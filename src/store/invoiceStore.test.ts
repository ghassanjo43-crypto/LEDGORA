import { describe, it, expect, beforeEach } from 'vitest';
import { useInvoiceStore } from './invoiceStore';
import { useInvoiceTemplateStore, INVOICE_ENTITY_ID } from './invoiceTemplateStore';
import { useJournalStore } from './journalStore';
import { useStore } from './useStore';
import { useEntityStore, entityToFormValues } from './useEntityStore';
import { computeTotals } from '@/lib/journalValidation';
import { BLUE_TEMPLATE_ID } from '@/data/invoiceTemplates';

function firstCustomerId(): string {
  const cust = useEntityStore.getState().entities.find((e) => e.entityType === 'customer' || e.entityType === 'both');
  return cust!.id;
}
/** Set the customer's preferred invoice template on the customer record. */
function setCustomerTemplate(customerId: string, templateId: string): void {
  const entity = useEntityStore.getState().entities.find((e) => e.id === customerId)!;
  useEntityStore.getState().updateEntity(customerId, { ...entityToFormValues(entity), defaultInvoiceTemplateId: templateId });
}
const revenueId = () => useStore.getState().accounts.find((a) => a.code === '4120')!.id;
const bankId = () => useStore.getState().accounts.find((a) => a.code === '1252')!.id;
const journalCount = () => useJournalStore.getState().entries.length;
const je = (id: string) => useJournalStore.getState().entries.find((e) => e.id === id)!;

function addLine(invoiceId: string, unitPrice: number, taxRate: number): void {
  const inv = useInvoiceStore.getState().getInvoice(invoiceId)!;
  const line = { ...inv.lines[0]!, accountId: revenueId(), description: 'Consulting', quantity: 1, unitPrice, taxRate };
  useInvoiceStore.getState().updateDraft(invoiceId, { lines: [line] });
}

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  useInvoiceTemplateStore.getState().resetToDefault();
  useInvoiceStore.getState().resetToDefault();
  useStore.getState().updateSettings({ logoUrl: '' });
  setCustomerTemplate(firstCustomerId(), ''); // clear any leaked customer preference
});

describe('logo persists through the template → snapshot → invoice data path', () => {
  it('a custom logo saved on a template version is frozen onto issued invoices', () => {
    const LOGO = 'data:image/png;base64,TEMPLATELOGO';
    const ts = useInvoiceTemplateStore.getState();
    // Save a custom logo on a new Professional Blue draft, then publish it.
    const draft = ts.createDraftVersion(BLUE_TEMPLATE_ID);
    const v = ts.getVersion(draft.id!)!;
    ts.updateVersion(draft.id!, { contentConfig: { ...v.contentConfig, showLogo: true, logo: { ...(v.contentConfig.logo!), mode: 'custom', customLogoUrl: LOGO } } });
    // Read back — proves the store retained the logo (not lost, not a blob URL).
    expect(useInvoiceTemplateStore.getState().getVersion(draft.id!)!.contentConfig.logo!.customLogoUrl).toBe(LOGO);
    ts.publishVersion(draft.id!);

    setCustomerTemplate(firstCustomerId(), BLUE_TEMPLATE_ID);
    const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
    addLine(id!, 100, 0);
    useInvoiceStore.getState().issueInvoice(id!);
    const inv = useInvoiceStore.getState().getInvoice(id!)!;
    expect(inv.templateSnapshot!.companySnapshot.logoUrl).toBe(LOGO); // appears on the issued invoice
  });

  it('the company default logo flows onto invoices when the template uses entity-default', () => {
    useStore.getState().updateSettings({ logoUrl: 'data:image/png;base64,COMPANYLOGO' });
    const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() }); // no customer template → system default (entity-default logo)
    addLine(id!, 100, 0);
    useInvoiceStore.getState().issueInvoice(id!);
    expect(useInvoiceStore.getState().getInvoice(id!)!.templateSnapshot!.companySnapshot.logoUrl).toBe('data:image/png;base64,COMPANYLOGO');
  });

  it('a later logo change does not alter an already-issued invoice', () => {
    useStore.getState().updateSettings({ logoUrl: 'data:image/png;base64,ORIGINAL' });
    const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
    addLine(id!, 100, 0);
    useInvoiceStore.getState().issueInvoice(id!);
    // change the company logo afterwards
    useStore.getState().updateSettings({ logoUrl: 'data:image/png;base64,CHANGED' });
    expect(useInvoiceStore.getState().getInvoice(id!)!.templateSnapshot!.companySnapshot.logoUrl).toBe('data:image/png;base64,ORIGINAL');
  });
});

describe('renaming an invoice template', () => {
  it('renames in place — ID unchanged, customers stay assigned, new invoices still resolve', () => {
    const ts = useInvoiceTemplateStore.getState();
    setCustomerTemplate(firstCustomerId(), BLUE_TEMPLATE_ID); // customer assigned by ID

    const res = ts.renameTemplate(BLUE_TEMPLATE_ID, '  Modern Professional Invoice  ');
    expect(res.ok).toBe(true);
    const t = useInvoiceTemplateStore.getState().getTemplate(BLUE_TEMPLATE_ID)!;
    expect(t.id).toBe(BLUE_TEMPLATE_ID); // same ID
    expect(t.name).toBe('Modern Professional Invoice'); // trimmed

    // Customer still references the same ID → new invoice resolves to the (renamed) template.
    const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
    const inv = useInvoiceStore.getState().getInvoice(id!)!;
    expect(inv.templateResolutionSource).toBe('customer-preference');
    expect(inv.templateId).toBe(BLUE_TEMPLATE_ID);
  });

  it('rejects blank, over-80-char and duplicate names', () => {
    const ts = useInvoiceTemplateStore.getState();
    expect(ts.renameTemplate(BLUE_TEMPLATE_ID, '   ').error).toBe('Template name is required.');
    expect(ts.renameTemplate(BLUE_TEMPLATE_ID, 'x'.repeat(81)).error).toBe('Template name cannot exceed 80 characters.');
    // "Standard Invoice" is the system template's name → duplicate
    expect(ts.renameTemplate(BLUE_TEMPLATE_ID, 'standard invoice').error).toBe('An invoice template with this name already exists.');
  });

  it('does not alter an already-issued invoice snapshot when the template is renamed later', () => {
    setCustomerTemplate(firstCustomerId(), BLUE_TEMPLATE_ID);
    const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
    addLine(id!, 100, 0);
    useInvoiceStore.getState().issueInvoice(id!);
    const before = useInvoiceStore.getState().getInvoice(id!)!.templateSnapshot!.templateName;
    useInvoiceTemplateStore.getState().renameTemplate(BLUE_TEMPLATE_ID, 'Renamed After Issue');
    expect(useInvoiceStore.getState().getInvoice(id!)!.templateSnapshot!.templateName).toBe(before); // frozen
  });
});

describe('draft invoices do not affect accounting', () => {
  it('creating and editing a draft posts nothing to the journal', () => {
    const before = journalCount();
    const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
    addLine(id!, 1000, 16);
    expect(useInvoiceStore.getState().getInvoice(id!)!.status).toBe('draft');
    expect(useInvoiceStore.getState().getInvoice(id!)!.journalEntryId).toBeUndefined();
    expect(journalCount()).toBe(before);
  });
});

describe('issuing an invoice', () => {
  it('creates a balanced Dr receivable / Cr revenue + tax journal entry', () => {
    const before = journalCount();
    const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
    addLine(id!, 1000, 16);
    const res = useInvoiceStore.getState().issueInvoice(id!);
    expect(res.ok).toBe(true);
    expect(journalCount()).toBe(before + 1);

    const inv = useInvoiceStore.getState().getInvoice(id!)!;
    expect(inv.status).toBe('issued');
    expect(inv.grandTotal).toBe(1160);
    expect(inv.templateSnapshot).toBeTruthy(); // frozen at issuance

    const entry = je(inv.journalEntryId!);
    expect(entry.status).toBe('posted');
    const totals = computeTotals(entry.lines);
    expect(totals.totalDebit).toBe(1160);
    expect(totals.totalCredit).toBe(1160);
    expect(entry.lines.find((l) => l.accountCode === '1221')!.debit).toBe(1160); // receivable
    expect(entry.lines.find((l) => l.accountCode === '4120')!.credit).toBe(1000); // revenue
    expect(entry.lines.find((l) => l.accountCode === '2270')!.credit).toBe(160); // output VAT
  });

  it('a later template edit does not change the issued invoice snapshot', () => {
    const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId(), overrideTemplateVersionId: undefined });
    addLine(id!, 500, 0);
    useInvoiceStore.getState().issueInvoice(id!);
    const snapTitleBefore = useInvoiceStore.getState().getInvoice(id!)!.templateSnapshot!.contentConfig.title;
    // create + publish a new version and mutate — snapshot must be unaffected
    const draft = useInvoiceTemplateStore.getState().createDraftVersion(BLUE_TEMPLATE_ID);
    useInvoiceTemplateStore.getState().updateVersion(draft.id!, { contentConfig: { ...useInvoiceTemplateStore.getState().getVersion(draft.id!)!.contentConfig, title: 'MUTATED' } });
    expect(useInvoiceStore.getState().getInvoice(id!)!.templateSnapshot!.contentConfig.title).toBe(snapTitleBefore);
  });
});

describe('payments', () => {
  it('a partial payment updates balance due and posts a separate receipt entry', () => {
    const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
    addLine(id!, 1000, 0);
    useInvoiceStore.getState().issueInvoice(id!);
    const invoiceJe = useInvoiceStore.getState().getInvoice(id!)!.journalEntryId;
    const countAfterIssue = journalCount();

    const res = useInvoiceStore.getState().recordPayment(id!, { amount: 400, date: '2026-04-01', bankAccountId: bankId() });
    expect(res.ok).toBe(true);
    const inv = useInvoiceStore.getState().getInvoice(id!)!;
    expect(inv.amountPaid).toBe(400);
    expect(inv.balanceDue).toBe(600);
    expect(inv.status).toBe('partially-paid');
    expect(journalCount()).toBe(countAfterIssue + 1); // separate entry
    expect(inv.payments[0]!.journalEntryId).not.toBe(invoiceJe); // original untouched
    const receipt = je(inv.payments[0]!.journalEntryId!);
    expect(receipt.lines.find((l) => l.accountCode === '1252')!.debit).toBe(400);
    expect(receipt.lines.find((l) => l.accountCode === '1221')!.credit).toBe(400);
  });

  it('paying the balance marks the invoice paid', () => {
    const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
    addLine(id!, 1000, 0);
    useInvoiceStore.getState().issueInvoice(id!);
    useInvoiceStore.getState().recordPayment(id!, { amount: 1000, date: '2026-04-01', bankAccountId: bankId() });
    expect(useInvoiceStore.getState().getInvoice(id!)!.status).toBe('paid');
    expect(useInvoiceStore.getState().getInvoice(id!)!.balanceDue).toBe(0);
  });
});

describe('voiding', () => {
  it('creates a reversing journal entry and preserves the original invoice', () => {
    const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
    addLine(id!, 1000, 16);
    useInvoiceStore.getState().issueInvoice(id!);
    const count = journalCount();
    const res = useInvoiceStore.getState().voidInvoice(id!, 'Issued in error');
    expect(res.ok).toBe(true);
    const inv = useInvoiceStore.getState().getInvoice(id!)!;
    expect(inv.status).toBe('void');
    expect(inv.reversalJournalEntryId).toBeTruthy();
    expect(inv.invoiceNumber).toBeTruthy(); // number preserved, not reused
    expect(journalCount()).toBe(count + 1); // reversing entry
  });
});

describe('numbering & assignment rules', () => {
  it('assigns unique sequential invoice numbers', () => {
    const a = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
    const b = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
    const na = useInvoiceStore.getState().getInvoice(a.id!)!.invoiceNumber;
    const nb = useInvoiceStore.getState().getInvoice(b.id!)!.invoiceNumber;
    expect(na).not.toBe(nb);
    expect(new Set([na, nb]).size).toBe(2);
  });

  it('the customer’s preferred template (stored on the customer) drives resolution for a new invoice', () => {
    const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
    // default: no customer preference → system default
    expect(useInvoiceStore.getState().getInvoice(id!)!.templateResolutionSource).toBe('system-default');

    // set the customer's preferred template on the customer record, then create another invoice
    setCustomerTemplate(firstCustomerId(), BLUE_TEMPLATE_ID);
    const { id: id2 } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
    const inv2 = useInvoiceStore.getState().getInvoice(id2!)!;
    expect(inv2.templateResolutionSource).toBe('customer-preference');
    expect(inv2.templateId).toBe(BLUE_TEMPLATE_ID);
  });

  it('an archived customer template is ignored → falls back to the system default', () => {
    setCustomerTemplate(firstCustomerId(), BLUE_TEMPLATE_ID);
    useInvoiceTemplateStore.getState().archiveTemplate(BLUE_TEMPLATE_ID);
    const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
    expect(useInvoiceStore.getState().getInvoice(id!)!.templateResolutionSource).toBe('system-default');
  });

  it('the system default template always resolves even with no preference', () => {
    const resolved = useInvoiceTemplateStore.getState().resolve({ entityId: INVOICE_ENTITY_ID });
    expect(resolved.resolutionSource).toBe('system-default');
  });
});

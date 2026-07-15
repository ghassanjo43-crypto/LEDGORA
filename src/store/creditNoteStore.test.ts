import { describe, it, expect, beforeEach } from 'vitest';
import { useCreditNoteStore } from './creditNoteStore';
import { useInvoiceStore } from './invoiceStore';
import { useInvoiceTemplateStore } from './invoiceTemplateStore';
import { useJournalStore } from './journalStore';
import { useStore } from './useStore';
import { useEntityStore, entityToFormValues } from './useEntityStore';
import { computeTotals } from '@/lib/journalValidation';
import { computeCustomerCreditSummary } from '@/lib/creditNoteApplications';

function firstCustomerId(): string {
  return useEntityStore.getState().entities.find((e) => e.entityType === 'customer' || e.entityType === 'both')!.id;
}
function setCustomerTemplate(customerId: string, templateId: string): void {
  const entity = useEntityStore.getState().entities.find((e) => e.id === customerId)!;
  useEntityStore.getState().updateEntity(customerId, { ...entityToFormValues(entity), defaultInvoiceTemplateId: templateId });
}
const revenueId = () => useStore.getState().accounts.find((a) => a.code === '4120')!.id;
const bankId = () => useStore.getState().accounts.find((a) => a.code === '1252')!.id;
const journalCount = () => useJournalStore.getState().entries.length;
const je = (id: string) => useJournalStore.getState().entries.find((e) => e.id === id)!;

/** Create and issue an invoice with a single line: qty × unitPrice @ taxRate%. */
function issuedInvoice(qty: number, unitPrice: number, taxRate: number): string {
  const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
  const inv = useInvoiceStore.getState().getInvoice(id!)!;
  const line = { ...inv.lines[0]!, accountId: revenueId(), description: 'Service', quantity: qty, unitPrice, taxRate };
  useInvoiceStore.getState().updateDraft(id!, { lines: [line] });
  useInvoiceStore.getState().issueInvoice(id!);
  return id!;
}

/** Set the sole credit-note line's quantity (the prefilled line). */
function setCreditQty(cnId: string, quantity: number): void {
  const cn = useCreditNoteStore.getState().getCreditNoteById(cnId)!;
  useCreditNoteStore.getState().updateCreditNote(cnId, { lines: [{ ...cn.lines[0]!, quantity }] });
}

const cnStore = () => useCreditNoteStore.getState();

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  useInvoiceTemplateStore.getState().resetToDefault();
  useInvoiceStore.getState().resetToDefault();
  useCreditNoteStore.getState().resetToDefault();
  useStore.getState().updateSettings({ logoUrl: '' });
  setCustomerTemplate(firstCustomerId(), '');
});

describe('crediting eligibility', () => {
  it('a draft invoice cannot be credited', () => {
    const { id } = useInvoiceStore.getState().createDraft({ customerId: firstCustomerId() });
    const res = cnStore().createCreditNoteFromInvoice(id!);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/issued invoice/i);
  });

  it('a void invoice cannot be credited', () => {
    const id = issuedInvoice(1, 1000, 0);
    useInvoiceStore.getState().voidInvoice(id, 'error');
    const res = cnStore().createCreditNoteFromInvoice(id);
    expect(res.ok).toBe(false);
  });

  it('an issued invoice can create a prefilled credit note', () => {
    const id = issuedInvoice(2, 500, 16);
    const res = cnStore().createCreditNoteFromInvoice(id);
    expect(res.ok).toBe(true);
    const cn = cnStore().getCreditNoteById(res.id!)!;
    expect(cn.status).toBe('draft');
    expect(cn.originalInvoiceNumber).toBeTruthy();
    expect(cn.lines).toHaveLength(1);
    expect(cn.lines[0]!.quantity).toBe(2); // full remaining quantity prefilled
    expect(cn.grandTotal).toBe(1160);
    expect(cn.customerId).toBe(firstCustomerId());
  });
});

describe('acceptance scenario — partial credit of INV total 1,160', () => {
  it('posts Dr sales returns 500 / Dr VAT 80 / Cr receivables 580 and adjusts the invoice balance', () => {
    const invId = issuedInvoice(2, 500, 16); // revenue 1,000 + VAT 160 = 1,160
    expect(useInvoiceStore.getState().getInvoice(invId)!.grandTotal).toBe(1160);

    const { id: cnId } = cnStore().createCreditNoteFromInvoice(invId);
    setCreditQty(cnId!, 1); // credit one of two units → 500 + 80 = 580
    const before = journalCount();
    const res = cnStore().issueCreditNote(cnId!);
    expect(res.ok).toBe(true);

    const cn = cnStore().getCreditNoteById(cnId!)!;
    expect(cn.subtotal).toBe(500);
    expect(cn.taxTotal).toBe(80);
    expect(cn.grandTotal).toBe(580);
    expect(cn.status).toBe('applied'); // auto-applied to the original invoice
    expect(cn.amountApplied).toBe(580);
    expect(cn.remainingCredit).toBe(0);

    // Balanced journal with the exact expected postings.
    expect(journalCount()).toBe(before + 1);
    const entry = je(cn.journalEntryId!);
    expect(entry.status).toBe('posted');
    const totals = computeTotals(entry.lines);
    expect(totals.totalDebit).toBe(580);
    expect(totals.totalCredit).toBe(580);
    expect(entry.lines.find((l) => l.accountCode === '4130')!.debit).toBe(500); // sales returns
    expect(entry.lines.find((l) => l.accountCode === '2270')!.debit).toBe(80); // VAT payable
    expect(entry.lines.find((l) => l.accountCode === '1221')!.credit).toBe(580); // receivables

    // Original invoice total is untouched; balance reflects the credit.
    const inv = useInvoiceStore.getState().getInvoice(invId)!;
    expect(inv.grandTotal).toBe(1160);
    expect(inv.creditsApplied).toBe(580);
    expect(inv.balanceDue).toBe(580);

    // Maximum additional credit becomes 580.
    const { id: cn2 } = cnStore().createCreditNoteFromInvoice(invId);
    // available-to-credit is exposed via the summary used by validation; assert via a fresh note total cap.
    setCreditQty(cn2!, 1); // remaining unit → 580
    expect(cnStore().issueCreditNote(cn2!).ok).toBe(true);
    expect(cnStore().getCreditNoteById(cn2!)!.grandTotal).toBe(580);
  });
});

describe('creditable-balance controls', () => {
  it('previous issued credits reduce available credit and block over-crediting', () => {
    const invId = issuedInvoice(10, 100, 16); // 1,000 + 160 = 1,160
    const { id: cn1 } = cnStore().createCreditNoteFromInvoice(invId);
    setCreditQty(cn1!, 4); // 400 + 64 = 464
    cnStore().issueCreditNote(cn1!);

    // A second note prefilled as "full" now only offers the remaining 6 units.
    const { id: cn2 } = cnStore().createCreditNoteFromInvoice(invId, { creditType: 'full' });
    const note2 = cnStore().getCreditNoteById(cn2!)!;
    expect(note2.lines[0]!.quantity).toBe(6);
    expect(note2.grandTotal).toBe(696); // 600 + 96

    // Attempting to credit MORE than remaining is blocked at issue.
    setCreditQty(cn2!, 8); // > remaining 6
    const res = cnStore().issueCreditNote(cn2!);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/remaining|exceed/i);
  });

  it('draft and void credit notes do not reduce the creditable amount', () => {
    const invId = issuedInvoice(10, 100, 0);
    // A lingering DRAFT credit note (never issued).
    cnStore().createCreditNoteFromInvoice(invId);
    // A voided credit note.
    const { id: v } = cnStore().createCreditNoteFromInvoice(invId);
    setCreditQty(v!, 3);
    cnStore().issueCreditNote(v!);
    cnStore().voidCreditNote(v!, 'mistake');

    // Full credit should still see all 10 units available (draft + void excluded).
    const { id: full } = cnStore().createCreditNoteFromInvoice(invId, { creditType: 'full' });
    expect(cnStore().getCreditNoteById(full!)!.lines[0]!.quantity).toBe(10);
  });

  it('tax reversal cannot exceed the original remaining tax', () => {
    const invId = issuedInvoice(1, 1000, 16); // net 1,000, tax 160
    const { id } = cnStore().createCreditNoteFromInvoice(invId);
    const cn = cnStore().getCreditNoteById(id!)!;
    // Credit only 500 of net (so the amount stays within the 1,160 available) but at
    // an inflated 40% rate → tax 200 > remaining 160, isolating the tax rule.
    cnStore().updateCreditNote(id!, { lines: [{ ...cn.lines[0]!, quantity: 1, unitPrice: 500, taxRate: 40 }] });
    const res = cnStore().issueCreditNote(id!);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/tax/i);
  });
});

describe('approval workflow', () => {
  it('an approved credit note can still be edited and then issued', () => {
    const invId = issuedInvoice(2, 500, 0);
    const { id } = cnStore().createCreditNoteFromInvoice(invId);
    setCreditQty(id!, 1);
    expect(cnStore().approveCreditNote(id!).ok).toBe(true);
    expect(cnStore().getCreditNoteById(id!)!.status).toBe('approved');

    // Editing after approval is allowed (draft-lock lifted for approved).
    const edit = cnStore().updateCreditNote(id!, { reasonDescription: 'reviewed and adjusted' });
    expect(edit.ok).toBe(true);
    expect(cnStore().getCreditNoteById(id!)!.reasonDescription).toBe('reviewed and adjusted');

    // And it can be issued straight from approved.
    const res = cnStore().issueCreditNote(id!);
    expect(res.ok).toBe(true);
    expect(cnStore().getCreditNoteById(id!)!.status).toBe('applied');
    expect(cnStore().getCreditNoteById(id!)!.journalEntryId).toBeTruthy();
  });
});

describe('correct & replace', () => {
  it('voids the issued note, restores the invoice, and opens a pre-filled replacement draft', () => {
    const invId = issuedInvoice(2, 500, 16); // 1,160
    const { id } = cnStore().createCreditNoteFromInvoice(invId);
    setCreditQty(id!, 1); // 580, auto-applied on issue
    cnStore().issueCreditNote(id!);
    expect(useInvoiceStore.getState().getInvoice(invId)!.balanceDue).toBe(580);
    const originalNumber = cnStore().getCreditNoteById(id!)!.creditNoteNumber;

    const res = cnStore().correctCreditNote(id!);
    expect(res.ok).toBe(true);
    expect(res.id).toBeTruthy();
    expect(res.id).not.toBe(id);

    // Original is voided (journal reversed, application reversed → invoice restored).
    const original = cnStore().getCreditNoteById(id!)!;
    expect(original.status).toBe('void');
    expect(original.reversalJournalEntryId).toBeTruthy();
    expect(useInvoiceStore.getState().getInvoice(invId)!.balanceDue).toBe(1160);

    // Replacement is an editable draft, new number, same linked invoice + lines.
    const replacement = cnStore().getCreditNoteById(res.id!)!;
    expect(replacement.status).toBe('draft');
    expect(replacement.creditNoteNumber).not.toBe(originalNumber);
    expect(replacement.originalInvoiceId).toBe(invId);
    expect(replacement.grandTotal).toBe(580);
    expect(cnStore().updateCreditNote(res.id!, { reasonDescription: 'fixed' }).ok).toBe(true);

    // Re-issuing the replacement applies afresh (previous void excluded from prior credits).
    expect(cnStore().issueCreditNote(res.id!).ok).toBe(true);
    expect(useInvoiceStore.getState().getInvoice(invId)!.balanceDue).toBe(580);
    expect(cnStore().invoiceReference(res.id!)!.previousCreditsTotal).toBe(0);
  });

  it('cannot correct a draft (it is already editable) or a void note', () => {
    const invId = issuedInvoice(2, 500, 0);
    const { id } = cnStore().createCreditNoteFromInvoice(invId);
    expect(cnStore().correctCreditNote(id!).ok).toBe(false); // draft
    setCreditQty(id!, 1);
    cnStore().issueCreditNote(id!);
    cnStore().voidCreditNote(id!, 'x');
    expect(cnStore().correctCreditNote(id!).ok).toBe(false); // void
  });
});

describe('immutability & voiding', () => {
  it('an issued credit note cannot be directly edited', () => {
    const invId = issuedInvoice(2, 500, 0);
    const { id } = cnStore().createCreditNoteFromInvoice(invId);
    setCreditQty(id!, 1);
    cnStore().issueCreditNote(id!);
    const res = cnStore().updateCreditNote(id!, { notes: 'change' });
    expect(res.ok).toBe(false);
  });

  it('voiding posts an exact reversal, reverses the application and restores the invoice balance', () => {
    const invId = issuedInvoice(2, 500, 16);
    const { id } = cnStore().createCreditNoteFromInvoice(invId);
    setCreditQty(id!, 1); // 580, auto-applied
    cnStore().issueCreditNote(id!);
    expect(useInvoiceStore.getState().getInvoice(invId)!.balanceDue).toBe(580);

    const count = journalCount();
    const res = cnStore().voidCreditNote(id!, 'raised in error');
    expect(res.ok).toBe(true);
    const cn = cnStore().getCreditNoteById(id!)!;
    expect(cn.status).toBe('void');
    expect(cn.reversalJournalEntryId).toBeTruthy();
    expect(cn.creditNoteNumber).toBeTruthy(); // number preserved
    expect(journalCount()).toBe(count + 1); // reversing entry

    // Application reversed → invoice balance and total restored.
    const inv = useInvoiceStore.getState().getInvoice(invId)!;
    expect(inv.creditsApplied).toBe(0);
    expect(inv.balanceDue).toBe(1160);
    expect(inv.grandTotal).toBe(1160);
  });
});

describe('paid invoice & refund', () => {
  it('crediting a fully paid invoice leaves an unapplied customer credit', () => {
    const invId = issuedInvoice(1, 1000, 0);
    useInvoiceStore.getState().recordPayment(invId, { amount: 1000, date: '2026-04-01', bankAccountId: bankId() });
    expect(useInvoiceStore.getState().getInvoice(invId)!.status).toBe('paid');

    const { id } = cnStore().createCreditNoteFromInvoice(invId);
    cnStore().issueCreditNote(id!); // nothing to auto-apply (balance 0)
    const cn = cnStore().getCreditNoteById(id!)!;
    expect(cn.status).toBe('issued');
    expect(cn.amountApplied).toBe(0);
    expect(cn.remainingCredit).toBe(1000);
  });

  it('a refund posts a separate Dr receivables / Cr bank entry and reduces remaining credit', () => {
    const invId = issuedInvoice(1, 1000, 0);
    useInvoiceStore.getState().recordPayment(invId, { amount: 1000, date: '2026-04-01', bankAccountId: bankId() });
    const { id } = cnStore().createCreditNoteFromInvoice(invId);
    cnStore().issueCreditNote(id!);
    const issueJe = cnStore().getCreditNoteById(id!)!.journalEntryId;

    const count = journalCount();
    const res = cnStore().refundCreditNote(id!, { amount: 400, refundDate: '2026-05-01', bankAccountId: bankId() });
    expect(res.ok).toBe(true);
    expect(journalCount()).toBe(count + 1); // separate entry

    const cn = cnStore().getCreditNoteById(id!)!;
    expect(cn.amountRefunded).toBe(400);
    expect(cn.remainingCredit).toBe(600);
    const refundJe = je(cn.refunds[0]!.journalEntryId!);
    expect(refundJe.id).not.toBe(issueJe); // original credit-note entry untouched
    expect(refundJe.lines.find((l) => l.accountCode === '1221')!.debit).toBe(400);
    expect(refundJe.lines.find((l) => l.accountCode === '1252')!.credit).toBe(400);
  });
});

describe('branding, numbering & customer credit', () => {
  it('a credit note inherits the invoice branding and freezes it on issue', () => {
    useStore.getState().updateSettings({ logoUrl: 'data:image/png;base64,BRAND' });
    const invId = issuedInvoice(1, 1000, 0);
    const invLogo = useInvoiceStore.getState().getInvoice(invId)!.templateSnapshot!.companySnapshot.logoUrl;
    const { id } = cnStore().createCreditNoteFromInvoice(invId);
    cnStore().issueCreditNote(id!);
    const snap = cnStore().getCreditNoteById(id!)!.templateSnapshot!;
    expect(snap.companySnapshot.logoUrl).toBe(invLogo); // inherited
    expect(snap.contentConfig.title).toBe('Credit Note'); // adapted title

    // A later logo change does not alter the issued credit note.
    useStore.getState().updateSettings({ logoUrl: 'data:image/png;base64,CHANGED' });
    expect(cnStore().getCreditNoteById(id!)!.templateSnapshot!.companySnapshot.logoUrl).toBe(invLogo);
  });

  it('credit-note numbers are unique and CN-prefixed', () => {
    const invId = issuedInvoice(10, 100, 0);
    const a = cnStore().createCreditNoteFromInvoice(invId);
    const b = cnStore().createCreditNoteFromInvoice(invId);
    const na = cnStore().getCreditNoteById(a.id!)!.creditNoteNumber;
    const nb = cnStore().getCreditNoteById(b.id!)!.creditNoteNumber;
    expect(na).toMatch(/^CN-/);
    expect(na).not.toBe(nb);
  });

  it('customer available credit recalculates across issue, apply and refund', () => {
    const invId = issuedInvoice(1, 1000, 0);
    useInvoiceStore.getState().recordPayment(invId, { amount: 1000, date: '2026-04-01', bankAccountId: bankId() });
    const { id } = cnStore().createCreditNoteFromInvoice(invId);
    cnStore().issueCreditNote(id!);
    let summary = computeCustomerCreditSummary(firstCustomerId(), useCreditNoteStore.getState().creditNotes);
    expect(summary.availableCredit).toBe(1000);
    cnStore().refundCreditNote(id!, { amount: 400, refundDate: '2026-05-01', bankAccountId: bankId() });
    summary = computeCustomerCreditSummary(firstCustomerId(), useCreditNoteStore.getState().creditNotes);
    expect(summary.availableCredit).toBe(600);
    expect(summary.refundedCredit).toBe(400);
  });
});

describe('persistence hydration', () => {
  it('replaceAll rehydrates credit notes without loss', () => {
    const invId = issuedInvoice(2, 500, 16);
    const { id } = cnStore().createCreditNoteFromInvoice(invId);
    setCreditQty(id!, 1);
    cnStore().issueCreditNote(id!);
    const snapshot = JSON.parse(JSON.stringify(useCreditNoteStore.getState().creditNotes));
    useCreditNoteStore.getState().replaceAll(snapshot);
    const cn = cnStore().getCreditNoteById(id!)!;
    expect(cn.grandTotal).toBe(580);
    expect(cn.journalEntryId).toBeTruthy();
  });
});

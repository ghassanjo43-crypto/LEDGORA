import { describe, it, expect } from 'vitest';
import type { Account, AccountType, NormalBalance } from '@/types';
import type { Invoice, InvoiceLine, InvoiceTemplateVersion } from '@/types/invoice';
import { calculateInvoiceLine, calculateInvoiceTotals } from './invoiceCalculations';
import {
  resolveInvoiceTemplateVersion,
  createInvoiceTemplateSnapshot,
  createDraftVersionFromPublished,
  canAssignVersion,
  latestPublishedVersion,
  type TemplateData,
} from './invoiceTemplates';
import { generateInvoiceNumber, makeDefaultNumberingConfig } from './invoiceNumbering';
import { buildInvoiceJournalEntry, buildInvoicePaymentJournalEntry } from './invoicePosting';
import { validateInvoiceDraft, validateInvoiceForIssue } from './invoiceValidation';
import {
  buildSeedInvoiceTemplates,
  BLUE_TEMPLATE_ID, BLUE_VERSION_2_ID,
  ARABIC_TEMPLATE_ID, ARABIC_VERSION_1_ID, SYSTEM_TEMPLATE_ID,
} from '@/data/invoiceTemplates';
import { computeTotals } from './journalValidation';

const ENT = 'ent1';
function templateData(): TemplateData {
  const seed = buildSeedInvoiceTemplates(ENT);
  return { templates: seed.templates, versions: seed.versions };
}

/* ── Calculations ── */
describe('invoice calculations (decimal-safe)', () => {
  it('computes a line: 3 × 100 less 10% + 15% tax', () => {
    const c = calculateInvoiceLine({ quantity: 3, unitPrice: 100, discountType: 'percentage', discountValue: 10, taxRate: 15 });
    expect(c.lineSubtotal).toBe(300);
    expect(c.discountAmount).toBe(30);
    expect(c.taxableAmount).toBe(270);
    expect(c.taxAmount).toBe(40.5);
    expect(c.lineTotal).toBe(310.5);
  });
  it('example: revenue 1,000 + VAT 160 = 1,160', () => {
    const totals = calculateInvoiceTotals([{ quantity: 1, unitPrice: 1000, taxRate: 16 }]);
    expect(totals.subtotal).toBe(1000);
    expect(totals.taxTotal).toBe(160);
    expect(totals.grandTotal).toBe(1160);
  });
  it('stays exact across many fractional lines (no FP drift)', () => {
    const lines = Array.from({ length: 3 }, () => ({ quantity: 1, unitPrice: 0.1, taxRate: 0 }));
    expect(calculateInvoiceTotals(lines).subtotal).toBe(0.3);
  });
  it('balance due reflects amount paid', () => {
    const t = calculateInvoiceTotals([{ quantity: 2, unitPrice: 500, taxRate: 0 }], 0, 400);
    expect(t.grandTotal).toBe(1000);
    expect(t.balanceDue).toBe(600);
  });
});

/* ── Template resolution ── */
describe('template resolution priority', () => {
  it('1. a system default template always resolves when nothing else applies', () => {
    const r = resolveInvoiceTemplateVersion({ entityId: ENT }, templateData());
    expect(r.resolutionSource).toBe('system-default');
    expect(r.templateId).toBe(SYSTEM_TEMPLATE_ID);
  });
  it('2. entity default overrides the system default', () => {
    const data = templateData();
    data.templates.find((t) => t.id === BLUE_TEMPLATE_ID)!.isEntityDefault = true;
    const r = resolveInvoiceTemplateVersion({ entityId: ENT }, data);
    expect(r.resolutionSource).toBe('entity-default');
    expect(r.templateId).toBe(BLUE_TEMPLATE_ID);
    expect(r.templateVersionId).toBe(BLUE_VERSION_2_ID); // latest published
  });
  it('3. the customer’s preferred template (from the customer record) overrides the entity default', () => {
    const data = templateData();
    data.templates.find((t) => t.id === ARABIC_TEMPLATE_ID)!.isEntityDefault = true;
    const r = resolveInvoiceTemplateVersion({ entityId: ENT, customerDefaultTemplateId: BLUE_TEMPLATE_ID }, data);
    expect(r.resolutionSource).toBe('customer-preference');
    expect(r.templateId).toBe(BLUE_TEMPLATE_ID);
    expect(r.templateVersionId).toBe(BLUE_VERSION_2_ID); // latest published of the customer's template
  });
  it('4. invoice override takes the highest priority', () => {
    const r = resolveInvoiceTemplateVersion({ entityId: ENT, customerDefaultTemplateId: BLUE_TEMPLATE_ID, invoiceTemplateVersionId: ARABIC_VERSION_1_ID }, templateData());
    expect(r.resolutionSource).toBe('invoice-override');
    expect(r.templateVersionId).toBe(ARABIC_VERSION_1_ID);
  });
  it('an archived customer template is ignored (falls through to defaults)', () => {
    const data = templateData();
    data.templates.find((t) => t.id === BLUE_TEMPLATE_ID)!.isArchived = true;
    const r = resolveInvoiceTemplateVersion({ entityId: ENT, customerDefaultTemplateId: BLUE_TEMPLATE_ID }, data);
    expect(r.resolutionSource).toBe('system-default');
  });
  it('no customer template falls back to the entity/system default', () => {
    const r = resolveInvoiceTemplateVersion({ entityId: ENT }, templateData());
    expect(r.resolutionSource).toBe('system-default');
  });
});

/* ── Versioning & assignment rules ── */
describe('versioning & assignment', () => {
  it('only published versions may be assigned', () => {
    const seed = buildSeedInvoiceTemplates(ENT);
    const draft: InvoiceTemplateVersion = { ...seed.versions[0]!, id: 'd', status: 'draft' };
    const archived: InvoiceTemplateVersion = { ...seed.versions[0]!, id: 'a', status: 'archived' };
    expect(canAssignVersion(seed.versions.find((v) => v.id === BLUE_VERSION_2_ID))).toBe(true);
    expect(canAssignVersion(draft)).toBe(false);
    expect(canAssignVersion(archived)).toBe(false); // archived not assignable to new invoices
  });
  it('editing a published template creates a new incremented draft version (does not overwrite)', () => {
    const seed = buildSeedInvoiceTemplates(ENT);
    const blue = seed.templates.find((t) => t.id === BLUE_TEMPLATE_ID)!;
    const draft = createDraftVersionFromPublished(blue, seed.versions, 'tester');
    expect(draft.status).toBe('draft');
    expect(draft.versionNumber).toBe(3); // v1, v2 published → next is 3
    // originals untouched
    expect(seed.versions.find((v) => v.id === BLUE_VERSION_2_ID)!.status).toBe('published');
  });
  it('latestPublishedVersion picks the highest published number', () => {
    const seed = buildSeedInvoiceTemplates(ENT);
    expect(latestPublishedVersion(BLUE_TEMPLATE_ID, seed.versions)!.id).toBe(BLUE_VERSION_2_ID);
  });
});

/* ── Snapshot immutability ── */
describe('template snapshot', () => {
  it('freezes config so later template edits do not change an issued invoice', () => {
    const seed = buildSeedInvoiceTemplates(ENT);
    const tmpl = seed.templates.find((t) => t.id === BLUE_TEMPLATE_ID)!;
    const ver = seed.versions.find((v) => v.id === BLUE_VERSION_2_ID)!;
    const snap = createInvoiceTemplateSnapshot(tmpl, ver, { legalName: 'Acme' }, { name: 'Customer A' });
    // mutate the live version afterwards
    ver.styleConfig.primaryColor = '#ff0000';
    ver.contentConfig.title = 'CHANGED';
    expect(snap.styleConfig.primaryColor).not.toBe('#ff0000');
    expect(snap.contentConfig.title).not.toBe('CHANGED');
    expect(snap.companySnapshot.legalName).toBe('Acme');
    expect(snap.customerSnapshot.name).toBe('Customer A');
  });
});

/* ── Numbering ── */
describe('invoice numbering', () => {
  it('formats entity-scoped numbers like INV-2026-0001', () => {
    const cfg = makeDefaultNumberingConfig(ENT, 2026);
    const g = generateInvoiceNumber(cfg, new Set(), '2026-03-01');
    expect(g.number).toBe('INV-2026-0001');
    expect(g.nextConfig.nextSequence).toBe(2);
  });
  it('never reuses a number already in use (e.g. voided)', () => {
    const cfg = makeDefaultNumberingConfig(ENT, 2026);
    const g = generateInvoiceNumber(cfg, new Set(['INV-2026-0001', 'INV-2026-0002']), '2026-03-01');
    expect(g.number).toBe('INV-2026-0003');
  });
  it('resets the sequence on a new year when configured', () => {
    const cfg = { ...makeDefaultNumberingConfig(ENT, 2025), nextSequence: 42 };
    const g = generateInvoiceNumber(cfg, new Set(), '2026-01-05');
    expect(g.number).toBe('INV-2026-0001');
  });
});

/* ── Posting ── */
function acc(id: string, code: string, type: AccountType, nb: NormalBalance): Account {
  return { id, code, name: code, type, parentId: null, level: 1, normalBalance: nb, ifrsStatement: 'PROFIT_OR_LOSS', ifrsCategory: '', ifrsSubcategory: '', cashFlowCategory: 'NOT_APPLICABLE', isPostingAccount: true, isActive: true, description: '', industryTag: 'general', sortOrder: 0, createdAt: '', updatedAt: '' };
}
const AR = acc('ar', '1221', 'ASSET', 'DEBIT');
const REVENUE = acc('rev', '4120', 'INCOME', 'CREDIT');
const REVENUE2 = acc('rev2', '4110', 'INCOME', 'CREDIT');
const VAT = acc('vat', '2270', 'LIABILITY', 'CREDIT');
const BANK = acc('bank', '1252', 'ASSET', 'DEBIT');
const accountsById = new Map<string, Account>([AR, REVENUE, REVENUE2, VAT, BANK].map((a) => [a.id, a]));

function line(over: Partial<InvoiceLine>): InvoiceLine {
  return { id: 'l', accountId: 'rev', description: 'Svc', quantity: 1, unitPrice: 1000, taxRate: 16, taxAmount: 160, lineSubtotal: 1000, lineTotal: 1160, sortOrder: 1, ...over };
}
function invoice(over: Partial<Invoice> = {}): Invoice {
  const lines = over.lines ?? [line({})];
  const t = calculateInvoiceTotals(lines, 0, over.amountPaid ?? 0);
  return {
    id: 'inv1', entityId: ENT, customerId: 'cust', invoiceNumber: 'INV-2026-0001', status: 'draft',
    issueDate: '2026-03-01', dueDate: '2026-03-31', currency: 'USD', exchangeRate: 1,
    templateId: BLUE_TEMPLATE_ID, templateVersionId: BLUE_VERSION_2_ID, templateResolutionSource: 'customer-preference',
    lines, subtotal: t.subtotal, discountTotal: t.discountTotal, taxTotal: t.taxTotal, additionalChargesTotal: 0,
    grandTotal: t.grandTotal, amountPaid: t.amountPaid, creditsApplied: 0, balanceDue: t.balanceDue, payments: [], auditTrail: [],
    createdAt: '', updatedAt: '', ...over,
  };
}

describe('invoice → journal posting', () => {
  it('builds a balanced Dr receivable / Cr revenue + tax entry', () => {
    const je = buildInvoiceJournalEntry(invoice(), { accountsById, receivableAccountId: 'ar', taxPayableAccountId: 'vat', createdBy: 'x' });
    const totals = computeTotals(je.lines);
    expect(totals.totalDebit).toBe(1160);
    expect(totals.totalCredit).toBe(1160);
    expect(totals.difference).toBe(0);
  });
  it('posts each line to its selected revenue account, tax to the tax account, receivable to AR', () => {
    const lines = [line({ id: 'a', accountId: 'rev', unitPrice: 1000, taxRate: 10 }), line({ id: 'b', accountId: 'rev2', unitPrice: 500, taxRate: 10 })];
    const je = buildInvoiceJournalEntry(invoice({ lines }), { accountsById, receivableAccountId: 'ar', taxPayableAccountId: 'vat' });
    const rev1 = je.lines.find((l) => l.accountId === 'rev')!;
    const rev2 = je.lines.find((l) => l.accountId === 'rev2')!;
    const vat = je.lines.find((l) => l.accountId === 'vat')!;
    const ar = je.lines.find((l) => l.accountId === 'ar')!;
    expect(rev1.credit).toBe(1000);
    expect(rev2.credit).toBe(500);
    expect(vat.credit).toBe(150); // 10% of 1500
    expect(ar.debit).toBe(1650);
    expect(ar.entityId).toBe('cust'); // customer control
  });
  it('a payment posts Dr bank / Cr receivable and never touches the invoice journal', () => {
    const inv = invoice();
    const payment = { id: 'p', invoiceId: inv.id, date: '2026-04-01', amount: 500, method: 'bank', bankAccountId: 'bank', createdAt: '' };
    const je = buildInvoicePaymentJournalEntry(inv, payment, { accountsById, receivableAccountId: 'ar' });
    expect(je.lines.find((l) => l.accountId === 'bank')!.debit).toBe(500);
    expect(je.lines.find((l) => l.accountId === 'ar')!.credit).toBe(500);
    expect(computeTotals(je.lines).difference).toBe(0);
  });
});

/* ── Validation ── */
describe('invoice validation', () => {
  it('draft validation is lenient (incomplete allowed)', () => {
    expect(validateInvoiceDraft({ lines: [line({ accountId: '', quantity: 0, unitPrice: 0 })] })).toEqual([]);
  });
  it('issue validation requires the essentials', () => {
    const bad = invoice({ customerId: '', lines: [line({ accountId: '', description: '', quantity: 0, unitPrice: 0 })] });
    const issues = validateInvoiceForIssue(bad, { templateVersionPublished: false, hasReceivableAccount: false, invoiceNumberUnique: true });
    const rules = issues.map((i) => i.rule);
    expect(rules).toContain('customer');
    expect(rules).toContain('template');
    expect(rules).toContain('receivable');
    expect(rules).toContain('lines'); // the only line is fully blank → no active lines
  });
  it('a complete invoice passes issue validation', () => {
    const issues = validateInvoiceForIssue(invoice(), { templateVersionPublished: true, hasReceivableAccount: true, invoiceNumberUnique: true });
    expect(issues).toEqual([]);
  });
});

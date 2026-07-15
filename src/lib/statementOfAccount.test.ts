import { describe, it, expect, beforeEach } from 'vitest';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useCreditNoteStore } from '@/store/creditNoteStore';
import { useReceiptStore } from '@/store/receiptStore';
import { useInvoiceTemplateStore } from '@/store/invoiceTemplateStore';
import { useJournalStore } from '@/store/journalStore';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { buildStatementOfAccount, customerReceivableAccountId } from '@/lib/statementOfAccount';
import { exportStatementCsv } from '@/lib/statementExport';
import type { StatementOptions } from '@/types/statementOfAccount';
import type { ReceiptAllocation } from '@/types/receipt';

const iStore = () => useInvoiceStore.getState();
const cnStore = () => useCreditNoteStore.getState();
const rStore = () => useReceiptStore.getState();
const jStore = () => useJournalStore.getState();
const customerId = () => useEntityStore.getState().entities.find((e) => e.entityType === 'customer' || e.entityType === 'both')!.id;
const otherCustomerId = () => useEntityStore.getState().entities.filter((e) => e.entityType === 'customer' || e.entityType === 'both')[1]?.id ?? customerId();
const acc = (code: string) => useStore.getState().accounts.find((a) => a.code === code)!.id;
const revenueId = () => acc('4120');

function options(patch: Partial<StatementOptions> = {}): StatementOptions {
  return {
    statementType: 'balance-forward', statementBasis: 'document',
    periodStart: '2026-07-01', periodEnd: '2026-07-31', asOfDate: '2026-07-31',
    currencyMode: 'single-currency', currency: 'USD',
    includeSettledInvoices: false, includeUnappliedReceipts: true, includeAllocationDetails: true,
    includeAging: true, includeOutstandingSchedule: true, includeZeroValueActivity: false,
    ...patch,
  };
}

function build(patch: Partial<StatementOptions> = {}, cid = customerId()) {
  return buildStatementOfAccount({
    entityId: 'primary', customerId: cid, options: options(patch),
    invoices: iStore().invoices, creditNotes: cnStore().creditNotes, receipts: rStore().receipts,
    journalEntries: jStore().entries, customers: useEntityStore.getState().entities, accounts: useStore.getState().accounts,
    baseCurrency: 'USD',
  });
}

function issuedInvoice(cid: string, issueDate: string, dueDate: string, unitPrice: number, qty = 1): string {
  const { id } = iStore().createDraft({ customerId: cid, issueDate, dueDate, currency: 'USD' });
  const inv = iStore().getInvoice(id!)!;
  iStore().updateDraft(id!, { lines: [{ ...inv.lines[0]!, accountId: revenueId(), description: 'Svc', quantity: qty, unitPrice, taxRate: 0 }] });
  iStore().issueInvoice(id!);
  return id!;
}
function creditNote(invoiceId: string, issueDate: string, amount: number): string {
  const { id } = cnStore().createCreditNoteFromInvoice(invoiceId);
  const cn = cnStore().getCreditNoteById(id!)!;
  cnStore().updateCreditNote(id!, { issueDate, lines: [{ ...cn.lines[0]!, revenueAccountId: revenueId(), quantity: 1, unitPrice: amount, taxRate: 0 }] });
  cnStore().issueCreditNote(id!);
  return id!;
}
function receiptFor(cid: string, invoiceId: string, receiptDate: string, amount: number): string {
  const inv = iStore().getInvoice(invoiceId)!;
  const { id } = rStore().createDraft({ customerId: cid, receiptDate, amount, currency: 'USD' });
  const now = new Date().toISOString();
  const allocation: ReceiptAllocation = { id: 'a', entityId: inv.entityId, receiptId: id!, customerId: cid, invoiceId, invoiceNumber: inv.invoiceNumber, allocationType: 'invoice', amount, baseCurrencyAmount: amount, allocationDate: receiptDate, createdAt: now, updatedAt: now };
  rStore().updateDraft(id!, { transactionReference: 'TRX', allocations: [allocation] });
  rStore().postReceipt(id!);
  return id!;
}

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  useInvoiceTemplateStore.getState().resetToDefault();
  useInvoiceStore.getState().resetToDefault();
  useCreditNoteStore.getState().resetToDefault();
  useReceiptStore.getState().resetToDefault();
  useStore.getState().updateSettings({ logoUrl: '' });
});

describe('acceptance scenario (opening 2,000 → closing 5,000)', () => {
  function setupAcceptance(): { invId: string; cnNumber: string; receiptNumber: string } {
    const cid = customerId();
    issuedInvoice(cid, '2026-06-15', '2026-06-15', 2000); // prior → opening 2,000
    const invId = issuedInvoice(cid, '2026-07-12', '2026-07-12', 8000);
    const cnId = creditNote(invId, '2026-07-12', 3000); // auto-applied
    const rId = receiptFor(cid, invId, '2026-07-15', 2000);
    return { invId, cnNumber: cnStore().getCreditNoteById(cnId)!.creditNoteNumber, receiptNumber: rStore().getReceiptById(rId)!.receiptNumber };
  }

  it('produces the expected opening, debits, credits, closing and reconciliation', () => {
    setupAcceptance();
    const st = build();
    expect(st.openingBalance).toBe(2000);
    expect(st.periodDebits).toBe(8000);
    expect(st.periodCredits).toBe(5000);
    expect(st.closingBalance).toBe(5000);
    expect(st.reconciliationDifference).toBe(0);
    expect(st.isReconciled).toBe(true);
  });

  it('running balances follow the ledger: 2,000 → 10,000 → 7,000 → 5,000', () => {
    setupAcceptance();
    const st = build();
    const balances = st.lines.map((l) => l.runningBalance);
    expect(balances).toEqual([2000, 10000, 7000, 5000]);
    expect(st.lines.map((l) => l.type)).toEqual(['opening-balance', 'invoice', 'credit-note', 'receipt']);
  });

  it('CSV export totals tie back to the statement closing balance', () => {
    setupAcceptance();
    const st = build();
    const csv = exportStatementCsv(st);
    expect(csv).toContain('Closing balance');
    expect(csv).toContain('5000.00');
  });
});

describe('source-record inclusion & exclusion', () => {
  it('excludes draft and void invoices; includes issued invoices', () => {
    const cid = customerId();
    issuedInvoice(cid, '2026-07-05', '2026-07-05', 1000);
    iStore().createDraft({ customerId: cid, issueDate: '2026-07-06', dueDate: '2026-07-06', currency: 'USD' }); // draft
    const voidId = issuedInvoice(cid, '2026-07-07', '2026-07-07', 4000);
    iStore().voidInvoice(voidId, 'error');
    const st = build();
    expect(st.periodDebits).toBe(1000); // only the issued, non-void invoice
    expect(st.lines.filter((l) => l.type === 'invoice')).toHaveLength(1);
  });

  it('excludes draft/void credit notes and reversed receipts', () => {
    const cid = customerId();
    const invId = issuedInvoice(cid, '2026-07-05', '2026-07-05', 5000);
    cnStore().createCreditNoteFromInvoice(invId); // draft CN — excluded
    creditNote(invId, '2026-07-06', 1000); // issued CN — included
    const rId = receiptFor(cid, invId, '2026-07-08', 1000);
    rStore().reverseReceipt(rId, 'bounced'); // reversed → excluded
    const st = build();
    expect(st.periodCredits).toBe(1000); // only the issued credit note
    expect(st.lines.filter((l) => l.type === 'credit-note')).toHaveLength(1);
    expect(st.lines.filter((l) => l.type === 'receipt')).toHaveLength(0);
  });

  it('filters by customer and entity', () => {
    issuedInvoice(customerId(), '2026-07-05', '2026-07-05', 1000);
    issuedInvoice(otherCustomerId(), '2026-07-06', '2026-07-06', 9999);
    const st = build();
    expect(st.periodDebits).toBe(1000);
  });
});

describe('double-counting protection', () => {
  it('does not show generated invoice/credit/receipt journals as extra events', () => {
    const cid = customerId();
    const invId = issuedInvoice(cid, '2026-07-05', '2026-07-05', 8000);
    creditNote(invId, '2026-07-06', 3000);
    receiptFor(cid, invId, '2026-07-08', 2000);
    const st = build();
    // No journal-adjustment/reversal lines when every journal is document-generated.
    expect(st.lines.filter((l) => l.type === 'journal-adjustment' || l.type === 'reversal')).toHaveLength(0);
    // One receipt line; its allocations are informational (balance moved once).
    const receiptLine = st.lines.find((l) => l.type === 'receipt')!;
    expect(receiptLine.allocations?.length).toBeGreaterThan(0);
  });

  it('includes an unlinked manual customer journal adjustment and stays reconciled', () => {
    const cid = customerId();
    issuedInvoice(cid, '2026-07-05', '2026-07-05', 1000);
    const receivable = customerReceivableAccountId(useEntityStore.getState().entities.find((e) => e.id === cid), useStore.getState().accounts);
    const line = (accountId: string, debit: number, credit: number, entityId = '') => ({ accountId, accountCode: '', accountName: '', description: '', debit, credit, entityId, entityName: '', costCenter: '', project: '', taxCode: '', taxAmount: 0, memo: 'adj' });
    const added = jStore().addEntry({ entryNumber: '', entryDate: '2026-07-20', reference: 'ADJ', description: 'Manual debit adjustment', currency: 'USD', exchangeRate: 1, notes: '', transactionType: 'Adjustment', createdBy: '', approvedBy: '', lines: [line(receivable, 500, 0, cid), line(acc('4300'), 0, 500)] });
    jStore().postEntry(added.id!);
    const st = build();
    expect(st.lines.filter((l) => l.type === 'journal-adjustment')).toHaveLength(1);
    expect(st.periodDebits).toBe(1500); // 1,000 invoice + 500 adjustment
    expect(st.closingBalance).toBe(1500);
    expect(st.isReconciled).toBe(true);
  });
});

describe('aging & outstanding schedule', () => {
  it('ages the remaining balance by due date into the correct buckets', () => {
    const cid = customerId();
    issuedInvoice(cid, '2026-06-15', '2026-06-15', 2000); // 46 days overdue at Jul 31 → 31-60
    const invId = issuedInvoice(cid, '2026-07-12', '2026-07-12', 8000); // 19 days → 1-30
    creditNote(invId, '2026-07-12', 3000);
    receiptFor(cid, invId, '2026-07-15', 2000); // INV-0006 outstanding now 3,000
    const st = build();
    const bucket = (id: string) => st.aging.buckets.find((b) => b.id === id)!.amount;
    expect(bucket('1-30')).toBe(3000);
    expect(bucket('31-60')).toBe(2000);
    expect(st.aging.total).toBe(5000);
    expect(st.overdueAmount).toBe(5000);
    // Outstanding schedule reconciles to the receivable balance.
    const scheduleTotal = st.outstandingInvoices.reduce((s, o) => s + o.outstandingBalance, 0);
    expect(Math.round(scheduleTotal)).toBe(5000);
  });
});

describe('statement types & edge cases', () => {
  it('balance-forward shows an opening balance; activity-only omits it', () => {
    const cid = customerId();
    issuedInvoice(cid, '2026-06-15', '2026-06-15', 2000);
    issuedInvoice(cid, '2026-07-10', '2026-07-10', 1000);
    expect(build().openingBalance).toBe(2000);
    expect(build().lines[0]!.type).toBe('opening-balance');
    const activity = build({ statementType: 'activity-only' });
    expect(activity.openingBalance).toBe(0);
    expect(activity.lines.some((l) => l.type === 'opening-balance')).toBe(false);
  });

  it('a net customer credit produces a negative closing balance', () => {
    const cid = customerId();
    const invId = issuedInvoice(cid, '2026-07-05', '2026-07-05', 1000);
    receiptFor(cid, invId, '2026-07-06', 1000); // settles the invoice
    creditNote(invId, '2026-07-07', 500); // extra credit → customer credit
    const st = build();
    expect(st.closingBalance).toBe(-500);
    expect(st.isReconciled).toBe(true);
  });

  it('an empty customer renders a zero statement safely', () => {
    const st = build({}, otherCustomerId());
    expect(st.openingBalance).toBe(0);
    expect(st.closingBalance).toBe(0);
    expect(st.lines.filter((l) => l.type !== 'opening-balance')).toHaveLength(0);
    expect(st.isReconciled).toBe(true);
  });

  it('base-currency mode converts using the stored exchange rate', () => {
    const cid = customerId();
    const { id } = iStore().createDraft({ customerId: cid, issueDate: '2026-07-05', dueDate: '2026-07-05', currency: 'EUR' });
    const inv = iStore().getInvoice(id!)!;
    iStore().updateDraft(id!, { exchangeRate: 1.1, lines: [{ ...inv.lines[0]!, accountId: revenueId(), description: 'Svc', quantity: 1, unitPrice: 1000, taxRate: 0 }] });
    iStore().issueInvoice(id!);
    const st = build({ currencyMode: 'base-currency' });
    expect(st.currency).toBe('USD');
    expect(st.periodDebits).toBe(1100); // 1,000 EUR × 1.1
  });
});

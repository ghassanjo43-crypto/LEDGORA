import { describe, it, expect, beforeEach } from 'vitest';
import { usePaymentStore } from './paymentStore';
import { useBillStore } from './billStore';
import { useInvoiceTemplateStore } from './invoiceTemplateStore';
import { useJournalStore } from './journalStore';
import { useStore } from './useStore';
import { useEntityStore } from './useEntityStore';
import { computeTotals } from '@/lib/journalValidation';
import { supplierPayableBalance } from '@/lib/billSettlement';
import type { BillLine } from '@/types/bill';
import type { Payment, PaymentAllocation } from '@/types/payment';

const pStore = () => usePaymentStore.getState();
const bStore = () => useBillStore.getState();
const jStore = () => useJournalStore.getState();
const firstSupplierId = () => useEntityStore.getState().entities.find((e) => e.entityType === 'supplier' || e.entityType === 'both')!.id;
const firstCustomerId = () => useEntityStore.getState().entities.find((e) => e.entityType === 'customer' || e.entityType === 'both')!.id;
const acc = (code: string) => useStore.getState().accounts.find((a) => a.code === code)!.id;
const je = (id: string) => jStore().entries.find((e) => e.id === id)!;
const journalCount = () => jStore().entries.length;
const line = (over: Partial<BillLine> = {}): Partial<BillLine> => ({ accountId: acc('6300'), description: 'Consulting', quantity: 1, unitPrice: 1000, taxRate: 0, ...over });

/** Create + post a bill with the given net total (taxRate 0 → balance = unitPrice). */
function postedBill(unitPrice: number, supplierInvoiceNumber: string, currency = 'USD'): string {
  const { id } = bStore().createDraft({ supplierId: firstSupplierId(), billDate: '2026-07-10', dueDate: '2026-08-10', currency });
  const bill = bStore().getBill(id!)!;
  bStore().updateDraft(id!, { supplierInvoiceNumber, lines: [{ ...bill.lines[0]!, ...line({ unitPrice }), id: 'bl0', billId: id! }] });
  bStore().postBill(id!);
  return id!;
}

function alloc(payment: Payment, billId: string, amount: number): PaymentAllocation {
  const bill = bStore().getBill(billId)!;
  return {
    id: `pa-${billId}`, entityId: payment.entityId, paymentId: payment.id, supplierId: payment.supplierId,
    billId, billNumber: bill.billNumber, allocationType: 'bill', amount, baseCurrencyAmount: amount,
    allocationDate: payment.paymentDate, createdAt: '2026-07-12', updatedAt: '2026-07-12',
  };
}

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  useInvoiceTemplateStore.getState().resetToDefault();
  useBillStore.getState().resetToDefault();
  usePaymentStore.getState().resetToDefault();
  useStore.getState().updateSettings({ logoUrl: '' });
});

/* ───────────────────────── Draft & workflow ───────────────────────── */

describe('draft does not post', () => {
  it('creating and saving a draft does not create a journal', () => {
    const before = journalCount();
    const { id } = pStore().createDraft({ supplierId: firstSupplierId(), currency: 'USD', grossAmount: 500 });
    expect(pStore().getPayment(id!)!.status).toBe('draft');
    expect(journalCount()).toBe(before);
  });
});

describe('acceptance — full supplier payment', () => {
  it('posts Dr trade payables / Cr bank, marks the bill paid and updates the supplier balance', () => {
    const billId = postedBill(1160, 'FULL-1');
    expect(supplierPayableBalance(bStore().bills, firstSupplierId(), 'primary')).toBe(1160);

    const created = pStore().createPaymentForBill(billId);
    expect(created.ok).toBe(true);
    pStore().updateDraft(created.id!, { transactionReference: 'TRX-1' });
    const before = journalCount();
    const res = pStore().postPayment(created.id!);
    expect(res.ok).toBe(true);
    expect(journalCount()).toBe(before + 1); // exactly one bank journal

    const payment = pStore().getPayment(created.id!)!;
    const entry = je(payment.journalEntryId!);
    const totals = computeTotals(entry.lines);
    expect(totals.difference).toBe(0);
    expect(entry.lines.find((l) => l.accountCode === '2210')!.debit).toBe(1160);
    expect(entry.lines.find((l) => l.accountCode === '1252')!.credit).toBe(1160);

    const bill = bStore().getBill(billId)!;
    expect(bill.status).toBe('paid');
    expect(bill.balanceDue).toBe(0);
    expect(supplierPayableBalance(bStore().bills, firstSupplierId(), 'primary')).toBe(0);
  });
});

describe('acceptance — partial payment', () => {
  it('reduces the balance and marks the bill partially paid', () => {
    const billId = postedBill(1160, 'PART-1');
    const created = pStore().createDraft({ supplierId: firstSupplierId(), currency: 'USD', grossAmount: 500 });
    const p = pStore().getPayment(created.id!)!;
    pStore().updateDraft(created.id!, { transactionReference: 'TRX-2', allocations: [alloc(p, billId, 500)] });
    expect(pStore().postPayment(created.id!).ok).toBe(true);
    const bill = bStore().getBill(billId)!;
    expect(bill.amountPaid).toBe(500);
    expect(bill.balanceDue).toBe(660);
    expect(bill.status).toBe('partially-paid');
  });
});

describe('acceptance — multi-bill allocation', () => {
  it('settles three bills with ONE journal and three allocations, no double counting', () => {
    const b1 = postedBill(2000, 'M-1');
    const b2 = postedBill(1500, 'M-2');
    const b3 = postedBill(1500, 'M-3');
    const created = pStore().createDraft({ supplierId: firstSupplierId(), currency: 'USD', grossAmount: 5000 });
    const p = pStore().getPayment(created.id!)!;
    pStore().updateDraft(created.id!, { transactionReference: 'TRX-3', allocations: [alloc(p, b1, 2000), alloc(p, b2, 1500), alloc(p, b3, 1500)] });
    const before = journalCount();
    expect(pStore().postPayment(created.id!).ok).toBe(true);
    expect(journalCount()).toBe(before + 1); // one payment journal only

    const payment = pStore().getPayment(created.id!)!;
    expect(payment.allocations.filter((a) => !a.reversed)).toHaveLength(3);
    expect(je(payment.journalEntryId!).lines.find((l) => l.accountCode === '2210')!.debit).toBe(5000);
    for (const id of [b1, b2, b3]) expect(bStore().getBill(id)!.status).toBe('paid');
    // Each bill records exactly one payment (no double counting).
    expect(bStore().getBill(b1)!.payments).toHaveLength(1);
  });
});

describe('over-allocation blocked', () => {
  it('rejects allocations exceeding the payment amount', () => {
    const billId = postedBill(1000, 'OVER-1');
    const created = pStore().createDraft({ supplierId: firstSupplierId(), grossAmount: 1000 });
    const p = pStore().getPayment(created.id!)!;
    pStore().updateDraft(created.id!, { transactionReference: 'TRX-4', allocations: [alloc(p, billId, 1500)] });
    const res = pStore().postPayment(created.id!);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exceed/i);
  });
});

/* ───────────────────────── Advance & later apply ───────────────────────── */

describe('supplier advance', () => {
  it('posts Dr supplier advances / Cr bank and recognises NO expense', () => {
    const created = pStore().createDraft({ paymentType: 'supplier-advance', supplierId: firstSupplierId(), currency: 'USD', grossAmount: 10000 });
    pStore().updateDraft(created.id!, { debitAccountId: acc('1240'), method: 'other' });
    expect(pStore().postPayment(created.id!).ok).toBe(true);
    const entry = je(pStore().getPayment(created.id!)!.journalEntryId!);
    expect(entry.lines.find((l) => l.accountCode === '1240')!.debit).toBe(10000);
    expect(entry.lines.find((l) => l.accountCode === '1252')!.credit).toBe(10000);
    // No expense account debited.
    expect(entry.lines.some((l) => l.accountCode.startsWith('6') || l.accountCode.startsWith('5'))).toBe(false);
    expect(pStore().getPayment(created.id!)!.unappliedAmount).toBe(10000);
  });

  it('applying a posted advance later does NOT create a second bank journal', () => {
    const billId = postedBill(4000, 'ADV-B1');
    const created = pStore().createDraft({ paymentType: 'supplier-advance', supplierId: firstSupplierId(), currency: 'USD', grossAmount: 10000 });
    pStore().updateDraft(created.id!, { debitAccountId: acc('1240'), method: 'other' });
    pStore().postPayment(created.id!);
    const after = journalCount();
    const res = pStore().applyPaymentToBills(created.id!, [{ billId, amount: 4000 }]);
    expect(res.ok).toBe(true);
    expect(journalCount()).toBe(after); // no new journal
    expect(bStore().getBill(billId)!.balanceDue).toBe(0);
    expect(pStore().getPayment(created.id!)!.status).toBe('partially-allocated');
  });
});

/* ───────────────────────── Other payment types ───────────────────────── */

describe('expense, tax, payroll, loan, refund', () => {
  it('expense payment requires a debit account, then posts Dr expense / Cr bank', () => {
    const created = pStore().createDraft({ paymentType: 'expense-payment', grossAmount: 500 });
    pStore().updateDraft(created.id!, { method: 'other' });
    expect(pStore().postPayment(created.id!).ok).toBe(false); // missing debit account
    pStore().updateDraft(created.id!, { debitAccountId: acc('6300') });
    expect(pStore().postPayment(created.id!).ok).toBe(true);
    const entry = je(pStore().getPayment(created.id!)!.journalEntryId!);
    expect(entry.lines.find((l) => l.accountCode === '6300')!.debit).toBe(500);
    expect(entry.lines.find((l) => l.accountCode === '1252')!.credit).toBe(500);
  });

  it('tax payment posts Dr tax payable / Cr bank', () => {
    const created = pStore().createDraft({ paymentType: 'tax-payment', grossAmount: 800 });
    pStore().updateDraft(created.id!, { method: 'other', debitAccountId: acc('2260'), taxAuthorityId: 'Revenue Authority', taxPeriod: '2026-Q1' });
    expect(pStore().postPayment(created.id!).ok).toBe(true);
    const entry = je(pStore().getPayment(created.id!)!.journalEntryId!);
    expect(entry.lines.find((l) => l.accountCode === '2260')!.debit).toBe(800);
    expect(entry.lines.find((l) => l.accountCode === '1252')!.credit).toBe(800);
  });

  it('payroll payment posts Dr payroll payable / Cr bank', () => {
    const created = pStore().createDraft({ paymentType: 'payroll-payment', grossAmount: 3000 });
    pStore().updateDraft(created.id!, { method: 'other', debitAccountId: acc('2220'), payrollPeriod: 'January 2026' });
    expect(pStore().postPayment(created.id!).ok).toBe(true);
    const entry = je(pStore().getPayment(created.id!)!.journalEntryId!);
    expect(entry.lines.find((l) => l.accountCode === '2220')!.debit).toBe(3000);
    expect(computeTotals(entry.lines).difference).toBe(0);
  });

  it('loan repayment splits principal + interest, balanced against bank', () => {
    const created = pStore().createDraft({ paymentType: 'loan-repayment' });
    pStore().updateDraft(created.id!, { method: 'other', loanAccountId: acc('2240'), interestAccountId: acc('7200'), principalAmount: 900, interestAmount: 100 });
    expect(pStore().postPayment(created.id!).ok).toBe(true);
    const entry = je(pStore().getPayment(created.id!)!.journalEntryId!);
    expect(entry.lines.find((l) => l.accountCode === '2240')!.debit).toBe(900);
    expect(entry.lines.find((l) => l.accountCode === '7200')!.debit).toBe(100);
    expect(entry.lines.find((l) => l.accountCode === '1252')!.credit).toBe(1000);
    expect(computeTotals(entry.lines).difference).toBe(0);
  });

  it('customer refund posts Dr receivables / Cr bank', () => {
    const created = pStore().createDraft({ paymentType: 'customer-refund', customerId: firstCustomerId(), grossAmount: 400 });
    pStore().updateDraft(created.id!, { method: 'other', debitAccountId: acc('1221'), refundReason: 'Overpayment' });
    expect(pStore().postPayment(created.id!).ok).toBe(true);
    const entry = je(pStore().getPayment(created.id!)!.journalEntryId!);
    expect(entry.lines.find((l) => l.accountCode === '1221')!.debit).toBe(400);
    expect(entry.lines.find((l) => l.accountCode === '1252')!.credit).toBe(400);
  });
});

/* ───────────────────────── Fees, withholding, discount, FX ───────────────────────── */

describe('fees, withholding, discount, FX', () => {
  it('bank fee is balanced and does not increase bill settlement', () => {
    const billId = postedBill(1000, 'FEE-1');
    const created = pStore().createPaymentForBill(billId);
    pStore().updateDraft(created.id!, { transactionReference: 'T', bankFeeAmount: 10 });
    expect(pStore().postPayment(created.id!).ok).toBe(true);
    const entry = je(pStore().getPayment(created.id!)!.journalEntryId!);
    expect(entry.lines.find((l) => l.accountCode === '2210')!.debit).toBe(1000);
    expect(entry.lines.find((l) => l.accountCode === '6900')!.debit).toBe(10);
    expect(entry.lines.find((l) => l.accountCode === '1252')!.credit).toBe(1010);
    expect(bStore().getBill(billId)!.balanceDue).toBe(0); // settled 1000, not 1010
  });

  it('withholding tax is balanced (Cr bank + Cr WHT payable)', () => {
    const billId = postedBill(1000, 'WHT-1');
    const created = pStore().createPaymentForBill(billId);
    pStore().updateDraft(created.id!, { transactionReference: 'T', withholdingTaxAmount: 50 });
    expect(pStore().postPayment(created.id!).ok).toBe(true);
    const entry = je(pStore().getPayment(created.id!)!.journalEntryId!);
    expect(entry.lines.find((l) => l.accountCode === '2210')!.debit).toBe(1000);
    expect(entry.lines.find((l) => l.accountCode === '1252')!.credit).toBe(950);
    expect(entry.lines.find((l) => l.accountCode === '2260')!.credit).toBe(50);
    expect(computeTotals(entry.lines).difference).toBe(0);
  });

  it('discount taken is balanced (Cr bank + Cr discount)', () => {
    const billId = postedBill(1000, 'DISC-1');
    const created = pStore().createPaymentForBill(billId);
    pStore().updateDraft(created.id!, { transactionReference: 'T', discountTakenAmount: 20 });
    expect(pStore().postPayment(created.id!).ok).toBe(true);
    const entry = je(pStore().getPayment(created.id!)!.journalEntryId!);
    expect(entry.lines.find((l) => l.accountCode === '2210')!.debit).toBe(1000);
    expect(entry.lines.find((l) => l.accountCode === '1252')!.credit).toBe(980);
    expect(entry.lines.find((l) => l.accountCode === '4300')!.credit).toBe(20);
  });

  it('realised FX loss is balanced on a foreign-currency payment', () => {
    const billId = postedBill(1000, 'FX-1', 'EUR');
    const created = pStore().createPaymentForBill(billId);
    pStore().updateDraft(created.id!, { transactionReference: 'T', realizedFxAmount: -50 });
    expect(pStore().postPayment(created.id!).ok).toBe(true);
    const entry = je(pStore().getPayment(created.id!)!.journalEntryId!);
    expect(entry.currency).toBe('EUR');
    expect(entry.lines.find((l) => l.accountCode === '2210')!.debit).toBe(1000);
    expect(entry.lines.find((l) => l.accountCode === '7300')!.debit).toBe(50);
    expect(entry.lines.find((l) => l.accountCode === '1252')!.credit).toBe(1050);
    expect(computeTotals(entry.lines).difference).toBe(0);
  });
});

/* ───────────────────────── Numbering, immutability, template ───────────────────────── */

describe('numbering, immutability & template', () => {
  it('assigns unique PAY-prefixed numbers', () => {
    const a = pStore().createDraft({ supplierId: firstSupplierId() });
    const b = pStore().createDraft({ supplierId: firstSupplierId() });
    expect(pStore().getPayment(a.id!)!.paymentNumber).toMatch(/^PAY-/);
    expect(pStore().getPayment(a.id!)!.paymentNumber).not.toBe(pStore().getPayment(b.id!)!.paymentNumber);
  });

  it('freezes a template snapshot at posting and blocks direct edits afterwards', () => {
    const billId = postedBill(1000, 'IMM-1');
    const created = pStore().createPaymentForBill(billId);
    pStore().updateDraft(created.id!, { transactionReference: 'T' });
    pStore().postPayment(created.id!);
    expect(pStore().getPayment(created.id!)!.templateSnapshot).toBeTruthy();
    expect(pStore().updateDraft(created.id!, { narration: 'x' }).ok).toBe(false);
  });
});

/* ───────────────────────── Reversal & currency guard ───────────────────────── */

describe('reversal', () => {
  it('posts an exact reversing journal, reverses allocations and restores the bill', () => {
    const billId = postedBill(1000, 'REV-1');
    const created = pStore().createPaymentForBill(billId);
    pStore().updateDraft(created.id!, { transactionReference: 'T' });
    pStore().postPayment(created.id!);
    expect(bStore().getBill(billId)!.status).toBe('paid');

    const count = journalCount();
    const res = pStore().reversePayment(created.id!, 'paid in error');
    expect(res.ok).toBe(true);
    expect(journalCount()).toBe(count + 1);
    const payment = pStore().getPayment(created.id!)!;
    expect(payment.status).toBe('reversed');
    const rev = je(payment.reversalJournalEntryId!);
    expect(rev.lines.find((l) => l.accountCode === '2210')!.credit).toBe(1000); // exact opposite
    expect(rev.lines.find((l) => l.accountCode === '1252')!.debit).toBe(1000);
    // Bill restored.
    const bill = bStore().getBill(billId)!;
    expect(bill.balanceDue).toBe(1000);
    expect(bill.status).toBe('posted');
    expect(payment.allocations.every((a) => a.reversed)).toBe(true);
  });
});

describe('currency mismatch blocked', () => {
  it('rejects allocating a USD payment to a EUR bill', () => {
    const billId = postedBill(1000, 'CUR-1', 'EUR');
    const created = pStore().createDraft({ paymentType: 'supplier-payment', supplierId: firstSupplierId(), currency: 'USD', grossAmount: 1000 });
    const p = pStore().getPayment(created.id!)!;
    pStore().updateDraft(created.id!, { transactionReference: 'T', allocations: [alloc(p, billId, 1000)] });
    const res = pStore().postPayment(created.id!);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/different currency/i);
  });
});

/* ───────────────────────── Persistence ───────────────────────── */

describe('persistence', () => {
  it('replaceAll rehydrates posted payments and allocations without loss', () => {
    const billId = postedBill(1000, 'PER-1');
    const created = pStore().createPaymentForBill(billId);
    pStore().updateDraft(created.id!, { transactionReference: 'T' });
    pStore().postPayment(created.id!);
    const snapshot = JSON.parse(JSON.stringify(pStore().payments));
    pStore().replaceAll(snapshot);
    const payment = pStore().getPayment(created.id!)!;
    expect(payment.status).toBe('fully-allocated');
    expect(payment.journalEntryId).toBeTruthy();
    expect(payment.allocations).toHaveLength(1);
  });
});

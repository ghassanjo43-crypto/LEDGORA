import { describe, it, expect, beforeEach } from 'vitest';
import { useBillStore } from './billStore';
import { useInvoiceTemplateStore } from './invoiceTemplateStore';
import { useJournalStore } from './journalStore';
import { useStore } from './useStore';
import { useEntityStore } from './useEntityStore';
import { computeTotals } from '@/lib/journalValidation';
import { supplierPayableBalance, calculateBillAging, buildBillSettlementSummary } from '@/lib/billSettlement';
import type { BillLine } from '@/types/bill';

const bStore = () => useBillStore.getState();
const jStore = () => useJournalStore.getState();
const firstSupplierId = () => useEntityStore.getState().entities.find((e) => e.entityType === 'supplier' || e.entityType === 'both')!.id;
const acc = (code: string) => useStore.getState().accounts.find((a) => a.code === code)!.id;
const je = (id: string) => jStore().entries.find((e) => e.id === id)!;
const journalCount = () => jStore().entries.length;

function line(over: Partial<BillLine>): Partial<BillLine> {
  return { accountId: acc('6300'), description: 'Consulting', quantity: 1, unitPrice: 1000, taxRate: 16, ...over };
}

function draftBill(patch: { supplierInvoiceNumber?: string; billDate?: string; dueDate?: string; currency?: string; lines?: Partial<BillLine>[] } = {}): string {
  const { id } = bStore().createDraft({ supplierId: firstSupplierId(), billDate: patch.billDate ?? '2026-07-10', dueDate: patch.dueDate ?? '2026-08-10', currency: patch.currency ?? 'USD' });
  const bill = bStore().getBill(id!)!;
  const lines = (patch.lines ?? [line({})]).map((l, i) => ({ ...bill.lines[0]!, ...l, id: `bl${i}`, billId: id! }));
  bStore().updateDraft(id!, { supplierInvoiceNumber: patch.supplierInvoiceNumber ?? 'ABC-8842', lines });
  return id!;
}
function postedBill(patch: Parameters<typeof draftBill>[0] = {}): string {
  const id = draftBill(patch);
  bStore().postBill(id);
  return id;
}

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  useInvoiceTemplateStore.getState().resetToDefault();
  useBillStore.getState().resetToDefault();
  useStore.getState().updateSettings({ logoUrl: '' });
});

describe('acceptance 1 — expense bill', () => {
  it('posts Dr expense / Dr input VAT / Cr trade payables and does not move cash', () => {
    const before = journalCount();
    const id = draftBill();
    expect(bStore().getBill(id)!.status).toBe('draft');
    expect(journalCount()).toBe(before); // draft does not affect accounting

    const res = bStore().postBill(id);
    expect(res.ok).toBe(true);
    const bill = bStore().getBill(id)!;
    expect(bill.status).toBe('posted');
    expect(bill.grandTotal).toBe(1160);
    expect(bill.balanceDue).toBe(1160);

    const entry = je(bill.journalEntryId!);
    const totals = computeTotals(entry.lines);
    expect(totals.totalDebit).toBe(1160);
    expect(totals.totalCredit).toBe(1160);
    expect(entry.lines.find((l) => l.accountCode === '6300')!.debit).toBe(1000); // expense
    expect(entry.lines.find((l) => l.accountCode === '2270')!.debit).toBe(160); // input VAT
    expect(entry.lines.find((l) => l.accountCode === '2210')!.credit).toBe(1160); // trade payables
    // No bank/cash line at posting.
    expect(entry.lines.some((l) => l.accountCode === '1252' || l.accountCode === '1251')).toBe(false);
    // Supplier balance +1,160.
    expect(supplierPayableBalance(bStore().bills, firstSupplierId(), 'primary')).toBe(1160);
  });
});

describe('acceptance 2 — partial payment', () => {
  it('reduces the balance and marks partially paid; payment posts Dr AP / Cr bank', () => {
    const id = postedBill();
    const res = bStore().recordPayment(id, { amount: 500, date: '2026-08-01', bankAccountId: acc('1252') });
    expect(res.ok).toBe(true);
    const bill = bStore().getBill(id)!;
    expect(bill.amountPaid).toBe(500);
    expect(bill.balanceDue).toBe(660);
    expect(bill.status).toBe('partially-paid');
    const pay = je(bill.payments[0]!.journalEntryId!);
    expect(pay.lines.find((l) => l.accountCode === '2210')!.debit).toBe(500);
    expect(pay.lines.find((l) => l.accountCode === '1252')!.credit).toBe(500);
  });

  it('full payment marks the bill paid', () => {
    const id = postedBill();
    bStore().recordPayment(id, { amount: 1160, date: '2026-08-01', bankAccountId: acc('1252') });
    expect(bStore().getBill(id)!.status).toBe('paid');
    expect(bStore().getBill(id)!.balanceDue).toBe(0);
  });
});

describe('acceptance 3 — supplier credit', () => {
  it('posts Dr trade payables / Cr expense + input VAT and reduces the balance without touching the total', () => {
    const id = postedBill();
    const res = bStore().createSupplierCredit(id, { netAmount: 500, taxAmount: 80, creditAccountId: acc('6300'), reason: 'Return' });
    expect(res.ok).toBe(true);
    const bill = bStore().getBill(id)!;
    expect(bill.grandTotal).toBe(1160); // original total unchanged
    expect(bill.supplierCreditsApplied).toBe(580);
    expect(bill.balanceDue).toBe(580);
    const credit = je(bill.supplierCredits[0]!.journalEntryId!);
    expect(credit.lines.find((l) => l.accountCode === '2210')!.debit).toBe(580);
    expect(credit.lines.find((l) => l.accountCode === '6300')!.credit).toBe(500);
    expect(credit.lines.find((l) => l.accountCode === '2270')!.credit).toBe(80);
    expect(buildBillSettlementSummary(bill).status).toBe('partially-credited');
  });
});

describe('acceptance 4 — asset bill', () => {
  it('debits the asset account and input VAT, credits trade payables', () => {
    const id = postedBill({ supplierInvoiceNumber: 'EQ-1', lines: [line({ accountId: acc('1114'), description: 'Equipment', unitPrice: 25000, taxRate: 16 })] });
    const bill = bStore().getBill(id)!;
    expect(bill.grandTotal).toBe(29000);
    const entry = je(bill.journalEntryId!);
    expect(entry.lines.find((l) => l.accountCode === '1114')!.debit).toBe(25000);
    expect(entry.lines.find((l) => l.accountCode === '2270')!.debit).toBe(4000);
    expect(entry.lines.find((l) => l.accountCode === '2210')!.credit).toBe(29000);
    expect(entry.lines.some((l) => l.accountCode === '1252')).toBe(false); // no cash movement
  });
});

describe('withholding tax', () => {
  it('reduces the payable and credits withholding tax payable', () => {
    const id = postedBill({ supplierInvoiceNumber: 'WHT-1', lines: [line({ taxRate: 0, withholdingTaxRate: 5 })] });
    const bill = bStore().getBill(id)!;
    expect(bill.grandTotal).toBe(1000);
    expect(bill.withholdingTaxTotal).toBe(50);
    expect(bill.balanceDue).toBe(950); // net payable
    const entry = je(bill.journalEntryId!);
    expect(entry.lines.find((l) => l.accountCode === '2210')!.credit).toBe(950);
    expect(entry.lines.find((l) => l.accountCode === '2260')!.credit).toBe(50);
    expect(computeTotals(entry.lines).difference).toBe(0);
  });
});

describe('duplicate control, numbering & immutability', () => {
  it('blocks a duplicate supplier invoice number for the same supplier', () => {
    postedBill({ supplierInvoiceNumber: 'DUP-1' });
    const second = draftBill({ supplierInvoiceNumber: 'DUP-1' });
    const res = bStore().postBill(second);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already recorded/i);
  });

  it('assigns unique BILL-prefixed numbers', () => {
    const a = bStore().createDraft({ supplierId: firstSupplierId() });
    const b = bStore().createDraft({ supplierId: firstSupplierId() });
    const na = bStore().getBill(a.id!)!.billNumber;
    expect(na).toMatch(/^BILL-/);
    expect(na).not.toBe(bStore().getBill(b.id!)!.billNumber);
  });

  it('a posted bill cannot be edited directly', () => {
    const id = postedBill();
    expect(bStore().updateDraft(id, { notes: 'x' }).ok).toBe(false);
  });
});

describe('reversal', () => {
  it('posts an exact reversing entry and restores the supplier balance', () => {
    const id = postedBill();
    expect(supplierPayableBalance(bStore().bills, firstSupplierId(), 'primary')).toBe(1160);
    const count = journalCount();
    const res = bStore().reverseBill(id, 'posted in error');
    expect(res.ok).toBe(true);
    expect(journalCount()).toBe(count + 1);
    const bill = bStore().getBill(id)!;
    expect(bill.status).toBe('reversed');
    expect(bill.reversalJournalEntryId).toBeTruthy();
    const rev = je(bill.reversalJournalEntryId!);
    expect(rev.lines.find((l) => l.accountCode === '2210')!.debit).toBe(1160); // exact opposite
    expect(rev.lines.find((l) => l.accountCode === '6300')!.credit).toBe(1000);
    expect(supplierPayableBalance(bStore().bills, firstSupplierId(), 'primary')).toBe(0);
  });
});

describe('AP aging, multi-currency & cash flow', () => {
  it('ages the remaining balance by due date', () => {
    postedBill({ supplierInvoiceNumber: 'OLD-1', billDate: '2026-05-01', dueDate: '2026-05-15' });
    const aging = calculateBillAging(bStore().bills, '2026-07-31');
    expect(aging.total).toBe(1160);
    // 2026-05-15 → 2026-07-31 is 77 days overdue → 61-90 bucket.
    expect(aging.buckets.find((b) => b.id === '61-90')!.amount).toBe(1160);
  });

  it('stores the foreign currency + rate and posts realised FX on payment', () => {
    const id = postedBill({ supplierInvoiceNumber: 'FX-1', currency: 'EUR', lines: [line({ taxRate: 0 })] });
    const bill = bStore().getBill(id)!;
    expect(bill.currency).toBe('EUR');
    expect(je(bill.journalEntryId!).currency).toBe('EUR');
    const res = bStore().recordPayment(id, { amount: 1000, date: '2026-08-01', bankAccountId: acc('1252'), realizedFxAmount: -50 });
    expect(res.ok).toBe(true);
    const pay = je(bStore().getBill(id)!.payments[0]!.journalEntryId!);
    expect(computeTotals(pay.lines).difference).toBe(0);
    expect(pay.lines.find((l) => l.accountCode === '7300')!.debit).toBe(50); // realised FX loss
    expect(pay.lines.find((l) => l.accountCode === '1252')!.credit).toBe(1050);
  });

  it('bill posting is non-cash; payment credits the OPERATING bank account', () => {
    const id = postedBill();
    bStore().recordPayment(id, { amount: 1160, date: '2026-08-01', bankAccountId: acc('1252') });
    const bank = useStore.getState().accounts.find((a) => a.code === '1252')!;
    expect(bank.cashFlowCategory).toBe('OPERATING');
    const bill = bStore().getBill(id)!;
    // Bill journal has no cash line; payment journal does.
    expect(je(bill.journalEntryId!).lines.some((l) => l.accountCode === '1252')).toBe(false);
    expect(je(bill.payments[0]!.journalEntryId!).lines.some((l) => l.accountCode === '1252')).toBe(true);
  });
});

describe('persistence', () => {
  it('replaceAll rehydrates bills without loss', () => {
    const id = postedBill();
    bStore().recordPayment(id, { amount: 500, date: '2026-08-01', bankAccountId: acc('1252') });
    const snapshot = JSON.parse(JSON.stringify(useBillStore.getState().bills));
    useBillStore.getState().replaceAll(snapshot);
    const bill = bStore().getBill(id)!;
    expect(bill.grandTotal).toBe(1160);
    expect(bill.amountPaid).toBe(500);
    expect(bill.journalEntryId).toBeTruthy();
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { useReceiptStore } from './receiptStore';
import { useInvoiceStore } from './invoiceStore';
import { useInvoiceTemplateStore } from './invoiceTemplateStore';
import { useJournalStore } from './journalStore';
import { useStore } from './useStore';
import { useEntityStore, entityToFormValues } from './useEntityStore';
import { computeTotals } from '@/lib/journalValidation';
import type { ReceiptAllocation } from '@/types/receipt';
import type { Invoice } from '@/types/invoice';

function customerIds(): string[] {
  return useEntityStore.getState().entities.filter((e) => e.entityType === 'customer' || e.entityType === 'both').map((e) => e.id);
}
const custA = () => customerIds()[0]!;
const custB = () => customerIds()[1] ?? customerIds()[0]!;
function clearCustomerTemplate(id: string): void {
  const e = useEntityStore.getState().entities.find((x) => x.id === id)!;
  useEntityStore.getState().updateEntity(id, { ...entityToFormValues(e), defaultInvoiceTemplateId: '' });
}
const acc = (code: string) => useStore.getState().accounts.find((a) => a.code === code)!;
const revenueId = () => acc('4120').id;
const journalCount = () => useJournalStore.getState().entries.length;
const je = (id: string) => useJournalStore.getState().entries.find((e) => e.id === id)!;
const rStore = () => useReceiptStore.getState();
const iStore = () => useInvoiceStore.getState();

function issuedInvoice(customerId: string, qty: number, unitPrice: number, taxRate: number): string {
  const { id } = iStore().createDraft({ customerId });
  const inv = iStore().getInvoice(id!)!;
  iStore().updateDraft(id!, { lines: [{ ...inv.lines[0]!, accountId: revenueId(), description: 'Service', quantity: qty, unitPrice, taxRate }] });
  iStore().issueInvoice(id!);
  return id!;
}

function allocation(receiptId: string, inv: Invoice, amount: number): ReceiptAllocation {
  const now = new Date().toISOString();
  return {
    id: `alloc_${inv.id}`, entityId: inv.entityId, receiptId, customerId: inv.customerId,
    invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, allocationType: 'invoice',
    amount, baseCurrencyAmount: amount, allocationDate: now.slice(0, 10), createdAt: now, updatedAt: now,
  };
}

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  useInvoiceTemplateStore.getState().resetToDefault();
  useInvoiceStore.getState().resetToDefault();
  useReceiptStore.getState().resetToDefault();
  useStore.getState().updateSettings({ logoUrl: '' });
  customerIds().forEach(clearCustomerTemplate);
});

describe('draft receipts', () => {
  it('creating and editing a draft posts nothing', () => {
    const before = journalCount();
    const { id } = rStore().createDraft({ customerId: custA(), amount: 500 });
    expect(rStore().getReceiptById(id!)!.status).toBe('draft');
    expect(rStore().getReceiptById(id!)!.journalEntryId).toBeUndefined();
    expect(journalCount()).toBe(before);
  });
});

describe('acceptance 1 — full invoice receipt', () => {
  it('posts Dr bank / Cr receivables and marks the invoice paid', () => {
    const invId = issuedInvoice(custA(), 1, 1000, 16); // 1,160
    const r = rStore().createReceiptForInvoice(invId);
    rStore().updateDraft(r.id!, { transactionReference: 'TRX-10001' });
    const before = journalCount();
    const res = rStore().postReceipt(r.id!);
    expect(res.ok).toBe(true);
    expect(journalCount()).toBe(before + 1);

    const rec = rStore().getReceiptById(r.id!)!;
    expect(rec.status).toBe('fully-allocated');
    expect(rec.amount).toBe(1160);
    expect(rec.unappliedAmount).toBe(0);
    expect(rec.templateSnapshot).toBeTruthy();

    const entry = je(rec.journalEntryId!);
    expect(entry.status).toBe('posted');
    const totals = computeTotals(entry.lines);
    expect(totals.totalDebit).toBe(1160);
    expect(totals.totalCredit).toBe(1160);
    expect(entry.lines.find((l) => l.accountCode === '1252')!.debit).toBe(1160); // bank
    expect(entry.lines.find((l) => l.accountCode === '1221')!.credit).toBe(1160); // receivables

    const inv = iStore().getInvoice(invId)!;
    expect(inv.grandTotal).toBe(1160); // untouched
    expect(inv.balanceDue).toBe(0);
    expect(inv.status).toBe('paid');
    // Receipt appears on the invoice and in the customer's receipt list.
    expect(rStore().getReceiptsForInvoice(invId)).toHaveLength(1);
    expect(rStore().getReceiptsForCustomer(custA()).length).toBeGreaterThan(0);
  });
});

describe('acceptance 2 — partial receipt', () => {
  it('marks the invoice partially paid with the correct balance', () => {
    const invId = issuedInvoice(custA(), 1, 1000, 16); // 1,160
    const inv = iStore().getInvoice(invId)!;
    const { id } = rStore().createDraft({ customerId: custA(), amount: 500 });
    rStore().updateDraft(id!, { transactionReference: 'TRX', allocations: [allocation(id!, inv, 500)] });
    expect(rStore().postReceipt(id!).ok).toBe(true);

    const after = iStore().getInvoice(invId)!;
    expect(after.status).toBe('partially-paid');
    expect(after.amountPaid).toBe(500);
    expect(after.balanceDue).toBe(660);
    const entry = je(rStore().getReceiptById(id!)!.journalEntryId!);
    expect(entry.lines.find((l) => l.accountCode === '1252')!.debit).toBe(500);
    expect(entry.lines.find((l) => l.accountCode === '1221')!.credit).toBe(500);
  });
});

describe('acceptance 3 — multiple invoices', () => {
  it('settles several invoices from one receipt with one journal and three allocations', () => {
    const a = issuedInvoice(custA(), 1, 2000, 0);
    const b = issuedInvoice(custA(), 1, 1500, 0);
    const c = issuedInvoice(custA(), 1, 2500, 0);
    const invA = iStore().getInvoice(a)!, invB = iStore().getInvoice(b)!, invC = iStore().getInvoice(c)!;
    const { id } = rStore().createDraft({ customerId: custA(), amount: 5000 });
    rStore().updateDraft(id!, { transactionReference: 'TRX', allocations: [allocation(id!, invA, 2000), allocation(id!, invB, 1500), allocation(id!, invC, 1500)] });
    const before = journalCount();
    expect(rStore().postReceipt(id!).ok).toBe(true);

    expect(journalCount()).toBe(before + 1); // ONE journal
    const rec = rStore().getReceiptById(id!)!;
    expect(rec.allocations.filter((x) => !x.reversed)).toHaveLength(3);
    expect(rec.allocationTotal).toBe(5000);
    expect(rec.unappliedAmount).toBe(0);
    expect(iStore().getInvoice(a)!.status).toBe('paid');
    expect(iStore().getInvoice(b)!.status).toBe('paid');
    expect(iStore().getInvoice(c)!.status).toBe('partially-paid');
    expect(iStore().getInvoice(c)!.balanceDue).toBe(1000);
    // The aggregated bank debit is a single line, not one per invoice.
    expect(je(rec.journalEntryId!).lines.filter((l) => l.accountCode === '1252')).toHaveLength(1);
  });
});

describe('allocation guards', () => {
  it('allocation cannot exceed the receipt amount', () => {
    const invId = issuedInvoice(custA(), 1, 2000, 0);
    const inv = iStore().getInvoice(invId)!;
    const { id } = rStore().createDraft({ customerId: custA(), amount: 1000 });
    rStore().updateDraft(id!, { transactionReference: 'TRX', allocations: [allocation(id!, inv, 1500)] });
    const res = rStore().postReceipt(id!);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exceed the receipt amount/i);
  });

  it('allocation cannot exceed the invoice balance', () => {
    const invId = issuedInvoice(custA(), 1, 500, 0);
    const inv = iStore().getInvoice(invId)!;
    const { id } = rStore().createDraft({ customerId: custA(), amount: 2000 });
    rStore().updateDraft(id!, { transactionReference: 'TRX', allocations: [allocation(id!, inv, 800)] });
    const res = rStore().postReceipt(id!);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/balance due/i);
  });

  it('overpayment remains unapplied (no forced allocation, no fake revenue)', () => {
    const invId = issuedInvoice(custA(), 1, 1500, 0);
    const inv = iStore().getInvoice(invId)!;
    const { id } = rStore().createDraft({ customerId: custA(), amount: 2000 });
    rStore().updateDraft(id!, { transactionReference: 'TRX', allocations: [allocation(id!, inv, 1500)] });
    expect(rStore().postReceipt(id!).ok).toBe(true);
    const rec = rStore().getReceiptById(id!)!;
    expect(rec.unappliedAmount).toBe(500);
    expect(rec.status).toBe('partially-allocated');
    expect(iStore().getInvoice(invId)!.status).toBe('paid');
  });

  it('blocks allocating to another customer’s invoice', () => {
    const invB = iStore().getInvoice(issuedInvoice(custB(), 1, 1000, 0))!;
    const { id } = rStore().createDraft({ customerId: custA(), amount: 1000 });
    rStore().updateDraft(id!, { transactionReference: 'TRX', allocations: [allocation(id!, invB, 1000)] });
    const res = rStore().postReceipt(id!);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/different customer/i);
  });
});

describe('acceptance 4 — customer advance', () => {
  it('posts Dr bank / Cr customer advances with the full amount unapplied', () => {
    const { id } = rStore().createDraft({ receiptType: 'customer-advance', customerId: custB(), amount: 10000 });
    rStore().updateDraft(id!, { transactionReference: 'TRX' });
    expect(rStore().postReceipt(id!).ok).toBe(true);
    const rec = rStore().getReceiptById(id!)!;
    expect(rec.status).toBe('posted');
    expect(rec.unappliedAmount).toBe(10000);
    const entry = je(rec.journalEntryId!);
    expect(entry.lines.find((l) => l.accountCode === '1252')!.debit).toBe(10000);
    expect(entry.lines.find((l) => l.accountCode === '2230')!.credit).toBe(10000); // customer advances / contract liabilities
  });
});

describe('acceptance 5 — bank fee', () => {
  it('splits the deposit: Dr bank 990 / Dr fee 10 / Cr receivables 1000', () => {
    const invId = issuedInvoice(custA(), 1, 1000, 0);
    const inv = iStore().getInvoice(invId)!;
    const { id } = rStore().createDraft({ customerId: custA(), amount: 1000 });
    rStore().updateDraft(id!, { transactionReference: 'TRX', bankFeeAmount: 10, bankFeeAccountId: acc('6900').id, allocations: [allocation(id!, inv, 1000)] });
    expect(rStore().postReceipt(id!).ok).toBe(true);
    const entry = je(rStore().getReceiptById(id!)!.journalEntryId!);
    const t = computeTotals(entry.lines);
    expect(t.totalDebit).toBe(1000);
    expect(t.totalCredit).toBe(1000);
    expect(entry.lines.find((l) => l.accountCode === '1252')!.debit).toBe(990);
    expect(entry.lines.find((l) => l.accountCode === '6900')!.debit).toBe(10);
    expect(entry.lines.find((l) => l.accountCode === '1221')!.credit).toBe(1000);
    // Invoice settled by the full 1,000 despite the fee.
    expect(iStore().getInvoice(invId)!.balanceDue).toBe(0);
  });
});

describe('withholding tax', () => {
  it('splits: Dr bank 950 / Dr WHT 50 / Cr receivables 1000', () => {
    const invId = issuedInvoice(custA(), 1, 1000, 0);
    const inv = iStore().getInvoice(invId)!;
    const { id } = rStore().createDraft({ customerId: custA(), amount: 1000 });
    rStore().updateDraft(id!, { transactionReference: 'TRX', withholdingTaxAmount: 50, withholdingTaxAccountId: acc('1223').id, allocations: [allocation(id!, inv, 1000)] });
    expect(rStore().postReceipt(id!).ok).toBe(true);
    const entry = je(rStore().getReceiptById(id!)!.journalEntryId!);
    expect(computeTotals(entry.lines).difference).toBe(0);
    expect(entry.lines.find((l) => l.accountCode === '1252')!.debit).toBe(950);
    expect(entry.lines.find((l) => l.accountCode === '1223')!.debit).toBe(50);
    expect(entry.lines.find((l) => l.accountCode === '1221')!.credit).toBe(1000);
  });
});

describe('receipt types & accounts', () => {
  it('cash receipt posts to the cash-on-hand account', () => {
    const invId = issuedInvoice(custA(), 1, 500, 0);
    const inv = iStore().getInvoice(invId)!;
    const { id } = rStore().createDraft({ customerId: custA(), amount: 500, method: 'cash' });
    rStore().updateDraft(id!, { method: 'cash', bankAccountId: acc('1251').id, allocations: [allocation(id!, inv, 500)] });
    expect(rStore().postReceipt(id!).ok).toBe(true);
    expect(je(rStore().getReceiptById(id!)!.journalEntryId!).lines.find((l) => l.accountCode === '1251')!.debit).toBe(500);
  });

  it('owner contribution posts to equity (financing)', () => {
    const { id } = rStore().createDraft({ receiptType: 'owner-contribution', amount: 100000 });
    rStore().updateDraft(id!, { payerName: 'Owner', transactionReference: 'TRX', creditAccountId: acc('3100').id });
    expect(rStore().postReceipt(id!).ok).toBe(true);
    const entry = je(rStore().getReceiptById(id!)!.journalEntryId!);
    expect(entry.lines.find((l) => l.accountCode === '3100')!.credit).toBe(100000);
    expect(acc('3100').cashFlowCategory).toBe('FINANCING'); // cash-flow classification via account metadata
  });

  it('loan proceeds post to a borrowing liability (financing)', () => {
    const { id } = rStore().createDraft({ receiptType: 'loan-proceeds', amount: 50000 });
    rStore().updateDraft(id!, { payerName: 'Bank', transactionReference: 'TRX', creditAccountId: acc('2240').id });
    expect(rStore().postReceipt(id!).ok).toBe(true);
    expect(je(rStore().getReceiptById(id!)!.journalEntryId!).lines.find((l) => l.accountCode === '2240')!.credit).toBe(50000);
    expect(acc('2240').cashFlowCategory).toBe('FINANCING');
  });

  it('an "other" receipt requires an explicit credit account', () => {
    const { id } = rStore().createDraft({ receiptType: 'other', amount: 100 });
    rStore().updateDraft(id!, { payerName: 'X', transactionReference: 'TRX' });
    const res = rStore().postReceipt(id!);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/credit account/i);
  });

  it('a customer receipt credits the OPERATING receivables control', () => {
    const invId = issuedInvoice(custA(), 1, 100, 0);
    const inv = iStore().getInvoice(invId)!;
    const { id } = rStore().createDraft({ customerId: custA(), amount: 100 });
    rStore().updateDraft(id!, { transactionReference: 'TRX', allocations: [allocation(id!, inv, 100)] });
    rStore().postReceipt(id!);
    expect(acc('1221').cashFlowCategory).toBe('OPERATING');
  });
});

describe('unapplied receipt & later application', () => {
  it('an unapplied receipt persists and can be applied later without a second bank journal', () => {
    const { id } = rStore().createDraft({ receiptType: 'unapplied-customer-receipt', customerId: custA(), amount: 1000 });
    rStore().updateDraft(id!, { transactionReference: 'TRX' });
    rStore().postReceipt(id!);
    expect(rStore().getReceiptById(id!)!.unappliedAmount).toBe(1000);

    const invId = issuedInvoice(custA(), 1, 600, 0); // issue first (posts its own journal)
    const jcount = journalCount();
    const res = rStore().applyReceiptToInvoices(id!, [{ invoiceId: invId, amount: 600 }]);
    expect(res.ok).toBe(true);
    expect(journalCount()).toBe(jcount); // NO new bank journal for a subledger allocation
    expect(iStore().getInvoice(invId)!.balanceDue).toBe(0);
    const rec = rStore().getReceiptById(id!)!;
    expect(rec.unappliedAmount).toBe(400);
    expect(rec.status).toBe('partially-allocated');
  });
});

describe('immutability, reversal & numbering', () => {
  it('a posted receipt cannot be edited', () => {
    const invId = issuedInvoice(custA(), 1, 500, 0);
    const inv = iStore().getInvoice(invId)!;
    const { id } = rStore().createDraft({ customerId: custA(), amount: 500 });
    rStore().updateDraft(id!, { transactionReference: 'TRX', allocations: [allocation(id!, inv, 500)] });
    rStore().postReceipt(id!);
    expect(rStore().updateDraft(id!, { narration: 'x' }).ok).toBe(false);
  });

  it('reversal creates the exact opposite journal and restores the invoice', () => {
    const invId = issuedInvoice(custA(), 1, 1000, 16); // 1,160
    const r = rStore().createReceiptForInvoice(invId);
    rStore().updateDraft(r.id!, { transactionReference: 'TRX' });
    rStore().postReceipt(r.id!);
    expect(iStore().getInvoice(invId)!.status).toBe('paid');

    const count = journalCount();
    const res = rStore().reverseReceipt(r.id!, 'posted in error');
    expect(res.ok).toBe(true);
    expect(journalCount()).toBe(count + 1);
    const rec = rStore().getReceiptById(r.id!)!;
    expect(rec.status).toBe('reversed');
    expect(rec.reversalJournalEntryId).toBeTruthy();
    expect(rec.allocations.every((a) => a.reversed)).toBe(true);

    const inv = iStore().getInvoice(invId)!;
    expect(inv.amountPaid).toBe(0);
    expect(inv.balanceDue).toBe(1160);
    expect(inv.status).toBe('issued');
    // Reversal is Dr receivables / Cr bank — the exact opposite.
    const rev = je(rec.reversalJournalEntryId!);
    expect(rev.lines.find((l) => l.accountCode === '1221')!.debit).toBe(1160);
    expect(rev.lines.find((l) => l.accountCode === '1252')!.credit).toBe(1160);
  });

  it('receipt numbers are unique and RCT-prefixed', () => {
    const a = rStore().createDraft({ customerId: custA(), amount: 1 });
    const b = rStore().createDraft({ customerId: custA(), amount: 1 });
    const na = rStore().getReceiptById(a.id!)!.receiptNumber;
    const nb = rStore().getReceiptById(b.id!)!.receiptNumber;
    expect(na).toMatch(/^RCT-/);
    expect(na).not.toBe(nb);
  });
});

describe('multi-currency & persistence', () => {
  it('computes the base-currency amount from the exchange rate', () => {
    const { id } = rStore().createDraft({ receiptType: 'miscellaneous-income', currency: 'EUR', amount: 100 });
    rStore().updateDraft(id!, { exchangeRate: 1.1, creditAccountId: acc('4300').id });
    expect(rStore().getReceiptById(id!)!.baseCurrencyAmount).toBe(110);
  });

  it('replaceAll rehydrates receipts without loss', () => {
    const invId = issuedInvoice(custA(), 1, 500, 0);
    const inv = iStore().getInvoice(invId)!;
    const { id } = rStore().createDraft({ customerId: custA(), amount: 500 });
    rStore().updateDraft(id!, { transactionReference: 'TRX', allocations: [allocation(id!, inv, 500)] });
    rStore().postReceipt(id!);
    const snapshot = JSON.parse(JSON.stringify(useReceiptStore.getState().receipts));
    useReceiptStore.getState().replaceAll(snapshot);
    const rec = rStore().getReceiptById(id!)!;
    expect(rec.amount).toBe(500);
    expect(rec.journalEntryId).toBeTruthy();
    expect(rec.allocations).toHaveLength(1);
  });
});

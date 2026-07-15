import type { Invoice } from '@/types/invoice';
import type { Receipt } from '@/types/receipt';
import { roundMoney } from '@/lib/journalValidation';

export interface EligibleInvoiceFilter {
  entityId: string;
  customerId: string;
  currency: string;
}

/**
 * Open invoices a receipt may settle: same entity + customer + currency, issued
 * (never draft or void) and still carrying a balance. Sorted oldest-due first so
 * the default allocation policy has a stable order.
 */
export function getEligibleInvoicesForReceipt(invoices: Invoice[], filter: EligibleInvoiceFilter): Invoice[] {
  return invoices
    .filter((i) => i.customerId === filter.customerId && i.entityId === filter.entityId)
    .filter((i) => i.status !== 'draft' && i.status !== 'void')
    .filter((i) => i.currency === filter.currency)
    .filter((i) => i.balanceDue > 0.005)
    .sort((a, b) => (a.dueDate || a.issueDate).localeCompare(b.dueDate || b.issueDate) || a.issueDate.localeCompare(b.issueDate));
}

export type AutoAllocateStrategy = 'oldest-due' | 'by-invoice-date';

/**
 * Greedily allocate `amount` across the eligible invoices, filling each up to its
 * balance due until the money runs out. Returns the per-invoice allocation map;
 * any remainder is the receipt's unapplied amount. Never over-allocates a line.
 */
export function autoAllocateReceipt(
  invoices: Invoice[],
  amount: number,
  strategy: AutoAllocateStrategy = 'oldest-due',
): Map<string, number> {
  const ordered = [...invoices].sort((a, b) =>
    strategy === 'by-invoice-date'
      ? a.issueDate.localeCompare(b.issueDate)
      : (a.dueDate || a.issueDate).localeCompare(b.dueDate || b.issueDate) || a.issueDate.localeCompare(b.issueDate),
  );
  const result = new Map<string, number>();
  let remaining = roundMoney(Number(amount) || 0);
  for (const inv of ordered) {
    if (remaining <= 0.005) break;
    const take = roundMoney(Math.min(remaining, inv.balanceDue));
    if (take > 0) {
      result.set(inv.id, take);
      remaining = roundMoney(remaining - take);
    }
  }
  return result;
}

export interface CustomerReceiptSummary {
  /** Unapplied money held against the customer across posted receipts. */
  unappliedReceipts: number;
  /** Money received as an explicit customer advance. */
  advances: number;
}

/**
 * Aggregate a customer's unapplied receipt / advance position across all their
 * posted (non-reversed, non-void) receipts.
 */
export function calculateCustomerUnappliedReceipts(customerId: string, receipts: Receipt[]): CustomerReceiptSummary {
  let unappliedReceipts = 0;
  let advances = 0;
  for (const r of receipts) {
    if (r.customerId !== customerId) continue;
    if (r.status === 'draft' || r.status === 'reversed' || r.status === 'void') continue;
    if (r.receiptType === 'customer-advance') advances += r.unappliedAmount;
    else if (r.receiptType === 'customer-payment' || r.receiptType === 'unapplied-customer-receipt') unappliedReceipts += r.unappliedAmount;
  }
  return { unappliedReceipts: roundMoney(unappliedReceipts), advances: roundMoney(advances) };
}

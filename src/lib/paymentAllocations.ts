import type { Bill } from '@/types/bill';
import type { Payment } from '@/types/payment';
import { isOpenBill } from '@/lib/billSettlement';
import { roundMoney } from '@/lib/journalValidation';

export interface EligibleBillFilter {
  entityId: string;
  supplierId: string;
  currency: string;
}

/**
 * Open bills a payment may settle: same entity + supplier + currency, posted
 * (never draft, void or reversed) and still carrying a balance. Sorted
 * oldest-due first so the default allocation policy has a stable order.
 */
export function getEligibleBillsForPayment(bills: Bill[], filter: EligibleBillFilter): Bill[] {
  return bills
    .filter((b) => b.supplierId === filter.supplierId && b.entityId === filter.entityId)
    .filter((b) => b.currency === filter.currency)
    .filter(isOpenBill)
    .sort((a, b) => (a.dueDate || a.billDate).localeCompare(b.dueDate || b.billDate) || a.billDate.localeCompare(b.billDate));
}

export type AutoAllocateStrategy = 'oldest-due' | 'by-bill-date';

/**
 * Greedily allocate `amount` across the eligible bills, filling each up to its
 * balance due until the money runs out. Returns the per-bill allocation map; any
 * remainder is the payment's unapplied amount (advance). Never over-allocates.
 */
export function autoAllocatePayment(
  bills: Bill[],
  amount: number,
  strategy: AutoAllocateStrategy = 'oldest-due',
): Map<string, number> {
  const ordered = [...bills].sort((a, b) =>
    strategy === 'by-bill-date'
      ? a.billDate.localeCompare(b.billDate)
      : (a.dueDate || a.billDate).localeCompare(b.dueDate || b.billDate) || a.billDate.localeCompare(b.billDate),
  );
  const result = new Map<string, number>();
  let remaining = roundMoney(Number(amount) || 0);
  for (const bill of ordered) {
    if (remaining <= 0.005) break;
    const take = roundMoney(Math.min(remaining, bill.balanceDue));
    if (take > 0) {
      result.set(bill.id, take);
      remaining = roundMoney(remaining - take);
    }
  }
  return result;
}

export interface SupplierPaymentSummary {
  /** Unapplied money paid to the supplier across posted payments (advances). */
  unappliedPayments: number;
  advances: number;
}

/**
 * Aggregate a supplier's unapplied payment / advance position across all their
 * posted (non-reversed, non-void) payments.
 */
export function calculateSupplierUnappliedPayments(supplierId: string, payments: Payment[]): SupplierPaymentSummary {
  let unappliedPayments = 0;
  let advances = 0;
  for (const p of payments) {
    if (p.supplierId !== supplierId) continue;
    if (p.status === 'draft' || p.status === 'submitted' || p.status === 'reversed' || p.status === 'void') continue;
    if (p.paymentType === 'supplier-advance') advances += p.unappliedAmount;
    else if (p.paymentType === 'supplier-payment' || p.paymentType === 'unapplied-supplier-payment') unappliedPayments += p.unappliedAmount;
  }
  return { unappliedPayments: roundMoney(unappliedPayments), advances: roundMoney(advances) };
}

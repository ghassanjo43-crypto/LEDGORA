import type { Payment, PaymentAllocation } from '@/types/payment';
import { roundMoney } from '@/lib/journalValidation';

export interface BillRestoration {
  billId: string;
  amount: number;
}

/**
 * Compute the subledger effect of reversing a payment: every live bill
 * allocation must be removed so the bill's balance and status are restored. The
 * original payment and its journal are preserved; a reversing journal is created
 * separately by the journal service.
 */
export function buildPaymentReversalPlan(payment: Payment): BillRestoration[] {
  const byBill = new Map<string, number>();
  for (const a of payment.allocations) {
    if (a.reversed || !a.billId) continue;
    byBill.set(a.billId, roundMoney((byBill.get(a.billId) ?? 0) + (Number(a.amount) || 0)));
  }
  return [...byBill.entries()].map(([billId, amount]) => ({ billId, amount }));
}

/** Mark every allocation reversed (used when a payment is reversed). */
export function reverseAllAllocations(allocations: PaymentAllocation[]): PaymentAllocation[] {
  return allocations.map((a) => ({ ...a, reversed: true }));
}

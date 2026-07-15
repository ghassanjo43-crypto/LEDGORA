import type { CreditNote } from '@/types/creditNote';
import { roundMoney } from '@/lib/journalValidation';

/** Remaining credit = grand total − applied − refunded (never below zero). */
export function calculateRemainingCredit(cn: Pick<CreditNote, 'grandTotal' | 'amountApplied' | 'amountRefunded'>): number {
  return roundMoney(Math.max(0, (Number(cn.grandTotal) || 0) - (Number(cn.amountApplied) || 0) - (Number(cn.amountRefunded) || 0)));
}

/** The status implied by how much of an issued credit note has been used up. */
export function deriveIssuedStatus(cn: Pick<CreditNote, 'grandTotal' | 'amountApplied' | 'amountRefunded'>): CreditNote['status'] {
  const applied = Number(cn.amountApplied) || 0;
  const refunded = Number(cn.amountRefunded) || 0;
  const used = applied + refunded;
  const remaining = calculateRemainingCredit(cn);
  if (remaining <= 0.005 && refunded > 0.005 && applied <= 0.005) return 'refunded';
  if (remaining <= 0.005) return applied > 0.005 ? 'applied' : 'refunded';
  if (used > 0.005) return 'partially-applied';
  return 'issued';
}

export interface CustomerCreditSummary {
  availableCredit: number;
  appliedCredit: number;
  refundedCredit: number;
  totalIssued: number;
}

/**
 * Aggregate a customer's credit position across all their non-void credit notes.
 * Only issued (non-draft, non-void) notes contribute available/applied/refunded.
 */
export function computeCustomerCreditSummary(customerId: string, creditNotes: CreditNote[]): CustomerCreditSummary {
  let availableCredit = 0;
  let appliedCredit = 0;
  let refundedCredit = 0;
  let totalIssued = 0;
  for (const cn of creditNotes) {
    if (cn.customerId !== customerId) continue;
    if (cn.status === 'draft' || cn.status === 'void') continue;
    availableCredit += calculateRemainingCredit(cn);
    appliedCredit += Number(cn.amountApplied) || 0;
    refundedCredit += Number(cn.amountRefunded) || 0;
    totalIssued += Number(cn.grandTotal) || 0;
  }
  return {
    availableCredit: roundMoney(availableCredit),
    appliedCredit: roundMoney(appliedCredit),
    refundedCredit: roundMoney(refundedCredit),
    totalIssued: roundMoney(totalIssued),
  };
}

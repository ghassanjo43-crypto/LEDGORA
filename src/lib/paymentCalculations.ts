import type { Payment, PaymentAllocation } from '@/types/payment';
import { roundMoney } from '@/lib/journalValidation';

/** Base-currency amount = amount × exchange rate (decimal-safe). */
export function toBaseCurrency(amount: number, exchangeRate: number): number {
  return roundMoney((Number(amount) || 0) * (Number(exchangeRate) || 1));
}

/** Sum of the live (non-reversed) allocations on a payment. */
export function calculateAllocationTotal(allocations: Pick<PaymentAllocation, 'amount' | 'reversed'>[]): number {
  return roundMoney(allocations.filter((a) => !a.reversed).reduce((sum, a) => sum + (Number(a.amount) || 0), 0));
}

/** Unapplied amount = gross amount − allocation total (never below zero). */
export function calculatePaymentUnappliedAmount(grossAmount: number, allocationTotal: number): number {
  return roundMoney(Math.max(0, (Number(grossAmount) || 0) - (Number(allocationTotal) || 0)));
}

export interface PaymentTotals {
  grossAmount: number;
  bankFeeAmount: number;
  withholdingTaxAmount: number;
  discountTakenAmount: number;
  /** Cash actually leaving the bank = gross + fee − withholding − discount. */
  netCashAmount: number;
  baseCurrencyAmount: number;
  allocationTotal: number;
  unappliedAmount: number;
}

type PaymentTotalsInput = Pick<
  Payment,
  | 'paymentType'
  | 'grossAmount'
  | 'exchangeRate'
  | 'allocations'
  | 'bankFeeAmount'
  | 'withholdingTaxAmount'
  | 'discountTakenAmount'
  | 'principalAmount'
  | 'interestAmount'
  | 'leasePrincipalAmount'
  | 'financeCostAmount'
>;

/**
 * For loan and lease payments the "gross" (liability + expense) side is the sum
 * of the split components, so the model stays internally consistent regardless
 * of what the header gross field holds.
 */
export function resolveGrossAmount(p: PaymentTotalsInput): number {
  if (p.paymentType === 'loan-repayment') {
    return roundMoney((Number(p.principalAmount) || 0) + (Number(p.interestAmount) || 0));
  }
  if (p.paymentType === 'lease-payment') {
    return roundMoney((Number(p.leasePrincipalAmount) || 0) + (Number(p.financeCostAmount) || 0));
  }
  return roundMoney(Number(p.grossAmount) || 0);
}

/**
 * Roll a payment's monetary fields into consistent totals. The bank credit line
 * takes the NET cash (gross + bank fee − withholding − discount). The liability
 * / expense debit side is always the gross amount so a fee, withholding or
 * discount never under- or over-settles a bill.
 */
export function calculatePaymentTotals(payment: PaymentTotalsInput): PaymentTotals {
  const grossAmount = resolveGrossAmount(payment);
  const bankFeeAmount = roundMoney(Math.max(0, Number(payment.bankFeeAmount) || 0));
  const withholdingTaxAmount = roundMoney(Math.max(0, Number(payment.withholdingTaxAmount) || 0));
  const discountTakenAmount = roundMoney(Math.max(0, Number(payment.discountTakenAmount) || 0));
  const allocationTotal = calculateAllocationTotal(payment.allocations ?? []);
  const netCashAmount = roundMoney(Math.max(0, grossAmount + bankFeeAmount - withholdingTaxAmount - discountTakenAmount));
  return {
    grossAmount,
    bankFeeAmount,
    withholdingTaxAmount,
    discountTakenAmount,
    netCashAmount,
    baseCurrencyAmount: toBaseCurrency(netCashAmount, payment.exchangeRate),
    allocationTotal,
    unappliedAmount: calculatePaymentUnappliedAmount(grossAmount, allocationTotal),
  };
}

/**
 * Bill balance after a hypothetical payment allocation:
 *   balance = current balance due − allocation (never below zero).
 * The original bill total is never touched.
 */
export function calculateBillBalanceAfterPayment(currentBalanceDue: number, allocation: number): number {
  return roundMoney(Math.max(0, (Number(currentBalanceDue) || 0) - (Number(allocation) || 0)));
}

/** The status of a posted payment implied by how much of its gross is allocated. */
export function derivePaymentStatus(grossAmount: number, allocationTotal: number): Payment['status'] {
  if (allocationTotal <= 0.005) return 'posted';
  if (allocationTotal >= grossAmount - 0.005) return 'fully-allocated';
  return 'partially-allocated';
}

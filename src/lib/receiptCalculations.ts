import type { Receipt, ReceiptAllocation } from '@/types/receipt';
import { roundMoney } from '@/lib/journalValidation';

/** Base-currency amount = receipt amount × exchange rate (decimal-safe). */
export function toBaseCurrency(amount: number, exchangeRate: number): number {
  return roundMoney((Number(amount) || 0) * (Number(exchangeRate) || 1));
}

/** Sum of the live (non-reversed) allocations on a receipt. */
export function calculateAllocationTotal(allocations: Pick<ReceiptAllocation, 'amount' | 'reversed'>[]): number {
  return roundMoney(allocations.filter((a) => !a.reversed).reduce((sum, a) => sum + (Number(a.amount) || 0), 0));
}

/** Unapplied amount = receipt amount − allocation total (never below zero). */
export function calculateReceiptUnappliedAmount(amount: number, allocationTotal: number): number {
  return roundMoney(Math.max(0, (Number(amount) || 0) - (Number(allocationTotal) || 0)));
}

export interface ReceiptTotals {
  amount: number;
  baseCurrencyAmount: number;
  allocationTotal: number;
  unappliedAmount: number;
  bankFeeAmount: number;
  withholdingTaxAmount: number;
  /** Cash actually landing in the bank/cash account = amount − fee − withholding. */
  netBankAmount: number;
}

/**
 * Roll a receipt's monetary fields into consistent totals. The debit cash line
 * receives the NET amount (gross less bank fees and withholding tax); the credit
 * side is always relieved by the full gross amount.
 */
export function calculateReceiptTotals(receipt: Pick<Receipt,
  'amount' | 'exchangeRate' | 'allocations' | 'bankFeeAmount' | 'withholdingTaxAmount'>): ReceiptTotals {
  const amount = roundMoney(Number(receipt.amount) || 0);
  const bankFeeAmount = roundMoney(Math.max(0, Number(receipt.bankFeeAmount) || 0));
  const withholdingTaxAmount = roundMoney(Math.max(0, Number(receipt.withholdingTaxAmount) || 0));
  const allocationTotal = calculateAllocationTotal(receipt.allocations ?? []);
  return {
    amount,
    baseCurrencyAmount: toBaseCurrency(amount, receipt.exchangeRate),
    allocationTotal,
    unappliedAmount: calculateReceiptUnappliedAmount(amount, allocationTotal),
    bankFeeAmount,
    withholdingTaxAmount,
    netBankAmount: roundMoney(Math.max(0, amount - bankFeeAmount - withholdingTaxAmount)),
  };
}

/**
 * Invoice balance after a hypothetical receipt allocation:
 *   balance = current balance due − allocation (never below zero).
 * The original invoice total is never touched.
 */
export function calculateInvoiceBalanceAfterReceipt(currentBalanceDue: number, allocation: number): number {
  return roundMoney(Math.max(0, (Number(currentBalanceDue) || 0) - (Number(allocation) || 0)));
}

import type { Account } from '@/types';
import type { Bill } from '@/types/bill';
import type { Payment, PaymentPostingConfig, PaymentType } from '@/types/payment';
import { isPostingAccount } from '@/lib/journalValidation';
import { calculatePaymentTotals, resolveGrossAmount } from '@/lib/paymentCalculations';
import { resolveCreditCashAccountId, resolveDebitAccountId } from '@/lib/paymentPosting';
import { isSupplierPaymentType, isCustomerRefundType, requiresDebitAccount, PAYMENT_TYPE_LABELS } from '@/lib/paymentLabels';

export interface PaymentIssue {
  severity: 'error' | 'warning';
  rule: string;
  message: string;
  allocationId?: string;
}

/** Drafts may be incomplete; only flag corrupt data (negative amounts). */
export function validatePaymentDraft(
  payment: Pick<Payment, 'grossAmount' | 'bankFeeAmount' | 'withholdingTaxAmount' | 'discountTakenAmount' | 'allocations'>,
): PaymentIssue[] {
  const issues: PaymentIssue[] = [];
  const neg = (v: number | undefined, rule: string, message: string) => { if (Number(v) < 0) issues.push({ severity: 'error', rule, message }); };
  neg(payment.grossAmount, 'negative-amount', 'Payment amount cannot be negative.');
  neg(payment.bankFeeAmount, 'negative-fee', 'Bank fee cannot be negative.');
  neg(payment.withholdingTaxAmount, 'negative-wht', 'Withholding tax cannot be negative.');
  neg(payment.discountTakenAmount, 'negative-discount', 'Discount taken cannot be negative.');
  for (const a of payment.allocations) {
    if (Number(a.amount) < 0) issues.push({ severity: 'error', rule: 'negative-allocation', message: 'Allocation amount cannot be negative.', allocationId: a.id });
  }
  return issues;
}

export interface PaymentPostingValidationContext {
  accountsById: Map<string, Account>;
  config: PaymentPostingConfig;
  billsById: Map<string, Bill>;
  numberUnique: boolean;
  requireApproval?: boolean;
}

const SUPPLIER_TYPES: PaymentType[] = ['supplier-payment', 'supplier-advance', 'unapplied-supplier-payment'];

/**
 * Full pre-posting validation. A payment may only be posted when everything
 * required for a correct, balanced posting is present and no allocation exceeds
 * the payment amount or a bill's remaining balance.
 */
export function validatePaymentForPosting(payment: Payment, ctx: PaymentPostingValidationContext): PaymentIssue[] {
  const issues: PaymentIssue[] = [];
  const err = (rule: string, message: string, allocationId?: string) => issues.push({ severity: 'error', rule, message, allocationId });
  const posting = (id: string | undefined): boolean => !!id && isPostingAccount(ctx.accountsById.get(id));
  const t = calculatePaymentTotals(payment);
  const gross = resolveGrossAmount(payment);

  if (!payment.entityId) err('entity', 'The paying entity is required.');
  if (!payment.paymentNumber.trim()) err('number', 'A payment number is required.');
  else if (!ctx.numberUnique) err('number-unique', `Payment number "${payment.paymentNumber}" is already in use.`);
  if (!payment.paymentDate) err('date', 'Payment date is required.');
  if (!payment.paymentType) err('type', 'A payment type is required.');
  if (!payment.currency) err('currency', 'Currency is required.');
  if (!(Number(payment.exchangeRate) > 0)) err('rate', 'Exchange rate must be greater than zero.');
  if (!(gross > 0)) err('amount', 'Payment amount must be greater than zero.');
  if (!payment.method) err('method', 'A payment method is required.');
  if (t.netCashAmount <= 0) err('net-amount', 'Net cash amount must be greater than zero after fees, withholding and discount.');

  // Credit cash account.
  const cashAccountId = resolveCreditCashAccountId(payment);
  if (!cashAccountId) err('cash-account', 'Select the bank or cash account the money is paid from.');
  else if (!posting(cashAccountId)) err('cash-account-posting', 'The paying account must be a posting account.');

  // Method-specific requirements.
  if (payment.method === 'cheque') {
    if (!payment.chequeNumber?.trim()) err('cheque-number', 'Cheque number is required for cheque payments.');
    if (!payment.chequeDate) err('cheque-date', 'Cheque date is required for cheque payments.');
  }
  if (payment.method === 'bank-transfer' && !payment.transactionReference?.trim() && !payment.transferReference?.trim()) {
    err('transfer-ref', 'A transfer reference is required for bank-transfer payments.');
  }
  if (payment.method === 'online-transfer' && !payment.transactionReference?.trim()) err('online-ref', 'A transaction reference is required for online transfers.');
  if (payment.method === 'direct-debit' && !payment.directDebitReference?.trim() && !payment.transactionReference?.trim()) err('dd-ref', 'A mandate / reference is required for direct-debit payments.');

  // Party requirements.
  if (isSupplierPaymentType(payment.paymentType) && !payment.supplierId) err('supplier', 'Select a supplier for a supplier payment.');
  if (isCustomerRefundType(payment.paymentType) && !payment.customerId && !payment.payeeName?.trim()) err('customer', 'Select the customer (or enter a payee) for a refund.');
  if (payment.paymentType === 'tax-payment' && !payment.taxAuthorityId && !payment.payeeName?.trim()) err('tax-authority', 'Enter the tax authority for a tax payment.');

  // Debit / liability account.
  if (payment.paymentType === 'loan-repayment') {
    if (!posting(payment.loanAccountId)) err('loan-account', 'Select a valid loan liability account.');
    if ((Number(payment.interestAmount) || 0) > 0 && !posting(payment.interestAccountId)) err('interest-account', 'Select a valid interest expense account.');
    const netCheck = Math.round(((Number(payment.principalAmount) || 0) + (Number(payment.interestAmount) || 0) + t.bankFeeAmount) * 100) / 100;
    if (Math.abs(netCheck - t.netCashAmount) > 0.01) err('loan-split', 'Principal + interest + fees must equal the net cash payment.');
  } else if (payment.paymentType === 'lease-payment') {
    if (!posting(payment.leaseLiabilityAccountId)) err('lease-account', 'Select a valid lease liability account.');
    if ((Number(payment.financeCostAmount) || 0) > 0 && !posting(payment.financeCostAccountId)) err('finance-account', 'Select a valid finance cost account.');
  } else {
    const debitAccountId = resolveDebitAccountId(payment, ctx.config);
    if (!debitAccountId) err('debit-account', `A debit account is required for a ${PAYMENT_TYPE_LABELS[payment.paymentType].toLowerCase()}.`);
    else if (!posting(debitAccountId)) err('debit-account-posting', 'The debit account must be a posting account.');
    if (requiresDebitAccount(payment.paymentType) && !payment.debitAccountId) err('explicit-debit', `Select the account to debit for this ${PAYMENT_TYPE_LABELS[payment.paymentType].toLowerCase()}.`);
  }

  // Fee / withholding / discount accounts.
  if (t.bankFeeAmount > 0 && !posting(payment.bankFeeAccountId)) err('fee-account', 'Select a valid bank-fee expense account.');
  if (t.withholdingTaxAmount > 0 && !posting(payment.withholdingTaxAccountId || ctx.config.withholdingTaxPayableAccountId)) err('wht-account', 'Select a valid withholding-tax payable account.');
  if (t.discountTakenAmount > 0 && !posting(payment.discountAccountId || ctx.config.purchaseDiscountAccountId)) err('discount-account', 'Select a valid discount account.');
  if ((Number(payment.realizedFxAmount) || 0) !== 0 && !posting(payment.realizedFxAccountId || ctx.config.realizedFxAccountId)) err('fx-account', 'Select a valid realised-FX account.');

  // Allocation rules.
  if (t.allocationTotal > gross + 0.005) err('over-allocated', `Allocations (${t.allocationTotal.toFixed(2)}) exceed the payment amount (${gross.toFixed(2)}).`);
  for (const a of payment.allocations.filter((x) => !x.reversed)) {
    if (!a.billId) continue;
    const bill = ctx.billsById.get(a.billId);
    if (!bill) { err('allocation-bill', 'An allocated bill no longer exists.', a.id); continue; }
    if (!SUPPLIER_TYPES.includes(payment.paymentType)) err('allocation-type', 'Only supplier payments can allocate to bills.', a.id);
    if (bill.status === 'draft' || bill.status === 'submitted' || bill.status === 'void' || bill.status === 'reversed') err('allocation-bill-status', `Cannot allocate to ${bill.billNumber} — it is ${bill.status}.`, a.id);
    if (bill.supplierId !== payment.supplierId) err('allocation-supplier', `Bill ${bill.billNumber} belongs to a different supplier.`, a.id);
    if (bill.entityId !== payment.entityId) err('allocation-entity', `Bill ${bill.billNumber} belongs to a different entity.`, a.id);
    if (bill.currency !== payment.currency) err('allocation-currency', `Bill ${bill.billNumber} is in a different currency (FX allocation is not supported).`, a.id);
    if (Number(a.amount) > bill.balanceDue + 0.005) err('allocation-over-balance', `Allocation to ${bill.billNumber} exceeds its balance due (${bill.balanceDue.toFixed(2)}).`, a.id);
  }

  if (ctx.requireApproval && payment.status !== 'approved') err('approval', 'This payment must be approved before it can be posted.');

  return issues;
}

export function canPostPayment(payment: Payment, ctx: PaymentPostingValidationContext): boolean {
  return validatePaymentForPosting(payment, ctx).length === 0;
}

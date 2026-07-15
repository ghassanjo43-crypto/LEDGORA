import type { Account } from '@/types';
import type { Invoice } from '@/types/invoice';
import type { Receipt, ReceiptType } from '@/types/receipt';
import { isPostingAccount } from '@/lib/journalValidation';
import { calculateReceiptTotals } from '@/lib/receiptCalculations';
import { resolveCreditAccountId, resolveDebitAccountId } from '@/lib/receiptPosting';
import type { ReceiptPostingConfig } from '@/types/receipt';

export interface ReceiptIssue {
  severity: 'error' | 'warning';
  rule: string;
  message: string;
  allocationId?: string;
}

const CUSTOMER_TYPES: ReceiptType[] = ['customer-payment', 'customer-advance', 'unapplied-customer-receipt'];
export function isCustomerReceiptType(t: ReceiptType): boolean {
  return CUSTOMER_TYPES.includes(t);
}

/** Drafts may be incomplete; only flag corrupt data (negative amounts). */
export function validateReceiptDraft(receipt: Pick<Receipt, 'amount' | 'bankFeeAmount' | 'withholdingTaxAmount' | 'allocations'>): ReceiptIssue[] {
  const issues: ReceiptIssue[] = [];
  if (Number(receipt.amount) < 0) issues.push({ severity: 'error', rule: 'negative-amount', message: 'Receipt amount cannot be negative.' });
  if (Number(receipt.bankFeeAmount) < 0) issues.push({ severity: 'error', rule: 'negative-fee', message: 'Bank fee cannot be negative.' });
  if (Number(receipt.withholdingTaxAmount) < 0) issues.push({ severity: 'error', rule: 'negative-wht', message: 'Withholding tax cannot be negative.' });
  for (const a of receipt.allocations) {
    if (Number(a.amount) < 0) issues.push({ severity: 'error', rule: 'negative-allocation', message: 'Allocation amount cannot be negative.', allocationId: a.id });
  }
  return issues;
}

export interface ReceiptPostingContext {
  accountsById: Map<string, Account>;
  config: ReceiptPostingConfig;
  invoicesById: Map<string, Invoice>;
  numberUnique: boolean;
}

/**
 * Full pre-posting validation. A receipt may only be posted when everything
 * required for a correct, balanced posting is present and no allocation exceeds
 * the receipt amount or an invoice's remaining balance.
 */
export function validateReceiptForPosting(receipt: Receipt, ctx: ReceiptPostingContext): ReceiptIssue[] {
  const issues: ReceiptIssue[] = [];
  const err = (rule: string, message: string, allocationId?: string) => issues.push({ severity: 'error', rule, message, allocationId });
  const posting = (id: string | undefined): boolean => !!id && isPostingAccount(ctx.accountsById.get(id));

  if (!receipt.entityId) err('entity', 'The receiving entity is required.');
  if (!receipt.receiptNumber.trim()) err('number', 'A receipt number is required.');
  else if (!ctx.numberUnique) err('number-unique', `Receipt number "${receipt.receiptNumber}" is already in use.`);
  if (!receipt.receiptDate) err('date', 'Receipt date is required.');
  if (!receipt.receiptType) err('type', 'A receipt type is required.');
  if (!receipt.currency) err('currency', 'Currency is required.');
  if (!(Number(receipt.exchangeRate) > 0)) err('rate', 'Exchange rate must be greater than zero.');
  if (!(Number(receipt.amount) > 0)) err('amount', 'Receipt amount must be greater than zero.');
  if (!receipt.method) err('method', 'A receipt method is required.');

  // Debit cash account.
  const debitAccountId = resolveDebitAccountId(receipt);
  if (!debitAccountId) err('debit-account', 'Select the bank or cash account the money was received into.');
  else if (!posting(debitAccountId)) err('debit-account-posting', 'The receiving account must be a posting account.');

  // Method-specific requirements.
  if (receipt.method === 'cheque') {
    if (!receipt.chequeNumber?.trim()) err('cheque-number', 'Cheque number is required for cheque receipts.');
    if (!receipt.chequeDate) err('cheque-date', 'Cheque date is required for cheque receipts.');
  }
  if (receipt.method === 'bank-transfer' && !receipt.transactionReference?.trim() && !receipt.transferReference?.trim()) {
    err('transfer-ref', 'A transfer reference is required for bank-transfer receipts.');
  }
  if (receipt.method === 'online-transfer' && !receipt.transactionReference?.trim()) err('online-ref', 'A transaction reference is required for online transfers.');

  // Credit account / customer requirements.
  if (isCustomerReceiptType(receipt.receiptType)) {
    if (!receipt.customerId) err('customer', 'Select a customer for a customer receipt.');
  }
  if (receipt.receiptType === 'supplier-refund' && !receipt.supplierId && !receipt.payerName?.trim()) {
    err('supplier', 'Select the supplier (or enter a payer) for a supplier refund.');
  }
  const creditAccountId = resolveCreditAccountId(receipt, ctx.config);
  if (!creditAccountId) err('credit-account', 'A credit account is required for this receipt type.');
  else if (!posting(creditAccountId)) err('credit-account-posting', 'The credit account must be a posting account.');
  if (receipt.receiptType === 'other' && !receipt.creditAccountId) err('other-account', 'The "Other" receipt type needs an explicit credit account.');

  // Bank fee / withholding accounts.
  const t = calculateReceiptTotals(receipt);
  if (t.bankFeeAmount > 0 && !posting(receipt.bankFeeAccountId)) err('fee-account', 'Select a valid bank-fee expense account.');
  if (t.withholdingTaxAmount > 0 && !posting(receipt.withholdingTaxAccountId)) err('wht-account', 'Select a valid withholding-tax account.');
  if (t.netBankAmount <= 0) err('net-amount', 'Net bank amount must be greater than zero after fees and withholding.');

  // Allocation rules.
  if (t.allocationTotal > t.amount + 0.005) err('over-allocated', `Allocations (${t.allocationTotal.toFixed(2)}) exceed the receipt amount (${t.amount.toFixed(2)}).`);
  for (const a of receipt.allocations.filter((x) => !x.reversed)) {
    if (!a.invoiceId) continue;
    const inv = ctx.invoicesById.get(a.invoiceId);
    if (!inv) { err('allocation-invoice', 'An allocated invoice no longer exists.', a.id); continue; }
    if (inv.status === 'draft' || inv.status === 'void') err('allocation-invoice-status', `Cannot allocate to ${inv.invoiceNumber} — it is ${inv.status}.`, a.id);
    if (inv.customerId !== receipt.customerId) err('allocation-customer', `Invoice ${inv.invoiceNumber} belongs to a different customer.`, a.id);
    if (inv.entityId !== receipt.entityId) err('allocation-entity', `Invoice ${inv.invoiceNumber} belongs to a different entity.`, a.id);
    if (inv.currency !== receipt.currency) err('allocation-currency', `Invoice ${inv.invoiceNumber} is in a different currency (FX allocation is not supported).`, a.id);
    if (Number(a.amount) > inv.balanceDue + 0.005) err('allocation-over-balance', `Allocation to ${inv.invoiceNumber} exceeds its balance due (${inv.balanceDue.toFixed(2)}).`, a.id);
  }

  return issues;
}

export function canPostReceipt(receipt: Receipt, ctx: ReceiptPostingContext): boolean {
  return validateReceiptForPosting(receipt, ctx).length === 0;
}

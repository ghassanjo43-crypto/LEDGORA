import type { Account } from '@/types';
import type { Bill, BillLine } from '@/types/bill';
import { isPostingAccount } from '@/lib/journalValidation';
import { calculateBillTotals } from '@/lib/billCalculations';
import { roundMoney } from '@/lib/journalValidation';

export interface BillIssue {
  severity: 'error' | 'warning';
  rule: string;
  message: string;
  lineId?: string;
}

export function isActiveBillLine(line: BillLine): boolean {
  return Number(line.quantity) !== 0 || Number(line.unitPrice) !== 0 || !!line.description.trim() || !!line.accountId;
}

/** Drafts may be incomplete; only flag corrupt data (negative qty/price/discount). */
export function validateBillDraft(bill: Pick<Bill, 'lines'>): BillIssue[] {
  const issues: BillIssue[] = [];
  for (const line of bill.lines) {
    if (Number(line.quantity) < 0) issues.push({ severity: 'error', rule: 'negative-qty', message: 'Quantity cannot be negative.', lineId: line.id });
    if (Number(line.unitPrice) < 0) issues.push({ severity: 'error', rule: 'negative-price', message: 'Unit price cannot be negative.', lineId: line.id });
  }
  return issues;
}

export interface BillPostingContext {
  accountsById: Map<string, Account>;
  billNumberUnique: boolean;
  supplierInvoiceUnique: boolean;
  hasApAccount: boolean;
  hasInputTaxAccount: boolean;
  approvalRequired: boolean;
  isApproved: boolean;
}

/** Full pre-posting validation (§28). */
export function validateBillForPosting(bill: Bill, ctx: BillPostingContext): BillIssue[] {
  const issues: BillIssue[] = [];
  const err = (rule: string, message: string, lineId?: string) => issues.push({ severity: 'error', rule, message, lineId });
  const posting = (id: string): boolean => isPostingAccount(ctx.accountsById.get(id));

  if (!bill.entityId) err('entity', 'The purchasing entity is required.');
  if (!bill.supplierId) err('supplier', 'Select a supplier.');
  if (!bill.billNumber.trim()) err('number', 'An internal bill number is required.');
  else if (!ctx.billNumberUnique) err('number-unique', `Bill number "${bill.billNumber}" is already in use.`);
  if (!bill.supplierInvoiceNumber.trim()) err('supplier-invoice', 'The supplier invoice number is required.');
  else if (!ctx.supplierInvoiceUnique) err('duplicate-supplier-invoice', `Supplier invoice "${bill.supplierInvoiceNumber}" is already recorded for this supplier.`);
  if (!bill.billDate) err('bill-date', 'Bill date is required.');
  if (!bill.dueDate) err('due-date', 'Due date is required.');
  else if (bill.billDate && bill.dueDate < bill.billDate) err('due-before-bill', 'Due date cannot be before the bill date.');
  if (!bill.currency) err('currency', 'Currency is required.');
  if (!(Number(bill.exchangeRate) > 0)) err('rate', 'Exchange rate must be greater than zero.');
  if (!ctx.hasApAccount) err('ap', 'No Accounts Payable control account is mapped.');

  const activeLines = bill.lines.filter(isActiveBillLine);
  if (activeLines.length === 0) err('lines', 'Add at least one bill line.');
  for (const line of activeLines) {
    if (!line.accountId) err('line-account', `Line "${line.description || 'untitled'}" needs a posting account.`, line.id);
    else if (!posting(line.accountId)) err('line-account-posting', `Line "${line.description || 'untitled'}" must use a posting (leaf) account.`, line.id);
    if (Number(line.quantity) <= 0) err('line-qty', `Line "${line.description || 'untitled'}" needs a positive quantity.`, line.id);
    if (Number(line.unitPrice) < 0) err('line-price', `Line "${line.description || 'untitled'}" cannot have a negative unit price.`, line.id);
  }

  const totals = calculateBillTotals(bill.lines, bill.additionalChargesTotal);
  if (totals.taxTotal > 0 && !ctx.hasInputTaxAccount) err('input-tax', 'Input tax is present but no input-tax account is mapped.');
  if (roundMoney(totals.grandTotal) !== roundMoney(bill.grandTotal)) err('totals', 'Bill totals are out of date — recalculate before posting.');
  if (totals.grandTotal <= 0) err('nonpositive', 'The bill total must be greater than zero.');
  if (ctx.approvalRequired && !ctx.isApproved) err('approval', 'This bill must be approved before it can be posted.');

  return issues;
}

export function canPostBill(bill: Bill, ctx: BillPostingContext): boolean {
  return validateBillForPosting(bill, ctx).length === 0;
}

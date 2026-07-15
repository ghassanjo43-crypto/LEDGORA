import type { Invoice } from '@/types/invoice';
import { calculateInvoiceTotals } from '@/lib/invoiceCalculations';
import { roundMoney } from '@/lib/journalValidation';

export interface InvoiceIssue {
  severity: 'error' | 'warning';
  rule: string;
  message: string;
  lineId?: string;
}

/** Drafts may be incomplete; only flag corrupt data (negative qty/price). */
export function validateInvoiceDraft(invoice: Pick<Invoice, 'lines'>): InvoiceIssue[] {
  const issues: InvoiceIssue[] = [];
  for (const line of invoice.lines) {
    if (Number(line.quantity) < 0) issues.push({ severity: 'error', rule: 'negative-qty', message: 'Quantity cannot be negative.', lineId: line.id });
    if (Number(line.unitPrice) < 0) issues.push({ severity: 'error', rule: 'negative-price', message: 'Unit price cannot be negative.', lineId: line.id });
  }
  return issues;
}

export interface IssueContext {
  /** The resolved template version exists and is published. */
  templateVersionPublished: boolean;
  /** The customer has a receivable/control account mapped. */
  hasReceivableAccount: boolean;
  /** The invoice number is unique within the entity. */
  invoiceNumberUnique: boolean;
}

/**
 * Full pre-issuance validation. An invoice may only be issued when everything
 * required for a correct, balanced posting is present.
 */
export function validateInvoiceForIssue(invoice: Invoice, ctx: IssueContext): InvoiceIssue[] {
  const issues: InvoiceIssue[] = [];
  const err = (rule: string, message: string, lineId?: string) => issues.push({ severity: 'error', rule, message, lineId });

  if (!invoice.entityId) err('entity', 'Select the invoicing entity.');
  if (!invoice.customerId) err('customer', 'Select a customer.');
  if (!invoice.invoiceNumber.trim()) err('number', 'An invoice number is required.');
  else if (!ctx.invoiceNumberUnique) err('number-unique', `Invoice number "${invoice.invoiceNumber}" is already in use.`);
  if (!invoice.issueDate) err('issue-date', 'Issue date is required.');
  if (!invoice.dueDate) err('due-date', 'Due date is required.');
  else if (invoice.issueDate && invoice.dueDate < invoice.issueDate) err('due-before-issue', 'Due date cannot be before the issue date.');
  if (!invoice.currency) err('currency', 'Currency is required.');
  if (!ctx.templateVersionPublished) err('template', 'Choose a published invoice template version.');
  if (!ctx.hasReceivableAccount) err('receivable', 'The customer has no receivable/control account mapped.');

  const activeLines = invoice.lines.filter((l) => Number(l.quantity) !== 0 || Number(l.unitPrice) !== 0 || l.description.trim() || l.accountId);
  if (activeLines.length === 0) err('lines', 'Add at least one invoice line.');

  for (const line of activeLines) {
    if (!line.accountId) err('line-account', `Line "${line.description || 'untitled'}" needs a revenue account.`, line.id);
    if (Number(line.quantity) <= 0) err('line-qty', `Line "${line.description || 'untitled'}" needs a positive quantity.`, line.id);
    if (Number(line.unitPrice) < 0) err('line-price', `Line "${line.description || 'untitled'}" cannot have a negative unit price.`, line.id);
  }

  // Totals must match a fresh recomputation (guards against stale UI state).
  const totals = calculateInvoiceTotals(invoice.lines, invoice.additionalChargesTotal, invoice.amountPaid);
  if (roundMoney(totals.grandTotal) !== roundMoney(invoice.grandTotal)) {
    err('totals', 'Invoice totals are out of date — recalculate before issuing.');
  }
  if (totals.grandTotal <= 0) err('nonpositive', 'The invoice total must be greater than zero.');

  return issues;
}

export function canIssueInvoice(invoice: Invoice, ctx: IssueContext): boolean {
  return validateInvoiceForIssue(invoice, ctx).length === 0;
}

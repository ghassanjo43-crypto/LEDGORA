import type { CreditNote, CreditNoteLine } from '@/types/creditNote';
import { calculateCreditNoteLine, calculateCreditNoteTotals } from '@/lib/creditNoteCalculations';
import { roundMoney } from '@/lib/journalValidation';

export interface CreditNoteIssue {
  severity: 'error' | 'warning';
  rule: string;
  message: string;
  lineId?: string;
}

/** A line the user has actually touched (not a blank placeholder row). */
export function isActiveCreditLine(line: CreditNoteLine): boolean {
  return Number(line.quantity) !== 0 || Number(line.unitPrice) !== 0 || !!line.description.trim() || !!line.revenueAccountId;
}

/** Drafts may be incomplete; only flag corrupt data (negative qty/price/discount). */
export function validateCreditNoteDraft(cn: Pick<CreditNote, 'lines'>): CreditNoteIssue[] {
  const issues: CreditNoteIssue[] = [];
  for (const line of cn.lines) {
    if (Number(line.quantity) < 0) issues.push({ severity: 'error', rule: 'negative-qty', message: 'Credit quantity cannot be negative.', lineId: line.id });
    if (Number(line.unitPrice) < 0) issues.push({ severity: 'error', rule: 'negative-price', message: 'Unit price cannot be negative.', lineId: line.id });
    if (Number(line.discountValue) < 0) issues.push({ severity: 'error', rule: 'negative-discount', message: 'Discount cannot be negative.', lineId: line.id });
  }
  return issues;
}

export interface CreditNoteIssueContext {
  /** The resolved template version exists and is published. */
  templateVersionPublished: boolean;
  /** The customer has a receivable/control account mapped. */
  hasReceivableAccount: boolean;
  /** The credit-note number is unique within the entity. */
  numberUnique: boolean;
  /** This credit note is linked to a real, creditable (issued/non-void) invoice. */
  originalInvoiceCreditable: boolean;
  /** Whether this credit type must be backed by an original invoice. */
  requiresOriginalInvoice: boolean;
  /** Invoice-level amount still available to credit (excluding this note). */
  availableToCredit: number;
  /** Gross tax still reversible on the original invoice (excluding this note). */
  remainingTax: number;
  /** Per-invoice-line remaining creditable quantity, keyed by original invoice line id. */
  remainingQuantityByInvoiceLine?: Map<string, number>;
}

/**
 * Full pre-issuance validation. A credit note may only be issued when everything
 * required for a correct, balanced posting is present and it does not over-credit
 * the invoice.
 */
export function validateCreditNoteForIssue(cn: CreditNote, ctx: CreditNoteIssueContext): CreditNoteIssue[] {
  const issues: CreditNoteIssue[] = [];
  const err = (rule: string, message: string, lineId?: string) => issues.push({ severity: 'error', rule, message, lineId });

  if (!cn.entityId) err('entity', 'The invoicing entity is required.');
  if (!cn.customerId) err('customer', 'Select a customer.');
  if (!cn.creditNoteNumber.trim()) err('number', 'A credit-note number is required.');
  else if (!ctx.numberUnique) err('number-unique', `Credit-note number "${cn.creditNoteNumber}" is already in use.`);
  if (!cn.issueDate) err('issue-date', 'Issue date is required.');
  if (!cn.currency) err('currency', 'Currency is required.');
  if (!cn.reasonCode) err('reason', 'A reason code is required.');
  if (cn.reasonCode === 'other' && !cn.reasonDescription.trim()) err('reason-desc', 'Describe the reason when choosing "Other".');
  if (!ctx.templateVersionPublished) err('template', 'Choose a published credit-note template version.');
  if (!ctx.hasReceivableAccount) err('receivable', 'The customer has no receivable/control account mapped.');

  if (ctx.requiresOriginalInvoice) {
    if (!cn.originalInvoiceId) err('original-invoice', 'This credit type must be linked to an original invoice.');
    else if (!ctx.originalInvoiceCreditable) err('invoice-status', 'The original invoice must be issued (draft or void invoices cannot be credited).');
  }

  const activeLines = cn.lines.filter(isActiveCreditLine);
  if (activeLines.length === 0) err('lines', 'Add at least one credit line.');

  for (const line of activeLines) {
    if (!line.revenueAccountId) err('line-account', `Line "${line.description || 'untitled'}" needs a revenue/adjustment account.`, line.id);
    if (Number(line.quantity) <= 0) err('line-qty', `Line "${line.description || 'untitled'}" needs a positive credit quantity.`, line.id);
    if (Number(line.unitPrice) < 0) err('line-price', `Line "${line.description || 'untitled'}" cannot have a negative unit price.`, line.id);
    // Per-line over-credit on quantity.
    if (line.originalInvoiceLineId && ctx.remainingQuantityByInvoiceLine) {
      const remaining = ctx.remainingQuantityByInvoiceLine.get(line.originalInvoiceLineId);
      if (remaining !== undefined && Number(line.quantity) > remaining + 0.0001) {
        err('line-over-credit', `Line "${line.description || 'untitled'}" credits more than the remaining ${remaining} available.`, line.id);
      }
    }
  }

  // Totals must match a fresh recomputation.
  const totals = calculateCreditNoteTotals(cn.lines);
  if (roundMoney(totals.grandTotal) !== roundMoney(cn.grandTotal)) {
    err('totals', 'Credit-note totals are out of date — recalculate before issuing.');
  }
  if (totals.grandTotal <= 0) err('nonpositive', 'The credit-note total must be greater than zero.');

  // Invoice-level over-credit.
  if (ctx.requiresOriginalInvoice && totals.grandTotal > ctx.availableToCredit + 0.005) {
    err('over-credit', `This credit (${totals.grandTotal.toFixed(2)}) exceeds the invoice's remaining creditable value (${ctx.availableToCredit.toFixed(2)}).`);
  }

  // Tax reversal cannot exceed the invoice's remaining output tax.
  const taxTotal = roundMoney(cn.lines.reduce((sum, l) => sum + calculateCreditNoteLine(l).taxAmount, 0));
  if (ctx.requiresOriginalInvoice && taxTotal > ctx.remainingTax + 0.005) {
    err('tax-over-credit', `Tax reversal (${taxTotal.toFixed(2)}) exceeds the remaining original tax (${ctx.remainingTax.toFixed(2)}).`);
  }

  return issues;
}

export function canIssueCreditNote(cn: CreditNote, ctx: CreditNoteIssueContext): boolean {
  return validateCreditNoteForIssue(cn, ctx).length === 0;
}

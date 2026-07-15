import type { Invoice } from '@/types/invoice';
import type { CreditNote } from '@/types/creditNote';
import type { Receipt } from '@/types/receipt';
import { roundMoney, BALANCE_TOLERANCE } from '@/lib/journalValidation';

/** Credit-note statuses whose applications count towards settling an invoice. */
const APPLIED_CREDIT_STATUSES: ReadonlyArray<CreditNote['status']> = ['issued', 'applied', 'partially-applied'];
/** Receipt statuses whose allocations count as real payments. */
const POSTED_RECEIPT_STATUSES: ReadonlyArray<Receipt['status']> = ['posted', 'partially-allocated', 'fully-allocated'];

/**
 * Derived, never-persisted settlement position for an invoice. The original
 * invoice grand total is historically immutable — this summary exposes the
 * live balance without ever rewriting {@link Invoice.grandTotal}.
 */
export interface InvoiceSettlementSummary {
  originalTotal: number;
  creditNotesApplied: number;
  paymentsApplied: number;
  balanceDue: number;
}

/** Non-reversed credit applied by ONE credit note to a specific invoice. */
export function creditNoteAppliedToInvoice(cn: CreditNote, invoiceId: string): number {
  if (!APPLIED_CREDIT_STATUSES.includes(cn.status)) return 0;
  return roundMoney(cn.applications.filter((a) => a.invoiceId === invoiceId && !a.reversed).reduce((s, a) => s + (Number(a.amount) || 0), 0));
}

/** Non-reversed allocation applied by ONE receipt to a specific invoice. */
export function receiptAppliedToInvoice(receipt: Receipt, invoiceId: string): number {
  if (!POSTED_RECEIPT_STATUSES.includes(receipt.status)) return 0;
  return roundMoney(receipt.allocations.filter((a) => a.invoiceId === invoiceId && !a.reversed).reduce((s, a) => s + (Number(a.amount) || 0), 0));
}

/** Issued, non-void credit notes that have applied credit to this invoice (excludes drafts, voids and unapplied credits). */
export function creditNotesForInvoice(invoiceId: string, creditNotes: CreditNote[]): CreditNote[] {
  return creditNotes.filter((cn) => creditNoteAppliedToInvoice(cn, invoiceId) > BALANCE_TOLERANCE);
}

/** Posted receipts that have allocated money to this invoice. */
export function receiptsForInvoice(invoiceId: string, receipts: Receipt[]): Receipt[] {
  return receipts.filter((r) => receiptAppliedToInvoice(r, invoiceId) > BALANCE_TOLERANCE);
}

/**
 * Build the live settlement summary from the ORIGINAL invoice total less credit
 * notes applied (from credit-note applications) and payments applied (from
 * receipt allocations). Never derives the balance from an already-updated field,
 * so credits/payments are never double-counted.
 */
export function buildInvoiceSettlementSummary(invoice: Invoice, creditNotes: CreditNote[], receipts: Receipt[]): InvoiceSettlementSummary {
  const originalTotal = roundMoney(invoice.grandTotal);
  const creditNotesApplied = roundMoney(creditNotes.reduce((s, cn) => s + creditNoteAppliedToInvoice(cn, invoice.id), 0));
  const paymentsApplied = roundMoney(receipts.reduce((s, r) => s + receiptAppliedToInvoice(r, invoice.id), 0));
  const balanceDue = roundMoney(Math.max(0, originalTotal - creditNotesApplied - paymentsApplied));
  return { originalTotal, creditNotesApplied, paymentsApplied, balanceDue };
}

export type InvoiceSettlementStatus =
  | 'fully-credited'
  | 'paid-after-credit'
  | 'paid'
  | 'partially-credited'
  | 'partially-paid'
  | 'partially-settled'
  | 'outstanding';

/**
 * Derive the settlement status per §7:
 *  - balance 0 by credits only            → fully-credited
 *  - balance 0 with payments (± credits)  → paid-after-credit / paid
 *  - balance > 0 with credits/payments    → partially-credited / partially-paid
 */
export function deriveSettlementStatus(s: InvoiceSettlementSummary): InvoiceSettlementStatus {
  const settled = s.balanceDue <= BALANCE_TOLERANCE;
  const hasCredits = s.creditNotesApplied > BALANCE_TOLERANCE;
  const hasPayments = s.paymentsApplied > BALANCE_TOLERANCE;
  if (settled) {
    if (hasPayments && hasCredits) return 'paid-after-credit';
    if (hasCredits) return 'fully-credited';
    return 'paid';
  }
  if (hasCredits && hasPayments) return 'partially-settled';
  if (hasCredits) return 'partially-credited';
  if (hasPayments) return 'partially-paid';
  return 'outstanding';
}

import type { Invoice } from '@/types/invoice';
import type { CreditNote, CreditNoteInvoiceReferenceSnapshot, CreditNoteLine, CreditNoteReferenceLine } from '@/types/creditNote';
import { calculateInvoiceLine } from '@/lib/invoiceCalculations';
import { calculateCreditNoteLine } from '@/lib/creditNoteCalculations';
import { roundMoney } from '@/lib/journalValidation';

/** Credit notes whose value has ALREADY reduced the invoice (issued, applied, partially-applied). */
const PREVIOUS_CREDIT_STATUSES: ReadonlyArray<CreditNote['status']> = ['issued', 'applied', 'partially-applied'];

function previousCreditNotes(invoiceId: string, creditNotes: CreditNote[], excludeId: string): CreditNote[] {
  return creditNotes.filter((c) => c.originalInvoiceId === invoiceId && c.id !== excludeId && PREVIOUS_CREDIT_STATUSES.includes(c.status));
}

/**
 * Sum of previously issued (non-void) credit notes linked to an invoice,
 * excluding the current one. This is the "previous credits" figure.
 */
export function sumPreviousCredits(invoiceId: string, creditNotes: CreditNote[], excludeId: string): number {
  return roundMoney(previousCreditNotes(invoiceId, creditNotes, excludeId).reduce((s, c) => s + (Number(c.grandTotal) || 0), 0));
}

/** Quantity of an invoice line already credited by previous (non-current) issued credit notes. */
function previouslyCreditedQuantity(invoiceLineId: string, creditNotes: CreditNote[], excludeId: string, invoiceId: string): number {
  let qty = 0;
  for (const cn of previousCreditNotes(invoiceId, creditNotes, excludeId)) {
    for (const line of cn.lines) {
      if (line.originalInvoiceLineId === invoiceLineId) qty += Number(line.quantity) || 0;
    }
  }
  return roundMoney(qty);
}

function buildReferenceLine(cnLine: CreditNoteLine, invoice: Invoice, creditNotes: CreditNote[], currentCreditNoteId: string): CreditNoteReferenceLine {
  const invLine = cnLine.originalInvoiceLineId ? invoice.lines.find((l) => l.id === cnLine.originalInvoiceLineId) : undefined;
  const originalQuantity = invLine ? Number(invLine.quantity) || 0 : 0;
  const originalUnitPrice = invLine ? Number(invLine.unitPrice) || 0 : Number(cnLine.unitPrice) || 0;
  const originalLineTotal = invLine ? calculateInvoiceLine(invLine).lineTotal : 0;
  const prevQty = cnLine.originalInvoiceLineId ? previouslyCreditedQuantity(cnLine.originalInvoiceLineId, creditNotes, currentCreditNoteId, invoice.id) : 0;
  const quantityCreditedByThisNote = Number(cnLine.quantity) || 0;
  const remainingQuantity = roundMoney(Math.max(0, originalQuantity - prevQty - quantityCreditedByThisNote));
  const creditNoteLineTotal = calculateCreditNoteLine(cnLine).lineTotal;
  // "Amount adjustment" when the credit unit price differs from the original line
  // (a partial-value credit) or there is no linked invoice line.
  const creditBasis = !invLine || Math.abs(originalUnitPrice - (Number(cnLine.unitPrice) || 0)) > 0.005 ? 'amount' : 'quantity';
  return {
    creditNoteLineId: cnLine.id,
    originalInvoiceLineId: cnLine.originalInvoiceLineId,
    itemLabel: cnLine.itemId || cnLine.description.split(' ').slice(0, 3).join(' '),
    description: cnLine.description,
    originalQuantity,
    originalUnitPrice,
    originalLineTotal,
    previouslyCreditedQuantity: prevQty,
    quantityCreditedByThisNote,
    remainingQuantity,
    creditNoteLineTotal,
    creditBasis,
  };
}

/**
 * Build the frozen original-invoice reference for a credit note.
 *
 *   previousCredits            = Σ issued/applied/partially-applied credits (excl. this note)
 *   invoiceBalanceBeforeCredit = originalTotal − previousCredits − paymentsBeforeCredit
 *   invoiceBalanceAfterCredit  = invoiceBalanceBeforeCredit − currentCreditAmount
 *
 * Crucially the revised balance is derived from the ORIGINAL total, never from
 * the invoice's already-updated balance (which would subtract this credit twice).
 */
export function buildCreditNoteInvoiceReference(
  cn: CreditNote,
  invoice: Invoice,
  creditNotes: CreditNote[],
): CreditNoteInvoiceReferenceSnapshot {
  const originalInvoiceTotal = roundMoney(invoice.grandTotal);
  const previousCreditsTotal = sumPreviousCredits(invoice.id, creditNotes, cn.id);
  const paymentsAppliedBeforeCredit = roundMoney(invoice.amountPaid);
  const invoiceBalanceBeforeCredit = roundMoney(originalInvoiceTotal - previousCreditsTotal - paymentsAppliedBeforeCredit);
  const currentCreditAmount = roundMoney(cn.grandTotal);
  const invoiceBalanceAfterCredit = roundMoney(invoiceBalanceBeforeCredit - currentCreditAmount);
  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.issueDate,
    originalInvoiceTotal,
    paymentsAppliedBeforeCredit,
    previousCreditsTotal,
    invoiceBalanceBeforeCredit,
    currentCreditAmount,
    invoiceBalanceAfterCredit,
    currency: cn.currency,
    purchaseOrderReference: invoice.purchaseOrderReference || undefined,
    customerReference: invoice.customerReference || undefined,
    lines: cn.lines.map((l) => buildReferenceLine(l, invoice, creditNotes, cn.id)),
  };
}

import type { CreditNoteLine } from '@/types/creditNote';
import { calculateInvoiceLine, type CalcLineInput, type InvoiceLineCalc } from '@/lib/invoiceCalculations';
import { roundMoney } from '@/lib/journalValidation';

/**
 * Per-line credit-note maths. Reuses the invoice module's decimal-safe
 * calculator verbatim so a credited line computes exactly like the invoice line
 * it mirrors:
 *
 *   lineSubtotal  = quantity × unitPrice
 *   discountAmount = percentage of subtotal, or a fixed amount
 *   taxableAmount  = lineSubtotal − discountAmount
 *   taxAmount      = taxableAmount × taxRate%
 *   lineTotal      = taxableAmount + taxAmount
 *
 * Customer-facing amounts stay POSITIVE — the accounting direction is expressed
 * through debits/credits in the posting layer, never through negative numbers.
 */
export function calculateCreditNoteLine(line: CalcLineInput): InvoiceLineCalc {
  return calculateInvoiceLine(line);
}

/** Refresh the derived fields on a full credit-note line. */
export function recalcCreditNoteLine(line: CreditNoteLine): CreditNoteLine {
  const c = calculateCreditNoteLine(line);
  return {
    ...line,
    discountAmount: c.discountAmount,
    taxableAmount: c.taxableAmount,
    taxAmount: c.taxAmount,
    lineTotal: c.lineTotal,
  };
}

export interface CreditNoteTotals {
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  grandTotal: number;
}

/**
 * Roll the lines up into document totals.
 *
 *   subtotal      = Σ lineSubtotal
 *   discountTotal = Σ discountAmount
 *   taxTotal      = Σ taxAmount
 *   grandTotal    = subtotal − discountTotal + taxTotal
 */
export function calculateCreditNoteTotals(lines: CalcLineInput[]): CreditNoteTotals {
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  for (const line of lines) {
    const c = calculateCreditNoteLine(line);
    subtotal += c.lineSubtotal;
    discountTotal += c.discountAmount;
    taxTotal += c.taxAmount;
  }
  subtotal = roundMoney(subtotal);
  discountTotal = roundMoney(discountTotal);
  taxTotal = roundMoney(taxTotal);
  return { subtotal, discountTotal, taxTotal, grandTotal: roundMoney(subtotal - discountTotal + taxTotal) };
}

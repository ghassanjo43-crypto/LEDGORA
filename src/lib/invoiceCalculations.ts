import type { InvoiceLine } from '@/types/invoice';
import { roundMoney } from '@/lib/journalValidation';

export interface InvoiceLineCalc {
  lineSubtotal: number;
  discountAmount: number;
  taxableAmount: number;
  taxAmount: number;
  lineTotal: number;
}

/** The editable subset of a line the calculator needs. */
export interface CalcLineInput {
  quantity: number;
  unitPrice: number;
  discountType?: 'percentage' | 'amount';
  discountValue?: number;
  taxRate: number;
}

/**
 * Decimal-safe per-line maths. Every intermediate is rounded to 2 dp so totals
 * never drift on floating-point boundaries.
 *
 *   lineSubtotal  = quantity × unitPrice
 *   discountAmount = percentage of subtotal, or a fixed amount (clamped ≥0, ≤subtotal)
 *   taxableAmount  = lineSubtotal − discountAmount
 *   taxAmount      = taxableAmount × taxRate%
 *   lineTotal      = taxableAmount + taxAmount
 */
export function calculateInvoiceLine(line: CalcLineInput): InvoiceLineCalc {
  const qty = Number(line.quantity) || 0;
  const price = Number(line.unitPrice) || 0;
  const lineSubtotal = roundMoney(qty * price);

  let discountAmount = 0;
  const dv = Number(line.discountValue) || 0;
  if (dv > 0) {
    discountAmount = line.discountType === 'amount' ? roundMoney(dv) : roundMoney((lineSubtotal * dv) / 100);
  }
  discountAmount = Math.min(Math.max(discountAmount, 0), lineSubtotal);

  const taxableAmount = roundMoney(lineSubtotal - discountAmount);
  const taxAmount = roundMoney((taxableAmount * (Number(line.taxRate) || 0)) / 100);
  const lineTotal = roundMoney(taxableAmount + taxAmount);

  return { lineSubtotal, discountAmount, taxableAmount, taxAmount, lineTotal };
}

/** Apply {@link calculateInvoiceLine} to a full invoice line, refreshing derived fields. */
export function recalcInvoiceLine(line: InvoiceLine): InvoiceLine {
  const c = calculateInvoiceLine(line);
  return { ...line, lineSubtotal: c.lineSubtotal, taxAmount: c.taxAmount, lineTotal: c.lineTotal };
}

export interface InvoiceTotals {
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  additionalChargesTotal: number;
  grandTotal: number;
  amountPaid: number;
  balanceDue: number;
}

export function calculateInvoiceTotals(
  lines: CalcLineInput[],
  additionalChargesTotal = 0,
  amountPaid = 0,
): InvoiceTotals {
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  for (const line of lines) {
    const c = calculateInvoiceLine(line);
    subtotal += c.lineSubtotal;
    discountTotal += c.discountAmount;
    taxTotal += c.taxAmount;
  }
  subtotal = roundMoney(subtotal);
  discountTotal = roundMoney(discountTotal);
  taxTotal = roundMoney(taxTotal);
  const charges = roundMoney(additionalChargesTotal);
  const grandTotal = roundMoney(subtotal - discountTotal + taxTotal + charges);
  const paid = roundMoney(amountPaid);
  return {
    subtotal,
    discountTotal,
    taxTotal,
    additionalChargesTotal: charges,
    grandTotal,
    amountPaid: paid,
    balanceDue: roundMoney(grandTotal - paid),
  };
}

import type { InvoiceLine } from '@/types/invoice';
import { roundTo } from '@/lib/currencyConversion';

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
 * Decimal-safe per-line maths. Every intermediate is rounded to the DOCUMENT
 * CURRENCY's configured decimal places (never an assumed 2 — JPY documents use
 * 0, JOD 3, BTC 8) so totals never drift on floating-point boundaries. Quantity
 * precision is independent of currency precision: only monetary results round.
 *
 *   lineSubtotal  = quantity × unitPrice
 *   discountAmount = percentage of subtotal, or a fixed amount (clamped ≥0, ≤subtotal)
 *   taxableAmount  = lineSubtotal − discountAmount
 *   taxAmount      = taxableAmount × taxRate%
 *   lineTotal      = taxableAmount + taxAmount
 */
export function calculateInvoiceLine(line: CalcLineInput, decimalPlaces = 2): InvoiceLineCalc {
  const r = (n: number): number => roundTo(n, decimalPlaces);
  const qty = Number(line.quantity) || 0;
  const price = Number(line.unitPrice) || 0;
  const lineSubtotal = r(qty * price);

  let discountAmount = 0;
  const dv = Number(line.discountValue) || 0;
  if (dv > 0) {
    discountAmount = line.discountType === 'amount' ? r(dv) : r((lineSubtotal * dv) / 100);
  }
  discountAmount = Math.min(Math.max(discountAmount, 0), lineSubtotal);

  const taxableAmount = r(lineSubtotal - discountAmount);
  const taxAmount = r((taxableAmount * (Number(line.taxRate) || 0)) / 100);
  const lineTotal = r(taxableAmount + taxAmount);

  return { lineSubtotal, discountAmount, taxableAmount, taxAmount, lineTotal };
}

/** Apply {@link calculateInvoiceLine} to a full invoice line, refreshing derived fields. */
export function recalcInvoiceLine(line: InvoiceLine, decimalPlaces = 2): InvoiceLine {
  const c = calculateInvoiceLine(line, decimalPlaces);
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
  decimalPlaces = 2,
): InvoiceTotals {
  const r = (n: number): number => roundTo(n, decimalPlaces);
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  for (const line of lines) {
    const c = calculateInvoiceLine(line, decimalPlaces);
    subtotal += c.lineSubtotal;
    discountTotal += c.discountAmount;
    taxTotal += c.taxAmount;
  }
  subtotal = r(subtotal);
  discountTotal = r(discountTotal);
  taxTotal = r(taxTotal);
  const charges = r(additionalChargesTotal);
  const grandTotal = r(subtotal - discountTotal + taxTotal + charges);
  const paid = r(amountPaid);
  return {
    subtotal,
    discountTotal,
    taxTotal,
    additionalChargesTotal: charges,
    grandTotal,
    amountPaid: paid,
    balanceDue: r(grandTotal - paid),
  };
}

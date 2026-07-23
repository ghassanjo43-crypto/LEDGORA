import type { Bill, BillLine } from '@/types/bill';
import { calculateInvoiceLine, type CalcLineInput, type InvoiceLineCalc } from '@/lib/invoiceCalculations';
import { roundTo } from '@/lib/currencyConversion';

/** Per-line bill maths — reuses the invoice module's decimal-safe calculator.
 *  `decimalPlaces` is the DOCUMENT currency's configured precision (default 2). */
export function calculateBillLine(line: CalcLineInput, decimalPlaces = 2): InvoiceLineCalc {
  return calculateInvoiceLine(line, decimalPlaces);
}

/** Withholding tax withheld on a line: taxableAmount × withholdingTaxRate%. */
export function calculateWithholdingTax(line: Pick<BillLine, 'withholdingTaxRate'> & CalcLineInput, decimalPlaces = 2): number {
  const rate = Number(line.withholdingTaxRate) || 0;
  if (rate <= 0) return 0;
  return roundTo((calculateInvoiceLine(line, decimalPlaces).taxableAmount * rate) / 100, decimalPlaces);
}

/** Refresh the derived fields on a full bill line. */
export function recalcBillLine(line: BillLine, decimalPlaces = 2): BillLine {
  const c = calculateBillLine(line, decimalPlaces);
  return {
    ...line,
    discountAmount: c.discountAmount,
    taxableAmount: c.taxableAmount,
    taxAmount: c.taxAmount,
    withholdingTaxAmount: calculateWithholdingTax(line, decimalPlaces),
    lineSubtotal: c.lineSubtotal,
    lineTotal: c.lineTotal,
  };
}

export interface BillTotals {
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  withholdingTaxTotal: number;
  additionalChargesTotal: number;
  grandTotal: number;
  /** Amount actually payable to the supplier = grandTotal − withholding tax. */
  netPayable: number;
}

/**
 * Bill totals (at the document currency's configured precision).
 *   subtotal   = Σ lineSubtotal
 *   taxTotal   = Σ taxAmount (input VAT)
 *   grandTotal = subtotal − discount + tax + additional charges
 *   netPayable = grandTotal − withholding tax (what the supplier is actually paid)
 */
export function calculateBillTotals(lines: BillLine[], additionalChargesTotal = 0, decimalPlaces = 2): BillTotals {
  const r = (n: number): number => roundTo(n, decimalPlaces);
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  let withholdingTaxTotal = 0;
  for (const line of lines) {
    const c = calculateBillLine(line, decimalPlaces);
    subtotal += c.lineSubtotal;
    discountTotal += c.discountAmount;
    taxTotal += c.taxAmount;
    withholdingTaxTotal += calculateWithholdingTax(line, decimalPlaces);
  }
  subtotal = r(subtotal);
  discountTotal = r(discountTotal);
  taxTotal = r(taxTotal);
  withholdingTaxTotal = r(withholdingTaxTotal);
  const charges = r(additionalChargesTotal);
  const grandTotal = r(subtotal - discountTotal + taxTotal + charges);
  return {
    subtotal, discountTotal, taxTotal, withholdingTaxTotal, additionalChargesTotal: charges, grandTotal,
    netPayable: r(grandTotal - withholdingTaxTotal),
  };
}

/** balanceDue = netPayable − supplier credits applied − payments applied (never below −tolerance). */
export function calculateBillBalance(bill: Pick<Bill, 'grandTotal' | 'withholdingTaxTotal' | 'supplierCreditsApplied' | 'amountPaid'>, decimalPlaces = 2): number {
  const netPayable = roundTo((Number(bill.grandTotal) || 0) - (Number(bill.withholdingTaxTotal) || 0), decimalPlaces);
  return roundTo(netPayable - (Number(bill.supplierCreditsApplied) || 0) - (Number(bill.amountPaid) || 0), decimalPlaces);
}

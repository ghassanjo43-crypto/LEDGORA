import type { Bill, BillLine } from '@/types/bill';
import { calculateInvoiceLine, type CalcLineInput, type InvoiceLineCalc } from '@/lib/invoiceCalculations';
import { roundMoney } from '@/lib/journalValidation';

/** Per-line bill maths — reuses the invoice module's decimal-safe calculator. */
export function calculateBillLine(line: CalcLineInput): InvoiceLineCalc {
  return calculateInvoiceLine(line);
}

/** Withholding tax withheld on a line: taxableAmount × withholdingTaxRate%. */
export function calculateWithholdingTax(line: Pick<BillLine, 'withholdingTaxRate'> & CalcLineInput): number {
  const rate = Number(line.withholdingTaxRate) || 0;
  if (rate <= 0) return 0;
  return roundMoney((calculateInvoiceLine(line).taxableAmount * rate) / 100);
}

/** Refresh the derived fields on a full bill line. */
export function recalcBillLine(line: BillLine): BillLine {
  const c = calculateBillLine(line);
  return {
    ...line,
    discountAmount: c.discountAmount,
    taxableAmount: c.taxableAmount,
    taxAmount: c.taxAmount,
    withholdingTaxAmount: calculateWithholdingTax(line),
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
 * Bill totals.
 *   subtotal   = Σ lineSubtotal
 *   taxTotal   = Σ taxAmount (input VAT)
 *   grandTotal = subtotal − discount + tax + additional charges
 *   netPayable = grandTotal − withholding tax (what the supplier is actually paid)
 */
export function calculateBillTotals(lines: BillLine[], additionalChargesTotal = 0): BillTotals {
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  let withholdingTaxTotal = 0;
  for (const line of lines) {
    const c = calculateBillLine(line);
    subtotal += c.lineSubtotal;
    discountTotal += c.discountAmount;
    taxTotal += c.taxAmount;
    withholdingTaxTotal += calculateWithholdingTax(line);
  }
  subtotal = roundMoney(subtotal);
  discountTotal = roundMoney(discountTotal);
  taxTotal = roundMoney(taxTotal);
  withholdingTaxTotal = roundMoney(withholdingTaxTotal);
  const charges = roundMoney(additionalChargesTotal);
  const grandTotal = roundMoney(subtotal - discountTotal + taxTotal + charges);
  return {
    subtotal, discountTotal, taxTotal, withholdingTaxTotal, additionalChargesTotal: charges, grandTotal,
    netPayable: roundMoney(grandTotal - withholdingTaxTotal),
  };
}

/** balanceDue = netPayable − supplier credits applied − payments applied (never below −tolerance). */
export function calculateBillBalance(bill: Pick<Bill, 'grandTotal' | 'withholdingTaxTotal' | 'supplierCreditsApplied' | 'amountPaid'>): number {
  const netPayable = roundMoney((Number(bill.grandTotal) || 0) - (Number(bill.withholdingTaxTotal) || 0));
  return roundMoney(netPayable - (Number(bill.supplierCreditsApplied) || 0) - (Number(bill.amountPaid) || 0));
}

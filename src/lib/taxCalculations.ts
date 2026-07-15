import type { TaxCalculationMethod, TaxCategory, TaxRoundingMethod } from '@/types/taxCode';
import { roundTo, applyRounding } from '@/lib/taxRounding';

/**
 * Centralized, decimal-safe tax calculation utilities — the single source of
 * truth for tax maths across invoices, bills, credits, journals and reports.
 * Transaction components must call these rather than re-implementing tax rules.
 */

/** Categories that report a taxable base but never touch a tax account. */
const ZERO_TAX_CATEGORIES: TaxCategory[] = ['zero-rated', 'exempt', 'out-of-scope'];
/** Categories excluded from the tax regime entirely (no reportable base). */
const NON_REPORTABLE_CATEGORIES: TaxCategory[] = ['out-of-scope'];

/** The rate actually applied for a category (zero-rated/exempt/out-of-scope → 0). */
export function effectiveRate(rate: number, category: TaxCategory): number {
  return ZERO_TAX_CATEGORIES.includes(category) ? 0 : Number(rate) || 0;
}

export interface TaxAmounts {
  taxableAmount: number;
  taxAmount: number;
  grossAmount: number;
}

/** Exclusive: tax added on top of the net. */
export function calculateTaxExclusive(net: number, rate: number, precision = 2): TaxAmounts {
  const taxableAmount = roundTo(net, precision);
  const taxAmount = roundTo((taxableAmount * (Number(rate) || 0)) / 100, precision);
  return { taxableAmount, taxAmount, grossAmount: roundTo(taxableAmount + taxAmount, precision) };
}

/** Inclusive: extract the tax already contained in the gross. */
export function calculateTaxInclusive(gross: number, rate: number, precision = 2): TaxAmounts {
  const g = roundTo(gross, precision);
  const r = Number(rate) || 0;
  const taxableAmount = roundTo(g / (1 + r / 100), precision);
  const taxAmount = roundTo(g - taxableAmount, precision);
  return { taxableAmount, taxAmount, grossAmount: g };
}

export interface CompoundTaxResult {
  taxableAmount: number;
  perRate: { rate: number; taxAmount: number; runningBase: number }[];
  taxAmount: number;
  grossAmount: number;
}

/** Compound: each successive rate applies to base + prior taxes (sequential). */
export function calculateCompoundTax(base: number, rates: number[], precision = 2): CompoundTaxResult {
  const taxableAmount = roundTo(base, precision);
  let running = taxableAmount;
  const perRate: CompoundTaxResult['perRate'] = [];
  for (const rate of rates) {
    const taxAmount = roundTo((running * (Number(rate) || 0)) / 100, precision);
    perRate.push({ rate, taxAmount, runningBase: running });
    running = roundTo(running + taxAmount, precision);
  }
  const taxAmount = roundTo(perRate.reduce((s, p) => s + p.taxAmount, 0), precision);
  return { taxableAmount, perRate, taxAmount, grossAmount: roundTo(taxableAmount + taxAmount, precision) };
}

export interface RecoverableSplit {
  recoverableTaxAmount: number;
  nonRecoverableTaxAmount: number;
}

/** Split input tax into recoverable / non-recoverable by recoverability %. */
export function calculateRecoverableTax(taxAmount: number, recoverabilityPercent = 100, precision = 2): RecoverableSplit {
  const pct = Math.max(0, Math.min(100, Number(recoverabilityPercent ?? 100)));
  const recoverableTaxAmount = roundTo((roundTo(taxAmount, precision) * pct) / 100, precision);
  return { recoverableTaxAmount, nonRecoverableTaxAmount: roundTo(roundTo(taxAmount, precision) - recoverableTaxAmount, precision) };
}

export interface TaxLineInput {
  /** Line amount inputs (net for exclusive, gross for inclusive). */
  quantity?: number;
  unitPrice?: number;
  amount?: number;
  discountAmount?: number;

  rate: number;
  category: TaxCategory;
  method: TaxCalculationMethod;
  precision?: number;
  recoverabilityPercent?: number;
}

export interface TaxLineResult {
  taxableAmount: number;
  taxAmount: number;
  grossAmount: number;
  recoverableTaxAmount: number;
  nonRecoverableTaxAmount: number;
  /** True when the base belongs in a tax return (false only for out-of-scope). */
  reportableBase: boolean;
}

/** Resolve the raw line amount before tax (qty × price − discount, or `amount`). */
export function resolveLineAmount(input: Pick<TaxLineInput, 'quantity' | 'unitPrice' | 'amount' | 'discountAmount'>, precision = 2): number {
  const base = input.amount !== undefined ? Number(input.amount) || 0 : (Number(input.quantity) || 0) * (Number(input.unitPrice) || 0);
  return roundTo(base - (Number(input.discountAmount) || 0), precision);
}

/**
 * Full single-line tax calculation honouring category, method and
 * recoverability. Out-of-scope produces no tax and no reportable base; zero-rated
 * and exempt produce a reportable base with zero tax.
 */
export function calculateTaxLine(input: TaxLineInput): TaxLineResult {
  const precision = input.precision ?? 2;
  const rate = effectiveRate(input.rate, input.category);
  const lineAmount = resolveLineAmount(input, precision);
  const reportableBase = !NON_REPORTABLE_CATEGORIES.includes(input.category);

  let amounts: TaxAmounts;
  if (input.method === 'inclusive') {
    amounts = rate > 0 ? calculateTaxInclusive(lineAmount, rate, precision) : { taxableAmount: lineAmount, taxAmount: 0, grossAmount: lineAmount };
  } else {
    // exclusive / compound (single rate) / self-assessed all compute tax on top
    amounts = calculateTaxExclusive(lineAmount, rate, precision);
  }

  const { recoverableTaxAmount, nonRecoverableTaxAmount } = calculateRecoverableTax(amounts.taxAmount, input.recoverabilityPercent ?? 100, precision);
  return {
    taxableAmount: amounts.taxableAmount,
    taxAmount: amounts.taxAmount,
    grossAmount: amounts.grossAmount,
    recoverableTaxAmount,
    nonRecoverableTaxAmount,
    reportableBase,
  };
}

export interface DocumentTaxTotals {
  taxableTotal: number;
  taxTotal: number;
  grossTotal: number;
  recoverableTotal: number;
  nonRecoverableTotal: number;
  roundingAdjustment: number;
}

/** Aggregate line results into document totals with the chosen rounding method. */
export function calculateDocumentTaxTotals(lines: TaxLineResult[], roundingMethod: TaxRoundingMethod = 'line', precision = 2): DocumentTaxTotals {
  const taxableTotal = roundTo(lines.reduce((s, l) => s + l.taxableAmount, 0), precision);
  const { total: taxTotal, roundingAdjustment } = applyRounding(lines.map((l) => l.taxAmount), roundingMethod, precision);
  const recoverableTotal = roundTo(lines.reduce((s, l) => s + l.recoverableTaxAmount, 0), precision);
  const nonRecoverableTotal = roundTo(lines.reduce((s, l) => s + l.nonRecoverableTaxAmount, 0), precision);
  return {
    taxableTotal,
    taxTotal,
    grossTotal: roundTo(taxableTotal + taxTotal, precision),
    recoverableTotal,
    nonRecoverableTotal,
    roundingAdjustment,
  };
}

export interface TaxGroupMemberInput {
  taxCodeId: string;
  rate: number;
  category: TaxCategory;
}
export interface TaxGroupMemberResult extends TaxGroupMemberInput {
  taxableBase: number;
  taxAmount: number;
}
export interface TaxGroupResult {
  taxableAmount: number;
  members: TaxGroupMemberResult[];
  taxTotal: number;
  grossAmount: number;
}

/**
 * Calculate a tax group over a shared base. Parallel: every member taxes the
 * same base. Sequential: each member taxes the base plus prior members' taxes.
 */
export function calculateTaxGroup(base: number, members: TaxGroupMemberInput[], order: 'parallel' | 'sequential', precision = 2): TaxGroupResult {
  const taxableAmount = roundTo(base, precision);
  let running = taxableAmount;
  const results: TaxGroupMemberResult[] = members.map((m) => {
    const rate = effectiveRate(m.rate, m.category);
    const taxableBase = order === 'sequential' ? running : taxableAmount;
    const taxAmount = roundTo((taxableBase * rate) / 100, precision);
    if (order === 'sequential') running = roundTo(running + taxAmount, precision);
    return { ...m, taxableBase, taxAmount };
  });
  const taxTotal = roundTo(results.reduce((s, r) => s + r.taxAmount, 0), precision);
  return { taxableAmount, members: results, taxTotal, grossAmount: roundTo(taxableAmount + taxTotal, precision) };
}

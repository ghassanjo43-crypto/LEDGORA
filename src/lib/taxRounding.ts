import type { TaxRoundingMethod } from '@/types/taxCode';

/**
 * Decimal-safe rounding for tax. Posted tax amounts must never use raw
 * floating-point arithmetic — every result routes through {@link roundTo}, which
 * rounds half-away-from-zero at the configured precision.
 */
export function roundTo(value: number, precision = 2): number {
  const n = Number(value) || 0;
  const factor = 10 ** Math.max(0, Math.min(6, precision));
  // +Number.EPSILON avoids representable-value drift (e.g. 1.005 → 1.00).
  return Math.sign(n) * Math.round((Math.abs(n) + Number.EPSILON) * factor) / factor;
}

/** Two-dp money rounding (currency precision), decimal-safe. */
export function roundMoney2(value: number): number {
  return roundTo(value, 2);
}

export { type TaxRoundingMethod };

/**
 * Line rounding rounds each line then sums; document rounding sums the raw
 * amounts and rounds once. The returned `roundingAdjustment` is the difference
 * between the two (shown as a tax-rounding line when material).
 */
export function applyRounding(
  rawLineTaxAmounts: number[],
  method: TaxRoundingMethod,
  precision = 2,
): { total: number; roundingAdjustment: number } {
  const rawSum = rawLineTaxAmounts.reduce((s, n) => s + (Number(n) || 0), 0);
  if (method === 'document') {
    const total = roundTo(rawSum, precision);
    return { total, roundingAdjustment: 0 };
  }
  const lineRounded = rawLineTaxAmounts.reduce((s, n) => s + roundTo(n, precision), 0);
  const total = roundTo(lineRounded, precision);
  return { total, roundingAdjustment: roundTo(total - roundTo(rawSum, precision), precision) };
}

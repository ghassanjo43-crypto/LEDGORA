import type { NegativeFormat } from '@/types/incomeStatement';
import { companyMonetaryDecimals, smallestUnit, companyCurrencyCode } from '@/lib/monetaryPrecision';

/**
 * Income-statement amount formatting.
 *
 * Built per call, for the reason given in `bsFormat`: a module-level formatter
 * would fix one company's precision for the whole session, and this one was
 * additionally fixed at two decimals regardless of currency.
 */
function formatter(): Intl.NumberFormat {
  const decimals = companyMonetaryDecimals();
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Financial-statement amount: zero as “—”, negatives per the chosen format. */
export function isAmount(n: number, negativeFormat: NegativeFormat = 'parentheses'): string {
  if (Math.abs(n) < smallestUnit(companyCurrencyCode()) / 2) return '—';
  const nf = formatter();
  if (n < 0) return negativeFormat === 'parentheses' ? `(${nf.format(-n)})` : `-${nf.format(-n)}`;
  return nf.format(n);
}

/* ── Percentages: NOT monetary, and deliberately left at one decimal ───────── */

/** Signed percentage, e.g. “+19.0%”, or “N/M” when not meaningful (null). */
export function isVariancePercent(v: number | null): string {
  if (v === null) return 'N/M';
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${Math.abs(v * 100).toFixed(1)}%`;
}

/** Plain percentage for margins / % of revenue; “—” when unavailable (null). */
export function isPercent(v: number | null): string {
  if (v === null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

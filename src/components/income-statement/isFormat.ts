import type { NegativeFormat } from '@/types/incomeStatement';

const NF = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Financial-statement amount: zero as “—”, negatives per the chosen format. */
export function isAmount(n: number, negativeFormat: NegativeFormat = 'parentheses'): string {
  if (Math.abs(n) < 0.005) return '—';
  if (n < 0) return negativeFormat === 'parentheses' ? `(${NF.format(-n)})` : `-${NF.format(-n)}`;
  return NF.format(n);
}

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

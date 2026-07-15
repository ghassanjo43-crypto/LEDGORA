import type { NegativeFormat } from '@/types/incomeStatement';

const NF = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Financial-statement amount: zero as “—”, negatives in parentheses (or minus). */
export function formatFinancialAmount(n: number, negativeFormat: NegativeFormat = 'parentheses'): string {
  if (Math.abs(n) < 0.005) return '—';
  if (n < 0) return negativeFormat === 'parentheses' ? `(${NF.format(-n)})` : `-${NF.format(-n)}`;
  return NF.format(n);
}

export function formatVariancePercent(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'N/M';
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${Math.abs(v * 100).toFixed(1)}%`;
}

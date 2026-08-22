import type { NegativeFormat } from '@/types/incomeStatement';
import { companyMonetaryDecimals, smallestUnit, companyCurrencyCode } from '@/lib/monetaryPrecision';

/**
 * Balance-sheet amount formatting.
 *
 * ── Why the formatter is built per call ─────────────────────────────────────
 * This was a module-level `Intl.NumberFormat` fixed at two decimals, so every
 * balance sheet in Ledgora rendered `1,250.00` whatever the company's currency
 * was. A JOD balance sheet is kept in thousandths and must read `1,250.000`.
 *
 * Building it inside the function is deliberate: a formatter captured at module
 * load would freeze the FIRST company's precision and then carry it into every
 * organization opened afterwards in the same session.
 */
function formatter(): Intl.NumberFormat {
  const decimals = companyMonetaryDecimals();
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Financial-statement amount: zero as “—”, negatives in parentheses (or minus). */
export function formatFinancialAmount(n: number, negativeFormat: NegativeFormat = 'parentheses'): string {
  // "Effectively zero" is half the currency's smallest unit, not half a cent —
  // otherwise a genuine 0.003 JOD line would be shown as nothing at all.
  if (Math.abs(n) < smallestUnit(companyCurrencyCode()) / 2) return '—';
  const nf = formatter();
  if (n < 0) return negativeFormat === 'parentheses' ? `(${nf.format(-n)})` : `-${nf.format(-n)}`;
  return nf.format(n);
}

/** Signed percentage. NOT a monetary value — one decimal, independent of currency. */
export function formatVariancePercent(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'N/M';
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${Math.abs(v * 100).toFixed(1)}%`;
}

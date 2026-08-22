/**
 * Monetary formatting.
 *
 * ══ Precision comes from the currency, not from the caller ═══════════════════
 *
 * `formatCurrency` used to take `decimals = 2`. Almost nothing passed it, so
 * almost every amount in Ledgora — every report, every card, every printed
 * document — was rendered to two decimal places regardless of the currency it
 * was denominated in. For a dollar company that is right by coincidence. For a
 * JOD, KWD, BHD or OMR company it is wrong: those currencies are kept in
 * thousandths, so `1,250.000` was displayed as `1,250.00` and a fils per line
 * vanished from the screen while remaining in the ledger.
 *
 * The parameter is now OPTIONAL and, when omitted, the precision is resolved
 * from Ledgora's canonical currency metadata. That single change corrects every
 * caller that was silently taking the default, which is nearly all of them.
 *
 * ══ Why the override was kept ═══════════════════════════════════════════════
 *
 * Two legitimate uses. `formatCurrencyCompact` deliberately drops decimals for
 * summary cards, and a caller that has already resolved precision for other
 * reasons should not have to resolve it twice. An explicit argument is a
 * deliberate statement; the old default was an accident.
 *
 * ══ Why not Intl's own defaults ═════════════════════════════════════════════
 *
 * `Intl.NumberFormat` knows ISO minor units and would get JOD right on its own,
 * but it knows nothing about an organization's CUSTOM currencies, and it cannot
 * be corrected when a currency's configuration is deliberately different. The
 * currency master is the authority; Intl is only the renderer, and the digit
 * counts are handed to it explicitly.
 */
import { getCurrencyMonetaryDecimals } from '@/lib/monetaryPrecision';

/**
 * Format an amount in its currency.
 *
 * `decimals` defaults to the currency's canonical monetary precision — JOD 3,
 * USD 2, JPY 0 — and negatives keep the locale's accounting presentation.
 */
export function formatCurrency(
  amount: number,
  currency: string,
  decimals?: number,
): string {
  const places = decimals ?? getCurrencyMonetaryDecimals(currency);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: places,
      maximumFractionDigits: places,
      currencySign: 'accounting',
    }).format(amount || 0);
  } catch {
    // Not an ISO code Intl recognises — an organization's custom currency, for
    // instance. Its precision still came from the master above.
    return `${currency} ${new Intl.NumberFormat('en-US', {
      minimumFractionDigits: places,
      maximumFractionDigits: places,
    }).format(amount || 0)}`;
  }
}

/**
 * Compact, whole-unit variant for principal summary cards.
 *
 * A DELIBERATE exception to currency precision, and the only one: these cards
 * present a magnitude at a glance, not a figure to reconcile against. The zero
 * is passed explicitly so it reads as a decision rather than a default.
 */
export function formatCurrencyCompact(amount: number, currency: string): string {
  return formatCurrency(amount, currency, 0);
}

/** Signed percentage, e.g. "+12.5%" / "−3.0%". NOT a monetary value. */
export function formatPercent(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(1)}%`;
}

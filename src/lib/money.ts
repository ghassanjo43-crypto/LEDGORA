/**
 * Base-currency money formatting for the dashboard. Uses Intl.NumberFormat so
 * negative values follow the locale's accounting-style presentation. Amounts
 * passed here must already be in the base currency (see convertToBase).
 */
export function formatCurrency(
  amount: number,
  currency: string,
  decimals = 2,
): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      currencySign: 'accounting',
    }).format(amount || 0);
  } catch {
    // Unknown ISO code → fall back to plain number + code.
    return `${currency} ${new Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amount || 0)}`;
  }
}

/** Compact, no-decimals variant for principal summary cards. */
export function formatCurrencyCompact(amount: number, currency: string): string {
  return formatCurrency(amount, currency, 0);
}

/** Signed percentage, e.g. "+12.5%" / "−3.0%". */
export function formatPercent(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(1)}%`;
}

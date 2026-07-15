import type { Currency } from '@/types/currency';
import { roundCurrencyAmount } from '@/lib/currencyConversion';

/**
 * Currency-aware formatting honouring each currency's configured decimals,
 * symbol position, separators and negative format. Precision is never forced to
 * two decimals — JPY shows 0, JOD shows 3.
 */

function groupInteger(intPart: string, thousand: string): string {
  if (!thousand) return intPart;
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, thousand);
}

/** Format the numeric magnitude with the currency's decimals + separators (no symbol/sign). */
export function formatNumber(amount: number, currency: Pick<Currency, 'decimalPlaces' | 'decimalSeparator' | 'thousandSeparator' | 'roundingIncrement'>): string {
  const rounded = roundCurrencyAmount(Math.abs(amount), currency);
  const dp = currency.decimalPlaces ?? 2;
  const fixed = rounded.toFixed(dp);
  const [intPart, decPart] = fixed.split('.');
  const grouped = groupInteger(intPart ?? '0', currency.thousandSeparator);
  return dp > 0 && decPart ? `${grouped}${currency.decimalSeparator}${decPart}` : grouped;
}

/** Full formatted amount with symbol and negative presentation, e.g. "$1,234.56" / "(1,234.56)". */
export function formatCurrencyAmount(amount: number, currency: Currency | undefined, opts: { showCode?: boolean } = {}): string {
  if (!currency) {
    const n = (Number(amount) || 0).toFixed(2);
    return `${n}`;
  }
  const negative = (Number(amount) || 0) < -0.5 / 10 ** (currency.decimalPlaces ?? 2);
  const magnitude = formatNumber(amount, currency);
  const withSymbol = currency.symbolPosition === 'after' ? `${magnitude} ${currency.symbol}` : `${currency.symbol}${magnitude}`;
  const codeSuffix = opts.showCode ? ` ${currency.code}` : '';
  if (!negative) return `${withSymbol}${codeSuffix}`;
  return currency.negativeFormat === '(1,234.56)' ? `(${withSymbol})${codeSuffix}` : `-${withSymbol}${codeSuffix}`;
}

/** "USD 1,000.00 · Base: JOD 709.000" dual display for foreign documents. */
export function formatForeignAndBaseAmount(
  foreignAmount: number,
  foreignCurrency: Currency | undefined,
  baseAmount: number,
  baseCurrency: Currency | undefined,
): string {
  const foreign = `${foreignCurrency?.code ?? ''} ${formatNumber(foreignAmount, foreignCurrency ?? fallbackCurrency())}`.trim();
  if (!baseCurrency || (foreignCurrency && foreignCurrency.code === baseCurrency.code)) return foreign;
  return `${foreign} · Base: ${baseCurrency.code} ${formatNumber(baseAmount, baseCurrency)}`;
}

function fallbackCurrency(): Currency {
  return { id: '', code: '', name: '', symbol: '', decimalPlaces: 2, symbolPosition: 'before', decimalSeparator: '.', thousandSeparator: ',', negativeFormat: '-1,234.56', status: 'active', auditTrail: [], createdAt: '', updatedAt: '' };
}

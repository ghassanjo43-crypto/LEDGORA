import type { Currency } from '@/types/currency';
import { monetaryDecimalsOf, roundingMethodOf } from '@/types/currency';
import { roundCurrencyAmountDec } from '@/lib/currencyConversion';
import { decAbs, decCmp, decRound, isDecimal } from '@/lib/decimal';

/**
 * Centralized currency-aware formatting honouring each currency's configured
 * decimals (0–18), rounding method + increment, symbol position and spacing,
 * separators and negative format. Precision is never forced to two decimals —
 * JPY shows 0, JOD shows 3, BTC shows 8. Amounts may be passed as decimal
 * STRINGS for high-precision currencies; numbers remain accepted for legacy
 * call sites.
 */

export interface FormatAmountOptions {
  /** Append the currency code after the formatted amount. */
  showCode?: boolean;
  /** Explicit precision override (display contexts that legitimately differ). */
  precisionOverride?: number;
}

function groupInteger(intPart: string, thousand: string): string {
  if (!thousand) return intPart;
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, thousand);
}

/** Format the numeric magnitude with the currency's decimals + separators (no symbol/sign). */
export function formatNumber(
  amount: number | string,
  currency: Pick<Currency, 'decimalPlaces' | 'decimalSeparator' | 'thousandSeparator' | 'roundingIncrement' | 'roundingMethod'>,
  precisionOverride?: number,
): string {
  const safe = isDecimal(amount) ? amount : 0;
  const dp = precisionOverride ?? monetaryDecimalsOf(currency);
  const rounded =
    precisionOverride !== undefined
      ? decRound(safe, dp, roundingMethodOf(currency))
      : roundCurrencyAmountDec(safe, currency);
  const fixed = decAbs(rounded);
  const [intPart, decPart] = fixed.split('.');
  const grouped = groupInteger(intPart ?? '0', currency.thousandSeparator);
  return dp > 0 && decPart ? `${grouped}${currency.decimalSeparator}${decPart}` : grouped;
}

/**
 * Full formatted amount with symbol and negative presentation, e.g.
 * "$1,234.56", "JD 1,234.568", "(¥1,235)", "1.234,56- €". Negative detection
 * happens AFTER rounding, so a value that rounds to zero never shows a sign.
 */
export function formatCurrencyAmount(
  amount: number | string,
  currency: Currency | undefined,
  opts: FormatAmountOptions = {},
): string {
  if (!currency) {
    const n = isDecimal(amount) ? decRound(amount, 2) : '0.00';
    return `${n}`;
  }
  const safe = isDecimal(amount) ? amount : 0;
  const dp = opts.precisionOverride ?? monetaryDecimalsOf(currency);
  const rounded =
    opts.precisionOverride !== undefined
      ? decRound(safe, dp, roundingMethodOf(currency))
      : roundCurrencyAmountDec(safe, currency);
  const negative = decCmp(rounded, 0) < 0;
  const magnitude = formatNumber(safe, currency, opts.precisionOverride);
  const gap = currency.symbolSpacing ? ' ' : '';
  const withSymbol =
    currency.symbolPosition === 'after' ? `${magnitude} ${currency.symbol}` : `${currency.symbol}${gap}${magnitude}`;
  const codeSuffix = opts.showCode ? ` ${currency.code}` : '';
  if (!negative) return `${withSymbol}${codeSuffix}`;
  switch (currency.negativeFormat) {
    case '(1,234.56)':
      return `(${withSymbol})${codeSuffix}`;
    case '1,234.56-':
      return `${withSymbol}-${codeSuffix}`;
    default:
      return `-${withSymbol}${codeSuffix}`;
  }
}

/** "USD 1,000.00 · Base: JOD 709.000" dual display for foreign documents. */
export function formatForeignAndBaseAmount(
  foreignAmount: number | string,
  foreignCurrency: Currency | undefined,
  baseAmount: number | string,
  baseCurrency: Currency | undefined,
): string {
  const foreign = `${foreignCurrency?.code ?? ''} ${formatNumber(foreignAmount, foreignCurrency ?? fallbackCurrency())}`.trim();
  if (!baseCurrency || (foreignCurrency && foreignCurrency.code === baseCurrency.code)) return foreign;
  return `${foreign} · Base: ${baseCurrency.code} ${formatNumber(baseAmount, baseCurrency)}`;
}

/** "JOD 1,234.568" — code-first presentation used by reports and previews. */
export function formatWithCode(amount: number | string, currency: Currency | undefined): string {
  if (!currency) return String(amount);
  return `${currency.code} ${formatNumber(amount, currency)}`;
}

function fallbackCurrency(): Currency {
  return { id: '', code: '', name: '', symbol: '', decimalPlaces: 2, symbolPosition: 'before', decimalSeparator: '.', thousandSeparator: ',', negativeFormat: '-1,234.56', status: 'active', auditTrail: [], createdAt: '', updatedAt: '' };
}

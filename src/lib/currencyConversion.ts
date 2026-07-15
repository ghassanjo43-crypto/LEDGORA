import type { Currency } from '@/types/currency';

/**
 * Centralized, decimal-safe currency conversion — the single source of truth.
 *
 * Convention: `1 unit of fromCurrency = rate units of toCurrency`, so a rate is
 * always foreign→base when converting to the base currency:
 *   baseAmount    = foreignAmount × rate
 *   foreignAmount = baseAmount ÷ rate
 *
 * Posted monetary values are rounded to the target currency's precision; the
 * rate itself is kept at high precision. Never use a rate of 1 for a missing
 * foreign rate — callers must resolve a real rate first.
 */

/** Round-half-away-from-zero at a given decimal precision (decimal-safe). */
export function roundTo(value: number, decimals: number): number {
  const n = Number(value) || 0;
  const d = Math.max(0, Math.min(12, Math.trunc(decimals)));
  const factor = 10 ** d;
  return (Math.sign(n) * Math.round((Math.abs(n) + Number.EPSILON) * factor)) / factor;
}

/** Round an amount to a currency's configured precision (and cash increment). */
export function roundCurrencyAmount(amount: number, currency: Pick<Currency, 'decimalPlaces' | 'roundingIncrement'>): number {
  const rounded = roundTo(amount, currency.decimalPlaces ?? 2);
  const inc = currency.roundingIncrement;
  if (inc && inc > 0) return roundTo(Math.round(rounded / inc) * inc, currency.decimalPlaces ?? 2);
  return rounded;
}

/** Exchange rates keep 8 decimals of precision. */
export function roundExchangeRate(rate: number): number {
  return roundTo(rate, 8);
}

export interface ConvertOptions {
  /** Decimal places of the result currency (defaults to 2). */
  precision?: number;
  roundingIncrement?: number;
}

/**
 * Convert an amount by a rate under the standard convention (amount × rate).
 * Rounds the RESULT to the target precision; intermediate maths stays full-float.
 */
export function convertCurrency(amount: number, rate: number, opts: ConvertOptions = {}): number {
  const raw = (Number(amount) || 0) * (Number(rate) || 0);
  return roundCurrencyAmount(raw, { decimalPlaces: opts.precision ?? 2, roundingIncrement: opts.roundingIncrement });
}

/** foreign → base: baseAmount = foreignAmount × rate. Same-currency → identity. */
export function convertToBase(foreignAmount: number, rate: number, sameCurrency: boolean, basePrecision = 2): number {
  if (sameCurrency) return roundCurrencyAmount(foreignAmount, { decimalPlaces: basePrecision });
  return convertCurrency(foreignAmount, rate, { precision: basePrecision });
}

/** base → foreign: foreignAmount = baseAmount ÷ rate. */
export function convertFromBase(baseAmount: number, rate: number, sameCurrency: boolean, foreignPrecision = 2): number {
  if (sameCurrency) return roundCurrencyAmount(baseAmount, { decimalPlaces: foreignPrecision });
  if (!rate) return 0;
  return roundCurrencyAmount((Number(baseAmount) || 0) / rate, { decimalPlaces: foreignPrecision });
}

/** The base amount for a foreign amount given a currency map + rate; base identity = 1. */
export function convertToBaseCurrencyByCode(
  foreignAmount: number,
  fromCode: string,
  baseCode: string,
  rate: number,
  currencies: Map<string, Currency>,
): number {
  const same = fromCode.toUpperCase() === baseCode.toUpperCase();
  const basePrecision = currencies.get(baseCode)?.decimalPlaces ?? 2;
  return convertToBase(foreignAmount, same ? 1 : rate, same, basePrecision);
}

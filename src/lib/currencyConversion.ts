import type { Currency, RoundingMethod } from '@/types/currency';
import { DEFAULT_RATE_DECIMALS, monetaryDecimalsOf, rateDecimalsOf, roundingMethodOf } from '@/types/currency';
import {
  decDiv,
  decMul,
  decRound,
  decRoundToIncrement,
  decToNumber,
} from '@/lib/decimal';

/**
 * Centralized, decimal-safe currency conversion — the single source of truth.
 *
 * Convention: `1 unit of fromCurrency = rate units of toCurrency`, so a rate is
 * always foreign→base when converting to the base currency:
 *   baseAmount    = foreignAmount × rate
 *   foreignAmount = baseAmount ÷ rate
 *
 * All arithmetic routes through the scaled-BigInt engine in `lib/decimal` — no
 * binary floating-point in the multiply/divide/round path. Posted monetary
 * values are rounded to the target currency's configured precision (0–18, never
 * assumed 2) with its configured rounding method; the rate keeps its own
 * configured precision. Never use a rate of 1 for a missing foreign rate —
 * callers must resolve a real rate first.
 *
 * Two API surfaces:
 *   · string functions (`*Dec`) — exact, for high-precision currencies;
 *   · number functions — compatibility bridge for existing numeric call sites
 *     (safe at conventional fiat precision; the string API is authoritative).
 */

/* ── Exact string API ─────────────────────────────────────────────────────── */

export interface DecRoundOptions {
  decimals: number;
  method?: RoundingMethod;
  /** Cash increment such as "0.05"; applied after precision rounding. */
  increment?: string | number;
}

/** Round a decimal string to a precision/method/increment. */
export function roundAmountDec(value: string | number, opts: DecRoundOptions): string {
  const method = opts.method ?? 'half-up';
  if (opts.increment !== undefined && Number(opts.increment) > 0) {
    return decRoundToIncrement(value, opts.increment, opts.decimals, method);
  }
  return decRound(value, opts.decimals, method);
}

/** Round a decimal amount to a currency's configured precision + method + increment. */
export function roundCurrencyAmountDec(
  value: string | number,
  currency: Pick<Currency, 'decimalPlaces' | 'roundingIncrement' | 'roundingMethod'>,
): string {
  return roundAmountDec(value, {
    decimals: monetaryDecimalsOf(currency),
    method: roundingMethodOf(currency),
    increment: currency.roundingIncrement,
  });
}

/** amount × rate, rounded to the target currency's precision (exact). */
export function convertAmountDec(
  amount: string | number,
  rate: string | number,
  target: Pick<Currency, 'decimalPlaces' | 'roundingIncrement' | 'roundingMethod'>,
): string {
  return roundCurrencyAmountDec(decMul(amount, rate), target);
}

/** amount ÷ rate, rounded to the target currency's precision (exact). */
export function convertAmountByInverseDec(
  amount: string | number,
  rate: string | number,
  target: Pick<Currency, 'decimalPlaces' | 'roundingIncrement' | 'roundingMethod'>,
): string {
  const dp = monetaryDecimalsOf(target);
  // Divide with guard digits, then apply the currency's rounding policy.
  return roundCurrencyAmountDec(decDiv(amount, rate, dp + 6, 'half-up'), target);
}

/** Round an exchange rate to a currency pair's configured rate precision (exact). */
export function roundExchangeRateDec(rate: string | number, decimals = DEFAULT_RATE_DECIMALS): string {
  return decRound(rate, decimals, 'half-up');
}

/**
 * Inverse rate at a given precision. The entered direction remains the
 * AUTHORITATIVE rate — a rounded inverse is informational and must never be
 * assumed to reproduce the original ("do not trust 1/(1/r) === r").
 */
export function inverseRateDec(rate: string | number, decimals = DEFAULT_RATE_DECIMALS): string {
  return decDiv('1', rate, decimals, 'half-up');
}

/** Effective rate precision when converting between two master currencies. */
export function ratePrecisionFor(
  from: Pick<Currency, 'exchangeRateDecimalPlaces'> | undefined,
  to: Pick<Currency, 'exchangeRateDecimalPlaces'> | undefined,
): number {
  return Math.max(rateDecimalsOf(from), rateDecimalsOf(to));
}

/* ── Numeric compatibility API (existing call sites) ──────────────────────── */

/** Round at a precision (decimal-safe internally); default method half-up (away from zero on ties). */
export function roundTo(value: number, decimals: number, method: RoundingMethod = 'half-up'): number {
  const n = Number(value) || 0;
  const d = Math.max(0, Math.min(18, Math.trunc(decimals)));
  return decToNumber(decRound(n, d, method));
}

/** Round an amount to a currency's configured precision (and cash increment). */
export function roundCurrencyAmount(
  amount: number,
  currency: Pick<Currency, 'decimalPlaces' | 'roundingIncrement' | 'roundingMethod'>,
): number {
  return decToNumber(roundCurrencyAmountDec(Number(amount) || 0, currency));
}

/** Exchange-rate rounding; precision defaults to 8 and follows the currency's configuration. */
export function roundExchangeRate(rate: number, decimals = DEFAULT_RATE_DECIMALS): number {
  return decToNumber(roundExchangeRateDec(Number(rate) || 0, decimals));
}

export interface ConvertOptions {
  /** Decimal places of the result currency (defaults to 2 for legacy callers). */
  precision?: number;
  roundingIncrement?: number;
  roundingMethod?: RoundingMethod;
}

/**
 * Convert an amount by a rate under the standard convention (amount × rate).
 * Rounds the RESULT to the target precision; the multiply itself is decimal-safe.
 */
export function convertCurrency(amount: number, rate: number, opts: ConvertOptions = {}): number {
  return decToNumber(
    roundAmountDec(decMul(Number(amount) || 0, Number(rate) || 0), {
      decimals: opts.precision ?? 2,
      method: opts.roundingMethod,
      increment: opts.roundingIncrement,
    }),
  );
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
  return decToNumber(decDiv(Number(baseAmount) || 0, rate, foreignPrecision, 'half-up'));
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
  const basePrecision = monetaryDecimalsOf(currencies.get(baseCode));
  return convertToBase(foreignAmount, same ? 1 : rate, same, basePrecision);
}

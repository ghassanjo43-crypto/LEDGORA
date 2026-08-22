/**
 * How many decimal places a monetary amount has, and where that answer comes
 * from.
 *
 * ══ The canonical chain ══════════════════════════════════════════════════════
 *
 *   active organization
 *     → its functional (base) currency code
 *       → the Currency Master record for that code
 *         → `Currency.decimalPlaces`
 *           → input, validation, rounding and display
 *
 * Every step already existed. What did not exist was a single place that walked
 * the chain, so each caller answered the question for itself — and the common
 * answer was a silent `2`. That is correct for the dollar and wrong for the
 * dinar: a JOD company's books are kept in thousandths, and showing `1,250.00`
 * where the ledger holds `1,250.000` loses a fils per line.
 *
 * ══ Why the Currency Master and not the ISO catalogue ════════════════════════
 *
 * The catalogue is the ISO reference data. The MASTER is what this organization
 * actually uses, and it carries organization-defined custom currencies that the
 * catalogue has never heard of. Resolution therefore reads the master first and
 * falls back to the catalogue only for a code the master does not hold.
 *
 * ══ The one fallback, and why it is here rather than everywhere ══════════════
 *
 * A code in neither the master nor the catalogue has no metadata to consult, so
 * something has to be assumed. {@link FALLBACK_MONETARY_DECIMALS} is that
 * assumption, declared once, exported so tests can pin it, and reached only
 * after both real sources have been asked. Scattered `?? 2` expressions were
 * the same guess made silently in thirty places.
 *
 * ══ What this is NOT ════════════════════════════════════════════════════════
 *
 * Not exchange-rate precision — that is a different concept with its own
 * configuration (`exchangeRateDecimalPlaces`, default 8) and is untouched here.
 * Not percentages, not quantities, not unit counts. Only the number of decimals
 * a MONETARY amount carries.
 */
import type { Currency } from '@/types/currency';
import { monetaryDecimalsOf } from '@/types/currency';
import { findCatalogEntry } from '@/data/currencyCatalog';
import { roundCurrencyAmount } from '@/lib/currencyConversion';

/*
 * ══ Why this module imports no stores ════════════════════════════════════════
 *
 * It is asked for precision from deep inside the accounting libraries —
 * `journalValidation`, the report calculators — and those libraries are
 * imported BY the stores. Importing `currencyStore` or `useStore` here would
 * therefore close a cycle:
 *
 *   journalStore → journalValidation → monetaryPrecision → currencyStore
 *                → journalStore
 *
 * which ESM resolves by handing one of them a half-initialised module ("Cannot
 * access ... before initialization" at run time, long after type-checking has
 * passed).
 *
 * So the two live sources are INJECTED instead. Each store registers itself as
 * it loads; until then the ISO catalogue answers, which is correct for every
 * standard currency and keeps this module usable in isolation and in tests.
 */

type CurrencyMasterLookup = (code: string) => PrecisionSource | undefined;

let currencyMasterLookup: CurrencyMasterLookup | null = null;
let companyCurrencyLookup: (() => string) | null = null;

/** Called by `currencyStore` at load: the organization's Currency Master. */
export function registerCurrencyMasterSource(lookup: CurrencyMasterLookup): void {
  currencyMasterLookup = lookup;
}

/** Called by `useStore` at load: the active organization's functional currency. */
export function registerCompanyCurrencySource(lookup: () => string): void {
  companyCurrencyLookup = lookup;
}

/** Test seam: forget both registrations. */
export function resetPrecisionSources(): void {
  currencyMasterLookup = null;
  companyCurrencyLookup = null;
}

/**
 * The assumption made for a currency with no metadata anywhere.
 *
 * Two, because a code that reached this point is almost always a legacy record
 * written before the Currency Master existed, and those were written by code
 * that assumed two. Changing the assumption would silently restate them.
 */
export const FALLBACK_MONETARY_DECIMALS = 2;

/** The shape the rounding engine needs. Never a second copy of the metadata. */
type PrecisionSource = Pick<Currency, 'decimalPlaces' | 'roundingMethod' | 'roundingIncrement'>;

/**
 * The Currency Master record for a code, or the catalogue entry as a stand-in.
 *
 * Read at CALL TIME, never captured. Switching the active company changes the
 * answer, and a value captured at module load would leak one organization's
 * precision into another's screens.
 */
export function resolveCurrencyPrecision(code: string | undefined | null): PrecisionSource {
  const normalized = (code ?? '').trim().toUpperCase();
  if (!normalized) return { decimalPlaces: FALLBACK_MONETARY_DECIMALS };

  // 1. The organization's own Currency Master — includes custom currencies.
  const master = currencyMasterLookup?.(normalized);
  if (master) return master;

  // 2. ISO reference data, for a code the master has not been seeded with.
  const catalogued = findCatalogEntry(normalized);
  if (catalogued) return { decimalPlaces: catalogued.decimals };

  // 3. Nothing knows this code. See FALLBACK_MONETARY_DECIMALS.
  return { decimalPlaces: FALLBACK_MONETARY_DECIMALS };
}

/**
 * Monetary decimal places for a currency code.
 *
 * The function every monetary path should ask. JOD 3, USD 2, JPY 0, KWD 3.
 */
export function getCurrencyMonetaryDecimals(code: string | undefined | null): number {
  return monetaryDecimalsOf(resolveCurrencyPrecision(code));
}

/* ── The active company ───────────────────────────────────────────────────── */

/** The active organization's functional currency code. */
export function companyCurrencyCode(): string {
  return (companyCurrencyLookup?.() ?? '').trim().toUpperCase();
}

/** Monetary decimals for the active organization's functional currency. */
export function companyMonetaryDecimals(): number {
  return getCurrencyMonetaryDecimals(companyCurrencyCode());
}

/* ── Rounding ─────────────────────────────────────────────────────────────── */

/**
 * Round an amount to a currency's monetary precision.
 *
 * Delegates to the existing engine in `currencyConversion`, which is exact
 * (BigInt fixed-point) and already honours the currency's `roundingMethod` and
 * cash `roundingIncrement`. This function exists to resolve the currency, not
 * to round — there is one rounding engine and this is not a second one.
 */
export function roundToCurrencyPrecision(amount: number, code: string | undefined | null): number {
  return roundCurrencyAmount(amount, resolveCurrencyPrecision(code));
}

/** As {@link roundToCurrencyPrecision}, for the active company's currency. */
export function roundToCompanyPrecision(amount: number): number {
  return roundToCurrencyPrecision(amount, companyCurrencyCode());
}

/**
 * The smallest amount that is not zero in this currency: 0.001 for JOD, 0.01
 * for USD, 1 for JPY.
 *
 * Used as the balance tolerance and as the `step` of a monetary input, so both
 * follow the currency instead of a hard-coded penny.
 */
export function smallestUnit(code: string | undefined | null): number {
  return 10 ** -getCurrencyMonetaryDecimals(code);
}

/* ── Validation ───────────────────────────────────────────────────────────── */

/**
 * How many decimal places a typed value actually carries.
 *
 * Deliberately reads the TEXT rather than the parsed number: `100.1230` is
 * three meaningful decimals typed with a trailing zero, and `Number()` would
 * have thrown that distinction away before it could be judged.
 */
export function decimalPlacesIn(value: string | number): number {
  const text = String(value).trim();
  if (!text) return 0;
  // Exponent form carries no typed decimals to count; fall back to the number.
  if (/e/i.test(text)) {
    const [, fraction = ''] = Number(text).toFixed(18).replace(/0+$/, '').split('.');
    return fraction.length;
  }
  const [, fraction = ''] = text.split('.');
  return fraction.replace(/0+$/, '').length;
}

export interface MonetaryPrecisionCheck {
  ok: boolean;
  error?: string;
  /** The currency's allowed decimals, for a caller that wants to say it again. */
  decimals: number;
}

/**
 * May this amount be entered in this currency?
 *
 * Refuses rather than truncating. Silently dropping a digit the user typed is
 * the one behaviour an accounting system must not have: it turns a typo into a
 * posted figure nobody was told about, and the difference only shows up when
 * something fails to balance much later.
 *
 * The message names the currency and its limit, so the answer to "why?" is on
 * screen rather than in a help page.
 */
export function validateMonetaryDecimals(
  value: string | number,
  code: string | undefined | null,
): MonetaryPrecisionCheck {
  const decimals = getCurrencyMonetaryDecimals(code);
  const typed = decimalPlacesIn(value);
  if (typed <= decimals) return { ok: true, decimals };

  const currency = (code ?? '').trim().toUpperCase() || 'This currency';
  return {
    ok: false,
    decimals,
    error:
      decimals === 0
        ? `${currency} does not support decimal places.`
        : `${currency} supports a maximum of ${decimals} decimal place${decimals === 1 ? '' : 's'}.`,
  };
}

/** As {@link validateMonetaryDecimals}, against the active company's currency. */
export function validateCompanyMonetaryDecimals(value: string | number): MonetaryPrecisionCheck {
  return validateMonetaryDecimals(value, companyCurrencyCode());
}

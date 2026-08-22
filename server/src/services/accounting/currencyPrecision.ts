/**
 * Monetary precision for the server: how many decimal places a currency's
 * posted amounts may carry.
 *
 * ══ Why the server needs its own copy ════════════════════════════════════════
 *
 * The browser has the Currency Master and the ISO catalogue; this process has
 * neither. It cannot import them either — the frontend catalogue is part of a
 * separate build with its own tsconfig and module graph, and reaching across
 * would drag React-era code into the API server.
 *
 * That leaves a genuine duplication of reference data, and duplication drifts.
 * So the risk is managed rather than ignored: `currencyPrecision.test.ts` reads
 * `src/data/currencyCatalog.ts` from disk and fails if the two disagree about
 * any currency. The table below may be edited; it may not silently diverge.
 *
 * ══ Why a table of EXCEPTIONS ═══════════════════════════════════════════════
 *
 * ISO 4217 gives almost every currency two minor units. Listing all 162 would
 * be 162 opportunities to mistype one; listing the 23 that differ makes the
 * interesting cases readable and reviewable, and the default explicit.
 *
 * ══ What this is NOT ════════════════════════════════════════════════════════
 *
 * Not the storage precision. `numeric(28,10)` and the BigInt engine are
 * unchanged and stay exact — see `money.ts`. This governs only how many
 * decimals a POSTED amount is permitted to carry, which is a property of the
 * currency, not of the arithmetic.
 */

/** ISO 4217 minor units for every currency that is not the usual two. */
const MINOR_UNIT_EXCEPTIONS: Readonly<Record<string, number>> = {
  // Three decimals — the Gulf and North African dinars, and the Iraqi dinar.
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,

  // Zero decimals — currencies with no minor unit in practical circulation.
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
};

/**
 * The assumption for a currency this table does not name.
 *
 * Deliberately the same value, and the same reasoning, as the browser's
 * `FALLBACK_MONETARY_DECIMALS`: an organization-defined custom currency the
 * server has no metadata for is treated as an ordinary two-decimal currency
 * rather than refused, because refusing would make its books unpostable.
 */
export const FALLBACK_MONETARY_DECIMALS = 2;

/** Every currency this module states a non-default precision for. */
export function knownPrecisionExceptions(): Readonly<Record<string, number>> {
  return MINOR_UNIT_EXCEPTIONS;
}

/**
 * Monetary decimal places for a currency code. JOD 3, USD 2, JPY 0.
 */
export function monetaryDecimalsFor(code: string | null | undefined): number {
  const normalized = (code ?? '').trim().toUpperCase();
  const exception = MINOR_UNIT_EXCEPTIONS[normalized];
  return exception === undefined ? FALLBACK_MONETARY_DECIMALS : exception;
}

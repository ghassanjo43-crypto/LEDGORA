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

/**
 * Render a stored figure at a currency's own precision.
 *
 * ── Why this exists, and why it lives here ───────────────────────────────────
 * Storage is `numeric(28,10)` and stays exact — that scale is what keeps the
 * arithmetic exact. But PostgreSQL returns every one of those decimals, so a
 * figure comes back as `100.0000000000`, and a document showing that to a
 * customer is not a document anyone would send.
 *
 * Precision is a POSTING rule on this server and a rendering rule here, and the
 * two are deliberately separate. This is the rendering side, and it is one
 * function rather than a copy per service: the invoice, the receipt and the
 * inventory reports must agree about what JPY looks like, and three private
 * copies is how they stop agreeing.
 *
 * ── Why it will not hide a digit ─────────────────────────────────────────────
 * Trailing zeros are dropped only down to `decimals`, never past a digit that
 * is not zero. Posting refuses an over-precise amount, so one should never
 * exist; if it somehow does, showing it is the honest failure. Rounding it away
 * would display a figure nobody wrote and make the discrepancy invisible.
 *
 * A zero-decimal currency therefore renders as a whole number: JPY `1234`, USD
 * `1234.00`, JOD `1234.000`.
 */
export function renderAmount(value: unknown, decimals: number): string {
  const text = String(value ?? '').trim();
  if (text === '') return '';
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.');

  const floor = Math.max(0, Math.trunc(decimals));
  let end = fraction.length;
  while (end > floor && fraction[end - 1] === '0') end -= 1;
  const kept = fraction.slice(0, end).padEnd(Math.min(floor, fraction.length), '0');

  /* Negative zero is still zero, and "-0.000" reads as an error rather than a
   * balance. */
  const body = `${whole}${kept.length > 0 ? `.${kept}` : ''}`;
  if (negative && !/[1-9]/.test(body)) return body;
  return `${negative ? '-' : ''}${body}`;
}

/** Quantities are rendered the same way, at the unit's precision rather than a currency's. */
export const renderQuantity = renderAmount;

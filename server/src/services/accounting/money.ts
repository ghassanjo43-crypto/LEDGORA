/**
 * Exact decimal arithmetic for the accounting engine.
 *
 * ══ Why not `number` ═════════════════════════════════════════════════════════
 *
 * `0.1 + 0.2 !== 0.3` is a curiosity in most software and a defect in a ledger:
 * a trial balance that is out by 1e-17 does not balance, and an entry that does
 * not balance cannot be posted. Worse, the error is silent and cumulative — it
 * appears only once enough lines have been added, by which time the books are
 * already wrong.
 *
 * So money never becomes a JavaScript number anywhere in this engine. Values
 * arrive as strings, are parsed into BigInt fixed-point, are compared and summed
 * as BigInt, and are handed back to PostgreSQL as strings. `numeric` in, string
 * out — node-postgres already returns NUMERIC as a string precisely so callers
 * cannot lose precision by accident, and this module keeps that promise instead
 * of undoing it with a `Number()` at the boundary.
 *
 * ══ Scale ═══════════════════════════════════════════════════════════════════
 *
 * Everything is normalised to {@link SCALE} fractional digits, matching the
 * `numeric(28,10)` columns. Ten is chosen because minor units belong to the
 * CURRENCY — JOD and KWD have three, not two — and a rate-converted functional
 * amount needs more headroom than the currency it came from.
 */

/** Fractional digits carried internally; matches `numeric(28,10)`. */
export const SCALE = 10;
const FACTOR = 10n ** BigInt(SCALE);

export class MoneyError extends Error {}

/** A decimal amount held exactly, as scaled BigInt units. */
export type Amount = bigint;

const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Parse a decimal string (or a safe integer) into exact units.
 *
 * Rejects anything that is not plainly a decimal — no exponents, no `Infinity`,
 * no empty string silently becoming zero. An unparseable amount in an
 * accounting API is a bug in the caller, and guessing zero would post it.
 */
export function toAmount(value: string | number | null | undefined, field = 'amount'): Amount {
  if (value === null || value === undefined || value === '') return 0n;
  const text = typeof value === 'number' ? String(value) : value.trim();
  if (!DECIMAL.test(text)) throw new MoneyError(`${field} is not a valid decimal amount: "${text}"`);

  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  if (fraction.length > SCALE) {
    throw new MoneyError(`${field} carries more than ${SCALE} decimal places: "${text}"`);
  }
  const padded = (fraction + '0'.repeat(SCALE)).slice(0, SCALE);
  const units = BigInt(whole || '0') * FACTOR + BigInt(padded || '0');
  return negative ? -units : units;
}

/** Render exact units back to a decimal string PostgreSQL will accept. */
export function toDecimalString(amount: Amount): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const whole = abs / FACTOR;
  const fraction = (abs % FACTOR).toString().padStart(SCALE, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export const ZERO: Amount = 0n;

export function add(a: Amount, b: Amount): Amount {
  return a + b;
}

export function sum(values: readonly Amount[]): Amount {
  return values.reduce((total, value) => total + value, 0n);
}

export function isZero(amount: Amount): boolean {
  return amount === 0n;
}

export function isNegative(amount: Amount): boolean {
  return amount < 0n;
}

export function isPositive(amount: Amount): boolean {
  return amount > 0n;
}

export function equals(a: Amount, b: Amount): boolean {
  return a === b;
}

/**
 * Multiply an amount by a rate, both exact, rounding half-up at {@link SCALE}.
 *
 * Used to translate a transaction amount into the functional currency. Rounding
 * has to happen somewhere — the product of two 10-digit decimals has twenty —
 * and half-up at the storage scale is the convention the rest of Ledgora's
 * money code already uses.
 */
export function multiply(amount: Amount, rate: Amount): Amount {
  const product = amount * rate; // scale 2 * SCALE
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const half = FACTOR / 2n;
  const rounded = (abs + half) / FACTOR;
  return negative ? -rounded : rounded;
}

/**
 * Does this amount carry more decimal places than `decimals` allows?
 *
 * Asked of the exact BigInt value rather than of any text, so it cannot be
 * fooled by formatting: an amount is within a currency's precision exactly when
 * it is a whole multiple of that currency's smallest unit. JOD allows 3, so
 * 100.1230000000 is a multiple of 10^7 scale-units and 100.1234000000 is not.
 *
 * Note what this does NOT do: it does not round, and it does not alter the
 * value. Storage stays at full SCALE and stays exact — this only answers a
 * question about the number.
 */
export function exceedsPrecision(amount: Amount, decimals: number): boolean {
  const allowed = Math.max(0, Math.min(SCALE, Math.trunc(decimals)));
  const unit = 10n ** BigInt(SCALE - allowed);
  return amount % unit !== 0n;
}

/** Format for a human-readable message. Never used for arithmetic. */
export function describe(amount: Amount): string {
  return toDecimalString(amount).replace(/0+$/, '').replace(/\.$/, '');
}

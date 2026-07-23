/**
 * Decimal-safe monetary arithmetic — the single numeric core of the Currency
 * Master. Values are decimal STRINGS (e.g. "1234.568", "-0.00012346"); the
 * implementation is scaled-BigInt fixed point, so no binary floating-point ever
 * touches an accounting amount. Supports 0–18+ decimal places (JPY 0, USD 2,
 * JOD/KWD 3, BTC 8, custom tokens up to 18).
 *
 * Rounding semantics (accounting convention):
 *   half-up        ties away from zero        (2.5 → 3, -2.5 → -3)
 *   half-down      ties toward zero           (2.5 → 2, -2.5 → -2)
 *   half-even      banker's rounding          (2.5 → 2, 3.5 → 4)
 *   toward-zero    truncate                   (2.9 → 2, -2.9 → -2)
 *   away-from-zero any remainder rounds out   (2.1 → 3, -2.1 → -3)
 *   floor          toward −∞                  (-2.1 → -3)
 *   ceiling        toward +∞                  ( 2.1 → 3)
 */

export type RoundingMethod =
  | 'half-up'
  | 'half-down'
  | 'half-even'
  | 'toward-zero'
  | 'away-from-zero'
  | 'floor'
  | 'ceiling';

export const ROUNDING_METHODS: RoundingMethod[] = [
  'half-up', 'half-down', 'half-even', 'toward-zero', 'away-from-zero', 'floor', 'ceiling',
];

/** A parsed fixed-point value: value = units / 10^scale. */
interface Fixed {
  units: bigint;
  scale: number;
}

const TEN = 10n;

function pow10(n: number): bigint {
  let r = 1n;
  for (let i = 0; i < n; i++) r *= TEN;
  return r;
}

/** Expand JS-number exponent notation ("1e-7") into a plain decimal string. */
function expandExponent(s: string): string {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(s);
  if (!m) return s;
  const sign = m[1] === '-' ? '-' : '';
  const int = m[2] ?? '';
  const frac = m[3] ?? '';
  const exp = Number(m[4]);
  const digits = (int + frac).replace(/^0+(?=\d)/, '') || '0';
  const point = int.length + exp;
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** Parse a decimal string or number; null when not a finite decimal. */
function parseFixed(input: string | number): Fixed | null {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return parseFixed(expandExponent(String(input)));
  }
  const s = expandExponent(input.trim());
  const m = /^([+-]?)(\d+)(?:\.(\d*))?$|^([+-]?)\.(\d+)$/.exec(s);
  if (!m) return null;
  const sign = (m[1] ?? m[4]) === '-' ? -1n : 1n;
  const intPart = m[2] ?? '0';
  const fracPart = m[3] ?? m[5] ?? '';
  const scale = fracPart.length;
  const units = sign * BigInt(intPart + fracPart);
  return { units, scale };
}

/** Render a Fixed back to a canonical decimal string at its own scale. */
function renderFixed(v: Fixed): string {
  const neg = v.units < 0n;
  const abs = neg ? -v.units : v.units;
  const digits = abs.toString().padStart(v.scale + 1, '0');
  const cut = digits.length - v.scale;
  const intPart = digits.slice(0, cut);
  const fracPart = digits.slice(cut);
  const body = v.scale > 0 ? `${intPart}.${fracPart}` : intPart;
  return neg && abs !== 0n ? `-${body}` : body;
}

/** Rescale (exactly, no rounding) up to a target scale ≥ current. */
function rescaleUp(v: Fixed, scale: number): Fixed {
  if (scale <= v.scale) return v;
  return { units: v.units * pow10(scale - v.scale), scale };
}

/** Align two values to a common scale. */
function align(a: Fixed, b: Fixed): [Fixed, Fixed] {
  const scale = Math.max(a.scale, b.scale);
  return [rescaleUp(a, scale), rescaleUp(b, scale)];
}

/** Divide units by divisor applying a rounding method (divisor > 0). */
function divRound(units: bigint, divisor: bigint, method: RoundingMethod): bigint {
  const q = units / divisor;
  const r = units % divisor;
  if (r === 0n) return q;
  const neg = units < 0n;
  const absR2 = (r < 0n ? -r : r) * 2n;
  switch (method) {
    case 'toward-zero':
      return q;
    case 'away-from-zero':
      return neg ? q - 1n : q + 1n;
    case 'floor':
      return neg ? q - 1n : q;
    case 'ceiling':
      return neg ? q : q + 1n;
    case 'half-up':
      return absR2 >= divisor ? (neg ? q - 1n : q + 1n) : q;
    case 'half-down':
      return absR2 > divisor ? (neg ? q - 1n : q + 1n) : q;
    case 'half-even': {
      if (absR2 > divisor) return neg ? q - 1n : q + 1n;
      if (absR2 < divisor) return q;
      return q % 2n === 0n ? q : neg ? q - 1n : q + 1n;
    }
  }
}

function mustParse(input: string | number, label = 'value'): Fixed {
  const v = parseFixed(input);
  if (!v) throw new Error(`Invalid decimal ${label}: "${input}"`);
  return v;
}

/* ── Public API (decimal strings in, decimal strings out) ─────────────────── */

/** True when the input parses as a finite decimal. */
export function isDecimal(input: string | number): boolean {
  return parseFixed(input) !== null;
}

/** Canonical decimal string (no exponent, no leading '+', "-0" → "0"). */
export function decNormalize(input: string | number): string {
  return renderFixed(mustParse(input));
}

export function decAdd(a: string | number, b: string | number): string {
  const [x, y] = align(mustParse(a), mustParse(b));
  return renderFixed({ units: x.units + y.units, scale: x.scale });
}

export function decSub(a: string | number, b: string | number): string {
  const [x, y] = align(mustParse(a), mustParse(b));
  return renderFixed({ units: x.units - y.units, scale: x.scale });
}

export function decMul(a: string | number, b: string | number): string {
  const x = mustParse(a);
  const y = mustParse(b);
  return renderFixed({ units: x.units * y.units, scale: x.scale + y.scale });
}

/** Divide to `scale` decimal places using `method` (default half-up). */
export function decDiv(a: string | number, b: string | number, scale = 18, method: RoundingMethod = 'half-up'): string {
  const x = mustParse(a);
  const y = mustParse(b);
  if (y.units === 0n) throw new Error('Division by zero.');
  // numerator scaled so the quotient carries `scale` fractional digits.
  const numerator = x.units * pow10(y.scale + scale);
  const denominator = y.units * pow10(x.scale);
  const negDen = denominator < 0n;
  const units = divRound(negDen ? -numerator : numerator, negDen ? -denominator : denominator, method);
  return renderFixed({ units, scale });
}

/** -1 | 0 | 1 comparison. */
export function decCmp(a: string | number, b: string | number): -1 | 0 | 1 {
  const [x, y] = align(mustParse(a), mustParse(b));
  return x.units < y.units ? -1 : x.units > y.units ? 1 : 0;
}

export function decIsZero(a: string | number): boolean {
  return mustParse(a).units === 0n;
}

export function decNeg(a: string | number): string {
  const v = mustParse(a);
  return renderFixed({ units: -v.units, scale: v.scale });
}

export function decAbs(a: string | number): string {
  const v = mustParse(a);
  return renderFixed({ units: v.units < 0n ? -v.units : v.units, scale: v.scale });
}

/** Round to `decimals` places with `method`; result keeps exactly `decimals` digits. */
export function decRound(input: string | number, decimals: number, method: RoundingMethod = 'half-up'): string {
  const d = Math.max(0, Math.trunc(decimals));
  const v = mustParse(input);
  if (v.scale <= d) return renderFixed(rescaleUp(v, d));
  const units = divRound(v.units, pow10(v.scale - d), method);
  return renderFixed({ units, scale: d });
}

/**
 * Round to the nearest multiple of `increment` (e.g. cash rounding to 0.05),
 * then re-round to `decimals` for presentation. Increment must be > 0.
 */
export function decRoundToIncrement(
  input: string | number,
  increment: string | number,
  decimals: number,
  method: RoundingMethod = 'half-up',
): string {
  const inc = mustParse(increment);
  if (inc.units <= 0n) return decRound(input, decimals, method);
  const steps = decDiv(input, renderFixed(inc), 0, method);
  return decRound(decMul(steps, renderFixed(inc)), decimals, method);
}

/** Fixed-decimal string with exactly `decimals` places (rounds half-up). */
export function decToFixed(input: string | number, decimals: number, method: RoundingMethod = 'half-up'): string {
  return decRound(input, decimals, method);
}

/**
 * Bridge back to a JS number for legacy numeric call sites. High-precision
 * values (many significant digits) may lose precision here — persistence and
 * comparison paths must stay on the string API.
 */
export function decToNumber(input: string | number): number {
  return Number(decNormalize(input));
}

/** Sum a list of decimal values. */
export function decSum(values: Array<string | number>): string {
  return values.reduce<string>((acc, v) => decAdd(acc, v), '0');
}

/**
 * Sales tax arithmetic, in exact decimals.
 *
 * ══ Why this is not the browser's tax engine ═════════════════════════════════
 *
 * `src/lib/taxCalculations.ts` does all of this in JavaScript `number`, with a
 * `+ Number.EPSILON` nudge in its rounding to paper over float drift. That is
 * survivable for a figure on a screen and not survivable for the figure on a
 * tax document: a tax authority holds a copy, and "the float landed a fils low"
 * is not a defence. Everything here is BigInt at {@link Money.SCALE}, and the
 * only rounding is explicit and at the currency's precision.
 *
 * ══ What a category means to the arithmetic ══════════════════════════════════
 *
 * Three of the five categories charge nothing, and they are NOT interchangeable
 * (§15). The difference does not show up in the tax amount — it is zero for all
 * three — it shows up in what is reported, which is why the category is frozen
 * on the line rather than inferred later from a zero. `reportableBase` is the
 * one arithmetic consequence: an out-of-scope supply is outside the regime, so
 * its base belongs in no return at all, while zero-rated and exempt bases are
 * reported and merely bear no tax.
 */
import type { SalesTaxCategory, SalesTaxMethod } from '../../db/schema.js';
import * as Money from './money.js';

/** Categories that report a base but never touch a tax account. */
const ZERO_TAX: readonly SalesTaxCategory[] = ['zero-rated', 'exempt', 'out-of-scope'];
/** Categories outside the regime entirely — no reportable base. */
const NON_REPORTABLE: readonly SalesTaxCategory[] = ['out-of-scope'];

export function chargesTax(category: SalesTaxCategory): boolean {
  return !ZERO_TAX.includes(category);
}

export function reportsBase(category: SalesTaxCategory): boolean {
  return !NON_REPORTABLE.includes(category);
}

/**
 * The rate actually applied.
 *
 * A zero-tax category forces zero even when the code carries a rate, so a
 * mis-configured exempt code at 16% cannot charge tax. The stored rate is left
 * alone — the snapshot records what the code said, and this records what was
 * applied.
 */
export function effectiveRate(rate: Money.Amount, category: SalesTaxCategory): Money.Amount {
  return chargesTax(category) ? rate : Money.ZERO;
}

export interface TaxLineResult {
  /** The base tax is charged on, at the currency's precision. */
  taxableAmount: Money.Amount;
  taxAmount: Money.Amount;
  /** taxable + tax. For inclusive this equals the line amount that came in. */
  grossAmount: Money.Amount;
  reportableBase: boolean;
}

/** A percentage as an exact amount — 16% arrives as `Money.toAmount('16')`. */
const HUNDRED = Money.toAmount('100');

/**
 * Exclusive: tax is added on top of the net.
 *
 *   net = line amount            tax = net × rate / 100      gross = net + tax
 *
 * Both results are rounded to the currency, because both are figures a customer
 * pays and a receipt has to clear to zero.
 */
export function calculateExclusive(
  net: Money.Amount,
  rate: Money.Amount,
  decimals: number,
): { taxableAmount: Money.Amount; taxAmount: Money.Amount; grossAmount: Money.Amount } {
  const taxableAmount = Money.roundTo(net, decimals);
  /*
   * `multiply` rounds at SCALE, which is ten digits — far finer than any
   * currency — so this is exact for every rate the CHECK allows. The visible
   * rounding is the explicit one that follows.
   */
  const raw = divideByHundred(Money.multiply(taxableAmount, rate));
  const taxAmount = Money.roundTo(raw, decimals);
  return { taxableAmount, taxAmount, grossAmount: Money.add(taxableAmount, taxAmount) };
}

/**
 * Inclusive: the tax is already inside the amount shown.
 *
 *   net = gross / (1 + rate/100)      tax = gross − net
 *
 * The tax is taken as the REMAINDER rather than computed independently, which
 * is what keeps the identity exact: net + tax is the gross the customer was
 * quoted, to the fils, with no adjustment line. Computing both and hoping they
 * add up is how an inclusive invoice ends up a fils away from its own total.
 */
export function calculateInclusive(
  gross: Money.Amount,
  rate: Money.Amount,
  decimals: number,
): { taxableAmount: Money.Amount; taxAmount: Money.Amount; grossAmount: Money.Amount } {
  const grossAmount = Money.roundTo(gross, decimals);
  if (Money.isZero(rate)) {
    return { taxableAmount: grossAmount, taxAmount: Money.ZERO, grossAmount };
  }
  /* net = gross × 100 / (100 + rate), at SCALE, then rounded to the currency. */
  const denominator = Money.add(HUNDRED, rate);
  const netRaw = divideExact(Money.multiply(grossAmount, HUNDRED), denominator);
  const taxableAmount = Money.roundTo(netRaw, decimals);
  return {
    taxableAmount,
    /* The remainder, so the identity holds exactly. */
    taxAmount: grossAmount - taxableAmount,
    grossAmount,
  };
}

export interface TaxLineInput {
  /** Net for exclusive, gross for inclusive — already discounted. */
  lineAmount: Money.Amount;
  rate: Money.Amount;
  category: SalesTaxCategory;
  method: SalesTaxMethod;
  decimals: number;
}

/** One line, honouring its category and method. */
export function calculateTaxLine(input: TaxLineInput): TaxLineResult {
  const rate = effectiveRate(input.rate, input.category);
  const amounts = input.method === 'inclusive'
    ? calculateInclusive(input.lineAmount, rate, input.decimals)
    : calculateExclusive(input.lineAmount, rate, input.decimals);
  return { ...amounts, reportableBase: reportsBase(input.category) };
}

/* ══ Division helpers ══════════════════════════════════════════════════════
 *
 * `money.ts` has no divide, because nothing before this needed one: a rate
 * conversion multiplies. Both of these round half away from zero at SCALE, the
 * same convention `multiply` uses, so a value that passes through either is
 * still exact to ten digits before the currency rounding that follows.
 */

const FACTOR = 10n ** BigInt(Money.SCALE);

/** `value / divisor`, where both are scaled amounts. */
function divideExact(value: Money.Amount, divisor: Money.Amount): Money.Amount {
  if (divisor === 0n) throw new Money.MoneyError('Division by zero in tax calculation.');
  const negative = (value < 0n) !== (divisor < 0n);
  const absValue = value < 0n ? -value : value;
  const absDivisor = divisor < 0n ? -divisor : divisor;
  const scaled = absValue * FACTOR;
  const rounded = (scaled + absDivisor / 2n) / absDivisor;
  return negative ? -rounded : rounded;
}

/** `value / 100`, kept separate because a percentage is not a scaled divisor. */
function divideByHundred(value: Money.Amount): Money.Amount {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const rounded = (abs + 50n) / 100n;
  return negative ? -rounded : rounded;
}

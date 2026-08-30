/**
 * Formatting a server figure WITHOUT ever making it a number.
 *
 * The server aggregates in `numeric` and hands back decimal strings so no
 * figure passes through a binary float. `Intl.NumberFormat` takes a number, so
 * using it here would undo that at the last step — and the last step is the one
 * the bookkeeper reads. `Number('1234567.891')` is fine today and wrong at a
 * scale nobody tests, which is the worst shape a money bug can take.
 *
 * So the grouping is done on the STRING: split the sign, group the integer part
 * in threes, keep the fraction exactly as the server sent it. Nothing is
 * rounded here, because the server already rounded to the currency's precision;
 * a second rounding could only disagree with the first.
 */

/** Thousands separators, inserted from the right, on digits only. */
function groupIntegerDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Render a server decimal string for display.
 *
 * `decimals` comes from the snapshot the figure arrived with, not from a
 * browser guess about the company's currency: the two agreeing is the point,
 * and a screen that padded to its own idea of precision would show a fils that
 * the statement does not have.
 */
export function serverAmount(value: string | null | undefined, decimals: number): string {
  if (value === null || value === undefined || value === '') return '';

  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;

  const [rawInteger = '0', rawFraction = ''] = unsigned.split('.');
  const integer = groupIntegerDigits(rawInteger.replace(/^0+(?=\d)/, ''));

  const fraction = decimals > 0 ? rawFraction.padEnd(decimals, '0').slice(0, decimals) : '';
  const body = fraction ? `${integer}.${fraction}` : integer;

  /* Negative zero is still zero, and printing "-0.000" reads as an error. */
  if (negative && /^[0.,]*$/.test(body.replace(/[^\d.,]/g, '')) && !/[1-9]/.test(body)) return body;
  return negative ? `-${body}` : body;
}

/** True when a server figure is zero, decided on the string, not by parsing. */
export function isServerZero(value: string | null | undefined): boolean {
  if (value === null || value === undefined || value === '') return true;
  return !/[1-9]/.test(value);
}

/** Blank for zero, the convention every statement table here already uses. */
export function serverAmountOrBlank(value: string | null | undefined, decimals: number): string {
  return isServerZero(value) ? '' : serverAmount(value, decimals);
}

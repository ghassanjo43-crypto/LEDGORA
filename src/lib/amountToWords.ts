/**
 * Decimal-safe amount-to-words for receipt documents. Not hardcoded to one
 * currency — the major/minor unit names come from a small currency table with a
 * sensible fallback, so "1160.00 JOD" → "One thousand one hundred sixty Jordanian
 * dinars only" and "12.50 USD" → "Twelve US dollars and fifty cents only".
 */

interface CurrencyUnit {
  major: string;
  majorPlural: string;
  minor: string;
  minorPlural: string;
  /** Number of minor units in one major unit (100 for cents, 1000 for fils). */
  minorPerMajor: number;
}

const CURRENCY_UNITS: Record<string, CurrencyUnit> = {
  USD: { major: 'US dollar', majorPlural: 'US dollars', minor: 'cent', minorPlural: 'cents', minorPerMajor: 100 },
  EUR: { major: 'euro', majorPlural: 'euros', minor: 'cent', minorPlural: 'cents', minorPerMajor: 100 },
  GBP: { major: 'pound', majorPlural: 'pounds', minor: 'penny', minorPlural: 'pence', minorPerMajor: 100 },
  JOD: { major: 'Jordanian dinar', majorPlural: 'Jordanian dinars', minor: 'fils', minorPlural: 'fils', minorPerMajor: 1000 },
  AED: { major: 'UAE dirham', majorPlural: 'UAE dirhams', minor: 'fils', minorPlural: 'fils', minorPerMajor: 100 },
  SAR: { major: 'Saudi riyal', majorPlural: 'Saudi riyals', minor: 'halala', minorPlural: 'halalas', minorPerMajor: 100 },
  KWD: { major: 'Kuwaiti dinar', majorPlural: 'Kuwaiti dinars', minor: 'fils', minorPlural: 'fils', minorPerMajor: 1000 },
};

function unitsFor(currency: string): CurrencyUnit {
  const code = (currency || 'USD').toUpperCase();
  return CURRENCY_UNITS[code] ?? { major: code, majorPlural: code, minor: 'cent', minorPlural: 'cents', minorPerMajor: 100 };
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];

function threeDigitsToWords(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds) parts.push(`${ONES[hundreds]} hundred`);
  if (rest) {
    if (rest < 20) parts.push(ONES[rest]!);
    else {
      const t = TENS[Math.floor(rest / 10)]!;
      const o = rest % 10;
      parts.push(o ? `${t}-${ONES[o]}` : t);
    }
  }
  return parts.join(' ');
}

/** Convert a non-negative integer to English words. */
export function integerToWords(value: number): string {
  let n = Math.floor(Math.abs(value));
  if (n === 0) return 'zero';
  const groups: number[] = [];
  while (n > 0) {
    groups.push(n % 1000);
    n = Math.floor(n / 1000);
  }
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]!;
    if (g === 0) continue;
    parts.push(`${threeDigitsToWords(g)}${SCALES[i] ? ` ${SCALES[i]}` : ''}`);
  }
  return parts.join(' ');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Render a monetary amount in words for the given currency.
 * @example amountToWords(1160, 'JOD') // "One thousand one hundred sixty Jordanian dinars only"
 * @example amountToWords(12.5, 'USD') // "Twelve US dollars and fifty cents only"
 */
export function amountToWords(amount: number, currency: string): string {
  const units = unitsFor(currency);
  const negative = amount < 0;
  const abs = Math.abs(Number(amount) || 0);
  const major = Math.floor(abs + 1e-9);
  const minor = Math.round((abs - major) * units.minorPerMajor);

  const majorWords = `${integerToWords(major)} ${major === 1 ? units.major : units.majorPlural}`;
  let text = majorWords;
  if (minor > 0) {
    text += ` and ${integerToWords(minor)} ${minor === 1 ? units.minor : units.minorPlural}`;
  }
  text = `${capitalize(text)} only`;
  return negative ? `Minus ${text}` : text;
}

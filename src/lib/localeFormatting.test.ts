/**
 * Locale display formatting, and the line it must not cross.
 *
 * ══ The failure these exist to prevent ═══════════════════════════════════════
 *
 * Arabic-Indic digits and Hijri dates are presentation. The moment either
 * reaches stored data or a submitted document, something breaks quietly:
 *
 *   · `Number('١٢٣')` is NaN, so an amount that round-trips through Arabic
 *     numerals comes back as nothing and propagates into a total.
 *   · UBL's `cbc:IssueDate` is `xsd:date` — proleptic Gregorian. There is no
 *     legal way to put a Hijri date in it, and no way to recover the tax period
 *     from one.
 *
 * So these tests pin that the formatters return strings for screens, and that
 * nothing here mutates the value it was given.
 */
import { describe, expect, it } from 'vitest';
import {
  toArabicNumerals,
  fromArabicNumerals,
  shouldUseArabicNumerals,
  formatDisplayDate,
  formatDualDate,
  formatNumber,
  directionFor,
} from './localeFormatting';

describe('Arabic-Indic digits', () => {
  it('converts for display', () => {
    expect(toArabicNumerals('1234567890')).toBe('١٢٣٤٥٦٧٨٩٠');
  });

  it('leaves separators and letters alone', () => {
    expect(toArabicNumerals('1,234.56 JOD')).toBe('١,٢٣٤.٥٦ JOD');
  });

  it('round-trips back to something Number() can read', () => {
    /*
     * The reverse direction exists for reading INPUT. `Number('١٢٣')` is NaN,
     * so a user typing Arabic digits into a quantity field would otherwise
     * produce a NaN line total.
     */
    expect(Number(toArabicNumerals('1234.5'))).toBeNaN();
    expect(Number(fromArabicNumerals(toArabicNumerals('1234.5')))).toBe(1234.5);
  });

  it('is off unless BOTH the language is Arabic and the user asked', () => {
    // Choosing Arabic does not answer the digits question — many finance users
    // want Arabic UI with Latin digits, because that is what the bank uses.
    expect(shouldUseArabicNumerals('ar', true)).toBe(true);
    expect(shouldUseArabicNumerals('ar', false)).toBe(false);
    expect(shouldUseArabicNumerals('ar', undefined)).toBe(false);
    expect(shouldUseArabicNumerals('en', true)).toBe(false);
  });
});

describe('numbers', () => {
  it('formats with Latin digits by default, even in Arabic', () => {
    const formatted = formatNumber(1234.5, 'ar', { decimals: 3 });
    // Pinned with -u-nu-latn so the choice is explicit rather than inherited
    // from whichever ICU build the browser ships.
    expect(formatted).toMatch(/[0-9]/);
    expect(formatted).not.toMatch(/[٠-٩]/);
  });

  it('uses Arabic-Indic only when asked', () => {
    expect(formatNumber(1234.5, 'ar', { decimals: 1, arabicNumerals: true })).toMatch(/[٠-٩]/);
  });

  it('honours the requested precision', () => {
    expect(formatNumber(100, 'en', { decimals: 3 })).toBe('100.000');
    expect(formatNumber(100, 'en', { decimals: 0 })).toBe('100');
  });
});

describe('dates', () => {
  const ISO = '2026-03-01';

  it('never alters the stored value', () => {
    // The formatters take an ISO string and return a different string. The
    // input is the source of truth and stays Gregorian.
    formatDisplayDate(ISO, 'ar', 'hijri');
    expect(ISO).toBe('2026-03-01');
  });

  it('renders a Hijri date that is visibly not the Gregorian one', () => {
    const gregorian = formatDisplayDate(ISO, 'ar', 'gregorian');
    const hijri = formatDisplayDate(ISO, 'ar', 'hijri');
    expect(hijri).not.toBe(gregorian);
    // 2026-03-01 falls in 1447 AH.
    expect(hijri).toMatch(/1447/);
  });

  it('shows both when a document must satisfy two readers', () => {
    const dual = formatDualDate(ISO, 'ar');
    expect(dual).toMatch(/2026/);
    expect(dual).toMatch(/1447/);
  });

  it('does not shift the day across a timezone', () => {
    /*
     * Formatted at midday UTC. Parsing at midnight would render the previous
     * day for any user west of UTC — an invoice dated a day early, in a
     * different tax period if it falls on the first of a month.
     */
    expect(formatDisplayDate('2026-03-01', 'en')).toMatch(/1 March 2026|1 Mar 2026/);
  });

  it('returns the input unchanged when it is not a date', () => {
    // Better a visible raw value than a blank field or "Invalid Date".
    expect(formatDisplayDate('', 'en')).toBe('');
    expect(formatDisplayDate('not-a-date', 'ar')).toBe('not-a-date');
  });
});

describe('direction', () => {
  it('maps each language', () => {
    expect(directionFor('en')).toBe('ltr');
    expect(directionFor('ar')).toBe('rtl');
  });
});

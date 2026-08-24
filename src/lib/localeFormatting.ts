/**
 * Locale-aware DISPLAY formatting — and the line it must not cross.
 *
 * ══ The rule everything here obeys ═══════════════════════════════════════════
 *
 * Arabic-Indic digits and Hijri dates are PRESENTATION. They never reach stored
 * data, a journal entry, a UBL document, or anything submitted to a tax
 * authority.
 *
 * This is not stylistic caution. Two concrete failures:
 *
 *   · `Number('١٢٣')` is NaN. A quantity or amount that round-trips through an
 *     Arabic-Indic string comes back as nothing at all, and a line total of NaN
 *     propagates silently into an invoice total.
 *
 *   · A Hijri date is not convertible back to a unique Gregorian date without
 *     knowing the calendar variant, and the variants disagree by a day. An
 *     invoice whose `issueDate` is stored as 1447-09-15 is an invoice whose tax
 *     period cannot be established. UBL's `cbc:IssueDate` is defined as
 *     xsd:date, which is proleptic Gregorian — there is no legal way to put a
 *     Hijri date in it.
 *
 * So every function here takes a real value and returns a STRING for a screen.
 * Nothing parses these back. If you find yourself wanting to, the value you
 * want is the one that was passed in.
 */

export type AppLanguage = 'en' | 'ar';

/* ══ Digits ═══════════════════════════════════════════════════════════════ */

const ARABIC_INDIC = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'] as const;

/**
 * Latin digits to Arabic-Indic, for display only.
 *
 * Deliberately a separate opt-in step rather than something the number
 * formatter does automatically: many Arabic-speaking finance users prefer Latin
 * digits for money precisely because that is what the printed invoice and the
 * bank statement use. See `shouldUseArabicNumerals`.
 */
export function toArabicNumerals(text: string): string {
  return text.replace(/[0-9]/g, (digit) => ARABIC_INDIC[Number(digit)]!);
}

/** Arabic-Indic back to Latin — for reading user INPUT, never for output. */
export function fromArabicNumerals(text: string): string {
  return text.replace(/[٠-٩]/g, (digit) => String(ARABIC_INDIC.indexOf(digit as typeof ARABIC_INDIC[number])));
}

/**
 * Whether to render digits in Arabic-Indic form.
 *
 * Off by default even in Arabic. Turning it on is a user preference, not a
 * consequence of choosing the language, because the two questions genuinely
 * have different answers for different people.
 */
export function shouldUseArabicNumerals(language: AppLanguage, preference: boolean | undefined): boolean {
  return language === 'ar' && preference === true;
}

/* ══ Dates ════════════════════════════════════════════════════════════════ */

export type CalendarPreference = 'gregorian' | 'hijri';

/**
 * Format a stored ISO date for display.
 *
 * `iso` is and remains the source of truth — YYYY-MM-DD, Gregorian, exactly as
 * stored. This produces something to look at and nothing to parse.
 */
export function formatDisplayDate(
  iso: string,
  language: AppLanguage,
  calendar: CalendarPreference = 'gregorian',
  arabicNumerals = false,
): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso;

  // Midday UTC, so a timezone west of UTC cannot roll the date backwards.
  const date = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;

  /*
   * `islamic-umalqura` is the Umm al-Qura calendar used by Saudi Arabia and
   * widely in the region. Other Islamic variants exist and differ by up to a
   * day; this picks one explicitly rather than letting the runtime choose,
   * so two machines do not render the same invoice differently.
   */
  /*
   * `-nu-latn` is pinned for the same reason it is on numbers: `ar-JO` emits
   * Arabic-Indic digits by DEFAULT, so without this a user who turned Arabic
   * numerals off would still get ١٤٤٧ in every date. One place decides digits
   * — the preference below — and the locale never decides it silently.
   */
  const locale = language === 'ar'
    ? (calendar === 'hijri' ? 'ar-JO-u-ca-islamic-umalqura-nu-latn' : 'ar-JO-u-nu-latn')
    : 'en-GB';

  let text: string;
  try {
    text = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
  } catch {
    // An engine without the calendar data must not blank the date.
    return iso;
  }
  return arabicNumerals ? toArabicNumerals(text) : text;
}

/**
 * A date shown with BOTH calendars, for a document that has to satisfy a reader
 * who thinks in one and an auditor who works in the other.
 */
export function formatDualDate(iso: string, language: AppLanguage, arabicNumerals = false): string {
  const gregorian = formatDisplayDate(iso, language, 'gregorian', arabicNumerals);
  const hijri = formatDisplayDate(iso, language, 'hijri', arabicNumerals);
  return gregorian === hijri ? gregorian : `${gregorian} · ${hijri}`;
}

/* ══ Numbers ══════════════════════════════════════════════════════════════ */

/**
 * A number for display.
 *
 * Grouping and decimal separators follow the locale; the DIGITS follow the
 * explicit preference, because `ar` locales in Intl vary in whether they emit
 * Arabic-Indic by default and that variation is not something an invoice should
 * inherit by accident.
 */
export function formatNumber(
  value: number,
  language: AppLanguage,
  options: { decimals?: number; arabicNumerals?: boolean } = {},
): string {
  const decimals = options.decimals ?? 2;
  // `-u-nu-latn` pins Latin digits so the choice is made here, once.
  const locale = language === 'ar' ? 'ar-JO-u-nu-latn' : 'en-GB';

  let text: string;
  try {
    text = new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  } catch {
    text = value.toFixed(decimals);
  }

  return options.arabicNumerals ? toArabicNumerals(text) : text;
}

/* ══ Direction ════════════════════════════════════════════════════════════ */

export const DIRECTION: Record<AppLanguage, 'ltr' | 'rtl'> = { en: 'ltr', ar: 'rtl' };

export function directionFor(language: AppLanguage): 'ltr' | 'rtl' {
  return DIRECTION[language];
}

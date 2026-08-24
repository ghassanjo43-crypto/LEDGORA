/**
 * The chosen language, its direction, and the two display preferences that ride
 * with it.
 *
 * ── Why direction lives here and not in CSS ──────────────────────────────────
 * `dir` has to be an attribute on a real element for the browser's bidirectional
 * algorithm to run. A stylesheet cannot supply it, and `direction: rtl` in CSS
 * moves text but does not reorder the neutral characters inside it — so
 * "Invoice INV-2026-0001 (JOD 232.000)" comes out with the brackets and digits
 * in the wrong places. Setting `dir` on `<html>` is the only thing that gets
 * that right, and this context is what sets it.
 *
 * ── Why numerals and calendar are separate from language ─────────────────────
 * Choosing Arabic does not tell you whether someone wants ١٢٣ or 123, or Hijri
 * or Gregorian dates. Many finance users want Arabic UI with Latin digits and
 * Gregorian dates, because that is what the bank statement and the tax return
 * use. Bundling the three would take that choice away.
 *
 * Both are DISPLAY preferences. See `lib/localeFormatting` for why neither may
 * reach stored data.
 */
import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { initI18n, isSupportedLanguage, type SupportedLanguage } from '@/i18n';
import { directionFor, type CalendarPreference } from '@/lib/localeFormatting';

const STORAGE_KEY = 'ledgora:language';
const NUMERALS_KEY = 'ledgora:arabic-numerals';
const CALENDAR_KEY = 'ledgora:calendar';

export interface LanguageContextValue {
  language: SupportedLanguage;
  direction: 'ltr' | 'rtl';
  isRtl: boolean;
  arabicNumerals: boolean;
  calendar: CalendarPreference;
  setLanguage: (language: SupportedLanguage) => void;
  setArabicNumerals: (enabled: boolean) => void;
  setCalendar: (calendar: CalendarPreference) => void;
}

export const LanguageContext = createContext<LanguageContextValue | null>(null);

/** Read a stored preference without letting a bad value break start-up. */
function read<T>(key: string, fallback: T, parse: (raw: string) => T | null): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return parse(raw) ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /*
     * A private-mode browser refuses writes. The choice still applies for this
     * session — losing it on reload is a far smaller problem than refusing to
     * change language at all.
     */
  }
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<SupportedLanguage>(() =>
    read<SupportedLanguage>(STORAGE_KEY, 'en', (raw) => (isSupportedLanguage(raw) ? raw : null)),
  );
  const [arabicNumerals, setArabicNumeralsState] = useState<boolean>(() =>
    read(NUMERALS_KEY, false, (raw) => raw === 'true'),
  );
  const [calendar, setCalendarState] = useState<CalendarPreference>(() =>
    read<CalendarPreference>(CALENDAR_KEY, 'gregorian', (raw) =>
      raw === 'hijri' || raw === 'gregorian' ? raw : null),
  );

  // Initialise i18next once, at the language already chosen, so the first paint
  // is not English text that then flips.
  useMemo(() => initI18n(language), []); // eslint-disable-line react-hooks/exhaustive-deps

  /*
   * `dir` and `lang` go on <html>, not on a wrapper div. The bidi algorithm,
   * form control alignment, and the browser's own UI (spellcheck, context menu,
   * scrollbar side) all read the document element.
   */
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('lang', language);
    root.setAttribute('dir', directionFor(language));
  }, [language]);

  const setLanguage = useCallback((next: SupportedLanguage) => {
    setLanguageState(next);
    write(STORAGE_KEY, next);
    void initI18n(next);
  }, []);

  const setArabicNumerals = useCallback((enabled: boolean) => {
    setArabicNumeralsState(enabled);
    write(NUMERALS_KEY, String(enabled));
  }, []);

  const setCalendar = useCallback((next: CalendarPreference) => {
    setCalendarState(next);
    write(CALENDAR_KEY, next);
  }, []);

  const value = useMemo<LanguageContextValue>(
    () => ({
      language,
      direction: directionFor(language),
      isRtl: directionFor(language) === 'rtl',
      // Arabic-Indic digits are meaningless in an English UI, so the preference
      // only takes effect where it makes sense.
      arabicNumerals: language === 'ar' && arabicNumerals,
      calendar,
      setLanguage,
      setArabicNumerals,
      setCalendar,
    }),
    [language, arabicNumerals, calendar, setLanguage, setArabicNumerals, setCalendar],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

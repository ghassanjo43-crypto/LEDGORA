/**
 * The language, its direction, and formatters already bound to both.
 *
 * Components should reach for `formatNumber`/`formatDate` from here rather than
 * calling `lib/localeFormatting` directly, so the numeral and calendar
 * preferences cannot be forgotten at one call site and honoured at another.
 */
import { useContext, useMemo } from 'react';
import { LanguageContext, type LanguageContextValue } from '@/contexts/LanguageContext';
import { formatDisplayDate, formatDualDate, formatNumber } from '@/lib/localeFormatting';

export interface UseLanguage extends LanguageContextValue {
  /** A number for display, honouring the numeral preference. */
  formatNumber: (value: number, decimals?: number) => string;
  /** A stored ISO date for display, honouring the calendar preference. */
  formatDate: (iso: string) => string;
  /** Both calendars, for a document an auditor and a customer both read. */
  formatDualDate: (iso: string) => string;
}

export function useLanguage(): UseLanguage {
  const context = useContext(LanguageContext);
  if (!context) {
    /*
     * Thrown rather than defaulted. A silent English fallback would look like a
     * missing translation and send someone hunting through JSON files for a key
     * that is present, when the real fault is a missing provider.
     */
    throw new Error('useLanguage must be used inside <LanguageProvider>.');
  }

  const { language, arabicNumerals, calendar } = context;

  return useMemo(
    () => ({
      ...context,
      formatNumber: (value: number, decimals?: number) =>
        formatNumber(value, language, { decimals, arabicNumerals }),
      formatDate: (iso: string) => formatDisplayDate(iso, language, calendar, arabicNumerals),
      formatDualDate: (iso: string) => formatDualDate(iso, language, arabicNumerals),
    }),
    [context, language, arabicNumerals, calendar],
  );
}

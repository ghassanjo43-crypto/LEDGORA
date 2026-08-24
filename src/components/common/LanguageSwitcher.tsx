/**
 * The EN / ع toggle.
 *
 * ── Why each label is in its own language ────────────────────────────────────
 * "English" and "العربية", never "English" and "Arabic". Someone who cannot
 * read the current interface language needs to recognise their own — and a
 * person looking for Arabic is looking for the Arabic word, not the English one
 * they may not be able to read.
 *
 * Implemented as a radio group rather than a single toggling button: a button
 * labelled "ع" is ambiguous about whether it means "you are in Arabic" or
 * "switch to Arabic", and a screen reader announces nothing to disambiguate it.
 * A radio group announces both options and which is current.
 */
import { useTranslation } from 'react-i18next';
import { useLanguage } from '@/hooks/useLanguage';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '@/i18n';
import { cn } from '@/lib/utils';

/** Each language names itself, in itself. */
const SELF_LABEL: Record<SupportedLanguage, { short: string; full: string }> = {
  en: { short: 'EN', full: 'English' },
  ar: { short: 'ع', full: 'العربية' },
};

export function LanguageSwitcher({ className }: { className?: string }) {
  const { language, setLanguage } = useLanguage();
  const { t } = useTranslation('common');

  return (
    <div
      role="radiogroup"
      aria-label={t('language.label')}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg border border-slate-200 p-0.5 dark:border-slate-700',
        className,
      )}
    >
      {SUPPORTED_LANGUAGES.map((code) => {
        const selected = code === language;
        return (
          <button
            key={code}
            type="button"
            role="radio"
            aria-checked={selected}
            /*
             * The accessible name is the language's own name, so a screen
             * reader in either language announces something recognisable.
             * `lang` on the element tells the speech engine which voice to use
             * — without it "العربية" is read as English gibberish.
             */
            lang={code}
            aria-label={SELF_LABEL[code].full}
            title={selected ? SELF_LABEL[code].full : t('language.switchTo', { language: SELF_LABEL[code].full })}
            onClick={() => setLanguage(code)}
            className={cn(
              'focus-ring min-w-[2rem] rounded-md px-2 py-1 text-xs font-semibold transition-colors',
              selected
                ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200'
                : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800',
            )}
          >
            {SELF_LABEL[code].short}
          </button>
        );
      })}
    </div>
  );
}

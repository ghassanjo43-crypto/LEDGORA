/**
 * i18next configuration.
 *
 * ── Bundled, not fetched ─────────────────────────────────────────────────────
 * Translations are imported rather than loaded over HTTP. Ledgora's books live
 * in the browser and the app is expected to work on a poor connection; a
 * language pack that arrives late leaves the user reading translation KEYS, and
 * one that never arrives leaves the app unusable in the language they chose.
 * Two languages of UI text is a few kilobytes — not worth a network request.
 *
 * ── Missing keys fall back to English, loudly in development ─────────────────
 * `saveMissing` is off (there is no backend to save to), but the dev console
 * warns. A key that silently renders as `invoices.lineItems.qty` is the failure
 * mode of every half-finished translation, and it should be noisy while there
 * is still a chance to fix it.
 */
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import enCommon from '@/locales/en/common.json';
import enInvoices from '@/locales/en/invoices.json';
import arCommon from '@/locales/ar/common.json';
import arInvoices from '@/locales/ar/invoices.json';
import enAuth from '@/locales/en/auth.json';
import arAuth from '@/locales/ar/auth.json';
import enOnboarding from '@/locales/en/onboarding.json';
import arOnboarding from '@/locales/ar/onboarding.json';

export const SUPPORTED_LANGUAGES = ['en', 'ar'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const NAMESPACES = ['common', 'invoices', 'auth', 'onboarding'] as const;

export const resources = {
  en: { common: enCommon, invoices: enInvoices, auth: enAuth, onboarding: enOnboarding },
  ar: { common: arCommon, invoices: arInvoices, auth: arAuth, onboarding: arOnboarding },
} as const;

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

let initialised = false;

export function initI18n(language: SupportedLanguage = 'en'): typeof i18next {
  if (initialised) {
    if (i18next.language !== language) void i18next.changeLanguage(language);
    return i18next;
  }

  void i18next.use(initReactI18next).init({
    resources,
    lng: language,
    fallbackLng: 'en',
    ns: NAMESPACES,
    defaultNS: 'common',
    interpolation: {
      // React escapes for us; double-escaping turns an apostrophe into &#39;.
      escapeValue: false,
    },
    // A key rendered as its own path is the signature of a half-done
    // translation. Say so while somebody can still act on it.
    saveMissing: false,
    missingKeyHandler: (_lngs, ns, key) => {
      if (import.meta.env?.DEV) {
        console.warn(`[i18n] missing translation: ${ns}:${key}`);
      }
    },
    react: { useSuspense: false },
  });

  initialised = true;
  return i18next;
}

export { i18next };

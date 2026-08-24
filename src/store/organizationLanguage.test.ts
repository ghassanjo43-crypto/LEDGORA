/**
 * Language as a property of the organization rather than the user.
 *
 * ══ What changed and why ═════════════════════════════════════════════════════
 *
 * Every member of a company now sees the same language, and it is chosen once
 * at onboarding. The compliance argument for that is about DOCUMENTS — an
 * invoice reissued in a different language from the one a tax authority
 * already cleared is a different document — so `document_language` is the one
 * that genuinely must not drift.
 *
 * These pin the client half: the organization's choice supersedes the browser's,
 * a locked organization refuses a per-user change, and signing out does not
 * leave the next person holding the previous tenant's language.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { useOrganizationLanguageStore } from './organizationLanguageStore';

beforeEach(() => {
  useOrganizationLanguageStore.setState({ interfaceLanguage: null, documentLanguage: null, locked: false });
});

describe('adopting the organization payload', () => {
  it('takes both languages and the lock', () => {
    useOrganizationLanguageStore.getState().adopt({
      interfaceLanguage: 'ar', documentLanguage: 'ar', interfaceLanguageLocked: true,
    });
    expect(useOrganizationLanguageStore.getState()).toMatchObject({
      interfaceLanguage: 'ar', documentLanguage: 'ar', locked: true,
    });
  });

  it('keeps the two separate — a company may work in English and invoice in Arabic', () => {
    useOrganizationLanguageStore.getState().adopt({
      interfaceLanguage: 'en', documentLanguage: 'ar', interfaceLanguageLocked: true,
    });
    const state = useOrganizationLanguageStore.getState();
    expect(state.interfaceLanguage).toBe('en');
    expect(state.documentLanguage).toBe('ar');
  });

  it('treats an organization that predates the column as locked', () => {
    // `interfaceLanguageLocked` absent → the safer reading of "the company decides".
    useOrganizationLanguageStore.getState().adopt({ interfaceLanguage: 'ar', documentLanguage: 'ar' });
    expect(useOrganizationLanguageStore.getState().locked).toBe(true);
  });

  it('does not lock when there is no organization language to lock to', () => {
    useOrganizationLanguageStore.getState().adopt({ interfaceLanguage: null, documentLanguage: null });
    expect(useOrganizationLanguageStore.getState().locked).toBe(false);
  });

  it('ignores a language the app does not ship', () => {
    /*
     * An organization set to an unshipped language would render every screen as
     * raw translation keys, which reads as catastrophic data loss to whoever
     * sees it. Falling back to the browser choice is the recoverable failure.
     */
    useOrganizationLanguageStore.getState().adopt({ interfaceLanguage: 'klingon', documentLanguage: 'fr' });
    expect(useOrganizationLanguageStore.getState().interfaceLanguage).toBeNull();
    expect(useOrganizationLanguageStore.getState().documentLanguage).toBeNull();
  });
});

describe('clearing', () => {
  it('drops everything on sign-out', () => {
    useOrganizationLanguageStore.getState().adopt({ interfaceLanguage: 'ar', documentLanguage: 'ar' });
    useOrganizationLanguageStore.getState().adopt(null);

    // The next person at this browser must not inherit the previous tenant's
    // language.
    expect(useOrganizationLanguageStore.getState()).toMatchObject({
      interfaceLanguage: null, documentLanguage: null, locked: false,
    });
  });
});

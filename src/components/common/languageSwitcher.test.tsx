// @vitest-environment happy-dom
/**
 * The language switcher and the direction it drives.
 *
 * ══ What these keep dead ═════════════════════════════════════════════════════
 *
 * `dir` must land on <html>, not on a wrapper. A stylesheet cannot supply it,
 * and `direction: rtl` in CSS moves text without running the bidirectional
 * algorithm over the neutral characters inside it — so an invoice number comes
 * out with its hyphens in the wrong places while every string in memory is
 * correct.
 *
 * The switcher also has to be usable by someone who cannot read the language it
 * is currently displaying, which is the whole point of a language switcher and
 * the thing a plain toggle button gets wrong.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { LanguageSwitcher } from './LanguageSwitcher';
import { useOrganizationLanguageStore } from '@/store/organizationLanguageStore';

function setup() {
  return render(
    <LanguageProvider>
      <LanguageSwitcher />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.removeAttribute('dir');
  document.documentElement.removeAttribute('lang');
  useOrganizationLanguageStore.setState({ interfaceLanguage: null, documentLanguage: null, locked: false });
});

describe('the control', () => {
  it('offers both languages as a radio group', () => {
    setup();
    const group = screen.getByRole('radiogroup');
    expect(group).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('names each language in its own language', () => {
    setup();
    /*
     * "العربية", not "Arabic". Someone who cannot read the current interface
     * language is looking for the word they DO recognise.
     */
    expect(screen.getByRole('radio', { name: 'English' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'العربية' })).toBeTruthy();
  });

  it('marks the current language as checked', () => {
    setup();
    expect(screen.getByRole('radio', { name: 'English' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'العربية' }).getAttribute('aria-checked')).toBe('false');
  });

  it('tags the Arabic option with lang, so speech uses an Arabic voice', () => {
    setup();
    // Without this, a screen reader pronounces "العربية" as English gibberish.
    expect(screen.getByRole('radio', { name: 'العربية' }).getAttribute('lang')).toBe('ar');
  });
});

describe('switching', () => {
  it('puts dir and lang on the document element', () => {
    setup();
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');

    fireEvent.click(screen.getByRole('radio', { name: 'العربية' }));

    /*
     * On <html>, not on a wrapper div: the bidi algorithm, form control
     * alignment and scrollbar placement all read the document element.
     */
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    expect(document.documentElement.getAttribute('lang')).toBe('ar');
  });

  it('moves the checked state', () => {
    setup();
    fireEvent.click(screen.getByRole('radio', { name: 'العربية' }));
    expect(screen.getByRole('radio', { name: 'العربية' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'English' }).getAttribute('aria-checked')).toBe('false');
  });

  it('remembers the choice', () => {
    setup();
    fireEvent.click(screen.getByRole('radio', { name: 'العربية' }));
    expect(window.localStorage.getItem('ledgora:language')).toBe('ar');

    cleanup();
    setup();
    // A language that resets on reload is one the user re-chooses every visit.
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
  });

  it('ignores a stored value that is not a language we ship', () => {
    window.localStorage.setItem('ledgora:language', 'klingon');
    setup();
    // A bad stored value must not leave the app with no translations at all.
    expect(document.documentElement.getAttribute('lang')).toBe('en');
  });
});

describe('when the organization decides', () => {
  it('hides the switcher entirely rather than disabling it', () => {
    useOrganizationLanguageStore.setState({ interfaceLanguage: 'ar', documentLanguage: 'ar', locked: true });
    setup();
    /*
     * A greyed-out control invites the user to hunt for the permission that
     * would enable it. There is none — in this configuration language is not a
     * per-user setting at all.
     */
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it("uses the organization's language, not the one stored in this browser", () => {
    window.localStorage.setItem('ledgora:language', 'en');
    useOrganizationLanguageStore.setState({ interfaceLanguage: 'ar', documentLanguage: 'ar', locked: true });
    setup();
    // Every member of a company sees the same product.
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    expect(document.documentElement.getAttribute('lang')).toBe('ar');
  });

  it('still offers the switcher before sign-in, when no organization is known', () => {
    // Onboarding and login must be readable by someone who has not identified
    // themselves yet, so the browser-level choice governs those surfaces.
    setup();
    expect(screen.getByRole('radiogroup')).toBeTruthy();
  });

  it('allows a per-user choice when the organization has not locked it', () => {
    useOrganizationLanguageStore.setState({ interfaceLanguage: 'en', documentLanguage: 'en', locked: false });
    setup();
    expect(screen.getByRole('radiogroup')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'العربية' }));
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
  });
});

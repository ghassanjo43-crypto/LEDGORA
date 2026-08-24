/**
 * The organization's language, as the client knows it.
 *
 * ── Why this is its own store and not part of the session store ──────────────
 * `LanguageProvider` sits above almost everything, and the session store pulls
 * in the API client, which pulls in config. Reading the language through a
 * small dedicated store keeps that dependency out of the provider and makes the
 * value trivially settable from a test.
 *
 * ── Deliberately NOT persisted ───────────────────────────────────────────────
 * The organization's choice is a server fact. Caching it in localStorage would
 * mean a user who was moved between organizations, or whose administrator
 * changed the language, keeps seeing the old one until something happens to
 * clear the cache — and the whole point of moving language to the organization
 * was that every member sees the same thing. It is re-read from the session on
 * every load, and absent until the server answers.
 */
import { create } from 'zustand';

export type OrganizationLanguage = 'en' | 'ar';

interface OrganizationLanguageState {
  /** Null until the server has said, or when there is no organization. */
  interfaceLanguage: OrganizationLanguage | null;
  documentLanguage: OrganizationLanguage | null;
  /** When true, a member may not choose their own interface language. */
  locked: boolean;

  adopt: (input: {
    interfaceLanguage?: string | null;
    documentLanguage?: string | null;
    interfaceLanguageLocked?: boolean | null;
  } | null) => void;
  clear: () => void;
}

const supported = (value: unknown): OrganizationLanguage | null =>
  value === 'en' || value === 'ar' ? value : null;

export const useOrganizationLanguageStore = create<OrganizationLanguageState>()((set) => ({
  interfaceLanguage: null,
  documentLanguage: null,
  locked: false,

  /**
   * Take the organization's languages from a server payload.
   *
   * A null payload means "no organization" — sign-out, or a platform
   * administrator who has none — and clears rather than keeping the last one,
   * so the next person at this browser is not handed the previous tenant's
   * language.
   */
  adopt: (input) => {
    if (!input) {
      set({ interfaceLanguage: null, documentLanguage: null, locked: false });
      return;
    }
    set({
      interfaceLanguage: supported(input.interfaceLanguage),
      documentLanguage: supported(input.documentLanguage),
      // Default true: an organization that predates the column is locked, which
      // is the safer reading of "the company decides".
      locked: input.interfaceLanguageLocked !== false && supported(input.interfaceLanguage) !== null,
    });
  },

  clear: () => set({ interfaceLanguage: null, documentLanguage: null, locked: false }),
}));

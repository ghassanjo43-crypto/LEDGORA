import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Account, BusinessEntity, CompanySettings } from '@/types';
import type { JournalEntry } from '@/types/journal';
import { SEED_ACCOUNTS } from '@/data/seedAccounts';
import { useStore, DEFAULT_SETTINGS } from './useStore';
import { useEntityStore } from './useEntityStore';
import { useJournalStore } from './journalStore';
import { generateId } from '@/lib/utils';

/**
 * A single company's complete books. The ACTIVE company's live data lives in
 * the working stores (accounts, entities, journal); the registry keeps the
 * other companies and a snapshot that is refreshed whenever you switch away.
 */
export interface CompanyBooks {
  id: string;
  settings: CompanySettings;
  accounts: Account[];
  entities: BusinessEntity[];
  entries: JournalEntry[];
}

export interface CompanyActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

function snapshotWorkingStores(): Omit<CompanyBooks, 'id'> {
  return {
    settings: useStore.getState().settings,
    accounts: useStore.getState().accounts,
    entities: useEntityStore.getState().entities,
    entries: useJournalStore.getState().entries,
  };
}

function loadIntoWorkingStores(company: CompanyBooks): void {
  useStore.setState({ accounts: company.accounts, settings: company.settings, collapsedIds: {} });
  useEntityStore.setState({ entities: company.entities });
  useJournalStore.setState({ entries: company.entries });
}

interface CompanyState {
  companies: CompanyBooks[];
  activeCompanyId: string;

  /** Create the first company from the current working stores (run once). */
  ensureInitialized: () => void;
  addCompany: (settings: Partial<CompanySettings> & { companyName: string }, switchTo?: boolean) => CompanyActionResult;
  switchCompany: (id: string) => CompanyActionResult;
  deleteCompany: (id: string) => CompanyActionResult;
  /** Keep the active company's registry snapshot in sync (e.g. after settings save). */
  syncActiveSettings: (settings: CompanySettings) => void;
}

export const useCompanyStore = create<CompanyState>()(
  persist(
    (set, get) => ({
      companies: [],
      activeCompanyId: '',

      ensureInitialized: () => {
        if (get().companies.length > 0 && get().activeCompanyId) return;
        const id = generateId('co');
        set({ companies: [{ id, ...snapshotWorkingStores() }], activeCompanyId: id });
      },

      addCompany: (settings, switchTo = true) => {
        const id = generateId('co');
        const fresh: CompanyBooks = {
          id,
          settings: { ...DEFAULT_SETTINGS, ...settings },
          accounts: SEED_ACCOUNTS.map((a) => ({ ...a })),
          entities: [],
          entries: [],
        };
        // Refresh the current active company's snapshot before adding.
        const { activeCompanyId, companies } = get();
        const withSnapshot = companies.map((c) =>
          c.id === activeCompanyId ? { ...c, ...snapshotWorkingStores() } : c,
        );
        set({ companies: [...withSnapshot, fresh] });
        if (switchTo) {
          loadIntoWorkingStores(fresh);
          set({ activeCompanyId: id });
        }
        return { ok: true, id };
      },

      switchCompany: (targetId) => {
        const { activeCompanyId, companies } = get();
        if (targetId === activeCompanyId) return { ok: true, id: targetId };
        const target = companies.find((c) => c.id === targetId);
        if (!target) return { ok: false, error: 'Company not found.' };
        // Snapshot the company we are leaving, then load the target's books.
        const updated = companies.map((c) =>
          c.id === activeCompanyId ? { ...c, ...snapshotWorkingStores() } : c,
        );
        const fresh = updated.find((c) => c.id === targetId) as CompanyBooks;
        loadIntoWorkingStores(fresh);
        set({ companies: updated, activeCompanyId: targetId });
        return { ok: true, id: targetId };
      },

      deleteCompany: (id) => {
        const { activeCompanyId, companies } = get();
        if (id === activeCompanyId) return { ok: false, error: 'Switch to another company before deleting this one.' };
        if (companies.length <= 1) return { ok: false, error: 'You must keep at least one company.' };
        set({ companies: companies.filter((c) => c.id !== id) });
        return { ok: true };
      },

      syncActiveSettings: (settings) =>
        set((s) => ({
          companies: s.companies.map((c) => (c.id === s.activeCompanyId ? { ...c, settings } : c)),
        })),
    }),
    {
      name: 'ledgerly-companies',
      version: 1,
      partialize: (s) => ({ companies: s.companies, activeCompanyId: s.activeCompanyId }),
    },
  ),
);

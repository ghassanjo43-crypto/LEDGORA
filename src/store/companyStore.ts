import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type { Account, BusinessEntity, CompanySettings } from '@/types';
import type { JournalEntry } from '@/types/journal';
import { SEED_ACCOUNTS } from '@/data/seedAccounts';
import { useStore, DEFAULT_SETTINGS } from './useStore';
import { useEntitlementStore } from './entitlementStore';
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
  /**
   * Whether this entity occupies one of the package's entity slots.
   *
   * Deactivating never destroys books — it sets this false, which frees a slot
   * so another entity can take it. A subscriber on a one-entity package can
   * therefore keep several sets of books and work in one at a time, which is
   * the point: the package limits concurrent use, not history.
   *
   * Optional so a record written before this existed reads as active, which is
   * what it was.
   */
  isActive?: boolean;
  /**
   * When this entity was archived, or absent while it is in ordinary use.
   *
   * Archiving is the step BEFORE deletion, never a synonym for it: the books
   * are intact and restorable, and only an archived entity may be deleted. The
   * platform side already stages destruction this way for organizations —
   * `archived_at` then `deletion_requested_at`, "a purge is requested first and
   * carried out afterwards, never in one click" — and a subscriber's own books
   * deserve no less care than the operator's console gives them.
   */
  archivedAt?: string | null;
}

export type EntityStatus = 'active' | 'inactive' | 'archived';

export interface CompanyActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

/**
 * Written before `isActive` existed? Then it was in use, so it is active.
 *
 * Reading the absent field as `false` would deactivate every existing
 * subscriber's books the moment this shipped.
 */
export function isArchivedEntity(company: Pick<CompanyBooks, 'archivedAt'>): boolean {
  return Boolean(company.archivedAt);
}

export function isActiveEntity(company: Pick<CompanyBooks, 'isActive' | 'archivedAt'>): boolean {
  // An archived entity holds no slot whatever its flag says: archiving frees
  // one, and a restore is what asks for it back.
  return !isArchivedEntity(company) && company.isActive !== false;
}

export function entityStatus(company: Pick<CompanyBooks, 'isActive' | 'archivedAt'>): EntityStatus {
  if (isArchivedEntity(company)) return 'archived';
  return company.isActive === false ? 'inactive' : 'active';
}

export function activeEntityCount(companies: readonly CompanyBooks[]): number {
  return companies.filter(isActiveEntity).length;
}

/** How many entities the package allows to be active at once. */
export function entityAllowance(): number {
  return useEntitlementStore.getState().subscription.entityLimit;
}

export function freeEntitySlots(companies: readonly CompanyBooks[]): number {
  return entityAllowance() - activeEntityCount(companies);
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
  /** Give this entity one of the package's slots. Refused when none is free. */
  activateCompany: (id: string) => CompanyActionResult;
  /** Release this entity's slot. The books are kept, exactly as they are. */
  deactivateCompany: (id: string) => CompanyActionResult;
  /** Retire an entity and free its slot. Reversible, and the gate before deletion. */
  archiveCompany: (id: string) => CompanyActionResult;
  /** Bring an archived entity back, deactivated — activating it is a separate step. */
  restoreCompany: (id: string) => CompanyActionResult;
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

      activateCompany: (id) => {
        const { companies } = get();
        const target = companies.find((c) => c.id === id);
        if (!target) return { ok: false, error: 'Company not found.' };
        if (isArchivedEntity(target)) {
          return { ok: false, error: 'This company is archived. Restore it before activating it.' };
        }
        if (isActiveEntity(target)) return { ok: true, id };
        const free = freeEntitySlots(companies);
        if (free <= 0) {
          return {
            ok: false,
            error: `Your package allows ${entityAllowance()} active ${entityAllowance() === 1 ? 'entity' : 'entities'}. Deactivate another entity or upgrade your package first.`,
          };
        }
        set({ companies: companies.map((c) => (c.id === id ? { ...c, isActive: true } : c)) });
        return { ok: true, id };
      },

      deactivateCompany: (id) => {
        const { companies, activeCompanyId } = get();
        const target = companies.find((c) => c.id === id);
        if (!target) return { ok: false, error: 'Company not found.' };
        if (!isActiveEntity(target)) return { ok: true, id };
        /*
         * Refused for the entity currently open, the same rule `deleteCompany`
         * applies: the books on screen would be the books just deactivated, and
         * every store in memory would still be holding them.
         */
        if (id === activeCompanyId) {
          return { ok: false, error: 'Switch to another company before deactivating this one.' };
        }
        set({ companies: companies.map((c) => (c.id === id ? { ...c, isActive: false } : c)) });
        return { ok: true, id };
      },

      archiveCompany: (id) => {
        const { companies, activeCompanyId } = get();
        const target = companies.find((c) => c.id === id);
        if (!target) return { ok: false, error: 'Company not found.' };
        if (isArchivedEntity(target)) return { ok: true, id };
        if (id === activeCompanyId) {
          return { ok: false, error: 'Switch to another company before archiving this one.' };
        }
        set({
          companies: companies.map((c) =>
            c.id === id ? { ...c, isActive: false, archivedAt: new Date().toISOString() } : c,
          ),
        });
        return { ok: true, id };
      },

      restoreCompany: (id) => {
        const { companies } = get();
        const target = companies.find((c) => c.id === id);
        if (!target) return { ok: false, error: 'Company not found.' };
        if (!isArchivedEntity(target)) return { ok: true, id };
        /*
         * Restored DEACTIVATED, not active. Taking a slot is a decision with a
         * limit attached, and making it silently here could either fail for a
         * reason the subscriber did not ask about or evict nothing and leave
         * them over their allowance. Activating is the next, separate step.
         */
        set({
          companies: companies.map((c) => (c.id === id ? { ...c, archivedAt: null, isActive: false } : c)),
        });
        return { ok: true, id };
      },

      addCompany: (settings, switchTo = true) => {
        // A new entity takes a slot, so it is bounded by the same allowance.
        if (freeEntitySlots(get().companies) <= 0) {
          return {
            ok: false,
            error: `Your package allows ${entityAllowance()} active ${entityAllowance() === 1 ? 'entity' : 'entities'}. Deactivate an entity or upgrade your package to add another.`,
          };
        }
        const id = generateId('co');
        const fresh: CompanyBooks = {
          id,
          settings: { ...DEFAULT_SETTINGS, ...settings },
          accounts: SEED_ACCOUNTS.map((a) => ({ ...a })),
          entities: [],
          entries: [],
          isActive: true,
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
        // Neither a deactivated nor an archived entity holds a slot, so neither
        // can be opened until one is given back to it.
        if (isArchivedEntity(target)) {
          return { ok: false, error: 'This company is archived. Restore it before opening its books.' };
        }
        if (!isActiveEntity(target)) {
          return { ok: false, error: 'This company is deactivated. Activate it before opening its books.' };
        }
        // Snapshot the company we are leaving, then load the target's books.
        const updated = companies.map((c) =>
          c.id === activeCompanyId ? { ...c, ...snapshotWorkingStores() } : c,
        );
        const fresh = updated.find((c) => c.id === targetId) as CompanyBooks;
        loadIntoWorkingStores(fresh);
        set({ companies: updated, activeCompanyId: targetId });
        return { ok: true, id: targetId };
      },

      /**
       * Destroy an entity's books. Archived entities only.
       *
       * Deleting a set of books is irreversible and there is no server-side
       * copy to recover from — these records live in this browser. Requiring
       * the entity to be archived first turns one careless click into a
       * deliberate two-step act, and gives the subscriber a state they can sit
       * in and change their mind from.
       */
      deleteCompany: (id) => {
        const { activeCompanyId, companies } = get();
        const target = companies.find((c) => c.id === id);
        if (!target) return { ok: false, error: 'Company not found.' };
        if (id === activeCompanyId) return { ok: false, error: 'Switch to another company before deleting this one.' };
        if (!isArchivedEntity(target)) {
          return { ok: false, error: 'Archive this company before deleting it. Archiving keeps its records and can be undone.' };
        }
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
      name: 'ledgerly-companies', storage: businessJSONStorage,
      version: 1,
      partialize: (s) => ({ companies: s.companies, activeCompanyId: s.activeCompanyId }),
    },
  ),
);

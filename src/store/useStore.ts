import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  Account,
  AccountType,
  CompanySettings,
  IFRSStatement,
  ViewKey,
} from '@/types';
import type { AccountFormValues } from '@/lib/validation';
import { SEED_ACCOUNTS } from '@/data/seedAccounts';
import { ACCOUNT_TYPE_META } from '@/data/ifrsOptions';
import {
  getChildren,
  getDescendantIds,
  recomputeLevels,
  wouldCreateCycle,
} from '@/lib/accountTree';
import { generateId, nowIso } from '@/lib/utils';
import { sanitizeStoredLogo } from '@/lib/invoiceLogo';

export type StatusFilter = 'all' | 'active' | 'inactive';
export type KindFilter = 'all' | 'posting' | 'header';

export interface AccountFilters {
  type: AccountType | 'ALL';
  statement: IFRSStatement | 'ALL';
  status: StatusFilter;
  kind: KindFilter;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

export const DEFAULT_SETTINGS: CompanySettings = {
  companyName: 'Acme Holdings Ltd.',
  tradingName: '',
  organizationType: 'LLC',
  industryType: 'general',
  logoUrl: '',
  registrationNumber: '',
  taxRegistered: false,
  taxRegistrationNumber: '',
  defaultTaxRate: 0,
  email: '',
  phone: '',
  website: '',
  country: '',
  stateProvince: '',
  city: '',
  addressLine1: '',
  addressLine2: '',
  postalCode: '',
  baseCurrency: 'USD',
  fiscalYearStart: '01-01',
  booksStartDate: `${new Date().getFullYear()}-01-01`,
  accountingBasis: 'accrual',
  reportingFramework: 'IFRS',
  presentationMode: 'IAS_1',
};

const DEFAULT_FILTERS: AccountFilters = {
  type: 'ALL',
  statement: 'ALL',
  status: 'all',
  kind: 'all',
};

interface COAState {
  accounts: Account[];
  settings: CompanySettings;

  // Transient UI state (persisted for convenience).
  activeView: ViewKey;
  search: string;
  filters: AccountFilters;
  collapsedIds: Record<string, true>;

  // Navigation & filters
  setActiveView: (view: ViewKey) => void;
  setSearch: (search: string) => void;
  setFilters: (patch: Partial<AccountFilters>) => void;
  resetFilters: () => void;
  toggleCollapsed: (id: string) => void;
  setAllCollapsed: (collapsed: boolean) => void;

  // Settings
  updateSettings: (patch: Partial<CompanySettings>) => void;

  // Account CRUD
  addAccount: (values: AccountFormValues, parentId: string | null) => ActionResult;
  updateAccount: (id: string, values: AccountFormValues) => ActionResult;
  deleteAccount: (id: string, cascade: boolean) => ActionResult;
  duplicateAccount: (id: string) => ActionResult;
  setActive: (id: string, isActive: boolean) => void;
  quickUpdate: (id: string, patch: Partial<Account>) => ActionResult;
  moveAccount: (id: string, direction: 'up' | 'down') => void;
  reorderSibling: (draggedId: string, targetId: string) => ActionResult;

  // Bulk
  replaceAll: (accounts: Account[]) => void;
  resetToDefault: () => void;
}

/** Next sort order for a new child of `parentId`. */
function nextSortOrder(accounts: Account[], parentId: string | null): number {
  const siblings = accounts.filter((a) => a.parentId === parentId);
  return siblings.reduce((max, a) => Math.max(max, a.sortOrder), -1) + 1;
}

/** Build a full Account from validated form values. */
function accountFromForm(
  values: AccountFormValues,
  base: Pick<Account, 'id' | 'parentId' | 'sortOrder' | 'createdAt'>,
): Account {
  const now = nowIso();
  const includePnl =
    values.ifrsStatement === 'PROFIT_OR_LOSS' && values.profitOrLossCategory;
  return {
    id: base.id,
    code: values.code.trim(),
    name: values.name.trim(),
    type: values.type,
    parentId: base.parentId,
    level: 0, // recomputed below
    normalBalance: values.normalBalance,
    ifrsStatement: values.ifrsStatement,
    ifrsCategory: values.ifrsCategory.trim(),
    ifrsSubcategory: values.ifrsSubcategory.trim(),
    cashFlowCategory: values.cashFlowCategory,
    isPostingAccount: values.isPostingAccount,
    isActive: values.isActive,
    description: values.description.trim(),
    industryTag: values.industryTag.trim() || 'general',
    sortOrder: base.sortOrder,
    createdAt: base.createdAt,
    updatedAt: now,
    ...(includePnl ? { profitOrLossCategory: values.profitOrLossCategory } : {}),
  };
}

export const useStore = create<COAState>()(
  persist(
    (set, get) => ({
      accounts: SEED_ACCOUNTS,
      settings: DEFAULT_SETTINGS,
      activeView: 'dashboard',
      search: '',
      filters: DEFAULT_FILTERS,
      collapsedIds: {},

      setActiveView: (view) => set({ activeView: view }),
      setSearch: (search) => set({ search }),
      setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
      resetFilters: () => set({ filters: DEFAULT_FILTERS, search: '' }),
      toggleCollapsed: (id) =>
        set((s) => {
          const next = { ...s.collapsedIds };
          if (next[id]) delete next[id];
          else next[id] = true;
          return { collapsedIds: next };
        }),
      setAllCollapsed: (collapsed) =>
        set((s) => {
          if (!collapsed) return { collapsedIds: {} };
          const next: Record<string, true> = {};
          for (const a of s.accounts) {
            if (!a.isPostingAccount) next[a.id] = true;
          }
          return { collapsedIds: next };
        }),

      updateSettings: (patch) =>
        set((s) => ({ settings: { ...s.settings, ...patch } })),

      addAccount: (values, parentId) => {
        const { accounts } = get();

        if (accounts.some((a) => a.code === values.code.trim())) {
          return { ok: false, error: `Account code "${values.code}" already exists.` };
        }
        if (parentId) {
          const parent = accounts.find((a) => a.id === parentId);
          if (!parent) return { ok: false, error: 'Selected parent account does not exist.' };
          if (parent.isPostingAccount) {
            return {
              ok: false,
              error: `"${parent.name}" is a posting account and cannot have children. Convert it to a header first.`,
            };
          }
        }

        const id = generateId();
        const created = accountFromForm(values, {
          id,
          parentId,
          sortOrder: nextSortOrder(accounts, parentId),
          createdAt: nowIso(),
        });
        set({ accounts: recomputeLevels([...accounts, created]) });
        return { ok: true, id };
      },

      updateAccount: (id, values) => {
        const { accounts } = get();
        const existing = accounts.find((a) => a.id === id);
        if (!existing) return { ok: false, error: 'Account not found.' };

        if (accounts.some((a) => a.code === values.code.trim() && a.id !== id)) {
          return { ok: false, error: `Account code "${values.code}" already exists.` };
        }

        // Converting to a posting account is blocked while children exist.
        const children = getChildren(accounts, id);
        if (values.isPostingAccount && children.length > 0) {
          return {
            ok: false,
            error: `"${existing.name}" has ${children.length} child account(s) and cannot become a posting account. Move or delete its children first.`,
          };
        }

        // Support re-parenting (moving between categories) from the form.
        const nextParentId = values.parentId ?? null;
        if (nextParentId !== existing.parentId) {
          if (nextParentId) {
            const parent = accounts.find((a) => a.id === nextParentId);
            if (!parent) return { ok: false, error: 'Selected parent account does not exist.' };
            if (parent.isPostingAccount) {
              return {
                ok: false,
                error: `"${parent.name}" is a posting account and cannot have children.`,
              };
            }
          }
          if (wouldCreateCycle(accounts, id, nextParentId)) {
            return { ok: false, error: 'That parent would create a circular reference.' };
          }
        }

        const movedParent = nextParentId !== existing.parentId;
        const updated = accountFromForm(values, {
          id,
          parentId: nextParentId,
          sortOrder: movedParent ? nextSortOrder(accounts, nextParentId) : existing.sortOrder,
          createdAt: existing.createdAt,
        });
        set({
          accounts: recomputeLevels(
            accounts.map((a) => (a.id === id ? updated : a)),
          ),
        });
        return { ok: true, id };
      },

      quickUpdate: (id, patch) => {
        const { accounts } = get();
        const existing = accounts.find((a) => a.id === id);
        if (!existing) return { ok: false, error: 'Account not found.' };

        if (patch.code && accounts.some((a) => a.code === patch.code && a.id !== id)) {
          return { ok: false, error: `Account code "${patch.code}" already exists.` };
        }
        if (patch.isPostingAccount === true && getChildren(accounts, id).length > 0) {
          return { ok: false, error: 'Cannot convert a header with children into a posting account.' };
        }
        if (patch.parentId !== undefined && wouldCreateCycle(accounts, id, patch.parentId)) {
          return { ok: false, error: 'That parent would create a circular reference.' };
        }

        const updated: Account = { ...existing, ...patch, updatedAt: nowIso() };
        set({
          accounts: recomputeLevels(
            accounts.map((a) => (a.id === id ? updated : a)),
          ),
        });
        return { ok: true, id };
      },

      deleteAccount: (id, cascade) => {
        const { accounts } = get();
        const descendants = getDescendantIds(accounts, id);
        if (descendants.length > 0 && !cascade) {
          return {
            ok: false,
            error: `This account has ${descendants.length} descendant account(s). Confirm cascading deletion to remove them too.`,
          };
        }
        const toRemove = new Set([id, ...descendants]);
        set({ accounts: accounts.filter((a) => !toRemove.has(a.id)) });
        return { ok: true };
      },

      duplicateAccount: (id) => {
        const { accounts } = get();
        const source = accounts.find((a) => a.id === id);
        if (!source) return { ok: false, error: 'Account not found.' };

        // Find a free code by incrementing.
        const used = new Set(accounts.map((a) => a.code));
        let numeric = Number(source.code);
        let candidate = source.code;
        if (!Number.isNaN(numeric)) {
          do {
            numeric += 1;
            candidate = String(numeric);
          } while (used.has(candidate));
        } else {
          candidate = `${source.code}-copy`;
        }

        const newId = generateId();
        const now = nowIso();
        const copy: Account = {
          ...source,
          id: newId,
          code: candidate,
          name: `${source.name} (copy)`,
          isPostingAccount: true, // a copy is a leaf; it has no children
          sortOrder: nextSortOrder(accounts, source.parentId),
          createdAt: now,
          updatedAt: now,
        };
        set({ accounts: recomputeLevels([...accounts, copy]) });
        return { ok: true, id: newId };
      },

      setActive: (id, isActive) =>
        set((s) => ({
          accounts: s.accounts.map((a) =>
            a.id === id ? { ...a, isActive, updatedAt: nowIso() } : a,
          ),
        })),

      moveAccount: (id, direction) =>
        set((s) => {
          const target = s.accounts.find((a) => a.id === id);
          if (!target) return {};
          const siblings = s.accounts
            .filter((a) => a.parentId === target.parentId)
            .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
          const idx = siblings.findIndex((a) => a.id === id);
          const swapWith = direction === 'up' ? idx - 1 : idx + 1;
          if (swapWith < 0 || swapWith >= siblings.length) return {};

          const a = siblings[idx];
          const b = siblings[swapWith];
          if (!a || !b) return {};
          const orderA = a.sortOrder;
          const orderB = b.sortOrder;
          return {
            accounts: s.accounts.map((acc) => {
              if (acc.id === a.id) return { ...acc, sortOrder: orderB };
              if (acc.id === b.id) return { ...acc, sortOrder: orderA };
              return acc;
            }),
          };
        }),

      reorderSibling: (draggedId, targetId) => {
        const { accounts } = get();
        const dragged = accounts.find((a) => a.id === draggedId);
        const target = accounts.find((a) => a.id === targetId);
        if (!dragged || !target) return { ok: false, error: 'Account not found.' };
        if (dragged.parentId !== target.parentId) {
          return { ok: false, error: 'Drag-reordering is only supported between siblings.' };
        }
        const siblings = accounts
          .filter((a) => a.parentId === dragged.parentId)
          .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
        const without = siblings.filter((a) => a.id !== draggedId);
        const targetIndex = without.findIndex((a) => a.id === targetId);
        without.splice(targetIndex, 0, dragged);

        const orderById = new Map(without.map((a, i) => [a.id, i]));
        set({
          accounts: accounts.map((a) =>
            orderById.has(a.id)
              ? { ...a, sortOrder: orderById.get(a.id) as number, updatedAt: nowIso() }
              : a,
          ),
        });
        return { ok: true };
      },

      replaceAll: (accounts) =>
        set({ accounts: recomputeLevels(accounts), collapsedIds: {} }),

      resetToDefault: () =>
        set({
          accounts: SEED_ACCOUNTS.map((a) => ({ ...a })),
          collapsedIds: {},
          search: '',
          filters: DEFAULT_FILTERS,
        }),
    }),
    {
      name: 'ifrs-coa-store',
      version: 1,
      partialize: (state) => ({
        accounts: state.accounts,
        settings: state.settings,
        activeView: state.activeView,
        filters: state.filters,
        collapsedIds: state.collapsedIds,
      }),
      // Backfill any newly-added company-setup fields onto persisted settings,
      // and drop any legacy non-persistent (e.g. blob:) logo value.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<COAState>;
        const settings = { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) };
        settings.logoUrl = sanitizeStoredLogo(settings.logoUrl);
        return { ...current, ...p, settings };
      },
    },
  ),
);

/** Default form values for a brand-new account under an optional parent. */
export function makeDefaultFormValues(parent?: Account): AccountFormValues {
  const type: AccountType = parent?.type ?? 'ASSET';
  const meta = ACCOUNT_TYPE_META[type];
  return {
    code: '',
    name: '',
    type,
    parentId: parent?.id ?? null,
    normalBalance: meta.defaultNormalBalance,
    ifrsStatement: meta.defaultStatement,
    ifrsCategory: parent?.ifrsCategory ?? '',
    ifrsSubcategory: parent?.ifrsSubcategory ?? '',
    cashFlowCategory: 'NOT_APPLICABLE',
    profitOrLossCategory:
      meta.defaultStatement === 'PROFIT_OR_LOSS' ? 'OPERATING' : 'NOT_APPLICABLE',
    isPostingAccount: true,
    isActive: true,
    description: '',
    industryTag: parent?.industryTag ?? 'general',
  };
}

/** Map an existing account into form values for editing. */
export function accountToFormValues(account: Account): AccountFormValues {
  return {
    code: account.code,
    name: account.name,
    type: account.type,
    parentId: account.parentId,
    normalBalance: account.normalBalance,
    ifrsStatement: account.ifrsStatement,
    ifrsCategory: account.ifrsCategory,
    ifrsSubcategory: account.ifrsSubcategory,
    cashFlowCategory: account.cashFlowCategory,
    profitOrLossCategory: account.profitOrLossCategory ?? 'NOT_APPLICABLE',
    isPostingAccount: account.isPostingAccount,
    isActive: account.isActive,
    description: account.description,
    industryTag: account.industryTag,
  };
}

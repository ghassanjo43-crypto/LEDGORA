import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type { Currency, CurrencyAuditEvent, EntityCurrencyConfig, ReportingCurrencyConfig } from '@/types/currency';
import { validateBaseCurrencySelection, validateCurrency } from '@/lib/currencyValidation';
import {
  type BaseCurrencyMigration,
  type CustomCurrencyInput,
  buildCustomCurrency,
  collectUsedCurrencyCodes,
  guardBaseCurrencyChange,
  guardCriticalCurrencyEdit,
  isDuplicateCurrencyCode,
  normalizeCurrencyCode,
  patchTouchesCriticalFields,
  upgradeCurrencyRecord,
} from '@/lib/currencyMaster';
import { findCatalogEntry, catalogEntryToCurrency } from '@/data/currencyCatalog';
import { SEED_CURRENCIES, SEED_ENTITY_CURRENCY_CONFIG, PRIMARY_ENTITY_ID } from '@/data/currencySeed';
import { generateId, nowIso } from '@/lib/utils';
import { operatorAuditContext, resolveAuditActor } from './platformFullAccess';
// Call-time-only imports (never touched during module evaluation): these stores
// sit on import cycles back to this module via businessWorkspace — resolving
// the binding inside an action always sees the fully-initialised store.
import { useJournalStore } from './journalStore';
import { useInvoiceStore } from './invoiceStore';
import { useBillStore } from './billStore';

const DEFAULT_ACTOR = 'Finance Manager';

export interface CurrencyActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

function audit(action: string, detail?: string): CurrencyAuditEvent {
  const operator = operatorAuditContext();
  return {
    id: generateId('caud'),
    at: nowIso(),
    action,
    detail,
    by: resolveAuditActor(DEFAULT_ACTOR),
    operator: operator
      ? { operatorUserId: operator.operatorUserId, operatorEmail: operator.operatorEmail, organizationId: operator.organizationId }
      : undefined,
  };
}

function defaultCurrency(): Currency {
  const now = nowIso();
  return {
    id: generateId('cur'), code: '', name: '', symbol: '', currencyType: 'fiat', isIso: false,
    decimalPlaces: 2, exchangeRateDecimalPlaces: 8, symbolPosition: 'before',
    decimalSeparator: '.', thousandSeparator: ',', negativeFormat: '-1,234.56',
    roundingMethod: 'half-up', status: 'inactive',
    auditTrail: [audit('currency-created')], createdAt: now, updatedAt: now, createdBy: resolveAuditActor(DEFAULT_ACTOR),
  };
}

/**
 * Currency codes referenced by workspace documents right now — drives the
 * "already used" warnings and the accounting-critical edit guards. Reads other
 * stores at CALL time (never at module evaluation) to stay cycle-safe.
 */
export function collectWorkspaceCurrencyUsage(): Set<string> {
  return collectUsedCurrencyCodes(
    useJournalStore.getState().entries.map((e) => e.currency),
    useInvoiceStore.getState().invoices.map((i) => i.currency),
    useBillStore.getState().bills.map((b) => b.currency),
  );
}

/** Posted journal entries exist → the base currency is locked behind migration. */
function hasPostedTransactions(): boolean {
  return useJournalStore.getState().entries.some((e) => e.status === 'posted');
}

interface CurrencyState {
  currencies: Currency[];
  entityConfigs: Record<string, EntityCurrencyConfig>;

  getCurrency: (code: string) => Currency | undefined;
  currencyMap: () => Map<string, Currency>;
  getConfig: (entityId?: string) => EntityCurrencyConfig;
  usedCurrencyCodes: () => Set<string>;

  createCurrency: (patch?: Partial<Currency>) => CurrencyActionResult;
  /** Activate a standard catalog currency for this workspace (adds it if absent). */
  activateStandardCurrency: (code: string) => CurrencyActionResult;
  /** Create an organization-defined custom currency (validated, audited). */
  createCustomCurrency: (input: CustomCurrencyInput) => CurrencyActionResult;
  updateCurrency: (
    id: string,
    patch: Partial<Currency>,
    opts?: { elevated?: boolean; confirmedImpact?: boolean },
  ) => CurrencyActionResult;
  setCurrencyStatus: (id: string, status: Currency['status']) => CurrencyActionResult;

  updateEntityConfig: (entityId: string, patch: Partial<EntityCurrencyConfig>) => CurrencyActionResult;
  /**
   * Controlled base-currency selection. Free while nothing is posted; once
   * postings exist it demands elevation + the migration workflow details, and
   * NEVER recalculates historical journals.
   */
  setBaseCurrency: (
    entityId: string,
    code: string,
    opts?: { elevated?: boolean; migration?: BaseCurrencyMigration; hasPostedTransactionsOverride?: boolean },
  ) => CurrencyActionResult;
  setReportingCurrencies: (entityId: string, reporting: ReportingCurrencyConfig[]) => CurrencyActionResult;
  enableCurrency: (entityId: string, code: string) => CurrencyActionResult;
  disableCurrency: (entityId: string, code: string) => CurrencyActionResult;

  replaceAll: (state: Partial<Pick<CurrencyState, 'currencies' | 'entityConfigs'>>) => void;
  resetToDefault: () => void;
}

export const useCurrencyStore = create<CurrencyState>()(
  persist(
    (set, get) => ({
      currencies: SEED_CURRENCIES,
      entityConfigs: { [PRIMARY_ENTITY_ID]: SEED_ENTITY_CURRENCY_CONFIG },

      getCurrency: (code) => get().currencies.find((c) => normalizeCurrencyCode(c.code) === normalizeCurrencyCode(code)),
      currencyMap: () => new Map(get().currencies.map((c) => [c.code, c])),
      getConfig: (entityId = PRIMARY_ENTITY_ID) => get().entityConfigs[entityId] ?? SEED_ENTITY_CURRENCY_CONFIG,
      usedCurrencyCodes: () => collectWorkspaceCurrencyUsage(),

      createCurrency: (patch) => {
        const cur = { ...defaultCurrency(), ...patch };
        set({ currencies: [...get().currencies, cur] });
        return { ok: true, id: cur.id };
      },

      activateStandardCurrency: (code) => {
        const existing = get().getCurrency(code);
        if (existing) {
          if (existing.status === 'active') return { ok: true, id: existing.id };
          return get().setCurrencyStatus(existing.id, 'active');
        }
        const entry = findCatalogEntry(code);
        if (!entry) return { ok: false, error: `${normalizeCurrencyCode(code)} is not in the standard catalog — create it as a custom currency instead.` };
        const cur = catalogEntryToCurrency(entry, { now: nowIso(), status: 'active', by: resolveAuditActor(DEFAULT_ACTOR) });
        // Regenerate the id so re-activation after archive+delete stays unique.
        const withAudit = { ...cur, auditTrail: [audit('currency-activated-from-catalog', `Standard currency ${entry.code}`)] };
        set({ currencies: [...get().currencies, withAudit] });
        return { ok: true, id: withAudit.id };
      },

      createCustomCurrency: (input) => {
        const { currencies } = get();
        if (isDuplicateCurrencyCode(input.code, currencies)) {
          return { ok: false, error: `Currency code ${normalizeCurrencyCode(input.code)} already exists (codes are case-insensitive).` };
        }
        const cur = buildCustomCurrency(input, { id: generateId('cur'), now: nowIso(), by: resolveAuditActor(DEFAULT_ACTOR) });
        const issues = validateCurrency(cur, currencies);
        const error = issues.find((i) => i.severity === 'error');
        if (error) return { ok: false, error: error.message };
        set({ currencies: [...currencies, cur] });
        return { ok: true, id: cur.id };
      },

      updateCurrency: (id, patch, opts = {}) => {
        const { currencies } = get();
        const existing = currencies.find((c) => c.id === id);
        if (!existing) return { ok: false, error: 'Currency not found.' };
        if (existing.status === 'archived') return { ok: false, error: 'Archived currencies cannot be edited.' };
        const merged = { ...existing, ...patch };
        const issues = validateCurrency(merged, currencies);
        const error = issues.find((i) => i.severity === 'error');
        if (error && (patch.code !== undefined || patch.decimalPlaces !== undefined || patch.exchangeRateDecimalPlaces !== undefined || patch.roundingIncrement !== undefined)) {
          return { ok: false, error: error.message };
        }
        // Display fields change freely; accounting-critical fields on a USED
        // currency require elevation + explicit impact confirmation. History is
        // never rewritten either way.
        if (patchTouchesCriticalFields(existing, patch)) {
          const inUse = collectWorkspaceCurrencyUsage().has(normalizeCurrencyCode(existing.code));
          const guard = guardCriticalCurrencyEdit({ inUse, elevated: opts.elevated ?? false, confirmedImpact: opts.confirmedImpact ?? false });
          if (!guard.ok) return { ok: false, error: guard.error };
        }
        set({ currencies: currencies.map((c) => (c.id === id ? { ...merged, auditTrail: [...existing.auditTrail, audit('currency-updated')], updatedAt: nowIso(), updatedBy: resolveAuditActor(DEFAULT_ACTOR) } : c)) });
        return { ok: true, id };
      },

      setCurrencyStatus: (id, status) => {
        const { currencies, entityConfigs } = get();
        const existing = currencies.find((c) => c.id === id);
        if (!existing) return { ok: false, error: 'Currency not found.' };
        if (status !== 'active') {
          const isBaseSomewhere = Object.values(entityConfigs).some((cfg) => cfg.baseCurrencyCode === existing.code);
          if (isBaseSomewhere) return { ok: false, error: `${existing.code} is the base currency and must stay active.` };
        }
        set({ currencies: currencies.map((c) => (c.id === id ? { ...c, status, auditTrail: [...c.auditTrail, audit(`currency-${status}`)], updatedAt: nowIso() } : c)) });
        return { ok: true, id };
      },

      updateEntityConfig: (entityId, patch) => {
        const { entityConfigs } = get();
        const existing = entityConfigs[entityId] ?? SEED_ENTITY_CURRENCY_CONFIG;
        // Base-currency changes must go through the controlled path.
        if (patch.baseCurrencyCode !== undefined && patch.baseCurrencyCode !== existing.baseCurrencyCode) {
          return get().setBaseCurrency(entityId, patch.baseCurrencyCode);
        }
        set({ entityConfigs: { ...entityConfigs, [entityId]: { ...existing, ...patch, entityId, updatedAt: nowIso() } } });
        return { ok: true, id: entityId };
      },

      setBaseCurrency: (entityId, code, opts = {}) => {
        const { entityConfigs, currencies } = get();
        const existing = entityConfigs[entityId] ?? SEED_ENTITY_CURRENCY_CONFIG;
        const normalized = normalizeCurrencyCode(code);
        if (normalized === existing.baseCurrencyCode) return { ok: true, id: entityId };
        const selectionIssues = validateBaseCurrencySelection(normalized, currencies);
        if (selectionIssues.length > 0) return { ok: false, error: selectionIssues[0]!.message };
        const posted = opts.hasPostedTransactionsOverride ?? hasPostedTransactions();
        const guard = guardBaseCurrencyChange({ hasPostedTransactions: posted, elevated: opts.elevated ?? false, migration: opts.migration });
        if (!guard.ok) return { ok: false, error: guard.error };
        const detail = opts.migration
          ? `Base currency ${existing.baseCurrencyCode} → ${normalized}; effective ${opts.migration.effectiveDate}; rate source ${opts.migration.exchangeRateSource}; confirmed by ${opts.migration.confirmedBy}. Historical journals retained unchanged.`
          : `Base currency ${existing.baseCurrencyCode} → ${normalized} (no postings existed).`;
        // Base-change audit lands on the currency record itself.
        const stamped = currencies.map((c) =>
          normalizeCurrencyCode(c.code) === normalized
            ? { ...c, auditTrail: [...c.auditTrail, audit('base-currency-assigned', detail)], updatedAt: nowIso() }
            : c,
        );
        set({
          currencies: stamped,
          entityConfigs: {
            ...entityConfigs,
            [entityId]: {
              ...existing,
              baseCurrencyCode: normalized,
              allowedCurrencyCodes: existing.allowedCurrencyCodes.includes(normalized)
                ? existing.allowedCurrencyCodes
                : [...existing.allowedCurrencyCodes, normalized],
              entityId,
              updatedAt: nowIso(),
            },
          },
        });
        return { ok: true, id: entityId };
      },

      setReportingCurrencies: (entityId, reporting) => {
        const { entityConfigs, currencies } = get();
        const existing = entityConfigs[entityId] ?? SEED_ENTITY_CURRENCY_CONFIG;
        // A reporting currency is never the base and must exist in the master.
        for (const r of reporting) {
          const code = normalizeCurrencyCode(r.currencyCode);
          if (code === existing.baseCurrencyCode) return { ok: false, error: `${code} is the base currency — reporting currencies are additional presentation currencies.` };
          if (!currencies.some((c) => normalizeCurrencyCode(c.code) === code)) return { ok: false, error: `Reporting currency ${code} is not defined in the Currency Master.` };
        }
        set({ entityConfigs: { ...entityConfigs, [entityId]: { ...existing, reportingCurrencies: reporting, entityId, updatedAt: nowIso() } } });
        return { ok: true, id: entityId };
      },

      enableCurrency: (entityId, code) => {
        const cfg = get().getConfig(entityId);
        if (cfg.allowedCurrencyCodes.includes(code)) return { ok: true };
        return get().updateEntityConfig(entityId, { allowedCurrencyCodes: [...cfg.allowedCurrencyCodes, code] });
      },
      disableCurrency: (entityId, code) => {
        const cfg = get().getConfig(entityId);
        if (code === cfg.baseCurrencyCode) return { ok: false, error: 'The base currency cannot be removed.' };
        return get().updateEntityConfig(entityId, { allowedCurrencyCodes: cfg.allowedCurrencyCodes.filter((c) => c !== code) });
      },

      replaceAll: (state) => set((s) => ({ ...s, ...state })),
      resetToDefault: () => set({ currencies: SEED_CURRENCIES.map((c) => ({ ...c })), entityConfigs: { [PRIMARY_ENTITY_ID]: { ...SEED_ENTITY_CURRENCY_CONFIG } } }),
    }),
    {
      name: 'ledgerly-currencies',
      storage: businessJSONStorage,
      version: 2,
      /**
       * v1 → v2 legacy migration: upgrade every persisted currency record to
       * the Currency Master shape (type, ISO metadata, exchange-rate precision,
       * rounding method) WITHOUT touching codes, precision, formatting or any
       * transaction values — historical amounts are never rewritten or rounded.
       */
      migrate: (persisted, version) => {
        const state = persisted as Partial<Pick<CurrencyState, 'currencies' | 'entityConfigs'>>;
        if (version >= 2) return state as CurrencyState;
        const currencies = (state.currencies ?? []).map(upgradeCurrencyRecord);
        const entityConfigs = Object.fromEntries(
          Object.entries(state.entityConfigs ?? {}).map(([id, cfg]) => [id, { reportingCurrencies: [], ...cfg }]),
        );
        return { ...state, currencies, entityConfigs } as CurrencyState;
      },
    },
  ),
);

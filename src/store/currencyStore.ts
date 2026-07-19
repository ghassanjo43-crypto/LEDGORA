import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type { Currency, CurrencyAuditEvent, EntityCurrencyConfig } from '@/types/currency';
import { validateCurrency } from '@/lib/currencyValidation';
import { SEED_CURRENCIES, SEED_ENTITY_CURRENCY_CONFIG, PRIMARY_ENTITY_ID } from '@/data/currencySeed';
import { generateId, nowIso } from '@/lib/utils';

const ACTOR = 'Finance Manager';

export interface CurrencyActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

function audit(action: string, detail?: string): CurrencyAuditEvent {
  return { id: generateId('caud'), at: nowIso(), action, detail, by: ACTOR };
}

function defaultCurrency(): Currency {
  const now = nowIso();
  return {
    id: generateId('cur'), code: '', name: '', symbol: '', decimalPlaces: 2, symbolPosition: 'before',
    decimalSeparator: '.', thousandSeparator: ',', negativeFormat: '-1,234.56', status: 'inactive',
    auditTrail: [audit('currency-created')], createdAt: now, updatedAt: now, createdBy: ACTOR,
  };
}

interface CurrencyState {
  currencies: Currency[];
  entityConfigs: Record<string, EntityCurrencyConfig>;

  getCurrency: (code: string) => Currency | undefined;
  currencyMap: () => Map<string, Currency>;
  getConfig: (entityId?: string) => EntityCurrencyConfig;

  createCurrency: (patch?: Partial<Currency>) => CurrencyActionResult;
  updateCurrency: (id: string, patch: Partial<Currency>) => CurrencyActionResult;
  setCurrencyStatus: (id: string, status: Currency['status']) => CurrencyActionResult;

  updateEntityConfig: (entityId: string, patch: Partial<EntityCurrencyConfig>) => CurrencyActionResult;
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

      getCurrency: (code) => get().currencies.find((c) => c.code.toUpperCase() === code.toUpperCase()),
      currencyMap: () => new Map(get().currencies.map((c) => [c.code, c])),
      getConfig: (entityId = PRIMARY_ENTITY_ID) => get().entityConfigs[entityId] ?? SEED_ENTITY_CURRENCY_CONFIG,

      createCurrency: (patch) => {
        const cur = { ...defaultCurrency(), ...patch };
        set({ currencies: [...get().currencies, cur] });
        return { ok: true, id: cur.id };
      },

      updateCurrency: (id, patch) => {
        const { currencies } = get();
        const existing = currencies.find((c) => c.id === id);
        if (!existing) return { ok: false, error: 'Currency not found.' };
        if (existing.status === 'archived') return { ok: false, error: 'Archived currencies cannot be edited.' };
        const merged = { ...existing, ...patch };
        const issues = validateCurrency(merged, currencies);
        const error = issues.find((i) => i.severity === 'error');
        if (error && (patch.code !== undefined || patch.decimalPlaces !== undefined)) return { ok: false, error: error.message };
        set({ currencies: currencies.map((c) => (c.id === id ? { ...merged, auditTrail: [...existing.auditTrail, audit('currency-updated')], updatedAt: nowIso(), updatedBy: ACTOR } : c)) });
        return { ok: true, id };
      },

      setCurrencyStatus: (id, status) => {
        const { currencies } = get();
        const existing = currencies.find((c) => c.id === id);
        if (!existing) return { ok: false, error: 'Currency not found.' };
        set({ currencies: currencies.map((c) => (c.id === id ? { ...c, status, auditTrail: [...c.auditTrail, audit(`currency-${status}`)], updatedAt: nowIso() } : c)) });
        return { ok: true, id };
      },

      updateEntityConfig: (entityId, patch) => {
        const { entityConfigs } = get();
        const existing = entityConfigs[entityId] ?? SEED_ENTITY_CURRENCY_CONFIG;
        set({ entityConfigs: { ...entityConfigs, [entityId]: { ...existing, ...patch, entityId, updatedAt: nowIso() } } });
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
    { name: 'ledgerly-currencies', storage: businessJSONStorage, version: 1 },
  ),
);

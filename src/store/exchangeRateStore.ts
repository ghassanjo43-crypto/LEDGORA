import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type { ExchangeRate, ExchangeRateType } from '@/types/exchangeRate';
import { validateExchangeRate } from '@/lib/exchangeRateValidation';
import { resolveExchangeRate, type RateResolution } from '@/lib/exchangeRateResolution';
import { roundExchangeRate } from '@/lib/currencyConversion';
import { SEED_EXCHANGE_RATES } from '@/data/currencySeed';
import { generateId, nowIso } from '@/lib/utils';

const ACTOR = 'Finance Manager';

export interface RateActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

interface ExchangeRateState {
  rates: ExchangeRate[];

  getRate: (id: string) => ExchangeRate | undefined;
  resolve: (params: { entityId: string; fromCurrencyCode: string; toCurrencyCode: string; transactionDate: string; rateType?: ExchangeRateType; baseCurrencyCode?: string }) => RateResolution;

  createRate: (input: Partial<ExchangeRate> & Pick<ExchangeRate, 'entityId' | 'fromCurrencyCode' | 'toCurrencyCode' | 'rate' | 'effectiveDate'>) => RateActionResult;
  updateRate: (id: string, patch: Partial<ExchangeRate>) => RateActionResult;
  supersedeRate: (id: string) => RateActionResult;
  deactivateRate: (id: string) => RateActionResult;
  duplicateRate: (id: string) => RateActionResult;

  replaceAll: (rates: ExchangeRate[]) => void;
  resetToDefault: () => void;
}

export const useExchangeRateStore = create<ExchangeRateState>()(
  persist(
    (set, get) => ({
      rates: SEED_EXCHANGE_RATES,

      getRate: (id) => get().rates.find((r) => r.id === id),

      resolve: (params) => resolveExchangeRate({ ...params, rates: get().rates, allowTriangulation: true }),

      createRate: (input) => {
        const now = nowIso();
        const rate: ExchangeRate = {
          id: generateId('xr'), entityId: input.entityId, fromCurrencyCode: input.fromCurrencyCode.toUpperCase(), toCurrencyCode: input.toCurrencyCode.toUpperCase(),
          rate: Number(input.rate), inverseRate: input.inverseRate ?? (input.rate ? roundExchangeRate(1 / Number(input.rate)) : 0),
          rateType: input.rateType ?? 'mid', source: input.source ?? 'manual', effectiveDate: input.effectiveDate, effectiveTime: input.effectiveTime,
          status: 'active', sourceReference: input.sourceReference, notes: input.notes, createdAt: now, updatedAt: now, createdBy: ACTOR,
        };
        const issues = validateExchangeRate(rate, { existingRates: get().rates });
        const error = issues.find((i) => i.severity === 'error');
        if (error) return { ok: false, error: error.message };
        // Supersede any prior active rate for the same pair + date.
        const superseded = get().rates.map((r) => (r.entityId === rate.entityId && r.fromCurrencyCode === rate.fromCurrencyCode && r.toCurrencyCode === rate.toCurrencyCode && r.effectiveDate === rate.effectiveDate && r.status === 'active' ? { ...r, status: 'superseded' as const, updatedAt: now } : r));
        set({ rates: [...superseded, rate] });
        return { ok: true, id: rate.id };
      },

      updateRate: (id, patch) => {
        const { rates } = get();
        const existing = rates.find((r) => r.id === id);
        if (!existing) return { ok: false, error: 'Exchange rate not found.' };
        const merged = { ...existing, ...patch, updatedAt: nowIso(), updatedBy: ACTOR };
        if (patch.rate !== undefined) merged.inverseRate = patch.rate ? roundExchangeRate(1 / Number(patch.rate)) : 0;
        const issues = validateExchangeRate(merged, { existingRates: rates });
        const error = issues.find((i) => i.severity === 'error');
        if (error) return { ok: false, error: error.message };
        set({ rates: rates.map((r) => (r.id === id ? merged : r)) });
        return { ok: true, id };
      },

      supersedeRate: (id) => {
        const { rates } = get();
        if (!rates.some((r) => r.id === id)) return { ok: false, error: 'Exchange rate not found.' };
        set({ rates: rates.map((r) => (r.id === id ? { ...r, status: 'superseded', updatedAt: nowIso() } : r)) });
        return { ok: true, id };
      },
      deactivateRate: (id) => {
        const { rates } = get();
        if (!rates.some((r) => r.id === id)) return { ok: false, error: 'Exchange rate not found.' };
        set({ rates: rates.map((r) => (r.id === id ? { ...r, status: 'inactive', updatedAt: nowIso() } : r)) });
        return { ok: true, id };
      },
      duplicateRate: (id) => {
        const { rates } = get();
        const src = rates.find((r) => r.id === id);
        if (!src) return { ok: false, error: 'Exchange rate not found.' };
        return get().createRate({ ...src, id: undefined as never, effectiveDate: new Date().toISOString().slice(0, 10) });
      },

      replaceAll: (rates) => set({ rates }),
      resetToDefault: () => set({ rates: SEED_EXCHANGE_RATES.map((r) => ({ ...r })) }),
    }),
    { name: 'ledgerly-exchange-rates', storage: businessJSONStorage, version: 1 },
  ),
);

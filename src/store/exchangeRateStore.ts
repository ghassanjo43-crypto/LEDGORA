import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type { ExchangeRate, ExchangeRateType } from '@/types/exchangeRate';
import { validateExchangeRate } from '@/lib/exchangeRateValidation';
import { resolveExchangeRate, type RateResolution } from '@/lib/exchangeRateResolution';
import { inverseRateDec, ratePrecisionFor } from '@/lib/currencyConversion';
import { decToNumber } from '@/lib/decimal';
import { SEED_EXCHANGE_RATES } from '@/data/currencySeed';
import { generateId, nowIso } from '@/lib/utils';
import { resolveAuditActor } from './platformFullAccess';
import { useCurrencyStore } from './currencyStore';

const DEFAULT_ACTOR = 'Finance Manager';

export interface RateActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

/**
 * Inverse of the AUTHORITATIVE entered rate at the currency pair's configured
 * exchange-rate precision (each currency's `exchangeRateDecimalPlaces`, up to
 * 18). The entered direction stays authoritative — the inverse is display data.
 */
function inverseAtPairPrecision(rate: number, fromCode: string, toCode: string): number {
  if (!rate) return 0;
  const getCurrency = useCurrencyStore.getState().getCurrency;
  const decimals = ratePrecisionFor(getCurrency(fromCode), getCurrency(toCode));
  return decToNumber(inverseRateDec(rate, decimals));
}

interface ExchangeRateState {
  rates: ExchangeRate[];

  getRate: (id: string) => ExchangeRate | undefined;
  resolve: (params: { entityId: string; fromCurrencyCode: string; toCurrencyCode: string; transactionDate: string; rateType?: ExchangeRateType; baseCurrencyCode?: string }) => RateResolution;

  createRate: (input: Partial<ExchangeRate> & Pick<ExchangeRate, 'entityId' | 'fromCurrencyCode' | 'toCurrencyCode' | 'rate' | 'effectiveDate'>) => RateActionResult;
  updateRate: (id: string, patch: Partial<ExchangeRate>) => RateActionResult;
  /** Activate a draft rate, recording the approver (exchangeRate.approve). */
  approveRate: (id: string) => RateActionResult;
  /** Remove a draft rate that was never active (exchangeRate.deleteDraft). */
  deleteDraftRate: (id: string) => RateActionResult;
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
        const from = input.fromCurrencyCode.toUpperCase();
        const to = input.toCurrencyCode.toUpperCase();
        const rate: ExchangeRate = {
          id: generateId('xr'), entityId: input.entityId, fromCurrencyCode: from, toCurrencyCode: to,
          rate: Number(input.rate), inverseRate: input.inverseRate ?? inverseAtPairPrecision(Number(input.rate), from, to),
          rateType: input.rateType ?? 'mid', source: input.source ?? 'manual', effectiveDate: input.effectiveDate, effectiveTime: input.effectiveTime,
          status: input.status ?? 'active', sourceReference: input.sourceReference, notes: input.notes,
          createdAt: now, updatedAt: now, createdBy: resolveAuditActor(DEFAULT_ACTOR),
        };
        const issues = validateExchangeRate(rate, { existingRates: get().rates });
        const error = issues.find((i) => i.severity === 'error');
        if (error) return { ok: false, error: error.message };
        // Supersede any prior active rate for the same pair + type + date.
        const superseded = rate.status === 'active'
          ? get().rates.map((r) => (r.entityId === rate.entityId && r.fromCurrencyCode === rate.fromCurrencyCode && r.toCurrencyCode === rate.toCurrencyCode && r.rateType === rate.rateType && r.effectiveDate === rate.effectiveDate && r.status === 'active' ? { ...r, status: 'superseded' as const, updatedAt: now } : r))
          : get().rates;
        set({ rates: [...superseded, rate] });
        return { ok: true, id: rate.id };
      },

      updateRate: (id, patch) => {
        const { rates } = get();
        const existing = rates.find((r) => r.id === id);
        if (!existing) return { ok: false, error: 'Exchange rate not found.' };
        const merged = { ...existing, ...patch, updatedAt: nowIso(), updatedBy: resolveAuditActor(DEFAULT_ACTOR) };
        if (patch.rate !== undefined && patch.inverseRate === undefined) {
          merged.inverseRate = inverseAtPairPrecision(Number(patch.rate), merged.fromCurrencyCode, merged.toCurrencyCode);
        }
        const issues = validateExchangeRate(merged, { existingRates: rates });
        const error = issues.find((i) => i.severity === 'error');
        if (error) return { ok: false, error: error.message };
        set({ rates: rates.map((r) => (r.id === id ? merged : r)) });
        return { ok: true, id };
      },

      approveRate: (id) => {
        const { rates } = get();
        const existing = rates.find((r) => r.id === id);
        if (!existing) return { ok: false, error: 'Exchange rate not found.' };
        if (existing.status !== 'draft') return { ok: false, error: 'Only draft rates can be approved.' };
        const now = nowIso();
        const approver = resolveAuditActor(DEFAULT_ACTOR);
        // Approval supersedes any active rate for the same pair + type + date.
        const superseded = rates.map((r) => (r.id !== id && r.entityId === existing.entityId && r.fromCurrencyCode === existing.fromCurrencyCode && r.toCurrencyCode === existing.toCurrencyCode && r.rateType === existing.rateType && r.effectiveDate === existing.effectiveDate && r.status === 'active' ? { ...r, status: 'superseded' as const, updatedAt: now } : r));
        set({ rates: superseded.map((r) => (r.id === id ? { ...r, status: 'active' as const, approvedBy: approver, approvedAt: now, updatedAt: now } : r)) });
        return { ok: true, id };
      },

      deleteDraftRate: (id) => {
        const { rates } = get();
        const existing = rates.find((r) => r.id === id);
        if (!existing) return { ok: false, error: 'Exchange rate not found.' };
        if (existing.status !== 'draft') return { ok: false, error: 'Only draft rates can be deleted — activated rates are deactivated instead, preserving history.' };
        set({ rates: rates.filter((r) => r.id !== id) });
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
    { name: 'ledgerly-exchange-rates', storage: businessJSONStorage, version: 2, migrate: (persisted) => persisted as ExchangeRateState },
  ),
);

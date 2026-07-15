import type { EntityCurrencyConfig, PartyCurrencyProfile } from '@/types/currency';
import type { ExchangeRate, ExchangeRateSnapshot, ExchangeRateType } from '@/types/exchangeRate';
import { roundExchangeRate } from '@/lib/currencyConversion';

/**
 * Exchange-rate resolution (§6). Never uses a future rate for a past date, and
 * never silently defaults a missing foreign rate to 1.0 — a missing rate blocks.
 */

export type RateResolutionMethod = 'base-identity' | 'exact' | 'prior' | 'inverse' | 'triangulated' | 'none';

export interface RateResolution {
  ok: boolean;
  rate?: number;
  inverseRate?: number;
  rateType?: ExchangeRateType;
  source?: ExchangeRate['source'];
  effectiveDate?: string;
  method: RateResolutionMethod;
  sourceReference?: string;
  error?: string;
}

export interface ResolveRateParams {
  entityId: string;
  fromCurrencyCode: string;
  toCurrencyCode: string;
  transactionDate: string;
  rateType?: ExchangeRateType;
  rates: ExchangeRate[];
  allowTriangulation?: boolean;
  baseCurrencyCode?: string;
}

function candidates(rates: ExchangeRate[], entityId: string, from: string, to: string, date: string, rateType?: ExchangeRateType): ExchangeRate[] {
  return rates
    .filter((r) => r.entityId === entityId && r.status !== 'inactive')
    .filter((r) => r.fromCurrencyCode === from && r.toCurrencyCode === to)
    .filter((r) => r.effectiveDate <= date)
    .filter((r) => (rateType ? r.rateType === rateType : true))
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || (b.effectiveTime ?? '').localeCompare(a.effectiveTime ?? ''));
}

export function resolveExchangeRate(params: ResolveRateParams): RateResolution {
  const { fromCurrencyCode: from, toCurrencyCode: to, transactionDate: date, entityId, rateType, rates } = params;
  if (from.toUpperCase() === to.toUpperCase()) {
    return { ok: true, rate: 1, inverseRate: 1, method: 'base-identity', rateType: rateType ?? 'mid', source: 'system', effectiveDate: date };
  }

  // 1–2. Exact / latest-prior direct rate.
  let direct = candidates(rates, entityId, from, to, date, rateType);
  if (direct.length === 0 && rateType) direct = candidates(rates, entityId, from, to, date); // relax the rate type
  if (direct.length > 0) {
    const r = direct[0]!;
    return { ok: true, rate: r.rate, inverseRate: r.inverseRate || roundExchangeRate(1 / r.rate), rateType: r.rateType, source: r.source, effectiveDate: r.effectiveDate, sourceReference: r.sourceReference, method: r.effectiveDate === date ? 'exact' : 'prior' };
  }

  // 3. Inverse of a reciprocal rate.
  const reciprocal = candidates(rates, entityId, to, from, date);
  if (reciprocal.length > 0 && reciprocal[0]!.rate) {
    const r = reciprocal[0]!;
    return { ok: true, rate: roundExchangeRate(1 / r.rate), inverseRate: r.rate, rateType: r.rateType, source: r.source, effectiveDate: r.effectiveDate, method: 'inverse' };
  }

  // 4. Triangulate through the base currency: from→to = (from→base) / (to→base).
  const base = params.baseCurrencyCode;
  if (params.allowTriangulation && base && base !== from && base !== to) {
    const fromBase = candidates(rates, entityId, from, base, date)[0] ?? inverseFrom(rates, entityId, base, from, date);
    const toBase = candidates(rates, entityId, to, base, date)[0] ?? inverseFrom(rates, entityId, base, to, date);
    if (fromBase && toBase && toBase.rate) {
      const rate = roundExchangeRate(fromBase.rate / toBase.rate);
      return { ok: true, rate, inverseRate: roundExchangeRate(1 / rate), rateType: 'mid', source: 'system', effectiveDate: date, method: 'triangulated' };
    }
  }

  return { ok: false, method: 'none', error: `No exchange rate found for ${from}→${to} on or before ${date}. Enter a rate before posting.` };
}

function inverseFrom(rates: ExchangeRate[], entityId: string, from: string, to: string, date: string): ExchangeRate | undefined {
  const rec = candidates(rates, entityId, to, from, date)[0];
  if (!rec || !rec.rate) return undefined;
  return { ...rec, fromCurrencyCode: from, toCurrencyCode: to, rate: roundExchangeRate(1 / rec.rate), inverseRate: rec.rate };
}

/** Freeze the resolved rate onto a posted document (§7), with optional override audit. */
export function createExchangeRateSnapshot(
  resolution: RateResolution,
  fromCurrencyCode: string,
  toCurrencyCode: string,
  capturedAt: string,
  override?: { overrideRate: number; overrideReason?: string },
): ExchangeRateSnapshot {
  const usedRate = override ? override.overrideRate : resolution.rate ?? 1;
  return {
    fromCurrencyCode,
    toCurrencyCode,
    rate: usedRate,
    inverseRate: usedRate ? roundExchangeRate(1 / usedRate) : 0,
    rateType: resolution.rateType ?? 'mid',
    source: override ? 'manual' : resolution.source ?? 'manual',
    effectiveDate: resolution.effectiveDate ?? capturedAt.slice(0, 10),
    sourceReference: resolution.sourceReference,
    overrideReason: override?.overrideReason,
    resolvedRate: override ? resolution.rate : undefined,
    overrideRate: override?.overrideRate,
    capturedAt,
  };
}

/* ─────────────────────────── Default currency ───────────────────────────── */

export type CurrencyDefaultSource = 'explicit' | 'party' | 'entity-default' | 'entity-base';

export interface DefaultCurrencyResolution {
  currencyCode: string;
  source: CurrencyDefaultSource;
}

export interface ResolveDefaultCurrencyParams {
  direction: 'sales' | 'purchase';
  explicitCurrencyCode?: string;
  party?: PartyCurrencyProfile;
  config: EntityCurrencyConfig;
}

/** Resolve the default document currency by priority (§12), reporting the source. */
export function resolveDefaultCurrency(params: ResolveDefaultCurrencyParams): DefaultCurrencyResolution {
  if (params.explicitCurrencyCode) return { currencyCode: params.explicitCurrencyCode, source: 'explicit' };
  if (params.party?.preferredCurrencyCode) return { currencyCode: params.party.preferredCurrencyCode, source: 'party' };
  const entityDefault = params.direction === 'sales' ? params.config.defaultSalesCurrencyCode : params.config.defaultPurchaseCurrencyCode;
  if (entityDefault) return { currencyCode: entityDefault, source: 'entity-default' };
  return { currencyCode: params.config.baseCurrencyCode, source: 'entity-base' };
}

/** Percent variance of an entered rate vs the resolved rate (for override controls). */
export function rateVariancePercent(resolvedRate: number, enteredRate: number): number {
  if (!resolvedRate) return 0;
  return Math.round((Math.abs(enteredRate - resolvedRate) / resolvedRate) * 10000) / 100;
}

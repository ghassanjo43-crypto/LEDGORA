import type { Currency, EntityCurrencyConfig } from '@/types/currency';
import type { ExchangeRate } from '@/types/exchangeRate';
import { STANDARD_CURRENCY_CATALOG, catalogEntryToCurrency } from '@/data/currencyCatalog';

/**
 * Default currency configuration DATA (not business logic). The seeded master
 * comes from the shared standard catalog — ISO fiat currencies active with their
 * proper decimals (JPY 0, USD 2, JOD/KWD/BHD/OMR/IQD 3), digital/commodity
 * reference entries present but INACTIVE until an organization enables them.
 * Users are never limited to this list — custom currencies extend it.
 *
 * Rates are sample data kept out of calculation code. FX account references use
 * the deterministic seed CoA id `seed_7300` (Foreign exchange gains and losses).
 */

const TS = new Date('2026-01-01T00:00:00.000Z').toISOString();
const FX = 'seed_7300';
export const PRIMARY_ENTITY_ID = 'primary';
export const DEFAULT_BASE_CURRENCY = 'USD';

export const SEED_CURRENCIES: Currency[] = STANDARD_CURRENCY_CATALOG.map((entry) =>
  catalogEntryToCurrency(entry, {
    now: TS,
    // Fiat is active by default; crypto/token/commodity entries wait for an
    // explicit organization opt-in ("where enabled").
    status: entry.type === 'fiat' ? 'active' : 'inactive',
  }),
).map((c) => ({
  ...c,
  auditTrail: [{ id: `caud_${c.code}`, at: TS, action: 'currency-created', detail: 'seed' }],
}));

export const SEED_ENTITY_CURRENCY_CONFIG: EntityCurrencyConfig = {
  entityId: PRIMARY_ENTITY_ID,
  baseCurrencyCode: DEFAULT_BASE_CURRENCY,
  allowedCurrencyCodes: ['USD', 'EUR', 'GBP', 'JOD', 'AED', 'JPY'],
  reportingCurrencies: [],
  realizedFxGainAccountId: FX,
  realizedFxLossAccountId: FX,
  unrealizedFxGainAccountId: FX,
  unrealizedFxLossAccountId: FX,
  currencyRoundingAccountId: FX,
  rateType: 'mid',
  allowManualRateOverride: true,
  requireOverrideReason: true,
  rateVariancePolicy: { warningThresholdPercent: 2, blockingThresholdPercent: 10, requireApprovalAbovePercent: 5 },
  revaluationReversalPolicy: 'reverse-next-day',
  createdAt: TS, updatedAt: TS,
};

/** Sample effective-dated rates INTO the base currency (1 foreign = rate USD). */
interface RateSpec { from: string; rate: number; date: string; }
function makeRate(s: RateSpec): ExchangeRate {
  return {
    id: `xr_${s.from}_${s.date}`, entityId: PRIMARY_ENTITY_ID,
    fromCurrencyCode: s.from, toCurrencyCode: DEFAULT_BASE_CURRENCY,
    rate: s.rate, inverseRate: Math.round((1 / s.rate) * 1e8) / 1e8,
    rateType: 'mid', source: 'manual', effectiveDate: s.date, status: 'active',
    createdAt: TS, updatedAt: TS,
  };
}

export const SEED_EXCHANGE_RATES: ExchangeRate[] = [
  makeRate({ from: 'EUR', rate: 1.08, date: '2026-01-01' }),
  makeRate({ from: 'GBP', rate: 1.27, date: '2026-01-01' }),
  makeRate({ from: 'JOD', rate: 1.41, date: '2026-01-01' }),
  makeRate({ from: 'AED', rate: 0.27, date: '2026-01-01' }),
  makeRate({ from: 'JPY', rate: 0.0067, date: '2026-01-01' }),
];

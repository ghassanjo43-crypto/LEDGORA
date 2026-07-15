import type { Currency, EntityCurrencyConfig } from '@/types/currency';
import type { ExchangeRate } from '@/types/exchangeRate';

/**
 * Default currency configuration DATA (not business logic). Rates are sample data
 * kept out of calculation code. FX account references use the deterministic seed
 * CoA id `seed_7300` (Foreign exchange gains and losses).
 */

const TS = new Date('2026-01-01T00:00:00.000Z').toISOString();
const FX = 'seed_7300';
export const PRIMARY_ENTITY_ID = 'primary';
export const DEFAULT_BASE_CURRENCY = 'USD';

interface CurrencySpec {
  code: string; name: string; symbol: string; decimals: number;
  symbolPosition?: 'before' | 'after'; countryCodes?: string[]; status?: Currency['status'];
}

function makeCurrency(s: CurrencySpec): Currency {
  return {
    id: `cur_${s.code}`, code: s.code, name: s.name, symbol: s.symbol, decimalPlaces: s.decimals,
    symbolPosition: s.symbolPosition ?? 'before', decimalSeparator: '.', thousandSeparator: ',', negativeFormat: '-1,234.56',
    status: s.status ?? 'active', countryCodes: s.countryCodes,
    auditTrail: [{ id: `caud_${s.code}`, at: TS, action: 'currency-created', detail: 'seed' }],
    createdAt: TS, updatedAt: TS,
  };
}

export const SEED_CURRENCIES: Currency[] = [
  makeCurrency({ code: 'USD', name: 'United States Dollar', symbol: '$', decimals: 2, countryCodes: ['US'] }),
  makeCurrency({ code: 'EUR', name: 'Euro', symbol: '€', decimals: 2, countryCodes: ['DE', 'FR', 'ES'] }),
  makeCurrency({ code: 'GBP', name: 'Pound Sterling', symbol: '£', decimals: 2, countryCodes: ['GB'] }),
  makeCurrency({ code: 'JOD', name: 'Jordanian Dinar', symbol: 'JD', decimals: 3, countryCodes: ['JO'] }),
  makeCurrency({ code: 'AED', name: 'UAE Dirham', symbol: 'AED', decimals: 2, symbolPosition: 'after', countryCodes: ['AE'] }),
  makeCurrency({ code: 'JPY', name: 'Japanese Yen', symbol: '¥', decimals: 0, countryCodes: ['JP'] }),
];

export const SEED_ENTITY_CURRENCY_CONFIG: EntityCurrencyConfig = {
  entityId: PRIMARY_ENTITY_ID,
  baseCurrencyCode: DEFAULT_BASE_CURRENCY,
  allowedCurrencyCodes: ['USD', 'EUR', 'GBP', 'JOD', 'AED', 'JPY'],
  realizedFxGainAccountId: FX,
  realizedFxLossAccountId: FX,
  unrealizedFxGainAccountId: FX,
  unrealizedFxLossAccountId: FX,
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

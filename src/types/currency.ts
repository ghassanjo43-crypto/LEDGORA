/**
 * Currency master data and entity currency configuration — the centralized
 * currency/FX engine's static model. Decimal precision is explicit per currency
 * (never inferred from the symbol, never assumed to be 2); one base currency per
 * entity; foreign currencies must be explicitly enabled.
 *
 * The master supports ISO fiat currencies, organization-defined custom
 * currencies, cryptocurrencies/digital tokens, commodity and internal units of
 * account, and historical (discontinued) currencies. Monetary precision and
 * exchange-rate precision are configured independently, each 0–18 places.
 */
import type { RoundingMethod } from '@/lib/decimal';

export type { RoundingMethod };

export type CurrencyStatus = 'active' | 'inactive' | 'archived';

export type CurrencyType =
  | 'fiat'
  | 'cryptocurrency'
  | 'digital-token'
  | 'commodity'
  | 'internal'
  | 'historical'
  | 'custom';

export const CURRENCY_TYPES: CurrencyType[] = [
  'fiat', 'cryptocurrency', 'digital-token', 'commodity', 'internal', 'historical', 'custom',
];

export type SymbolPosition = 'before' | 'after';
export type DecimalSeparator = '.' | ',';
export type ThousandSeparator = ',' | '.' | ' ' | '';
export type NegativeFormat = '-1,234.56' | '(1,234.56)' | '1,234.56-';

/** Supported precision ranges — configured, never silently clamped to 2. */
export const MIN_MONETARY_DECIMALS = 0;
export const MAX_MONETARY_DECIMALS = 18;
export const MIN_RATE_DECIMALS = 0;
export const MAX_RATE_DECIMALS = 18;
/** Default exchange-rate precision when a currency does not configure one. */
export const DEFAULT_RATE_DECIMALS = 8;

export interface CurrencyAuditEvent {
  id: string;
  at: string;
  action: string;
  detail?: string;
  by?: string;
  /** Operator audit metadata when a platform administrator acted in support mode. */
  operator?: {
    operatorUserId: string;
    operatorEmail?: string;
    organizationId: string | null;
  };
}

export interface Currency {
  id: string;

  /** Unique (case-insensitive). ISO currencies are 3 letters; custom codes may
   *  be longer (e.g. USDT, TOKEN1, INTERNAL-UNIT). */
  code: string;
  name: string;
  symbol: string;
  /** Optional display name in the organization's local language. */
  localizedName?: string;

  /** Fiat / crypto / token / commodity / internal / historical / custom.
   *  Absent on legacy records → treated as 'fiat'. */
  currencyType?: CurrencyType;
  /** True for standard ISO-4217 currencies (implies a 3-letter code). */
  isIso?: boolean;
  /** ISO-4217 numeric code, where applicable (e.g. "840" for USD). */
  isoNumericCode?: string;
  /** Country or region, where applicable. */
  region?: string;
  countryCodes?: string[];

  /** Monetary decimal places (0–18). JPY 0, USD 2, JOD/KWD 3, BTC 8. */
  decimalPlaces: number;
  /** Exchange-rate storage/entry/display precision (0–18; default 8). */
  exchangeRateDecimalPlaces?: number;

  /** Smallest-unit naming, e.g. cent/cents, fils/fils, satoshi/satoshis. */
  minorUnitName?: string;
  minorUnitPluralName?: string;
  majorUnitName?: string;

  symbolPosition: SymbolPosition;
  /** Space between symbol and amount ("$ 1,234.56" vs "$1,234.56"). */
  symbolSpacing?: boolean;
  decimalSeparator: DecimalSeparator;
  thousandSeparator: ThousandSeparator;
  negativeFormat: NegativeFormat;

  /** Rounding method for amounts in this currency (default half-up). */
  roundingMethod?: RoundingMethod;
  /** Smallest cash increment (e.g. 0.05); undefined → 10^-decimalPlaces. */
  roundingIncrement?: number;

  status: CurrencyStatus;
  /** Validity window for historical / phased-in currencies. */
  effectiveFrom?: string;
  effectiveTo?: string;

  auditTrail: CurrencyAuditEvent[];
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}

export type EntityRateType = 'mid' | 'buy' | 'sell' | 'custom';

/** How a reporting currency translates financial statements. */
export type TranslationMethod = 'closing-rate' | 'average-rate' | 'historical-rate';

/** An optional reporting currency — NEVER the base; base records stay unchanged. */
export interface ReportingCurrencyConfig {
  currencyCode: string;
  rateType: EntityRateType;
  translationMethod: TranslationMethod;
  effectiveDatePolicy: 'transaction-date' | 'period-end';
}

export interface EntityCurrencyConfig {
  entityId: string;

  baseCurrencyCode: string;
  allowedCurrencyCodes: string[];

  /** Optional presentation currencies for translated statements. */
  reportingCurrencies?: ReportingCurrencyConfig[];

  defaultSalesCurrencyCode?: string;
  defaultPurchaseCurrencyCode?: string;

  realizedFxGainAccountId: string;
  realizedFxLossAccountId: string;

  unrealizedFxGainAccountId?: string;
  unrealizedFxLossAccountId?: string;

  /** Posting differences from currency rounding go here — never an unbalanced journal. */
  currencyRoundingAccountId?: string;

  cumulativeTranslationAdjustmentAccountId?: string;
  revaluationJournalTemplateId?: string;

  rateType: EntityRateType;

  allowManualRateOverride: boolean;
  requireOverrideReason: boolean;

  /** Variance thresholds for manual rate overrides. */
  rateVariancePolicy?: RateVariancePolicy;
  revaluationReversalPolicy?: RevaluationReversalPolicy;

  createdAt: string;
  updatedAt: string;
}

/** Attached to a customer/supplier to drive default currency resolution. */
export interface PartyCurrencyProfile {
  preferredCurrencyCode?: string;
  allowedCurrencyCodes?: string[];
  defaultExchangeRateType?: EntityRateType;
  allowCurrencyOverride?: boolean;
}

/** Whether a foreign-currency balance is revalued at period end. */
export type FxAccountClassification = 'monetary' | 'non-monetary' | 'not-applicable';

export interface MonetaryAccountCurrencyConfig {
  accountId: string;
  currencyCode: string;
  allowForeignTransactions: boolean;
  classification?: FxAccountClassification;
}

export interface RateVariancePolicy {
  warningThresholdPercent: number;
  blockingThresholdPercent?: number;
  requireApprovalAbovePercent?: number;
}

export type RevaluationReversalPolicy = 'reverse-next-day' | 'reverse-next-period' | 'carry-forward';

/* ── Field-level derived accessors (legacy records lack v2 fields) ────────── */

/** Effective currency type — legacy records without one are fiat. */
export function currencyTypeOf(c: Pick<Currency, 'currencyType'>): CurrencyType {
  return c.currencyType ?? 'fiat';
}

/** Effective monetary precision (explicit, never assumed 2 — 2 is only the
 *  fallback for records that predate explicit configuration). */
export function monetaryDecimalsOf(c: Pick<Currency, 'decimalPlaces'> | undefined): number {
  return c?.decimalPlaces ?? 2;
}

/** Effective exchange-rate precision for this currency. */
export function rateDecimalsOf(c: Pick<Currency, 'exchangeRateDecimalPlaces'> | undefined): number {
  return c?.exchangeRateDecimalPlaces ?? DEFAULT_RATE_DECIMALS;
}

/** Effective rounding method (default half-up = ties away from zero). */
export function roundingMethodOf(c: Pick<Currency, 'roundingMethod'> | undefined): RoundingMethod {
  return c?.roundingMethod ?? 'half-up';
}

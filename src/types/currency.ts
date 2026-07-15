/**
 * Currency master data and entity currency configuration — the centralized
 * currency/FX engine's static model. Decimal precision is explicit per currency
 * (never inferred from the symbol); one base currency per entity; foreign
 * currencies must be explicitly enabled.
 */

export type CurrencyStatus = 'active' | 'inactive' | 'archived';

export type SymbolPosition = 'before' | 'after';
export type DecimalSeparator = '.' | ',';
export type ThousandSeparator = ',' | '.' | ' ' | '';
export type NegativeFormat = '-1,234.56' | '(1,234.56)';

export interface CurrencyAuditEvent {
  id: string;
  at: string;
  action: string;
  detail?: string;
  by?: string;
}

export interface Currency {
  id: string;

  code: string;
  name: string;
  symbol: string;

  decimalPlaces: number;
  minorUnitName?: string;
  majorUnitName?: string;

  symbolPosition: SymbolPosition;
  decimalSeparator: DecimalSeparator;
  thousandSeparator: ThousandSeparator;
  negativeFormat: NegativeFormat;

  /** Smallest cash increment (e.g. 0.05); undefined → 10^-decimalPlaces. */
  roundingIncrement?: number;

  status: CurrencyStatus;
  countryCodes?: string[];

  auditTrail: CurrencyAuditEvent[];
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}

export type EntityRateType = 'mid' | 'buy' | 'sell' | 'custom';

export interface EntityCurrencyConfig {
  entityId: string;

  baseCurrencyCode: string;
  allowedCurrencyCodes: string[];

  defaultSalesCurrencyCode?: string;
  defaultPurchaseCurrencyCode?: string;

  realizedFxGainAccountId: string;
  realizedFxLossAccountId: string;

  unrealizedFxGainAccountId?: string;
  unrealizedFxLossAccountId?: string;

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

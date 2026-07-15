/**
 * Exchange-rate model and the frozen snapshot stored on posted documents.
 *
 * Convention (single, never mixed): `1 unit of fromCurrency = rate units of
 * toCurrency`. Rates are effective-dated; posted documents freeze the rate they
 * used so later rate edits never retranslate history.
 */

export type ExchangeRateSource = 'manual' | 'bank' | 'central-bank' | 'market-provider' | 'import' | 'system' | 'custom';

export type ExchangeRateType = 'mid' | 'buy' | 'sell' | 'custom';

export type ExchangeRateStatus = 'active' | 'superseded' | 'inactive';

export interface ExchangeRate {
  id: string;
  entityId: string;

  fromCurrencyCode: string;
  toCurrencyCode: string;

  rate: number;
  inverseRate: number;

  rateType: ExchangeRateType;
  source: ExchangeRateSource;

  effectiveDate: string;
  effectiveTime?: string;

  status: ExchangeRateStatus;

  sourceReference?: string;
  notes?: string;

  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}

/** The frozen rate captured on a posted foreign-currency document. */
export interface ExchangeRateSnapshot {
  fromCurrencyCode: string;
  toCurrencyCode: string;

  rate: number;
  inverseRate: number;

  rateType: ExchangeRateType;
  source: ExchangeRateSource;

  effectiveDate: string;
  effectiveTime?: string;

  sourceReference?: string;

  /** Manual-override audit (§39): the resolved rate vs the entered rate. */
  overrideReason?: string;
  resolvedRate?: number;
  overrideRate?: number;

  capturedAt: string;
}

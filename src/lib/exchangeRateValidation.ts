import type { ExchangeRate } from '@/types/exchangeRate';

export interface RateIssue {
  severity: 'error' | 'warning';
  rule: string;
  message: string;
}

export const INVERSE_TOLERANCE = 0.0001;

export interface ExchangeRateValidationContext {
  existingRates: ExchangeRate[];
  /** Rate ids already referenced by a posted snapshot (cannot be deleted/edited). */
  usedRateIds?: Set<string>;
}

/**
 * Validate an exchange rate (§38, §54): positive rate, a real pair, reconciling
 * inverse, a valid date, and no unauthorised duplicate timestamp for the pair.
 */
export function validateExchangeRate(rate: ExchangeRate, ctx: ExchangeRateValidationContext): RateIssue[] {
  const issues: RateIssue[] = [];
  const err = (rule: string, message: string) => issues.push({ severity: 'error', rule, message });

  const same = rate.fromCurrencyCode.toUpperCase() === rate.toCurrencyCode.toUpperCase();
  if (!rate.fromCurrencyCode || !rate.toCurrencyCode) err('pair', 'Both currencies are required.');
  if (same && Math.abs(rate.rate - 1) > INVERSE_TOLERANCE) err('identity', 'A same-currency rate must be exactly 1 (base identity).');
  if (!(Number(rate.rate) > 0)) err('positive', 'The rate must be greater than zero.');
  if (!rate.effectiveDate) err('date', 'An effective date is required.');
  if (rate.inverseRate && rate.rate) {
    const reconciled = Math.abs(rate.inverseRate - 1 / rate.rate);
    if (reconciled > INVERSE_TOLERANCE) issues.push({ severity: 'warning', rule: 'inverse', message: `Inverse rate ${rate.inverseRate} does not reconcile with 1/${rate.rate}.` });
  }
  if (!rate.source) err('source', 'A rate source is required.');

  const duplicate = ctx.existingRates.some(
    (r) => r.id !== rate.id && r.entityId === rate.entityId && r.fromCurrencyCode === rate.fromCurrencyCode && r.toCurrencyCode === rate.toCurrencyCode &&
      r.rateType === rate.rateType && r.effectiveDate === rate.effectiveDate && (r.effectiveTime ?? '') === (rate.effectiveTime ?? '') && r.status === 'active' && rate.status === 'active',
  );
  if (duplicate) err('duplicate', 'An active rate already exists for this pair and rate type at that effective timestamp.');

  return issues;
}

export function canSaveExchangeRate(rate: ExchangeRate, ctx: ExchangeRateValidationContext): boolean {
  return validateExchangeRate(rate, ctx).every((i) => i.severity !== 'error');
}

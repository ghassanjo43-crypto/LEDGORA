import type { Account } from '@/types';
import type { Currency, EntityCurrencyConfig } from '@/types/currency';
import { MAX_MONETARY_DECIMALS, MAX_RATE_DECIMALS } from '@/types/currency';
import type { ExchangeRate } from '@/types/exchangeRate';
import { isPostingAccount } from '@/lib/journalValidation';
import { resolveExchangeRate } from '@/lib/exchangeRateResolution';
import {
  isDuplicateCurrencyCode,
  isIncrementCompatible,
  isValidMonetaryPrecision,
  isValidRatePrecision,
  validateCurrencyCodeFormat,
} from '@/lib/currencyMaster';

export interface CurrencyIssue {
  severity: 'error' | 'warning';
  rule: string;
  message: string;
}

/**
 * Currency master validation (§54): unique case-insensitive code (3-letter ISO
 * for standard currencies, up to 12 chars for custom codes like USDT or
 * INTERNAL-UNIT), monetary precision 0–18, exchange-rate precision 0–18, and a
 * rounding increment compatible with the monetary precision.
 */
export function validateCurrency(currency: Currency, existing: Currency[]): CurrencyIssue[] {
  const issues: CurrencyIssue[] = [];
  const err = (rule: string, message: string) => issues.push({ severity: 'error', rule, message });
  const codeError = validateCurrencyCodeFormat(currency.code, { isIso: currency.isIso });
  if (codeError) err('code', codeError);
  else if (isDuplicateCurrencyCode(currency.code, existing, currency.id)) err('code-unique', `Currency ${currency.code.trim().toUpperCase()} already exists.`);
  if (!currency.name.trim()) err('name', 'A currency name is required.');
  if (!currency.symbol.trim()) err('symbol', 'A currency symbol is required.');
  if (!isValidMonetaryPrecision(currency.decimalPlaces)) err('decimals', `Monetary decimal places must be an integer between 0 and ${MAX_MONETARY_DECIMALS}.`);
  if (currency.exchangeRateDecimalPlaces !== undefined && !isValidRatePrecision(currency.exchangeRateDecimalPlaces)) err('rate-decimals', `Exchange-rate decimal places must be an integer between 0 and ${MAX_RATE_DECIMALS}.`);
  if (currency.roundingIncrement !== undefined && currency.roundingIncrement < 0) err('increment', 'Rounding increment cannot be negative.');
  else if (isValidMonetaryPrecision(currency.decimalPlaces) && !isIncrementCompatible(currency.roundingIncrement, currency.decimalPlaces)) {
    err('increment-precision', `Rounding increment ${currency.roundingIncrement} is not representable at ${currency.decimalPlaces} decimal places.`);
  }
  if (currency.effectiveFrom && currency.effectiveTo && currency.effectiveTo < currency.effectiveFrom) err('effective-window', 'Effective-to must not precede effective-from.');
  return issues;
}

/** Base-currency rules: exactly one, selected from active master records. */
export function validateBaseCurrencySelection(code: string, currencies: Currency[]): CurrencyIssue[] {
  const cur = currencies.find((c) => c.code.toUpperCase() === code.toUpperCase());
  if (!cur) return [{ severity: 'error', rule: 'base-missing', message: `Base currency ${code} is not defined in the Currency Master.` }];
  if (cur.status !== 'active') return [{ severity: 'error', rule: 'base-inactive', message: `Base currency ${code} is ${cur.status}; the base currency must be active.` }];
  return [];
}

/** A currency is usable by an entity when enabled and active. */
export function validateCurrencyForEntity(code: string, config: EntityCurrencyConfig, currencies: Currency[]): CurrencyIssue[] {
  const issues: CurrencyIssue[] = [];
  const cur = currencies.find((c) => c.code === code);
  if (!cur) return [{ severity: 'error', rule: 'missing', message: `Currency ${code} is not defined.` }];
  if (cur.status !== 'active') issues.push({ severity: 'error', rule: 'inactive', message: `Currency ${code} is ${cur.status} and cannot be used on new transactions.` });
  if (!config.allowedCurrencyCodes.includes(code) && code !== config.baseCurrencyCode) issues.push({ severity: 'error', rule: 'not-enabled', message: `Currency ${code} is not enabled for this entity.` });
  return issues;
}

export interface TransactionCurrencyContext {
  config: EntityCurrencyConfig;
  currencies: Currency[];
  rates: ExchangeRate[];
  transactionDate: string;
}

/**
 * Transaction currency validation (§54): enabled + active currency, and a rate
 * resolvable on the document date (never silently 1.0 for a foreign currency).
 */
export function validateCurrencyForTransaction(code: string, ctx: TransactionCurrencyContext): CurrencyIssue[] {
  const issues = validateCurrencyForEntity(code, ctx.config, ctx.currencies);
  if (issues.some((i) => i.severity === 'error')) return issues;
  if (code !== ctx.config.baseCurrencyCode) {
    const resolution = resolveExchangeRate({ entityId: ctx.config.entityId, fromCurrencyCode: code, toCurrencyCode: ctx.config.baseCurrencyCode, transactionDate: ctx.transactionDate, rates: ctx.rates, allowTriangulation: true, baseCurrencyCode: ctx.config.baseCurrencyCode });
    if (!resolution.ok) issues.push({ severity: 'error', rule: 'no-rate', message: resolution.error ?? `No exchange rate for ${code} on ${ctx.transactionDate}.` });
  }
  return issues;
}

/** Validate the entity currency configuration's FX account mappings. */
export function validateEntityCurrencyConfig(config: EntityCurrencyConfig, accountsById: Map<string, Account>): CurrencyIssue[] {
  const issues: CurrencyIssue[] = [];
  const err = (rule: string, message: string) => issues.push({ severity: 'error', rule, message });
  const posting = (id: string | undefined): boolean => !!id && isPostingAccount(accountsById.get(id));
  if (!config.baseCurrencyCode) err('base', 'A base currency is required.');
  if (!posting(config.realizedFxGainAccountId)) err('realized-gain', 'Realized FX gain account must be a posting account.');
  if (!posting(config.realizedFxLossAccountId)) err('realized-loss', 'Realized FX loss account must be a posting account.');
  if (config.unrealizedFxGainAccountId && !posting(config.unrealizedFxGainAccountId)) err('unrealized-gain', 'Unrealized FX gain account must be a posting account.');
  if (config.unrealizedFxLossAccountId && !posting(config.unrealizedFxLossAccountId)) err('unrealized-loss', 'Unrealized FX loss account must be a posting account.');
  return issues;
}

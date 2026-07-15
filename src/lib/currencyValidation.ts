import type { Account } from '@/types';
import type { Currency, EntityCurrencyConfig } from '@/types/currency';
import type { ExchangeRate } from '@/types/exchangeRate';
import { isPostingAccount } from '@/lib/journalValidation';
import { resolveExchangeRate } from '@/lib/exchangeRateResolution';

export interface CurrencyIssue {
  severity: 'error' | 'warning';
  rule: string;
  message: string;
}

/** Currency master validation (§54): unique code, valid decimals & symbol. */
export function validateCurrency(currency: Currency, existing: Currency[]): CurrencyIssue[] {
  const issues: CurrencyIssue[] = [];
  const err = (rule: string, message: string) => issues.push({ severity: 'error', rule, message });
  if (!/^[A-Za-z]{3}$/.test(currency.code.trim())) err('code', 'Currency code should be a 3-letter ISO code.');
  else if (existing.some((c) => c.id !== currency.id && c.code.trim().toUpperCase() === currency.code.trim().toUpperCase())) err('code-unique', `Currency ${currency.code} already exists.`);
  if (!currency.name.trim()) err('name', 'A currency name is required.');
  if (!currency.symbol.trim()) err('symbol', 'A currency symbol is required.');
  if (currency.decimalPlaces < 0 || currency.decimalPlaces > 6 || !Number.isInteger(currency.decimalPlaces)) err('decimals', 'Decimal places must be an integer between 0 and 6.');
  if (currency.roundingIncrement !== undefined && currency.roundingIncrement < 0) err('increment', 'Rounding increment cannot be negative.');
  return issues;
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

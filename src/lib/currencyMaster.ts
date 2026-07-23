/**
 * Currency Master workflow logic — custom-currency creation, code rules,
 * legacy-record migration, base-currency change protection and usage reporting.
 *
 * Code rules: standard ISO currencies keep strict 3-letter codes; custom
 * currencies (tokens, internal units, commodities) may use longer codes such as
 * USDT, TOKEN1 or INTERNAL-UNIT. Codes are case-insensitive-unique per scope.
 */
import type { Currency, CurrencyType } from '@/types/currency';
import {
  DEFAULT_RATE_DECIMALS,
  MAX_MONETARY_DECIMALS,
  MAX_RATE_DECIMALS,
  MIN_MONETARY_DECIMALS,
  MIN_RATE_DECIMALS,
} from '@/types/currency';
import { findCatalogEntry } from '@/data/currencyCatalog';
import { decIsZero, decMul, decRound, decSub, isDecimal } from '@/lib/decimal';

export const ISO_CODE_PATTERN = /^[A-Z]{3}$/;
/** Custom codes: 2–16 chars, A–Z 0–9 and '-', starting alphanumeric (USDT, TOKEN1, INTERNAL-UNIT). */
export const CUSTOM_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,15}$/;

export function normalizeCurrencyCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Null when valid; otherwise the reason the code is rejected. */
export function validateCurrencyCodeFormat(code: string, opts: { isIso?: boolean } = {}): string | null {
  const normalized = normalizeCurrencyCode(code);
  if (!normalized) return 'A currency code is required.';
  if (opts.isIso) {
    return ISO_CODE_PATTERN.test(normalized) ? null : 'A standard ISO currency code must be exactly 3 letters.';
  }
  if (ISO_CODE_PATTERN.test(normalized) || CUSTOM_CODE_PATTERN.test(normalized)) return null;
  return 'Currency codes must be 2–16 characters using letters, digits or "-", starting with a letter or digit.';
}

/** Case-insensitive duplicate check within the currency scope. */
export function isDuplicateCurrencyCode(code: string, existing: Currency[], selfId?: string): boolean {
  const normalized = normalizeCurrencyCode(code);
  return existing.some((c) => c.id !== selfId && normalizeCurrencyCode(c.code) === normalized);
}

export function isValidMonetaryPrecision(dp: number): boolean {
  return Number.isInteger(dp) && dp >= MIN_MONETARY_DECIMALS && dp <= MAX_MONETARY_DECIMALS;
}

export function isValidRatePrecision(dp: number): boolean {
  return Number.isInteger(dp) && dp >= MIN_RATE_DECIMALS && dp <= MAX_RATE_DECIMALS;
}

/**
 * A rounding increment must be positive, decimal-parsable and representable at
 * the currency's monetary precision (0.05 is valid at 2 dp; 0.001 is not).
 */
export function isIncrementCompatible(increment: number | string | undefined, decimalPlaces: number): boolean {
  if (increment === undefined || increment === '') return true;
  if (!isDecimal(increment)) return false;
  const inc = String(increment);
  if (decIsZero(inc)) return false;
  if (inc.startsWith('-')) return false;
  // Representable ⇔ rounding the increment to the currency precision is lossless.
  return decIsZero(decSub(inc, decRound(inc, decimalPlaces, 'toward-zero')));
}

/* ── Custom currency creation ─────────────────────────────────────────────── */

export interface CustomCurrencyInput {
  code: string;
  name: string;
  symbol: string;
  currencyType: CurrencyType;
  decimalPlaces: number;
  exchangeRateDecimalPlaces?: number;
  localizedName?: string;
  region?: string;
  minorUnitName?: string;
  minorUnitPluralName?: string;
  roundingMethod?: Currency['roundingMethod'];
  roundingIncrement?: number;
  symbolPosition?: Currency['symbolPosition'];
  symbolSpacing?: boolean;
  decimalSeparator?: Currency['decimalSeparator'];
  thousandSeparator?: Currency['thousandSeparator'];
  negativeFormat?: Currency['negativeFormat'];
  status?: Currency['status'];
  effectiveFrom?: string;
  effectiveTo?: string;
}

/** Build a Currency Master record for an organization-defined custom currency. */
export function buildCustomCurrency(
  input: CustomCurrencyInput,
  meta: { id: string; now: string; by?: string },
): Currency {
  return {
    id: meta.id,
    code: normalizeCurrencyCode(input.code),
    name: input.name.trim(),
    symbol: input.symbol.trim() || normalizeCurrencyCode(input.code),
    localizedName: input.localizedName,
    currencyType: input.currencyType,
    isIso: false,
    region: input.region,
    decimalPlaces: input.decimalPlaces,
    exchangeRateDecimalPlaces: input.exchangeRateDecimalPlaces ?? DEFAULT_RATE_DECIMALS,
    minorUnitName: input.minorUnitName,
    minorUnitPluralName: input.minorUnitPluralName,
    symbolPosition: input.symbolPosition ?? 'before',
    symbolSpacing: input.symbolSpacing ?? false,
    decimalSeparator: input.decimalSeparator ?? '.',
    thousandSeparator: input.thousandSeparator ?? ',',
    negativeFormat: input.negativeFormat ?? '-1,234.56',
    roundingMethod: input.roundingMethod ?? 'half-up',
    roundingIncrement: input.roundingIncrement,
    status: input.status ?? 'active',
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    auditTrail: [{ id: `${meta.id}_created`, at: meta.now, action: 'custom-currency-created', detail: `Custom ${input.currencyType} currency`, by: meta.by }],
    createdAt: meta.now,
    updatedAt: meta.now,
    createdBy: meta.by,
  };
}

/* ── Legacy migration ─────────────────────────────────────────────────────── */

/**
 * Upgrade a v1 persisted currency record to the v2 Currency Master shape.
 * Preserves codes, precision and formatting exactly; only fills the fields v1
 * records never had (type, ISO metadata, exchange-rate precision, rounding
 * method). Never rewrites amounts — this touches definitions only.
 */
export function upgradeCurrencyRecord(record: Currency): Currency {
  if (record.currencyType !== undefined && record.exchangeRateDecimalPlaces !== undefined) return record;
  const catalog = findCatalogEntry(record.code);
  return {
    ...record,
    currencyType: record.currencyType ?? catalog?.type ?? 'fiat',
    isIso: record.isIso ?? (catalog ? catalog.isIso : ISO_CODE_PATTERN.test(normalizeCurrencyCode(record.code))),
    isoNumericCode: record.isoNumericCode ?? catalog?.isoNumericCode,
    region: record.region ?? catalog?.region,
    exchangeRateDecimalPlaces: record.exchangeRateDecimalPlaces ?? catalog?.rateDecimals ?? DEFAULT_RATE_DECIMALS,
    minorUnitName: record.minorUnitName ?? catalog?.minorUnitName,
    minorUnitPluralName: record.minorUnitPluralName ?? catalog?.minorUnitPluralName,
    roundingMethod: record.roundingMethod ?? 'half-up',
  };
}

/** Currency codes referenced by records but missing from the master (for the migration report). */
export function findUnknownCurrencyCodes(usedCodes: Iterable<string>, currencies: Currency[]): string[] {
  const known = new Set(currencies.map((c) => normalizeCurrencyCode(c.code)));
  const unknown = new Set<string>();
  for (const code of usedCodes) {
    const normalized = normalizeCurrencyCode(code);
    if (normalized && !known.has(normalized)) unknown.add(normalized);
  }
  return [...unknown].sort();
}

/* ── Editing & base-currency safeguards ───────────────────────────────────── */

/** Accounting-critical fields that need controlled changes once a currency is used. */
export const ACCOUNTING_CRITICAL_FIELDS: Array<keyof Currency> = [
  'code', 'decimalPlaces', 'roundingIncrement', 'roundingMethod', 'currencyType',
];

/** True when a patch touches a field that would alter posted-amount semantics. */
export function patchTouchesCriticalFields(existing: Currency, patch: Partial<Currency>): boolean {
  return ACCOUNTING_CRITICAL_FIELDS.some(
    (field) => patch[field] !== undefined && patch[field] !== existing[field],
  );
}

export interface GuardResult {
  ok: boolean;
  error?: string;
}

/**
 * Once a currency appears on transactions, accounting-critical edits require
 * elevated permission and explicit confirmation — display fields stay free.
 * Prefer creating a NEW currency definition over destructive precision changes.
 */
export function guardCriticalCurrencyEdit(params: {
  inUse: boolean;
  elevated: boolean;
  confirmedImpact: boolean;
}): GuardResult {
  if (!params.inUse) return { ok: true };
  if (!params.elevated) {
    return { ok: false, error: 'This currency is already used on transactions. Changing its code, precision or rounding requires an administrator.' };
  }
  if (!params.confirmedImpact) {
    return { ok: false, error: 'Confirm the impact analysis before changing accounting-critical settings of a used currency. Historical values are never rewritten.' };
  }
  return { ok: true };
}

/** Details a controlled base-currency migration must supply once postings exist. */
export interface BaseCurrencyMigration {
  effectiveDate: string;
  exchangeRateSource: string;
  confirmedBy: string;
}

/**
 * The base currency is freely changeable only while no accounting transactions
 * have been posted. Afterwards it requires the controlled migration workflow.
 */
export function guardBaseCurrencyChange(params: {
  hasPostedTransactions: boolean;
  elevated: boolean;
  migration?: BaseCurrencyMigration;
}): GuardResult {
  if (!params.hasPostedTransactions) return { ok: true };
  if (!params.elevated) {
    return { ok: false, error: 'Posted transactions exist — changing the base currency requires an administrator using the controlled migration workflow.' };
  }
  const m = params.migration;
  if (!m || !m.effectiveDate || !m.exchangeRateSource || !m.confirmedBy) {
    return { ok: false, error: 'A base-currency migration needs an effective date, an exchange-rate source and explicit confirmation. Historical journals are never silently recalculated.' };
  }
  return { ok: true };
}

/* ── Usage reporting (drives "already used" warnings and edit guards) ─────── */

/** Merge currency codes referenced across document sets into one usage set. */
export function collectUsedCurrencyCodes(...codeSets: Array<Iterable<string | undefined>>): Set<string> {
  const used = new Set<string>();
  for (const set of codeSets) {
    for (const code of set) {
      if (code) used.add(normalizeCurrencyCode(code));
    }
  }
  return used;
}

/** Sample preview row for the settings page ("Entered 1234.5678 → JOD 1,234.568"). */
export function precisionPreview(value: string, currency: Pick<Currency, 'decimalPlaces' | 'roundingMethod'>): string {
  return decRound(value, currency.decimalPlaces, currency.roundingMethod ?? 'half-up');
}

/** Decimal-safe conversion preview: amount × rate at the target precision. */
export function conversionPreview(
  amount: string,
  rate: string,
  target: Pick<Currency, 'decimalPlaces' | 'roundingMethod'>,
): string {
  return decRound(decMul(amount, rate), target.decimalPlaces, target.roundingMethod ?? 'half-up');
}

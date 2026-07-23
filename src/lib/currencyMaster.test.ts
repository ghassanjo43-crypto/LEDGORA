import { describe, it, expect, beforeEach } from 'vitest';
import type { Currency } from '@/types/currency';
import { monetaryDecimalsOf, rateDecimalsOf } from '@/types/currency';
import {
  buildCustomCurrency, findUnknownCurrencyCodes, guardBaseCurrencyChange,
  guardCriticalCurrencyEdit, isDuplicateCurrencyCode, isIncrementCompatible,
  normalizeCurrencyCode, patchTouchesCriticalFields, upgradeCurrencyRecord,
  validateCurrencyCodeFormat, collectUsedCurrencyCodes, precisionPreview, conversionPreview,
} from '@/lib/currencyMaster';
import { validateCurrency, validateBaseCurrencySelection, validateCurrencyForEntity } from '@/lib/currencyValidation';
import { formatCurrencyAmount, formatNumber, formatWithCode } from '@/lib/currencyFormatting';
import { convertAmountDec, inverseRateDec, ratePrecisionFor, roundCurrencyAmountDec } from '@/lib/currencyConversion';
import { assertCurrencyPermission, roleHasCurrencyPermission } from '@/lib/currencyPermissions';
import { findCatalogEntry } from '@/data/currencyCatalog';
import { SEED_CURRENCIES, SEED_ENTITY_CURRENCY_CONFIG } from '@/data/currencySeed';
import { useCurrencyStore } from '@/store/currencyStore';
import { useExchangeRateStore } from '@/store/exchangeRateStore';
import { useJournalStore } from '@/store/journalStore';

const base = (over: Partial<Currency>): Currency => ({
  id: 'c1', code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2,
  symbolPosition: 'before', decimalSeparator: '.', thousandSeparator: ',',
  negativeFormat: '-1,234.56', status: 'active', auditTrail: [], createdAt: '', updatedAt: '',
  ...over,
});

beforeEach(() => {
  useCurrencyStore.getState().resetToDefault();
  useExchangeRateStore.getState().resetToDefault();
  useJournalStore.getState().resetToDefault();
});

/* ───────────── Currency codes: ISO + custom ───────────── */

describe('currency codes', () => {
  it('accepts 3-letter ISO codes and longer custom codes', () => {
    for (const code of ['USD', 'USDT', 'USDC', 'XAU', 'TOKEN1', 'PTS', 'INTERNAL-UNIT']) {
      expect(validateCurrencyCodeFormat(code)).toBeNull();
    }
  });
  it('enforces strict 3-letter codes for ISO currencies', () => {
    expect(validateCurrencyCodeFormat('USDT', { isIso: true })).toContain('3 letters');
    expect(validateCurrencyCodeFormat('USD', { isIso: true })).toBeNull();
  });
  it('rejects blank and malformed codes', () => {
    expect(validateCurrencyCodeFormat('')).toBeTruthy();
    expect(validateCurrencyCodeFormat('-BAD')).toBeTruthy();
    expect(validateCurrencyCodeFormat('WAY-TOO-LONG-CODE')).toBeTruthy();
  });
  it('detects duplicates case-insensitively', () => {
    const existing = [base({ id: 'a', code: 'usdt' })];
    expect(isDuplicateCurrencyCode('USDT', existing)).toBe(true);
    expect(isDuplicateCurrencyCode('USDT', existing, 'a')).toBe(false);
    expect(normalizeCurrencyCode(' usdt ')).toBe('USDT');
  });
});

/* ───────────── Precision configuration ───────────── */

describe('precision configuration', () => {
  it('accepts 0–18 monetary decimals and rejects out-of-range values', () => {
    expect(validateCurrency(base({ decimalPlaces: 0 }), []).length).toBe(0);
    expect(validateCurrency(base({ decimalPlaces: 18 }), []).length).toBe(0);
    expect(validateCurrency(base({ decimalPlaces: 19 }), []).some((i) => i.rule === 'decimals')).toBe(true);
    expect(validateCurrency(base({ decimalPlaces: -1 }), []).some((i) => i.rule === 'decimals')).toBe(true);
    expect(validateCurrency(base({ decimalPlaces: 2.5 }), []).some((i) => i.rule === 'decimals')).toBe(true);
  });
  it('validates exchange-rate precision independently (0–18)', () => {
    expect(validateCurrency(base({ exchangeRateDecimalPlaces: 12 }), []).length).toBe(0);
    expect(validateCurrency(base({ exchangeRateDecimalPlaces: 19 }), []).some((i) => i.rule === 'rate-decimals')).toBe(true);
  });
  it('requires the rounding increment to be representable at the monetary precision', () => {
    expect(isIncrementCompatible(0.05, 2)).toBe(true);
    expect(isIncrementCompatible(0.001, 2)).toBe(false);
    expect(isIncrementCompatible(0.001, 3)).toBe(true);
    expect(isIncrementCompatible(undefined, 2)).toBe(true);
    expect(validateCurrency(base({ roundingIncrement: 0.001 }), []).some((i) => i.rule === 'increment-precision')).toBe(true);
  });
});

/* ───────────── Custom currency creation ───────────── */

describe('custom currency creation', () => {
  it('creates a custom fiat currency', () => {
    const r = useCurrencyStore.getState().createCustomCurrency({
      code: 'ZWG', name: 'Zimbabwe Gold', symbol: 'ZiG', currencyType: 'fiat', decimalPlaces: 2,
    });
    expect(r.ok).toBe(true);
    const cur = useCurrencyStore.getState().getCurrency('ZWG')!;
    expect(cur.isIso).toBe(false);
    expect(monetaryDecimalsOf(cur)).toBe(2);
  });
  it('creates a custom token with high precision and long code', () => {
    const r = useCurrencyStore.getState().createCustomCurrency({
      code: 'INTERNAL-UNIT', name: 'Internal Unit', symbol: 'IU', currencyType: 'internal',
      decimalPlaces: 8, exchangeRateDecimalPlaces: 12,
    });
    expect(r.ok).toBe(true);
    const cur = useCurrencyStore.getState().getCurrency('internal-unit')!;
    expect(cur.code).toBe('INTERNAL-UNIT');
    expect(rateDecimalsOf(cur)).toBe(12);
  });
  it('rejects duplicate codes case-insensitively', () => {
    const store = useCurrencyStore.getState();
    expect(store.createCustomCurrency({ code: 'PTS', name: 'Points', symbol: 'pts', currencyType: 'internal', decimalPlaces: 0 }).ok).toBe(true);
    const dup = useCurrencyStore.getState().createCustomCurrency({ code: 'pts', name: 'Points 2', symbol: 'p', currencyType: 'internal', decimalPlaces: 0 });
    expect(dup.ok).toBe(false);
    expect(dup.error).toMatch(/already exists/i);
  });
  it('rejects invalid precision', () => {
    const r = useCurrencyStore.getState().createCustomCurrency({ code: 'TOKEN1', name: 'Token', symbol: 'T', currencyType: 'digital-token', decimalPlaces: 25 });
    expect(r.ok).toBe(false);
  });
  it('builds an audited record', () => {
    const cur = buildCustomCurrency(
      { code: 'xau2', name: 'Gold grams', symbol: 'g', currencyType: 'commodity', decimalPlaces: 6 },
      { id: 'cur_x', now: '2026-07-23T00:00:00.000Z', by: 'Tester' },
    );
    expect(cur.code).toBe('XAU2');
    expect(cur.auditTrail[0]!.action).toBe('custom-currency-created');
    expect(cur.auditTrail[0]!.by).toBe('Tester');
  });
});

/* ───────────── Standard catalog ───────────── */

describe('standard catalog', () => {
  it('seeds the required currencies with correct default precision', () => {
    const expected: Record<string, number> = { AED: 2, BHD: 3, JOD: 3, JPY: 0, KWD: 3, OMR: 3, IQD: 3, USD: 2, EUR: 2, TRY: 2, EGP: 2, SAR: 2, QAR: 2, CHF: 2, CNY: 2, GBP: 2, INR: 2, CAD: 2, AUD: 2 };
    for (const [code, dp] of Object.entries(expected)) {
      const entry = findCatalogEntry(code);
      expect(entry, code).toBeDefined();
      expect(entry!.decimals, code).toBe(dp);
      expect(SEED_CURRENCIES.some((c) => c.code === code && c.status === 'active'), code).toBe(true);
    }
  });
  it('includes crypto/token reference entries that are seeded inactive (opt-in)', () => {
    expect(findCatalogEntry('BTC')!.decimals).toBe(8);
    expect(findCatalogEntry('ETH')!.decimals).toBe(18);
    expect(SEED_CURRENCIES.find((c) => c.code === 'BTC')!.status).toBe('inactive');
  });
  it('activates a catalog currency on demand', () => {
    const r = useCurrencyStore.getState().activateStandardCurrency('BTC');
    expect(r.ok).toBe(true);
    expect(useCurrencyStore.getState().getCurrency('BTC')!.status).toBe('active');
  });
  it('does not limit users to the catalog', () => {
    expect(useCurrencyStore.getState().activateStandardCurrency('NOPE').ok).toBe(false);
    expect(useCurrencyStore.getState().createCustomCurrency({ code: 'NOPE', name: 'Custom', symbol: 'N', currencyType: 'custom', decimalPlaces: 4 }).ok).toBe(true);
  });
});

/* ───────────── Formatting by currency precision ───────────── */

describe('formatting', () => {
  const jod = SEED_CURRENCIES.find((c) => c.code === 'JOD')!;
  const jpy = SEED_CURRENCIES.find((c) => c.code === 'JPY')!;
  const btc = SEED_CURRENCIES.find((c) => c.code === 'BTC')!;

  it('matches the specification examples', () => {
    expect(formatWithCode('1234.5678', jod)).toBe('JOD 1,234.568');
    expect(formatWithCode('1234.56', jpy)).toBe('JPY 1,235');
    expect(formatWithCode('0.000123456789', btc)).toBe('BTC 0.00012346');
  });
  it('never adds trailing decimals to zero-decimal currencies', () => {
    expect(formatNumber('1250', jpy)).toBe('1,250');
  });
  it('never truncates high-precision currencies', () => {
    expect(formatNumber('1250', jod)).toBe('1,250.000');
    expect(formatNumber('0.00012500', btc)).toBe('0.00012500');
  });
  it('supports all three negative formats', () => {
    const usd = base({});
    expect(formatCurrencyAmount('-1000', { ...usd, negativeFormat: '-1,234.56' })).toBe('-$1,000.00');
    expect(formatCurrencyAmount('-1000', { ...usd, negativeFormat: '(1,234.56)' })).toBe('($1,000.00)');
    expect(formatCurrencyAmount('-1000', { ...usd, negativeFormat: '1,234.56-' })).toBe('$1,000.00-');
  });
  it('honours symbol position and spacing', () => {
    expect(formatCurrencyAmount('5', base({ symbolSpacing: true }))).toBe('$ 5.00');
    expect(formatCurrencyAmount('5', base({ symbolPosition: 'after', symbol: 'AED' }))).toBe('5.00 AED');
  });
  it('applies the currency rounding method when formatting', () => {
    expect(formatNumber('2.675', base({ roundingMethod: 'half-even' }))).toBe('2.68');
    expect(formatNumber('2.665', base({ roundingMethod: 'half-even' }))).toBe('2.66');
    expect(formatNumber('2.669', base({ roundingMethod: 'toward-zero' }))).toBe('2.66');
  });
  it('applies rounding increments (0.05 cash rounding)', () => {
    expect(formatNumber('1.02', base({ roundingIncrement: 0.05 }))).toBe('1.00');
    expect(formatNumber('1.03', base({ roundingIncrement: 0.05 }))).toBe('1.05');
  });
  it('a value that rounds to zero is not shown negative', () => {
    expect(formatCurrencyAmount('-0.001', base({ negativeFormat: '(1,234.56)' }))).toBe('$0.00');
  });
});

/* ───────────── Conversion & exchange-rate precision ───────────── */

describe('conversion & rate precision', () => {
  it('converts decimal-safely at the target currency precision', () => {
    const jod = SEED_CURRENCIES.find((c) => c.code === 'JOD')!;
    expect(convertAmountDec('1000', '0.709', jod)).toBe('709.000');
    expect(convertAmountDec('1234.5678', '0.709', jod)).toBe('875.309');
  });
  it('respects per-currency exchange-rate precision', () => {
    const btc = SEED_CURRENCIES.find((c) => c.code === 'BTC')!;
    const usd = SEED_CURRENCIES.find((c) => c.code === 'USD')!;
    expect(ratePrecisionFor(usd, btc)).toBe(12);
    expect(inverseRateDec('67000', 12)).toBe('0.000014925373');
  });
  it('keeps the entered direction authoritative — a rounded inverse does not round-trip', () => {
    const inv = inverseRateDec('0.709', 8); // 1.41043724
    expect(inverseRateDec(inv, 8)).not.toBe('0.709'); // 0.70899999...
  });
  it('rounds amounts using the currency rounding method + increment', () => {
    expect(roundCurrencyAmountDec('1.075', base({ roundingIncrement: 0.05 }))).toBe('1.10');
  });
  it('drives the settings-page previews', () => {
    expect(precisionPreview('1234.5678', { decimalPlaces: 3 })).toBe('1234.568');
    expect(conversionPreview('100', '1.41', { decimalPlaces: 3 })).toBe('141.000');
  });
});

/* ───────────── Inactive currencies & validation ───────────── */

describe('inactive currency handling', () => {
  it('rejects an inactive currency for new transactions but keeps it defined (readable)', () => {
    const currencies = useCurrencyStore.getState().currencies;
    const issues = validateCurrencyForEntity('BTC', SEED_ENTITY_CURRENCY_CONFIG, currencies);
    expect(issues.some((i) => i.rule === 'inactive')).toBe(true);
    expect(useCurrencyStore.getState().getCurrency('BTC')).toBeDefined();
  });
  it('the base currency must be active', () => {
    expect(validateBaseCurrencySelection('BTC', useCurrencyStore.getState().currencies).some((i) => i.rule === 'base-inactive')).toBe(true);
    expect(validateBaseCurrencySelection('USD', useCurrencyStore.getState().currencies)).toEqual([]);
  });
  it('the store refuses to deactivate the base currency', () => {
    const usd = useCurrencyStore.getState().getCurrency('USD')!;
    const r = useCurrencyStore.getState().setCurrencyStatus(usd.id, 'inactive');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/base currency/i);
  });
});

/* ───────────── Base currency protection ───────────── */

describe('base-currency change protection', () => {
  it('allows changing the base freely before any posting exists', () => {
    expect(guardBaseCurrencyChange({ hasPostedTransactions: false, elevated: false }).ok).toBe(true);
    const r = useCurrencyStore.getState().setBaseCurrency('primary', 'JOD', { hasPostedTransactionsOverride: false });
    expect(r.ok).toBe(true);
    expect(useCurrencyStore.getState().getConfig().baseCurrencyCode).toBe('JOD');
  });
  it('blocks ordinary changes once postings exist (seeded journal has posted entries)', () => {
    const r = useCurrencyStore.getState().setBaseCurrency('primary', 'JOD');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/migration/i);
  });
  it('requires the full migration workflow even when elevated', () => {
    expect(guardBaseCurrencyChange({ hasPostedTransactions: true, elevated: true }).ok).toBe(false);
    const r = useCurrencyStore.getState().setBaseCurrency('primary', 'JOD', {
      elevated: true,
      migration: { effectiveDate: '2026-08-01', exchangeRateSource: 'central-bank closing', confirmedBy: 'Org Admin' },
    });
    expect(r.ok).toBe(true);
    // The change is audited on the currency record; history is never recalculated.
    const jod = useCurrencyStore.getState().getCurrency('JOD')!;
    expect(jod.auditTrail.some((e) => e.action === 'base-currency-assigned')).toBe(true);
  });
  it('keeps exactly one base currency per entity', () => {
    useCurrencyStore.getState().setBaseCurrency('primary', 'JOD', { hasPostedTransactionsOverride: false });
    expect(useCurrencyStore.getState().getConfig().baseCurrencyCode).toBe('JOD');
    const configs = useCurrencyStore.getState().entityConfigs;
    expect(Object.values(configs).filter((c) => c.entityId === 'primary').length).toBe(1);
  });
});

/* ───────────── Editing safeguards ───────────── */

describe('editing safeguards', () => {
  it('display fields change freely even for used currencies', () => {
    const usd = useCurrencyStore.getState().getCurrency('USD')!;
    const r = useCurrencyStore.getState().updateCurrency(usd.id, { localizedName: 'دولار أمريكي', symbolSpacing: true });
    expect(r.ok).toBe(true);
  });
  it('accounting-critical edits on a used currency require elevation + confirmation', () => {
    const usd = useCurrencyStore.getState().getCurrency('USD')!; // used by seeded journal
    const blocked = useCurrencyStore.getState().updateCurrency(usd.id, { decimalPlaces: 4 });
    expect(blocked.ok).toBe(false);
    const confirmed = useCurrencyStore.getState().updateCurrency(usd.id, { decimalPlaces: 4 }, { elevated: true, confirmedImpact: true });
    expect(confirmed.ok).toBe(true);
  });
  it('unused currencies stay freely editable', () => {
    const chf = useCurrencyStore.getState().getCurrency('CHF')!; // not in seeded documents
    const r = useCurrencyStore.getState().updateCurrency(chf.id, { decimalPlaces: 3 });
    expect(r.ok).toBe(true);
  });
  it('guard helpers behave as specified', () => {
    expect(guardCriticalCurrencyEdit({ inUse: false, elevated: false, confirmedImpact: false }).ok).toBe(true);
    expect(guardCriticalCurrencyEdit({ inUse: true, elevated: false, confirmedImpact: false }).ok).toBe(false);
    expect(guardCriticalCurrencyEdit({ inUse: true, elevated: true, confirmedImpact: false }).ok).toBe(false);
    expect(guardCriticalCurrencyEdit({ inUse: true, elevated: true, confirmedImpact: true }).ok).toBe(true);
    expect(patchTouchesCriticalFields(base({}), { name: 'renamed' })).toBe(false);
    expect(patchTouchesCriticalFields(base({}), { decimalPlaces: 3 })).toBe(true);
  });
});

/* ───────────── Reporting currencies ───────────── */

describe('reporting currencies', () => {
  it('configures reporting currencies distinct from the base', () => {
    const r = useCurrencyStore.getState().setReportingCurrencies('primary', [
      { currencyCode: 'EUR', rateType: 'mid', translationMethod: 'closing-rate', effectiveDatePolicy: 'period-end' },
    ]);
    expect(r.ok).toBe(true);
    expect(useCurrencyStore.getState().getConfig().reportingCurrencies).toHaveLength(1);
  });
  it('rejects the base currency as a reporting currency', () => {
    const r = useCurrencyStore.getState().setReportingCurrencies('primary', [
      { currencyCode: 'USD', rateType: 'mid', translationMethod: 'closing-rate', effectiveDatePolicy: 'period-end' },
    ]);
    expect(r.ok).toBe(false);
  });
  it('rejects unknown reporting currencies', () => {
    const r = useCurrencyStore.getState().setReportingCurrencies('primary', [
      { currencyCode: 'ZZZ', rateType: 'mid', translationMethod: 'closing-rate', effectiveDatePolicy: 'period-end' },
    ]);
    expect(r.ok).toBe(false);
  });
});

/* ───────────── Exchange-rate workflow ───────────── */

describe('exchange-rate workflow', () => {
  it('supports draft → approve, and drafts never resolve', () => {
    const store = useExchangeRateStore.getState();
    const r = store.createRate({ entityId: 'primary', fromCurrencyCode: 'CHF', toCurrencyCode: 'USD', rate: 1.12, effectiveDate: '2026-07-01', status: 'draft' });
    expect(r.ok).toBe(true);
    expect(useExchangeRateStore.getState().resolve({ entityId: 'primary', fromCurrencyCode: 'CHF', toCurrencyCode: 'USD', transactionDate: '2026-07-02' }).ok).toBe(false);
    expect(useExchangeRateStore.getState().approveRate(r.id!).ok).toBe(true);
    const approved = useExchangeRateStore.getState().getRate(r.id!)!;
    expect(approved.status).toBe('active');
    expect(approved.approvedBy).toBeTruthy();
    expect(useExchangeRateStore.getState().resolve({ entityId: 'primary', fromCurrencyCode: 'CHF', toCurrencyCode: 'USD', transactionDate: '2026-07-02' }).rate).toBe(1.12);
  });
  it('deletes only draft rates', () => {
    const store = useExchangeRateStore.getState();
    const draft = store.createRate({ entityId: 'primary', fromCurrencyCode: 'CHF', toCurrencyCode: 'USD', rate: 1.12, effectiveDate: '2026-07-01', status: 'draft' });
    expect(useExchangeRateStore.getState().deleteDraftRate(draft.id!).ok).toBe(true);
    const active = useExchangeRateStore.getState().rates.find((x) => x.status === 'active')!;
    expect(useExchangeRateStore.getState().deleteDraftRate(active.id).ok).toBe(false);
  });
  it('rejects zero/negative rates and same-currency pairs', () => {
    const store = useExchangeRateStore.getState();
    expect(store.createRate({ entityId: 'primary', fromCurrencyCode: 'CHF', toCurrencyCode: 'USD', rate: 0, effectiveDate: '2026-07-01' }).ok).toBe(false);
    expect(store.createRate({ entityId: 'primary', fromCurrencyCode: 'USD', toCurrencyCode: 'USD', rate: 2, effectiveDate: '2026-07-01' }).ok).toBe(false);
  });
});

/* ───────────── Permissions & operator attribution ───────────── */

describe('permissions', () => {
  it('grants owners/admins full currency administration', () => {
    expect(roleHasCurrencyPermission('owner', 'currency.setBaseCurrency')).toBe(true);
    expect(roleHasCurrencyPermission('admin', 'currency.configurePrecision')).toBe(true);
  });
  it('accountants manage rates but not precision or base currency', () => {
    expect(roleHasCurrencyPermission('accountant', 'exchangeRate.create')).toBe(true);
    expect(roleHasCurrencyPermission('accountant', 'currency.configurePrecision')).toBe(false);
    expect(roleHasCurrencyPermission('accountant', 'currency.setBaseCurrency')).toBe(false);
  });
  it('viewers only view', () => {
    expect(roleHasCurrencyPermission('viewer', 'currency.view')).toBe(true);
    expect(roleHasCurrencyPermission('viewer', 'currency.create')).toBe(false);
    expect(assertCurrencyPermission('viewer', 'exchangeRate.approve').ok).toBe(false);
  });
});

/* ───────────── Legacy migration ───────────── */

describe('legacy migration', () => {
  it('upgrades v1 records without touching code, precision or formatting', () => {
    const legacy = base({ id: 'cur_JOD', code: 'JOD', decimalPlaces: 3, currencyType: undefined, exchangeRateDecimalPlaces: undefined });
    const upgraded = upgradeCurrencyRecord(legacy);
    expect(upgraded.code).toBe('JOD');
    expect(upgraded.decimalPlaces).toBe(3);
    expect(upgraded.currencyType).toBe('fiat');
    expect(upgraded.isIso).toBe(true);
    expect(upgraded.isoNumericCode).toBe('400');
    expect(rateDecimalsOf(upgraded)).toBe(8);
  });
  it('classifies unknown legacy codes as custom-safe fallbacks', () => {
    const legacy = base({ code: 'OLDCUR', currencyType: undefined, exchangeRateDecimalPlaces: undefined, isIso: undefined });
    const upgraded = upgradeCurrencyRecord(legacy);
    expect(upgraded.isIso).toBe(false);
    expect(upgraded.currencyType).toBe('fiat');
  });
  it('reports records referencing an unknown currency', () => {
    const unknown = findUnknownCurrencyCodes(['USD', 'ZZZ', 'zzz', 'PTS'], SEED_CURRENCIES);
    expect(unknown).toEqual(['PTS', 'ZZZ']);
  });
  it('collects used codes across document sets', () => {
    const used = collectUsedCurrencyCodes(['usd', undefined], ['JOD'], []);
    expect(used.has('USD')).toBe(true);
    expect(used.has('JOD')).toBe(true);
    expect(used.size).toBe(2);
  });
});

/* ───────────── Document integration (precision-aware calculators) ───────────── */

describe('document integration', () => {
  it('invoice lines honour 3-decimal (JOD) and 0-decimal (JPY) document currencies', async () => {
    const { calculateInvoiceLine, calculateInvoiceTotals } = await import('@/lib/invoiceCalculations');
    const jod = calculateInvoiceLine({ quantity: 3, unitPrice: 1.111, taxRate: 16 }, 3);
    expect(jod.lineSubtotal).toBe(3.333);
    expect(jod.taxAmount).toBe(0.533); // 3.333 × 16% = 0.53328 → 0.533
    const jpy = calculateInvoiceLine({ quantity: 3, unitPrice: 416.5, taxRate: 10 }, 0);
    expect(jpy.lineSubtotal).toBe(1250); // 1249.5 → 1250, no forced .00
    expect(jpy.lineTotal).toBe(1375);
    const totals = calculateInvoiceTotals([{ quantity: 3, unitPrice: 1.111, taxRate: 16 }], 0, 0, 3);
    expect(totals.grandTotal).toBe(3.866);
  });
  it('bill totals honour the document currency precision', async () => {
    const { calculateBillTotals } = await import('@/lib/billCalculations');
    const t = calculateBillTotals([
      { quantity: 1, unitPrice: 10.1235, taxRate: 0, withholdingTaxRate: 0, discountType: undefined, discountValue: 0 } as never,
    ], 0, 3);
    expect(t.subtotal).toBe(10.124);
    expect(t.grandTotal).toBe(10.124);
  });
  it('journal voucher totals balance at the voucher currency precision', async () => {
    const { computeVoucherTotals, balanceToleranceAt } = await import('@/lib/journalVoucherValidation');
    const mk = (debit: number, credit: number) => ({ debit, credit }) as never;
    // A JOD voucher balanced at 3dp…
    const jod = computeVoucherTotals([mk(100.123, 0), mk(0, 100.123)], 1.41, { currencyDecimals: 3, baseCurrencyDecimals: 2 });
    expect(jod.difference).toBe(0);
    expect(Math.abs(jod.baseDifference)).toBeLessThanOrEqual(balanceToleranceAt(2));
    // …and a JPY voucher at 0dp keeps integer totals.
    const jpy = computeVoucherTotals([mk(1250, 0), mk(0, 1250)], 0.0067, { currencyDecimals: 0, baseCurrencyDecimals: 2 });
    expect(jpy.debit).toBe(1250);
    expect(jpy.difference).toBe(0);
  });
});

/* ───────────── Workspace lifecycle ───────────── */

describe('workspace lifecycle', () => {
  it('resetToDefault restores the seeded master (tenant reset on sign-out)', () => {
    useCurrencyStore.getState().createCustomCurrency({ code: 'PTS', name: 'Points', symbol: 'pts', currencyType: 'internal', decimalPlaces: 0 });
    expect(useCurrencyStore.getState().getCurrency('PTS')).toBeDefined();
    useCurrencyStore.getState().resetToDefault();
    expect(useCurrencyStore.getState().getCurrency('PTS')).toBeUndefined();
    expect(useCurrencyStore.getState().getConfig().baseCurrencyCode).toBe('USD');
  });
  it('entity configs stay scoped per entity (tenant isolation of preferences)', () => {
    useCurrencyStore.getState().updateEntityConfig('other-entity', { defaultSalesCurrencyCode: 'EUR' });
    expect(useCurrencyStore.getState().getConfig('other-entity').defaultSalesCurrencyCode).toBe('EUR');
    expect(useCurrencyStore.getState().getConfig('primary').defaultSalesCurrencyCode).toBeUndefined();
  });
});

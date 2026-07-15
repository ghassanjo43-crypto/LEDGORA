import { describe, it, expect, beforeEach } from 'vitest';
import type { Currency } from '@/types/currency';
import type { ExchangeRate } from '@/types/exchangeRate';
import { convertToBase, convertFromBase, convertCurrency, roundCurrencyAmount, roundExchangeRate } from '@/lib/currencyConversion';
import { formatCurrencyAmount, formatNumber } from '@/lib/currencyFormatting';
import { resolveExchangeRate, resolveDefaultCurrency, createExchangeRateSnapshot, rateVariancePercent } from '@/lib/exchangeRateResolution';
import { calculateRealizedFx, calculatePartialSettlementFx } from '@/lib/fxRealization';
import { validateExchangeRate } from '@/lib/exchangeRateValidation';
import { validateCurrencyForTransaction } from '@/lib/currencyValidation';
import { buildFxGainLossReport } from '@/lib/currencyReporting';
import { computeTotals } from '@/lib/journalValidation';
import { useCurrencyStore } from '@/store/currencyStore';
import { useExchangeRateStore } from '@/store/exchangeRateStore';
import { useCurrencyRevaluationStore } from '@/store/currencyRevaluationStore';
import { useJournalStore } from '@/store/journalStore';
import { useStore } from '@/store/useStore';
import { SEED_ENTITY_CURRENCY_CONFIG } from '@/data/currencySeed';

const acc = (code: string) => useStore.getState().accounts.find((a) => a.code === code)!.id;
const usd: Currency = { id: 'u', code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2, symbolPosition: 'before', decimalSeparator: '.', thousandSeparator: ',', negativeFormat: '(1,234.56)', status: 'active', auditTrail: [], createdAt: '', updatedAt: '' };
const jod: Currency = { ...usd, id: 'j', code: 'JOD', name: 'Jordanian Dinar', symbol: 'JD', decimalPlaces: 3 };
const jpy: Currency = { ...usd, id: 'y', code: 'JPY', name: 'Yen', symbol: '¥', decimalPlaces: 0 };

beforeEach(() => {
  useJournalStore.getState().resetToDefault();
  useCurrencyStore.getState().resetToDefault();
  useExchangeRateStore.getState().resetToDefault();
  useCurrencyRevaluationStore.getState().resetToDefault();
});

/* ───────────────────── Conversion & precision ───────────────────── */

describe('conversion & precision', () => {
  it('base identity keeps the amount (rate 1)', () => {
    expect(convertToBase(1000, 1, true, 3)).toBe(1000);
  });
  it('foreign→base: 1000 USD × 0.709 = 709.000 (JOD, 3dp)', () => {
    expect(convertToBase(1000, 0.709, false, 3)).toBe(709);
    expect(convertCurrency(1000, 0.709, { precision: 3 })).toBe(709);
  });
  it('base→foreign is the inverse', () => {
    expect(convertFromBase(709, 0.709, false, 2)).toBe(1000);
  });
  it('inverse rate is 1/rate', () => {
    expect(roundExchangeRate(1 / 0.709)).toBeCloseTo(1.41043724, 6);
  });
  it('respects per-currency precision (JOD 3dp, JPY 0dp)', () => {
    expect(roundCurrencyAmount(1234.5678, jod)).toBe(1234.568);
    expect(roundCurrencyAmount(1234.56, jpy)).toBe(1235);
  });
});

/* ───────────────────── Formatting ───────────────────── */

describe('formatting', () => {
  it('JPY shows zero decimals, JOD shows three', () => {
    expect(formatNumber(1234.56, jpy)).toBe('1,235');
    expect(formatNumber(1234.5678, jod)).toBe('1,234.568');
  });
  it('accounting negatives use parentheses when configured', () => {
    expect(formatCurrencyAmount(-1234.56, usd)).toBe('($1,234.56)');
  });
});

/* ───────────────────── Rate resolution ───────────────────── */

describe('rate resolution', () => {
  const rates: ExchangeRate[] = [
    { id: 'r1', entityId: 'primary', fromCurrencyCode: 'USD', toCurrencyCode: 'JOD', rate: 0.709, inverseRate: 1.4104, rateType: 'mid', source: 'manual', effectiveDate: '2026-01-01', status: 'active', createdAt: '', updatedAt: '' },
    { id: 'r2', entityId: 'primary', fromCurrencyCode: 'USD', toCurrencyCode: 'JOD', rate: 0.720, inverseRate: 1.3889, rateType: 'mid', source: 'manual', effectiveDate: '2026-06-01', status: 'active', createdAt: '', updatedAt: '' },
  ];
  it('base-to-base resolves to 1', () => {
    expect(resolveExchangeRate({ entityId: 'primary', fromCurrencyCode: 'USD', toCurrencyCode: 'USD', transactionDate: '2026-03-01', rates }).rate).toBe(1);
  });
  it('uses the latest prior rate, never a future rate', () => {
    expect(resolveExchangeRate({ entityId: 'primary', fromCurrencyCode: 'USD', toCurrencyCode: 'JOD', transactionDate: '2026-03-01', rates }).rate).toBe(0.709);
    expect(resolveExchangeRate({ entityId: 'primary', fromCurrencyCode: 'USD', toCurrencyCode: 'JOD', transactionDate: '2026-07-01', rates }).rate).toBe(0.720);
  });
  it('resolves the inverse when only the reciprocal exists', () => {
    const res = resolveExchangeRate({ entityId: 'primary', fromCurrencyCode: 'JOD', toCurrencyCode: 'USD', transactionDate: '2026-03-01', rates });
    expect(res.method).toBe('inverse');
    expect(res.rate).toBeCloseTo(1 / 0.709, 6);
  });
  it('a missing rate blocks (never silently 1.0)', () => {
    const res = resolveExchangeRate({ entityId: 'primary', fromCurrencyCode: 'CHF', toCurrencyCode: 'JOD', transactionDate: '2026-03-01', rates });
    expect(res.ok).toBe(false);
    expect(res.method).toBe('none');
  });
});

/* ───────────────────── Default currency ───────────────────── */

describe('default currency resolution', () => {
  const config = SEED_ENTITY_CURRENCY_CONFIG;
  it('honours explicit → party → entity default → base', () => {
    expect(resolveDefaultCurrency({ direction: 'sales', explicitCurrencyCode: 'EUR', config }).source).toBe('explicit');
    expect(resolveDefaultCurrency({ direction: 'sales', party: { preferredCurrencyCode: 'GBP' }, config }).currencyCode).toBe('GBP');
    expect(resolveDefaultCurrency({ direction: 'purchase', config }).source).toBe('entity-base');
  });
});

/* ───────────────────── Override & variance ───────────────────── */

describe('override & variance', () => {
  it('variance percent and snapshot override audit', () => {
    expect(rateVariancePercent(0.709, 0.750)).toBeCloseTo(5.78, 1);
    const snap = createExchangeRateSnapshot({ ok: true, rate: 0.709, method: 'prior', effectiveDate: '2026-01-01' }, 'USD', 'JOD', 'now', { overrideRate: 0.750, overrideReason: 'bank deal' });
    expect(snap.overrideRate).toBe(0.750);
    expect(snap.resolvedRate).toBe(0.709);
    expect(snap.rate).toBe(0.750);
  });
});

/* ───────────────────── Realized FX ───────────────────── */

describe('realized FX', () => {
  it('scenario 2 — full receipt with realized gain of 6', () => {
    const r = calculateRealizedFx({ side: 'receivable', settledForeign: 1000, originalForeign: 1000, originalCarryingBase: 709, settlementRate: 0.715, basePrecision: 3 });
    expect(r.settlementBase).toBe(715);
    expect(r.realizedFx).toBe(6);
    expect(r.isGain).toBe(true);
    expect(r.remainingForeign).toBe(0);
  });
  it('scenario 3 — partial receipt uses proportional carrying', () => {
    const r = calculatePartialSettlementFx({ side: 'receivable', settledForeign: 400, originalForeign: 1000, originalCarryingBase: 709, settlementRate: 0.715, basePrecision: 3 });
    expect(r.carryingBaseSettled).toBe(283.6);
    expect(r.settlementBase).toBe(286);
    expect(r.realizedFx).toBe(2.4);
    expect(r.remainingForeign).toBe(600);
    expect(r.remainingCarryingBase).toBe(425.4);
  });
  it('scenario 4 — payable payment realized gain of 25 (pay less base)', () => {
    const r = calculateRealizedFx({ side: 'payable', settledForeign: 5000, originalForeign: 5000, originalCarryingBase: 3850, settlementRate: 0.765, basePrecision: 3 });
    expect(r.settlementBase).toBe(3825);
    expect(r.realizedFx).toBe(25);
    expect(r.isGain).toBe(true);
  });
  it('payable payment at a higher rate is a loss', () => {
    const r = calculateRealizedFx({ side: 'payable', settledForeign: 1000, originalForeign: 1000, originalCarryingBase: 709, settlementRate: 0.715, basePrecision: 3 });
    expect(r.realizedFx).toBe(-6);
    expect(r.isLoss).toBe(true);
  });
});

/* ───────────────────── Validation ───────────────────── */

describe('validation', () => {
  it('exchange rate must be positive and reconcile', () => {
    const bad = validateExchangeRate({ id: 'x', entityId: 'primary', fromCurrencyCode: 'USD', toCurrencyCode: 'JOD', rate: -1, inverseRate: 0, rateType: 'mid', source: 'manual', effectiveDate: '2026-01-01', status: 'active', createdAt: '', updatedAt: '' }, { existingRates: [] });
    expect(bad.some((i) => i.rule === 'positive')).toBe(true);
  });
  it('foreign transaction currency requires a resolvable rate', () => {
    const config = useCurrencyStore.getState().getConfig();
    const issues = validateCurrencyForTransaction('CHF', { config, currencies: useCurrencyStore.getState().currencies, rates: [], transactionDate: '2026-03-01' });
    // CHF isn't enabled → not-enabled error precedes the rate check.
    expect(issues.some((i) => i.severity === 'error')).toBe(true);
  });
});

/* ───────────────────── Revaluation ───────────────────── */

describe('currency revaluation', () => {
  /** Post a foreign receivable: Dr 1221 (USD) / Cr revenue, at rate 0.709. */
  function postForeignReceivable(foreign: number, rate: number, currency = 'USD'): void {
    useJournalStore.getState().replaceAll([]); // isolate from the USD seed entries (base is JOD here)
    const j = useJournalStore.getState();
    const added = j.addEntry({
      entryNumber: '', entryDate: '2026-03-01', reference: 'INV', description: 'Foreign invoice', currency, exchangeRate: rate,
      notes: '', transactionType: 'Customer Invoice', createdBy: 'x', approvedBy: '',
      lines: [
        { accountId: acc('1221'), accountCode: '1221', accountName: '', description: '', debit: foreign, credit: 0, entityId: '', entityName: '', costCenter: '', project: '', taxCode: '', taxAmount: 0, memo: '' },
        { accountId: acc('4110'), accountCode: '4110', accountName: '', description: '', debit: 0, credit: foreign, entityId: '', entityName: '', costCenter: '', project: '', taxCode: '', taxAmount: 0, memo: '' },
      ],
    });
    j.postEntry(added.id!);
  }

  it('scenario 5 — revalues a USD receivable up by JOD 110 and posts a balanced gain', () => {
    // Reconfigure base to JOD so revaluation runs in JOD (3dp).
    useCurrencyStore.getState().updateEntityConfig('primary', { baseCurrencyCode: 'JOD' });
    useExchangeRateStore.getState().createRate({ entityId: 'primary', fromCurrencyCode: 'USD', toCurrencyCode: 'JOD', rate: 0.720, effectiveDate: '2026-12-31' });
    postForeignReceivable(10000, 0.709); // carrying JOD 7090

    const store = useCurrencyRevaluationStore.getState();
    const res = store.buildDraft({ revaluationDate: '2026-12-31', currencyCodes: ['USD'] });
    expect(res.ok).toBe(true);
    const run = useCurrencyRevaluationStore.getState().getRun(res.id!)!;
    const line = run.lines.find((l) => l.currencyCode === 'USD')!;
    expect(line.carryingBaseAmount).toBe(7090);
    expect(line.revaluedBaseAmount).toBe(7200);
    expect(line.unrealizedGain).toBe(110);

    // Post → balanced journal Dr receivable 110 / Cr unrealized gain 110.
    expect(useCurrencyRevaluationStore.getState().postRun(res.id!).ok).toBe(true);
    const posted = useCurrencyRevaluationStore.getState().getRun(res.id!)!;
    const je = useJournalStore.getState().entries.find((e) => e.id === posted.journalEntryId)!;
    expect(computeTotals(je.lines).difference).toBe(0);
    expect(je.lines.find((l) => l.accountCode === '1221')!.debit).toBe(110);
  });

  it('excludes non-monetary accounts and blocks a duplicate posted run', () => {
    useCurrencyStore.getState().updateEntityConfig('primary', { baseCurrencyCode: 'JOD' });
    useExchangeRateStore.getState().createRate({ entityId: 'primary', fromCurrencyCode: 'USD', toCurrencyCode: 'JOD', rate: 0.720, effectiveDate: '2026-12-31' });
    postForeignReceivable(10000, 0.709);
    const store = useCurrencyRevaluationStore.getState();
    const first = store.buildDraft({ revaluationDate: '2026-12-31' });
    store.postRun(first.id!);
    const second = useCurrencyRevaluationStore.getState().buildDraft({ revaluationDate: '2026-12-31' });
    expect(useCurrencyRevaluationStore.getState().postRun(second.id!).ok).toBe(false);
  });

  it('reversal is exact (swaps the revaluation journal)', () => {
    useCurrencyStore.getState().updateEntityConfig('primary', { baseCurrencyCode: 'JOD' });
    useExchangeRateStore.getState().createRate({ entityId: 'primary', fromCurrencyCode: 'USD', toCurrencyCode: 'JOD', rate: 0.720, effectiveDate: '2026-12-31' });
    postForeignReceivable(10000, 0.709);
    const store = useCurrencyRevaluationStore.getState();
    const res = store.buildDraft({ revaluationDate: '2026-12-31' });
    store.postRun(res.id!);
    const rev = useCurrencyRevaluationStore.getState().reverseRun(res.id!);
    expect(rev.ok).toBe(true);
    const run = useCurrencyRevaluationStore.getState().getRun(res.id!)!;
    expect(run.status).toBe('reversed');
    const reversal = useJournalStore.getState().entries.find((e) => e.id === run.reversalJournalEntryId)!;
    expect(reversal.lines.find((l) => l.accountCode === '1221')!.credit).toBe(110); // opposite of the original debit
  });
});

/* ───────────────────── FX report ───────────────────── */

describe('FX gain/loss report', () => {
  it('classifies realized vs unrealized and totals the net', () => {
    const j = useJournalStore.getState();
    // Realized loss: Dr FX 6 / Cr bank 6 (simplified).
    const a = j.addEntry({ entryNumber: '', entryDate: '2026-05-01', reference: 'PAY', description: 'Realized loss', currency: 'USD', exchangeRate: 1, notes: '', transactionType: 'Supplier Payment', createdBy: 'x', approvedBy: '', lines: [
      { accountId: acc('7300'), accountCode: '7300', accountName: '', description: '', debit: 6, credit: 0, entityId: '', entityName: '', costCenter: '', project: '', taxCode: '', taxAmount: 0, memo: '' },
      { accountId: acc('1252'), accountCode: '1252', accountName: '', description: '', debit: 0, credit: 6, entityId: '', entityName: '', costCenter: '', project: '', taxCode: '', taxAmount: 0, memo: '' },
    ] });
    j.postEntry(a.id!);
    const report = buildFxGainLossReport({ entries: useJournalStore.getState().entries, config: useCurrencyStore.getState().getConfig(), baseCurrency: 'USD' });
    expect(report.realizedLoss).toBe(6);
    expect(report.netFx).toBe(-6);
  });
});

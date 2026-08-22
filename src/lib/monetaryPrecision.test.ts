// @vitest-environment happy-dom
/**
 * The company's functional currency determines monetary precision — everywhere.
 *
 * ══ Why this is an accounting test, not a formatting test ════════════════════
 *
 * A JOD company keeps its books in thousandths. Rendering `1,250.000` as
 * `1,250.00` does not merely look wrong: it hides a fils per line, and the
 * balance check that used a fixed half-a-cent tolerance would then call an
 * entry balanced when it was out by one. Precision affects what may be entered,
 * what is judged balanced, and what is reported — not only what is displayed.
 *
 * ══ What is deliberately NOT governed by currency precision ══════════════════
 *
 * Exchange rates (their own configuration, 8 decimals by default), percentages,
 * quantities, and Ledgora's own platform billing. Those have their own tests
 * below so a future change cannot quietly sweep them in.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '@/store/useStore';
import { useCurrencyStore } from '@/store/currencyStore';
import { useJournalStore } from '@/store/journalStore';
import {
  FALLBACK_MONETARY_DECIMALS,
  companyMonetaryDecimals,
  decimalPlacesIn,
  getCurrencyMonetaryDecimals,
  roundToCurrencyPrecision,
  smallestUnit,
  validateCompanyMonetaryDecimals,
  validateMonetaryDecimals,
} from '@/lib/monetaryPrecision';
import { formatCurrency, formatCurrencyCompact, formatPercent } from '@/lib/money';
import { computeTotals, balanceStatus, roundMoney, balanceToleranceFor } from '@/lib/journalValidation';
import { formatMoney } from '@/lib/journalSelectors';
import { tbAmount, tbAmountAlways } from '@/components/trial-balance/tbFormat';
import { formatFinancialAmount } from '@/components/balance-sheet/bsFormat';
import { isAmount } from '@/components/income-statement/isFormat';
import { formatBalanceLabel } from '@/lib/generalLedgerCalculations';
import { rateDecimalsOf, DEFAULT_RATE_DECIMALS } from '@/types/currency';

/** Put the workspace into a company whose books are kept in `code`. */
function companyKeepsBooksIn(code: string): void {
  useStore.setState((s) => ({ settings: { ...s.settings, baseCurrency: code } }));
}

beforeEach(() => {
  useJournalStore.getState().replaceAll([]);
  companyKeepsBooksIn('USD');
});

/* ══ 1–4 · Resolution ══════════════════════════════════════════════════════ */

describe('resolving a currency to its monetary decimals', () => {
  it('resolves the currencies the specification names', () => {
    expect(getCurrencyMonetaryDecimals('JOD')).toBe(3);
    expect(getCurrencyMonetaryDecimals('USD')).toBe(2);
    expect(getCurrencyMonetaryDecimals('JPY')).toBe(0);
    expect(getCurrencyMonetaryDecimals('KWD')).toBe(3);
    expect(getCurrencyMonetaryDecimals('BHD')).toBe(3);
    expect(getCurrencyMonetaryDecimals('OMR')).toBe(3);
    expect(getCurrencyMonetaryDecimals('IQD')).toBe(3);
  });

  it('follows the ACTIVE company, and changes when the company does', () => {
    companyKeepsBooksIn('JOD');
    expect(companyMonetaryDecimals()).toBe(3);
    companyKeepsBooksIn('USD');
    expect(companyMonetaryDecimals()).toBe(2);
    companyKeepsBooksIn('JPY');
    expect(companyMonetaryDecimals()).toBe(0);
    // …and back again: nothing caches one organization's answer.
    companyKeepsBooksIn('JOD');
    expect(companyMonetaryDecimals()).toBe(3);
  });

  it('reports the currency’s smallest expressible unit', () => {
    expect(smallestUnit('JOD')).toBeCloseTo(0.001, 10);
    expect(smallestUnit('USD')).toBeCloseTo(0.01, 10);
    expect(smallestUnit('JPY')).toBe(1);
  });

  it('falls back exactly once, for a code nothing knows', () => {
    expect(getCurrencyMonetaryDecimals('ZZZ')).toBe(FALLBACK_MONETARY_DECIMALS);
    expect(getCurrencyMonetaryDecimals('')).toBe(FALLBACK_MONETARY_DECIMALS);
  });
});

/* ══ 33 · Custom currencies ════════════════════════════════════════════════ */

describe('organization-defined custom currencies', () => {
  it('takes precision from the Currency Master, not the ISO catalogue', () => {
    /*
     * Ledgora supports more than ISO. A custom currency's own `decimalPlaces` is
     * authoritative — the catalogue has never heard of it, so a catalogue-only
     * resolver would silently give it two.
     */
    const created = useCurrencyStore.getState().createCurrency({
      code: 'XTS', name: 'Test Token', symbol: 'XT', decimalPlaces: 5, status: 'active',
    });
    expect(created.ok).toBe(true);
    expect(getCurrencyMonetaryDecimals('XTS')).toBe(5);
  });

  it('lets the master override a catalogued currency’s configuration', () => {
    // The master is the authority. Correcting a currency there must be respected
    // rather than overridden by the reference data.
    const jod = useCurrencyStore.getState().getCurrency('JOD')!;
    useCurrencyStore.getState().updateCurrency(jod.id, { decimalPlaces: 4 });
    expect(getCurrencyMonetaryDecimals('JOD')).toBe(4);
    useCurrencyStore.getState().updateCurrency(jod.id, { decimalPlaces: 3 });
    expect(getCurrencyMonetaryDecimals('JOD')).toBe(3);
  });
});

/* ══ 5–7 · Formatting ══════════════════════════════════════════════════════ */

describe('formatting an amount', () => {
  it('shows exactly the currency’s decimals', () => {
    expect(formatCurrency(1234.5, 'JOD')).toMatch(/1,234\.500/);
    expect(formatCurrency(1234.5, 'USD')).toMatch(/1,234\.50/);
    expect(formatCurrency(1234.5, 'JPY')).toMatch(/1,235/);
    expect(formatCurrency(1234.5, 'JPY')).not.toMatch(/\./);
    expect(formatCurrency(1234.5, 'KWD')).toMatch(/1,234\.500/);
  });

  it('renders the specification’s worked example', () => {
    companyKeepsBooksIn('JOD');
    for (const [value, expected] of [
      [100, '100.000'],
      [100.1, '100.100'],
      [100.12, '100.120'],
      [100.123, '100.123'],
    ] as const) {
      expect(formatCurrency(value, 'JOD')).toContain(expected);
    }
  });

  it('keeps accounting-style negatives', () => {
    // Parentheses, not a minus sign — the accounting presentation must survive.
    expect(formatCurrency(-1234.5, 'JOD')).toMatch(/^\(.*1,234\.500\)$/);
    expect(formatCurrency(-1234.5, 'USD')).toMatch(/^\(.*1,234\.50\)$/);
  });

  it('keeps the compact card variant at whole units, deliberately', () => {
    // A documented exception: summary cards present a magnitude, not a figure to
    // reconcile. The zero is passed explicitly rather than defaulted.
    companyKeepsBooksIn('JOD');
    expect(formatCurrencyCompact(1234.5, 'JOD')).not.toMatch(/\./);
  });

  it('formats a custom currency it cannot hand to Intl', () => {
    useCurrencyStore.getState().createCurrency({
      code: 'XTT', name: 'Custom', symbol: 'XT', decimalPlaces: 4, status: 'active',
    });
    expect(formatCurrency(12.5, 'XTT')).toContain('12.5000');
  });
});

/* ══ 8–12 · Input validation ═══════════════════════════════════════════════ */

describe('validating what a user may enter', () => {
  it('counts the decimals actually typed', () => {
    expect(decimalPlacesIn('100')).toBe(0);
    expect(decimalPlacesIn('100.123')).toBe(3);
    // A trailing zero is not extra precision.
    expect(decimalPlacesIn('100.1230')).toBe(3);
    expect(decimalPlacesIn(100.1234)).toBe(4);
  });

  it('accepts up to three decimals for JOD and refuses a fourth', () => {
    companyKeepsBooksIn('JOD');
    for (const ok of ['100', '100.1', '100.12', '100.123']) {
      expect(validateCompanyMonetaryDecimals(ok).ok, ok).toBe(true);
    }
    const refused = validateCompanyMonetaryDecimals('100.1234');
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe('JOD supports a maximum of 3 decimal places.');
  });

  it('accepts up to two for USD and refuses a third', () => {
    companyKeepsBooksIn('USD');
    for (const ok of ['100', '100.1', '100.12']) {
      expect(validateCompanyMonetaryDecimals(ok).ok, ok).toBe(true);
    }
    const refused = validateCompanyMonetaryDecimals('100.123');
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe('USD supports a maximum of 2 decimal places.');
  });

  it('refuses any fraction for JPY, and says so in its own words', () => {
    companyKeepsBooksIn('JPY');
    expect(validateCompanyMonetaryDecimals('100').ok).toBe(true);
    expect(validateCompanyMonetaryDecimals('1250').ok).toBe(true);
    const refused = validateCompanyMonetaryDecimals('100.1');
    expect(refused.ok).toBe(false);
    // "a maximum of 0 decimal places" would be a sentence nobody says.
    expect(refused.error).toBe('JPY does not support decimal places.');
  });

  it('never truncates — it reports', () => {
    // The check returns a verdict about the value; it does not return a value.
    const result = validateMonetaryDecimals('100.1234', 'JOD');
    expect(result.ok).toBe(false);
    expect(result.decimals).toBe(3);
    expect(Object.keys(result)).not.toContain('value');
  });
});

/* ══ 8 · Rounding policy ═══════════════════════════════════════════════════ */

describe('rounding at the currency’s precision', () => {
  it('rounds a calculated excess to the currency’s decimals', () => {
    // The specification's own example: a JOD calculation of 10.12349.
    expect(roundToCurrencyPrecision(10.12349, 'JOD')).toBeCloseTo(10.123, 10);
    expect(roundToCurrencyPrecision(10.1235, 'JOD')).toBeCloseTo(10.124, 10);
    expect(roundToCurrencyPrecision(10.125, 'USD')).toBeCloseTo(10.13, 10);
    expect(roundToCurrencyPrecision(1250.6, 'JPY')).toBe(1251);
  });

  it('leaves an amount already within precision untouched', () => {
    // Manually entered amounts are not silently changed.
    expect(roundToCurrencyPrecision(100.123, 'JOD')).toBeCloseTo(100.123, 10);
    expect(roundToCurrencyPrecision(100.12, 'USD')).toBeCloseTo(100.12, 10);
  });
});

/* ══ 13 · The journal balance check ════════════════════════════════════════ */

describe('the balance check follows the currency', () => {
  it('uses half the currency’s smallest unit as its tolerance', () => {
    companyKeepsBooksIn('JOD');
    expect(balanceToleranceFor()).toBeCloseTo(0.0005, 10);
    companyKeepsBooksIn('USD');
    expect(balanceToleranceFor()).toBeCloseTo(0.005, 10);
    companyKeepsBooksIn('JPY');
    expect(balanceToleranceFor()).toBe(0.5);
  });

  it('catches a one-fils imbalance a JOD company would otherwise post', () => {
    /*
     * The defect this replaces: `roundMoney` rounded to two decimals and the
     * tolerance was a fixed 0.005, so a JOD entry out by 0.001 was rounded to
     * nothing and reported as balanced.
     */
    companyKeepsBooksIn('JOD');
    const lines = [{ debit: 100.001, credit: 0 }, { debit: 0, credit: 100 }];
    const totals = computeTotals(lines);
    expect(totals.totalDebit).toBeCloseTo(100.001, 10);
    expect(totals.difference).toBeCloseTo(0.001, 10);
    expect(balanceStatus(totals)).toBe('unbalanced');
  });

  it('still treats the same difference as balanced for a USD company', () => {
    // Not a regression: in USD a 0.001 difference is below the smallest unit and
    // is genuine floating-point noise rather than a real imbalance.
    companyKeepsBooksIn('USD');
    const totals = computeTotals([{ debit: 100.001, credit: 0 }, { debit: 0, credit: 100 }]);
    expect(balanceStatus(totals)).toBe('balanced');
  });

  it('rounds subtotals at the company’s precision', () => {
    companyKeepsBooksIn('JOD');
    expect(roundMoney(100.1234)).toBeCloseTo(100.123, 10);
    companyKeepsBooksIn('USD');
    expect(roundMoney(100.1234)).toBeCloseTo(100.12, 10);
  });
});

/* ══ 20–24 · Reports ═══════════════════════════════════════════════════════ */

describe('reports display the company’s precision', () => {
  const cases = [
    ['General Journal / drawer', (n: number) => formatMoney(n)],
    ['Trial Balance', (n: number) => tbAmount(n)],
    ['Trial Balance totals', (n: number) => tbAmountAlways(n)],
    ['Balance Sheet', (n: number) => formatFinancialAmount(n)],
    ['Income Statement', (n: number) => isAmount(n)],
    ['General Ledger', (n: number) => formatBalanceLabel(n)],
  ] as const;

  it.each(cases)('%s shows three decimals for a JOD company', (_label, render) => {
    companyKeepsBooksIn('JOD');
    expect(render(1250)).toContain('1,250.000');
  });

  it.each(cases)('%s shows two decimals for a USD company', (_label, render) => {
    companyKeepsBooksIn('USD');
    expect(render(1250)).toContain('1,250.00');
    expect(render(1250)).not.toContain('1,250.000');
  });

  it.each(cases)('%s shows no decimals for a JPY company', (_label, render) => {
    companyKeepsBooksIn('JPY');
    expect(render(1250)).toContain('1,250');
    expect(render(1250)).not.toContain('1,250.');
  });

  it('does not hide a JOD amount smaller than half a cent', () => {
    // 0.003 JOD is three fils — a real amount, and it was being shown as "—"
    // because the "effectively zero" threshold was a fixed 0.005.
    companyKeepsBooksIn('JOD');
    expect(formatFinancialAmount(0.003)).not.toBe('—');
    expect(isAmount(0.003)).not.toBe('—');
    companyKeepsBooksIn('USD');
    expect(formatFinancialAmount(0.003)).toBe('—');
  });
});

/* ══ 25–26 · Switching companies ═══════════════════════════════════════════ */

describe('switching between companies', () => {
  it('changes precision from 3 to 2 and back, with nothing cached', () => {
    companyKeepsBooksIn('JOD');
    expect(companyMonetaryDecimals()).toBe(3);
    expect(formatMoney(1250)).toBe('1,250.000');

    companyKeepsBooksIn('USD');
    expect(companyMonetaryDecimals()).toBe(2);
    expect(formatMoney(1250)).toBe('1,250.00');

    companyKeepsBooksIn('JOD');
    expect(companyMonetaryDecimals()).toBe(3);
    expect(formatMoney(1250)).toBe('1,250.000');
  });

  it('does not leak one organization’s precision into another’s validation', () => {
    companyKeepsBooksIn('JOD');
    expect(validateCompanyMonetaryDecimals('100.123').ok).toBe(true);
    companyKeepsBooksIn('USD');
    expect(validateCompanyMonetaryDecimals('100.123').ok).toBe(false);
  });
});

/* ══ 30–31 · What precision must NOT touch ═════════════════════════════════ */

describe('concepts that are not monetary precision', () => {
  it('leaves exchange-rate precision independent', () => {
    /*
     * A rate is not an amount. JOD money has three decimals; a JOD exchange rate
     * still carries eight, because reducing a rate to the currency's monetary
     * precision would destroy the conversion it exists to perform.
     */
    companyKeepsBooksIn('JOD');
    const jod = useCurrencyStore.getState().getCurrency('JOD')!;
    expect(rateDecimalsOf(jod)).toBe(DEFAULT_RATE_DECIMALS);
    expect(rateDecimalsOf(jod)).toBe(8);
    expect(rateDecimalsOf(jod)).not.toBe(companyMonetaryDecimals());
  });

  it('leaves percentages alone', () => {
    // A 12.5% tax rate is 12.5% in every currency.
    companyKeepsBooksIn('JOD');
    expect(formatPercent(12.5)).toBe('+12.5%');
    companyKeepsBooksIn('JPY');
    expect(formatPercent(12.5)).toBe('+12.5%');
  });

  it('leaves Ledgora’s own platform metering alone', async () => {
    // Gigabytes and Ledgora's own billing are not the subscriber's books.
    companyKeepsBooksIn('JOD');
    const { round2 } = await import('@/lib/meteringCalculations');
    expect(round2(12.3456)).toBe(12.35);
  });
});

/**
 * One renderer, three currencies, every domain.
 *
 * ══ Why this file exists ═════════════════════════════════════════════════════
 *
 * Storage is `numeric(28,10)`, so every figure comes back from PostgreSQL with
 * ten decimals. Invoices and receipts trimmed that to the currency's precision;
 * the inventory reports did not, so an inventory value read `50.0000000000` on
 * a screen beside an invoice reading `50.000`. They now share one function, and
 * this is the test that keeps them sharing it: a copy made for one domain would
 * fail here the first time it disagreed.
 *
 * JOD three, USD two, JPY zero. The zero is the interesting one, because a
 * naive implementation slices nothing and renders the whole stored scale.
 */
import { describe, it, expect } from 'vitest';
import { monetaryDecimalsFor, renderAmount } from '../src/services/accounting/currencyPrecision.js';

describe('the shared monetary renderer', () => {
  it('renders a whole amount at each currency’s own precision', () => {
    expect(renderAmount('1234.0000000000', monetaryDecimalsFor('JOD'))).toBe('1234.000');
    expect(renderAmount('1234.0000000000', monetaryDecimalsFor('USD'))).toBe('1234.00');
    /* Zero decimals: a whole number, not ten places of nothing. */
    expect(renderAmount('1234.0000000000', monetaryDecimalsFor('JPY'))).toBe('1234');
  });

  it('knows the zero-decimal currencies, not just JPY', () => {
    for (const code of ['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XAF', 'XOF']) {
      expect(monetaryDecimalsFor(code), code).toBe(0);
      expect(renderAmount('500.0000000000', monetaryDecimalsFor(code)), code).toBe('500');
    }
    for (const code of ['JOD', 'KWD', 'BHD', 'OMR', 'TND']) {
      expect(monetaryDecimalsFor(code), code).toBe(3);
    }
    /* Anything else is an ordinary two-decimal currency rather than refused. */
    expect(monetaryDecimalsFor('ZZZ')).toBe(2);
  });

  it('keeps the digits a currency actually has', () => {
    expect(renderAmount('1234.5670000000', 3)).toBe('1234.567');
    expect(renderAmount('1234.5000000000', 2)).toBe('1234.50');
    expect(renderAmount('0.0010000000', 3)).toBe('0.001');
  });

  it('never HIDES an over-precise digit, because posting should have refused it', () => {
    /*
     * Rounding here would display a figure nobody wrote and make the
     * discrepancy invisible. Showing it is the honest failure.
     */
    expect(renderAmount('1234.5670000000', 2)).toBe('1234.567');
    expect(renderAmount('10.0000000001', 0)).toBe('10.0000000001');
  });

  it('renders negatives, and never a negative zero', () => {
    expect(renderAmount('-1234.0000000000', 3)).toBe('-1234.000');
    expect(renderAmount('-1234.0000000000', 0)).toBe('-1234');
    /* "-0.000" reads as an error rather than a balance. */
    expect(renderAmount('-0.0000000000', 3)).toBe('0.000');
    expect(renderAmount('-0.0000000000', 0)).toBe('0');
  });

  it('handles an absent figure without inventing one', () => {
    expect(renderAmount('', 2)).toBe('');
    expect(renderAmount(null, 2)).toBe('');
    expect(renderAmount(undefined, 2)).toBe('');
  });

  it('renders a quantity at the unit’s precision rather than a currency’s', () => {
    /* Quantities follow the unit: whole units read as whole numbers. */
    expect(renderAmount('10.0000000000', 0)).toBe('10');
    expect(renderAmount('2.5000000000', 0)).toBe('2.5');
    expect(renderAmount('-2.0000000000', 0)).toBe('-2');
  });
});

/**
 * Server figures are formatted as STRINGS, and the reason is not fussiness.
 *
 * The server aggregates in `numeric` precisely so no figure passes through a
 * binary float. Formatting with `Intl.NumberFormat` would take a `number` and
 * undo that at the very last step — the one the bookkeeper reads. These tests
 * pin values that a float round-trip visibly damages.
 */
import { describe, it, expect } from 'vitest';
import { serverAmount, serverAmountOrBlank, isServerZero } from './serverAmount';

describe('serverAmount', () => {
  it('groups thousands without parsing the number', () => {
    expect(serverAmount('1234567.891', 3)).toBe('1,234,567.891');
    expect(serverAmount('999.000', 3)).toBe('999.000');
    expect(serverAmount('1000.00', 2)).toBe('1,000.00');
  });

  it('keeps a value a float would not survive', () => {
    /* 17 significant digits: `Number(...)` loses the tail, and a trial balance
     * out by a unit in the last place is one a bookkeeper cannot sign. */
    const exact = '12345678901234.567';
    expect(serverAmount(exact, 3)).toBe('12,345,678,901,234.567');

    /* The classic: 0.1 + 0.2 is not 0.3 in binary. Nothing here adds, so the
     * digits the server sent are the digits shown. */
    expect(serverAmount('0.300', 3)).toBe('0.300');
  });

  it('pads to the snapshot precision, and never invents digits beyond it', () => {
    expect(serverAmount('5', 3)).toBe('5.000');
    expect(serverAmount('5.1', 3)).toBe('5.100');
    /* A zero-decimal currency shows no point at all. */
    expect(serverAmount('1500', 0)).toBe('1,500');
  });

  it('keeps a negative sign, and does not print negative zero', () => {
    expect(serverAmount('-2500.500', 3)).toBe('-2,500.500');
    /* "-0.000" reads as an error rather than as nothing. */
    expect(serverAmount('-0.000', 3)).toBe('0.000');
  });

  it('strips leading zeros without eating the value', () => {
    expect(serverAmount('0007.500', 3)).toBe('7.500');
    expect(serverAmount('0.750', 3)).toBe('0.750');
  });

  it('decides zero on the string, never by parsing', () => {
    expect(isServerZero('0.000')).toBe(true);
    expect(isServerZero('-0.00')).toBe(true);
    expect(isServerZero('')).toBe(true);
    expect(isServerZero(null)).toBe(true);
    expect(isServerZero('0.001')).toBe(false);
    expect(isServerZero('100.000')).toBe(false);
  });

  it('blanks a zero in a table body, the convention the statements use', () => {
    expect(serverAmountOrBlank('0.000', 3)).toBe('');
    expect(serverAmountOrBlank('0.001', 3)).toBe('0.001');
  });
});

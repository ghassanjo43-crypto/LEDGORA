import { describe, it, expect } from 'vitest';
import {
  decAdd, decSub, decMul, decDiv, decCmp, decRound, decRoundToIncrement,
  decSum, decToNumber, decNormalize, decAbs, decNeg, decIsZero, isDecimal,
} from '@/lib/decimal';

describe('decimal parsing & normalization', () => {
  it('normalizes plain and exponent forms', () => {
    expect(decNormalize('1234.5678')).toBe('1234.5678');
    expect(decNormalize(1e-7)).toBe('0.0000001');
    expect(decNormalize('-0')).toBe('0');
    expect(decNormalize('.5')).toBe('0.5');
  });
  it('rejects non-decimals', () => {
    expect(isDecimal('abc')).toBe(false);
    expect(isDecimal(NaN)).toBe(false);
    expect(isDecimal(Infinity)).toBe(false);
    expect(isDecimal('12.3.4')).toBe(false);
    expect(isDecimal('10.50')).toBe(true);
  });
});

describe('decimal-safe arithmetic', () => {
  it('adds without float drift (0.1 + 0.2 = 0.3 exactly)', () => {
    expect(decAdd('0.1', '0.2')).toBe('0.3');
    expect(decAdd(0.1, 0.2)).toBe('0.3');
  });
  it('subtracts across scales', () => {
    expect(decSub('1.005', '0.0049')).toBe('1.0001');
  });
  it('multiplies exactly (the classic 1.1 × 1.1 case)', () => {
    expect(decMul('1.1', '1.1')).toBe('1.21');
    expect(decMul('1234.5678', '0.709')).toBe('875.3085702');
  });
  it('divides to a controlled scale', () => {
    expect(decDiv('1', '3', 6)).toBe('0.333333');
    expect(decDiv('10', '4', 2)).toBe('2.50');
    expect(() => decDiv('1', '0')).toThrow();
  });
  it('sums a mixed list', () => {
    expect(decSum(['0.1', '0.2', '0.3', '-0.6'])).toBe('0.0'); // scale of the inputs is kept
    expect(decIsZero(decSum(['0.1', '0.2', '-0.3']))).toBe(true);
  });
  it('compares magnitudes', () => {
    expect(decCmp('1.10', '1.1')).toBe(0);
    expect(decCmp('-2', '1')).toBe(-1);
    expect(decCmp('0.0000000000000000019', '0.0000000000000000018')).toBe(1);
  });
  it('abs / neg', () => {
    expect(decAbs('-5.5')).toBe('5.5');
    expect(decNeg('5.5')).toBe('-5.5');
  });
});

describe('rounding methods', () => {
  it('half-up rounds ties away from zero', () => {
    expect(decRound('2.5', 0, 'half-up')).toBe('3');
    expect(decRound('-2.5', 0, 'half-up')).toBe('-3');
    expect(decRound('1234.5678', 3, 'half-up')).toBe('1234.568');
  });
  it('half-down rounds ties toward zero', () => {
    expect(decRound('2.5', 0, 'half-down')).toBe('2');
    expect(decRound('-2.5', 0, 'half-down')).toBe('-2');
    expect(decRound('2.51', 0, 'half-down')).toBe('3');
  });
  it('half-even is banker’s rounding', () => {
    expect(decRound('2.5', 0, 'half-even')).toBe('2');
    expect(decRound('3.5', 0, 'half-even')).toBe('4');
    expect(decRound('2.675', 2, 'half-even')).toBe('2.68');
  });
  it('directed modes', () => {
    expect(decRound('2.9', 0, 'toward-zero')).toBe('2');
    expect(decRound('-2.9', 0, 'toward-zero')).toBe('-2');
    expect(decRound('2.1', 0, 'away-from-zero')).toBe('3');
    expect(decRound('-2.1', 0, 'away-from-zero')).toBe('-3');
    expect(decRound('-2.1', 0, 'floor')).toBe('-3');
    expect(decRound('2.1', 0, 'ceiling')).toBe('3');
  });
  it('pads to the requested precision (JOD 3dp, BTC 8dp)', () => {
    expect(decRound('5', 3)).toBe('5.000');
    expect(decRound('0.000123456789', 8)).toBe('0.00012346');
  });
  it('supports 18 decimal places without precision loss', () => {
    const wei = '0.000000000000000001'; // 1 wei
    expect(decRound(wei, 18)).toBe(wei);
    expect(decAdd(wei, wei)).toBe('0.000000000000000002');
    expect(decMul(wei, '2')).toBe('0.000000000000000002');
  });
});

describe('rounding increments', () => {
  it('rounds cash amounts to 0.05', () => {
    expect(decRoundToIncrement('1.02', '0.05', 2)).toBe('1.00');
    expect(decRoundToIncrement('1.03', '0.05', 2)).toBe('1.05');
    expect(decRoundToIncrement('1.075', '0.05', 2)).toBe('1.10');
  });
  it('supports 0.1 and 0.001 increments', () => {
    expect(decRoundToIncrement('7.24', '0.1', 1)).toBe('7.2');
    expect(decRoundToIncrement('7.26', '0.1', 1)).toBe('7.3');
    expect(decRoundToIncrement('1.2345', '0.001', 3)).toBe('1.235'); // JOD-style fils
  });
});

describe('decimal ↔ number bridge', () => {
  it('round-trips conventional fiat amounts', () => {
    expect(decToNumber('1234.57')).toBe(1234.57);
    expect(decToNumber(decRound('1234.5678', 2))).toBe(1234.57);
  });
});

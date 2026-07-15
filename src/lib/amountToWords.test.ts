import { describe, it, expect } from 'vitest';
import { amountToWords, integerToWords } from './amountToWords';

describe('integerToWords', () => {
  it('handles zero, teens, tens and scales', () => {
    expect(integerToWords(0)).toBe('zero');
    expect(integerToWords(7)).toBe('seven');
    expect(integerToWords(16)).toBe('sixteen');
    expect(integerToWords(42)).toBe('forty-two');
    expect(integerToWords(100)).toBe('one hundred');
    expect(integerToWords(1160)).toBe('one thousand one hundred sixty');
    expect(integerToWords(1000000)).toBe('one million');
  });
});

describe('amountToWords', () => {
  it('renders the acceptance JOD amount', () => {
    expect(amountToWords(1160, 'JOD')).toBe('One thousand one hundred sixty Jordanian dinars only');
  });
  it('renders minor units for USD', () => {
    expect(amountToWords(12.5, 'USD')).toBe('Twelve US dollars and fifty cents only');
    expect(amountToWords(1, 'USD')).toBe('One US dollar only');
  });
  it('falls back to the currency code for unknown currencies', () => {
    expect(amountToWords(5, 'XYZ')).toBe('Five XYZ only');
  });
});

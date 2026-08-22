// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MoneyInput } from './MoneyInput';
import { useStore } from '@/store/useStore';

beforeEach(() => {
  useStore.setState((state) => ({ settings: { ...state.settings, baseCurrency: 'JOD' } }));
});

afterEach(() => cleanup());

describe('MoneyInput', () => {
  it('uses company precision without forbidding negative amounts', () => {
    const onChange = vi.fn();
    render(<MoneyInput aria-label="Amount" value="" onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Amount' });

    expect(input.getAttribute('inputmode')).toBe('decimal');
    expect(input.getAttribute('step')).toBe('0.001');
    expect(input.hasAttribute('min')).toBe(false);
    fireEvent.change(input, { target: { value: '-12.345' } });
    expect(onChange).toHaveBeenLastCalledWith('-12.345');
  });

  it('preserves zero and an intermediate trailing decimal separator', () => {
    const onChange = vi.fn();
    render(<MoneyInput aria-label="Amount" value="" onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Amount' });

    fireEvent.change(input, { target: { value: '0' } });
    expect(onChange).toHaveBeenLastCalledWith('0');
    fireEvent.change(input, { target: { value: '12.' } });
    expect(onChange).toHaveBeenLastCalledWith('12.');
  });

  it('reports excess precision without altering pasted text', () => {
    const onChange = vi.fn();
    const onPrecisionError = vi.fn();
    render(
      <MoneyInput
        aria-label="Amount"
        value=""
        onChange={onChange}
        onPrecisionError={onPrecisionError}
      />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Amount' }), {
      target: { value: '-10.1234' },
    });
    expect(onChange).toHaveBeenLastCalledWith('-10.1234');
    expect(onPrecisionError.mock.lastCall?.[0]).toMatch(/JOD supports a maximum of 3 decimal places/);
  });
});

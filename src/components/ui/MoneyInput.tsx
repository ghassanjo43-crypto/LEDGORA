/**
 * A monetary field denominated in the active company's functional currency.
 *
 * ══ Why this exists alongside AmountInput ════════════════════════════════════
 *
 * `AmountInput` is a GENERIC formatted-number field. It is also used for things
 * that are not money — quantities, rates — so it must not assume the company's
 * currency, and its `decimals` prop stays explicit. Making it company-aware
 * would silently give a JOD company three decimals on a quantity field.
 *
 * This wrapper is the company-money case, and it is the one accounting forms
 * should reach for. Precision, the input `step` and the placeholder all come
 * from the same canonical chain — organization → functional currency →
 * `Currency.decimalPlaces` — so a JOD company gets `0.000` and a step of
 * `0.001`, a USD company `0.00` and `0.01`, and a JPY company whole units.
 *
 * ══ Rejects rather than truncates ════════════════════════════════════════════
 *
 * Typing a fourth decimal into a JOD field does not silently lose it. The field
 * reports the currency's limit and the value is left as typed for the user to
 * correct, because an accounting system that quietly alters what someone
 * entered turns a typo into a posted figure nobody was told about.
 */
import { forwardRef } from 'react';
import { Input } from '@/components/ui/Input';
import { useMonetaryPrecision, useCompanyCurrencyCode } from '@/lib/useMonetaryPrecision';
import { validateMonetaryDecimals } from '@/lib/monetaryPrecision';

export interface MoneyInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'step' | 'type' | 'value'> {
  value: number | string;
  onChange: (value: string) => void;
  /** Reported when the typed value carries more decimals than the currency has. */
  onPrecisionError?: (message: string | null) => void;
  hasError?: boolean;
  /** Override the currency; defaults to the active company's functional one. */
  currencyCode?: string;
}

export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput(
  { value, onChange, onPrecisionError, hasError, currencyCode, className, ...rest },
  ref,
) {
  const companyCode = useCompanyCurrencyCode();
  const code = currencyCode ?? companyCode;
  const decimals = useMonetaryPrecision(code);

  // 0.001 for JOD, 0.01 for USD, 1 for JPY — the smallest amount the currency
  // can express, so the browser's own stepper agrees with the ledger.
  const step = 10 ** -decimals;

  return (
    <Input
      ref={ref}
      type="text"
      inputMode="decimal"
      step={step}
      placeholder={decimals > 0 ? `0.${'0'.repeat(decimals)}` : '0'}
      value={value}
      hasError={hasError}
      className={className}
      onChange={(e) => {
        const next = e.target.value;
        const check = validateMonetaryDecimals(next, code);
        // Reported, not corrected: the value stays exactly as typed.
        onPrecisionError?.(check.ok ? null : check.error ?? null);
        onChange(next);
      }}
      {...rest}
    />
  );
});

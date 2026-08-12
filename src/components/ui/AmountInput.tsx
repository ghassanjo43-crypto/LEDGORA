import { forwardRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { toDecimalAmount } from '@/lib/journalDraft';
import { decToNumber } from '@/lib/decimal';

/**
 * A monetary input that shows a fully formatted figure when it is not being
 * edited, and a plain editable number while it is.
 *
 * ── Why not `<input type="number">` ─────────────────────────────────────────
 * A number input cannot display thousands separators — browsers refuse a value
 * that is not a bare numeral — so `1250000000` renders as an undifferentiated
 * run of digits. In a ledger that is exactly the figure a reader has to be able
 * to take in at a glance: `1,250,000,000.00` and `125,000,000.00` differ by an
 * order of magnitude and by one character.
 *
 * ── Why formatting is dropped while focused ─────────────────────────────────
 * Re-formatting on every keystroke means re-placing the caret on every
 * keystroke, and every implementation of that gets it wrong somewhere — typing
 * in the middle, selecting a range, pasting, deleting a separator. The value
 * being edited is therefore shown raw, and formatted the moment the field is
 * left. Nothing is ever hidden: the field is sized for the formatted string,
 * which is always the longer of the two.
 *
 * Parsing goes through {@link toDecimalAmount}, the same grouped-input-tolerant
 * parser the General Journal uses, so a pasted `1,250,000,000.00` is understood
 * rather than silently scored as zero.
 */
export interface AmountInputProps {
  value: number;
  onChange: (value: number) => void;
  /** Decimal places shown when the field is not focused. */
  decimals?: number;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  'data-testid'?: string;
  id?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

function format(value: number, decimals: number): string {
  if (!Number.isFinite(value) || value === 0) return '';
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export const AmountInput = forwardRef<HTMLInputElement, AmountInputProps>(function AmountInput(
  { value, onChange, decimals = 2, disabled, className, id, onKeyDown, ...rest },
  ref,
) {
  const [editing, setEditing] = useState(false);
  /** What the user is literally typing; only meaningful while focused. */
  const [draft, setDraft] = useState('');

  const display = editing ? draft : format(value, decimals);

  return (
    <input
      ref={ref}
      id={id}
      type="text"
      // `decimal` gets the numeric keypad on touch without the spinner and the
      // scroll-wheel-changes-the-value hazard of type="number".
      inputMode="decimal"
      disabled={disabled}
      value={display}
      onFocus={() => {
        // Seed the editable draft from the real value, unformatted.
        setDraft(value === 0 ? '' : String(value));
        setEditing(true);
      }}
      onBlur={() => setEditing(false)}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(decToNumber(toDecimalAmount(e.target.value)));
      }}
      onKeyDown={onKeyDown}
      className={cn(
        // `tabular-nums`: digits share a width, so columns of figures line up
        // and a number does not reflow as it is typed.
        'focus-ring w-full rounded-lg border bg-white px-2.5 py-1.5 text-right text-sm tabular-nums text-slate-900 transition-colors disabled:cursor-not-allowed disabled:opacity-60 dark:bg-slate-900 dark:text-slate-100',
        'border-slate-300 dark:border-slate-700',
        className,
      )}
      {...rest}
    />
  );
});

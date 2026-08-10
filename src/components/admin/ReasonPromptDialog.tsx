/**
 * Confirmation with a mandatory, audited reason.
 *
 * ── Why not `window.prompt` ──────────────────────────────────────────────────
 * Every destructive or security-sensitive administrator action requires a written
 * reason that the server records in the audit trail. A browser prompt cannot
 * explain the consequences, cannot show a warning, cannot be styled to
 * distinguish "suspend an account" from "archive a customer", and cannot be
 * asserted in a test. This dialog does all four, and refuses to submit until a
 * reason has actually been typed — the same rule the backend enforces, surfaced
 * before the round trip instead of after it.
 *
 * The `consequences` slot is what makes a downgrade confirmable in good
 * conscience: the operator reads what will happen, in the same dialog where they
 * accept it.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, Textarea } from '@/components/ui/Input';
import { Alert } from '@/components/ui/Alert';
import { Icon } from '@/components/ui/icons';

export interface ReasonPromptProps {
  open: boolean;
  title: string;
  /** What the operator is about to do, in plain language. */
  description: ReactNode;
  /** Rendered above the reason field — used for downgrade consequences. */
  consequences?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  /** A server-side failure from the previous attempt, kept visible. */
  error?: string | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

export function ReasonPromptDialog({
  open,
  title,
  description,
  consequences,
  confirmLabel = 'Confirm',
  destructive,
  busy,
  error,
  onConfirm,
  onCancel,
}: ReasonPromptProps) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  // A fresh dialog starts empty — a reason typed for one action must never be
  // silently reused as the audit record for a different one.
  useEffect(() => {
    if (open) {
      setReason('');
      setTouched(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const trimmed = reason.trim();
  const missing = touched && trimmed.length === 0;

  const submit = (): void => {
    setTouched(true);
    if (!trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" role="alertdialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => !busy && onCancel()} aria-hidden />
      <div className="relative w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-start gap-3">
          <span
            className={
              destructive
                ? 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-500/15 dark:text-red-400'
                : 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400'
            }
          >
            <Icon.Alert className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
            <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">{description}</div>
          </div>
        </div>

        <div className="mt-4 max-h-[45vh] space-y-3 overflow-y-auto">
          {consequences}
          {error && <Alert variant="error">{error}</Alert>}
          <Field
            label="Reason"
            required
            error={missing ? 'A reason is required and is recorded in the audit trail.' : undefined}
            hint={missing ? undefined : 'Recorded in the audit trail against your account.'}
          >
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              onBlur={() => setTouched(true)}
              hasError={missing}
              placeholder="Why is this change being made?"
              aria-label="Reason"
              data-testid="reason-input"
            />
          </Field>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={submit}
            // Disabled until a reason exists, so the failure is prevented rather
            // than reported by the server a round trip later.
            disabled={busy || trimmed.length === 0}
            data-testid="reason-confirm"
          >
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

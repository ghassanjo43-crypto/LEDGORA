/**
 * "Request permanent deletion" — the step-up confirmation dialog.
 *
 * ── How the password is handled ──────────────────────────────────────────────
 * It lives in ONE `useState` in this component and nowhere else. Not in a
 * Zustand store, not in `localStorage` or `sessionStorage`, not in a URL, not in
 * an analytics call and not in a log line. It is cleared on success, on cancel,
 * on unmount, and after every failed attempt — so a dialog left open on a screen
 * is not holding a credential.
 *
 * It is submitted only to `requestDeletion`, which passes it to the established
 * server-side step-up check. The server never echoes it and this component never
 * puts it in an error message: a failure renders the server's message, and the
 * only thing this dialog does with the value afterwards is discard it.
 *
 * ── Why a failed step-up keeps the dialog open ───────────────────────────────
 * A mistyped password should cost the operator the password field, not the
 * reason and confirmation they have already typed. So `reauthentication_failed`
 * clears exactly one field and leaves the rest — while any other failure leaves
 * everything, because the operator may want to read the blockers and try
 * something else.
 *
 * ── Nothing here is a security control ───────────────────────────────────────
 * Every gate below is also enforced server-side: the eligibility assessment is
 * recomputed inside the purge transaction, the confirmation is checked against
 * the database, and the password is verified against the stored digest. This
 * dialog exists so the operator understands what they are about to do — not to
 * decide whether they may.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Input, Field, Textarea } from '@/components/ui/Input';
import { ApiError } from '@/services/api/client';
import { PERMANENT_DELETION_DISCLOSURE } from '@/services/api/cleanupApi';
import {
  subscriberClosureApi,
  type DeletionImpact,
  type DeletionRequestResult,
} from '@/services/api/closureApi';
import { ClosureImpactReport } from './ClosureImpactReport';

export interface RequestDeletionDialogProps {
  open: boolean;
  organizationId: string;
  legalName: string;
  ownerEmail: string | null;
  /** Fetched by the caller so the dialog opens with the verdict already known. */
  impact: DeletionImpact | null;
  impactError?: string | null;
  onClose: () => void;
  onScheduled: (result: DeletionRequestResult) => void;
  /** Offered when deletion is blocked — the recommended action instead. */
  onArchiveInstead?: () => void;
}

export function RequestDeletionDialog({
  open,
  organizationId,
  legalName,
  ownerEmail,
  impact,
  impactError,
  onClose,
  onScheduled,
  onArchiveInstead,
}: RequestDeletionDialogProps) {
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  /** The operator's password. Local state only — see the module note. */
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /**
   * Clear every field — the password included — whenever the dialog closes or
   * unmounts. A credential must not survive the dialog that collected it.
   */
  useEffect(() => {
    if (open) return;
    setReason('');
    setConfirmation('');
    setAcknowledged(false);
    setPassword('');
    setError(null);
    setFieldErrors({});
    setSubmitting(false);
  }, [open]);

  useEffect(
    () => () => {
      // Unmount, including a navigation away with the dialog open.
      setPassword('');
    },
    [],
  );

  const permitted = impact?.deletionPermitted ?? false;

  /** The identifier the server will accept. Compared server-side, not here. */
  const confirmationMatches = useMemo(() => {
    const typed = confirmation.trim().toLowerCase();
    if (!typed) return false;
    return typed === legalName.trim().toLowerCase() || typed === (ownerEmail ?? '').trim().toLowerCase();
  }, [confirmation, legalName, ownerEmail]);

  const ready =
    permitted &&
    reason.trim().length > 0 &&
    confirmationMatches &&
    acknowledged &&
    password.length > 0 &&
    !submitting;

  const submit = useCallback(async (): Promise<void> => {
    // Guards against a double submission from a fast second click or an Enter
    // key arriving while the first request is still in flight.
    if (submitting || !ready) return;
    setSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      const result = await subscriberClosureApi.requestDeletion(organizationId, {
        reason: reason.trim(),
        confirmation: confirmation.trim(),
        password,
      });
      // Success: the credential goes immediately, before anything else happens.
      setPassword('');
      onScheduled(result);
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : null;

      if (apiError?.code === 'reauthentication_failed') {
        /*
         * Clear ONLY the password. The operator mistyped one field; making them
         * retype the reason and the organization name as well would be a
         * punishment, not a safeguard.
         */
        setPassword('');
        setFieldErrors({ password: 'That password is not correct.' });
        setError(apiError.message);
      } else {
        /*
         * Any other failure — blocked, conflict, network. The password is still
         * cleared: it has been sent once and this dialog has no reason to keep
         * holding it while the operator reads a blocker list.
         */
        setPassword('');
        const details = (caught as { details?: { fieldErrors?: Record<string, string> } }).details;
        if (details?.fieldErrors) setFieldErrors(details.fieldErrors);
        // The server's own wording, never replaced by a generic message.
        setError(apiError?.message ?? 'The deletion request could not be completed.');
      }
    } finally {
      setSubmitting(false);
    }
  }, [submitting, ready, organizationId, reason, confirmation, password, onScheduled]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`Permanently delete ${legalName}`}
      data-testid="request-deletion-dialog"
    >
      <div className="my-8 w-full max-w-3xl rounded-xl border border-red-300 bg-white shadow-xl dark:border-red-500/40 dark:bg-slate-900">
        <div className="flex items-start gap-3 border-b border-slate-200 p-5 dark:border-slate-700">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" aria-hidden />
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">
              Permanently delete {legalName} from Ledgora&rsquo;s platform
            </h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              This schedules the irreversible destruction of this subscriber&rsquo;s account records. Deactivating
              and archiving is the normal way to close an account and retains everything.
            </p>
            {/*
              The same disclosure the bulk console shows. This dialog schedules a
              purge rather than running one, but it ends in the same place, so it
              has to be equally clear about what that purge cannot reach.
            */}
            <p
              className="mt-2 text-sm text-slate-600 dark:text-slate-300"
              data-testid="deletion-disclosure"
            >
              {PERMANENT_DELETION_DISCLOSURE}
            </p>
          </div>
        </div>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto p-5">
          {impactError && (
            <Alert variant="error" title="The eligibility assessment could not be loaded">
              {impactError} Deletion cannot be requested until it succeeds.
            </Alert>
          )}

          {impact && <ClosureImpactReport impact={impact} />}

          {/* ── Blocked: no form at all, and the safe action offered instead ── */}
          {impact && !permitted && (
            <Alert variant="warning" title="This subscriber cannot be permanently deleted">
              <p>{impact.recommendation}</p>
              {onArchiveInstead && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={onArchiveInstead}
                  data-testid="archive-instead"
                >
                  Deactivate and archive instead
                </Button>
              )}
            </Alert>
          )}

          {/* ── Permitted: the confirmation form ─────────────────────────── */}
          {permitted && (
            <>
              <Alert variant="warning" title="What happens next">
                <ul className="list-disc space-y-1 pl-4">
                  <li>The account is archived immediately and every member is signed out.</li>
                  <li>
                    A <span className="font-semibold">30-day recovery period</span> begins. Nothing is destroyed
                    during it, and you can cancel at any time.
                  </li>
                  <li>
                    After that, the purge runs only if the subscriber is <em>still</em> eligible — the
                    assessment is repeated at that moment.
                  </li>
                </ul>
              </Alert>

              {error && (
                <Alert variant="error" title="Could not schedule the deletion" onClose={() => setError(null)}>
                  {error}
                </Alert>
              )}

              <Field
                label="Reason"
                required
                error={fieldErrors.reason}
                hint="Recorded in the audit trail against this subscriber, permanently."
              >
                <Textarea
                  rows={2}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why is this account being deleted?"
                  data-testid="deletion-reason"
                />
              </Field>

              <Field
                label={`Type “${legalName}” to confirm`}
                required
                error={fieldErrors.confirmation}
                hint={
                  ownerEmail
                    ? `The owner's email address (${ownerEmail}) is also accepted.`
                    : 'Checked against the organization record on the server.'
                }
              >
                <Input
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  autoComplete="off"
                  data-testid="deletion-confirmation"
                />
              </Field>

              <label className="flex items-start gap-2 rounded-lg border border-red-200 p-3 text-sm dark:border-red-500/30">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  data-testid="deletion-acknowledge"
                />
                <span>
                  I understand this is <span className="font-semibold">irreversible</span> once the recovery
                  period ends, and that records held in the customer&rsquo;s browser workspace are neither
                  assessed nor removed by this action.
                </span>
              </label>

              <Field
                label="Confirm your password"
                required
                error={fieldErrors.password}
                hint="Verified by the server against your own account. It is never stored or logged."
              >
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  data-testid="deletion-password"
                />
              </Field>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 p-4 dark:border-slate-700">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!ready}
            onClick={() => void submit()}
            data-testid="deletion-submit"
          >
            {submitting ? 'Scheduling…' : 'Schedule permanent deletion'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Small helper the drawer reuses to render a scheduled-purge badge. */
export function ScheduledPurgeBadge({ scheduledPurgeAfter }: { scheduledPurgeAfter: string | null }) {
  if (!scheduledPurgeAfter) return null;
  return (
    <Badge tone="red" title={`Purge permitted after ${scheduledPurgeAfter}`}>
      Deletion scheduled · {new Date(scheduledPurgeAfter).toLocaleDateString()}
    </Badge>
  );
}

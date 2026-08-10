/**
 * The one place a generated credential is ever displayed.
 *
 * ── Why this is its own component, with its own modal shell ───────────────────
 * A temporary password (or an invitation token) exists in exactly one API response
 * and nowhere else — not in the database in recoverable form, not in a log, not in
 * a store. So the UI has one job and one chance: show it clearly, say plainly that
 * it cannot be retrieved again, and make losing it hard.
 *
 * That last part is why this does NOT use the shared `Drawer`: `Drawer` closes on
 * Escape and on a backdrop click, which are exactly the two accidents that destroy
 * an unrecoverable value. This dialog:
 *   · ignores Escape;
 *   · ignores backdrop clicks;
 *   · keeps its close control DISABLED until the administrator ticks "I have
 *     copied this".
 * The only way out is a deliberate acknowledgement.
 *
 * ── Lifetime of the secret ───────────────────────────────────────────────────
 * The value arrives as a prop, is rendered, and is dropped by the parent when this
 * dialog closes. It is never written to a store, a URL, `localStorage`,
 * `sessionStorage`, or the clipboard without an explicit click.
 *
 * ── Honest delivery status ───────────────────────────────────────────────────
 * `deliveryStatus` comes from the server. Only `sent` is reported as delivered;
 * `unavailable` and `failed` say what actually happened, in the server's own
 * words. This component never renders "Email sent".
 */
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import type { CredentialDeliveryStatus } from '@/services/api/adminConsoleApi';
import { ROUTES } from '@/lib/accessControl';
import { KeyRound, Link2, Copy, Check, X } from 'lucide-react';

export interface CredentialResult {
  /** Who it is for — shown so an operator cannot pass it to the wrong person. */
  subjectName: string;
  subjectEmail: string;
  type: 'temporary_password' | 'invitation';
  /** Present for `temporary_password`. Shown once; never stored. */
  temporaryPassword?: string | undefined;
  /** Present for `invitation`. Shown once; never stored. */
  invitationToken?: string | undefined;
  expiresAt: string;
  deliveryStatus: CredentialDeliveryStatus;
  mustChangePassword?: boolean | undefined;
  /** How many sessions issuing it ended, when it ended any. */
  revokedSessions?: number | undefined;
  message: string;
}

/** Absolute date AND relative distance — an operator needs both. */
function expiryLabel(iso: string): string {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return 'soon';
  const stamp = new Date(iso).toISOString().replace('T', ' ').slice(0, 16);
  const minutes = Math.round((target - Date.now()) / 60_000);
  const relative =
    minutes < 60
      ? `in ${Math.max(minutes, 1)} minutes`
      : minutes < 60 * 48
        ? `in ${Math.round(minutes / 60)} hours`
        : `in ${Math.round(minutes / 1440)} days`;
  return `${stamp} UTC (${relative})`;
}

/**
 * A single-use link the operator can hand over when mail is unavailable.
 *
 * The path comes from `ROUTES.acceptInvitation`, not a literal: this used to
 * build `/reset-password?token=…`, which no route serves — the redemption page
 * is registered at `/set-password`. An operator copying that link handed the
 * recipient a dead URL, and nothing failed loudly enough to say so.
 *
 * The COMPLETE link is what is shown, never the bare token: the recipient should
 * be able to open it, and an operator reassembling a URL by hand is how the
 * token ends up pasted somewhere it should not be.
 */
function resetLinkFor(token: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}${ROUTES.acceptInvitation}?token=${encodeURIComponent(token)}`;
}

const DELIVERY_COPY: Record<CredentialDeliveryStatus, { title: string; variant: 'success' | 'warning' | 'error' }> = {
  sent: { title: 'Delivered by email', variant: 'success' },
  // Not a failure: nothing was attempted, so the operator is the channel.
  unavailable: { title: 'Not sent — email delivery is not configured', variant: 'warning' },
  failed: { title: 'Delivery failed', variant: 'error' },
};

function CopyRow({
  label,
  value,
  testId,
  onCopied,
}: {
  label: string;
  value: string;
  testId: string;
  onCopied: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // A clipboard refusal is not worth interrupting the operator for — the value
      // is on screen and selectable. Still count it as "they tried to copy".
      setCopied(false);
    } finally {
      onCopied();
    }
  };

  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{label}</span>
      <div className="flex items-stretch gap-2">
        <code
          data-testid={testId}
          className="focus-ring min-w-0 flex-1 select-all break-all rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-sm tracking-wide text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        >
          {value}
        </code>
        <Button variant="outline" size="sm" onClick={() => void copy()} aria-label={`Copy ${label}`} data-testid="credential-copy">
          {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

export function CredentialResultDialog({
  result,
  onClose,
}: {
  result: CredentialResult | null;
  /** Must drop the credential from state — this dialog cannot be reopened. */
  onClose: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const titleId = useId();
  const isPassword = result?.type === 'temporary_password';

  // A new credential starts unacknowledged, so a tick left over from a previous
  // one can never let the next value be dismissed unread.
  useEffect(() => {
    setAcknowledged(false);
  }, [result?.temporaryPassword, result?.invitationToken, result?.subjectEmail]);

  /*
   * Escape is deliberately SWALLOWED rather than ignored. Any dialog underneath
   * (the creation drawer's own Escape handler, for instance) would otherwise
   * still act on the key press while this one is open.
   */
  useEffect(() => {
    if (!result) return;
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', handler, true);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handler, true);
      document.body.style.overflow = '';
    };
  }, [result]);

  if (!result) return null;

  const delivery = DELIVERY_COPY[result.deliveryStatus];
  const secret = isPassword ? result.temporaryPassword : result.invitationToken;
  const acknowledgeLabel = isPassword
    ? 'I have copied the temporary password.'
    : 'I have copied the invitation link.';

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="credential-dialog"
    >
      {/*
        A plain backdrop with NO click handler. Dismissing an unrecoverable value
        by clicking slightly off-target is the accident this prevents.
      */}
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" aria-hidden />

      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900">
        <div className="border-b border-slate-200 px-6 py-4 dark:border-slate-800">
          <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100">
            {isPassword ? <KeyRound className="h-4 w-4" aria-hidden /> : <Link2 className="h-4 w-4" aria-hidden />}
            {isPassword ? 'Temporary password' : 'Invitation link'}
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            For {result.subjectName} —{' '}
            <span className="font-medium text-slate-700 dark:text-slate-200" data-testid="credential-email">
              {result.subjectEmail}
            </span>
          </p>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          {/* Delivery status, in the server's words. Never "Email sent". */}
          <Alert variant={delivery.variant} title={delivery.title}>
            <span data-testid="credential-delivery">{result.message}</span>
          </Alert>

          <Alert variant="error" title="Shown only once">
            <span data-testid="credential-once-warning">
              {isPassword
                ? 'Ledgora stores only an Argon2id hash of this password. Nobody — including you — can read it back after this dialog closes. If it is lost, generate a new one.'
                : 'Only a hash of this token is stored. The link works once and cannot be shown again. If it is lost, issue a new one.'}
            </span>
          </Alert>

          {secret ? (
            <CopyRow
              label={isPassword ? 'Temporary password' : 'Reset link'}
              value={isPassword ? secret : resetLinkFor(secret)}
              testId={isPassword ? 'credential-value' : 'credential-link'}
              onCopied={() => setAcknowledged(true)}
            />
          ) : (
            <Alert variant="warning" title="No credential was returned">
              The account exists, but no one-time credential came back with the response. Generate a new temporary
              password from the member details.
            </Alert>
          )}

          {result.mustChangePassword && (
            <Alert variant="warning" title="Must be changed at first login">
              <span data-testid="credential-force-change">
                {result.subjectName} cannot use the account until they replace this password. The server refuses every
                other request until they do.
              </span>
            </Alert>
          )}

          <dl className="grid gap-2 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-500">Expires</dt>
              <dd className="text-right font-medium" data-testid="credential-expiry">
                {expiryLabel(result.expiresAt)}
              </dd>
            </div>
            {result.mustChangePassword && (
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-500">First sign-in</dt>
                <dd>
                  <Badge tone="amber">Must choose a new password</Badge>
                </dd>
              </div>
            )}
            {typeof result.revokedSessions === 'number' && (
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-500">Sessions ended</dt>
                <dd className="font-medium" data-testid="credential-revoked">
                  {result.revokedSessions}
                </dd>
              </div>
            )}
          </dl>
        </div>

        <div className="space-y-3 border-t border-slate-200 px-6 py-4 dark:border-slate-800">
          <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              data-testid="credential-acknowledge"
            />
            <span>{acknowledgeLabel}</span>
          </label>
          <div className="flex justify-end">
            <Button
              onClick={onClose}
              // The gate: no accidental dismissal of an unrecoverable value.
              disabled={!acknowledged}
              data-testid="credential-dismiss"
            >
              <X className="h-4 w-4" aria-hidden /> Close
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

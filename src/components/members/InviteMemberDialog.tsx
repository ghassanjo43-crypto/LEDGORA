/**
 * "Invite user".
 *
 * ── The development-only link ────────────────────────────────────────────────
 * `invitationToken` is returned ONLY when the server has been explicitly
 * configured to expose it — production refuses to boot with that flag set. When
 * it does arrive, `developmentOnlyLink` is true and the link is shown once,
 * labelled, with a copy button.
 *
 * It lives in ONE `useState` here. It is never written to the member directory
 * store, `localStorage`, `sessionStorage`, the URL, analytics or a log, and it
 * is cleared when the dialog closes and on unmount. A link that outlived its
 * dialog would be a live credential sitting in memory for somebody else's
 * account.
 *
 * ── Why the seat check here is not enforcement ───────────────────────────────
 * The submit button is disabled when the server last reported no seats free.
 * That is a courtesy: another administrator can take the final seat between the
 * render and the request, so a 409 is handled as a first-class outcome and shown
 * with the server's own wording.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Input, Field } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ApiError } from '@/services/api/client';
import {
  memberApi,
  type InvitableRole,
  type InvitationResult,
  type SeatUsage,
} from '@/services/api/memberApi';

/**
 * Roles the invitation endpoint accepts.
 *
 * `owner` and `admin` are absent because the backend refuses both — ownership is
 * transferred, and minting an Organization Admin through an invite is lateral
 * privilege propagation. Offering them would be offering a 400.
 */
const INVITABLE_ROLES: Array<{ value: InvitableRole; label: string }> = [
  { value: 'manager', label: 'Manager' },
  { value: 'accountant', label: 'Accountant' },
  { value: 'member', label: 'Standard User' },
  { value: 'viewer', label: 'Read-only / Auditor' },
];

export interface InviteMemberDialogProps {
  open: boolean;
  mode: 'subscriber' | 'operator';
  organizationId: string;
  organizationName: string | null;
  seats: SeatUsage | null;
  onClose: () => void;
  onInvited: (result: InvitationResult) => void;
}

export function InviteMemberDialog({
  open,
  mode,
  organizationId,
  organizationName,
  seats,
  onClose,
  onInvited,
}: InviteMemberDialogProps) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InvitableRole>('member');
  const [onboarding, setOnboarding] = useState<'invitation' | 'temporary_password'>('invitation');
  /**
   * The temporary password and its confirmation.
   *
   * Local component state ONLY, and cleared on success, on failure, on close and
   * on unmount. They are never written to a store, browser storage, a URL, a log
   * or analytics, and the server never returns them.
   */
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /** The development-only acceptance link. Local state only. */
  const [devLink, setDevLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /** Clear everything — the link included — whenever the dialog closes. */
  useEffect(() => {
    if (open) return;
    setFullName('');
    setEmail('');
    setRole('member');
    setOnboarding('invitation');
    setTemporaryPassword('');
    setConfirmPassword('');
    setError(null);
    setFieldErrors({});
    setSubmitting(false);
    setDevLink(null);
    setCopied(false);
  }, [open]);

  // Unmount, including navigating away with the dialog open. Both secrets go.
  useEffect(
    () => () => {
      setDevLink(null);
      setTemporaryPassword('');
      setConfirmPassword('');
    },
    [],
  );

  const atLimit = seats?.atLimit ?? false;
  const usingTemporary = onboarding === 'temporary_password';
  /*
   * A local match check only, so the operator is not made to submit to learn
   * they mistyped. The POLICY itself is the server's — this never restates it.
   */
  const passwordsMatch = temporaryPassword.length > 0 && temporaryPassword === confirmPassword;
  const ready =
    fullName.trim().length > 0 &&
    email.trim().length > 0 &&
    !submitting &&
    !atLimit &&
    (!usingTemporary || passwordsMatch);

  const submit = useCallback(async (): Promise<void> => {
    // Guards a second click, and an Enter arriving while the first is in flight.
    if (submitting || !ready) return;
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const input = {
        fullName: fullName.trim(),
        email: email.trim(),
        role,
        onboarding,
        ...(usingTemporary ? { temporaryPassword } : {}),
      };
      const result =
        mode === 'operator'
          ? await memberApi.inviteToOrganization(organizationId, input)
          : await memberApi.inviteToCurrentOrganization(input);

      if (result.developmentOnlyLink && result.invitationToken) {
        const origin = typeof window === 'undefined' ? '' : window.location.origin;
        setDevLink(`${origin}/set-password?token=${encodeURIComponent(result.invitationToken)}`);
      }
      onInvited(result);

      // The form resets; the link (if any) stays until the dialog is dismissed.
      // The passwords go FIRST and unconditionally.
      setTemporaryPassword('');
      setConfirmPassword('');
      setFullName('');
      setEmail('');
      setRole('member');
      if (!result.developmentOnlyLink) onClose();
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : null;
      const details = (caught as { details?: { fieldErrors?: Record<string, string> } }).details;
      if (details?.fieldErrors) setFieldErrors(details.fieldErrors);
      /*
       * The server's own message, whatever it is: seat limit reached, already a
       * member, invitation already pending, subscriber archived, insufficient
       * permission. Replacing any of those with a generic sentence would hide
       * the one piece of information the administrator needs.
       */
      setError(apiError?.message ?? 'The invitation could not be created.');
      /*
       * Clear the password on failure too. The operator re-enters it, which
       * costs one field, and a rejected credential does not sit in memory
       * behind an error banner.
       */
      setTemporaryPassword('');
      setConfirmPassword('');
    } finally {
      setSubmitting(false);
    }
  }, [
    submitting,
    ready,
    fullName,
    email,
    role,
    onboarding,
    usingTemporary,
    temporaryPassword,
    mode,
    organizationId,
    onInvited,
    onClose,
  ]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Invite user"
      data-testid="invite-dialog"
    >
      <div className="my-8 w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="border-b border-slate-200 p-5 dark:border-slate-700">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">Add user</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Adds somebody to{organizationName ? ` ${organizationName}` : ' this organization'}.{' '}
            <span data-testid="onboarding-guidance">
              Invitation link is recommended. A temporary password may be used when you need to provide
              initial credentials directly. The user must replace it at first login.
            </span>
          </p>
        </div>

        <div className="space-y-4 p-5">
          {error && (
            <Alert variant="error" title="Could not invite" onClose={() => setError(null)}>
              <span data-testid="invite-error">{error}</span>
            </Alert>
          )}

          {atLimit && !devLink && (
            <Alert variant="warning">
              Every seat on this plan is in use. Free one or upgrade the package before inviting anybody
              else.
            </Alert>
          )}

          {/* ── The development-only link ──────────────────────────────── */}
          {devLink && (
            <div data-testid="dev-link">
            <Alert variant="warning" title="Development only — not sent by email">
              <p className="text-xs">
                This deployment is configured to reveal invitation links. This is shown once, is a live
                credential for that account, and is never available in production.
              </p>
              <code className="mt-2 block break-all rounded bg-slate-100 p-2 text-[11px] dark:bg-slate-800">
                <span data-testid="dev-link-value">{devLink}</span>
              </code>
              <div className="mt-2 flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="copy-dev-link"
                  onClick={() => {
                    void navigator.clipboard?.writeText(devLink);
                    setCopied(true);
                  }}
                >
                  {copied ? 'Copied' : 'Copy link'}
                </Button>
                <Badge tone="red">Development only</Badge>
              </div>
            </Alert>
            </div>
          )}

          <Field label="Full name" required error={fieldErrors.fullName}>
            <Input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              autoComplete="off"
              data-testid="invite-name"
            />
          </Field>

          <Field label="Email" required error={fieldErrors.email}>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
              data-testid="invite-email"
            />
          </Field>

          <Field label="Onboarding method" required>
            <div className="space-y-2">
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                <input
                  type="radio"
                  name="onboarding"
                  className="mt-0.5"
                  checked={!usingTemporary}
                  onChange={() => setOnboarding('invitation')}
                  data-testid="onboarding-invitation"
                />
                <span className="text-sm">
                  <span className="font-medium">Send invitation link</span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    Recommended. They choose their own password through a single-use link, and nobody else
                    ever learns it.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                <input
                  type="radio"
                  name="onboarding"
                  className="mt-0.5"
                  checked={usingTemporary}
                  onChange={() => setOnboarding('temporary_password')}
                  data-testid="onboarding-temporary"
                />
                <span className="text-sm">
                  <span className="font-medium">Create a temporary password</span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    Give it to them through a separate secure channel, never by email. They must replace it at
                    first login before they can use anything.
                  </span>
                </span>
              </label>
            </div>
          </Field>

          {usingTemporary && (
            <div className="space-y-4 rounded-lg border border-amber-200 p-3 dark:border-amber-500/30">
              <p className="text-xs text-slate-500 dark:text-slate-400" data-testid="password-requirements">
                At least 12 characters, with upper and lower case letters and a digit. It must not contain the
                person&rsquo;s name or email address. These are the server&rsquo;s rules, checked there — this
                is a summary, not a separate browser policy.
              </p>
              <Field label="Temporary password" required error={fieldErrors.temporaryPassword}>
                <Input
                  type="password"
                  value={temporaryPassword}
                  onChange={(e) => setTemporaryPassword(e.target.value)}
                  autoComplete="new-password"
                  data-testid="invite-temp-password"
                />
              </Field>
              <Field
                label="Confirm temporary password"
                required
                error={
                  confirmPassword.length > 0 && !passwordsMatch
                    ? 'The two passwords do not match.'
                    : undefined
                }
              >
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  data-testid="invite-temp-confirm"
                />
              </Field>
            </div>
          )}

          <Field
            label="Role"
            required
            error={fieldErrors.role}
            hint="Ownership is transferred separately, and an Organization Admin is promoted rather than invited."
          >
            <Select
              value={role}
              onChange={(e) => setRole(e.target.value as InvitableRole)}
              options={INVITABLE_ROLES}
              data-testid="invite-role"
            />
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 p-4 dark:border-slate-700">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {devLink ? 'Done' : 'Cancel'}
          </Button>
          <Button onClick={() => void submit()} disabled={!ready} data-testid="invite-submit">
            {submitting ? 'Working…' : usingTemporary ? 'Create user' : 'Send invitation'}
          </Button>
        </div>
      </div>
    </div>
  );
}

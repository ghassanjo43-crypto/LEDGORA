/**
 * "Set your password" — the page a single-use invitation or reset link opens.
 *
 * ── Why this page is public ──────────────────────────────────────────────────
 * The token IS the authentication. Requiring a session first would be circular:
 * the whole point is that the account has no usable password yet.
 *
 * ── What it is careful not to reveal ─────────────────────────────────────────
 * The server returns a MASKED address and nothing else — not the full email, not
 * the account's status, not whether a password already exists. An invalid,
 * expired, revoked or already-used link all produce the identical "no longer
 * valid" state, because distinguishing them would tell someone holding a guessed
 * token that they guessed correctly.
 *
 * ── Why setting a password does not sign you in ──────────────────────────────
 * On success this sends the person to the sign-in page rather than issuing a
 * session. Completing setup and signing in are separate acts: the link proves
 * they hold it, and the sign-in proves they know the password they just chose.
 * Handing back a session would make the link alone sufficient to be logged in —
 * and links get forwarded, logged by mail gateways and left in browser history.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouterStore } from '@/store/routerStore';
import { ROUTES } from '@/lib/accessControl';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Input, Field } from '@/components/ui/Input';
import {
  completePasswordSetup,
  describeInvitation,
  type TokenDescription,
} from '@/services/api/permissionsApi';

/** The token travels in the query string — it is not part of the path. */
function tokenFromLocation(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('token') ?? '';
}

export function AcceptInvitationPage() {
  const navigate = useRouterStore((s) => s.navigate);
  const [token] = useState(tokenFromLocation);
  const [description, setDescription] = useState<TokenDescription | null>(null);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) {
      setChecking(false);
      setDescription({ valid: false, purpose: null, maskedEmail: null, expiresAt: null });
      return;
    }
    /*
     * `cancelled` rather than an AbortController: the check is a POST (the token
     * must not travel in a URL), and the shared client's POST helper takes no
     * signal. Guarding the state update is what actually matters — an unmounted
     * component must not be written to.
     */
    let cancelled = false;
    void describeInvitation(token)
      .then((result) => {
        if (!cancelled) setDescription(result);
      })
      .catch(() => {
        if (!cancelled) setDescription({ valid: false, purpose: null, maskedEmail: null, expiresAt: null });
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = useCallback(async (): Promise<void> => {
    if (password !== confirmation) {
      setError('The two passwords do not match.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await completePasswordSetup(token, password);
      setDone(true);
      // Clear the token from the address bar so it does not linger in history
      // or get copied out of a shared screen.
      if (typeof window !== 'undefined') {
        window.history.replaceState({}, '', window.location.pathname);
      }
    } catch (caught) {
      setError((caught as Error).message || 'The password could not be set.');
    } finally {
      setSubmitting(false);
    }
  }, [token, password, confirmation]);

  const isInvitation = description?.purpose === 'invitation';

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12 dark:bg-slate-950">
      <div className="w-full max-w-md space-y-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div>
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
            {isInvitation ? 'Set your password' : 'Choose a new password'}
          </h1>
          {description?.valid && description.maskedEmail && (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              For <span className="font-medium">{description.maskedEmail}</span>
            </p>
          )}
        </div>

        {checking && <p className="text-sm text-slate-500">Checking the link…</p>}

        {/* ── An unusable link. One message for every cause. ─────────────── */}
        {!checking && description && !description.valid && !done && (
          <>
            <Alert variant="error" title="This link is no longer valid">
              It may have expired, already been used, or been withdrawn. Ask your administrator to send you a
              new one.
            </Alert>
            <Button variant="outline" className="w-full" onClick={() => navigate(ROUTES.login)}>
              Go to sign in
            </Button>
          </>
        )}

        {/* ── Success ─────────────────────────────────────────────────────── */}
        {done && (
          <>
            <Alert variant="success" title="Your password has been set">
              Sign in with your email address and the password you just chose.
            </Alert>
            <Button className="w-full" onClick={() => navigate(ROUTES.login)}>
              Continue to sign in
            </Button>
          </>
        )}

        {/* ── The form ────────────────────────────────────────────────────── */}
        {!checking && description?.valid && !done && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {error && (
              <Alert variant="error" onClose={() => setError(null)}>
                {error}
              </Alert>
            )}

            <Field
              label="New password"
              required
              hint="At least 12 characters, with upper and lower case letters and a digit. It must not contain your name or email address."
            >
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
            </Field>

            <Field label="Confirm password" required>
              <Input
                type="password"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="new-password"
                required
              />
            </Field>

            {description.expiresAt && (
              <p className="text-xs text-slate-400 dark:text-slate-500">
                This link can be used once, and expires{' '}
                {new Date(description.expiresAt).toLocaleString()}.
              </p>
            )}

            <Button type="submit" className="w-full" disabled={submitting || password.length === 0}>
              {submitting ? 'Setting your password…' : 'Set password'}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * Forced password change.
 *
 * A bootstrap administrator is provisioned from `BOOTSTRAP_ADMIN_PASSWORD`, a
 * value that by definition has been typed into a deploy dashboard and may sit in
 * its configuration history. The backend marks such accounts
 * `must_change_password`, and this page is the only surface reachable until the
 * credential has actually been exchanged — see `resolvePostLoginRoute`.
 *
 * The new password never touches browser storage: it goes straight to
 * `POST /api/auth/change-password` and is discarded.
 */
import { useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { CenteredCard } from '@/components/onboarding/OnboardingChrome';
import { Field, Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { authApi } from '@/services/api/authApi';
import { ApiError } from '@/services/api/client';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useRouterStore } from '@/store/routerStore';
import { resolvePostLoginRoute } from '@/lib/accessControl';
import { readAccessContext } from '@/lib/accessContext';

export function ChangePasswordPage() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useRouterStore((s) => s.navigate);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      return;
    }
    if (newPassword === currentPassword) {
      setError('Choose a password different from the temporary one.');
      return;
    }

    setBusy(true);
    try {
      await authApi.changePassword({ currentPassword, newPassword });
      // Re-read the session so `mustChangePassword` clears from the one place
      // that is allowed to assert it — the server.
      await useBackendSessionStore.getState().refresh();
      navigate(resolvePostLoginRoute(readAccessContext()), { replace: true });
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'Could not change your password. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <CenteredCard
      title="Choose a new password"
      subtitle="Your account was created with a temporary password. Set your own before continuing."
    >
      <form className="space-y-4" onSubmit={(e) => void submit(e)} noValidate>
        {error && <Alert variant="error">{error}</Alert>}

        <Field label="Current (temporary) password" htmlFor="current-password">
          <Input
            id="current-password"
            type={show ? 'text' : 'password'}
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
        </Field>

        <Field
          label="New password"
          htmlFor="new-password"
          hint="At least 12 characters, with upper and lower case letters and a digit."
        >
          <div className="relative">
            <Input
              id="new-password"
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? 'Hide password' : 'Show password'}
              className="absolute inset-y-0 right-2 flex items-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            >
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </Field>

        <Field label="Confirm new password" htmlFor="confirm-password">
          <Input
            id="confirm-password"
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />
        </Field>

        <Button type="submit" className="w-full" disabled={busy}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
          {busy ? 'Saving…' : 'Set new password'}
        </Button>
      </form>
    </CenteredCard>
  );
}

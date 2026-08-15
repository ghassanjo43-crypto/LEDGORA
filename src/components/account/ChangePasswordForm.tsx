/**
 * Change your own password. THE form — there is exactly one.
 *
 * ── Why one component for three personas ─────────────────────────────────────
 * A super administrator, a subscriber owner and an ordinary member all change
 * their password the same way, because the server decides whose password changes
 * from the authenticated session and from nothing else (`POST
 * /api/auth/change-password` reads `request.principal`, and there is no
 * `userId` field to send). Duplicating this form per surface would create three
 * places for the validation, the clearing and the session refresh to drift, with
 * no security benefit whatsoever — the authority is server-side either way.
 *
 * So this component is mounted in several places (platform console, in-app
 * settings, the standalone account page, the forced-change screen) and the
 * differences between those surfaces are wording, nothing more.
 *
 * ── What never happens here ──────────────────────────────────────────────────
 * No password is written to localStorage, sessionStorage, a cookie, the URL or
 * a store. All three values live in component state for the lifetime of the
 * form and are erased on success. Nothing is logged.
 */
import { useId, useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { Field, Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { authApi } from '@/services/api/authApi';
import { ApiError, isApiConfigured } from '@/services/api/client';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { checkPasswordPolicy, PASSWORD_RULE_HINT } from '@/lib/passwordPolicy';
import { cn } from '@/lib/utils';

export interface ChangePasswordFormProps {
  /**
   * Wording for the first field. The forced-change screen calls it the
   * "temporary" password, because that is what the holder was given.
   */
  currentPasswordLabel?: string;
  submitLabel?: string;
  busyLabel?: string;
  /**
   * Inline confirmation shown on success. Pass `null` when the caller navigates
   * away instead and a message on a disappearing screen would only flash.
   */
  successMessage?: string | null;
  /** Runs after the server has confirmed the change and the fields are cleared. */
  onSuccess?: () => void | Promise<void>;
  className?: string;
}

export function ChangePasswordForm({
  currentPasswordLabel = 'Current password',
  submitLabel = 'Change password',
  busyLabel = 'Changing password…',
  successMessage = 'Your password has been changed.',
  onSuccess,
  className,
}: ChangePasswordFormProps) {
  const fieldId = useId();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [reveal, setReveal] = useState({ current: false, next: false, confirm: false });
  /** Form-level failure (wrong current password, server refusal, network). */
  const [error, setError] = useState<string | null>(null);
  /** Per-field messages, so a mismatch is reported where it happened. */
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /** Policy failures, listed individually — one line per broken rule. */
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // The signed-in identity, used ONLY to pre-check the "must not contain your
  // name or email" rules locally. The server derives the real identity itself.
  const user = useBackendSessionStore((s) => s.user);

  /*
   * A build with no account service has no password to change. Saying so is
   * honest; rendering a form whose every submission fails with
   * "api_not_configured" is not.
   */
  if (!isApiConfigured()) {
    return (
      <Alert variant="info" title="Account service not available in this build">
        Password management needs the LEDGORA account service, which this deployment is not
        connected to.
      </Alert>
    );
  }

  const clearMessages = (): void => {
    setError(null);
    setFieldErrors({});
    setProblems([]);
  };

  const resetFields = (): void => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setReveal({ current: false, next: false, confirm: false });
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    clearMessages();
    setDone(false);

    /* ── Client-side checks. The server repeats every one of them. ─────────── */
    const nextFieldErrors: Record<string, string> = {};

    if (!currentPassword) {
      nextFieldErrors.currentPassword = 'Enter your current password.';
    }
    if (newPassword !== confirmPassword) {
      nextFieldErrors.confirmPassword = 'The new passwords do not match.';
    }
    if (newPassword && newPassword === currentPassword) {
      nextFieldErrors.newPassword = 'Choose a password different from your current one.';
    }

    const policyProblems = newPassword
      ? checkPasswordPolicy(newPassword, { email: user?.email, fullName: user?.fullName })
      : ['Enter a new password.'];

    if (Object.keys(nextFieldErrors).length > 0 || policyProblems.length > 0) {
      setFieldErrors(nextFieldErrors);
      setProblems(policyProblems);
      return;
    }

    setBusy(true);
    try {
      // Note what is NOT sent: no user id, no email. The server changes the
      // password of whoever the session cookie resolves to.
      await authApi.changePassword({ currentPassword, newPassword });

      // Erase the credentials from memory before anything else can await.
      resetFields();
      setDone(true);

      /*
       * Re-read the session from the server. This is what clears
       * `mustChangePassword` from the client's cache — from the only place
       * allowed to assert it — and it also confirms that the CURRENT session
       * survived the change, since the server revokes the user's OTHER sessions
       * and keeps this one.
       */
      await useBackendSessionStore.getState().refresh();

      await onSuccess?.();
    } catch (cause) {
      if (cause instanceof ApiError) {
        // The server lists each broken policy rule; show them rather than a
        // single vague sentence.
        const serverProblems = (cause.details as { problems?: string[] } | undefined)?.problems;
        if (Array.isArray(serverProblems) && serverProblems.length > 0) {
          setProblems(serverProblems);
          setError('That new password does not meet the password policy.');
        } else if (cause.code === 'invalid_credentials') {
          // Deliberately no hint about HOW wrong it was.
          setFieldErrors({ currentPassword: 'That is not your current password.' });
          setError('Your current password is not correct.');
        } else {
          setError(cause.message);
        }
      } else {
        setError('Could not change your password. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const toggle = (key: keyof typeof reveal) => (): void =>
    setReveal((state) => ({ ...state, [key]: !state[key] }));

  return (
    <form className={cn('space-y-4', className)} onSubmit={(e) => void submit(e)} noValidate>
      {done && successMessage && (
        <Alert variant="success" onClose={() => setDone(false)}>
          <span data-testid="change-password-success">{successMessage}</span>
        </Alert>
      )}

      {error && (
        <Alert variant="error" onClose={() => setError(null)}>
          <span data-testid="change-password-error">{error}</span>
        </Alert>
      )}

      {problems.length > 0 && (
        <Alert variant="warning" title="Choose a different password">
          <ul className="list-disc space-y-0.5 pl-4" data-testid="change-password-problems">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      )}

      <PasswordField
        id={`${fieldId}-current`}
        label={currentPasswordLabel}
        value={currentPassword}
        onChange={setCurrentPassword}
        autoComplete="current-password"
        revealed={reveal.current}
        onToggle={toggle('current')}
        error={fieldErrors.currentPassword}
      />

      <PasswordField
        id={`${fieldId}-new`}
        label="New password"
        value={newPassword}
        onChange={setNewPassword}
        autoComplete="new-password"
        revealed={reveal.next}
        onToggle={toggle('next')}
        error={fieldErrors.newPassword}
        hint={PASSWORD_RULE_HINT}
      />

      <PasswordField
        id={`${fieldId}-confirm`}
        label="Confirm new password"
        value={confirmPassword}
        onChange={setConfirmPassword}
        autoComplete="new-password"
        revealed={reveal.confirm}
        onToggle={toggle('confirm')}
        error={fieldErrors.confirmPassword}
      />

      <Button type="submit" disabled={busy} className="w-full sm:w-auto">
        {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
        {busy ? busyLabel : submitLabel}
      </Button>
    </form>
  );
}

/** One labelled password input with its own show/hide control. */
function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  revealed,
  onToggle,
  error,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  revealed: boolean;
  onToggle: () => void;
  error?: string;
  hint?: string;
}) {
  return (
    <Field label={label} htmlFor={id} required error={error} hint={hint}>
      <div className="relative">
        <Input
          id={id}
          // `type` is the whole show/hide mechanism: the value stays in React
          // state either way, and a revealed field is still never persisted.
          type={revealed ? 'text' : 'password'}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          hasError={!!error}
          className="pr-10"
          required
        />
        <button
          type="button"
          onClick={onToggle}
          aria-label={revealed ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          className="focus-ring absolute inset-y-0 right-2 flex items-center rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
        >
          {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </Field>
  );
}

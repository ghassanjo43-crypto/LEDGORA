/**
 * Customer sign-in. Goes through the `AuthService` (development adapter today —
 * see `services/devAuthService.ts` for the backend seam). On success the
 * post-login redirect state machine decides where the user lands.
 *
 * "Remember me" is a session *preference* only: no credential is ever stored.
 */
import { useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { useRouterStore } from '@/store/routerStore';
import { CenteredCard } from '@/components/onboarding/OnboardingChrome';
import { resolvePostLoginRoute, ROUTES } from '@/lib/accessControl';
import { Field, Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { authService } from '@/services';
import { platformAdminToolsAllowed } from '@/lib/platformAccess';

export function LoginPage() {
  const navigate = useRouterStore((s) => s.navigate);
  const rememberMePref = useAccountSessionStore((s) => s.rememberMe);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(rememberMePref);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);

    const res = await authService.signIn({ email, password, rememberMe });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? 'Sign-in failed.');
      return;
    }

    const auth = useAuthStore.getState();
    const user = auth.users.find((u) => u.id === auth.currentUserId) ?? null;
    const org = useOrganizationStore.getState();
    navigate(
      resolvePostLoginRoute({
        user: user ? { emailVerified: user.emailVerified } : null,
        hasOrganization: !!org.organization,
        subscriptionStatus: org.subscription?.status ?? null,
      }),
    );
  };

  const forgotPassword = async (): Promise<void> => {
    setError(null);
    // BACKEND SEAM: password reset is a server responsibility (AuthService).
    const res = await authService.requestPasswordReset(email);
    if (!res.ok) setError(res.error ?? 'Could not start a password reset.');
    else setNotice(res.message ?? 'Check your inbox for reset instructions.');
  };

  return (
    <CenteredCard
      title="Sign in to LEDGORA"
      footer={
        <span>
          New to LEDGORA?{' '}
          <button
            type="button"
            className="focus-ring rounded font-medium text-brand-600 hover:underline"
            onClick={() => navigate(ROUTES.register)}
          >
            Create an account
          </button>
        </span>
      }
    >
      <form className="space-y-4" onSubmit={(e) => void submit(e)} noValidate>
        {error && <Alert variant="error">{error}</Alert>}
        {notice && <Alert variant="info">{notice}</Alert>}
        {platformAdminToolsAllowed() && (
          <Alert variant="info" title="Development account">
            Sign in with <b>owner@demo.ledgora.app</b> / <b>Demo1234</b>, or create a new account.
          </Alert>
        )}

        <Field label="Business email" htmlFor="login-email" required>
          <Input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </Field>

        <Field label="Password" htmlFor="login-password" required>
          <div className="relative">
            <Input
              id="login-password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              className="focus-ring absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </Field>

        <div className="flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
            <input
              id="login-remember"
              type="checkbox"
              className="focus-ring"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
            />
            Remember me on this device
          </label>
          <button
            type="button"
            className="focus-ring rounded text-xs font-medium text-brand-600 hover:underline"
            onClick={() => void forgotPassword()}
          >
            Forgot password?
          </button>
        </div>

        <Button type="submit" className="w-full" disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </CenteredCard>
  );
}

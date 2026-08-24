/**
 * Customer sign-in. Goes through the `AuthService` (development adapter today —
 * see `services/devAuthService.ts` for the backend seam). On success the
 * post-login redirect state machine decides where the user lands.
 *
 * "Remember me" is a session *preference* only: no credential is ever stored.
 *
 * "Forgot password?" swaps this card for a recovery panel with its own address
 * field, and reports the SAME sentence on every completed request. It never says
 * whether the address is registered — the backend deliberately cannot tell it,
 * and this page could not repeat it if it did.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { useRouterStore } from '@/store/routerStore';
import { CenteredCard } from '@/components/onboarding/OnboardingChrome';
import { resolvePostLoginRoute, ROUTES } from '@/lib/accessControl';
import { readAccessContext } from '@/lib/accessContext';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { isApiConfigured } from '@/services/api/client';
import { Field, Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { authService } from '@/services';
import { platformAdminToolsAllowed } from '@/lib/platformAccess';

/**
 * The ONE thing the recovery form ever reports on a completed request.
 *
 * Held here rather than taken from the response so the page cannot be made to
 * say anything else: the backend already answers identically for a known and an
 * unknown address, and this makes the browser incapable of undoing that even if
 * a future endpoint started returning something more specific.
 */
const RECOVERY_NOTICE = 'If an account exists for that address, reset instructions have been sent.';

export function LoginPage() {
  const { t } = useTranslation('auth');
  const navigate = useRouterStore((s) => s.navigate);
  const rememberMePref = useAccountSessionStore((s) => s.rememberMe);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(rememberMePref);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** `recovery` is the "forgot password" panel on the same card. */
  const [mode, setMode] = useState<'signin' | 'recovery'>('signin');
  const [recoveryEmail, setRecoveryEmail] = useState('');

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);

    const res = await authService.signIn({ email, password, rememberMe });
    if (!res.ok) {
      setBusy(false);
      setError(res.error ?? t('signIn.failed'));
      return;
    }

    // Wait for the SERVER's answer about who this is before deciding where they
    // go. A platform operator has no organization and no subscription, so
    // routing on customer state alone would send them to package selection —
    // the defect this await exists to prevent. `apiAuthService.signIn` already
    // refreshes, but a stale/unknown status here must never be treated as
    // "no role".
    if (isApiConfigured() && useBackendSessionStore.getState().status !== 'ready') {
      await useBackendSessionStore.getState().refresh();
    }

    setBusy(false);
    // The role comes from the shared context reader, which sources it from the
    // verified backend session — never from authStore or browser storage.
    navigate(resolvePostLoginRoute(readAccessContext()));
  };

  /** Open the recovery panel, carrying across whatever was already typed. */
  const openRecovery = (): void => {
    setError(null);
    setNotice(null);
    setRecoveryEmail(email);
    setMode('recovery');
  };

  const closeRecovery = (): void => {
    setError(null);
    setNotice(null);
    setMode('signin');
  };

  /**
   * Ask the server to send a reset link.
   *
   * The success branch does not consult the response: the message is the same
   * whether or not the address is registered, which is the point. Only a request
   * that never reached the server (a network failure, or an empty field the
   * adapter refuses) is reported as an error — that is a fact about the browser,
   * not about the account.
   */
  const requestRecovery = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    const res = await authService.requestPasswordReset(recoveryEmail);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? t('recovery.failed'));
      return;
    }
    setNotice(RECOVERY_NOTICE);
  };

  if (mode === 'recovery') {
    return (
      <CenteredCard
        title={t('recovery.title')}
        footer={
          <span>
            {t('recovery.remembered')}{' '}
            <button
              type="button"
              className="focus-ring rounded font-medium text-brand-600 hover:underline"
              onClick={closeRecovery}
            >
              {t('recovery.backToSignIn')}
            </button>
          </span>
        }
      >
        <form className="space-y-4" onSubmit={(e) => void requestRecovery(e)} noValidate>
          {error && <Alert variant="error">{error}</Alert>}
          {notice && <Alert variant="info">{notice}</Alert>}

          <p className="text-sm text-slate-600 dark:text-slate-300">
            {t('recovery.intro')}
          </p>

          <Field label={t('signIn.email')} htmlFor="recovery-email" required>
            <Input
              id="recovery-email"
              name="email"
              type="email"
              autoComplete="email"
              value={recoveryEmail}
              onChange={(e) => setRecoveryEmail(e.target.value)}
              placeholder={t('signIn.emailPlaceholder')}
            />
          </Field>

          <Button type="submit" className="w-full" disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {busy ? t('recovery.submitting') : t('recovery.submit')}
          </Button>
        </form>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard
      title={t('signIn.title')}
      brandSize="login"
      footer={
        <span>
          {t('signIn.newHere')}{' '}
          <button
            type="button"
            className="focus-ring rounded font-medium text-brand-600 hover:underline"
            onClick={() => navigate(ROUTES.register)}
          >
            {t('signIn.createAccount')}
          </button>
        </span>
      }
    >
      <form className="space-y-4" onSubmit={(e) => void submit(e)} noValidate>
        {error && <Alert variant="error">{error}</Alert>}
        {notice && <Alert variant="info">{notice}</Alert>}
        {platformAdminToolsAllowed() && (
          <Alert variant="info" title={t('signIn.developmentAccount')}>
            Sign in with <b>owner@demo.ledgora.app</b> / <b>Demo1234</b>, or create a new account.
          </Alert>
        )}

        <Field label={t('signIn.email')} htmlFor="login-email" required>
          <Input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('signIn.emailPlaceholder')}
          />
        </Field>

        <Field label={t('signIn.password')} htmlFor="login-password" required>
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
              aria-label={showPassword ? t('signIn.hidePassword') : t('signIn.showPassword')}
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
            {t('signIn.rememberMe')}
          </label>
          <button
            type="button"
            className="focus-ring rounded text-xs font-medium text-brand-600 hover:underline"
            onClick={openRecovery}
          >
            {t('signIn.forgotPassword')}
          </button>
        </div>

        <Button type="submit" className="w-full" disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {busy ? t('signIn.submitting') : t('signIn.submit')}
        </Button>
      </form>
    </CenteredCard>
  );
}

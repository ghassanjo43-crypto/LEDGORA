/**
 * Customer sign-in. On success the post-login redirect state machine decides
 * where the user lands (verify email / onboarding / billing / app / …).
 */
import { useState } from 'react';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useRouterStore } from '@/store/routerStore';
import { CenteredCard } from '@/components/onboarding/OnboardingChrome';
import { resolvePostLoginRoute, ROUTES } from '@/lib/accessControl';
import { Field, Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';

export function LoginPage() {
  const login = useAuthStore((s) => s.login);
  const navigate = useRouterStore((s) => s.navigate);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    setError(null);
    const res = login(email, password);
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

  return (
    <CenteredCard
      title="Sign in to Ledgora"
      footer={
        <span>
          New to Ledgora?{' '}
          <button className="font-medium text-brand-600 hover:underline" onClick={() => navigate(ROUTES.register)}>
            Create an account
          </button>
        </span>
      }
    >
      <form className="space-y-4" onSubmit={submit} noValidate>
        {error && <Alert variant="error">{error}</Alert>}
        <Alert variant="info" title="Demo account">
          Sign in with <b>owner@demo.ledgora.app</b> / <b>Demo1234</b>, or create a new account.
        </Alert>
        <Field label="Business email" required>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
        </Field>
        <Field label="Password" required>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </Field>
        <Button type="submit" className="w-full">
          Sign in
        </Button>
      </form>
    </CenteredCard>
  );
}

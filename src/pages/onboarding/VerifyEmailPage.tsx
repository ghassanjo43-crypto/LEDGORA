/**
 * Email verification gate. A real backend emails a signed link; here we surface
 * the pending token and a "verify now" action (clearly labelled a demo seam).
 * Verifying advances the user to organization onboarding.
 */
import { useMemo, useState } from 'react';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useRouterStore } from '@/store/routerStore';
import { CenteredCard } from '@/components/onboarding/OnboardingChrome';
import { resolvePostLoginRoute } from '@/lib/accessControl';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';

export function VerifyEmailPage() {
  const users = useAuthStore((s) => s.users);
  const currentUserId = useAuthStore((s) => s.currentUserId);
  const verifyEmail = useAuthStore((s) => s.verifyEmail);
  const resend = useAuthStore((s) => s.resendVerification);
  const navigate = useRouterStore((s) => s.navigate);

  const user = useMemo(() => users.find((u) => u.id === currentUserId) ?? null, [users, currentUserId]);
  const [message, setMessage] = useState<string | null>(null);

  if (!user) {
    return (
      <CenteredCard title="Verify your email">
        <Alert variant="warning">Sign in to verify your email address.</Alert>
        <Button className="mt-4 w-full" onClick={() => navigate('/login')}>
          Go to sign in
        </Button>
      </CenteredCard>
    );
  }

  const doVerify = (): void => {
    if (!user.verificationToken) return;
    const res = verifyEmail(user.verificationToken);
    if (!res.ok) {
      setMessage(res.error ?? 'Verification failed.');
      return;
    }
    const org = useOrganizationStore.getState().organization;
    navigate(
      resolvePostLoginRoute({
        user: { emailVerified: true },
        hasOrganization: !!org,
        subscriptionStatus: useOrganizationStore.getState().subscription?.status ?? null,
      }),
    );
  };

  const doResend = (): void => {
    const res = resend(user.email);
    setMessage(res.ok ? 'A new verification link has been sent.' : res.error ?? null);
  };

  return (
    <CenteredCard
      title="Verify your email"
      subtitle={`We sent a verification link to ${user.email}.`}
    >
      <div className="space-y-4">
        {message && <Alert variant="info">{message}</Alert>}
        <Alert variant="info" title="Demo environment">
          Email delivery is a backend seam in this build. Use the button below to simulate clicking the link in your
          inbox.
        </Alert>
        <Button className="w-full" onClick={doVerify} disabled={!user.verificationToken}>
          {user.emailVerified ? 'Email verified' : 'Verify my email now'}
        </Button>
        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <span>Didn’t get the email?</span>
          <button className="font-medium text-brand-600 hover:underline" onClick={doResend}>
            Resend link
          </button>
        </div>
      </div>
    </CenteredCard>
  );
}

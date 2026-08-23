/**
 * The fallback the AccessGate renders for an ACCOUNT-LEVEL refusal.
 *
 * An AccessGate refusal is about the account lifecycle (nothing purchased yet,
 * payment pending, suspended, …) — it is NOT a module entitlement failure, so
 * showing `ModuleUnavailablePage` ("not included in your edition") here was
 * misleading. `ModuleUnavailablePage` remains the fallback for actual module
 * entitlement failures (see `ModuleRoute`); this page explains the account
 * state and points at the onboarding surface that resolves it.
 */
import { Lock, ArrowRight } from 'lucide-react';
import type { AccountStatus } from '@/types/session';
import type { OnboardingSubscriptionStatus } from '@/types/onboarding';
import { ROUTES } from '@/lib/accessControl';
import { useAccountStatus } from '@/hooks/useSession';
import { useOrganizationStore } from '@/store/organizationStore';
import { useRouterStore } from '@/store/routerStore';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

export interface AccountAccessExplanation {
  reason:
    | 'sign-in'
    | 'demo-restricted'
    | 'no-organization'
    | 'no-plan'
    | 'pending-payment'
    | 'pending-verification'
    | 'expired'
    | 'suspended';
  title: string;
  description: string;
  actionLabel: string;
  /** The onboarding-shell route that resolves this state. */
  route: string;
}

/** Pure mapping so every state can be unit-tested without React. */
export function resolveAccountAccessExplanation(input: {
  accountStatus: AccountStatus;
  onboardingStatus: OnboardingSubscriptionStatus | null;
  hasOrganization: boolean;
}): AccountAccessExplanation {
  const { accountStatus, onboardingStatus, hasOrganization } = input;

  if (accountStatus === 'free-demo') {
    return {
      reason: 'demo-restricted',
      title: 'Not part of the Free Demo',
      description:
        'This page is outside the Free Demo. Choose a plan to unlock the full application.',
      actionLabel: 'View plans',
      route: ROUTES.pricing,
    };
  }
  if (accountStatus === 'anonymous') {
    return {
      reason: 'sign-in',
      title: 'Sign in required',
      description: 'Sign in to open your organization’s workspace.',
      actionLabel: 'Go to sign in',
      route: ROUTES.login,
    };
  }
  if (accountStatus === 'suspended' || onboardingStatus === 'suspended') {
    return {
      reason: 'suspended',
      title: 'Account suspended',
      description:
        'Your organization’s subscription is suspended. Review your subscription status or contact support.',
      actionLabel: 'View status',
      route: ROUTES.subscriptionSuspended,
    };
  }
  if (!hasOrganization) {
    return {
      reason: 'no-organization',
      title: 'No company workspace available',
      description:
        'Your subscriber account is not linked to a company workspace yet. Create your company workspace to continue.',
      actionLabel: 'Set up company',
      // Reachable, and not undone on arrival: the shell keeps a genuinely
      // workspace-less user on this exact onboarding step, so the button lands
      // where it says it will.
      route: ROUTES.onboardingOrganization,
    };
  }

  switch (onboardingStatus) {
    case 'pending_payment':
    case 'rejected':
      return {
        reason: 'pending-payment',
        title: 'Payment required',
        description:
          'Your subscription invoice is awaiting payment. Complete the bank transfer and upload the payment proof to activate your subscription.',
        actionLabel: 'Go to payment',
        route: ROUTES.billingPayment,
      };
    case 'pending_verification':
      return {
        reason: 'pending-verification',
        title: 'Payment under review',
        description:
          'Your payment proof has been received and is awaiting verification. The application opens as soon as it is approved.',
        actionLabel: 'View status',
        route: ROUTES.subscriptionStatus,
      };
    case 'expired':
      return {
        reason: 'expired',
        title: 'Subscription expired',
        description: 'Your subscription term has ended. Renew to regain access to the application.',
        actionLabel: 'Renew subscription',
        route: ROUTES.billingRenew,
      };
    default:
      // null / 'draft' — registered, but nothing purchased or confirmed yet.
      return {
        reason: 'no-plan',
        title: 'No active subscription',
        description:
          'Your subscriber account has not activated a subscription yet. Choose a package to open the application.',
        actionLabel: 'Choose a plan',
        route: ROUTES.onboardingSubscription,
      };
  }
}

export function AccountAccessRequiredPage() {
  const accountStatus = useAccountStatus();
  const onboardingStatus = useOrganizationStore((s) => s.subscription?.status ?? null);
  const hasOrganization = useOrganizationStore((s) => s.organization !== null);
  const navigate = useRouterStore((s) => s.navigate);

  const explanation = resolveAccountAccessExplanation({
    accountStatus,
    onboardingStatus,
    hasOrganization,
  });

  return (
    <div className="mx-auto max-w-lg py-10">
      <Card>
        <CardBody className="flex flex-col items-center gap-4 py-10 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
            <Lock className="h-6 w-6" />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {explanation.title}
            </h2>
            <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
              {explanation.description}
            </p>
          </div>
          <Button variant="primary" size="sm" onClick={() => navigate(explanation.route)}>
            {explanation.actionLabel} <ArrowRight className="h-4 w-4" />
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}

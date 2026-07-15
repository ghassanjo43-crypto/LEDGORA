/**
 * Top-level surface router + access gate.
 *
 * Sits above the authenticated accounting app. It reads the current URL and the
 * auth / organization / subscription state, enforces the post-login redirect
 * state machine and route access policy, and renders the matching public, auth,
 * onboarding, billing, status, admin or app surface. The same policy a backend
 * would enforce (see `accessControl`) is applied here — menus are never the only
 * gate.
 */
import { useEffect, useState, type ReactNode } from 'react';
import App from '@/App';
import { useRouterStore, initRouter } from '@/store/routerStore';
import { useAuthStore, getCurrentUser } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useSessionStore } from '@/store/sessionStore';
import { useBillingStore } from '@/store/billingStore';
import { useMeteringConfigStore } from '@/store/meteringConfigStore';
import {
  isPathAllowed,
  resolvePostLoginRoute,
  surfaceOf,
  PUBLIC_PATHS,
  ROUTES,
  type AccessContext,
} from '@/lib/accessControl';
import { PricingPage } from '@/pages/onboarding/PricingPage';
import { RegisterPage } from '@/pages/onboarding/RegisterPage';
import { LoginPage } from '@/pages/onboarding/LoginPage';
import { VerifyEmailPage } from '@/pages/onboarding/VerifyEmailPage';
import { OnboardingOrganizationPage } from '@/pages/onboarding/OnboardingOrganizationPage';
import { OnboardingSubscriptionPage } from '@/pages/onboarding/OnboardingSubscriptionPage';
import { BillingPaymentPage } from '@/pages/onboarding/BillingPaymentPage';
import { AdminPaymentReviewPage } from '@/pages/onboarding/AdminPaymentReviewPage';
import {
  SubscriptionStatusPage,
  SubscriptionSuspendedPage,
  BillingRenewPage,
  ProfilePage,
  SupportPage,
} from '@/pages/onboarding/StatusPages';

/** Snapshot the live access context from the stores. */
function readContext(): AccessContext {
  const user = getCurrentUser();
  const org = useOrganizationStore.getState();
  return {
    user: user ? { emailVerified: user.emailVerified } : null,
    hasOrganization: !!org.organization,
    subscriptionStatus: org.subscription?.status ?? null,
  };
}

export function AppShell() {
  // Seed config + provision a dev tenant once, before any effect reads state,
  // so an existing install still boots straight into the app.
  useState(() => {
    useBillingStore.getState().ensureSeeded();
    useMeteringConfigStore.getState().ensureSeeded();
    useOrganizationStore.getState().ensureBootstrapped();
    return true;
  });

  const path = useRouterStore((s) => s.path);
  // Subscriptions that must re-run the gate when they change.
  const currentUserId = useAuthStore((s) => s.currentUserId);
  const usersLen = useAuthStore((s) => s.users.length);
  const orgId = useOrganizationStore((s) => s.organization?.id ?? null);
  const subStatus = useOrganizationStore((s) => s.subscription?.status ?? null);
  const platformRole = useSessionStore((s) => s.role);

  useEffect(() => initRouter(), []);

  // Access enforcement.
  useEffect(() => {
    const { navigate } = useRouterStore.getState();
    const ctx = readContext();
    const surface = surfaceOf(path);

    // Root → the user's home (or the public pricing page).
    if (path === '/' || path === '') {
      navigate(ctx.user ? resolvePostLoginRoute(ctx) : ROUTES.pricing, { replace: true });
      return;
    }

    // Not signed in → only public paths are reachable.
    if (!ctx.user) {
      if (!PUBLIC_PATHS.includes(path)) navigate(ROUTES.login, { replace: true });
      return;
    }

    // Admin surface requires the platform super-admin role.
    if (surface === 'admin') {
      if (platformRole !== 'admin') navigate(resolvePostLoginRoute(ctx), { replace: true });
      return;
    }

    // Already signed in → bounce away from login/register.
    if (path === ROUTES.login || path === ROUTES.register) {
      navigate(resolvePostLoginRoute(ctx), { replace: true });
      return;
    }

    // The app (accounting/invoicing/reports/…) requires an active subscription;
    // everything else allowed by policy (onboarding/billing/status/profile/support).
    if (!isPathAllowed(ctx, path)) {
      navigate(resolvePostLoginRoute(ctx), { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, currentUserId, usersLen, orgId, subStatus, platformRole]);

  return <Surface path={path} platformRole={platformRole} />;
}

function Surface({ path, platformRole }: { path: string; platformRole: string }): ReactNode {
  const surface = surfaceOf(path);
  const ctx = readContext();

  // Guard render: don't paint a protected surface while a redirect is pending.
  if (surface === 'app') {
    if (ctx.subscriptionStatus !== 'active') return <Blank />;
    return <App />;
  }
  if (surface === 'admin') {
    if (platformRole !== 'admin') return <Blank />;
    return <AdminPaymentReviewPage />;
  }
  if (!ctx.user && !PUBLIC_PATHS.includes(path)) return <Blank />;

  switch (path) {
    case ROUTES.pricing:
      return <PricingPage />;
    case ROUTES.register:
      return <RegisterPage />;
    case ROUTES.login:
      return <LoginPage />;
    case ROUTES.verifyEmail:
      return <VerifyEmailPage />;
    case ROUTES.onboardingOrganization:
      return <OnboardingOrganizationPage />;
    case ROUTES.onboardingSubscription:
      return <OnboardingSubscriptionPage />;
    case ROUTES.billingPayment:
      return <BillingPaymentPage />;
    case ROUTES.subscriptionStatus:
      return <SubscriptionStatusPage />;
    case ROUTES.subscriptionSuspended:
      return <SubscriptionSuspendedPage />;
    case ROUTES.billingRenew:
      return <BillingRenewPage />;
    case ROUTES.profile:
      return <ProfilePage />;
    case ROUTES.support:
      return <SupportPage />;
    default:
      return <Blank />;
  }
}

function Blank() {
  return <div className="min-h-full bg-slate-50 dark:bg-slate-950" />;
}

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
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { readSessionState } from '@/store/sessionSnapshot';
import { syncWorkspaceStorageMode } from '@/lib/freeDemoSession';
import { platformAdminToolsAllowed } from '@/lib/platformAccess';
import { useBackendSessionBootstrap, useEffectivePlatformRole } from '@/hooks/usePlatformRole';
import { platformRoleHasCapability, type PlatformRole } from '@/types/roles';
import { WelcomePage } from '@/pages/onboarding/WelcomePage';
import { SubscriptionOnboardingPage } from '@/pages/onboarding/SubscriptionOnboardingPage';
import { PricingPage } from '@/pages/onboarding/PricingPage';
import { RegisterPage } from '@/pages/onboarding/RegisterPage';
import { LoginPage } from '@/pages/onboarding/LoginPage';
import { VerifyEmailPage } from '@/pages/onboarding/VerifyEmailPage';
import { OnboardingOrganizationPage } from '@/pages/onboarding/OnboardingOrganizationPage';
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
    demoActive: useAccountSessionStore.getState().demoActive,
  };
}

export function AppShell() {
  // Seed public configuration (packages/metering) once, before any effect reads
  // state. Provisioning a ready-made tenant is a DEVELOPMENT aid only: without
  // it an unregistered visitor correctly lands on the welcome page instead of
  // being handed an administrator account.
  useState(() => {
    useBillingStore.getState().ensureSeeded();
    useMeteringConfigStore.getState().ensureSeeded();
    if (platformAdminToolsAllowed()) useOrganizationStore.getState().ensureBootstrapped();
    else useOrganizationStore.getState().applyLifecycleTransitions();
    return true;
  });

  const path = useRouterStore((s) => s.path);
  // Subscriptions that must re-run the gate when they change.
  const currentUserId = useAuthStore((s) => s.currentUserId);
  const usersLen = useAuthStore((s) => s.users.length);
  const orgId = useOrganizationStore((s) => s.organization?.id ?? null);
  const subStatus = useOrganizationStore((s) => s.subscription?.status ?? null);
  // Backend-verified where a backend exists; locally simulated otherwise.
  const platformRole = useEffectivePlatformRole();
  const demoActive = useAccountSessionStore((s) => s.demoActive);

  useEffect(() => initRouter(), []);

  // Confirm the server session once, before any administration surface renders.
  useBackendSessionBootstrap();

  // Keep business-data storage aligned with the account status: an anonymous
  // visitor or a Free Demo never writes to durable storage.
  useEffect(() => {
    syncWorkspaceStorageMode(readSessionState().accountStatus);
  }, [currentUserId, orgId, subStatus, demoActive]);

  // Access enforcement.
  useEffect(() => {
    const { navigate } = useRouterStore.getState();
    const ctx = readContext();
    const surface = surfaceOf(path);

    // Root is the public welcome page for a visitor with nothing to return to;
    // everyone else is sent to where they belong.
    if (path === ROUTES.welcome || path === '') {
      if (ctx.user || ctx.demoActive) navigate(resolvePostLoginRoute(ctx), { replace: true });
      return;
    }

    // Not signed in → only public paths are reachable (a Free Demo is allowed
    // into the application without an account).
    if (!ctx.user && !ctx.demoActive) {
      if (!PUBLIC_PATHS.includes(path)) navigate(ROUTES.welcome, { replace: true });
      return;
    }

    // Admin surface requires the platform super-admin role.
    if (surface === 'admin') {
      if (!platformRoleHasCapability(platformRole as PlatformRole, 'verify-payments')) {
        navigate(resolvePostLoginRoute(ctx), { replace: true });
      }
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
  }, [path, currentUserId, usersLen, orgId, subStatus, platformRole, demoActive]);

  return <Surface path={path} platformRole={platformRole} />;
}

function Surface({ path, platformRole }: { path: string; platformRole: string }): ReactNode {
  const surface = surfaceOf(path);
  const ctx = readContext();

  // Guard render: don't paint a protected surface while a redirect is pending.
  // The application is never rendered from a view key or a stored value — only
  // an active subscription or a running Free Demo reaches it.
  if (surface === 'app') {
    if (!ctx.demoActive && ctx.subscriptionStatus !== 'active') return <Blank />;
    return <App />;
  }
  if (surface === 'admin') {
    // Administration is never available to a demo visitor or a normal customer.
    if (ctx.demoActive || !platformRoleHasCapability(platformRole as PlatformRole, 'verify-payments')) {
      return <Blank />;
    }
    return <AdminPaymentReviewPage />;
  }
  if (!ctx.user && !ctx.demoActive && !PUBLIC_PATHS.includes(path)) return <Blank />;

  switch (path) {
    case ROUTES.welcome:
      return <WelcomePage />;
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
      // Package selection + the Free Demo option (wraps the existing flow).
      return <SubscriptionOnboardingPage />;
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

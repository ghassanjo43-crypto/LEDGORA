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
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useBillingStore } from '@/store/billingStore';
import { useMeteringConfigStore } from '@/store/meteringConfigStore';
import {
  isPathAllowed,
  requiredAdminCapability,
  resolvePostLoginRoute,
  surfaceOf,
  PUBLIC_PATHS,
  ROUTES,
} from '@/lib/accessControl';
import { readAccessContext } from '@/lib/accessContext';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { useOperatorViewStore } from '@/store/operatorViewStore';
import { readSessionState } from '@/store/sessionSnapshot';
import { syncWorkspaceStorageMode } from '@/lib/freeDemoSession';
import { platformAdminToolsAllowed } from '@/lib/platformAccess';
import { useBackendSessionBootstrap, useEffectivePlatformRole } from '@/hooks/usePlatformRole';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { isApiConfigured } from '@/services/api/client';
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
import { PlatformConsolePage } from '@/pages/admin/PlatformConsolePage';
import { ChangePasswordPage } from '@/pages/account/ChangePasswordPage';
import {
  SubscriptionStatusPage,
  SubscriptionSuspendedPage,
  BillingRenewPage,
  ProfilePage,
  SupportPage,
} from '@/pages/onboarding/StatusPages';

/**
 * Snapshot the live access context. Shared with the login and password-change
 * pages via `lib/accessContext`, so every surface reaches the same verdict —
 * including the verified platform role, which this shell previously ignored.
 */
const readContext = readAccessContext;

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
  // Re-run the gate when the operator enters/leaves subscriber-view mode.
  const operatorViewing = useOperatorViewStore((s) => s.active);
  // Re-run the gate when the server session resolves or demands a new password.
  const backendStatus = useBackendSessionStore((s) => s.status);
  const backendUser = useBackendSessionStore((s) => s.user);
  const mustChangePassword = backendUser?.mustChangePassword ?? false;
  const apiMode = isApiConfigured();
  const sessionResolving = apiMode && (backendStatus === 'unknown' || backendStatus === 'loading');
  // The server positively reported "no session" — route to /login, not welcome.
  const sessionVerifiedUnauthenticated = apiMode && backendStatus === 'ready' && backendUser === null;

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
    // Decide NOTHING until the server has answered. An administrator whose role
    // has not arrived yet is indistinguishable from a customer with no
    // subscription, and redirecting now would bounce them into onboarding —
    // including on a direct refresh of /admin/console.
    if (sessionResolving) return;

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
    // into the application without an account). If the backend positively
    // reported no session (the cookie did not travel, or it expired), send the
    // user to /login rather than the welcome page — and never into onboarding.
    if (!ctx.user && !ctx.demoActive) {
      if (!PUBLIC_PATHS.includes(path)) {
        navigate(sessionVerifiedUnauthenticated ? ROUTES.login : ROUTES.welcome, { replace: true });
      }
      return;
    }

    // A forced password change outranks everything else, including the console.
    if (ctx.mustChangePassword && path !== ROUTES.changePassword) {
      navigate(ROUTES.changePassword, { replace: true });
      return;
    }

    // Admin surface: gated purely by the verified capability for that path, with
    // no reference to organization or subscription state.
    if (surface === 'admin') {
      if (!platformRoleHasCapability(platformRole as PlatformRole, requiredAdminCapability(path))) {
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
  }, [path, currentUserId, usersLen, orgId, subStatus, platformRole, demoActive, operatorViewing, sessionResolving, mustChangePassword, sessionVerifiedUnauthenticated]);

  // Paint nothing until the session verdict is in, so no surface flashes.
  if (sessionResolving) return <Blank />;

  return <Surface path={path} platformRole={platformRole} />;
}

function Surface({ path, platformRole }: { path: string; platformRole: string }): ReactNode {
  const surface = surfaceOf(path);
  const ctx = readContext();

  // Guard render: don't paint a protected surface while a redirect is pending.
  // The application is never rendered from a view key or a stored value — only
  // an active subscription or a running Free Demo reaches it.
  if (surface === 'app') {
    // A verified operator in explicit subscriber-view mode may open the
    // application even though they hold no subscription of their own.
    if (!ctx.demoActive && ctx.subscriptionStatus !== 'active' && !ctx.operatorViewing) return <Blank />;
    return <App />;
  }
  if (surface === 'admin') {
    // Administration is never available to a demo visitor or a normal customer,
    // and each admin path demands its own capability.
    if (ctx.demoActive || !platformRoleHasCapability(platformRole as PlatformRole, requiredAdminCapability(path))) {
      return <Blank />;
    }
    // A temporary credential must be exchanged before the console opens.
    if (ctx.mustChangePassword) return <Blank />;
    return path.startsWith(ROUTES.adminPayments) ? <AdminPaymentReviewPage /> : <PlatformConsolePage />;
  }
  if (surface === 'account') {
    if (!ctx.user) return <Blank />;
    return <ChangePasswordPage />;
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

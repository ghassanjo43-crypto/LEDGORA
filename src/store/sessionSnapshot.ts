/**
 * Imperative snapshot of the onboarding session for non-component call sites
 * (the top-level access gate, services, tests). Mirrors `hooks/useSession`.
 */
import type { SessionState } from '@/types/session';
import { resolveSessionState, type SessionInputs } from '@/lib/sessionModel';
import { getCurrentUser } from './authStore';
import { useOrganizationStore } from './organizationStore';
import { useEntitlementStore } from './entitlementStore';
import { useBillingStore } from './billingStore';
import { useAccountSessionStore } from './accountSessionStore';

export function readSessionInputs(): SessionInputs {
  const org = useOrganizationStore.getState();
  return {
    user: getCurrentUser(),
    organizationId: org.organization?.id ?? null,
    organizationName: org.organization?.legalName,
    onboardingStatus: org.subscription?.status ?? null,
    entitlementStatus: useEntitlementStore.getState().subscription.status,
    subscriptionPlanId: useBillingStore.getState().activePlanId || null,
    demoActive: useAccountSessionStore.getState().demoActive,
  };
}

export function readSessionState(): SessionState {
  return resolveSessionState(readSessionInputs());
}

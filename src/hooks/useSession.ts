/**
 * The reusable access hook. Components ask `useSession()` / `useAccountStatus()`
 * instead of re-deriving onboarding rules — the checks live in one place.
 *
 * Selector safety: every zustand selector below returns a primitive or a stored
 * reference; the composed object is built in `useMemo`.
 */
import { useMemo } from 'react';
import type { AccountStatus, SessionState } from '@/types/session';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useBillingStore } from '@/store/billingStore';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { canOpenApplication, resolveSessionState, type SessionInputs } from '@/lib/sessionModel';

function useSessionInputs(): SessionInputs {
  const users = useAuthStore((s) => s.users);
  const currentUserId = useAuthStore((s) => s.currentUserId);
  const organizationId = useOrganizationStore((s) => s.organization?.id ?? null);
  const organizationName = useOrganizationStore((s) => s.organization?.legalName);
  const onboardingStatus = useOrganizationStore((s) => s.subscription?.status ?? null);
  const entitlementStatus = useEntitlementStore((s) => s.subscription.status);
  const activePlanId = useBillingStore((s) => s.activePlanId);
  const demoActive = useAccountSessionStore((s) => s.demoActive);

  return useMemo(
    () => ({
      user: users.find((u) => u.id === currentUserId) ?? null,
      organizationId,
      organizationName,
      onboardingStatus,
      entitlementStatus,
      subscriptionPlanId: activePlanId || null,
      demoActive,
    }),
    [users, currentUserId, organizationId, organizationName, onboardingStatus, entitlementStatus, activePlanId, demoActive],
  );
}

export function useSession(): SessionState {
  const inputs = useSessionInputs();
  return useMemo(() => resolveSessionState(inputs), [inputs]);
}

export function useAccountStatus(): AccountStatus {
  return useSession().accountStatus;
}

export function useIsFreeDemo(): boolean {
  return useAccountSessionStore((s) => s.demoActive);
}

/** May the current visitor open the accounting application at all? */
export function useCanOpenApplication(): boolean {
  return canOpenApplication(useAccountStatus());
}

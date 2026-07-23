/**
 * The reusable onboarding access gate.
 *
 * One component owns "may this visitor see the accounting application, and this
 * view of it?". Pages never re-implement the rule, and a view cannot be reached
 * by setting `activeView`, editing a stored Zustand value, or typing a URL —
 * the check runs at render time from the derived session, not from navigation.
 *
 * Platform operators: a verified super-admin viewing a subscriber workspace has
 * no subscriber onboarding lifecycle of their own, so deriving an account
 * status for them yields `registered-no-plan` and would lock even the
 * Dashboard. The gate therefore consults the ONE centralized override resolver
 * (`store/platformFullAccess` → `lib/platformEntitlementOverride`), which is
 * fail-closed: it requires a backend-verified super-admin role (or the explicit
 * local-dev simulation), explicit operator viewing mode, a coherent viewed/
 * loaded organization, and "view exactly as subscriber" OFF. In
 * exact-subscriber mode the resolver returns `subscriber_view` — not full
 * access — so the subscriber's real account lifecycle below still applies, and
 * a browser-planted role resolves to `'none'` and changes nothing.
 */
import type { ReactNode } from 'react';
import type { ViewKey } from '@/types';
import { useAccountStatus } from '@/hooks/useSession';
import { canOpenApplication } from '@/lib/sessionModel';
import { isFreeDemoView } from '@/config/freeDemo';
import { usePlatformAdminFullAccess } from '@/store/platformFullAccess';

export interface AccessGateProps {
  /** The view being rendered, when the gate is protecting a single view. */
  view?: ViewKey;
  children: ReactNode;
  /** Rendered instead of `children` when access is refused. */
  fallback: ReactNode;
}

/** Pure decision so it can be unit-tested without React. */
export function isViewAllowed(status: string, view?: ViewKey): boolean {
  if (!canOpenApplication(status as never)) return false;
  if (status === 'free-demo' && view) return isFreeDemoView(view);
  return true;
}

export function AccessGate({ view, children, fallback }: AccessGateProps) {
  const status = useAccountStatus();
  // Centralized, fail-closed operator override — never a raw role check here.
  const platformFullAccess = usePlatformAdminFullAccess();
  if (platformFullAccess) {
    return <>{children}</>;
  }
  return <>{isViewAllowed(status, view) ? children : fallback}</>;
}

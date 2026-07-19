/**
 * The reusable onboarding access gate.
 *
 * One component owns "may this visitor see the accounting application, and this
 * view of it?". Pages never re-implement the rule, and a view cannot be reached
 * by setting `activeView`, editing a stored Zustand value, or typing a URL —
 * the check runs at render time from the derived session, not from navigation.
 */
import type { ReactNode } from 'react';
import type { ViewKey } from '@/types';
import { useAccountStatus } from '@/hooks/useSession';
import { canOpenApplication } from '@/lib/sessionModel';
import { isFreeDemoView } from '@/config/freeDemo';

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
  return <>{isViewAllowed(status, view) ? children : fallback}</>;
}

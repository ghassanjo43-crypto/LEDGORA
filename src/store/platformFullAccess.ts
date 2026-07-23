/**
 * Live readers for the platform-operator entitlement override.
 *
 * The POLICY lives in `lib/platformEntitlementOverride` (pure, fail-closed).
 * This module assembles the policy's inputs from the stores — the same trust
 * boundary as `readAccessContext`: the role comes from `effectivePlatformRole`
 * (backend-verified in production; explicit dev simulation otherwise), never
 * from a browser-held value on its own. A tenant hand-editing sessionStorage
 * still resolves to role `'none'`, so the override stays `'none'`.
 *
 * Every consumer — sidebar, routes, module tabs, feature gates, action guards,
 * audit attribution — reads through `store/entitlementHooks`, which consults
 * exactly this resolver. Do not re-check `platformRole === 'super_admin'` in
 * components; ask these functions instead.
 */
import { useMemo } from 'react';
import { effectivePlatformRole } from '@/lib/platformAccess';
import {
  resolvePlatformEntitlementOverride,
  type OperatorAuditMetadata,
  type PlatformEntitlementOverride,
} from '@/lib/platformEntitlementOverride';
import { useSessionStore } from './sessionStore';
import { useBackendSessionStore } from './backendSessionStore';
import { useOperatorViewStore } from './operatorViewStore';
import { useOrganizationStore } from './organizationStore';

/* ── Imperative reads (guards, store actions, non-React policy code) ───────── */

/** The override that applies right now. */
export function getPlatformEntitlementOverride(): PlatformEntitlementOverride {
  const view = useOperatorViewStore.getState();
  // Cheap short-circuit: outside viewing mode there is never an override.
  if (!view.active) return 'none';
  return resolvePlatformEntitlementOverride({
    platformRole: effectivePlatformRole(
      useSessionStore.getState().platformRole,
      useBackendSessionStore.getState().platformRoles,
    ),
    operatorViewActive: view.active,
    viewAsSubscriber: view.viewAsSubscriber,
    viewedOrganizationId: view.organizationId,
    activeOrganizationId: useOrganizationStore.getState().organization?.id ?? null,
  });
}

/** True while the verified super-admin has full feature access in a workspace. */
export function isPlatformAdminFullAccess(): boolean {
  return getPlatformEntitlementOverride() === 'full_access';
}

/* ── Reactive reads (components) ───────────────────────────────────────────── */

/** Reactive form of {@link getPlatformEntitlementOverride}. */
export function usePlatformEntitlementOverride(): PlatformEntitlementOverride {
  const storedRole = useSessionStore((s) => s.platformRole);
  const backendRoles = useBackendSessionStore((s) => s.platformRoles);
  const active = useOperatorViewStore((s) => s.active);
  const viewAsSubscriber = useOperatorViewStore((s) => s.viewAsSubscriber);
  const viewedOrganizationId = useOperatorViewStore((s) => s.organizationId);
  const activeOrganizationId = useOrganizationStore((s) => s.organization?.id ?? null);

  return useMemo(
    () =>
      resolvePlatformEntitlementOverride({
        platformRole: effectivePlatformRole(storedRole, backendRoles),
        operatorViewActive: active,
        viewAsSubscriber,
        viewedOrganizationId,
        activeOrganizationId,
      }),
    [storedRole, backendRoles, active, viewAsSubscriber, viewedOrganizationId, activeOrganizationId],
  );
}

/** Reactive form of {@link isPlatformAdminFullAccess}. */
export function usePlatformAdminFullAccess(): boolean {
  return usePlatformEntitlementOverride() === 'full_access';
}

/* ── Audit attribution ─────────────────────────────────────────────────────── */

/**
 * Operator metadata for audit records, or null outside operator viewing mode.
 * Identifies the AUTHENTICATED administrator (never the subscriber owner), the
 * organization acted on, the mode and the moment.
 */
export function operatorAuditContext(): OperatorAuditMetadata | null {
  const override = getPlatformEntitlementOverride();
  if (override === 'none') return null;
  const backendUser = useBackendSessionStore.getState().user;
  return {
    // In production the backend session names the administrator; the dev
    // simulation is labelled explicitly so it can never be read as a customer.
    operatorUserId: backendUser?.id ?? `local-dev:${useSessionStore.getState().userName}`,
    operatorEmail: backendUser?.email,
    organizationId: useOrganizationStore.getState().organization?.id ?? null,
    operatorViewMode: override,
    at: new Date().toISOString(),
  };
}

/**
 * The actor to record on an audit entry. Outside operator mode this is the
 * caller's default; inside it, the administrator is identified so audit logs
 * never impersonate the subscriber.
 */
export function resolveAuditActor(defaultActor: string): string {
  const ctx = operatorAuditContext();
  if (!ctx) return defaultActor;
  return `Platform administrator (${ctx.operatorEmail ?? ctx.operatorUserId})`;
}

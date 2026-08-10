/**
 * Live readers for the effective organization context.
 *
 * The POLICY is `lib/effectiveOrganization` (pure). This module assembles its
 * inputs from the stores and owns the one piece of state the policy needs but
 * cannot derive: backend confirmation of the VIEWED organization.
 *
 * ── Why the viewed organization is confirmed against the backend ─────────────
 * `operatorViewStore` is sessionStorage. It is a perfectly good record of what
 * the operator clicked, and no basis at all for believing the organization
 * exists — the session may be days old, the tenant may have been closed, and a
 * hand-edited value must resolve to "not found" rather than to a blank roster
 * that looks like success. So the viewed id is verified through the
 * capability-guarded admin endpoint before anything is shown.
 */
import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import {
  resolveEffectiveOrganization,
  type EffectiveOrganizationContext,
  type EffectiveOrganizationStatus,
} from '@/lib/effectiveOrganization';
import { availabilityOf } from '@/lib/currentOrganization';
import { isPlatformOperator } from '@/lib/accessControl';
import { effectivePlatformRole } from '@/lib/platformAccess';
import { memberApi } from '@/services/api/memberApi';
import { ApiError, isApiConfigured } from '@/services/api/client';
import { useOrganizationStore } from './organizationStore';
import { useOperatorViewStore } from './operatorViewStore';
import { useSessionStore } from './sessionStore';
import { useBackendSessionStore } from './backendSessionStore';
import { usePlatformEntitlementOverride, getPlatformEntitlementOverride } from './platformFullAccess';
import { canManageMembers } from './authStore';

/* ── Backend confirmation of the viewed organization ───────────────────────── */

interface ViewedOrganizationState {
  status: EffectiveOrganizationStatus | 'idle';
  organizationId: string | null;
  organizationName: string | null;
  error: string | null;
  confirm: (organizationId: string | null) => Promise<void>;
  clear: () => void;
}

/** Generation guard: a response for an organization we left is discarded. */
let viewedGeneration = 0;

export const useViewedOrganizationStore = create<ViewedOrganizationState>()((set, get) => ({
  status: 'idle',
  organizationId: null,
  organizationName: null,
  error: null,

  confirm: async (organizationId) => {
    if (!organizationId) {
      viewedGeneration += 1;
      set({ status: 'ready', organizationId: null, organizationName: null, error: null });
      return;
    }
    // With no backend to ask, the operator-view record is all there is.
    if (!isApiConfigured()) {
      const local = useOrganizationStore.getState().organization;
      set({
        status: 'ready',
        organizationId,
        organizationName: local?.id === organizationId ? local.legalName : null,
        error: null,
      });
      return;
    }
    if (get().status === 'ready' && get().organizationId === organizationId) return;

    const mine = ++viewedGeneration;
    set({ status: 'loading', error: null });
    try {
      const result = await memberApi.listForOrganization(organizationId);
      if (mine !== viewedGeneration) return;
      set({
        status: 'ready',
        organizationId: result.organization?.id ?? organizationId,
        organizationName: result.organization?.legalName ?? null,
        error: null,
      });
    } catch (cause) {
      if (mine !== viewedGeneration) return;
      set({
        status: 'error',
        organizationId: null,
        organizationName: null,
        error:
          cause instanceof ApiError
            ? cause.status === 404
              ? 'That organization no longer exists.'
              : cause.status === 403
                ? 'You do not have permission to manage this organization.'
                : cause.message
            : 'We could not load the selected organization.',
      });
    }
  },

  clear: () => {
    viewedGeneration += 1;
    set({ status: 'idle', organizationId: null, organizationName: null, error: null });
  },
}));

/* ── The context ───────────────────────────────────────────────────────────── */

function assemble(input: {
  override: ReturnType<typeof getPlatformEntitlementOverride>;
  operator: boolean;
  hydration: ReturnType<typeof useOrganizationStore.getState>['hydration'];
  subscriberName: string | null;
  viewed: { status: EffectiveOrganizationStatus | 'idle'; organizationId: string | null; organizationName: string | null; error: string | null };
  subscriberCanManage: boolean;
  /** What the operator SELECTED, before confirmation. See the resolver. */
  operatorSelectedOrganizationId: string | null;
}): EffectiveOrganizationContext {
  return resolveEffectiveOrganization({
    operatorOverride: input.override,
    isPlatformOperator: input.operator,
    subscriberAvailability: availabilityOf(input.hydration),
    subscriberOrganizationId: input.hydration.confirmedOrganizationId,
    subscriberOrganizationName: input.subscriberName,
    subscriberError: input.hydration.error,
    // `idle` means the confirmation has not started; that is not knowledge, so
    // it reports as loading and never as "no organization".
    viewedStatus: input.viewed.status === 'idle' ? 'loading' : input.viewed.status,
    viewedOrganizationId: input.viewed.organizationId,
    viewedOrganizationName: input.viewed.organizationName,
    viewedError: input.viewed.error,
    subscriberCanManage: input.subscriberCanManage,
    operatorSelectedOrganizationId: input.operatorSelectedOrganizationId,
  });
}

/** Imperative read, for store actions and guards. */
export function readEffectiveOrganization(): EffectiveOrganizationContext {
  const org = useOrganizationStore.getState();
  const viewed = useViewedOrganizationStore.getState();
  const view = useOperatorViewStore.getState();
  return assemble({
    override: getPlatformEntitlementOverride(),
    operator: isPlatformOperator(
      effectivePlatformRole(
        useSessionStore.getState().platformRole,
        useBackendSessionStore.getState().platformRoles,
      ),
    ),
    hydration: org.hydration,
    subscriberName: org.organization?.legalName ?? null,
    viewed,
    subscriberCanManage: canManageMembers(),
    operatorSelectedOrganizationId: view.active ? view.organizationId : null,
  });
}

/** The backend-confirmed organization id being operated on, or null. */
export function effectiveOrganizationId(): string | null {
  return readEffectiveOrganization().organizationId;
}

/** Reactive read, for components. */
export function useEffectiveOrganization(): EffectiveOrganizationContext {
  const override = usePlatformEntitlementOverride();
  const storedRole = useSessionStore((s) => s.platformRole);
  const backendRoles = useBackendSessionStore((s) => s.platformRoles);
  const hydration = useOrganizationStore((s) => s.hydration);
  const subscriberName = useOrganizationStore((s) => s.organization?.legalName ?? null);
  const viewedStatus = useViewedOrganizationStore((s) => s.status);
  const viewedId = useViewedOrganizationStore((s) => s.organizationId);
  const viewedName = useViewedOrganizationStore((s) => s.organizationName);
  const viewedError = useViewedOrganizationStore((s) => s.error);
  // Re-derive when the caller's own role in their organization changes.
  const currentUserId = useOperatorViewStore((s) => s.ownerUserId);
  // What the operator SELECTED — needed before the confirmation settles.
  const viewActive = useOperatorViewStore((s) => s.active);
  const selectedId = useOperatorViewStore((s) => s.organizationId);

  return useMemo(
    () =>
      assemble({
        override,
        operator: isPlatformOperator(effectivePlatformRole(storedRole, backendRoles)),
        hydration,
        subscriberName,
        viewed: { status: viewedStatus, organizationId: viewedId, organizationName: viewedName, error: viewedError },
        subscriberCanManage: canManageMembers(),
        operatorSelectedOrganizationId: viewActive ? selectedId : null,
      }),
    [override, storedRole, backendRoles, hydration, subscriberName, viewedStatus, viewedId, viewedName, viewedError, currentUserId, viewActive, selectedId],
  );
}

/**
 * Keep the viewed-organization confirmation in step with what the operator
 * selected. Mount this wherever the effective context is consumed; concurrent
 * mounts share one request through the store's generation guard.
 */
export function useEffectiveOrganizationSync(): EffectiveOrganizationContext {
  // Driven by the VERIFIED ROLE and explicit viewing mode — deliberately not by
  // the entitlement override. The override now consults this confirmation, so
  // gating the confirmation on the override would be circular and would leave
  // both permanently at "none".
  const storedRole = useSessionStore((s) => s.platformRole);
  const backendRoles = useBackendSessionStore((s) => s.platformRoles);
  const active = useOperatorViewStore((s) => s.active);
  const selected = useOperatorViewStore((s) => s.organizationId);
  const confirm = useViewedOrganizationStore((s) => s.confirm);
  const clear = useViewedOrganizationStore((s) => s.clear);
  const operator = isPlatformOperator(effectivePlatformRole(storedRole, backendRoles));

  useEffect(() => {
    // Not an operator, or not viewing anybody: there is nothing to confirm, and
    // any previous confirmation is stale tenant context that must go.
    if (!operator || !active) {
      clear();
      return;
    }
    void confirm(selected);
  }, [operator, active, selected, confirm, clear]);

  return useEffectiveOrganization();
}

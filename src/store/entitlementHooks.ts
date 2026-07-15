/**
 * React hooks and imperative helpers for reading entitlements.
 *
 * SELECTOR SAFETY: every hook returns either the stored `effectiveModuleIds`
 * array (a stable reference recomputed only in actions) or a primitive value
 * (boolean / string). No hook builds a fresh array or Set inside its selector.
 */
import type {
  EffectiveEntitlements,
  LedgoraEdition,
  LedgoraModule,
} from '@/types/entitlements';
import type { SubscriptionStatus } from '@/types/subscription';
import { useEntitlementStore } from './entitlementStore';
import {
  canAccessFeature,
  hasAllModules,
  hasAnyModule,
  statusIsExpired,
  statusIsSuspended,
  type ModuleRequirement,
} from '@/lib/entitlementResolution';

/* ── Hooks ────────────────────────────────────────────────────────────────── */

/** Stable array of owned module ids. */
export function useEffectiveModules(): LedgoraModule[] {
  return useEntitlementStore((s) => s.effectiveModuleIds);
}

export function useHasModule(module: LedgoraModule): boolean {
  return useEntitlementStore((s) => s.effectiveModuleIds.includes(module));
}

export function useHasAllModules(modules: readonly LedgoraModule[]): boolean {
  return useEntitlementStore((s) => hasAllModules(s.effectiveModuleIds, modules));
}

export function useHasAnyModule(modules: readonly LedgoraModule[]): boolean {
  return useEntitlementStore((s) => hasAnyModule(s.effectiveModuleIds, modules));
}

export function useCanAccessFeature(req: ModuleRequirement | undefined): boolean {
  return useEntitlementStore((s) => canAccessFeature(s.effectiveModuleIds, req));
}

export function useCurrentEdition(): LedgoraEdition {
  return useEntitlementStore((s) => s.subscription.edition);
}

export function useSubscriptionStatus(): SubscriptionStatus {
  return useEntitlementStore((s) => s.subscription.status);
}

/** True when the subscription blocks new posting (suspended / cancelled / expired). */
export function usePostingBlocked(): boolean {
  return useEntitlementStore(
    (s) => statusIsSuspended(s.subscription.status) || statusIsExpired(s.subscription.status),
  );
}

/**
 * The full derived entitlement snapshot. Returns a fresh object each call, so
 * only use where the consumer does not feed it straight back into React state
 * as an identity dependency (components read primitives via the hooks above).
 */
export function useEntitlements(): EffectiveEntitlements {
  const subscription = useEntitlementStore((s) => s.subscription);
  const moduleIds = useEntitlementStore((s) => s.effectiveModuleIds);
  return {
    edition: subscription.edition,
    status: subscription.status,
    moduleIds,
    userLimit: subscription.userLimit,
    entityLimit: subscription.entityLimit,
    isTrial: subscription.status === 'trial',
    isSuspended: statusIsSuspended(subscription.status),
    isExpired: statusIsExpired(subscription.status),
  };
}

/* ── Imperative helpers (for use inside non-React store code) ─────────────── */

export function getEffectiveModuleIds(): LedgoraModule[] {
  return useEntitlementStore.getState().effectiveModuleIds;
}

export function orgHasModule(module: LedgoraModule): boolean {
  return useEntitlementStore.getState().effectiveModuleIds.includes(module);
}

export function getSubscriptionStatus(): SubscriptionStatus {
  return useEntitlementStore.getState().subscription.status;
}

export function getCurrentEdition(): LedgoraEdition {
  return useEntitlementStore.getState().subscription.edition;
}

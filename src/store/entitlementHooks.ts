/**
 * React hooks and imperative helpers for reading entitlements.
 *
 * THE central feature-access read path: route guards, sidebar navigation,
 * module tabs, feature gates and action guards all resolve module access here,
 * so the platform-operator override (`store/platformFullAccess`) is applied in
 * exactly one place. A verified super-admin in operator subscriber-view mode
 * sees every module (`FULL_ACCESS_MODULE_IDS`); everyone else — including that
 * same subscriber's own users — sees the organization's real package. The
 * override never touches the stored subscription.
 *
 * SELECTOR SAFETY: every hook returns either a stored/stable array reference
 * (`effectiveModuleIds` recomputed only in actions, or the module-level
 * `FULL_ACCESS_MODULE_IDS` constant) or a primitive value (boolean / string).
 * No hook builds a fresh array or Set inside its selector.
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
import { FULL_ACCESS_MODULE_IDS } from '@/lib/platformEntitlementOverride';
import { isPlatformAdminFullAccess, usePlatformAdminFullAccess } from './platformFullAccess';

/* ── Hooks ────────────────────────────────────────────────────────────────── */

/** Stable array of accessible module ids (owned, or all under full access). */
export function useEffectiveModules(): LedgoraModule[] {
  const owned = useEntitlementStore((s) => s.effectiveModuleIds);
  const fullAccess = usePlatformAdminFullAccess();
  return fullAccess ? FULL_ACCESS_MODULE_IDS : owned;
}

export function useHasModule(module: LedgoraModule): boolean {
  const owned = useEntitlementStore((s) => s.effectiveModuleIds.includes(module));
  return usePlatformAdminFullAccess() || owned;
}

export function useHasAllModules(modules: readonly LedgoraModule[]): boolean {
  const owned = useEntitlementStore((s) => hasAllModules(s.effectiveModuleIds, modules));
  return usePlatformAdminFullAccess() || owned;
}

export function useHasAnyModule(modules: readonly LedgoraModule[]): boolean {
  const owned = useEntitlementStore((s) => hasAnyModule(s.effectiveModuleIds, modules));
  return usePlatformAdminFullAccess() || owned;
}

export function useCanAccessFeature(req: ModuleRequirement | undefined): boolean {
  const owned = useEntitlementStore((s) => canAccessFeature(s.effectiveModuleIds, req));
  return usePlatformAdminFullAccess() || owned;
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
  if (isPlatformAdminFullAccess()) return FULL_ACCESS_MODULE_IDS;
  return useEntitlementStore.getState().effectiveModuleIds;
}

export function orgHasModule(module: LedgoraModule): boolean {
  return getEffectiveModuleIds().includes(module);
}

export function getSubscriptionStatus(): SubscriptionStatus {
  return useEntitlementStore.getState().subscription.status;
}

export function getCurrentEdition(): LedgoraEdition {
  return useEntitlementStore.getState().subscription.edition;
}

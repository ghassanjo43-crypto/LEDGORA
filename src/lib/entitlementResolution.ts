/**
 * Resolve a subscription into the effective set of modules and the derived
 * entitlement snapshot.
 *
 * Rules (spec §5):
 *   1. Begin with the edition preset.
 *   2. Add explicit add-ons.
 *   3. Remove explicitly disabled modules.
 *   4. Expand required dependencies.
 *   5. Reject invalid dependency combinations (a disable that breaks a
 *      still-enabled dependent is undone — data is never inconsistent).
 *   6. Return a stable, canonically-ordered list.
 */
import type {
  EffectiveEntitlements,
  LedgoraEdition,
  LedgoraModule,
} from '@/types/entitlements';
import type {
  OrganizationSubscription,
  SubscriptionStatus,
} from '@/types/subscription';
import {
  getEditionModules,
  expandModuleDependencies,
  sortModules,
  EDITION_LIMITS,
} from '@/config/editions';

/** Statuses that still grant full access to owned modules. */
export function statusIsActive(status: SubscriptionStatus): boolean {
  return status === 'trial' || status === 'active' || status === 'past-due';
}

export function statusIsSuspended(status: SubscriptionStatus): boolean {
  return status === 'suspended' || status === 'cancelled';
}

export function statusIsExpired(status: SubscriptionStatus): boolean {
  return status === 'expired';
}

/**
 * The ordered list of modules an organization effectively owns. Note: module
 * ownership is independent of subscription STATUS — a suspended organization
 * still *owns* its modules (so its historical data stays visible); status only
 * gates new posting. Visibility/335 posting rules read status separately.
 */
export function resolveEffectiveModules(
  subscription: Pick<
    OrganizationSubscription,
    'edition' | 'enabledModules' | 'disabledModules'
  >,
): LedgoraModule[] {
  // 1. edition preset
  const base = new Set<LedgoraModule>(getEditionModules(subscription.edition));

  // 2. add-ons
  for (const m of subscription.enabledModules ?? []) base.add(m);

  // 3. remove explicit disables
  for (const m of subscription.disabledModules ?? []) base.delete(m);

  // 4. expand dependencies of whatever remains
  let expanded = new Set<LedgoraModule>(expandModuleDependencies(base));

  // 5. re-apply disables, then drop any module whose dependency was disabled,
  //    so the result never contains a module missing a hard dependency.
  const disabled = new Set(subscription.disabledModules ?? []);
  for (const m of disabled) expanded.delete(m);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...expanded]) {
      const deps = expandModuleDependencies([id]).filter((d) => d !== id);
      if (deps.some((d) => !expanded.has(d))) {
        expanded.delete(id);
        changed = true;
      }
    }
  }

  // 6. stable ordering
  return sortModules(expanded);
}

/** Full derived entitlement snapshot for the active organization. */
export function resolveEffectiveEntitlements(
  subscription: OrganizationSubscription,
): EffectiveEntitlements {
  return {
    edition: subscription.edition,
    status: subscription.status,
    moduleIds: resolveEffectiveModules(subscription),
    userLimit: subscription.userLimit,
    entityLimit: subscription.entityLimit,
    isTrial: subscription.status === 'trial',
    isSuspended: statusIsSuspended(subscription.status),
    isExpired: statusIsExpired(subscription.status),
  };
}

/* ── Shared access helpers (operate on a resolved module list) ────────────── */

export function hasModule(
  moduleIds: readonly LedgoraModule[],
  module: LedgoraModule,
): boolean {
  return moduleIds.includes(module);
}

export function hasAllModules(
  moduleIds: readonly LedgoraModule[],
  modules: readonly LedgoraModule[],
): boolean {
  return modules.every((m) => moduleIds.includes(m));
}

export function hasAnyModule(
  moduleIds: readonly LedgoraModule[],
  modules: readonly LedgoraModule[],
): boolean {
  return modules.some((m) => moduleIds.includes(m));
}

/** Feature access requirement descriptor shared by nav, routes and widgets. */
export interface ModuleRequirement {
  requiredModule?: LedgoraModule;
  requiredAnyModules?: LedgoraModule[];
  requiredAllModules?: LedgoraModule[];
}

/**
 * Whether a feature's module requirements are satisfied by the owned modules.
 * A feature with no requirement is always accessible. Entitlement is the
 * ORGANIZATION half of access; user permission is checked separately.
 */
export function canAccessFeature(
  moduleIds: readonly LedgoraModule[],
  req: ModuleRequirement | undefined,
): boolean {
  if (!req) return true;
  if (req.requiredModule && !hasModule(moduleIds, req.requiredModule)) {
    return false;
  }
  if (
    req.requiredAllModules &&
    req.requiredAllModules.length > 0 &&
    !hasAllModules(moduleIds, req.requiredAllModules)
  ) {
    return false;
  }
  if (
    req.requiredAnyModules &&
    req.requiredAnyModules.length > 0 &&
    !hasAnyModule(moduleIds, req.requiredAnyModules)
  ) {
    return false;
  }
  return true;
}

/** Default per-edition limits, re-exported for convenience. */
export function defaultLimitsForEdition(edition: LedgoraEdition): {
  userLimit: number;
  entityLimit: number;
} {
  return { ...EDITION_LIMITS[edition] };
}

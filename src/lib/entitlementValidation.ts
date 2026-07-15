/**
 * Pure dependency helpers for the module registry. No React, no store — these
 * are used by resolution, the entitlement store and tests.
 */
import type { LedgoraModule } from '@/types/entitlements';
import { MODULE_BY_ID } from '@/config/modules';
import { expandModuleDependencies, sortModules } from '@/config/editions';

export { expandModuleDependencies, sortModules };

/** Direct dependencies declared for a module. */
export function getDirectDependencies(id: LedgoraModule): LedgoraModule[] {
  return [...(MODULE_BY_ID[id]?.dependencies ?? [])];
}

/**
 * Given a set of enabled modules, return the dependencies that are required but
 * missing. Empty array = the set is internally consistent.
 */
export function getMissingDependencies(
  enabled: Iterable<LedgoraModule>,
): LedgoraModule[] {
  const set = new Set(enabled);
  const missing = new Set<LedgoraModule>();
  for (const id of set) {
    for (const dep of getDirectDependencies(id)) {
      if (!set.has(dep)) missing.add(dep);
    }
  }
  return sortModules(missing);
}

export interface DependencyValidationResult {
  ok: boolean;
  missing: LedgoraModule[];
  message?: string;
}

/**
 * Validate that a set of modules satisfies all of its dependencies. Reject
 * invalid combinations (e.g. project_billing without sales) unless `expand`
 * mode auto-adds them.
 */
export function validateModuleDependencies(
  enabled: Iterable<LedgoraModule>,
): DependencyValidationResult {
  const missing = getMissingDependencies(enabled);
  if (missing.length === 0) return { ok: true, missing: [] };
  const names = missing.map((m) => MODULE_BY_ID[m]?.name ?? m).join(', ');
  return {
    ok: false,
    missing,
    message: `Missing required module(s): ${names}.`,
  };
}

/**
 * Modules that depend (directly or transitively) on `target`. Used to warn
 * before disabling a module that others rely on.
 */
export function getDependentModules(
  target: LedgoraModule,
  within: Iterable<LedgoraModule>,
): LedgoraModule[] {
  const scope = new Set(within);
  const dependents = new Set<LedgoraModule>();
  for (const id of scope) {
    if (id === target) continue;
    if (expandModuleDependencies([id]).includes(target)) dependents.add(id);
  }
  return sortModules(dependents);
}

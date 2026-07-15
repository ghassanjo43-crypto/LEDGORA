/**
 * Edition presets, derived from the module registry.
 *
 * Core / Projects / Construction presets come from each module's
 * `defaultForEditions`; Enterprise is derived as "all stable modules" so any
 * newly added stable module is automatically included. Dependency expansion is
 * applied so a preset is always closed under its dependencies.
 *
 * editions.ts imports modules.ts (one direction only) — never the reverse.
 */
import type { LedgoraEdition, LedgoraModule } from '@/types/entitlements';
import {
  MODULE_DEFINITIONS,
  ALL_MODULE_IDS,
  MODULE_ORDER,
  isStableModule,
} from './modules';

export const ALL_EDITIONS: LedgoraEdition[] = [
  'core',
  'projects',
  'construction',
  'manufacturing',
  'enterprise',
];

/** Sort a module list into the canonical registry order (stable & deterministic). */
export function sortModules(ids: Iterable<LedgoraModule>): LedgoraModule[] {
  return [...new Set(ids)].sort((a, b) => MODULE_ORDER[a] - MODULE_ORDER[b]);
}

/**
 * Expand a set of modules to include every transitive dependency. Pure and
 * order-independent; the result is returned in canonical order.
 */
export function expandModuleDependencies(
  ids: Iterable<LedgoraModule>,
): LedgoraModule[] {
  const out = new Set<LedgoraModule>();
  const visit = (id: LedgoraModule): void => {
    if (out.has(id)) return;
    out.add(id);
    const def = MODULE_DEFINITIONS.find((m) => m.id === id);
    for (const dep of def?.dependencies ?? []) visit(dep);
  };
  for (const id of ids) visit(id);
  return sortModules(out);
}

/** Raw preset (before dependency expansion) for a single edition. */
function rawPresetFor(edition: LedgoraEdition): LedgoraModule[] {
  if (edition === 'enterprise') {
    return ALL_MODULE_IDS.filter(isStableModule);
  }
  return MODULE_DEFINITIONS.filter((m) =>
    m.defaultForEditions.includes(edition),
  ).map((m) => m.id);
}

/**
 * The canonical edition → modules map, fully dependency-expanded. This is the
 * starting point `resolveEffectiveModules` builds on.
 */
export const EDITION_MODULES: Record<LedgoraEdition, LedgoraModule[]> = {
  core: expandModuleDependencies(rawPresetFor('core')),
  projects: expandModuleDependencies(rawPresetFor('projects')),
  construction: expandModuleDependencies(rawPresetFor('construction')),
  manufacturing: expandModuleDependencies(rawPresetFor('manufacturing')),
  enterprise: expandModuleDependencies(rawPresetFor('enterprise')),
};

/** Modules included in an edition preset (defensive copy). */
export function getEditionModules(edition: LedgoraEdition): LedgoraModule[] {
  return [...(EDITION_MODULES[edition] ?? EDITION_MODULES.core)];
}

/** Default user/entity limits per edition (Phase 1 development defaults). */
export const EDITION_LIMITS: Record<
  LedgoraEdition,
  { userLimit: number; entityLimit: number }
> = {
  core: { userLimit: 3, entityLimit: 1 },
  projects: { userLimit: 10, entityLimit: 2 },
  construction: { userLimit: 25, entityLimit: 5 },
  manufacturing: { userLimit: 25, entityLimit: 3 },
  enterprise: { userLimit: 999, entityLimit: 999 },
};

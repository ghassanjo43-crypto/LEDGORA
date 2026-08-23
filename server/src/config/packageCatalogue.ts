/**
 * What each commercial package entitles, in the COARSE module vocabulary.
 *
 * ── Why this exists as code ──────────────────────────────────────────────────
 * Ledgora has two module vocabularies, and `config/permissionCatalog` explains
 * why: the frontend registry enumerates ~68 fine-grained capabilities for the
 * entitlement UI, while the PLANS sell about a dozen coarse ones, and it is the
 * coarse set that lands in `subscription_plans.module_entitlements` and
 * therefore in `organization_entitlements.modules`.
 *
 * Two vocabularies can drift, and they did. Migration 014 seeded the coarse
 * lists inline, so the only statement of what a package includes lived inside a
 * historical migration that must never be edited again. Nothing compared it to
 * the permission catalogue, and the result was a subject nobody could reach:
 * `fixed_assets` had a module, a navigation group and its own edition tier, but
 * appeared in NO package's module list — so every Fixed Assets permission
 * resolved "not in package" for every subscriber, Enterprise included.
 *
 * The list therefore lives here, once, where a migration can repair the
 * database from it and a test can hold it to the permission catalogue. Adding a
 * gated subject without selling the module it needs is now a failing test rather
 * than a feature that is silently unreachable in every package sold.
 *
 * ── This is the entitlement CEILING, never the grant ─────────────────────────
 * Owning a module means the tenant MAY be granted permissions on it. What any
 * one person actually holds is the role template narrowed by their overrides —
 * see `permissionService`. Nothing here grants anybody anything.
 */

/** The five packages on offer. The superseded 002 tiers are not commercial. */
export const PACKAGE_CODES = ['core', 'projects', 'construction', 'manufacturing', 'enterprise'] as const;
export type PackageCode = (typeof PACKAGE_CODES)[number];

/**
 * Bookkeeping every package includes, whatever else it sells.
 *
 * `fixed_assets` belongs here for the same reason `accounting` does: the asset
 * register is part of keeping books, it ships in the Core edition of the
 * frontend registry (`defaultForEditions: CORE_TIER`), and every richer edition
 * inherits Core. Its absence from this floor was the bug described above.
 *
 * `multi_currency` is here despite its name. It is the coarse id the
 * `currencies` subject is gated on, and that subject covers currency MASTER
 * DATA — the currency list, precision, exchange rates — which the frontend
 * ships in every edition as `currency_basic`. Selling it only with Enterprise
 * meant every other subscriber could open Currencies and Exchange Rates while
 * holding no permission on either.
 *
 * Advanced FX is NOT given away by this. Period-end revaluation and realized /
 * unrealized reporting are a separate frontend module (`currency_advanced`,
 * Enterprise only) which the coarse vocabulary does not represent at all, so it
 * stays gated where it always was.
 */
const BOOKKEEPING: readonly string[] = ['accounting', 'invoicing', 'reports', 'fixed_assets', 'multi_currency'];

/**
 * The canonical coarse entitlements per package.
 *
 * Kept deliberately explicit rather than derived by tier inheritance: a package
 * is a commercial artefact, and reading what one includes should not require
 * evaluating a chain of spreads.
 */
export const PACKAGE_MODULES: Record<PackageCode, readonly string[]> = {
  core: [...BOOKKEEPING],

  projects: [...BOOKKEEPING, 'cost_centers', 'projects'],

  construction: [...BOOKKEEPING, 'cost_centers', 'projects', 'construction'],

  /*
   * `cost_centers` is not optional here and is not a pricing choice: the
   * frontend's `manufacturing_core` and `manufacturing_work_centers` both
   * declare a dependency on it, and a work center without a cost center has
   * nowhere to post. Manufacturing shipped without it, so every cost-center
   * permission resolved "not in package" for a plant that structurally needs
   * one.
   */
  manufacturing: [...BOOKKEEPING, 'cost_centers', 'inventory_basic', 'inventory_advanced', 'manufacturing'],

  enterprise: [
    ...BOOKKEEPING,
    'cost_centers',
    'inventory_basic',
    'inventory_advanced',
    'projects',
    'construction',
    'manufacturing',
    'multi_entity',
  ],
};

/** Sorted, de-duplicated — the form stored in `module_entitlements`. */
export function modulesForPackage(code: PackageCode): string[] {
  return [...new Set(PACKAGE_MODULES[code])].sort();
}

/** Every coarse module any package sells. A subject gated on anything else is unreachable. */
export function allSoldModules(): string[] {
  return [...new Set(PACKAGE_CODES.flatMap((code) => [...PACKAGE_MODULES[code]]))].sort();
}

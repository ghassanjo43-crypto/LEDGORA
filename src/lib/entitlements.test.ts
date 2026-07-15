import { describe, it, expect } from 'vitest';
import type { LedgoraModule } from '@/types/entitlements';
import { EDITION_MODULES, expandModuleDependencies } from '@/config/editions';
import { MODULE_DEFINITIONS, isStableModule } from '@/config/modules';
import {
  resolveEffectiveModules,
  resolveEffectiveEntitlements,
  canAccessFeature,
  hasAllModules,
} from '@/lib/entitlementResolution';
import {
  validateModuleDependencies,
  getMissingDependencies,
  getDependentModules,
} from '@/lib/entitlementValidation';
import {
  createSubscription,
  createEnterpriseDevelopmentSubscription,
  migrateExistingOrganization,
} from '@/lib/entitlementMigration';
import {
  assertSubscriptionAllowsPosting,
  canCreateEntity,
  canCreateUser,
} from '@/lib/subscriptionPostingGuard';
import {
  seedOrganizationForEdition,
  seedManufacturingOrganization,
} from '@/lib/editionSeeding';

const has = (mods: LedgoraModule[], m: LedgoraModule) => mods.includes(m);

/* ── Edition presets ──────────────────────────────────────────────────────── */

describe('edition presets', () => {
  it('Core includes only accounting, sales, purchases, statements, basic tax & currency', () => {
    const core = EDITION_MODULES.core;
    expect(has(core, 'core_accounting')).toBe(true);
    expect(has(core, 'sales')).toBe(true);
    expect(has(core, 'purchases')).toBe(true);
    expect(has(core, 'customer_statements')).toBe(true);
    expect(has(core, 'tax_basic')).toBe(true);
    expect(has(core, 'currency_basic')).toBe(true);
    // Core must NOT see project / cost-center / construction / advanced modules
    expect(has(core, 'cost_centers')).toBe(false);
    expect(has(core, 'projects')).toBe(false);
    expect(has(core, 'construction_projects')).toBe(false);
    expect(has(core, 'tax_advanced')).toBe(false);
    expect(has(core, 'currency_advanced')).toBe(false);
  });

  it('Projects includes everything in Core plus cost centers & project features', () => {
    const core = EDITION_MODULES.core;
    const projects = EDITION_MODULES.projects;
    expect(hasAllModules(projects, core)).toBe(true); // superset of Core
    expect(has(projects, 'cost_centers')).toBe(true);
    expect(has(projects, 'projects')).toBe(true);
    expect(has(projects, 'project_budgets')).toBe(true);
    expect(has(projects, 'project_billing')).toBe(true);
    expect(has(projects, 'project_cash_flow')).toBe(true);
    // Construction still hidden
    expect(has(projects, 'construction_projects')).toBe(false);
  });

  it('Construction includes everything in Projects plus construction modules', () => {
    const projects = EDITION_MODULES.projects;
    const construction = EDITION_MODULES.construction;
    expect(hasAllModules(construction, projects)).toBe(true); // superset of Projects
    expect(has(construction, 'construction_projects')).toBe(true);
    expect(has(construction, 'construction_boq')).toBe(true);
    expect(has(construction, 'construction_retention')).toBe(true);
    expect(has(construction, 'construction_wip')).toBe(true);
  });

  it('Enterprise includes all stable modules (incl. manufacturing)', () => {
    const enterprise = EDITION_MODULES.enterprise;
    const stable = MODULE_DEFINITIONS.filter((m) => isStableModule(m.id)).map((m) => m.id);
    expect(hasAllModules(enterprise, stable)).toBe(true);
    expect(enterprise.length).toBe(stable.length);
    // manufacturing modules are part of Enterprise
    expect(has(enterprise, 'manufacturing_work_orders')).toBe(true);
    expect(has(enterprise, 'manufacturing_batch_process')).toBe(true);
  });

  it('Manufacturing includes Core + inventory + cost centers + manufacturing, but NOT the Projects edition', () => {
    const core = EDITION_MODULES.core;
    const mfg = EDITION_MODULES.manufacturing;
    // includes all of Core
    expect(hasAllModules(mfg, core)).toBe(true);
    // inventory & warehousing
    expect(has(mfg, 'inventory_basic')).toBe(true);
    expect(has(mfg, 'warehouses')).toBe(true);
    expect(has(mfg, 'lot_serial_tracking')).toBe(true);
    expect(has(mfg, 'landed_cost')).toBe(true);
    // cost centers ship with Manufacturing
    expect(has(mfg, 'cost_centers')).toBe(true);
    // manufacturing essentials
    expect(has(mfg, 'manufacturing_core')).toBe(true);
    expect(has(mfg, 'manufacturing_bom')).toBe(true);
    expect(has(mfg, 'manufacturing_work_orders')).toBe(true);
    expect(has(mfg, 'manufacturing_standard_costing')).toBe(true);
    expect(has(mfg, 'manufacturing_variance_analysis')).toBe(true);
    expect(has(mfg, 'manufacturing_quality')).toBe(true);
    expect(has(mfg, 'manufacturing_maintenance')).toBe(true);
    expect(has(mfg, 'manufacturing_dashboards')).toBe(true);
    expect(has(mfg, 'manufacturing_reports')).toBe(true);
    // does NOT auto-include the Projects edition
    expect(has(mfg, 'projects')).toBe(false);
    expect(has(mfg, 'project_budgets')).toBe(false);
    expect(has(mfg, 'construction_projects')).toBe(false);
  });

  it('Manufacturing add-ons are NOT in the essentials preset', () => {
    const mfg = EDITION_MODULES.manufacturing;
    expect(has(mfg, 'manufacturing_capacity_planning')).toBe(false);
    expect(has(mfg, 'manufacturing_rework')).toBe(false);
    expect(has(mfg, 'manufacturing_subcontracting')).toBe(false);
    expect(has(mfg, 'manufacturing_batch_process')).toBe(false);
    expect(has(mfg, 'manufacturing_yield')).toBe(false);
    expect(has(mfg, 'manufacturing_co_products')).toBe(false);
  });

  it('Core and Construction never see manufacturing modules', () => {
    expect(has(EDITION_MODULES.core, 'inventory_basic')).toBe(false);
    expect(has(EDITION_MODULES.core, 'manufacturing_core')).toBe(false);
    expect(has(EDITION_MODULES.construction, 'manufacturing_core')).toBe(false);
    expect(has(EDITION_MODULES.projects, 'manufacturing_core')).toBe(false);
  });
});

/* ── Dependencies ─────────────────────────────────────────────────────────── */

describe('module dependencies', () => {
  it('expands transitive dependencies', () => {
    const expanded = expandModuleDependencies(['project_cash_flow']);
    expect(has(expanded, 'projects')).toBe(true);
    expect(has(expanded, 'sales')).toBe(true);
    expect(has(expanded, 'purchases')).toBe(true);
    expect(has(expanded, 'core_accounting')).toBe(true);
  });

  it('flags missing dependencies for an inconsistent set', () => {
    const missing = getMissingDependencies(['project_billing']);
    expect(missing).toContain('projects');
    expect(missing).toContain('sales');
  });

  it('validates a complete set as ok', () => {
    const res = validateModuleDependencies(EDITION_MODULES.construction);
    expect(res.ok).toBe(true);
    expect(res.missing).toHaveLength(0);
  });

  it('rejects an invalid combination', () => {
    const res = validateModuleDependencies(['construction_revenue_recognition']);
    expect(res.ok).toBe(false);
    expect(res.missing).toContain('construction_wip');
    expect(res.message).toBeTruthy();
  });

  it('reports dependents so disabling can warn', () => {
    const dependents = getDependentModules('construction_projects', EDITION_MODULES.construction);
    expect(dependents).toContain('construction_boq');
    expect(dependents).toContain('construction_wip');
  });

  it('expands manufacturing dependencies correctly', () => {
    // work orders pull in bom, routings, work centers, items, core and inventory
    const wo = expandModuleDependencies(['manufacturing_work_orders']);
    expect(has(wo, 'manufacturing_bom')).toBe(true);
    expect(has(wo, 'manufacturing_routings')).toBe(true);
    expect(has(wo, 'manufacturing_work_centers')).toBe(true);
    expect(has(wo, 'manufacturing_items')).toBe(true);
    expect(has(wo, 'manufacturing_core')).toBe(true);
    expect(has(wo, 'inventory_basic')).toBe(true);
    // traceability needs lot/serial + work orders
    const trace = expandModuleDependencies(['manufacturing_traceability']);
    expect(has(trace, 'lot_serial_tracking')).toBe(true);
    expect(has(trace, 'manufacturing_work_orders')).toBe(true);
    // variance analysis needs standard + actual costing
    const variance = expandModuleDependencies(['manufacturing_variance_analysis']);
    expect(has(variance, 'manufacturing_standard_costing')).toBe(true);
    expect(has(variance, 'manufacturing_actual_costing')).toBe(true);
  });

  it('rejects manufacturing modules missing dependencies', () => {
    const res = validateModuleDependencies(['manufacturing_work_orders']);
    expect(res.ok).toBe(false);
    expect(res.missing).toContain('manufacturing_bom');
    // a full manufacturing preset is internally consistent
    expect(validateModuleDependencies(EDITION_MODULES.manufacturing).ok).toBe(true);
  });
});

/* ── Resolution: add-ons, disables, stability ─────────────────────────────── */

describe('resolveEffectiveModules', () => {
  it('adds an add-on without upgrading the edition', () => {
    const mods = resolveEffectiveModules({
      edition: 'core',
      enabledModules: ['cost_centers'],
      disabledModules: [],
    });
    expect(has(mods, 'cost_centers')).toBe(true);
    // enabling cost centers must NOT pull in projects
    expect(has(mods, 'projects')).toBe(false);
  });

  it('honours explicit disables and drops orphaned dependents', () => {
    const mods = resolveEffectiveModules({
      edition: 'projects',
      enabledModules: [],
      disabledModules: ['projects'],
    });
    expect(has(mods, 'projects')).toBe(false);
    // modules that require projects must also disappear
    expect(has(mods, 'project_budgets')).toBe(false);
    expect(has(mods, 'project_billing')).toBe(false);
    // core stays
    expect(has(mods, 'core_accounting')).toBe(true);
    expect(has(mods, 'cost_centers')).toBe(true); // cost centers do not depend on projects
  });

  it('adds the Projects add-on to a Manufacturing organization on demand', () => {
    const mods = resolveEffectiveModules({
      edition: 'manufacturing',
      enabledModules: ['projects', 'project_profitability'],
      disabledModules: [],
    });
    expect(has(mods, 'manufacturing_core')).toBe(true); // keeps manufacturing
    expect(has(mods, 'projects')).toBe(true); // gains projects add-on
    expect(has(mods, 'project_profitability')).toBe(true);
  });

  it('adds Manufacturing Control / Process add-ons without changing edition', () => {
    const mods = resolveEffectiveModules({
      edition: 'manufacturing',
      enabledModules: ['manufacturing_rework', 'manufacturing_batch_process', 'manufacturing_yield'],
      disabledModules: [],
    });
    expect(has(mods, 'manufacturing_rework')).toBe(true);
    expect(has(mods, 'manufacturing_batch_process')).toBe(true);
    expect(has(mods, 'manufacturing_yield')).toBe(true); // yield depends on batch/process
  });

  it('returns a stable, canonically-ordered list (deterministic)', () => {
    const a = resolveEffectiveModules({ edition: 'construction', enabledModules: [], disabledModules: [] });
    const b = resolveEffectiveModules({ edition: 'construction', enabledModules: [], disabledModules: [] });
    expect(a).toEqual(b);
    const sorted = [...a].sort();
    // canonical order is registry order, not alphabetical — just assert no dupes
    expect(new Set(a).size).toBe(a.length);
    expect(sorted.length).toBe(a.length);
  });

  it('derives the full entitlement snapshot', () => {
    const sub = createSubscription({ organizationId: 'o1', edition: 'projects' });
    const eff = resolveEffectiveEntitlements(sub);
    expect(eff.edition).toBe('projects');
    expect(eff.isSuspended).toBe(false);
    expect(eff.moduleIds.length).toBeGreaterThan(EDITION_MODULES.core.length);
  });
});

/* ── canAccessFeature ─────────────────────────────────────────────────────── */

describe('canAccessFeature', () => {
  const core = EDITION_MODULES.core;
  it('allows features with no requirement', () => {
    expect(canAccessFeature(core, undefined)).toBe(true);
  });
  it('blocks a project feature for Core', () => {
    expect(canAccessFeature(core, { requiredModule: 'projects' })).toBe(false);
  });
  it('supports any/all requirements', () => {
    expect(canAccessFeature(core, { requiredAnyModules: ['sales', 'projects'] })).toBe(true);
    expect(canAccessFeature(core, { requiredAllModules: ['sales', 'projects'] })).toBe(false);
  });
});

/* ── Migration ────────────────────────────────────────────────────────────── */

describe('existing-data migration', () => {
  it('migrates an org with no subscription to Enterprise development', () => {
    const sub = migrateExistingOrganization(null);
    expect(sub.edition).toBe('enterprise');
    expect(sub.status).toBe('active');
    const mods = resolveEffectiveModules(sub);
    // No currently-implemented module should be hidden
    expect(has(mods, 'projects')).toBe(true);
    expect(has(mods, 'cost_centers')).toBe(true);
    expect(has(mods, 'tax_advanced')).toBe(true);
    expect(has(mods, 'currency_advanced')).toBe(true);
  });

  it('leaves an existing subscription untouched', () => {
    const existing = createSubscription({ organizationId: 'o1', edition: 'core' });
    expect(migrateExistingOrganization(existing)).toBe(existing);
  });

  it('the enterprise development subscription owns every stable module', () => {
    const sub = createEnterpriseDevelopmentSubscription();
    const mods = resolveEffectiveModules(sub);
    const stable = MODULE_DEFINITIONS.filter((m) => isStableModule(m.id)).map((m) => m.id);
    expect(hasAllModules(mods, stable)).toBe(true);
  });
});

/* ── Posting guard & limits ───────────────────────────────────────────────── */

describe('subscription posting guard', () => {
  it('allows posting for trial/active/past-due', () => {
    expect(assertSubscriptionAllowsPosting('active').ok).toBe(true);
    expect(assertSubscriptionAllowsPosting('trial').ok).toBe(true);
    expect(assertSubscriptionAllowsPosting('past-due').ok).toBe(true);
  });
  it('blocks posting for suspended/cancelled/expired', () => {
    for (const s of ['suspended', 'cancelled', 'expired'] as const) {
      const res = assertSubscriptionAllowsPosting(s);
      expect(res.ok).toBe(false);
      expect(res.error).toBeTruthy();
    }
  });
  it('enforces user and entity limits with clear messages', () => {
    expect(canCreateEntity(1, 2).ok).toBe(true);
    const blocked = canCreateEntity(2, 2);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain('2 entit');
    expect(canCreateUser(3, 3).ok).toBe(false);
  });
});

/* ── Edition seeding ──────────────────────────────────────────────────────── */

describe('edition seeding plan', () => {
  it('Core seeds accounting/customers/suppliers only — never project/construction data', () => {
    const plan = seedOrganizationForEdition('core');
    expect(plan.seedAccounting).toBe(true);
    expect(plan.seedCustomers).toBe(true);
    expect(plan.seedSuppliers).toBe(true);
    expect(plan.seedCostCenters).toBe(false);
    expect(plan.seedProjects).toBe(false);
    expect(plan.seedConstructionBoq).toBe(false);
  });
  it('Projects seeds cost centers, projects and budgets', () => {
    const plan = seedOrganizationForEdition('projects');
    expect(plan.seedCostCenters).toBe(true);
    expect(plan.seedProjects).toBe(true);
    expect(plan.seedProjectBudgets).toBe(true);
    expect(plan.seedConstructionBoq).toBe(false);
  });
  it('Construction seeds WBS, cost codes, BOQ, retention & subcontracts', () => {
    const plan = seedOrganizationForEdition('construction');
    expect(plan.seedConstructionWbs).toBe(true);
    expect(plan.seedConstructionCostCodes).toBe(true);
    expect(plan.seedConstructionBoq).toBe(true);
    expect(plan.seedConstructionRetention).toBe(true);
    expect(plan.seedConstructionSubcontracts).toBe(true);
  });

  it('Manufacturing seeds inventory, warehouses, items, BOM, routings, work centers & work orders', () => {
    const plan = seedOrganizationForEdition('manufacturing');
    expect(plan.seedInventory).toBe(true);
    expect(plan.seedWarehouses).toBe(true);
    expect(plan.seedManufacturingItems).toBe(true);
    expect(plan.seedManufacturingBom).toBe(true);
    expect(plan.seedManufacturingRoutings).toBe(true);
    expect(plan.seedManufacturingWorkCenters).toBe(true);
    expect(plan.seedManufacturingWorkOrders).toBe(true);
    // and NOT construction/project data
    expect(plan.seedConstructionBoq).toBe(false);
    expect(plan.seedProjects).toBe(false);
  });

  it('manufacturing seed is isolated from Core/Projects/Construction', () => {
    for (const edition of ['core', 'projects', 'construction'] as const) {
      const plan = seedOrganizationForEdition(edition);
      expect(plan.seedManufacturingItems).toBe(false);
      expect(plan.seedManufacturingWorkOrders).toBe(false);
    }
    // Inventory is a shared module: Core/Projects don't get it, but Construction
    // now does (construction_materials depends on inventory_basic).
    expect(seedOrganizationForEdition('core').seedInventory).toBe(false);
    expect(seedOrganizationForEdition('projects').seedInventory).toBe(false);
    expect(seedOrganizationForEdition('construction').seedInventory).toBe(true);
    // seedManufacturingOrganization descriptor only applies to Manufacturing
    expect(seedManufacturingOrganization('core').applies).toBe(false);
    const mfgSeed = seedManufacturingOrganization('manufacturing');
    expect(mfgSeed.applies).toBe(true);
    expect(mfgSeed.plants).toBe(1);
    expect(mfgSeed.warehouses).toBe(3);
  });
});

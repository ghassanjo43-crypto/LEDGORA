/**
 * Edition-specific seed planning.
 *
 * A new organization is seeded with ONLY the data relevant to its edition. Core
 * organizations never receive project or construction sample data. This module
 * returns a declarative plan; callers (onboarding / company creation) apply the
 * parts they support. Construction sample datasets are built in the Construction
 * phases — the plan already advertises them so wiring is incremental.
 */
import type { LedgoraEdition, LedgoraModule } from '@/types/entitlements';
import { getEditionModules } from '@/config/editions';

export interface EditionSeedPlan {
  edition: LedgoraEdition;
  /** Always seeded: chart of accounts, standard transactions. */
  seedAccounting: boolean;
  seedCustomers: boolean;
  seedSuppliers: boolean;
  /** Projects tier. */
  seedCostCenters: boolean;
  seedProjects: boolean;
  seedProjectBudgets: boolean;
  /** Construction tier. */
  seedConstructionWbs: boolean;
  seedConstructionCostCodes: boolean;
  seedConstructionBoq: boolean;
  seedConstructionRetention: boolean;
  seedConstructionSubcontracts: boolean;
  /** Manufacturing tier. */
  seedInventory: boolean;
  seedWarehouses: boolean;
  seedManufacturingItems: boolean;
  seedManufacturingBom: boolean;
  seedManufacturingRoutings: boolean;
  seedManufacturingWorkCenters: boolean;
  seedManufacturingWorkOrders: boolean;
}

/**
 * Compute what to seed for a chosen edition. Membership is driven off the
 * edition's resolved modules so the plan can never seed data for a module the
 * edition does not own.
 */
export function seedOrganizationForEdition(
  edition: LedgoraEdition,
): EditionSeedPlan {
  const modules = new Set<LedgoraModule>(getEditionModules(edition));
  const has = (m: LedgoraModule): boolean => modules.has(m);
  return {
    edition,
    seedAccounting: has('core_accounting'),
    seedCustomers: has('sales'),
    seedSuppliers: has('purchases'),
    seedCostCenters: has('cost_centers'),
    seedProjects: has('projects'),
    seedProjectBudgets: has('project_budgets'),
    seedConstructionWbs: has('construction_wbs'),
    seedConstructionCostCodes: has('construction_cost_codes'),
    seedConstructionBoq: has('construction_boq'),
    seedConstructionRetention: has('construction_retention'),
    seedConstructionSubcontracts: has('construction_subcontracts'),
    seedInventory: has('inventory_basic'),
    seedWarehouses: has('warehouses'),
    seedManufacturingItems: has('manufacturing_items'),
    seedManufacturingBom: has('manufacturing_bom'),
    seedManufacturingRoutings: has('manufacturing_routings'),
    seedManufacturingWorkCenters: has('manufacturing_work_centers'),
    seedManufacturingWorkOrders: has('manufacturing_work_orders'),
  };
}

/** Convenience: does this edition seed any project-related data at all? */
export function editionSeedsProjectData(edition: LedgoraEdition): boolean {
  const plan = seedOrganizationForEdition(edition);
  return plan.seedCostCenters || plan.seedProjects;
}

/** Convenience: does this edition seed any construction data at all? */
export function editionSeedsConstructionData(edition: LedgoraEdition): boolean {
  const plan = seedOrganizationForEdition(edition);
  return (
    plan.seedConstructionWbs ||
    plan.seedConstructionBoq ||
    plan.seedConstructionRetention ||
    plan.seedConstructionSubcontracts
  );
}

/** Convenience: does this edition seed any manufacturing/inventory data at all? */
export function editionSeedsManufacturingData(edition: LedgoraEdition): boolean {
  const plan = seedOrganizationForEdition(edition);
  return (
    plan.seedInventory ||
    plan.seedManufacturingItems ||
    plan.seedManufacturingBom ||
    plan.seedManufacturingWorkOrders
  );
}

/**
 * Manufacturing seed descriptor (spec §39). Returns the sample entities a new
 * Manufacturing organization should receive. Actual data creation is wired in
 * Manufacturing Phase 1 — this keeps seed intent centralized and isolated so it
 * is never applied to Core/Projects/Construction organizations.
 */
export function seedManufacturingOrganization(edition: LedgoraEdition): {
  applies: boolean;
  plants: number;
  warehouses: number;
  rawMaterials: number;
  finishedProducts: number;
  boms: number;
  routings: number;
  workCenters: number;
  workOrders: number;
} {
  const applies = editionSeedsManufacturingData(edition);
  if (!applies) {
    return {
      applies: false,
      plants: 0,
      warehouses: 0,
      rawMaterials: 0,
      finishedProducts: 0,
      boms: 0,
      routings: 0,
      workCenters: 0,
      workOrders: 0,
    };
  }
  return {
    applies: true,
    plants: 1,
    warehouses: 3, // raw-material, WIP, finished-goods
    rawMaterials: 3,
    finishedProducts: 1,
    boms: 1,
    routings: 1,
    workCenters: 3,
    workOrders: 2, // one planned, one completed
  };
}

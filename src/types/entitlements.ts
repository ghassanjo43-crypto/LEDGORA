/**
 * Ledgora editions & module entitlements — core type definitions.
 *
 * One codebase, one accounting engine, multiple commercial editions. These
 * types describe WHICH modules exist and how they group into editions. The
 * runtime source of truth for what a given organization can access lives in
 * the entitlement store; these types never change accounting logic.
 */

/** The commercial editions Ledgora is sold as. */
export type LedgoraEdition =
  | 'core'
  | 'projects'
  | 'construction'
  | 'manufacturing'
  | 'enterprise';

/** Every gate-able capability in the product. */
export type LedgoraModule =
  | 'core_accounting'
  | 'sales'
  | 'purchases'
  | 'customer_statements'
  | 'supplier_statements'
  | 'tax_basic'
  | 'tax_advanced'
  | 'currency_basic'
  | 'currency_advanced'
  | 'cost_centers'
  | 'cost_center_budgets'
  | 'cost_allocations'
  | 'projects'
  | 'project_budgets'
  | 'project_time_expenses'
  | 'project_billing'
  | 'project_profitability'
  | 'project_cash_flow'
  | 'construction_projects'
  | 'construction_wbs'
  | 'construction_cost_codes'
  | 'construction_boq'
  | 'construction_progress_billing'
  | 'construction_retention'
  | 'construction_subcontracts'
  | 'construction_variations'
  | 'construction_commitments'
  | 'construction_materials'
  | 'construction_labor'
  | 'construction_equipment'
  | 'construction_wip'
  | 'construction_revenue_recognition'
  | 'construction_forecasting'
  // Inventory & warehousing (Manufacturing tier)
  | 'inventory_basic'
  | 'inventory_advanced'
  | 'warehouses'
  | 'lot_serial_tracking'
  | 'landed_cost'
  // Manufacturing
  | 'manufacturing_core'
  | 'manufacturing_items'
  | 'manufacturing_bom'
  | 'manufacturing_routings'
  | 'manufacturing_work_centers'
  | 'manufacturing_work_orders'
  | 'manufacturing_production_planning'
  | 'manufacturing_mrp'
  | 'manufacturing_capacity_planning'
  | 'manufacturing_material_issues'
  | 'manufacturing_production_receipts'
  | 'manufacturing_scrap'
  | 'manufacturing_rework'
  | 'manufacturing_subcontracting'
  | 'manufacturing_standard_costing'
  | 'manufacturing_actual_costing'
  | 'manufacturing_variance_analysis'
  | 'manufacturing_quality'
  | 'manufacturing_maintenance'
  | 'manufacturing_traceability'
  | 'manufacturing_batch_process'
  | 'manufacturing_yield'
  | 'manufacturing_co_products'
  | 'manufacturing_dashboards'
  | 'manufacturing_reports'
  | 'advanced_reporting'
  | 'multi_entity'
  | 'approvals'
  | 'audit_admin';

/** High-level grouping used by the admin entitlement table. */
export type ModuleCategory =
  | 'core'
  | 'sales'
  | 'purchases'
  | 'projects'
  | 'construction'
  | 'manufacturing'
  | 'reporting'
  | 'administration';

/**
 * Static metadata for one module. `dependencies` are other modules that MUST
 * be enabled for this one to function; `defaultForEditions` lists the editions
 * that include this module out of the box (edition nesting is expressed by
 * listing every edition a module belongs to).
 */
export interface ModuleDefinition {
  id: LedgoraModule;
  name: string;
  description: string;
  category: ModuleCategory;
  dependencies: LedgoraModule[];
  defaultForEditions: LedgoraEdition[];
  /** Whether the module is shown in the admin entitlement table. */
  isVisibleInAdmin: boolean;
  /** Experimental modules are excluded from the Enterprise "all stable" preset. */
  isExperimental?: boolean;
}

/**
 * The fully-resolved access snapshot for the active organization. Derived from
 * the subscription (edition preset + add-ons − disables + dependency
 * expansion). Consumers read `moduleIds` — never a freshly-built Set.
 */
export interface EffectiveEntitlements {
  edition: LedgoraEdition;
  status: import('./subscription').SubscriptionStatus;
  moduleIds: LedgoraModule[];
  userLimit: number;
  entityLimit: number;
  isTrial: boolean;
  isSuspended: boolean;
  isExpired: boolean;
}

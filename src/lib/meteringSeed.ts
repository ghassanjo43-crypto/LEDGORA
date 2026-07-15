/**
 * Seed (initial) metering configuration. These are only the first values written
 * to the config store; the super administrator edits everything afterwards —
 * nothing here is read at runtime once seeded.
 */
import type {
  CommercialBasePlan,
  MeteringConfig,
  OptionalModuleOffer,
  OverageRates,
  PlanAllowances,
  RenderCostAssumptions,
  UsageBundle,
} from '@/types/metering';

function allow(a: PlanAllowances): PlanAllowances {
  return a;
}

export function makeSeedBasePlans(): CommercialBasePlan[] {
  return [
    {
      id: 'base_core',
      code: 'core',
      name: 'Ledgora Core',
      priceMonthly: 39,
      startingAt: false,
      currency: 'USD',
      sortOrder: 0,
      isActive: true,
      allowances: allow({ users: 3, companies: 1, storageGb: 5, bandwidthGb: 25, uploadedFiles: 500, reportExports: 50, journalEntries: 5_000, invoices: 500, apiRequests: 50_000, aiUnits: 0 }),
    },
    {
      id: 'base_professional',
      code: 'professional',
      name: 'Ledgora Professional',
      priceMonthly: 89,
      startingAt: false,
      currency: 'USD',
      sortOrder: 1,
      isActive: true,
      allowances: allow({ users: 10, companies: 3, storageGb: 25, bandwidthGb: 100, uploadedFiles: 5_000, reportExports: 250, journalEntries: 25_000, invoices: 2_500, apiRequests: 250_000, aiUnits: 100_000 }),
    },
    {
      id: 'base_business',
      code: 'business',
      name: 'Ledgora Business',
      priceMonthly: 179,
      startingAt: false,
      currency: 'USD',
      sortOrder: 2,
      isActive: true,
      allowances: allow({ users: 25, companies: 10, storageGb: 100, bandwidthGb: 500, uploadedFiles: 25_000, reportExports: 1_000, journalEntries: 100_000, invoices: 10_000, apiRequests: 1_000_000, aiUnits: 1_000_000 }),
    },
    {
      id: 'base_enterprise',
      code: 'enterprise',
      name: 'Ledgora Enterprise',
      priceMonthly: 499,
      startingAt: true,
      currency: 'USD',
      sortOrder: 3,
      isActive: true,
      allowances: allow({ users: 100, companies: 25, storageGb: 500, bandwidthGb: 2_000, uploadedFiles: 100_000, reportExports: 10_000, journalEntries: 1_000_000, invoices: 100_000, apiRequests: 10_000_000, aiUnits: 10_000_000 }),
    },
  ];
}

export function makeSeedOptionalModules(): OptionalModuleOffer[] {
  const base = { currency: 'USD', isActive: true } as const;
  return [
    { id: 'opt_projects', code: 'projects', name: 'Projects', priceMonthly: 29, sortOrder: 0, ...base },
    { id: 'opt_construction', code: 'construction', name: 'Construction', priceMonthly: 49, sortOrder: 1, ...base },
    { id: 'opt_manufacturing', code: 'manufacturing', name: 'Manufacturing', priceMonthly: 59, sortOrder: 2, ...base },
    { id: 'opt_advanced_inventory', code: 'advanced_inventory', name: 'Advanced Inventory', priceMonthly: 39, sortOrder: 3, ...base },
    { id: 'opt_ai', code: 'ai', name: 'AI', priceMonthly: 49, sortOrder: 4, ...base },
    { id: 'opt_consolidation', code: 'consolidation', name: 'Consolidation', priceMonthly: 79, sortOrder: 5, ...base },
  ];
}

/** Initial customer overage rates (from the specification). */
export const SEED_OVERAGE_RATES: OverageRates = {
  storagePerGbMonth: 0.75,
  bandwidthPerGb: 0.45,
  extraUserMonth: 6,
  extraCompanyMonth: 20,
  journalEntriesBlock: 10_000,
  journalEntriesBlockPrice: 5,
  apiRequestsBlock: 100_000,
  apiRequestsBlockPrice: 5,
};

export function makeSeedBundles(): UsageBundle[] {
  return [
    { id: 'bnd_storage_10', kind: 'storage', gb: 10, price: 6, currency: 'USD' },
    { id: 'bnd_storage_50', kind: 'storage', gb: 50, price: 25, currency: 'USD' },
    { id: 'bnd_bw_50', kind: 'bandwidth', gb: 50, price: 18, currency: 'USD' },
    { id: 'bnd_bw_250', kind: 'bandwidth', gb: 250, price: 80, currency: 'USD' },
  ];
}

/** Editable Render / infrastructure cost assumptions used for cost recovery. */
export const SEED_RENDER_COSTS: RenderCostAssumptions = {
  webServiceMonthly: 25,
  postgresMonthly: 20,
  objectStoragePerGbMonth: 0.15,
  egressPerGb: 0.1,
  aiCostPerUnit: 0.0008,
  perMillionApiRequests: 0.4,
  overheadMonthly: 10,
};

export const SEED_THRESHOLDS = [70, 85, 100, 120];

export function makeSeedMeteringConfig(now: string): MeteringConfig {
  const basePlans = makeSeedBasePlans();
  return {
    basePlans,
    optionalModules: makeSeedOptionalModules(),
    overageRates: { ...SEED_OVERAGE_RATES },
    bundles: makeSeedBundles(),
    renderCosts: { ...SEED_RENDER_COSTS },
    thresholds: [...SEED_THRESHOLDS],
    activeBasePlanId: basePlans[0]!.id,
    activeModuleCodes: [],
    updatedAt: now,
  };
}

/** Bytes per GB (decimal GB, matching cloud egress/storage billing). */
export const BYTES_PER_GB = 1_000_000_000;

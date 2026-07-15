/**
 * Usage-metering & infrastructure-cost-recovery domain types.
 *
 * Ledgora is one application. This layer models per-organization usage, plan
 * allowances, overage and the cost of the underlying infrastructure. It is
 * frontend modelling with clean seams for a real backend:
 *   - Document BINARIES are never stored here — only metadata + an object-store
 *     key. A real deployment issues signed upload/download URLs from object
 *     storage (S3/R2/GCS); Postgres holds only the metadata.
 *   - Every rate, price, allowance and cost assumption is configuration, edited
 *     by the super administrator — nothing is hard-coded (seed values only).
 *
 * Billing rule: uploads are NOT outbound bandwidth (inbound is free). An upload
 * consumes STORAGE (and a file count); DOWNLOADS and API responses consume
 * OUTBOUND BANDWIDTH.
 */

/** Everything we meter. */
export type UsageMetric =
  | 'users' // gauge / seat limit
  | 'companies' // gauge / limit
  | 'storage_bytes' // level (average-daily-storage billed)
  | 'uploaded_files' // counter (also adds storage via a delta event)
  | 'outbound_download_bytes' // counter → outbound bandwidth
  | 'api_outbound_bytes' // counter → outbound bandwidth
  | 'report_exports' // counter
  | 'journal_entries' // counter
  | 'invoices' // counter
  | 'api_requests' // counter
  | 'ai_units'; // counter (AI usage, e.g. 1k-token units)

/** How a metric aggregates over a period. */
export type MetricNature = 'counter' | 'storage' | 'gauge';

export interface UsageEventKindMeta {
  /** 'usage' events are immutable; 'adjustment' events correct a closed period. */
  kind: 'usage' | 'adjustment';
}

/**
 * A single append-only usage event. For counters `quantity` is a positive
 * increment; for storage it is a SIGNED byte delta (+upload, −delete). Events
 * are never mutated — corrections to a closed period are recorded as adjustment
 * events referencing the affected period.
 */
export interface UsageEvent extends UsageEventKindMeta {
  id: string;
  organizationId: string;
  metric: UsageMetric;
  quantity: number;
  /** ISO timestamp. */
  at: string;
  /** yyyy-mm-dd bucket. */
  day: string;
  /** yyyy-mm period bucket. */
  period: string;
  source: string;
  refId?: string;
  note?: string;
  actor: string;
}

/** Document metadata only — the binary lives in external object storage. */
export interface DocumentMeta {
  id: string;
  organizationId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** Object-storage key (e.g. s3://bucket/org/uuid). No binary is stored here. */
  storageKey: string;
  checksum?: string;
  uploadedAt: string;
  uploadedBy: string;
  status: 'active' | 'deleted';
}

/** Seam for a real object-storage provider (signed uploads/downloads). */
export interface SignedUrl {
  url: string;
  method: 'PUT' | 'GET';
  storageKey: string;
  expiresAt: string;
}

/** Per-metric allowance for a plan (monthly for counters; level for gauges). */
export interface PlanAllowances {
  users: number;
  companies: number;
  storageGb: number;
  bandwidthGb: number;
  uploadedFiles: number;
  reportExports: number;
  journalEntries: number;
  invoices: number;
  apiRequests: number;
  aiUnits: number;
}

/** A commercial base plan (super-admin editable). */
export interface CommercialBasePlan {
  id: string;
  code: string;
  name: string;
  priceMonthly: number;
  /** Enterprise-style "starting at" pricing flag. */
  startingAt: boolean;
  currency: string;
  allowances: PlanAllowances;
  isActive: boolean;
  sortOrder: number;
}

/** Optional priced module add-on (super-admin editable). */
export interface OptionalModuleOffer {
  id: string;
  code: 'projects' | 'construction' | 'manufacturing' | 'advanced_inventory' | 'ai' | 'consolidation';
  name: string;
  priceMonthly: number;
  currency: string;
  isActive: boolean;
  sortOrder: number;
}

/** Customer-facing overage rates (super-admin editable). */
export interface OverageRates {
  storagePerGbMonth: number;
  bandwidthPerGb: number;
  extraUserMonth: number;
  extraCompanyMonth: number;
  journalEntriesBlock: number; // block size (e.g. 10_000)
  journalEntriesBlockPrice: number; // price per block (e.g. 5)
  apiRequestsBlock: number; // block size (e.g. 100_000)
  apiRequestsBlockPrice: number; // price per block (e.g. 5)
}

/** Prepaid capacity bundles that raise the effective allowance. */
export interface UsageBundle {
  id: string;
  kind: 'storage' | 'bandwidth';
  gb: number;
  price: number;
  currency: string;
}

/** How much of each bundle an organization has purchased. */
export interface OrganizationBundles {
  storageGb: number;
  bandwidthGb: number;
}

/**
 * Editable assumptions used to estimate the true Render / infrastructure cost of
 * an organization's usage. Never hard-coded — the super administrator maintains
 * these as the platform's real costs change.
 */
export interface RenderCostAssumptions {
  webServiceMonthly: number;
  postgresMonthly: number;
  objectStoragePerGbMonth: number;
  egressPerGb: number;
  aiCostPerUnit: number;
  perMillionApiRequests: number;
  overheadMonthly: number;
}

export interface MeteringConfig {
  basePlans: CommercialBasePlan[];
  optionalModules: OptionalModuleOffer[];
  overageRates: OverageRates;
  bundles: UsageBundle[];
  renderCosts: RenderCostAssumptions;
  /** Warning thresholds as percentages, e.g. [70, 85, 100, 120]. */
  thresholds: number[];
  /** The base plan the active organization is on (drives allowances). */
  activeBasePlanId: string;
  /** Optional module codes currently enabled. */
  activeModuleCodes: string[];
  updatedAt: string;
}

/* ── Rollups & billing artefacts ──────────────────────────────────────────── */

export interface MetricSummary {
  metric: UsageMetric;
  /** Period total (counters), average-daily bytes (storage), or level (gauge). */
  value: number;
}

export interface UsageSummary {
  organizationId: string;
  period: string;
  /** Elapsed days used for average-daily-storage. */
  daysElapsed: number;
  daysInPeriod: number;
  counters: Record<string, number>;
  /** Average daily storage in bytes across the elapsed period. */
  averageStorageBytes: number;
  /** Outbound bandwidth bytes = downloads + api outbound (uploads excluded). */
  outboundBandwidthBytes: number;
  users: number;
  companies: number;
}

export type ThresholdBand = 'ok' | 'warn70' | 'warn85' | 'over100' | 'critical120';

export interface AllowanceLine {
  metric: UsageMetric;
  label: string;
  used: number;
  allowance: number;
  /** Display unit, e.g. 'GB', 'entries'. */
  unit: string;
  pct: number;
  band: ThresholdBand;
  overage: number;
  overageCost: number;
  currency: string;
}

export interface OverageCharge {
  metric: UsageMetric;
  label: string;
  quantity: number;
  unit: string;
  rate: number;
  amount: number;
}

export interface OverageStatement {
  organizationId: string;
  period: string;
  currency: string;
  lines: OverageCharge[];
  total: number;
}

export interface InfraCostBreakdown {
  compute: number;
  database: number;
  storage: number;
  egress: number;
  ai: number;
  api: number;
  overhead: number;
  total: number;
}

export interface CostRecovery {
  organizationId: string;
  period: string;
  currency: string;
  planRevenue: number;
  overageRevenue: number;
  totalRevenue: number;
  infraCost: number;
  margin: number;
  marginPct: number;
}

/* ── Immutable monthly usage ledger ───────────────────────────────────────── */

export interface UsageAdjustment {
  id: string;
  metric: UsageMetric;
  quantity: number;
  reason: string;
  at: string;
  actor: string;
}

export interface MonthlyUsagePeriod {
  organizationId: string;
  period: string; // yyyy-mm
  status: 'open' | 'closed';
  closedAt?: string;
  closedBy?: string;
  /** Snapshot of the summary frozen at close (immutable). */
  summarySnapshot?: UsageSummary;
  /** Post-close corrections; never edit closed usage events. */
  adjustments: UsageAdjustment[];
}

export type MeteringAuditEvent =
  | 'config-updated'
  | 'plan-updated'
  | 'module-updated'
  | 'overage-rates-updated'
  | 'bundle-updated'
  | 'render-costs-updated'
  | 'bundle-purchased'
  | 'period-closed'
  | 'period-reopened'
  | 'adjustment-recorded'
  | 'threshold-crossed';

export interface MeteringAuditEntry {
  id: string;
  event: MeteringAuditEvent;
  at: string;
  actor: string;
  detail: string;
  period?: string;
}

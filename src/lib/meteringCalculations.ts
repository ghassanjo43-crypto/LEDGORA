/**
 * Pure usage-metering & cost-recovery engine. No React, no store.
 *
 * Key rules:
 *  - Uploads are STORAGE (+ file count), never outbound bandwidth.
 *  - Outbound bandwidth = downloads + API outbound responses.
 *  - Storage is billed on AVERAGE DAILY storage over the period.
 *  - Overage applies after prepaid bundles raise the effective allowance.
 *  - Adjustments (for closed periods) fold into the billed totals; the raw
 *    usage events are never mutated.
 */
import type {
  AllowanceLine,
  CostRecovery,
  InfraCostBreakdown,
  MetricNature,
  OrganizationBundles,
  OverageCharge,
  OverageRates,
  OverageStatement,
  PlanAllowances,
  RenderCostAssumptions,
  ThresholdBand,
  UsageAdjustment,
  UsageEvent,
  UsageMetric,
  UsageSummary,
} from '@/types/metering';
import { BYTES_PER_GB } from './meteringSeed';

/* ── Metric classification ────────────────────────────────────────────────── */

export const METRIC_NATURE: Record<UsageMetric, MetricNature> = {
  users: 'gauge',
  companies: 'gauge',
  storage_bytes: 'storage',
  uploaded_files: 'counter',
  outbound_download_bytes: 'counter',
  api_outbound_bytes: 'counter',
  report_exports: 'counter',
  journal_entries: 'counter',
  invoices: 'counter',
  api_requests: 'counter',
  ai_units: 'counter',
};

/** Metrics that count as billable outbound bandwidth (uploads excluded). */
export const BANDWIDTH_METRICS: UsageMetric[] = ['outbound_download_bytes', 'api_outbound_bytes'];

export const COUNTER_METRICS: UsageMetric[] = (Object.keys(METRIC_NATURE) as UsageMetric[]).filter(
  (m) => METRIC_NATURE[m] === 'counter',
);

/* ── Date helpers ─────────────────────────────────────────────────────────── */

export function periodKeyOf(dateIso: string): string {
  return dateIso.slice(0, 7);
}

export function dayKeyOf(dateIso: string): string {
  return dateIso.slice(0, 10);
}

export function daysInPeriod(period: string): number {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

/** All yyyy-mm-dd day keys from the 1st of the period up to (and incl.) asOfDay. */
function elapsedDays(period: string, asOfDay: string): string[] {
  const total = daysInPeriod(period);
  const days: string[] = [];
  for (let d = 1; d <= total; d += 1) {
    const key = `${period}-${String(d).padStart(2, '0')}`;
    if (key > asOfDay) break;
    days.push(key);
  }
  return days;
}

/* ── Average daily storage ────────────────────────────────────────────────── */

/**
 * Average daily storage in bytes across the elapsed period. Storage events are
 * signed byte deltas (+upload, −delete). The level carried into the period is
 * the sum of all deltas dated before it.
 */
export function averageDailyStorageBytes(
  storageEvents: { day: string; quantity: number }[],
  period: string,
  asOfDay: string,
  extraDelta = 0,
): number {
  const days = elapsedDays(period, asOfDay);
  if (days.length === 0) return 0;
  const firstDay = `${period}-01`;
  let baseline = extraDelta;
  for (const e of storageEvents) if (e.day < firstDay) baseline += e.quantity;

  // cumulative delta within the period, applied by day
  const byDay = new Map<string, number>();
  for (const e of storageEvents) {
    if (e.day >= firstDay) byDay.set(e.day, (byDay.get(e.day) ?? 0) + e.quantity);
  }
  let running = baseline;
  let sum = 0;
  for (const day of days) {
    running += byDay.get(day) ?? 0;
    sum += Math.max(0, running);
  }
  return sum / days.length;
}

/* ── Summary ──────────────────────────────────────────────────────────────── */

export interface Levels {
  users: number;
  companies: number;
}

/**
 * Aggregate raw events (+ closed-period adjustments) into a period summary.
 * `asOf` defaults to the last instant considered for average-daily-storage.
 */
export function summarizeUsage(
  events: UsageEvent[],
  adjustments: UsageAdjustment[],
  organizationId: string,
  period: string,
  levels: Levels,
  asOfDay: string,
): UsageSummary {
  const inScope = events.filter((e) => e.organizationId === organizationId);

  const counters: Record<string, number> = {};
  for (const m of COUNTER_METRICS) counters[m] = 0;
  const storageEvents: { day: string; quantity: number }[] = [];

  for (const e of inScope) {
    if (e.metric === 'storage_bytes') {
      storageEvents.push({ day: e.day, quantity: e.quantity });
    } else if (e.period === period && METRIC_NATURE[e.metric] === 'counter') {
      counters[e.metric] = (counters[e.metric] ?? 0) + e.quantity;
    }
  }

  // fold adjustments into billed totals (never mutate raw events)
  let storageAdjustBytes = 0;
  for (const adj of adjustments) {
    if (adj.metric === 'storage_bytes') storageAdjustBytes += adj.quantity;
    else if (METRIC_NATURE[adj.metric] === 'counter') counters[adj.metric] = (counters[adj.metric] ?? 0) + adj.quantity;
  }

  const averageStorageBytes = averageDailyStorageBytes(storageEvents, period, asOfDay, 0) + storageAdjustBytes;
  const outboundBandwidthBytes = BANDWIDTH_METRICS.reduce((sum, m) => sum + (counters[m] ?? 0), 0);
  const total = daysInPeriod(period);
  const elapsed = elapsedDays(period, asOfDay).length || 1;

  return {
    organizationId,
    period,
    daysElapsed: elapsed,
    daysInPeriod: total,
    counters,
    averageStorageBytes: Math.max(0, averageStorageBytes),
    outboundBandwidthBytes,
    users: levels.users,
    companies: levels.companies,
  };
}

/* ── Thresholds ───────────────────────────────────────────────────────────── */

export function thresholdBand(pct: number, thresholds: number[]): ThresholdBand {
  const [t70 = 70, t85 = 85, t100 = 100, t120 = 120] = [...thresholds].sort((a, b) => a - b);
  if (pct >= t120) return 'critical120';
  if (pct >= t100) return 'over100';
  if (pct >= t85) return 'warn85';
  if (pct >= t70) return 'warn70';
  return 'ok';
}

function pctOf(used: number, allowance: number): number {
  if (allowance <= 0) return used > 0 ? 999 : 0;
  return (used / allowance) * 100;
}

/* ── Allowance lines (dashboard) ──────────────────────────────────────────── */

export function buildAllowanceLines(
  summary: UsageSummary,
  allowances: PlanAllowances,
  bundles: OrganizationBundles,
  rates: OverageRates,
  thresholds: number[],
  currency: string,
): AllowanceLine[] {
  const storageGb = summary.averageStorageBytes / BYTES_PER_GB;
  const bandwidthGb = summary.outboundBandwidthBytes / BYTES_PER_GB;
  const storageAllow = allowances.storageGb + bundles.storageGb;
  const bandwidthAllow = allowances.bandwidthGb + bundles.bandwidthGb;

  const je = summary.counters.journal_entries ?? 0;
  const api = summary.counters.api_requests ?? 0;

  const jeBlocks = Math.ceil(Math.max(0, je - allowances.journalEntries) / rates.journalEntriesBlock);
  const apiBlocks = Math.ceil(Math.max(0, api - allowances.apiRequests) / rates.apiRequestsBlock);

  const line = (
    metric: UsageMetric,
    label: string,
    used: number,
    allowance: number,
    unit: string,
    overage: number,
    overageCost: number,
  ): AllowanceLine => ({
    metric,
    label,
    used,
    allowance,
    unit,
    pct: pctOf(used, allowance),
    band: thresholdBand(pctOf(used, allowance), thresholds),
    overage,
    overageCost: round2(overageCost),
    currency,
  });

  return [
    line('users', 'Users', summary.users, allowances.users, 'users', Math.max(0, summary.users - allowances.users), Math.max(0, summary.users - allowances.users) * rates.extraUserMonth),
    line('companies', 'Companies', summary.companies, allowances.companies, 'companies', Math.max(0, summary.companies - allowances.companies), Math.max(0, summary.companies - allowances.companies) * rates.extraCompanyMonth),
    line('storage_bytes', 'Avg. storage', round2(storageGb), storageAllow, 'GB', round2(Math.max(0, storageGb - storageAllow)), Math.max(0, storageGb - storageAllow) * rates.storagePerGbMonth),
    line('outbound_download_bytes', 'Outbound bandwidth', round2(bandwidthGb), bandwidthAllow, 'GB', round2(Math.max(0, bandwidthGb - bandwidthAllow)), Math.max(0, bandwidthGb - bandwidthAllow) * rates.bandwidthPerGb),
    line('journal_entries', 'Journal entries', je, allowances.journalEntries, 'entries', Math.max(0, je - allowances.journalEntries), jeBlocks * rates.journalEntriesBlockPrice),
    line('api_requests', 'API requests', api, allowances.apiRequests, 'requests', Math.max(0, api - allowances.apiRequests), apiBlocks * rates.apiRequestsBlockPrice),
    line('invoices', 'Invoices', summary.counters.invoices ?? 0, allowances.invoices, 'invoices', 0, 0),
    line('uploaded_files', 'Uploaded files', summary.counters.uploaded_files ?? 0, allowances.uploadedFiles, 'files', 0, 0),
    line('report_exports', 'Report exports', summary.counters.report_exports ?? 0, allowances.reportExports, 'exports', 0, 0),
    line('ai_units', 'AI usage', summary.counters.ai_units ?? 0, allowances.aiUnits, 'units', 0, 0),
  ];
}

/* ── Overage statement ────────────────────────────────────────────────────── */

export function computeOverage(
  summary: UsageSummary,
  allowances: PlanAllowances,
  bundles: OrganizationBundles,
  rates: OverageRates,
  currency: string,
): OverageStatement {
  const lines: OverageCharge[] = [];
  const push = (metric: UsageMetric, label: string, quantity: number, unit: string, rate: number): void => {
    if (quantity > 0 && rate > 0) lines.push({ metric, label, quantity: round2(quantity), unit, rate, amount: round2(quantity * rate) });
  };

  const storageGb = summary.averageStorageBytes / BYTES_PER_GB;
  const bandwidthGb = summary.outboundBandwidthBytes / BYTES_PER_GB;
  push('storage_bytes', 'Storage overage', Math.max(0, storageGb - (allowances.storageGb + bundles.storageGb)), 'GB-month', rates.storagePerGbMonth);
  push('outbound_download_bytes', 'Bandwidth overage', Math.max(0, bandwidthGb - (allowances.bandwidthGb + bundles.bandwidthGb)), 'GB', rates.bandwidthPerGb);
  push('users', 'Extra users', Math.max(0, summary.users - allowances.users), 'users', rates.extraUserMonth);
  push('companies', 'Extra companies', Math.max(0, summary.companies - allowances.companies), 'companies', rates.extraCompanyMonth);

  const jeBlocks = Math.ceil(Math.max(0, (summary.counters.journal_entries ?? 0) - allowances.journalEntries) / rates.journalEntriesBlock);
  if (jeBlocks > 0) lines.push({ metric: 'journal_entries', label: `Journal entries (${rates.journalEntriesBlock.toLocaleString()} blocks)`, quantity: jeBlocks, unit: 'blocks', rate: rates.journalEntriesBlockPrice, amount: round2(jeBlocks * rates.journalEntriesBlockPrice) });
  const apiBlocks = Math.ceil(Math.max(0, (summary.counters.api_requests ?? 0) - allowances.apiRequests) / rates.apiRequestsBlock);
  if (apiBlocks > 0) lines.push({ metric: 'api_requests', label: `API requests (${rates.apiRequestsBlock.toLocaleString()} blocks)`, quantity: apiBlocks, unit: 'blocks', rate: rates.apiRequestsBlockPrice, amount: round2(apiBlocks * rates.apiRequestsBlockPrice) });

  return { organizationId: summary.organizationId, period: summary.period, currency, lines, total: round2(lines.reduce((s, l) => s + l.amount, 0)) };
}

/* ── Infrastructure cost & recovery ───────────────────────────────────────── */

export function estimateInfraCost(summary: UsageSummary, costs: RenderCostAssumptions): InfraCostBreakdown {
  const storageGbMonth = summary.averageStorageBytes / BYTES_PER_GB;
  const egressGb = summary.outboundBandwidthBytes / BYTES_PER_GB;
  const compute = costs.webServiceMonthly;
  const database = costs.postgresMonthly;
  const storage = storageGbMonth * costs.objectStoragePerGbMonth;
  const egress = egressGb * costs.egressPerGb;
  const ai = (summary.counters.ai_units ?? 0) * costs.aiCostPerUnit;
  const api = ((summary.counters.api_requests ?? 0) / 1_000_000) * costs.perMillionApiRequests;
  const overhead = costs.overheadMonthly;
  const total = compute + database + storage + egress + ai + api + overhead;
  return { compute: round2(compute), database: round2(database), storage: round2(storage), egress: round2(egress), ai: round2(ai), api: round2(api), overhead: round2(overhead), total: round2(total) };
}

export function computeCostRecovery(
  summary: UsageSummary,
  planRevenue: number,
  overage: OverageStatement,
  costs: RenderCostAssumptions,
  currency: string,
): CostRecovery {
  const infra = estimateInfraCost(summary, costs);
  const totalRevenue = planRevenue + overage.total;
  const margin = totalRevenue - infra.total;
  return {
    organizationId: summary.organizationId,
    period: summary.period,
    currency,
    planRevenue: round2(planRevenue),
    overageRevenue: round2(overage.total),
    totalRevenue: round2(totalRevenue),
    infraCost: infra.total,
    margin: round2(margin),
    marginPct: totalRevenue > 0 ? round2((margin / totalRevenue) * 100) : 0,
  };
}

/* ── Daily rollups (charts) ───────────────────────────────────────────────── */

export function dailyCounterRollup(events: UsageEvent[], organizationId: string, period: string, metric: UsageMetric): { day: string; value: number }[] {
  const byDay = new Map<string, number>();
  for (const e of events) {
    if (e.organizationId === organizationId && e.period === period && e.metric === metric) {
      byDay.set(e.day, (byDay.get(e.day) ?? 0) + e.quantity);
    }
  }
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, value]) => ({ day, value }));
}

/* ── Utils ────────────────────────────────────────────────────────────────── */

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function gbLabel(bytes: number): string {
  return `${round2(bytes / BYTES_PER_GB)} GB`;
}

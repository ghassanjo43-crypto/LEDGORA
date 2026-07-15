import { describe, it, expect } from 'vitest';
import type { OrganizationBundles, PlanAllowances, UsageEvent } from '@/types/metering';
import {
  averageDailyStorageBytes,
  buildAllowanceLines,
  computeCostRecovery,
  computeOverage,
  estimateInfraCost,
  summarizeUsage,
  thresholdBand,
  BANDWIDTH_METRICS,
} from '@/lib/meteringCalculations';
import { BYTES_PER_GB, SEED_OVERAGE_RATES, SEED_RENDER_COSTS, makeSeedBasePlans } from '@/lib/meteringSeed';

const PERIOD = '2026-07';
const ORG = 'primary';
const rates = SEED_OVERAGE_RATES;
const noBundles: OrganizationBundles = { storageGb: 0, bandwidthGb: 0 };
const thresholds = [70, 85, 100, 120];

function ev(metric: UsageEvent['metric'], quantity: number, day: string, source = 'test'): UsageEvent {
  return { id: `e_${Math.random()}`, organizationId: ORG, metric, quantity, at: `${day}T00:00:00.000Z`, day, period: day.slice(0, 7), source, actor: 'tester', kind: 'usage' };
}

const coreAllow: PlanAllowances = makeSeedBasePlans()[0]!.allowances;

/* ── Upload is storage, not bandwidth ─────────────────────────────────────── */

describe('upload vs bandwidth rule', () => {
  it('an upload consumes storage + a file count but NEVER outbound bandwidth', () => {
    const events = [
      ev('storage_bytes', 2 * BYTES_PER_GB, `${PERIOD}-01`, 'upload'),
      ev('uploaded_files', 1, `${PERIOD}-01`, 'upload'),
    ];
    const summary = summarizeUsage(events, [], ORG, PERIOD, { users: 1, companies: 1 }, `${PERIOD}-31`);
    expect(summary.outboundBandwidthBytes).toBe(0); // uploads are not bandwidth
    expect(summary.counters.uploaded_files).toBe(1);
    expect(summary.averageStorageBytes).toBeGreaterThan(0);
  });

  it('downloads and API responses ARE outbound bandwidth', () => {
    const events = [
      ev('outbound_download_bytes', 3 * BYTES_PER_GB, `${PERIOD}-02`),
      ev('api_outbound_bytes', 1 * BYTES_PER_GB, `${PERIOD}-02`),
    ];
    const summary = summarizeUsage(events, [], ORG, PERIOD, { users: 1, companies: 1 }, `${PERIOD}-31`);
    expect(summary.outboundBandwidthBytes).toBe(4 * BYTES_PER_GB);
    expect(BANDWIDTH_METRICS).toContain('outbound_download_bytes');
    expect(BANDWIDTH_METRICS).not.toContain('uploaded_files');
  });
});

/* ── Average daily storage ────────────────────────────────────────────────── */

describe('average daily storage', () => {
  it('averages the daily level across the elapsed period', () => {
    // 10 GB uploaded on day 1, present for 10 days → average over 10 days = 10 GB
    const events = [ev('storage_bytes', 10 * BYTES_PER_GB, `${PERIOD}-01`)];
    const avg = averageDailyStorageBytes(events.map((e) => ({ day: e.day, quantity: e.quantity })), PERIOD, `${PERIOD}-10`);
    expect(avg).toBe(10 * BYTES_PER_GB);
  });

  it('reflects a mid-period increase in the average', () => {
    // 0 for days 1-5, then +10 GB on day 6 through day 10 → avg = (5*0 + 5*10)/10 = 5 GB
    const events = [ev('storage_bytes', 10 * BYTES_PER_GB, `${PERIOD}-06`)];
    const avg = averageDailyStorageBytes(events.map((e) => ({ day: e.day, quantity: e.quantity })), PERIOD, `${PERIOD}-10`);
    expect(avg).toBe(5 * BYTES_PER_GB);
  });

  it('carries storage from before the period as a baseline', () => {
    const events = [ev('storage_bytes', 4 * BYTES_PER_GB, '2026-06-15')]; // prior month
    const avg = averageDailyStorageBytes(events.map((e) => ({ day: e.day, quantity: e.quantity })), PERIOD, `${PERIOD}-05`);
    expect(avg).toBe(4 * BYTES_PER_GB);
  });
});

/* ── Overage + bundles ────────────────────────────────────────────────────── */

describe('overage with bundles', () => {
  it('bills storage, bandwidth, users, companies, JE blocks and API blocks over allowance', () => {
    const events = [
      ev('storage_bytes', 8 * BYTES_PER_GB, `${PERIOD}-01`), // avg 8 GB, allowance 5 → 3 over
      ev('outbound_download_bytes', 30 * BYTES_PER_GB, `${PERIOD}-01`), // 30 GB, allowance 25 → 5 over
      ev('journal_entries', 17_000, `${PERIOD}-01`), // allowance 5,000 → 12,000 over → 2 blocks
      ev('api_requests', 260_000, `${PERIOD}-01`), // allowance 50,000 → 210,000 over → 3 blocks
    ];
    const summary = summarizeUsage(events, [], ORG, PERIOD, { users: 5, companies: 3 }, `${PERIOD}-31`);
    const st = computeOverage(summary, coreAllow, noBundles, rates, 'USD');
    const amount = (m: string) => st.lines.find((l) => l.metric === m)?.amount ?? 0;
    expect(amount('storage_bytes')).toBeCloseTo(3 * 0.75, 2);
    expect(amount('outbound_download_bytes')).toBeCloseTo(5 * 0.45, 2);
    expect(amount('users')).toBe((5 - 3) * 6);
    expect(amount('companies')).toBe((3 - 1) * 20);
    expect(amount('journal_entries')).toBe(2 * 5);
    expect(amount('api_requests')).toBe(3 * 5);
    expect(st.total).toBeGreaterThan(0);
  });

  it('prepaid bundles raise the effective allowance before overage', () => {
    const events = [ev('storage_bytes', 8 * BYTES_PER_GB, `${PERIOD}-01`)]; // 8 GB, allowance 5
    const withBundle: OrganizationBundles = { storageGb: 10, bandwidthGb: 0 }; // 5 + 10 = 15 allowance
    const summary = summarizeUsage(events, [], ORG, PERIOD, { users: 1, companies: 1 }, `${PERIOD}-31`);
    const st = computeOverage(summary, coreAllow, withBundle, rates, 'USD');
    expect(st.lines.find((l) => l.metric === 'storage_bytes')).toBeUndefined(); // no overage
  });
});

/* ── Thresholds ───────────────────────────────────────────────────────────── */

describe('warning thresholds', () => {
  it('classifies 70 / 85 / 100 / 120 bands', () => {
    expect(thresholdBand(50, thresholds)).toBe('ok');
    expect(thresholdBand(72, thresholds)).toBe('warn70');
    expect(thresholdBand(90, thresholds)).toBe('warn85');
    expect(thresholdBand(105, thresholds)).toBe('over100');
    expect(thresholdBand(130, thresholds)).toBe('critical120');
  });

  it('surfaces bands on allowance lines', () => {
    const events = [ev('journal_entries', 4_000, `${PERIOD}-01`)]; // 80% of 5,000
    const summary = summarizeUsage(events, [], ORG, PERIOD, { users: 1, companies: 1 }, `${PERIOD}-31`);
    const lines = buildAllowanceLines(summary, coreAllow, noBundles, rates, thresholds, 'USD');
    const je = lines.find((l) => l.metric === 'journal_entries')!;
    expect(je.band).toBe('warn70');
    expect(Math.round(je.pct)).toBe(80);
  });
});

/* ── Cost recovery ────────────────────────────────────────────────────────── */

describe('infrastructure cost & recovery', () => {
  it('estimates infra cost from usage and computes margin', () => {
    const events = [
      ev('storage_bytes', 100 * BYTES_PER_GB, `${PERIOD}-01`),
      ev('outbound_download_bytes', 50 * BYTES_PER_GB, `${PERIOD}-01`),
      ev('ai_units', 10_000, `${PERIOD}-01`),
    ];
    const summary = summarizeUsage(events, [], ORG, PERIOD, { users: 1, companies: 1 }, `${PERIOD}-31`);
    const infra = estimateInfraCost(summary, SEED_RENDER_COSTS);
    expect(infra.total).toBeGreaterThan(SEED_RENDER_COSTS.webServiceMonthly);
    const overage = computeOverage(summary, coreAllow, noBundles, rates, 'USD');
    const recovery = computeCostRecovery(summary, 39, overage, SEED_RENDER_COSTS, 'USD');
    expect(recovery.totalRevenue).toBe(39 + overage.total);
    expect(recovery.margin).toBe(recovery.totalRevenue - infra.total);
  });
});

/* ── Adjustments fold into billed totals ──────────────────────────────────── */

describe('closed-period adjustments', () => {
  it('adjustment entries change the billed total without touching raw events', () => {
    const events = [ev('journal_entries', 10_000, `${PERIOD}-01`)];
    const base = summarizeUsage(events, [], ORG, PERIOD, { users: 1, companies: 1 }, `${PERIOD}-31`);
    const adjusted = summarizeUsage(events, [{ id: 'a1', metric: 'journal_entries', quantity: 2_000, reason: 'missed batch', at: '', actor: 'admin' }], ORG, PERIOD, { users: 1, companies: 1 }, `${PERIOD}-31`);
    expect(base.counters.journal_entries).toBe(10_000);
    expect(adjusted.counters.journal_entries).toBe(12_000);
    // raw events are unchanged
    expect(events[0]!.quantity).toBe(10_000);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { useUsageStore } from './usageStore';
import { useMeteringConfigStore } from './meteringConfigStore';
import { useSessionStore } from './sessionStore';
import { periodKeyOf, summarizeUsage } from '@/lib/meteringCalculations';
import { BYTES_PER_GB } from '@/lib/meteringSeed';

const usage = () => useUsageStore.getState();
const cfg = () => useMeteringConfigStore.getState();
const thisPeriod = () => periodKeyOf(new Date().toISOString());

beforeEach(() => {
  useUsageStore.getState().resetToDefault();
  useMeteringConfigStore.getState().resetToDefault();
  useSessionStore.setState({ role: 'admin', userName: 'Finance Manager' });
});

/* ── Recording usage ──────────────────────────────────────────────────────── */

describe('usage recording', () => {
  it('records an upload as storage + a file, never as bandwidth, storing only metadata', () => {
    const res = usage().recordUpload({ fileName: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: 500_000_000, storageKey: 'obj://demo/invoice.pdf' });
    expect(res.ok).toBe(true);
    const doc = usage().documents.find((d) => d.id === res.id)!;
    expect(doc.storageKey).toBe('obj://demo/invoice.pdf');
    expect((doc as unknown as Record<string, unknown>).binary).toBeUndefined(); // no binary stored
    const storageEvents = usage().events.filter((e) => e.metric === 'storage_bytes');
    const bandwidthEvents = usage().events.filter((e) => e.metric === 'outbound_download_bytes');
    expect(storageEvents.length).toBe(1);
    expect(bandwidthEvents.length).toBe(0);
  });

  it('records a download as outbound bandwidth', () => {
    usage().recordDownload(250_000_000);
    expect(usage().events.some((e) => e.metric === 'outbound_download_bytes')).toBe(true);
  });

  it('deleting a document releases storage via a negative delta event', () => {
    const up = usage().recordUpload({ fileName: 'x', contentType: 'image/png', sizeBytes: BYTES_PER_GB, storageKey: 'k' });
    usage().deleteDocument(up.id!);
    const deltas = usage().events.filter((e) => e.metric === 'storage_bytes');
    expect(deltas.reduce((s, e) => s + e.quantity, 0)).toBe(0); // net zero after delete
    expect(usage().documents.find((d) => d.id === up.id)!.status).toBe('deleted');
  });
});

/* ── Immutable closed periods + adjustments ───────────────────────────────── */

describe('immutable usage ledger', () => {
  it('freezes a period on close and blocks new events; corrections go through adjustments', () => {
    usage().recordJournalEntry(5000);
    const period = thisPeriod();
    const res = usage().closePeriod(period);
    expect(res.ok).toBe(true);
    expect(usage().isPeriodClosed(period)).toBe(true);
    // new usage into a closed period is rejected
    const blocked = usage().recordJournalEntry(1);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/closed/i);
    // snapshot is frozen
    const snap = usage().periods.find((p) => p.period === period)!.summarySnapshot!;
    expect(snap.counters.journal_entries).toBe(5000);
    // correction recorded as an adjustment (snapshot unchanged)
    const adj = usage().recordAdjustment(period, 'journal_entries', 250, 'late batch');
    expect(adj.ok).toBe(true);
    const p = usage().periods.find((x) => x.period === period)!;
    expect(p.summarySnapshot!.counters.journal_entries).toBe(5000); // raw snapshot immutable
    expect(p.adjustments[0]!.quantity).toBe(250);
  });

  it('requires an administrator to close periods and record adjustments', () => {
    useSessionStore.setState({ role: 'member' });
    expect(usage().closePeriod(thisPeriod()).ok).toBe(false);
    expect(usage().recordAdjustment(thisPeriod(), 'invoices', 1, 'x').ok).toBe(false);
  });

  it('billed totals include adjustments while raw events stay intact', () => {
    usage().recordJournalEntry(10_000);
    const period = thisPeriod();
    const p = usage().periods.find((x) => x.period === period);
    // summarize with the period's adjustments folded in
    usage().closePeriod(period);
    usage().recordAdjustment(period, 'journal_entries', 2_000, 'correction');
    const withAdj = summarizeUsage(usage().events, usage().periods.find((x) => x.period === period)!.adjustments, 'primary', period, { users: 1, companies: 1 }, `${period}-31`);
    expect(withAdj.counters.journal_entries).toBe(12_000);
    expect(p).toBeUndefined(); // no period existed before close
  });
});

/* ── Super-admin config editability + permissions ─────────────────────────── */

describe('metering configuration', () => {
  it('seeds the four base plans at the required prices and the exact overage rates', () => {
    const byCode = Object.fromEntries(cfg().config.basePlans.map((p) => [p.code, p.priceMonthly]));
    expect(byCode).toMatchObject({ core: 39, professional: 89, business: 179, enterprise: 499 });
    const r = cfg().config.overageRates;
    expect(r.storagePerGbMonth).toBe(0.75);
    expect(r.bandwidthPerGb).toBe(0.45);
    expect(r.extraUserMonth).toBe(6);
    expect(r.extraCompanyMonth).toBe(20);
    expect(r.journalEntriesBlock).toBe(10_000);
    expect(r.journalEntriesBlockPrice).toBe(5);
    expect(r.apiRequestsBlock).toBe(100_000);
    expect(r.apiRequestsBlockPrice).toBe(5);
  });

  it('offers the six optional modules', () => {
    const codes = cfg().config.optionalModules.map((m) => m.code).sort();
    expect(codes).toEqual(['advanced_inventory', 'ai', 'consolidation', 'construction', 'manufacturing', 'projects']);
  });

  it('lets the super administrator edit prices, allowances and rates', () => {
    const coreId = cfg().config.basePlans.find((p) => p.code === 'core')!.id;
    expect(cfg().updateBasePlan(coreId, { priceMonthly: 49, allowances: { ...cfg().config.basePlans[0]!.allowances, storageGb: 20 } }).ok).toBe(true);
    const core = cfg().config.basePlans.find((p) => p.code === 'core')!;
    expect(core.priceMonthly).toBe(49);
    expect(core.allowances.storageGb).toBe(20);
    expect(cfg().updateOverageRates({ storagePerGbMonth: 0.9 }).ok).toBe(true);
    expect(cfg().config.overageRates.storagePerGbMonth).toBe(0.9);
    expect(cfg().updateRenderCosts({ egressPerGb: 0.2 }).ok).toBe(true);
    expect(cfg().config.renderCosts.egressPerGb).toBe(0.2);
    expect(cfg().updateThresholds([60, 80, 100, 130]).ok).toBe(true);
    expect(cfg().config.thresholds).toEqual([60, 80, 100, 130]);
  });

  it('blocks non-super-admins from editing configuration', () => {
    useSessionStore.setState({ role: 'member' });
    const coreId = cfg().config.basePlans.find((p) => p.code === 'core')!.id;
    expect(cfg().updateBasePlan(coreId, { priceMonthly: 1 }).ok).toBe(false);
    expect(cfg().updateOverageRates({ storagePerGbMonth: 9 }).ok).toBe(false);
    expect(cfg().updateRenderCosts({ egressPerGb: 9 }).ok).toBe(false);
  });

  it('purchasing a bundle raises the effective allowance', () => {
    cfg().purchaseBundle('storage', 50);
    expect(cfg().orgBundles.storageGb).toBe(50);
  });
});

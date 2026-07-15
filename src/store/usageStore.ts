/**
 * Append-only usage ledger + document metadata + monthly usage periods.
 *
 *  - Usage events are immutable. Uploads add STORAGE + a file count (never
 *    outbound bandwidth); downloads and API responses add outbound bandwidth.
 *  - Document BINARIES are never stored — only metadata + an object-storage key.
 *  - Once a monthly period is CLOSED the raw events are frozen; corrections are
 *    recorded as adjustment entries, never by editing closed records.
 *
 * Persisted under `ledgora-usage`.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  DocumentMeta,
  MeteringAuditEntry,
  MeteringAuditEvent,
  MonthlyUsagePeriod,
  UsageEvent,
  UsageMetric,
  UsageSummary,
} from '@/types/metering';
import { useCompanyStore } from './companyStore';
import { getCurrentRole, getCurrentUserName } from './sessionStore';
import { assertCanClosePeriods } from '@/lib/meteringPermissions';
import { dayKeyOf, periodKeyOf, summarizeUsage } from '@/lib/meteringCalculations';
import { generateId, nowIso } from '@/lib/utils';

const ORG = 'primary';

export interface UsageActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

function audit(event: MeteringAuditEvent, detail: string, period?: string): MeteringAuditEntry {
  return { id: generateId('uau'), event, at: nowIso(), actor: getCurrentUserName(), detail, period };
}

interface UsageState {
  events: UsageEvent[];
  documents: DocumentMeta[];
  periods: MonthlyUsagePeriod[];
  auditTrail: MeteringAuditEntry[];
  /** Current seat count (gauge). Companies are derived from the company store. */
  userSeats: number;

  setUserSeats: (n: number) => void;

  recordEvent: (metric: UsageMetric, quantity: number, opts?: { source?: string; refId?: string; note?: string }) => UsageActionResult;
  recordUpload: (file: { fileName: string; contentType: string; sizeBytes: number; storageKey: string; checksum?: string }) => UsageActionResult;
  deleteDocument: (documentId: string) => UsageActionResult;
  recordDownload: (bytes: number, opts?: { documentId?: string; source?: string }) => UsageActionResult;
  recordApiOutbound: (bytes: number) => UsageActionResult;
  recordReportExport: (bytes?: number) => UsageActionResult;
  recordJournalEntry: (n?: number) => UsageActionResult;
  recordInvoice: (n?: number) => UsageActionResult;
  recordApiRequest: (n?: number) => UsageActionResult;
  recordAiUnits: (n: number) => UsageActionResult;

  isPeriodClosed: (period: string) => boolean;
  closePeriod: (period: string) => UsageActionResult;
  reopenPeriod: (period: string) => UsageActionResult;
  recordAdjustment: (period: string, metric: UsageMetric, quantity: number, reason: string) => UsageActionResult;

  currentCompanies: () => number;
  resetToDefault: () => void;
}

function buildEvent(metric: UsageMetric, quantity: number, extra?: { source?: string; refId?: string; note?: string }): UsageEvent {
  const at = nowIso();
  return {
    id: generateId('use'),
    organizationId: ORG,
    metric,
    quantity,
    at,
    day: dayKeyOf(at),
    period: periodKeyOf(at),
    source: extra?.source ?? 'system',
    refId: extra?.refId,
    note: extra?.note,
    actor: getCurrentUserName(),
    kind: 'usage',
  };
}

export const useUsageStore = create<UsageState>()(
  persist(
    (set, get) => ({
      events: [],
      documents: [],
      periods: [],
      auditTrail: [],
      userSeats: 1,

      setUserSeats: (n) => set({ userSeats: Math.max(0, Math.floor(n)) }),

      recordEvent: (metric, quantity, opts) => {
        const period = periodKeyOf(nowIso());
        if (get().isPeriodClosed(period)) {
          return { ok: false, error: 'This billing period is closed. Record a correction as an adjustment entry.' };
        }
        const event = buildEvent(metric, quantity, opts);
        set((s) => ({ events: [...s.events, event] }));
        return { ok: true, id: event.id };
      },

      recordUpload: (file) => {
        // Uploads consume STORAGE + a file count — NOT outbound bandwidth.
        const period = periodKeyOf(nowIso());
        if (get().isPeriodClosed(period)) return { ok: false, error: 'Billing period is closed.' };
        const doc: DocumentMeta = {
          id: generateId('doc'),
          organizationId: ORG,
          fileName: file.fileName,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
          storageKey: file.storageKey,
          checksum: file.checksum,
          uploadedAt: nowIso(),
          uploadedBy: getCurrentUserName(),
          status: 'active',
        };
        const storageEvent = buildEvent('storage_bytes', file.sizeBytes, { source: 'upload', refId: doc.id });
        const fileEvent = buildEvent('uploaded_files', 1, { source: 'upload', refId: doc.id });
        set((s) => ({ documents: [...s.documents, doc], events: [...s.events, storageEvent, fileEvent] }));
        return { ok: true, id: doc.id };
      },

      deleteDocument: (documentId) => {
        const doc = get().documents.find((d) => d.id === documentId);
        if (!doc || doc.status === 'deleted') return { ok: false, error: 'Document not found.' };
        const delta = buildEvent('storage_bytes', -doc.sizeBytes, { source: 'delete', refId: documentId });
        set((s) => ({
          documents: s.documents.map((d) => (d.id === documentId ? { ...d, status: 'deleted' } : d)),
          events: [...s.events, delta],
        }));
        return { ok: true };
      },

      recordDownload: (bytes, opts) => get().recordEvent('outbound_download_bytes', Math.max(0, bytes), { source: opts?.source ?? 'download', refId: opts?.documentId }),
      recordApiOutbound: (bytes) => get().recordEvent('api_outbound_bytes', Math.max(0, bytes), { source: 'api' }),
      recordReportExport: (bytes) => {
        const a = get().recordEvent('report_exports', 1, { source: 'report' });
        if (bytes && bytes > 0) get().recordEvent('outbound_download_bytes', bytes, { source: 'report-download' });
        return a;
      },
      recordJournalEntry: (n = 1) => get().recordEvent('journal_entries', n, { source: 'journal' }),
      recordInvoice: (n = 1) => get().recordEvent('invoices', n, { source: 'invoice' }),
      recordApiRequest: (n = 1) => get().recordEvent('api_requests', n, { source: 'api' }),
      recordAiUnits: (n) => get().recordEvent('ai_units', Math.max(0, n), { source: 'ai' }),

      isPeriodClosed: (period) => get().periods.some((p) => p.period === period && p.status === 'closed'),

      currentCompanies: () => {
        try {
          return useCompanyStore.getState().companies.length || 1;
        } catch {
          return 1;
        }
      },

      closePeriod: (period) => {
        const perm = assertCanClosePeriods(getCurrentRole());
        if (!perm.ok) return { ok: false, error: perm.error };
        if (get().isPeriodClosed(period)) return { ok: false, error: 'Period is already closed.' };
        const lastDay = `${period}-${String(new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;
        const today = dayKeyOf(nowIso());
        const asOf = today < lastDay ? today : lastDay;
        const summary: UsageSummary = summarizeUsage(get().events, [], ORG, period, { users: get().userSeats, companies: get().currentCompanies() }, asOf);
        const existing = get().periods.find((p) => p.period === period);
        const periodRecord: MonthlyUsagePeriod = existing
          ? { ...existing, status: 'closed', closedAt: nowIso(), closedBy: getCurrentUserName(), summarySnapshot: summary }
          : { organizationId: ORG, period, status: 'closed', closedAt: nowIso(), closedBy: getCurrentUserName(), summarySnapshot: summary, adjustments: [] };
        set((s) => ({
          periods: existing ? s.periods.map((p) => (p.period === period ? periodRecord : p)) : [...s.periods, periodRecord],
          auditTrail: [...s.auditTrail, audit('period-closed', `Usage period ${period} closed and frozen.`, period)],
        }));
        return { ok: true };
      },

      reopenPeriod: (period) => {
        const perm = assertCanClosePeriods(getCurrentRole());
        if (!perm.ok) return { ok: false, error: perm.error };
        set((s) => ({
          periods: s.periods.map((p) => (p.period === period ? { ...p, status: 'open', closedAt: undefined } : p)),
          auditTrail: [...s.auditTrail, audit('period-reopened', `Usage period ${period} reopened by administrator.`, period)],
        }));
        return { ok: true };
      },

      recordAdjustment: (period, metric, quantity, reason) => {
        const perm = assertCanClosePeriods(getCurrentRole());
        if (!perm.ok) return { ok: false, error: perm.error };
        if (!reason.trim()) return { ok: false, error: 'An adjustment reason is required.' };
        const adjustment = { id: generateId('adj'), metric, quantity, reason: reason.trim(), at: nowIso(), actor: getCurrentUserName() };
        const existing = get().periods.find((p) => p.period === period);
        const record: MonthlyUsagePeriod = existing
          ? { ...existing, adjustments: [...existing.adjustments, adjustment] }
          : { organizationId: ORG, period, status: 'open', adjustments: [adjustment] };
        set((s) => ({
          periods: existing ? s.periods.map((p) => (p.period === period ? record : p)) : [...s.periods, record],
          auditTrail: [...s.auditTrail, audit('adjustment-recorded', `Adjustment on ${period}: ${metric} ${quantity > 0 ? '+' : ''}${quantity} (${reason.trim()}).`, period)],
        }));
        return { ok: true, id: adjustment.id };
      },

      resetToDefault: () => set({ events: [], documents: [], periods: [], auditTrail: [], userSeats: 1 }),
    }),
    {
      name: 'ledgora-usage',
      version: 1,
      partialize: (s) => ({ events: s.events, documents: s.documents, periods: s.periods, auditTrail: s.auditTrail, userSeats: s.userSeats }),
    },
  ),
);

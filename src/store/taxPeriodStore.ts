import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type { TaxPeriod, TaxPeriodAuditEvent, TaxPeriodStatus } from '@/types/taxReporting';
import { generateId, nowIso } from '@/lib/utils';

const ACTOR = 'Finance Manager';

export interface TaxPeriodActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

function audit(action: string, detail?: string): TaxPeriodAuditEvent {
  return { id: generateId('tpaud'), at: nowIso(), action, detail, by: ACTOR };
}

/** How a date sits relative to the tax period locks for an entity/jurisdiction. */
export interface PeriodPostingCheck {
  allowed: boolean;
  requiresWarning: boolean;
  blocked: boolean;
  period?: TaxPeriod;
  reason?: string;
}

interface TaxPeriodState {
  periods: TaxPeriod[];

  getPeriodForDate: (entityId: string, jurisdictionId: string, date: string) => TaxPeriod | undefined;
  checkPosting: (entityId: string, jurisdictionId: string, date: string) => PeriodPostingCheck;

  createPeriod: (input: { entityId: string; jurisdictionId: string; periodStart: string; periodEnd: string; filingDueDate?: string }) => TaxPeriodActionResult;
  setStatus: (id: string, status: TaxPeriodStatus, detail?: string) => TaxPeriodActionResult;
  filePeriod: (id: string, reference?: string) => TaxPeriodActionResult;
  lockPeriod: (id: string) => TaxPeriodActionResult;
  reopenPeriod: (id: string, reason: string) => TaxPeriodActionResult;

  replaceAll: (periods: TaxPeriod[]) => void;
  resetToDefault: () => void;
}

export const useTaxPeriodStore = create<TaxPeriodState>()(
  persist(
    (set, get) => ({
      periods: [],

      getPeriodForDate: (entityId, jurisdictionId, date) =>
        get().periods.find((p) => p.entityId === entityId && p.jurisdictionId === jurisdictionId && date >= p.periodStart && date <= p.periodEnd),

      checkPosting: (entityId, jurisdictionId, date) => {
        const period = get().getPeriodForDate(entityId, jurisdictionId, date);
        if (!period) return { allowed: true, requiresWarning: false, blocked: false };
        if (period.status === 'filed' || period.status === 'locked') {
          return { allowed: false, requiresWarning: false, blocked: true, period, reason: `Tax period ${period.periodStart}–${period.periodEnd} is ${period.status}. Posting requires reopening or an adjustment period.` };
        }
        if (period.status === 'prepared') return { allowed: true, requiresWarning: true, blocked: false, period, reason: 'This tax period is prepared for filing — changes may affect the return.' };
        return { allowed: true, requiresWarning: false, blocked: false, period };
      },

      createPeriod: (input) => {
        const overlap = get().periods.find((p) => p.entityId === input.entityId && p.jurisdictionId === input.jurisdictionId && input.periodStart <= p.periodEnd && p.periodStart <= input.periodEnd);
        if (overlap) return { ok: false, error: 'Tax periods for an entity/jurisdiction cannot overlap.' };
        const now = nowIso();
        const period: TaxPeriod = {
          id: generateId('txp'), entityId: input.entityId, jurisdictionId: input.jurisdictionId,
          periodStart: input.periodStart, periodEnd: input.periodEnd, filingDueDate: input.filingDueDate,
          status: 'open', auditTrail: [audit('period-created')], createdAt: now, updatedAt: now,
        };
        set({ periods: [...get().periods, period] });
        return { ok: true, id: period.id };
      },

      setStatus: (id, status, detail) => {
        const { periods } = get();
        const p = periods.find((x) => x.id === id);
        if (!p) return { ok: false, error: 'Tax period not found.' };
        set({ periods: periods.map((x) => (x.id === id ? { ...x, status, auditTrail: [...x.auditTrail, audit(`period-${status}`, detail)], updatedAt: nowIso() } : x)) });
        return { ok: true, id };
      },

      filePeriod: (id, reference) => {
        const { periods } = get();
        const p = periods.find((x) => x.id === id);
        if (!p) return { ok: false, error: 'Tax period not found.' };
        if (p.status === 'locked') return { ok: false, error: 'A locked period is already closed.' };
        const now = nowIso();
        set({ periods: periods.map((x) => (x.id === id ? { ...x, status: 'filed', filedAt: now, filedReference: reference, auditTrail: [...x.auditTrail, audit('period-filed', reference)], updatedAt: now } : x)) });
        return { ok: true, id };
      },

      lockPeriod: (id) => get().setStatus(id, 'locked'),

      reopenPeriod: (id, reason) => {
        const { periods } = get();
        const p = periods.find((x) => x.id === id);
        if (!p) return { ok: false, error: 'Tax period not found.' };
        if (p.status !== 'filed' && p.status !== 'locked') return { ok: false, error: 'Only a filed or locked period can be reopened.' };
        if (!reason.trim()) return { ok: false, error: 'A reason is required to reopen a tax period.' };
        set({ periods: periods.map((x) => (x.id === id ? { ...x, status: 'reopened', auditTrail: [...x.auditTrail, audit('period-reopened', reason.trim())], updatedAt: nowIso() } : x)) });
        return { ok: true, id };
      },

      replaceAll: (periods) => set({ periods }),
      resetToDefault: () => set({ periods: [] }),
    }),
    { name: 'ledgerly-tax-periods', storage: businessJSONStorage, version: 1 },
  ),
);

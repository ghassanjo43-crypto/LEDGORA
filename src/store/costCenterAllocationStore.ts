import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Account } from '@/types';
import type { CostCenterAllocationRule, CostCenterAllocationRun } from '@/types/costCenterAllocation';
import { buildCostCenterAllocationRun, buildCostCenterAllocationJournal } from '@/lib/costCenterAllocationPosting';
import { costCenterActuals } from '@/lib/costCenterReporting';
import { generateId, nowIso } from '@/lib/utils';
import { PRIMARY_ENTITY_ID } from '@/data/costCenterSeed';
import { useStore } from './useStore';
import { useJournalStore } from './journalStore';

export interface AllocationActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

function accountsById(): Map<string, Account> {
  return new Map(useStore.getState().accounts.map((a) => [a.id, a]));
}
function audit(action: string, detail?: string) {
  return { id: generateId('araud'), at: nowIso(), action, detail };
}

interface AllocationState {
  rules: CostCenterAllocationRule[];
  runs: CostCenterAllocationRun[];

  getRule: (id: string) => CostCenterAllocationRule | undefined;
  getRun: (id: string) => CostCenterAllocationRun | undefined;

  createRule: (patch?: Partial<CostCenterAllocationRule>) => AllocationActionResult;
  updateRule: (id: string, patch: Partial<CostCenterAllocationRule>) => AllocationActionResult;

  buildRun: (ruleId: string, input: { periodStart: string; periodEnd: string; postingDate: string; sourceAmountOverride?: number }) => AllocationActionResult;
  postRun: (id: string) => AllocationActionResult;
  reverseRun: (id: string, reason: string) => AllocationActionResult;
  deleteDraft: (id: string) => AllocationActionResult;

  replaceAll: (state: Partial<Pick<AllocationState, 'rules' | 'runs'>>) => void;
  resetToDefault: () => void;
}

export const useCostCenterAllocationStore = create<AllocationState>()(
  persist(
    (set, get) => ({
      rules: [],
      runs: [],

      getRule: (id) => get().rules.find((r) => r.id === id),
      getRun: (id) => get().runs.find((r) => r.id === id),

      createRule: (patch) => {
        const now = nowIso();
        const rule: CostCenterAllocationRule = {
          id: generateId('ccar'), entityId: PRIMARY_ENTITY_ID, code: patch?.code ?? '', name: patch?.name ?? '', status: patch?.status ?? 'draft',
          method: patch?.method ?? 'percentage', targets: patch?.targets ?? [], frequency: patch?.frequency ?? 'manual', effectiveFrom: patch?.effectiveFrom ?? now.slice(0, 10),
          sourceCostCenterId: patch?.sourceCostCenterId, sourceAccountIds: patch?.sourceAccountIds, allocationAccountId: patch?.allocationAccountId, clearingAccountId: patch?.clearingAccountId,
          createdAt: now, updatedAt: now, ...patch,
        };
        set({ rules: [...get().rules, rule] });
        return { ok: true, id: rule.id };
      },

      updateRule: (id, patch) => {
        const { rules } = get();
        if (!rules.some((r) => r.id === id)) return { ok: false, error: 'Allocation rule not found.' };
        set({ rules: rules.map((r) => (r.id === id ? { ...r, ...patch, updatedAt: nowIso() } : r)) });
        return { ok: true, id };
      },

      buildRun: (ruleId, input) => {
        const rule = get().rules.find((r) => r.id === ruleId);
        if (!rule) return { ok: false, error: 'Allocation rule not found.' };
        if (rule.targets.length === 0) return { ok: false, error: 'The rule has no target cost centers.' };

        // Source amount: measured posted balance on the source cost center + account (unless overridden / fixed-amount).
        let sourceAmount = input.sourceAmountOverride ?? 0;
        if (input.sourceAmountOverride === undefined && rule.method !== 'fixed-amount' && rule.sourceCostCenterId && rule.allocationAccountId) {
          const actuals = costCenterActuals(useJournalStore.getState().entries, accountsById(), { costCenterIds: new Set([rule.sourceCostCenterId]), from: input.periodStart, to: input.periodEnd, base: useStore.getState().settings.baseCurrency });
          const a = actuals.get(rule.allocationAccountId);
          sourceAmount = a ? Math.round((a.debit - a.credit) * 100) / 100 : 0;
        }

        const built = buildCostCenterAllocationRun({ rule, sourceAmount, periodStart: input.periodStart, periodEnd: input.periodEnd, postingDate: input.postingDate });
        if (!built.ok) return { ok: false, error: built.error };
        const id = generateId('ccrun');
        set({ runs: [...get().runs, { ...built.run, id }] });
        return { ok: true, id };
      },

      postRun: (id) => {
        const { runs, rules } = get();
        const run = runs.find((r) => r.id === id);
        if (!run) return { ok: false, error: 'Allocation run not found.' };
        if (run.status === 'posted' || run.status === 'reversed') return { ok: false, error: 'This run is already posted.' };
        const rule = rules.find((r) => r.id === run.ruleId);
        if (!rule) return { ok: false, error: 'Allocation rule not found.' };
        // Block a duplicate posted run for the same rule/period.
        const dup = runs.find((r) => r.id !== id && r.status === 'posted' && r.ruleId === run.ruleId && r.periodStart === run.periodStart && r.periodEnd === run.periodEnd);
        if (dup) return { ok: false, error: `A run for ${rule.code} covering ${run.periodStart}–${run.periodEnd} is already posted. Reverse it first.` };

        const journal = useJournalStore.getState();
        const je = buildCostCenterAllocationJournal(run, rule, accountsById(), useStore.getState().settings.baseCurrency);
        const added = journal.addEntry(je);
        if (!added.ok || !added.id) return { ok: false, error: added.error ?? 'Could not create the allocation journal.' };
        const posted = journal.postEntry(added.id);
        if (!posted.ok) return { ok: false, error: posted.error ?? 'Could not post the allocation journal.' };
        const now = nowIso();
        set({ runs: runs.map((r) => (r.id === id ? { ...r, status: 'posted', journalEntryId: added.id, postedAt: now, auditTrail: [...r.auditTrail, audit('allocation-posted', added.id)], updatedAt: now } : r)) });
        return { ok: true, id };
      },

      reverseRun: (id, reason) => {
        const { runs } = get();
        const run = runs.find((r) => r.id === id);
        if (!run) return { ok: false, error: 'Allocation run not found.' };
        if (run.status !== 'posted' || !run.journalEntryId) return { ok: false, error: 'Only a posted run can be reversed.' };
        if (!reason.trim()) return { ok: false, error: 'A reversal reason is required.' };
        const reversal = useJournalStore.getState().reverseEntry(run.journalEntryId);
        if (!reversal.ok || !reversal.id) return { ok: false, error: reversal.error ?? 'Could not create the reversing journal.' };
        const now = nowIso();
        set({ runs: runs.map((r) => (r.id === id ? { ...r, status: 'reversed', reversalJournalEntryId: reversal.id, reversedAt: now, auditTrail: [...r.auditTrail, audit('allocation-reversed', reason.trim())], updatedAt: now } : r)) });
        return { ok: true, id };
      },

      deleteDraft: (id) => {
        const { runs } = get();
        const run = runs.find((r) => r.id === id);
        if (!run) return { ok: false, error: 'Allocation run not found.' };
        if (run.status === 'posted') return { ok: false, error: 'A posted run cannot be deleted — reverse it instead.' };
        set({ runs: runs.filter((r) => r.id !== id) });
        return { ok: true, id };
      },

      replaceAll: (state) => set((s) => ({ ...s, ...state })),
      resetToDefault: () => set({ rules: [], runs: [] }),
    }),
    { name: 'ledgerly-cost-center-allocations', version: 1 },
  ),
);

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Account } from '@/types';
import type { ProjectRecognitionRun, RecognitionPostingConfig } from '@/types/projectRecognition';
import { computeRecognition, recognizedRevenueToDate, buildRecognitionJournalEntry } from '@/lib/projectRevenueRecognition';
import { getPostedJournalLines, convertToBaseCurrency } from '@/lib/generalLedgerCalculations';
import { roundMoney } from '@/lib/journalValidation';
import { generateId, nowIso } from '@/lib/utils';
import { useStore } from './useStore';
import { useJournalStore } from './journalStore';
import { useProjectStore } from './projectStore';

export interface RecognitionActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

function accountsById(): Map<string, Account> {
  return new Map(useStore.getState().accounts.map((a) => [a.id, a]));
}
function byCode(code: string): string | undefined {
  return useStore.getState().accounts.find((a) => a.code === code)?.id;
}
function postingConfig(): RecognitionPostingConfig {
  return {
    revenueAccountId: byCode('4120') ?? '',
    contractAssetAccountId: byCode('1230') ?? '',
    contractLiabilityAccountId: byCode('2230') ?? '',
  };
}

/** Actual project cost in the GL up to `asOfDate` (debit − credit on COS/OPEX). */
function actualCostToDate(projectId: string, asOfDate: string, base: string): number {
  const accById = accountsById();
  let cost = 0;
  for (const { entry, line } of getPostedJournalLines(useJournalStore.getState().entries)) {
    if (line.project !== projectId || entry.entryDate > asOfDate) continue;
    const acc = accById.get(line.accountId);
    if (!acc || (acc.type !== 'COST_OF_SALES' && acc.type !== 'OPERATING_EXPENSE')) continue;
    cost += convertToBaseCurrency(Number(line.debit) || 0, entry.currency, entry.exchangeRate, base) - convertToBaseCurrency(Number(line.credit) || 0, entry.currency, entry.exchangeRate, base);
  }
  return roundMoney(cost);
}

interface RecognitionState {
  runs: ProjectRecognitionRun[];

  getRun: (id: string) => ProjectRecognitionRun | undefined;
  buildRun: (projectId: string, asOfDate: string, manualCumulative?: number) => RecognitionActionResult;
  postRun: (id: string) => RecognitionActionResult;
  reverseRun: (id: string, reason: string) => RecognitionActionResult;
  deleteDraft: (id: string) => RecognitionActionResult;

  replaceAll: (runs: ProjectRecognitionRun[]) => void;
  resetToDefault: () => void;
}

export const useProjectRecognitionStore = create<RecognitionState>()(
  persist(
    (set, get) => ({
      runs: [],

      getRun: (id) => get().runs.find((r) => r.id === id),

      buildRun: (projectId, asOfDate, manualCumulative) => {
        const project = useProjectStore.getState().getProject(projectId);
        if (!project) return { ok: false, error: 'Project not found.' };
        const base = useStore.getState().settings.baseCurrency;
        const cost = actualCostToDate(projectId, asOfDate, base);
        const recognized = recognizedRevenueToDate(useJournalStore.getState().entries, accountsById(), projectId, asOfDate, base);
        const comp = computeRecognition({ project, actualCostToDate: cost, recognizedToDate: recognized, manualCumulative });
        if (Math.abs(comp.currentPeriodAmount) < 0.005) return { ok: false, error: 'No revenue to recognise for this period (already up to date).' };
        const now = nowIso();
        const run: ProjectRecognitionRun = {
          id: generateId('rrun'), projectId, method: comp.method ?? 'invoice', asOfDate,
          revisedContractValue: comp.revisedContractValue, actualCostToDate: comp.actualCostToDate, estimatedTotalCost: comp.estimatedTotalCost,
          completionPercent: comp.completionPercent, recognizedToDate: comp.recognizedToDate, targetCumulative: comp.targetCumulative, currentPeriodAmount: comp.currentPeriodAmount,
          status: 'draft', createdAt: now, updatedAt: now,
        };
        set({ runs: [...get().runs, run] });
        return { ok: true, id: run.id };
      },

      postRun: (id) => {
        const { runs } = get();
        const run = runs.find((r) => r.id === id);
        if (!run) return { ok: false, error: 'Recognition run not found.' };
        if (run.status !== 'draft') return { ok: false, error: 'This run is already posted.' };
        const config = postingConfig();
        if (!config.revenueAccountId || !config.contractAssetAccountId || !config.contractLiabilityAccountId) return { ok: false, error: 'Contract asset/liability or revenue account is not mapped.' };
        const project = useProjectStore.getState().getProject(run.projectId);
        const journal = useJournalStore.getState();
        const je = buildRecognitionJournalEntry(run, project?.code ?? run.projectId, config, accountsById(), useStore.getState().settings.baseCurrency);
        const added = journal.addEntry(je);
        if (!added.ok || !added.id) return { ok: false, error: added.error ?? 'Could not create the recognition journal.' };
        const posted = journal.postEntry(added.id);
        if (!posted.ok) return { ok: false, error: posted.error ?? 'Could not post the recognition journal.' };
        const now = nowIso();
        set({ runs: runs.map((r) => (r.id === id ? { ...r, status: 'posted', journalEntryId: added.id, postedAt: now, updatedAt: now } : r)) });
        return { ok: true, id };
      },

      reverseRun: (id, reason) => {
        const { runs } = get();
        const run = runs.find((r) => r.id === id);
        if (!run) return { ok: false, error: 'Recognition run not found.' };
        if (run.status !== 'posted' || !run.journalEntryId) return { ok: false, error: 'Only a posted run can be reversed.' };
        if (!reason.trim()) return { ok: false, error: 'A reversal reason is required.' };
        const reversal = useJournalStore.getState().reverseEntry(run.journalEntryId);
        if (!reversal.ok || !reversal.id) return { ok: false, error: reversal.error ?? 'Could not create the reversing journal.' };
        const now = nowIso();
        set({ runs: runs.map((r) => (r.id === id ? { ...r, status: 'reversed', reversalJournalEntryId: reversal.id, reversedAt: now, updatedAt: now } : r)) });
        return { ok: true, id };
      },

      deleteDraft: (id) => {
        const { runs } = get();
        const run = runs.find((r) => r.id === id);
        if (!run) return { ok: false, error: 'Recognition run not found.' };
        if (run.status === 'posted') return { ok: false, error: 'A posted run cannot be deleted — reverse it instead.' };
        set({ runs: runs.filter((r) => r.id !== id) });
        return { ok: true, id };
      },

      replaceAll: (runs) => set({ runs }),
      resetToDefault: () => set({ runs: [] }),
    }),
    { name: 'ledgerly-project-recognition', version: 1 },
  ),
);

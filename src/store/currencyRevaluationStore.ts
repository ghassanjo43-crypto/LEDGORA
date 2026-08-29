import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type { Account } from '@/types';
import type { CurrencyRevaluationRun } from '@/types/currencyRevaluation';
import { buildCurrencyRevaluation } from '@/lib/currencyRevaluation';
import { buildRevaluationJournalEntry } from '@/lib/currencyRevaluationPosting';
import { generateId, nowIso } from '@/lib/utils';
import { useStore } from './useStore';
import { useJournalStore } from './journalStore';
import { booksAreServerAuthoritative } from '@/services/books/booksEngine';
import { postRunJournal, reverseRunJournal } from '@/services/books/runPostings';
import { useExchangeRateStore } from './exchangeRateStore';
import { useCurrencyStore } from './currencyStore';

export interface RevaluationActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

function accountsById(): Map<string, Account> {
  return new Map(useStore.getState().accounts.map((a) => [a.id, a]));
}
function audit(action: string, detail?: string) {
  return { id: generateId('raud'), at: nowIso(), action, detail };
}

interface RevaluationState {
  runs: CurrencyRevaluationRun[];

  getRun: (id: string) => CurrencyRevaluationRun | undefined;
  buildDraft: (input: { entityId?: string; revaluationDate: string; currencyCodes?: string[]; byParty?: boolean }) => RevaluationActionResult;
  reviewRun: (id: string) => RevaluationActionResult;
  /* Async: the journal travels to the server before the run may call itself
   * posted. See `services/books/runPostings`. */
  postRun: (id: string) => Promise<RevaluationActionResult>;
  reverseRun: (id: string) => Promise<RevaluationActionResult>;
  deleteDraft: (id: string) => RevaluationActionResult;

  replaceAll: (runs: CurrencyRevaluationRun[]) => void;
  resetToDefault: () => void;
}

export const useCurrencyRevaluationStore = create<RevaluationState>()(
  persist(
    (set, get) => ({
      runs: [],

      getRun: (id) => get().runs.find((r) => r.id === id),

      buildDraft: (input) => {
        const entityId = input.entityId ?? 'primary';
        const config = useCurrencyStore.getState().getConfig(entityId);
        const baseCurrency = config.baseCurrencyCode;
        const basePrecision = useCurrencyStore.getState().getCurrency(baseCurrency)?.decimalPlaces ?? 2;
        const { run, missingRates } = buildCurrencyRevaluation({
          entityId, baseCurrencyCode: baseCurrency, revaluationDate: input.revaluationDate,
          entries: useJournalStore.getState().entries, accounts: useStore.getState().accounts,
          rates: useExchangeRateStore.getState().rates, config, currencyCodes: input.currencyCodes, byParty: input.byParty, basePrecision,
        });
        if (run.lines.length === 0) {
          return { ok: false, error: missingRates.length > 0 ? `No closing rate for ${missingRates.map((m) => m.currencyCode).join(', ')}.` : 'No foreign monetary balances to revalue at this date.' };
        }
        const id = generateId('reval');
        set({ runs: [...get().runs, { ...run, id }] });
        return { ok: true, id };
      },

      reviewRun: (id) => {
        const { runs } = get();
        const run = runs.find((r) => r.id === id);
        if (!run) return { ok: false, error: 'Revaluation run not found.' };
        if (run.status !== 'draft') return { ok: false, error: 'Only a draft run can be reviewed.' };
        set({ runs: runs.map((r) => (r.id === id ? { ...r, status: 'reviewed', auditTrail: [...r.auditTrail, audit('revaluation-reviewed')], updatedAt: nowIso() } : r)) });
        return { ok: true, id };
      },

      postRun: async (id) => {
        const { runs } = get();
        const run = runs.find((r) => r.id === id);
        if (!run) return { ok: false, error: 'Revaluation run not found.' };
        if (run.status === 'posted' || run.status === 'reversed') return { ok: false, error: 'This run is already posted.' };
        // Guard against a duplicate posted run for the same scope/date.
        const dup = runs.find((r) => r.id !== id && r.status === 'posted' && r.entityId === run.entityId && r.revaluationDate === run.revaluationDate);
        if (dup) return { ok: false, error: `A revaluation is already posted for ${run.revaluationDate}. Reverse it first.` };

/*
 * The journal goes to the SERVER when the books are kept there.
 *
 * `booksAreServerAuthoritative()` decides, not a try/catch: a failure must be
 * reported, never quietly retried against browser storage. The run is marked
 * posted ONLY after the server confirms, so a run recorded as posted is always
 * a run whose journal is genuinely in the books.
 */
        const je = buildRevaluationJournalEntry(run, accountsById());

        let journalEntryId: string;
        if (booksAreServerAuthoritative()) {
          const result = await postRunJournal('currency_revaluation', run.id, je);
          if (!result.ok) return { ok: false, error: result.error };
          journalEntryId = result.journalEntryId;
        } else {
          const journal = useJournalStore.getState();
          const added = journal.addEntry(je, { inheritCurrency: true });
          if (!added.ok || !added.id) return { ok: false, error: added.error ?? 'Could not create the revaluation journal.' };
          const posted = journal.postEntry(added.id);
          if (!posted.ok) return { ok: false, error: posted.error ?? 'Could not post the revaluation journal.' };
          journalEntryId = added.id;
        }

        const now = nowIso();
        set({ runs: get().runs.map((r) => (r.id === id ? { ...r, status: 'posted', journalEntryId, postedAt: now, auditTrail: [...r.auditTrail, audit('revaluation-posted', journalEntryId)], updatedAt: now } : r)) });
        return { ok: true, id };
      },

      reverseRun: async (id) => {
        const { runs } = get();
        const run = runs.find((r) => r.id === id);
        if (!run) return { ok: false, error: 'Revaluation run not found.' };
        if (run.status !== 'posted' || !run.journalEntryId) return { ok: false, error: 'Only a posted run can be reversed.' };
        let reversalId: string;
        if (booksAreServerAuthoritative()) {
          const result = await reverseRunJournal('currency_revaluation', run.id, 'Revaluation reversed');
          if (!result.ok) return { ok: false, error: result.error };
          reversalId = result.journalEntryId;
        } else {
          const reversal = useJournalStore.getState().reverseEntry(run.journalEntryId);
          if (!reversal.ok || !reversal.id) return { ok: false, error: reversal.error ?? 'Could not create the reversing journal.' };
          reversalId = reversal.id;
        }
        const now = nowIso();
        set({ runs: get().runs.map((r) => (r.id === id ? { ...r, status: 'reversed', reversalJournalEntryId: reversalId, reversedAt: now, auditTrail: [...r.auditTrail, audit('revaluation-reversed', `reversal ${reversalId}`)], updatedAt: now } : r)) });
        return { ok: true, id };
      },

      deleteDraft: (id) => {
        const { runs } = get();
        const run = runs.find((r) => r.id === id);
        if (!run) return { ok: false, error: 'Revaluation run not found.' };
        if (run.status === 'posted') return { ok: false, error: 'A posted run cannot be deleted — reverse it instead.' };
        set({ runs: runs.filter((r) => r.id !== id) });
        return { ok: true, id };
      },

      replaceAll: (runs) => set({ runs }),
      resetToDefault: () => set({ runs: [] }),
    }),
    { name: 'ledgerly-currency-revaluations', storage: businessJSONStorage, version: 1 },
  ),
);

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { businessJSONStorage } from '@/lib/workspaceStorage';
import type { Account, BusinessEntity } from '@/types';
import type { CostCenter } from '@/types/costCenter';
import type { Project } from '@/types/project';
import type { JournalEntry, JournalLine, JournalStatus } from '@/types/journal';
import type { JournalFormValues, JournalLineFormValues } from '@/lib/journalValidation';
import { computeTotals, getPostingErrors, isBlankJournalLine } from '@/lib/journalValidation';
import { createCostCenterSnapshot } from '@/lib/costCenterSnapshots';
import { createProjectSnapshot } from '@/lib/projectSnapshots';
import { SEED_JOURNAL_ENTRIES } from '@/data/journalSeed';
import { assertSubscriptionAllowsPosting } from '@/lib/subscriptionPostingGuard';
import { getSubscriptionStatus } from './entitlementHooks';
import { useStore } from './useStore';
import { useEntityStore } from './useEntityStore';
import { useCostCenterStore } from './costCenterStore';
import { useProjectStore } from './projectStore';
import { generateId, nowIso } from '@/lib/utils';

/** Placeholder for the signed-in user until real auth exists (matches Topbar). */
const ACTOR = 'Finance Manager';

export interface JournalActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

/** Next sequential entry number, e.g. "JE-0007", based on existing entries. */
export function nextEntryNumber(entries: JournalEntry[]): string {
  let max = 0;
  for (const entry of entries) {
    const match = /^JE-(\d+)$/u.exec(entry.entryNumber.trim());
    if (match?.[1]) max = Math.max(max, Number(match[1]));
  }
  return `JE-${String(max + 1).padStart(4, '0')}`;
}

function accountsMap(): Map<string, Account> {
  return new Map(useStore.getState().accounts.map((a) => [a.id, a]));
}

function entitiesMap(): Map<string, BusinessEntity> {
  return new Map(useEntityStore.getState().entities.map((e) => [e.id, e]));
}

function costCentersMap(): Map<string, CostCenter> {
  return new Map(useCostCenterStore.getState().costCenters.map((c) => [c.id, c]));
}

function projectsMap(): Map<string, Project> {
  return new Map(useProjectStore.getState().projects.map((p) => [p.id, p]));
}

/** Fill any audit/metadata fields missing from persisted or imported data. */
function normalizeEntry(raw: unknown): JournalEntry {
  const e = raw as Partial<JournalEntry>;
  return {
    ...(e as JournalEntry),
    transactionType: e.transactionType ?? '',
    updatedBy: e.updatedBy ?? '',
    postedBy: e.postedBy ?? '',
    voidedAt: e.voidedAt ?? '',
    voidedBy: e.voidedBy ?? '',
    originalEntryId: e.originalEntryId ?? '',
    reversalEntryId: e.reversalEntryId ?? '',
  };
}

/** All non-content (identity + audit) fields needed to build an entry. */
interface EntryBase {
  id: string;
  entryNumber: string;
  status: JournalStatus;
  createdAt: string;
  updatedBy: string;
  postedAt: string;
  postedBy: string;
  approvedBy: string;
  voidedAt: string;
  voidedBy: string;
  originalEntryId: string;
  reversalEntryId: string;
  reversalReference: string;
}

/**
 * Convert one form line into a persisted {@link JournalLine}, refreshing the
 * account & entity snapshots from the live directories. Draft entries always
 * take the current names; posted entries are never rebuilt through this path.
 */
function lineFromForm(
  line: JournalLineFormValues,
  journalEntryId: string,
  lineNumber: number,
  accById: Map<string, Account>,
  entById: Map<string, BusinessEntity>,
  ccById: Map<string, CostCenter>,
  prjById: Map<string, Project>,
): JournalLine {
  const account = line.accountId ? accById.get(line.accountId) : undefined;
  const entity = line.entityId ? entById.get(line.entityId) : undefined;
  // Freeze the cost-center + project identities at posting so a later rename never
  // rewrites historical document presentation (mirrors the entity-name snapshot).
  const cc = line.costCenter ? ccById.get(line.costCenter) : undefined;
  const prj = line.project ? prjById.get(line.project) : undefined;
  return {
    id: generateId('jl'),
    journalEntryId,
    lineNumber,
    accountId: line.accountId,
    accountCode: account?.code ?? line.accountCode ?? '',
    accountName: account?.name ?? line.accountName ?? '',
    description: line.description,
    debit: Number(line.debit) || 0,
    credit: Number(line.credit) || 0,
    entityId: line.entityId,
    entityName: entity?.legalName ?? line.entityName ?? '',
    costCenter: line.costCenter,
    costCenterSnapshot: cc ? createCostCenterSnapshot(cc, nowIso()) : undefined,
    project: line.project,
    projectSnapshot: prj ? createProjectSnapshot(prj, nowIso()) : undefined,
    taxCode: line.taxCode,
    taxAmount: Number(line.taxAmount) || 0,
    memo: line.memo,
  };
}

function entryFromForm(values: JournalFormValues, base: EntryBase): JournalEntry {
  const accById = accountsMap();
  const entById = entitiesMap();
  const ccById = costCentersMap();
  const prjById = projectsMap();
  const id = base.id;
  const lines = values.lines.map((line, idx) =>
    lineFromForm(line, id, idx + 1, accById, entById, ccById, prjById),
  );
  const totals = computeTotals(lines);
  return {
    id,
    entryNumber: base.entryNumber,
    entryDate: values.entryDate,
    reference: values.reference,
    description: values.description,
    status: base.status,
    transactionType: values.transactionType,
    currency: values.currency.toUpperCase(),
    exchangeRate: Number(values.exchangeRate) || 1,
    totalDebit: totals.totalDebit,
    totalCredit: totals.totalCredit,
    difference: totals.difference,
    notes: values.notes,
    reversalReference: base.reversalReference,
    lines,
    createdAt: base.createdAt,
    createdBy: values.createdBy,
    updatedAt: nowIso(),
    updatedBy: base.updatedBy,
    postedAt: base.postedAt,
    postedBy: base.postedBy,
    approvedBy: base.approvedBy,
    voidedAt: base.voidedAt,
    voidedBy: base.voidedBy,
    originalEntryId: base.originalEntryId,
    reversalEntryId: base.reversalEntryId,
  };
}

interface JournalState {
  entries: JournalEntry[];

  addEntry: (values: JournalFormValues) => JournalActionResult;
  updateEntry: (id: string, values: JournalFormValues) => JournalActionResult;
  deleteEntry: (id: string) => JournalActionResult;
  duplicateEntry: (id: string) => JournalActionResult;
  reverseEntry: (id: string) => JournalActionResult;
  postEntry: (id: string) => JournalActionResult;
  voidEntry: (id: string) => JournalActionResult;

  appendEntries: (entries: JournalEntry[]) => JournalActionResult;
  /** Insert a already-balanced entry directly as POSTED (programmatic posting). */
  insertPostedEntry: (input: PostedEntryInput) => JournalActionResult & { lineIds?: string[] };
  replaceAll: (entries: JournalEntry[]) => void;
  resetToDefault: () => void;
}

/** A generated, already-balanced journal to post atomically (e.g. inventory). */
export interface PostedEntryInput {
  entryDate: string;
  reference: string;
  description: string;
  currency: string;
  exchangeRate: number;
  transactionType?: string;
  notes?: string;
  lines: Array<{
    accountId: string;
    debit: number;
    credit: number;
    description?: string;
    project?: string;
    costCenter?: string;
    taxCode?: string;
    taxAmount?: number;
  }>;
}

export const useJournalStore = create<JournalState>()(
  persist(
    (set, get) => ({
      entries: SEED_JOURNAL_ENTRIES,

      addEntry: (values) => {
        // Subscription gate: a suspended/expired subscription blocks new
        // posting activity (drafts included, so document flows never leave an
        // orphan draft). Existing data is never touched.
        const guard = assertSubscriptionAllowsPosting(getSubscriptionStatus());
        if (!guard.ok) return { ok: false, error: guard.error };
        const { entries } = get();
        const entryNumber = values.entryNumber.trim() || nextEntryNumber(entries);
        if (entries.some((e) => e.entryNumber === entryNumber)) {
          return { ok: false, error: `Entry number "${entryNumber}" already exists.` };
        }
        const id = generateId('je');
        const created = entryFromForm(values, {
          id,
          entryNumber,
          status: 'draft',
          createdAt: nowIso(),
          updatedBy: ACTOR,
          postedAt: '',
          postedBy: '',
          approvedBy: '',
          voidedAt: '',
          voidedBy: '',
          originalEntryId: '',
          reversalEntryId: '',
          reversalReference: '',
        });
        set({ entries: [...entries, created] });
        return { ok: true, id };
      },

      updateEntry: (id, values) => {
        const { entries } = get();
        const existing = entries.find((e) => e.id === id);
        if (!existing) return { ok: false, error: 'Journal entry not found.' };
        if (existing.status !== 'draft') {
          return {
            ok: false,
            error: 'Posted journal entries cannot be edited directly. Create a reversing entry or duplicate it as a new draft.',
          };
        }
        // Preserve identity + createdAt; refresh updatedAt/updatedBy.
        const updated = entryFromForm(values, {
          id,
          entryNumber: existing.entryNumber,
          status: 'draft',
          createdAt: existing.createdAt,
          updatedBy: ACTOR,
          postedAt: '',
          postedBy: '',
          approvedBy: existing.approvedBy,
          voidedAt: '',
          voidedBy: '',
          originalEntryId: existing.originalEntryId,
          reversalEntryId: existing.reversalEntryId,
          reversalReference: existing.reversalReference,
        });
        set({ entries: entries.map((e) => (e.id === id ? updated : e)) });
        return { ok: true, id };
      },

      deleteEntry: (id) => {
        const { entries } = get();
        const existing = entries.find((e) => e.id === id);
        if (!existing) return { ok: false, error: 'Journal entry not found.' };
        if (existing.status !== 'draft') {
          return { ok: false, error: 'Only draft entries can be deleted. Posted entries must be reversed or voided.' };
        }
        set({ entries: entries.filter((e) => e.id !== id) });
        return { ok: true };
      },

      duplicateEntry: (id) => {
        const { entries } = get();
        const source = entries.find((e) => e.id === id);
        if (!source) return { ok: false, error: 'Journal entry not found.' };

        const newId = generateId('je');
        const entryNumber = nextEntryNumber(entries);
        const now = nowIso();
        const copy: JournalEntry = {
          ...source,
          id: newId,
          entryNumber,
          status: 'draft',
          reference: source.reference ? `${source.reference}-COPY` : '',
          approvedBy: '',
          postedAt: '',
          postedBy: '',
          voidedAt: '',
          voidedBy: '',
          reversalReference: '',
          originalEntryId: '',
          reversalEntryId: '',
          createdAt: now,
          createdBy: source.createdBy || ACTOR,
          updatedAt: now,
          updatedBy: ACTOR,
          lines: source.lines.map((line, idx) => ({
            ...line,
            id: generateId('jl'),
            journalEntryId: newId,
            lineNumber: idx + 1,
          })),
        };
        set({ entries: [...entries, copy] });
        return { ok: true, id: newId };
      },

      reverseEntry: (id) => {
        const { entries } = get();
        const source = entries.find((e) => e.id === id);
        if (!source) return { ok: false, error: 'Journal entry not found.' };
        if (source.status !== 'posted') {
          return { ok: false, error: 'Only posted entries can be reversed.' };
        }

        const newId = generateId('je');
        const entryNumber = nextEntryNumber(entries);
        const now = nowIso();
        // Swap debit ↔ credit, keep account & entity references intact.
        const lines: JournalLine[] = source.lines.map((line, idx) => ({
          ...line,
          id: generateId('jl'),
          journalEntryId: newId,
          lineNumber: idx + 1,
          debit: line.credit,
          credit: line.debit,
        }));
        const totals = computeTotals(lines);
        const reversal: JournalEntry = {
          id: newId,
          entryNumber,
          entryDate: new Date().toISOString().slice(0, 10),
          reference: `REV-${source.entryNumber}`,
          description: `Reversal of ${source.entryNumber}${source.description ? ` — ${source.description}` : ''}`,
          status: 'draft',
          transactionType: source.transactionType,
          currency: source.currency,
          exchangeRate: source.exchangeRate,
          totalDebit: totals.totalDebit,
          totalCredit: totals.totalCredit,
          difference: totals.difference,
          notes: `Reversal of ${source.entryNumber}.`,
          reversalReference: source.entryNumber,
          lines,
          createdAt: now,
          createdBy: ACTOR,
          updatedAt: now,
          updatedBy: ACTOR,
          postedAt: '',
          postedBy: '',
          approvedBy: '',
          voidedAt: '',
          voidedBy: '',
          originalEntryId: source.id, // audit link; original left untouched
          reversalEntryId: '',
        };
        set({ entries: [...entries, reversal] }); // original posted entry is NOT mutated
        return { ok: true, id: newId };
      },

      postEntry: (id) => {
        const guard = assertSubscriptionAllowsPosting(getSubscriptionStatus());
        if (!guard.ok) return { ok: false, error: guard.error };
        const { entries } = get();
        const existing = entries.find((e) => e.id === id);
        if (!existing) return { ok: false, error: 'Journal entry not found.' };
        if (existing.status === 'posted') return { ok: false, error: 'Entry is already posted.' };
        if (existing.status === 'void') return { ok: false, error: 'A voided entry cannot be posted.' };

        // Drop blank placeholder rows before validating & posting so a posted
        // entry never carries empty lines. Line numbers are re-sequenced.
        const activeLines = existing.lines
          .filter((line) => !isBlankJournalLine(line))
          .map((line, idx) => ({ ...line, lineNumber: idx + 1 }));

        const errors = getPostingErrors({ lines: activeLines }, accountsMap());
        if (errors.length > 0) {
          return { ok: false, error: errors[0]?.message ?? 'Entry cannot be posted.' };
        }
        const now = nowIso();
        const totals = computeTotals(activeLines);
        set({
          entries: entries.map((e) =>
            e.id === id
              ? {
                  ...e,
                  lines: activeLines,
                  totalDebit: totals.totalDebit,
                  totalCredit: totals.totalCredit,
                  difference: totals.difference,
                  status: 'posted',
                  postedAt: now,
                  postedBy: ACTOR,
                  approvedBy: e.approvedBy || ACTOR,
                  updatedAt: now,
                  updatedBy: ACTOR,
                }
              : e,
          ),
        });
        return { ok: true, id };
      },

      voidEntry: (id) => {
        const { entries } = get();
        const existing = entries.find((e) => e.id === id);
        if (!existing) return { ok: false, error: 'Journal entry not found.' };
        if (existing.status !== 'posted') {
          return { ok: false, error: 'Only posted entries can be voided.' };
        }
        const now = nowIso();
        set({
          entries: entries.map((e) =>
            e.id === id
              ? {
                  ...e,
                  status: 'void',
                  reversalReference: `REV-${e.entryNumber}`,
                  voidedAt: now,
                  voidedBy: ACTOR,
                  updatedAt: now,
                  updatedBy: ACTOR,
                }
              : e,
          ),
        });
        return { ok: true, id };
      },

      appendEntries: (incoming) => {
        const { entries } = get();
        const used = new Set(entries.map((e) => e.entryNumber));
        let counter = entries;
        const renumbered = incoming.map((entry) => {
          let number = entry.entryNumber;
          if (!number || used.has(number)) {
            number = nextEntryNumber(counter);
          }
          used.add(number);
          const withNumber: JournalEntry = { ...normalizeEntry(entry), entryNumber: number };
          counter = [...counter, withNumber];
          return withNumber;
        });
        set({ entries: [...entries, ...renumbered] });
        return { ok: true };
      },

      insertPostedEntry: (input) => {
        const guard = assertSubscriptionAllowsPosting(getSubscriptionStatus());
        if (!guard.ok) return { ok: false, error: guard.error };
        const active = input.lines.filter((l) => (Number(l.debit) || 0) !== 0 || (Number(l.credit) || 0) !== 0);
        if (active.length < 2) return { ok: false, error: 'A posted entry needs at least two lines.' };
        const totalDebit = active.reduce((s, l) => s + (Number(l.debit) || 0), 0);
        const totalCredit = active.reduce((s, l) => s + (Number(l.credit) || 0), 0);
        if (Math.abs(totalDebit - totalCredit) > 0.005) {
          return { ok: false, error: 'Generated entry is not balanced.' };
        }
        const accById = accountsMap();
        const ccById = costCentersMap();
        const prjById = projectsMap();
        const { entries } = get();
        const id = generateId('je');
        const entryNumber = nextEntryNumber(entries);
        const now = nowIso();
        const lineIds: string[] = [];
        const lines: JournalLine[] = active.map((l, idx) => {
          const account = accById.get(l.accountId);
          const cc = l.costCenter ? ccById.get(l.costCenter) : undefined;
          const prj = l.project ? prjById.get(l.project) : undefined;
          const lineId = generateId('jl');
          lineIds.push(lineId);
          return {
            id: lineId,
            journalEntryId: id,
            lineNumber: idx + 1,
            accountId: l.accountId,
            accountCode: account?.code ?? '',
            accountName: account?.name ?? '',
            description: l.description ?? '',
            debit: Number(l.debit) || 0,
            credit: Number(l.credit) || 0,
            entityId: '',
            entityName: '',
            costCenter: l.costCenter ?? '',
            costCenterSnapshot: cc ? createCostCenterSnapshot(cc, now) : undefined,
            project: l.project ?? '',
            projectSnapshot: prj ? createProjectSnapshot(prj, now) : undefined,
            taxCode: l.taxCode ?? '',
            taxAmount: Number(l.taxAmount) || 0,
            memo: '',
          };
        });
        const entry: JournalEntry = {
          id,
          entryNumber,
          entryDate: input.entryDate,
          reference: input.reference,
          description: input.description,
          status: 'posted',
          transactionType: input.transactionType ?? 'Inventory',
          currency: input.currency.toUpperCase(),
          exchangeRate: Number(input.exchangeRate) || 1,
          totalDebit,
          totalCredit,
          difference: 0,
          notes: input.notes ?? '',
          reversalReference: '',
          lines,
          createdAt: now,
          createdBy: ACTOR,
          updatedAt: now,
          updatedBy: ACTOR,
          postedAt: now,
          postedBy: ACTOR,
          approvedBy: ACTOR,
          voidedAt: '',
          voidedBy: '',
          originalEntryId: '',
          reversalEntryId: '',
        };
        set({ entries: [...entries, entry] });
        return { ok: true, id, lineIds };
      },

      replaceAll: (entries) => set({ entries: entries.map(normalizeEntry) }),

      resetToDefault: () =>
        set({ entries: SEED_JOURNAL_ENTRIES.map((e) => ({ ...e })) }),
    }),
    {
      name: 'ifrs-journal-store', storage: businessJSONStorage,
      version: 3,
      partialize: (state) => ({ entries: state.entries }),
      // v3 refreshes the demo dataset to the 10 seeded dummy transactions
      // (9 posted + 1 draft). Once the store is written at v3, the persisted
      // entries are kept as-is on subsequent loads.
      migrate: (_persisted, _version) => ({ entries: SEED_JOURNAL_ENTRIES.map((e) => ({ ...e })) }),
    },
  ),
);

/* ─────────────────────────────── Form helpers ───────────────────────────── */

export function makeEmptyLine(): JournalLineFormValues {
  return {
    accountId: '',
    accountCode: '',
    accountName: '',
    description: '',
    debit: 0,
    credit: 0,
    entityId: '',
    entityName: '',
    costCenter: '',
    project: '',
    taxCode: '',
    taxAmount: 0,
    memo: '',
  };
}

/** Default form values for a brand-new draft entry. */
export function makeDefaultJournalValues(
  entryNumber: string,
  currency: string,
): JournalFormValues {
  return {
    entryNumber,
    entryDate: new Date().toISOString().slice(0, 10),
    reference: '',
    description: '',
    currency,
    exchangeRate: 1,
    notes: '',
    transactionType: '',
    createdBy: '',
    approvedBy: '',
    lines: [makeEmptyLine(), makeEmptyLine()],
  };
}

/** Map an existing entry into editable form values. */
export function entryToFormValues(entry: JournalEntry): JournalFormValues {
  return {
    entryNumber: entry.entryNumber,
    entryDate: entry.entryDate,
    reference: entry.reference,
    description: entry.description,
    currency: entry.currency,
    exchangeRate: entry.exchangeRate,
    notes: entry.notes,
    transactionType: entry.transactionType,
    createdBy: entry.createdBy,
    approvedBy: entry.approvedBy,
    lines: entry.lines.map((line) => ({
      accountId: line.accountId,
      accountCode: line.accountCode,
      accountName: line.accountName,
      description: line.description,
      debit: line.debit,
      credit: line.credit,
      entityId: line.entityId,
      entityName: line.entityName,
      costCenter: line.costCenter,
      project: line.project,
      taxCode: line.taxCode,
      taxAmount: line.taxAmount,
      memo: line.memo,
    })),
  };
}

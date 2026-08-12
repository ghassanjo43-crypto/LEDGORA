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
import type { OrganizationRole } from '@/types/roles';
import { assertJournalPermission, type JournalPermission } from '@/lib/journalPermissions';
import {
  assertExpectedVersion,
  assessAmendment,
  diffEntries,
  entryVersion,
  snapshotEntry,
  validateReason,
  type AmendmentAssessment,
} from '@/lib/journalAmendment';
import { collectDependencies } from '@/lib/journalDependencies';
import type { JournalAmendmentRecord } from '@/types/journal';
import { getSubscriptionStatus } from './entitlementHooks';
import { isPlatformAdminFullAccess, resolveAuditActor } from './platformFullAccess';
import { getCurrentUser } from './authStore';
import { useStore } from './useStore';
import { useEntityStore } from './useEntityStore';
import { useCostCenterStore } from './costCenterStore';
import { useProjectStore } from './projectStore';
import { generateId, nowIso } from '@/lib/utils';

/**
 * Attribution for journal records. Normally the signed-in finance user
 * (placeholder until real auth, matches Topbar); when a platform administrator
 * acts inside a subscriber workspace in operator mode, records name the
 * administrator — audit never impersonates the subscriber owner.
 */
const auditActor = (): string => resolveAuditActor('Finance Manager');

export interface JournalActionResult {
  ok: boolean;
  error?: string;
  id?: string;
  /**
   * Set when the refusal was a concurrency conflict, so the caller can offer
   * "review latest version" instead of showing a generic failure.
   */
  conflict?: { currentVersion: number; expectedVersion?: number };
}

/**
 * Effective organization role for permission checks.
 *
 * Identical to the resolution used by `fixedAssetStore`, `journalVoucherStore`
 * and `useEntityStore`, so one role means one thing across the workspace.
 */
function currentRole(): OrganizationRole {
  if (isPlatformAdminFullAccess()) return 'admin';
  return getCurrentUser()?.role ?? 'owner';
}

/**
 * The permission gate, applied to the WRITE.
 *
 * See `lib/journalPermissions` for why this is the deepest enforcement point
 * that exists today and what must happen when journals move server-side.
 */
function requirePermission(permission: JournalPermission): JournalActionResult | null {
  const result = assertJournalPermission(currentRole(), permission);
  return result.ok ? null : { ok: false, error: result.error };
}

/** Whether the current role may correct entries. For UI affordances only. */
export function canEditJournal(): boolean {
  return assertJournalPermission(currentRole(), 'journal.edit').ok;
}

export function canReverseJournal(): boolean {
  return assertJournalPermission(currentRole(), 'journal.reverse').ok;
}

/** Build one immutable history record. */
function amendmentRecord(input: Omit<JournalAmendmentRecord, 'id' | 'at' | 'actor'>): JournalAmendmentRecord {
  return { id: generateId('jam'), at: nowIso(), actor: auditActor(), ...input };
}

/**
 * The history an entry starts life with.
 *
 * Entries persisted before versioning have none, so one is synthesised from
 * what the record itself remembers rather than left empty — an audit panel that
 * shows nothing for an entry that was demonstrably created and posted would
 * read as "the history was deleted".
 */
function ensureHistory(entry: JournalEntry): JournalAmendmentRecord[] {
  if (entry.amendments && entry.amendments.length > 0) return entry.amendments;
  const history: JournalAmendmentRecord[] = [
    {
      id: generateId('jam'),
      version: 1,
      kind: 'created',
      at: entry.createdAt,
      actor: entry.createdBy || 'Unknown',
      reason: '',
      changes: [],
    },
  ];
  if (entry.status === 'posted' && entry.postedAt) {
    history.push({
      id: generateId('jam'),
      version: 1,
      kind: 'posted',
      at: entry.postedAt,
      actor: entry.postedBy || entry.createdBy || 'Unknown',
      reason: '',
      changes: [],
    });
  }
  return history;
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
  updateEntry: (id: string, values: JournalFormValues, options?: AmendOptions) => JournalActionResult;
  /**
   * What may be done to this entry, and why. A pure read — the UI calls it
   * before opening the editor, and every mutating action re-runs it internally
   * so the verdict a caller saw can never be the one that is acted on.
   */
  assessAmendment: (id: string) => AmendmentAssessment | null;
  /** Correct a POSTED entry in place, keeping the superseded version. */
  amendPostedEntry: (id: string, values: JournalFormValues, options: AmendOptions) => JournalActionResult;
  /** Reverse a posted entry and write a corrected replacement, linking all three. */
  reverseAndReplace: (
    id: string,
    values: JournalFormValues,
    options: AmendOptions,
  ) => JournalActionResult & { reversalId?: string; replacementId?: string };
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

/** What every correction must carry: why, and which version it was based on. */
export interface AmendOptions {
  /** Mandatory for posted corrections; recorded permanently. */
  reason?: string;
  /**
   * The version the editor read when it opened. A save that does not match the
   * stored version is refused rather than merged — see `assertExpectedVersion`.
   */
  expectedVersion?: number;
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
        const denied = requirePermission('journal.create');
        if (denied) return denied;
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
          updatedBy: auditActor(),
          postedAt: '',
          postedBy: '',
          approvedBy: '',
          voidedAt: '',
          voidedBy: '',
          originalEntryId: '',
          reversalEntryId: '',
          reversalReference: '',
        });
        set({
          entries: [
            ...entries,
            {
              ...created,
              version: 1,
              amendments: [amendmentRecord({ version: 1, kind: 'created', reason: '', changes: [] })],
            },
          ],
        });
        return { ok: true, id };
      },

      assessAmendment: (id) => {
        const existing = get().entries.find((e) => e.id === id);
        if (!existing) return null;
        return assessAmendment(existing, collectDependencies(existing.id, existing.entryDate));
      },

      /**
       * Edit a DRAFT entry.
       *
       * Posted entries are routed to `amendPostedEntry` / `reverseAndReplace`
       * rather than refused outright — the old behaviour told the accountant to
       * go and build the reversal by hand, which is both more work and easier
       * to get wrong than the correction they were attempting.
       */
      updateEntry: (id, values, options = {}) => {
        const denied = requirePermission('journal.edit');
        if (denied) return denied;

        const { entries } = get();
        const existing = entries.find((e) => e.id === id);
        if (!existing) return { ok: false, error: 'Journal entry not found.' };

        if (existing.status !== 'draft') {
          const assessment = assessAmendment(existing, collectDependencies(existing.id, existing.entryDate));
          if (assessment.mode === 'amend_in_place') return get().amendPostedEntry(id, values, options);
          if (assessment.mode === 'reverse_and_replace') {
            return {
              ok: false,
              error: `${assessment.explanation} Use “Reverse & edit” to apply this correction.`,
            };
          }
          return { ok: false, error: assessment.explanation };
        }

        /*
         * A draft is still subject to hard blocks: a locked period governs the
         * DATE, not the lifecycle state, so a draft dated inside a closed
         * period may not be saved into it either.
         */
        const assessment = assessAmendment(existing, collectDependencies(existing.id, values.entryDate));
        if (assessment.mode === 'blocked') return { ok: false, error: assessment.explanation };

        const version = assertExpectedVersion(existing, options.expectedVersion ?? entryVersion(existing));
        if (!version.ok) {
          return { ok: false, error: version.error, conflict: { currentVersion: version.currentVersion ?? 1, expectedVersion: options.expectedVersion } };
        }

        const before = snapshotEntry(existing);
        // Preserve identity + createdAt; refresh updatedAt/updatedBy.
        const updated = entryFromForm(values, {
          id,
          entryNumber: existing.entryNumber,
          status: 'draft',
          createdAt: existing.createdAt,
          updatedBy: auditActor(),
          postedAt: '',
          postedBy: '',
          approvedBy: existing.approvedBy,
          voidedAt: '',
          voidedBy: '',
          originalEntryId: existing.originalEntryId,
          reversalEntryId: existing.reversalEntryId,
          reversalReference: existing.reversalReference,
        });

        const nextVersion = entryVersion(existing) + 1;
        const changes = diffEntries(before, snapshotEntry(updated));
        const withHistory: JournalEntry = {
          ...updated,
          version: nextVersion,
          amendments: [
            ...ensureHistory(existing),
            amendmentRecord({
              version: nextVersion,
              kind: 'amended',
              reason: (options.reason ?? '').trim(),
              changes,
              snapshot: before,
            }),
          ],
          ...(existing.replacedEntryId ? { replacedEntryId: existing.replacedEntryId } : {}),
          ...(existing.replacementEntryId ? { replacementEntryId: existing.replacementEntryId } : {}),
        };

        set({ entries: entries.map((e) => (e.id === id ? withHistory : e)) });
        return { ok: true, id };
      },

      /**
       * Controlled amendment of a POSTED entry.
       *
       * The superseded version is snapshotted into the history BEFORE the new
       * values are written, so the original posting survives in full. Nothing
       * here removes or rewrites an existing history record.
       */
      amendPostedEntry: (id, values, options) => {
        const denied = requirePermission('journal.edit');
        if (denied) return denied;

        const { entries } = get();
        const existing = entries.find((e) => e.id === id);
        if (!existing) return { ok: false, error: 'Journal entry not found.' };
        if (existing.status !== 'posted') {
          return { ok: false, error: 'Only a posted entry is amended this way. Drafts are edited directly.' };
        }

        /*
         * Re-assessed HERE, against live dependencies — never trusting the
         * verdict the caller was shown. A dependency can appear between opening
         * the editor and pressing save, and that is exactly the window this
         * matters in.
         */
        const assessment = assessAmendment(existing, collectDependencies(existing.id, existing.entryDate));
        if (assessment.mode !== 'amend_in_place') {
          return { ok: false, error: assessment.explanation };
        }
        // The NEW date must also be amendable — a correction must not move an
        // entry into a period that is closed.
        const targetDate = assessAmendment(existing, collectDependencies(existing.id, values.entryDate));
        if (targetDate.mode === 'blocked') return { ok: false, error: targetDate.explanation };

        const reason = validateReason(options.reason);
        if (!reason.ok) return { ok: false, error: reason.error };

        const version = assertExpectedVersion(existing, options.expectedVersion);
        if (!version.ok) {
          return { ok: false, error: version.error, conflict: { currentVersion: version.currentVersion ?? 1, expectedVersion: options.expectedVersion } };
        }

        const activeLines = values.lines.filter((line) => !isBlankJournalLine(line));
        const errors = getPostingErrors(
          {
            lines: activeLines.map((line, idx) => ({
              lineNumber: idx + 1,
              accountId: line.accountId,
              debit: Number(line.debit) || 0,
              credit: Number(line.credit) || 0,
              taxAmount: Number(line.taxAmount) || 0,
              entityId: line.entityId,
            })),
          },
          accountsMap(),
        );
        if (errors.length > 0) {
          return { ok: false, error: errors[0]?.message ?? 'The corrected entry is not valid for posting.' };
        }

        const before = snapshotEntry(existing);
        const amended = entryFromForm({ ...values, lines: activeLines }, {
          id,
          entryNumber: existing.entryNumber,
          status: 'posted',
          createdAt: existing.createdAt,
          updatedBy: auditActor(),
          // The ORIGINAL posting timestamp survives: the entry was posted then,
          // and rewriting that would misdate the ledger effect.
          postedAt: existing.postedAt,
          postedBy: existing.postedBy,
          approvedBy: existing.approvedBy,
          voidedAt: '',
          voidedBy: '',
          originalEntryId: existing.originalEntryId,
          reversalEntryId: existing.reversalEntryId,
          reversalReference: existing.reversalReference,
        });

        const nextVersion = entryVersion(existing) + 1;
        const withHistory: JournalEntry = {
          ...amended,
          version: nextVersion,
          amendments: [
            ...ensureHistory(existing),
            amendmentRecord({
              version: nextVersion,
              kind: 'amended',
              reason: (options.reason ?? '').trim(),
              changes: diffEntries(before, snapshotEntry(amended)),
              snapshot: before,
            }),
          ],
        };

        set({ entries: entries.map((e) => (e.id === id ? withHistory : e)) });
        return { ok: true, id };
      },

      /**
       * Reverse a posted entry and write a corrected replacement.
       *
       * Three records afterwards, all linked and all readable:
       *   the ORIGINAL, untouched except for the links and its history;
       *   a REVERSAL that withdraws its ledger effect;
       *   a REPLACEMENT carrying the corrected figures.
       *
       * Both new entries are written as POSTED. A reversal left as a draft is a
       * ledger that is wrong until somebody remembers to post it, and the whole
       * point of offering this as one action is that the correction is complete
       * when it returns.
       */
      reverseAndReplace: (id, values, options) => {
        const denied = requirePermission('journal.edit') ?? requirePermission('journal.reverse');
        if (denied) return denied;

        const { entries } = get();
        const existing = entries.find((e) => e.id === id);
        if (!existing) return { ok: false, error: 'Journal entry not found.' };
        if (existing.status !== 'posted') {
          return { ok: false, error: 'Only a posted entry can be reversed and replaced.' };
        }

        const assessment = assessAmendment(existing, collectDependencies(existing.id, existing.entryDate));
        if (assessment.mode === 'blocked') return { ok: false, error: assessment.explanation };
        if (assessment.mode === 'direct_edit') {
          return { ok: false, error: 'This entry is a draft and can be edited directly.' };
        }

        const reason = validateReason(options.reason);
        if (!reason.ok) return { ok: false, error: reason.error };

        const version = assertExpectedVersion(existing, options.expectedVersion);
        if (!version.ok) {
          return { ok: false, error: version.error, conflict: { currentVersion: version.currentVersion ?? 1, expectedVersion: options.expectedVersion } };
        }

        const activeLines = values.lines.filter((line) => !isBlankJournalLine(line));
        const replacementErrors = getPostingErrors(
          {
            lines: activeLines.map((line, idx) => ({
              lineNumber: idx + 1,
              accountId: line.accountId,
              debit: Number(line.debit) || 0,
              credit: Number(line.credit) || 0,
              taxAmount: Number(line.taxAmount) || 0,
              entityId: line.entityId,
            })),
          },
          accountsMap(),
        );
        if (replacementErrors.length > 0) {
          return { ok: false, error: replacementErrors[0]?.message ?? 'The replacement entry is not valid for posting.' };
        }

        const now = nowIso();
        const trimmedReason = (options.reason ?? '').trim();

        /* ── 1. The reversal: the original's lines with the sides swapped ── */
        const reversalId = generateId('je');
        const reversalNumber = nextEntryNumber(entries);
        const reversalLines: JournalLine[] = existing.lines.map((line, idx) => ({
          ...line,
          id: generateId('jl'),
          journalEntryId: reversalId,
          lineNumber: idx + 1,
          debit: line.credit,
          credit: line.debit,
        }));
        const reversalTotals = computeTotals(reversalLines);
        const reversal: JournalEntry = {
          ...existing,
          id: reversalId,
          entryNumber: reversalNumber,
          // Dated with the original so the reversal lands in the same period
          // the effect it withdraws belongs to.
          entryDate: existing.entryDate,
          reference: `REV-${existing.entryNumber}`,
          description: `Reversal of ${existing.entryNumber}${existing.description ? ` — ${existing.description}` : ''}`,
          status: 'posted',
          totalDebit: reversalTotals.totalDebit,
          totalCredit: reversalTotals.totalCredit,
          difference: reversalTotals.difference,
          notes: `Reversal of ${existing.entryNumber}. ${trimmedReason}`,
          reversalReference: existing.entryNumber,
          lines: reversalLines,
          createdAt: now,
          createdBy: auditActor(),
          updatedAt: now,
          updatedBy: auditActor(),
          postedAt: now,
          postedBy: auditActor(),
          voidedAt: '',
          voidedBy: '',
          originalEntryId: existing.id,
          reversalEntryId: '',
          replacementEntryId: '',
          replacedEntryId: '',
          version: 1,
          amendments: [
            {
              id: generateId('jam'),
              version: 1,
              kind: 'reversed',
              at: now,
              actor: auditActor(),
              reason: trimmedReason,
              changes: [],
              relatedEntryId: existing.id,
              relatedEntryNumber: existing.entryNumber,
            },
          ],
        };

        /* ── 2. The replacement: the corrected figures ────────────────────── */
        const replacementId = generateId('je');
        const replacementNumber = nextEntryNumber([...entries, reversal]);
        const replacementBase = entryFromForm({ ...values, lines: activeLines }, {
          id: replacementId,
          entryNumber: replacementNumber,
          status: 'posted',
          createdAt: now,
          updatedBy: auditActor(),
          postedAt: now,
          postedBy: auditActor(),
          approvedBy: existing.approvedBy,
          voidedAt: '',
          voidedBy: '',
          originalEntryId: existing.id,
          reversalEntryId: '',
          reversalReference: '',
        });
        const replacement: JournalEntry = {
          ...replacementBase,
          description: replacementBase.description || `Replacement for ${existing.entryNumber}`,
          notes: replacementBase.notes || `Replacement for ${existing.entryNumber}. ${trimmedReason}`,
          replacedEntryId: existing.id,
          version: 1,
          amendments: [
            {
              id: generateId('jam'),
              version: 1,
              kind: 'replacement',
              at: now,
              actor: auditActor(),
              reason: trimmedReason,
              changes: diffEntries(snapshotEntry(existing), snapshotEntry(replacementBase)),
              relatedEntryId: existing.id,
              relatedEntryNumber: existing.entryNumber,
            },
          ],
        };

        /* ── 3. The original: links only. Its figures are NOT touched. ───── */
        const originalWithLinks: JournalEntry = {
          ...existing,
          version: entryVersion(existing) + 1,
          updatedAt: now,
          updatedBy: auditActor(),
          reversalEntryId: reversalId,
          replacementEntryId: replacementId,
          amendments: [
            ...ensureHistory(existing),
            {
              id: generateId('jam'),
              version: entryVersion(existing) + 1,
              kind: 'replaced',
              at: now,
              actor: auditActor(),
              reason: trimmedReason,
              changes: [],
              relatedEntryId: replacementId,
              relatedEntryNumber: replacementNumber,
            },
          ],
        };

        set({
          entries: [
            ...entries.map((e) => (e.id === id ? originalWithLinks : e)),
            reversal,
            replacement,
          ],
        });
        return { ok: true, id: replacementId, reversalId, replacementId };
      },

      deleteEntry: (id) => {
        const denied = requirePermission('journal.edit');
        if (denied) return denied;
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
          createdBy: source.createdBy || auditActor(),
          updatedAt: now,
          updatedBy: auditActor(),
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
        const denied = requirePermission('journal.reverse');
        if (denied) return denied;
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
          createdBy: auditActor(),
          updatedAt: now,
          updatedBy: auditActor(),
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
        const denied = requirePermission('journal.post');
        if (denied) return denied;
        const { entries } = get();
        const existing = entries.find((e) => e.id === id);
        if (!existing) return { ok: false, error: 'Journal entry not found.' };
        if (existing.status === 'posted') return { ok: false, error: 'Entry is already posted.' };
        if (existing.status === 'void') return { ok: false, error: 'A voided entry cannot be posted.' };

        /*
         * Posting is a write INTO a period, so the same hard blocks apply: an
         * entry may not be posted into a closed or filed period, and
         * `journal.post` is not a way around a period lock.
         */
        const periodCheck = assessAmendment(existing, collectDependencies(existing.id, existing.entryDate));
        if (periodCheck.blockers.some((b) => b.kind === 'locked_period' || b.kind === 'filed_tax_return' || b.kind === 'legal_hold')) {
          return { ok: false, error: periodCheck.explanation };
        }

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
                  postedBy: auditActor(),
                  approvedBy: e.approvedBy || auditActor(),
                  updatedAt: now,
                  updatedBy: auditActor(),
                  version: entryVersion(e) + 1,
                  amendments: [
                    ...ensureHistory(e),
                    amendmentRecord({ version: entryVersion(e) + 1, kind: 'posted', reason: '', changes: [] }),
                  ],
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
                  voidedBy: auditActor(),
                  updatedAt: now,
                  updatedBy: auditActor(),
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
          createdBy: auditActor(),
          updatedAt: now,
          updatedBy: auditActor(),
          postedAt: now,
          postedBy: auditActor(),
          approvedBy: auditActor(),
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

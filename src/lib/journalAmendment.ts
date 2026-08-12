/**
 * Controlled amendment of journal entries: what may be corrected, how, and what
 * must never be silently overwritten.
 *
 * ══ The rule this module encodes ══════════════════════════════════════════════
 *
 * An authorized user may correct any journal entry, as long as the correction
 * does not conflict with another transaction, an accounting dependency, a
 * locked period, a regulatory record, or a concurrent edit.
 *
 * "Posted entries cannot be edited" — the behaviour this replaces — is not that
 * rule. It is a refusal to think about the question, and it pushes accountants
 * into hand-built reversals that are easier to get wrong than the correction
 * they were trying to make. What actually matters is that the HISTORY survives:
 * a posted figure that someone relied on must remain readable afterwards,
 * together with who changed it, when, and why.
 *
 * ══ The four outcomes ════════════════════════════════════════════════════════
 *
 *   direct_edit          A draft. Nobody has relied on it; edit it normally.
 *
 *   amend_in_place       A posted entry that nothing depends on. The correction
 *                        is applied and the superseded version is kept in full,
 *                        with actor, timestamp and a mandatory reason.
 *
 *   reverse_and_replace  A posted entry something downstream depends on.
 *                        Overwriting it would change a number another record
 *                        was computed from, so instead it is reversed and a
 *                        corrected replacement is written. All three entries
 *                        stay linked and readable.
 *
 *   blocked              A correction this application must not make at all:
 *                        the period is locked or filed, a legal hold applies,
 *                        or ANOTHER MODULE OWNS the journal and the correction
 *                        belongs to the source document.
 *
 * ══ What is NOT a conflict ═══════════════════════════════════════════════════
 *
 * Another journal touching the same account is not a dependency. Accounts are
 * shared by construction — every cash transaction in the business posts to the
 * same cash account — and treating that as a conflict would make every entry in
 * an active ledger uncorrectable. A dependency is a record that was DERIVED
 * from this specific entry, or a rule that governs this specific entry's date.
 * `journalAmendment.test.ts` holds that line explicitly.
 *
 * ══ Purity ═══════════════════════════════════════════════════════════════════
 *
 * Everything here is a pure function over data. The probing of live stores is
 * `journalDependencies`; this module only decides what the collected facts mean,
 * which is what makes the decision testable without constructing a workspace.
 */
import type {
  JournalAmendmentRecord,
  JournalEntry,
  JournalEntrySnapshot,
  JournalFieldChange,
  JournalLine,
} from '@/types/journal';

/* ─────────────────────────────── Dependencies ───────────────────────────── */

export type DependencySeverity =
  /** The journal may not be corrected here at all. */
  | 'blocks'
  /** Direct overwrite is unsafe; reverse and replace instead. */
  | 'requires_reversal';

export type DependencyKind =
  | 'locked_period'
  | 'filed_tax_return'
  | 'legal_hold'
  | 'source_document'
  | 'bank_reconciliation'
  | 'ar_ap_allocation'
  | 'inventory_costing'
  | 'depreciation_run'
  | 'payroll'
  | 'downstream_record';

export interface JournalDependency {
  kind: DependencyKind;
  severity: DependencySeverity;
  /** The module or record type holding the dependency. */
  sourceType: string;
  sourceId: string;
  /** Human label, e.g. `Sales invoice INV-0042`. */
  sourceLabel: string;
  /** The sentence the operator reads. */
  message: string;
  /**
   * Where the correction actually belongs, when it is not here. Drives the
   * "correct the source document instead" redirect in the UI.
   */
  correctAt?: { module: string; documentId: string; label: string };
}

/* ──────────────────────────────── Assessment ────────────────────────────── */

export type AmendmentMode = 'direct_edit' | 'amend_in_place' | 'reverse_and_replace' | 'blocked';

export interface AmendmentAssessment {
  entryId: string;
  entryNumber: string;
  status: JournalEntry['status'];
  /** The token a save must echo back. See {@link assertExpectedVersion}. */
  version: number;
  mode: AmendmentMode;
  /** Every dependency found, whatever the verdict. Always shown, never summarised away. */
  dependencies: JournalDependency[];
  /** Dependencies that stop the correction entirely. */
  blockers: JournalDependency[];
  /** True when the chosen mode records history and therefore needs a reason. */
  reasonRequired: boolean;
  /** The sentence the drawer/dialog shows. */
  explanation: string;
  /** Present when the correction belongs to another module. */
  correctAt?: JournalDependency['correctAt'];
}

/** Version of an entry, defaulting to 1 for records written before versioning. */
export function entryVersion(entry: Pick<JournalEntry, 'version'>): number {
  return typeof entry.version === 'number' && entry.version > 0 ? entry.version : 1;
}

export const CONCURRENT_EDIT_MESSAGE =
  'This journal entry was changed by another user while you were editing it. Review the latest version before applying your changes.';

export interface VersionCheckResult {
  ok: boolean;
  error?: string;
  /** The version now in the store, for the "review latest" affordance. */
  currentVersion?: number;
  expectedVersion?: number;
}

/**
 * Optimistic concurrency.
 *
 * The saver states the version it read. If the stored entry has moved on, the
 * save is REFUSED rather than merged or applied: the other user's change is
 * already part of the ledger, and a last-writer-wins overwrite would delete it
 * with no record that it existed. The caller is expected to show the latest
 * version and let a human decide.
 */
export function assertExpectedVersion(
  entry: Pick<JournalEntry, 'version'>,
  expectedVersion: number | undefined,
): VersionCheckResult {
  const current = entryVersion(entry);
  // Omitting the token is not a way to skip the check.
  if (typeof expectedVersion !== 'number') {
    return { ok: false, error: CONCURRENT_EDIT_MESSAGE, currentVersion: current };
  }
  if (expectedVersion !== current) {
    return { ok: false, error: CONCURRENT_EDIT_MESSAGE, currentVersion: current, expectedVersion };
  }
  return { ok: true, currentVersion: current, expectedVersion };
}

/**
 * Decide how — or whether — this entry may be corrected.
 *
 * Order matters and is deliberate: a hard block is reported even when a
 * reversal-grade dependency is also present, because the operator's next action
 * differs completely (reopen the period / release the hold, versus correct the
 * entry). Reporting the weaker verdict would send them down a path that ends in
 * a second refusal.
 */
export function assessAmendment(
  entry: Pick<JournalEntry, 'id' | 'entryNumber' | 'status' | 'version'>,
  dependencies: readonly JournalDependency[],
): AmendmentAssessment {
  const blockers = dependencies.filter((d) => d.severity === 'blocks');
  const reversalRequired = dependencies.filter((d) => d.severity === 'requires_reversal');
  const version = entryVersion(entry);
  const base = {
    entryId: entry.id,
    entryNumber: entry.entryNumber,
    status: entry.status,
    version,
    dependencies: [...dependencies],
    blockers,
  };

  if (blockers.length > 0) {
    const redirect = blockers.find((b) => b.correctAt);
    return {
      ...base,
      mode: 'blocked',
      reasonRequired: false,
      explanation: blockers.map((b) => b.message).join(' '),
      ...(redirect?.correctAt ? { correctAt: redirect.correctAt } : {}),
    };
  }

  /*
   * A voided entry is history, not a draft. There is nothing to correct: the
   * ledger effect is already withdrawn, and the right move is a fresh entry.
   */
  if (entry.status === 'void') {
    return {
      ...base,
      mode: 'blocked',
      reasonRequired: false,
      explanation: 'This entry has been voided. Record a new entry instead of correcting a withdrawn one.',
    };
  }

  if (entry.status === 'draft') {
    return {
      ...base,
      mode: 'direct_edit',
      reasonRequired: false,
      explanation: 'This entry is still a draft and can be edited freely. It must pass posting validation before it can be posted.',
    };
  }

  if (reversalRequired.length > 0) {
    return {
      ...base,
      mode: 'reverse_and_replace',
      reasonRequired: true,
      explanation:
        'This posted entry has dependencies and cannot be overwritten directly. Ledgora can reverse it and create a corrected replacement.',
    };
  }

  return {
    ...base,
    mode: 'amend_in_place',
    reasonRequired: true,
    explanation:
      'This posted entry is standalone. The correction is applied as a new version; the original posting is kept in the history.',
  };
}

/* ──────────────────────────────── Diffing ───────────────────────────────── */

const money = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Header fields tracked in the audit trail, with the labels operators read. */
const HEADER_FIELDS: Array<{ key: keyof JournalEntrySnapshot; label: string }> = [
  { key: 'entryDate', label: 'Entry date' },
  { key: 'reference', label: 'Reference' },
  { key: 'description', label: 'Description' },
  { key: 'currency', label: 'Currency' },
  { key: 'exchangeRate', label: 'Exchange rate' },
  { key: 'notes', label: 'Notes' },
  { key: 'createdBy', label: 'Preparer' },
];

/** Line fields tracked, in the order an accountant reads a line. */
const LINE_FIELDS: Array<{ key: keyof JournalLine; label: string; money?: boolean }> = [
  { key: 'accountCode', label: 'Account' },
  { key: 'entityName', label: 'Entity' },
  { key: 'debit', label: 'Debit', money: true },
  { key: 'credit', label: 'Credit', money: true },
  { key: 'memo', label: 'Memo' },
  { key: 'costCenter', label: 'Cost center' },
  { key: 'project', label: 'Project' },
];

/** Snapshot the parts of an entry the history needs to reproduce it. */
export function snapshotEntry(entry: JournalEntry): JournalEntrySnapshot {
  return {
    entryDate: entry.entryDate,
    reference: entry.reference,
    description: entry.description,
    currency: entry.currency,
    exchangeRate: entry.exchangeRate,
    notes: entry.notes,
    createdBy: entry.createdBy,
    totalDebit: entry.totalDebit,
    totalCredit: entry.totalCredit,
    lines: entry.lines.map((l) => ({ ...l })),
  };
}

function accountLabel(line: JournalLine | undefined): string {
  if (!line) return '—';
  return [line.accountCode, line.accountName].filter(Boolean).join(' ') || '—';
}

/**
 * Field-level before/after, for the audit panel.
 *
 * Only genuine differences are recorded. A change list padded with "unchanged"
 * rows buries the one field that actually moved, which is the single question
 * an auditor opens this panel to answer.
 */
export function diffEntries(before: JournalEntrySnapshot, after: JournalEntrySnapshot): JournalFieldChange[] {
  const changes: JournalFieldChange[] = [];

  for (const { key, label } of HEADER_FIELDS) {
    const a = String(before[key] ?? '');
    const b = String(after[key] ?? '');
    if (a !== b) changes.push({ field: key, label, before: a || '—', after: b || '—' });
  }

  const rows = Math.max(before.lines.length, after.lines.length);
  for (let i = 0; i < rows; i += 1) {
    const lineBefore = before.lines[i];
    const lineAfter = after.lines[i];

    if (lineBefore && !lineAfter) {
      changes.push({
        field: `lines.${i}`,
        label: `Line ${i + 1}`,
        before: `${accountLabel(lineBefore)} · Dr ${money(lineBefore.debit)} / Cr ${money(lineBefore.credit)}`,
        after: 'removed',
      });
      continue;
    }
    if (!lineBefore && lineAfter) {
      changes.push({
        field: `lines.${i}`,
        label: `Line ${i + 1}`,
        before: 'added',
        after: `${accountLabel(lineAfter)} · Dr ${money(lineAfter.debit)} / Cr ${money(lineAfter.credit)}`,
      });
      continue;
    }
    if (!lineBefore || !lineAfter) continue;

    for (const { key, label, money: isMoney } of LINE_FIELDS) {
      if (key === 'accountCode') {
        const a = accountLabel(lineBefore);
        const b = accountLabel(lineAfter);
        if (a !== b) changes.push({ field: `lines.${i}.accountId`, label: `Line ${i + 1} · ${label}`, before: a, after: b });
        continue;
      }
      const rawA = lineBefore[key];
      const rawB = lineAfter[key];
      const a = isMoney ? money(Number(rawA ?? 0)) : String(rawA ?? '');
      const b = isMoney ? money(Number(rawB ?? 0)) : String(rawB ?? '');
      if (a !== b) {
        changes.push({ field: `lines.${i}.${String(key)}`, label: `Line ${i + 1} · ${label}`, before: a || '—', after: b || '—' });
      }
    }
  }

  return changes;
}

/* ──────────────────────────────── History ──────────────────────────────── */

/** The history of an entry, oldest first, with version 1 always present. */
export function amendmentHistory(entry: JournalEntry): JournalAmendmentRecord[] {
  return [...(entry.amendments ?? [])].sort((a, b) => a.version - b.version || a.at.localeCompare(b.at));
}

/**
 * A reason is mandatory for anything that rewrites or withdraws a posted
 * figure. An amendment with no stated reason is an unexplained change to a
 * number somebody relied on — the audit trail would record that it happened and
 * be unable to say why, which is the one thing it exists to answer.
 */
export const REASON_REQUIRED_MESSAGE =
  'A reason is required and is recorded permanently in the entry’s history.';

export function validateReason(reason: string | undefined): { ok: boolean; error?: string } {
  return (reason ?? '').trim().length >= 5
    ? { ok: true }
    : { ok: false, error: REASON_REQUIRED_MESSAGE };
}

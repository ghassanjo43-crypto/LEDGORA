/**
 * Domain types for the General Journal module.
 *
 * The General Journal records accounting transactions using double-entry
 * bookkeeping BEFORE they are posted to the ledger. Every entry must balance:
 * total debits must equal total credits.
 *
 * Each {@link JournalLine} stores `accountId` as the canonical reference into
 * the Chart of Accounts, plus `accountCode` / `accountName` snapshots so that
 * historical (posted) entries preserve how the account was named at the time —
 * this keeps future reports (General Ledger, Trial Balance, Financial
 * Statements, Customer/Supplier Ledgers, Aging) accurate even if the chart is
 * later renamed.
 */

/** Lifecycle status of a journal entry. */
import type { CostCenterSnapshot } from '@/types/costCenter';
import type { ProjectSnapshot } from '@/types/project';

export type JournalStatus = 'draft' | 'posted' | 'void';

/** Approval lifecycle (UI/workflow layer — prepared for a future engine). */
export type JournalApprovalStatus =
  | 'not_required'
  | 'pending_review'
  | 'pending_approval'
  | 'approved'
  | 'rejected';

/** A single stage in the approval workflow shown in the details panel. */
export interface JournalApprovalStep {
  id: string;
  stage: 'created' | 'review' | 'approval' | 'posting';
  status: 'complete' | 'pending' | 'rejected';
  assignedTo?: string;
  completedAt?: string;
}

/** A single debit-or-credit line within a journal entry. */
export interface JournalLine {
  id: string;
  journalEntryId: string;
  lineNumber: number;

  /** Canonical reference into the Chart of Accounts. */
  accountId: string;
  /** Snapshot of the account code at the time of writing (historical accuracy). */
  accountCode: string;
  /** Snapshot of the account name at the time of writing (historical accuracy). */
  accountName: string;

  description: string;
  /** Debit amount in the entry currency. Mutually exclusive with `credit`. */
  debit: number;
  /** Credit amount in the entry currency. Mutually exclusive with `debit`. */
  credit: number;

  /** Optional business entity (customer / supplier / other party). */
  entityId: string;
  /** Snapshot of the entity legal name for display & historical reporting. */
  entityName: string;

  /** Cost-center id tagged on the line (management-reporting dimension). */
  costCenter: string;
  /** Frozen cost-center identity captured at posting (historical hierarchy). */
  costCenterSnapshot?: CostCenterSnapshot;
  /** Project id tagged on the line (temporary-initiative dimension). */
  project: string;
  /** Frozen project identity captured at posting. */
  projectSnapshot?: ProjectSnapshot;
  taxCode: string;
  taxAmount: number;
  memo: string;
}

/** A complete journal entry, composed of two or more balancing lines. */
export interface JournalEntry {
  id: string;
  /** Human-facing sequential reference, e.g. "JE-0001". */
  entryNumber: string;
  /** ISO date (yyyy-mm-dd) the transaction is recorded against. */
  entryDate: string;
  reference: string;
  description: string;
  status: JournalStatus;

  /**
   * Human transaction type (e.g. "Sales Invoice", "Depreciation"). Empty means
   * "auto-classify" from the reference/description. Display-only metadata.
   */
  transactionType: string;

  currency: string;
  exchangeRate: number;

  /** Sum of line debits (cached for display & reporting). */
  totalDebit: number;
  /** Sum of line credits (cached for display & reporting). */
  totalCredit: number;
  /** totalDebit - totalCredit; zero when balanced. */
  difference: number;

  notes: string;

  /** When voiding, references the reversal / reason marker. */
  reversalReference: string;

  lines: JournalLine[];

  /* ── Audit trail ──────────────────────────────────────────────────────── */
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  /** ISO timestamp when the entry was posted; empty while draft. */
  postedAt: string;
  postedBy: string;
  /** Retained for compatibility — the approver of the entry. */
  approvedBy: string;
  voidedAt: string;
  voidedBy: string;
  /** If this entry reverses/derives from another, the source entry id. */
  originalEntryId: string;
  /** If this entry was reversed, the id of the reversing entry. */
  reversalEntryId: string;

  /** Optional approval state; when absent the UI derives a status. */
  approvalStatus?: JournalApprovalStatus;

  /* ── Concurrency & amendment history ──────────────────────────────────── */
  /**
   * Optimistic concurrency token, incremented by every mutating action.
   *
   * OPTIONAL because entries persisted before versioning existed have none;
   * `entryVersion()` treats their absence as version 1 rather than rejecting
   * them, so an existing workspace keeps working. Never compare this field
   * directly — go through `entryVersion()`.
   */
  version?: number;
  /** Append-only history. Never rewritten, never pruned. */
  amendments?: JournalAmendmentRecord[];
  /** Set on an ORIGINAL that was reversed and replaced. */
  replacementEntryId?: string;
  /** Set on a REPLACEMENT, naming the original it corrects. */
  replacedEntryId?: string;
  /**
   * The document that generated this journal, when another module owns it.
   * Its presence is what makes journal-level editing inappropriate: the
   * correction belongs to the source, or the journal and its source disagree.
   */
  sourceModule?: string;
  sourceDocumentId?: string;
  sourceDocumentLabel?: string;
}

/* ────────────────────────── Amendment & audit history ───────────────────── */

/** What happened to the entry at a given version. */
export type JournalAmendmentKind =
  | 'created'
  | 'posted'
  | 'amended'
  | 'reversed'
  | 'replaced'
  | 'replacement'
  | 'voided';

/** One field that changed between two versions, rendered for the audit panel. */
export interface JournalFieldChange {
  /** Dotted path, e.g. `lines.1.accountId`. */
  field: string;
  /** Human label, e.g. `Line 2 · Account`. */
  label: string;
  /** Display value before, already formatted. */
  before: string;
  /** Display value after, already formatted. */
  after: string;
}

/**
 * One immutable entry in the journal's history.
 *
 * Append-only by construction: nothing in the store rewrites or removes a
 * record once written. The original posting survives every later correction,
 * which is the whole point — an amendment that erased what it replaced would
 * destroy the evidence the amendment exists to explain.
 */
export interface JournalAmendmentRecord {
  id: string;
  /** The version this record PRODUCED. Version 1 is the original. */
  version: number;
  kind: JournalAmendmentKind;
  /** ISO timestamp. */
  at: string;
  /** Who did it. */
  actor: string;
  /** Mandatory for `amended` / `reversed` / `replacement`; '' for `created`. */
  reason: string;
  changes: JournalFieldChange[];
  /** The other side of a reversal / replacement link. */
  relatedEntryId?: string;
  relatedEntryNumber?: string;
  /**
   * A full copy of the entry as it stood BEFORE this change. Present on
   * `amended` records so the audit trail can show the superseded version
   * itself, not merely a description of it.
   */
  snapshot?: JournalEntrySnapshot;
}

/** The restorable shape of a superseded version. */
export interface JournalEntrySnapshot {
  entryDate: string;
  reference: string;
  description: string;
  currency: string;
  exchangeRate: number;
  notes: string;
  createdBy: string;
  totalDebit: number;
  totalCredit: number;
  lines: JournalLine[];
}

/** Structured filters for the General Journal table. */
export interface JournalFilters {
  status: JournalStatus | 'ALL';
  /** Inclusive ISO start date, '' = unbounded. */
  dateFrom: string;
  /** Inclusive ISO end date, '' = unbounded. */
  dateTo: string;
  /** Filter by an account appearing on any line; '' = all. */
  accountId: string;
  /** Filter by an entity appearing on any line; '' = all. */
  entityId: string;
}

/** Severity-tagged finding against a journal entry. */
export type JournalIssueSeverity = 'error' | 'warning';

export interface JournalIssue {
  severity: JournalIssueSeverity;
  rule: string;
  message: string;
  /** Line number the issue relates to, or null for entry-level issues. */
  lineNumber: number | null;
}

/** Result of parsing + validating a journal import file. */
export interface JournalImportResult {
  entries: JournalEntry[];
  issues: JournalIssue[];
  ok: boolean;
}

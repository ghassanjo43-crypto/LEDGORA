/**
 * Controlled amendment of POSTED source documents — the shared vocabulary.
 *
 * ══ The rule these types encode ══════════════════════════════════════════════
 *
 * A posted document is never overwritten. An authorized user may AMEND one
 * through a controlled reversal-and-reposting workflow that preserves the
 * original document, its original journal entry, its number, its settlement
 * history and its inventory movements — all of it readable afterwards, linked
 * to the reversal and to the corrected replacement.
 *
 * This is the document-level counterpart of `lib/journalAmendment`, which
 * governs entries authored directly in the General Journal. The two are
 * deliberately separate and deliberately connected: `journalDependencies`
 * already refuses to let a journal OWNED by an invoice be corrected in the
 * journal editor, and says "correct the source document instead". These types
 * describe what that redirect leads to.
 *
 * ══ Why the metadata is all optional ═════════════════════════════════════════
 *
 * Every document written before this feature existed is version 1 of a chain of
 * one, and nothing rewrites it to say so. `amendmentVersion` therefore reads as
 * 1 when absent (see `documentVersion`), and a persisted record with no
 * amendment fields at all is a completely valid current document. Backfilling
 * these fields on load would mean rewriting historical records to introduce a
 * feature, which is exactly what the amendment rule forbids doing to them.
 */
import type { OrganizationRole } from '@/types/roles';

/* ── The documents this workflow covers ───────────────────────────────────── */

/**
 * The amendable posted-document classifications that exist in Ledgora.
 *
 * `supplier-debit-note` is the supplier-side counterpart of a customer credit
 * note — the note a buyer raises against a supplier when goods go back or a
 * bill was overcharged. Ledgora records it as a `BillSupplierCredit`: a posted
 * sub-record of the bill it corrects, with its own number and its own journal
 * entry. It is named here as its own classification because that is what it is
 * to an accountant, even though it is not a top-level store.
 */
export type AmendableDocumentType =
  | 'invoice'
  | 'bill'
  | 'credit-note'
  | 'supplier-debit-note';

export const AMENDABLE_DOCUMENT_TYPES: AmendableDocumentType[] = [
  'invoice',
  'bill',
  'credit-note',
  'supplier-debit-note',
];

export const DOCUMENT_TYPE_LABELS: Record<AmendableDocumentType, string> = {
  invoice: 'Sales invoice',
  bill: 'Purchase bill',
  'credit-note': 'Customer credit note',
  'supplier-debit-note': 'Supplier debit note',
};

/* ── Amendment metadata carried by an amendable document ──────────────────── */

/**
 * The version-chain fields mixed into `Invoice`, `Bill` and `CreditNote`.
 *
 * Every field is optional. A document that carries none of them is version 1 of
 * a chain that has never been amended, which is true of every record that
 * existed before this feature.
 */
export interface DocumentAmendmentMeta {
  /**
   * Position in the version chain. Absent means 1.
   *
   * The chain is a chain of DOCUMENTS, not of edits to one document: version 2
   * is a different record, with its own number and its own journal entry, and
   * version 1 keeps everything it had.
   */
  amendmentVersion?: number;
  /**
   * The FIRST document in the chain. Stable across every amendment, so a search
   * that finds any version can offer all of them. Absent on an unamended
   * document, where the chain root is the document itself.
   */
  amendmentChainId?: string;
  /** The document this one replaced. Set on a replacement. */
  amendsDocumentId?: string;
  amendsDocumentNumber?: string;
  /** The document that replaced this one. Set on the superseded original. */
  supersededByDocumentId?: string;
  supersededByDocumentNumber?: string;
  /** When this document was superseded, and why. */
  supersededAt?: string;
  amendmentReason?: string;
  /** The POSTED journal entry that withdrew this document's original posting. */
  amendmentReversalJournalEntryId?: string;
  /** The inventory reversal document, when this document moved stock. */
  amendmentInventoryReversalId?: string;
  /** The amendment audit event that records the whole transaction. */
  amendmentAuditEventId?: string;
}

/** Version of a document, defaulting to 1 for records written before versioning. */
export function documentVersion(doc: DocumentAmendmentMeta | undefined): number {
  const v = doc?.amendmentVersion;
  return typeof v === 'number' && v > 0 ? v : 1;
}

/** The chain a document belongs to. Its own id when it has never been amended. */
export function documentChainId(doc: DocumentAmendmentMeta & { id: string }): string {
  return doc.amendmentChainId || doc.id;
}

/**
 * Has this document been replaced by a later version?
 *
 * Read from the LINK rather than from the status, so it stays true for a
 * document whose status field a future migration renames. The status is what
 * reports filter on; this is what the amendment workflow reasons about.
 */
export function isSupersededDocument(doc: DocumentAmendmentMeta): boolean {
  return !!doc.supersededByDocumentId;
}

/* ── Eligibility ──────────────────────────────────────────────────────────── */

export type AmendmentBlockerKind =
  /** Not a posted document — drafts use the ordinary editor. */
  | 'not_posted'
  /** Already superseded, voided or reversed: history, not a live document. */
  | 'not_current'
  /** The books for the document's date are closed or the return is filed. */
  | 'locked_period'
  | 'filed_tax_return'
  /** Cleared, submitted or otherwise externally identified. */
  | 'external_einvoice'
  /** A settlement that cannot be carried across to the replacement. */
  | 'reconciled_settlement'
  | 'non_transferable_allocation'
  /** Stock this document moved has been consumed, transferred or counted. */
  | 'inventory_dependency'
  /** The company's records for this document type are held on the server. */
  | 'server_backend'
  /** The acting user does not hold the amendment permission. */
  | 'permission'
  /** The subscription does not currently permit new posting. */
  | 'subscription'
  /** Something the checker could not answer. Never read as "no dependency". */
  | 'indeterminate';

export type AmendmentSeverity =
  /** The amendment must not proceed. */
  | 'blocks'
  /** It may proceed, but the operator must be shown and accept the effect. */
  | 'requires_confirmation';

export interface AmendmentBlocker {
  kind: AmendmentBlockerKind;
  severity: AmendmentSeverity;
  /** The record or rule holding the dependency, e.g. `Receipt REC-0007`. */
  sourceLabel: string;
  /** The sentence the operator reads. */
  message: string;
  /** The corrective workflow to use instead, when one exists. */
  correctiveWorkflow?: string;
}

export interface AmendmentAssessment {
  documentType: AmendableDocumentType;
  documentId: string;
  documentNumber: string;
  /** The posting/document date the period rules are evaluated against. */
  documentDate: string;
  /** The token a confirmation must echo back (optimistic concurrency). */
  version: number;
  /** True only when the workflow may be started at all. */
  eligible: boolean;
  /** Everything found, whatever the verdict. Always shown, never summarised away. */
  findings: AmendmentBlocker[];
  /** The subset that stops the amendment. */
  blockers: AmendmentBlocker[];
  /** The subset the operator must acknowledge before confirming. */
  confirmations: AmendmentBlocker[];
  /** The one-line reason an ineligible action is disabled, for the menu. */
  reason: string;
  /** What the amendment would touch, for the impact summary. */
  impact: AmendmentImpact;
}

/** The accounting, settlement, tax and inventory footprint of a document. */
export interface AmendmentImpact {
  originalJournalEntryId?: string;
  originalJournalEntryNumber?: string;
  /** Settlement recorded against the document at assessment time. */
  settlement: {
    grandTotal: number;
    amountSettled: number;
    balanceDue: number;
    /** Allocations that would be carried across to the replacement. */
    transferable: SettlementAllocationRef[];
    /** Allocations that cannot be carried across, with the reason. */
    blocked: SettlementAllocationRef[];
  };
  /** Stock documents this document created, and whether they can be reversed. */
  inventory: {
    documentIds: string[];
    movementCount: number;
    reversible: boolean;
    blockReason?: string;
  };
  /** Tax period covering the document date, when one exists. */
  tax: {
    periodLabel?: string;
    periodStatus?: string;
    /** External e-invoicing state, when the deployment has an integration. */
    externalSubmission?: string;
  };
}

export interface SettlementAllocationRef {
  kind: 'receipt' | 'payment' | 'credit-note' | 'supplier-credit' | 'direct';
  id: string;
  label: string;
  amount: number;
  /** Why it cannot be carried across. Only on blocked allocations. */
  reason?: string;
}

/* ── The amendment itself ─────────────────────────────────────────────────── */

/** One field that changed, as the audit panel shows it. */
export interface DocumentFieldChange {
  field: string;
  label: string;
  before: string;
  after: string;
}

/** What the caller asks for. Everything is validated before anything is written. */
export interface AmendmentRequest {
  documentType: AmendableDocumentType;
  documentId: string;
  /** Mandatory, recorded permanently. */
  reason: string;
  /** The version the drawer read when it opened. A mismatch is refused. */
  expectedVersion: number;
  /**
   * What the document looked like when the drawer read it.
   *
   * The version alone only moves when the document is AMENDED, so it would miss
   * a payment recorded, a credit applied or a receipt allocated while the
   * amendment sat open — all of which change what is being amended and what the
   * settlement transfer has to carry across. `amendmentFingerprint` produces
   * this; a mismatch is refused. Optional, so a caller with no fingerprint to
   * state still gets the version check.
   */
  expectedFingerprint?: string;
  /**
   * Idempotency key for this attempt. A repeat with the same key returns the
   * first attempt's result instead of posting a second reversal.
   */
  correlationId: string;
  /** The corrected values. Only amendable fields are honoured. */
  patch: Record<string, unknown>;
  /** The operator has seen the impact summary and confirmed. */
  confirmed: boolean;
}

export interface AmendmentResult {
  ok: boolean;
  error?: string;
  /** The replacement document. */
  replacementId?: string;
  replacementNumber?: string;
  reversalJournalEntryId?: string;
  replacementJournalEntryId?: string;
  auditEventId?: string;
  /** True when this call returned a previous attempt's result unchanged. */
  idempotentReplay?: boolean;
  /** Present when the refusal was a stale-version conflict. */
  conflict?: { currentVersion: number; expectedVersion: number };
}

/* ── Audit ────────────────────────────────────────────────────────────────── */

export type AmendmentOutcome = 'succeeded' | 'failed' | 'cancelled' | 'rejected';

/**
 * One amendment attempt, successful or not.
 *
 * Append-only by construction: the store that holds these exposes no update and
 * no delete, and every event carries a checksum over its own content and the
 * previous event's checksum. See `lib/amendmentAudit` for exactly what that
 * does and does not guarantee while the books live in the browser.
 */
export interface AmendmentAuditEvent {
  id: string;
  /** Position in the chain, from 1. */
  sequence: number;
  at: string;

  /** Tenant and company the document belongs to. */
  organizationId: string;
  companyId: string;

  documentType: AmendableDocumentType;
  documentId: string;
  documentNumber: string;
  originalVersion: number;
  /**
   * The three dates a period correction has to be explainable by.
   *
   * `documentDate` is when the original was dated; `at` (above) is when the
   * amendment was made; `reversalPostingDate` is the period the withdrawal
   * lands in — which is the ORIGINAL's period, deliberately, so a correction
   * restates the month the effect belonged to rather than moving revenue
   * between two of them. A reader who has only one of the three cannot tell
   * which period moved and why.
   */
  documentDate: string;
  reversalPostingDate?: string;

  replacementDocumentId?: string;
  replacementDocumentNumber?: string;
  replacementVersion?: number;

  originalJournalEntryId?: string;
  reversalJournalEntryId?: string;
  replacementJournalEntryId?: string;

  actorUserId?: string;
  actorName: string;
  actorRole: OrganizationRole;
  /** True when a platform operator acted inside the subscriber's workspace. */
  actedAsPlatformOperator: boolean;

  reason: string;
  changes: DocumentFieldChange[];

  settlementEffect: SettlementAllocationRef[];
  inventoryEffect: {
    reversedDocumentIds: string[];
    replacementDocumentIds: string[];
    movementCount: number;
  };
  taxStatus: {
    periodLabel?: string;
    periodStatus?: string;
    externalSubmission?: string;
  };

  outcome: AmendmentOutcome;
  failureReason?: string;
  correlationId: string;

  /** Checksum of the previous event. `''` for the first. */
  previousChecksum: string;
  /** Checksum of this event's own content chained onto `previousChecksum`. */
  checksum: string;
}

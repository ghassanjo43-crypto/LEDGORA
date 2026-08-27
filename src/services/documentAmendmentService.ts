/**
 * Amending a posted document: the orchestration.
 *
 * ══ The rule ═════════════════════════════════════════════════════════════════
 *
 * A posted document is never overwritten. An authorized user amends one by
 * reversing its posting and posting a corrected replacement, with the original
 * document, its number, its lines, its taxes, its journal entry and its
 * settlement history all preserved and all linked to what replaced them.
 *
 * ══ What this file does and does not do ══════════════════════════════════════
 *
 * It ORCHESTRATES. Every accounting act inside it belongs to a module that
 * already owned it:
 *
 *   the reversal            → `journalStore.reverseForSourceDocument`
 *   the replacement posting → `invoiceStore.issueInvoice`, `billStore.postBill`,
 *                             `creditNoteStore.issueCreditNote`,
 *                             `billStore.createSupplierCredit`
 *   the replacement number  → each module's existing numbering sequence
 *   stock reversal          → `inventoryStore.reverseDocument`
 *   stock reposting         → the module's own posting path, unchanged
 *   eligibility             → `lib/documentAmendmentProbes`
 *   permission              → `lib/amendmentPermissions`
 *
 * There is no second ledger here, no second posting engine, no second numbering
 * counter and no second permission model. What is genuinely new is the SEQUENCE
 * and its all-or-nothing property.
 *
 * ══ The order, and why it is that order ══════════════════════════════════════
 *
 *   1. authorise, assess, check the version, check for a replay
 *   2. build the replacement DRAFT and apply the corrected values
 *      — nothing has reached the ledger yet, so a bad draft costs nothing
 *   3. reverse the original's stock movements
 *      — before the replacement issues stock, or the replacement would be
 *        refused for stock the original is still holding
 *   4. reverse the original's journal entry, posted, dated with the original
 *   5. mark the original superseded
 *      — before the replacement posts, so validations that count "other live
 *        documents" (credit available against an invoice, duplicate supplier
 *        invoice numbers) do not count the document being replaced
 *   6. post the replacement through the module's own posting path
 *   7. move the settlement allocations across, refusing to over-allocate
 *   8. link the chain and write the audit event
 *
 * Any failure at any step rolls every store back to where it started, so a
 * partial amendment cannot remain. `services/amendmentTransaction` documents
 * exactly how far that guarantee reaches while the books are in the browser.
 */
import type {
  AmendableDocumentType,
  AmendmentAssessment,
  AmendmentAuditEvent,
  AmendmentRequest,
  AmendmentResult,
  DocumentAmendmentMeta,
  DocumentFieldChange,
  SettlementAllocationRef,
} from '@/types/documentAmendment';
import { DOCUMENT_TYPE_LABELS, documentChainId, documentVersion } from '@/types/documentAmendment';
import type { Invoice, InvoicePayment } from '@/types/invoice';
import type { Bill, BillPayment, BillSupplierCredit } from '@/types/bill';
import type { CreditNote, CreditApplication, CreditNoteRefund } from '@/types/creditNote';
import {
  assessDocumentAmendment,
  diffDocuments,
  pickAmendableFields,
  validateAmendmentReason,
  orderChain,
  type ChainMember,
} from '@/lib/documentAmendment';
import {
  billSubject,
  collectAmendmentFindings,
  creditNoteSubject,
  invoiceSubject,
  supplierDebitNoteSubject,
  type ProbeSubject,
} from '@/lib/documentAmendmentProbes';
import { resolveDocumentAmendmentPermission } from '@/lib/amendmentPermissions';
import { permissionInput, readAmendmentContext, type AmendmentContext } from '@/lib/amendmentContext';
import { currentAmendmentPolicy } from '@/store/amendmentPolicyStore';
import { useAmendmentAuditStore } from '@/store/amendmentAuditStore';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useBillStore } from '@/store/billStore';
import { useCreditNoteStore } from '@/store/creditNoteStore';
import { useReceiptStore } from '@/store/receiptStore';
import { usePaymentStore } from '@/store/paymentStore';
import { useInventoryStore } from '@/store/inventoryStore';
import { useJournalStore } from '@/store/journalStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useStore } from '@/store/useStore';
import { captureSnapshot } from '@/services/amendmentTransaction';
import { generateId, nowIso } from '@/lib/utils';
import { roundToCompanyPrecision } from '@/lib/monetaryPrecision';
import { balanceToleranceFor } from '@/lib/journalValidation';

/* ── Small shared readers ─────────────────────────────────────────────────── */

const entityName = (id: unknown): string =>
  useEntityStore.getState().entities.find((e) => e.id === id)?.legalName ?? String(id ?? '—');

const accountName = (id: unknown): string => {
  const account = useStore.getState().accounts.find((a) => a.id === id);
  return account ? `${account.code} ${account.name}` : String(id ?? '—');
};

const labels = { entityName, accountName };

const NOT_FOUND = (type: AmendableDocumentType): string =>
  `That ${DOCUMENT_TYPE_LABELS[type].toLowerCase()} is not in this company's books.`;

/* ── Loading, scoped to the active workspace and company ──────────────────── */

/**
 * Find the document — and, by construction, find nothing outside this tenant.
 *
 * The lookup is by id INSIDE the store's own array. Those stores persist
 * through the workspace-namespaced adapter and hold exactly one company's books
 * at a time (`companyStore` swaps them in and out), so an id belonging to
 * another organization, or to another company in this organization, is simply
 * not in the array being searched. A client-supplied identifier cannot reach
 * another tenant's document because there is no array it could be found in.
 *
 * The `entityId` check on top of that catches a record that was imported or
 * migrated carrying a foreign issuing entity.
 */
interface Loaded {
  subject: ProbeSubject;
  /** The document itself, for the diff and the replacement. */
  document: Invoice | Bill | CreditNote | BillSupplierCredit;
  /** For a supplier debit note, the bill that holds it. */
  parentBill?: Bill;
  entityId?: string;
}

function load(type: AmendableDocumentType, id: string): Loaded | undefined {
  if (type === 'invoice') {
    const invoice = useInvoiceStore.getState().invoices.find((i) => i.id === id);
    return invoice ? { subject: invoiceSubject(invoice), document: invoice, entityId: invoice.entityId } : undefined;
  }
  if (type === 'bill') {
    const bill = useBillStore.getState().bills.find((b) => b.id === id);
    return bill ? { subject: billSubject(bill), document: bill, entityId: bill.entityId } : undefined;
  }
  if (type === 'credit-note') {
    const note = useCreditNoteStore.getState().creditNotes.find((c) => c.id === id);
    return note ? { subject: creditNoteSubject(note), document: note, entityId: note.entityId } : undefined;
  }
  /*
   * A supplier debit note can appear on two bills at once, with the same id.
   *
   * When a bill is amended its debit notes move to the replacement — one note,
   * still settling the same payable — and the superseded bill keeps its own
   * copy as the historical record of what it looked like. So the lookup must
   * prefer the bill that is IN FORCE: the copy on the superseded bill is
   * history, and `createSupplierCredit` would refuse to raise a corrected note
   * against a bill that is no longer live.
   */
  const bills = useBillStore.getState().bills;
  const live = bills.filter((b) => !isRetiredBill(b));
  for (const bill of [...live, ...bills.filter((b) => isRetiredBill(b))]) {
    const credit = (bill.supplierCredits ?? []).find((c) => c.id === id);
    if (credit) {
      return {
        subject: supplierDebitNoteSubject(credit),
        document: credit,
        parentBill: bill,
        entityId: bill.entityId,
      };
    }
  }
  return undefined;
}

/** A bill whose own effect has been withdrawn, so its sub-records are history. */
function isRetiredBill(bill: Bill): boolean {
  return bill.status === 'superseded' || bill.status === 'void' || bill.status === 'reversed';
}

/** The company's own issuing entity. Anything else is not this company's book. */
function activeIssuingEntityId(): string {
  return 'primary';
}

/**
 * A fingerprint of everything about a document that an amendment depends on.
 *
 * A timestamp alone is not enough — two writes inside the same millisecond
 * produce the same `updatedAt`, and an amendment drawer that opened before a
 * receipt was allocated would sail past the check. So the settlement figures,
 * the status and the line count are folded in: any change that would alter what
 * the amendment carries across changes the fingerprint.
 */
function fingerprintOf(loaded: Loaded): string {
  const doc = loaded.document as unknown as Record<string, unknown>;
  const parts = [
    documentVersion(loaded.document as DocumentAmendmentMeta),
    String(doc.updatedAt ?? ''),
    loaded.subject.status,
    loaded.subject.grandTotal,
    loaded.subject.balanceDue,
    loaded.subject.settlements.length,
    loaded.subject.settlements.reduce((sum, s) => sum + s.amount, 0),
    Array.isArray(doc.lines) ? (doc.lines as unknown[]).length : 0,
  ];
  return parts.join('|');
}

/**
 * The fingerprint a screen captures when it opens an amendment, and echoes back
 * when it confirms. Returns `undefined` for a document that is not there.
 */
export function amendmentFingerprint(type: AmendableDocumentType, id: string): string | undefined {
  const loaded = load(type, id);
  return loaded ? fingerprintOf(loaded) : undefined;
}

/* ── Assessment ───────────────────────────────────────────────────────────── */

/**
 * What would happen, and whether it may happen — a pure read.
 *
 * The drawer calls this before it opens and the menu calls it to decide whether
 * to offer a disabled action with a reason. `amendPostedDocument` re-runs it
 * internally, so the verdict a caller saw can never be the one that is acted on.
 */
export function assessAmendment(
  type: AmendableDocumentType,
  id: string,
): AmendmentAssessment | null {
  const loaded = load(type, id);
  if (!loaded) return null;

  const findings = collectAmendmentFindings(loaded.subject);
  const extra = [...findings.findings];

  /* Permission is a finding like any other, so the menu can say WHY. */
  const context = readAmendmentContext();
  const permitted = resolveDocumentAmendmentPermission(
    permissionInput(context, currentAmendmentPolicy()),
    type,
  );
  if (!permitted.allowed) {
    extra.push({
      kind: permitted.source === 'subscription_inactive' ? 'subscription' : 'permission',
      severity: 'blocks',
      sourceLabel: context.role,
      message: permitted.error ?? 'You do not have permission to amend this document.',
    });
  }

  /*
   * A company whose invoices are held on the server. The browser has no
   * amendment path for those and must not pretend to: writing here would leave
   * localStorage disagreeing with the database, with the local copy silently
   * winning until the next sync discarded it. Refused visibly, following the
   * same rule `invoiceStore`'s other server-backed refusals follow.
   */
  if (type === 'invoice' && useInvoiceStore.getState().backend === 'server') {
    extra.push({
      kind: 'server_backend',
      severity: 'blocks',
      sourceLabel: loaded.subject.number,
      message:
        'This company’s invoices are held on the server, where the amendment workflow is not available yet. '
        + 'No change was made.',
      correctiveWorkflow: 'Void the invoice and issue a corrected one, or amend it from a browser-backed company.',
    });
  }

  if (loaded.entityId && loaded.entityId !== activeIssuingEntityId()) {
    extra.push({
      kind: 'permission',
      severity: 'blocks',
      sourceLabel: loaded.subject.number,
      message: 'This document belongs to another company’s books and cannot be amended from here.',
    });
  }

  return assessDocumentAmendment({
    documentType: type,
    documentId: loaded.subject.id,
    documentNumber: loaded.subject.number,
    documentDate: loaded.subject.date,
    version: documentVersion(loaded.document as DocumentAmendmentMeta),
    findings: extra,
    impact: findings.impact,
  });
}

/* ── The version chain ────────────────────────────────────────────────────── */

/**
 * Every version of a document, oldest first, whichever version is asked for.
 *
 * Walks by `amendmentChainId`, which every version carries and which never
 * changes, so search and drill-down find the original and every amendment from
 * any one of them.
 */
export function amendmentChain(type: AmendableDocumentType, id: string): ChainMember[] {
  const loaded = load(type, id);
  if (!loaded) return [];
  const root = documentChainId(loaded.document as DocumentAmendmentMeta & { id: string });

  const member = (
    doc: DocumentAmendmentMeta & { id: string },
    number: string,
    status: string,
    date: string,
    total: number,
    journalEntryId?: string,
  ): ChainMember => ({
    id: doc.id,
    number,
    version: documentVersion(doc),
    status,
    date,
    total,
    journalEntryId,
    reversalJournalEntryId: doc.amendmentReversalJournalEntryId,
    amendmentReason: doc.amendmentReason,
    supersededAt: doc.supersededAt,
    current: !doc.supersededByDocumentId,
  });

  const inChain = <T extends DocumentAmendmentMeta & { id: string }>(doc: T): boolean =>
    documentChainId(doc) === root;

  if (type === 'invoice') {
    return orderChain(
      useInvoiceStore.getState().invoices.filter(inChain).map((i) =>
        member(i, i.invoiceNumber, i.status, i.issueDate, i.grandTotal, i.journalEntryId)),
    );
  }
  if (type === 'bill') {
    return orderChain(
      useBillStore.getState().bills.filter(inChain).map((b) =>
        member(b, b.billNumber, b.status, b.postingDate || b.billDate, b.grandTotal, b.journalEntryId)),
    );
  }
  if (type === 'credit-note') {
    return orderChain(
      useCreditNoteStore.getState().creditNotes.filter(inChain).map((c) =>
        member(c, c.creditNoteNumber, c.status, c.issueDate, c.grandTotal, c.journalEntryId)),
    );
  }
  /*
   * De-duplicated by id, preferring the copy on the bill in force: the same
   * debit note exists on a superseded bill and on its replacement, and a
   * version history that listed it twice would read as two notes.
   */
  const byId = new Map<string, BillSupplierCredit>();
  for (const bill of useBillStore.getState().bills) {
    for (const credit of bill.supplierCredits ?? []) {
      if (!inChain(credit)) continue;
      if (byId.has(credit.id) && isRetiredBill(bill)) continue;
      byId.set(credit.id, credit);
    }
  }
  return orderChain(
    [...byId.values()]
      .map((c) =>
        member(
          c,
          c.creditNumber,
          c.supersededByDocumentId ? 'superseded' : 'posted',
          c.date,
          c.amount,
          c.journalEntryId,
        )),
  );
}

/* ── Audit ────────────────────────────────────────────────────────────────── */

interface AuditInput {
  context: AmendmentContext;
  type: AmendableDocumentType;
  subject: ProbeSubject;
  originalVersion: number;
  request: Pick<AmendmentRequest, 'reason' | 'correlationId'>;
  outcome: AmendmentAuditEvent['outcome'];
  failureReason?: string;
  changes?: DocumentFieldChange[];
  replacement?: { id: string; number: string; version: number; journalEntryId?: string };
  reversalJournalEntryId?: string;
  settlementEffect?: SettlementAllocationRef[];
  inventoryEffect?: AmendmentAuditEvent['inventoryEffect'];
  taxStatus?: AmendmentAuditEvent['taxStatus'];
}

/**
 * Record the attempt.
 *
 * Called on EVERY exit path, including refusals — a rejected attempt to restate
 * a posted invoice is exactly the thing an auditor wants to see, and a trail
 * that only records successes cannot show that anyone tried.
 */
function recordAttempt(input: AuditInput): AmendmentAuditEvent {
  return useAmendmentAuditStore.getState().append({
    id: generateId('amd'),
    at: nowIso(),
    organizationId: input.context.organizationId,
    companyId: input.context.companyId,
    documentType: input.type,
    documentId: input.subject.id,
    documentNumber: input.subject.number,
    originalVersion: input.originalVersion,
    documentDate: input.subject.date,
    reversalPostingDate: input.reversalJournalEntryId
      ? useJournalStore.getState().entries.find((e) => e.id === input.reversalJournalEntryId)?.entryDate
      : undefined,
    replacementDocumentId: input.replacement?.id,
    replacementDocumentNumber: input.replacement?.number,
    replacementVersion: input.replacement?.version,
    originalJournalEntryId: input.subject.journalEntryId,
    reversalJournalEntryId: input.reversalJournalEntryId,
    replacementJournalEntryId: input.replacement?.journalEntryId,
    actorUserId: input.context.userId,
    actorName: input.context.actorName,
    actorRole: input.context.role,
    actedAsPlatformOperator: input.context.actingAsPlatformOperator,
    reason: input.request.reason.trim(),
    changes: input.changes ?? [],
    settlementEffect: input.settlementEffect ?? [],
    inventoryEffect: input.inventoryEffect ?? {
      reversedDocumentIds: [],
      replacementDocumentIds: [],
      movementCount: 0,
    },
    taxStatus: input.taxStatus ?? {},
    outcome: input.outcome,
    failureReason: input.failureReason,
    correlationId: input.request.correlationId,
  });
}

/* ── Settlement transfer ──────────────────────────────────────────────────── */

const tolerance = (): number => balanceToleranceFor();

/**
 * Whether what is already settled still fits the corrected document.
 *
 * The one arithmetic rule the transfer has to obey: an allocation that no
 * longer fits is not silently trimmed and not silently dropped. Both would lose
 * money that a customer actually paid. The amendment is refused instead, with
 * the corrective workflow named.
 */
function assertFits(settled: number, replacementTotal: number, documentLabel: string): string | undefined {
  if (settled <= replacementTotal + tolerance()) return undefined;
  return (
    `The corrected ${documentLabel} totals ${replacementTotal.toFixed(2)} but ${settled.toFixed(2)} is already settled against the original. `
    + 'Carrying the settlement across would over-allocate it, so the amendment is refused and nothing has changed. '
    + 'Unapply or refund the excess first, or raise a credit note for the difference instead of amending.'
  );
}

/* ── The amendment ────────────────────────────────────────────────────────── */

/**
 * Amend a posted document.
 *
 * Async because the invoice store's lifecycle actions are: a server-backed
 * company posts over the network, and the same API serves both backends so no
 * caller has to know which is which.
 */
export async function amendPostedDocument(request: AmendmentRequest): Promise<AmendmentResult> {
  const context = readAmendmentContext();

  /*
   * Idempotency, checked FIRST — and only against a SUCCESS.
   *
   * A double-clicked confirmation, a retried request, a component that mounts
   * twice: each would otherwise post a second reversal and a second
   * replacement, and the books would carry two corrections for one mistake. The
   * correlation id is minted once when the drawer opens, so a repeat of a
   * completed amendment returns what the first one did.
   *
   * A previous FAILURE is deliberately not replayed. Every failed attempt is
   * rolled back completely, so it left nothing behind to be idempotent about —
   * and the operator's next move after "the corrected total is smaller than
   * what is already settled" is to go back, fix it and confirm again, in the
   * same drawer, under the same id. Replaying the refusal would make that
   * impossible and the drawer permanently dead.
   */
  const replay = useAmendmentAuditStore.getState().findCompleted(request.correlationId);
  if (replay) {
    return {
      ok: true,
      replacementId: replay.replacementDocumentId,
      replacementNumber: replay.replacementDocumentNumber,
      reversalJournalEntryId: replay.reversalJournalEntryId,
      replacementJournalEntryId: replay.replacementJournalEntryId,
      auditEventId: replay.id,
      idempotentReplay: true,
    };
  }

  const loaded = load(request.documentType, request.documentId);
  if (!loaded) return { ok: false, error: NOT_FOUND(request.documentType) };

  const subject = loaded.subject;
  const originalVersion = documentVersion(loaded.document as DocumentAmendmentMeta);
  const audit = (
    outcome: AmendmentAuditEvent['outcome'],
    failureReason: string,
  ): AmendmentAuditEvent =>
    recordAttempt({ context, type: request.documentType, subject, originalVersion, request, outcome, failureReason });

  const reject = (message: string): AmendmentResult => ({
    ok: false,
    error: message,
    auditEventId: audit('rejected', message).id,
  });

  /* 1a. Permission — resolved here AND again inside the journal reversal. */
  const permitted = resolveDocumentAmendmentPermission(
    permissionInput(context, currentAmendmentPolicy()),
    request.documentType,
  );
  if (!permitted.allowed) return reject(permitted.error ?? 'Not permitted.');

  /* 1b. A reason, before anything else is evaluated. */
  const reasonCheck = validateAmendmentReason(request.reason);
  if (!reasonCheck.ok) return reject(reasonCheck.error!);

  /* 1c. The operator must have confirmed. */
  if (!request.confirmed) {
    return reject('The amendment was not confirmed, so nothing was changed.');
  }

  /* 1d. Eligibility, re-run rather than trusted from the caller. */
  const assessment = assessAmendment(request.documentType, request.documentId);
  if (!assessment) return { ok: false, error: NOT_FOUND(request.documentType) };
  if (!assessment.eligible) return reject(assessment.reason);

  /*
   * 1e. Optimistic concurrency.
   *
   * The drawer states the version it read. If the document has moved on since —
   * somebody settled it, amended it, or voided it in another tab — the save is
   * REFUSED rather than merged: the other change is already part of the books,
   * and a last-writer-wins amendment would restate figures on top of it with no
   * record that it had happened.
   */
  if (request.expectedVersion !== originalVersion) {
    const message =
      `This ${DOCUMENT_TYPE_LABELS[request.documentType].toLowerCase()} changed while the amendment was open `
      + `(you were working from version ${request.expectedVersion}; it is now version ${originalVersion}). `
      + 'Review the latest version before amending it.';
    return {
      ok: false,
      error: message,
      auditEventId: audit('rejected', message).id,
      conflict: { currentVersion: originalVersion, expectedVersion: request.expectedVersion },
    };
  }

  /*
   * 1f. Staleness.
   *
   * The version only moves when a document is AMENDED, so on its own it would
   * miss a receipt allocated, a credit applied or a payment recorded while the
   * amendment drawer sat open — every one of which changes what the settlement
   * transfer has to carry across. The timestamp catches those.
   */
  if (request.expectedFingerprint && request.expectedFingerprint !== fingerprintOf(loaded)) {
    const message =
      `This ${DOCUMENT_TYPE_LABELS[request.documentType].toLowerCase()} changed while the amendment was open. `
      + 'Close the amendment and reopen it against the latest version before confirming.';
    return {
      ok: false,
      error: message,
      auditEventId: audit('rejected', message).id,
      conflict: { currentVersion: originalVersion, expectedVersion: request.expectedVersion },
    };
  }

  const patch = pickAmendableFields(request.documentType, request.patch);
  const snapshot = captureSnapshot();

  try {
    const outcome = await execute(request, loaded, patch, context);
    if (!outcome.ok) {
      snapshot.restore();
      return { ok: false, error: outcome.error, auditEventId: audit('failed', outcome.error).id };
    }

    const event = recordAttempt({
      context,
      type: request.documentType,
      subject,
      originalVersion,
      request,
      outcome: 'succeeded',
      changes: outcome.changes,
      replacement: outcome.replacement,
      reversalJournalEntryId: outcome.reversalJournalEntryId,
      settlementEffect: outcome.settlementEffect,
      inventoryEffect: outcome.inventoryEffect,
      taxStatus: assessment.impact.tax,
    });

    /* The chain link to the audit event, written last so it can name the event. */
    outcome.linkAudit(event.id);

    return {
      ok: true,
      replacementId: outcome.replacement.id,
      replacementNumber: outcome.replacement.number,
      reversalJournalEntryId: outcome.reversalJournalEntryId,
      replacementJournalEntryId: outcome.replacement.journalEntryId,
      auditEventId: event.id,
    };
  } catch (cause) {
    snapshot.restore();
    const message =
      cause instanceof Error
        ? `The amendment failed and every change was rolled back: ${cause.message}`
        : 'The amendment failed and every change was rolled back.';
    return { ok: false, error: message, auditEventId: audit('failed', message).id };
  }
}

/* ── Execution, per document classification ───────────────────────────────── */

interface ExecutionSuccess {
  ok: true;
  replacement: { id: string; number: string; version: number; journalEntryId?: string };
  reversalJournalEntryId: string;
  changes: DocumentFieldChange[];
  settlementEffect: SettlementAllocationRef[];
  inventoryEffect: AmendmentAuditEvent['inventoryEffect'];
  /** Stamp the audit event id onto both versions once the event exists. */
  linkAudit: (eventId: string) => void;
}
type Execution = ExecutionSuccess | { ok: false; error: string };

function execute(
  request: AmendmentRequest,
  loaded: Loaded,
  patch: Record<string, unknown>,
  context: AmendmentContext,
): Promise<Execution> {
  switch (request.documentType) {
    case 'invoice':
      return amendInvoice(request, loaded.document as Invoice, patch);
    case 'bill':
      return amendBill(request, loaded.document as Bill, patch);
    case 'credit-note':
      return amendCreditNote(request, loaded.document as CreditNote, patch);
    default:
      return amendSupplierDebitNote(request, loaded.parentBill!, loaded.document as BillSupplierCredit, patch, context);
  }
}

/** Reverse a document's stock, through the existing engine, or refuse. */
function reverseInventory(documentIds: string[]): { ok: boolean; error?: string; movementCount: number } {
  let movementCount = 0;
  for (const id of documentIds) {
    const doc = useInventoryStore.getState().documents.find((d) => d.id === id);
    if (!doc || doc.status === 'reversed') continue;
    movementCount += doc.movementIds.length;
    const result = useInventoryStore.getState().reverseDocument(id);
    if (!result.ok) return { ok: false, error: result.error, movementCount };
  }
  return { ok: true, movementCount };
}

/** The posted reversal of a document's journal entry, through the journal store. */
function reverseJournal(
  type: AmendableDocumentType,
  documentId: string,
  documentNumber: string,
  journalEntryId: string,
  reason: string,
): { ok: boolean; error?: string; id?: string } {
  return useJournalStore.getState().reverseForSourceDocument(journalEntryId, {
    sourceDocumentType: type,
    sourceDocumentId: documentId,
    sourceDocumentNumber: documentNumber,
    reason,
  });
}

/** The metadata a superseded original gains. Its figures are never touched. */
function supersededMeta(
  replacementId: string,
  replacementNumber: string,
  reversalJournalEntryId: string,
  reason: string,
  inventoryReversalId: string | undefined,
  now: string,
): DocumentAmendmentMeta {
  return {
    supersededByDocumentId: replacementId,
    supersededByDocumentNumber: replacementNumber,
    supersededAt: now,
    amendmentReason: reason.trim(),
    amendmentReversalJournalEntryId: reversalJournalEntryId,
    ...(inventoryReversalId ? { amendmentInventoryReversalId: inventoryReversalId } : {}),
  };
}

/**
 * The metadata a replacement carries — every field of it, explicitly.
 *
 * Each module's `duplicate*` action structurally copies the source document,
 * which on a SECOND amendment means the new draft arrives already carrying
 * version 2's links: its `supersededByDocumentId`, its reversal journal, its
 * own `amendsDocumentId`. Returning a partial patch would leave those in place
 * and produce a version 3 that claims to have been superseded by version 2.
 * So every field is set, including the ones that must be cleared.
 */
function replacementMeta(
  original: DocumentAmendmentMeta & { id: string },
  originalNumber: string,
  reason: string,
): Required<Pick<DocumentAmendmentMeta, 'amendmentVersion' | 'amendmentChainId' | 'amendsDocumentId' | 'amendsDocumentNumber' | 'amendmentReason'>> & DocumentAmendmentMeta {
  return {
    amendmentVersion: documentVersion(original) + 1,
    amendmentChainId: documentChainId(original),
    amendsDocumentId: original.id,
    amendsDocumentNumber: originalNumber,
    amendmentReason: reason.trim(),
    supersededByDocumentId: undefined,
    supersededByDocumentNumber: undefined,
    supersededAt: undefined,
    amendmentReversalJournalEntryId: undefined,
    amendmentInventoryReversalId: undefined,
    amendmentAuditEventId: undefined,
  };
}

/* ── Sales invoice ────────────────────────────────────────────────────────── */

async function amendInvoice(
  request: AmendmentRequest,
  original: Invoice,
  patch: Record<string, unknown>,
): Promise<Execution> {
  const store = useInvoiceStore.getState();
  const now = nowIso();

  /* 2. The replacement draft, from the module's own duplicate + numbering. */
  const dup = store.duplicateInvoice(original.id);
  if (!dup.ok || !dup.id) return { ok: false, error: dup.error ?? 'Could not create the amended invoice.' };
  const replacementId = dup.id;

  /*
   * The chain is stamped onto the draft immediately, before anything else
   * touches it. Two reasons: `duplicateInvoice` copies the source structurally
   * and would otherwise leave a re-amended document wearing the previous
   * version's links, and the stores use `amendsDocumentId` to recognise an
   * amendment draft when they decide who may edit it.
   */
  markInvoice(replacementId, (invoice) => ({
    ...invoice,
    ...replacementMeta(original, original.invoiceNumber, request.reason),
  }));

  /*
   * The dates come from the ORIGINAL unless the amendment changes them.
   * `duplicateInvoice` stamps today, which is right for a genuine duplicate and
   * wrong here: an amendment corrects a document that was issued on a
   * particular day, and moving it to today would move revenue between periods
   * as a side effect of fixing a typo.
   */
  const applied = await useInvoiceStore.getState().updateDraft(replacementId, {
    issueDate: original.issueDate,
    dueDate: original.dueDate,
    ...patch,
    lines: (patch.lines as Invoice['lines'] | undefined)
      ?? original.lines.map((l) => ({ ...l, id: generateId('iline') })),
  } as Partial<Invoice>);
  if (!applied.ok) return { ok: false, error: applied.error ?? 'The corrected values could not be applied.' };

  /* 3. Stock first, so the replacement can issue the same units again. */
  const inventoryDocumentIds = original.invoiceNumber
    ? useInventoryStore
      .getState()
      .documents.filter((d) => d.kind === 'invoice-issue' && d.reference === original.invoiceNumber && d.status === 'posted')
      .map((d) => d.id)
    : [];
  const stock = reverseInventory(inventoryDocumentIds);
  if (!stock.ok) return { ok: false, error: stock.error! };
  const inventoryReversalId = useInventoryStore
    .getState()
    .documents.find((d) => inventoryDocumentIds.includes(d.reversalOfId ?? ''))?.id;

  /* 4. The ledger reversal — posted, dated with the original. */
  const reversal = reverseJournal('invoice', original.id, original.invoiceNumber, original.journalEntryId!, request.reason);
  if (!reversal.ok || !reversal.id) {
    return { ok: false, error: reversal.error ?? 'Could not reverse the invoice’s journal entry.' };
  }

  /* 5. The original steps aside before the replacement is validated. */
  markInvoice(original.id, (invoice) => ({
    ...invoice,
    status: 'superseded',
    ...supersededMeta(replacementId, replacementNumberOf(replacementId), reversal.id!, request.reason, inventoryReversalId, now),
    auditTrail: [
      ...invoice.auditTrail,
      { id: generateId('iaud'), at: now, action: 'invoice-superseded', detail: request.reason.trim() },
      { id: generateId('iaud'), at: now, action: 'journal-entry-created', detail: `reversal ${reversal.id}` },
    ],
    updatedAt: now,
  }));

  /* 6. Post the replacement through the module's own issuing path. */
  const issued = await useInvoiceStore.getState().issueInvoice(replacementId);
  if (!issued.ok) return { ok: false, error: issued.error ?? 'The amended invoice could not be posted.' };

  const replacement = useInvoiceStore.getState().invoices.find((i) => i.id === replacementId)!;

  /* 7. Carry the settlement across. */
  const settlement = transferInvoiceSettlement(original, replacement);
  if (!settlement.ok) return { ok: false, error: settlement.error! };

  /* 7b. Point the invoice's credit notes at the version now in force. */
  repointCreditNotes(original, replacement);

  /* 8. Link the replacement back to what it amends. */
  markInvoice(replacementId, (invoice) => ({
    ...invoice,
    auditTrail: [
      ...invoice.auditTrail,
      { id: generateId('iaud'), at: now, action: 'invoice-amended', detail: `amends ${original.invoiceNumber}: ${request.reason.trim()}` },
    ],
    updatedAt: now,
  }));
  /* The superseded original could only be told the number once it existed. */
  markInvoice(original.id, (invoice) => ({
    ...invoice,
    supersededByDocumentNumber: replacement.invoiceNumber,
  }));

  const final = useInvoiceStore.getState().invoices.find((i) => i.id === replacementId)!;
  return {
    ok: true,
    replacement: {
      id: replacementId,
      number: final.invoiceNumber,
      version: documentVersion(final),
      journalEntryId: final.journalEntryId,
    },
    reversalJournalEntryId: reversal.id,
    changes: diffDocuments('invoice', original as unknown as Record<string, unknown>, final as unknown as Record<string, unknown>, labels),
    settlementEffect: settlement.moved,
    inventoryEffect: {
      reversedDocumentIds: inventoryDocumentIds,
      replacementDocumentIds: useInventoryStore
        .getState()
        .documents.filter((d) => d.kind === 'invoice-issue' && d.reference === final.invoiceNumber)
        .map((d) => d.id),
      movementCount: stock.movementCount,
    },
    linkAudit: (eventId) => {
      markInvoice(original.id, (i) => ({ ...i, amendmentAuditEventId: eventId }));
      markInvoice(replacementId, (i) => ({ ...i, amendmentAuditEventId: eventId }));
    },
  };
}

function replacementNumberOf(id: string): string {
  return useInvoiceStore.getState().invoices.find((i) => i.id === id)?.invoiceNumber ?? '';
}

/**
 * Write amendment metadata onto one invoice.
 *
 * Direct rather than through a store action deliberately: an action called
 * "rewrite this document's amendment chain" would be a wider hole than this
 * function is, because it would be callable from anywhere. Nothing outside this
 * service writes these fields.
 */
function markInvoice(id: string, update: (invoice: Invoice) => Invoice): void {
  useInvoiceStore.setState((state) => ({
    invoices: state.invoices.map((i) => (i.id === id ? update(i) : i)),
  }));
}

/**
 * Move the settlement from the original to the replacement.
 *
 * Payments, receipts and credit notes keep their own numbers, their own journal
 * entries and their own bank postings; what moves is the ALLOCATION — the
 * subledger link saying which document the money settled. That is the
 * difference between correcting an invoice and interfering with a payment.
 *
 * The original's own `payments` array is left exactly as it was. It is history
 * now, and its status keeps it out of every receivables, statement, aging and
 * allocation-eligibility calculation, so nothing is double-counted by leaving
 * the record intact.
 */
function transferInvoiceSettlement(
  original: Invoice,
  replacement: Invoice,
): { ok: boolean; error?: string; moved: SettlementAllocationRef[] } {
  const moved: SettlementAllocationRef[] = [];
  const payments: InvoicePayment[] = (original.payments ?? []).map((p) => ({
    ...p,
    id: generateId('ipay'),
    invoiceId: replacement.id,
  }));
  const amountPaid = roundToCompanyPrecision(payments.reduce((sum, p) => sum + p.amount, 0));
  const creditsApplied = roundToCompanyPrecision(original.creditsApplied ?? 0);
  const settled = roundToCompanyPrecision(amountPaid + creditsApplied);

  const overAllocated = assertFits(settled, replacement.grandTotal, 'invoice');
  if (overAllocated) return { ok: false, error: overAllocated, moved: [] };

  if (settled <= tolerance()) return { ok: true, moved };

  for (const payment of payments) {
    moved.push({
      kind: payment.receiptId ? 'receipt' : 'direct',
      id: payment.id,
      label: payment.receiptId ? `Receipt allocation ${payment.reference || payment.id}` : `Payment ${payment.reference || payment.id}`,
      amount: payment.amount,
    });
  }

  const balanceDue = roundToCompanyPrecision(replacement.grandTotal - amountPaid - creditsApplied);
  markInvoice(replacement.id, (invoice) => ({
    ...invoice,
    payments,
    amountPaid,
    creditsApplied,
    balanceDue,
    status: balanceDue <= tolerance() ? 'paid' : amountPaid > tolerance() || creditsApplied > tolerance() ? 'partially-paid' : invoice.status,
  }));

  /* Re-point the receipts' own allocations at the replacement. */
  useReceiptStore.setState((state) => ({
    receipts: state.receipts.map((receipt) => {
      if (!receipt.allocations?.some((a) => a.invoiceId === original.id && !a.reversed)) return receipt;
      return {
        ...receipt,
        allocations: receipt.allocations.map((a) =>
          a.invoiceId === original.id && !a.reversed
            ? { ...a, invoiceId: replacement.id, invoiceNumber: replacement.invoiceNumber, updatedAt: nowIso() }
            : a),
      };
    }),
  }));

  /* And the credit notes' applications. */
  useCreditNoteStore.setState((state) => ({
    creditNotes: state.creditNotes.map((note) => {
      if (!note.applications?.some((a) => a.invoiceId === original.id && !a.reversed)) return note;
      const applications: CreditApplication[] = note.applications.map((a) =>
        a.invoiceId === original.id && !a.reversed ? { ...a, invoiceId: replacement.id } : a);
      moved.push({
        kind: 'credit-note',
        id: note.id,
        label: `Credit note ${note.creditNoteNumber}`,
        amount: applications.filter((a) => a.invoiceId === replacement.id && !a.reversed).reduce((s, a) => s + a.amount, 0),
      });
      return { ...note, applications, updatedAt: nowIso() };
    }),
  }));

  return { ok: true, moved };
}

/**
 * Move a credit note's LIVE link from the superseded invoice to its replacement.
 *
 * `originalInvoiceId` is not history — it is the pointer every creditable-balance
 * calculation, validation and drill-down follows. Left on a superseded invoice
 * it makes the credit note a dead end: `validateCreditNoteForIssue` refuses to
 * re-issue a note whose invoice is no longer in force, so amending an invoice
 * would quietly cost every credit note against it the ability to be amended at
 * all. That is the failure, not a preserved fact.
 *
 * `invoiceReferenceSnapshot` is where the history lives, and it is NOT touched:
 * the frozen figures — what the invoice totalled, what had been paid, what had
 * already been credited at the moment this note was issued — stay exactly as
 * they were. `types/creditNote` says in terms that they must.
 */
function repointCreditNotes(original: Invoice, replacement: Invoice): void {
  useCreditNoteStore.setState((state) => ({
    creditNotes: state.creditNotes.map((note) =>
      note.originalInvoiceId === original.id
        ? {
          ...note,
          originalInvoiceId: replacement.id,
          originalInvoiceNumber: replacement.invoiceNumber,
          auditTrail: [
            ...note.auditTrail,
            {
              id: generateId('cnaud'),
              at: nowIso(),
              action: 'linked-invoice-amended',
              detail: `${original.invoiceNumber} was amended; this note now references ${replacement.invoiceNumber}. The frozen invoice reference is unchanged.`,
            },
          ],
          updatedAt: nowIso(),
        }
        : note),
  }));
}

/* ── Purchase bill ────────────────────────────────────────────────────────── */

async function amendBill(
  request: AmendmentRequest,
  original: Bill,
  patch: Record<string, unknown>,
): Promise<Execution> {
  const now = nowIso();
  const dup = useBillStore.getState().duplicateBill(original.id);
  if (!dup.ok || !dup.id) return { ok: false, error: dup.error ?? 'Could not create the amended bill.' };
  const replacementId = dup.id;
  markBill(replacementId, (bill) => ({
    ...bill,
    ...replacementMeta(original, original.billNumber, request.reason),
  }));

  /*
   * `duplicateBill` clears the supplier's own invoice number — right for a
   * duplicate, wrong for an amendment, where the corrected document records the
   * SAME supplier invoice. It is restored unless the amendment changes it.
   */
  const patched = useBillStore.getState().updateDraft(replacementId, {
    supplierInvoiceNumber: original.supplierInvoiceNumber,
    billDate: original.billDate,
    dueDate: original.dueDate,
    ...patch,
    lines: (patch.lines as Bill['lines'] | undefined)
      ?? original.lines.map((l) => ({ ...l, id: generateId('bline'), billId: replacementId })),
  } as Partial<Bill>);
  if (!patched.ok) return { ok: false, error: patched.error ?? 'The corrected values could not be applied.' };

  const inventoryDocumentIds = useInventoryStore
    .getState()
    .documents.filter((d) => d.kind === 'bill-receipt' && d.reference === original.billNumber && d.status === 'posted')
    .map((d) => d.id);
  const stock = reverseInventory(inventoryDocumentIds);
  if (!stock.ok) return { ok: false, error: stock.error! };

  const reversal = reverseJournal('bill', original.id, original.billNumber, original.journalEntryId!, request.reason);
  if (!reversal.ok || !reversal.id) {
    return { ok: false, error: reversal.error ?? 'Could not reverse the bill’s journal entry.' };
  }

  /*
   * Superseded BEFORE the replacement posts, so the duplicate-supplier-invoice
   * check does not see the document being replaced as a rival record of the
   * same supplier invoice.
   */
  markBill(original.id, (bill) => ({
    ...bill,
    status: 'superseded',
    ...supersededMeta(replacementId, '', reversal.id!, request.reason, undefined, now),
    auditTrail: [
      ...bill.auditTrail,
      { id: generateId('baud'), at: now, action: 'bill-superseded', detail: request.reason.trim() },
      { id: generateId('baud'), at: now, action: 'journal-created', detail: `reversal ${reversal.id}` },
    ],
    updatedAt: now,
  }));

  const posted = useBillStore.getState().postBill(replacementId);
  if (!posted.ok) return { ok: false, error: posted.error ?? 'The amended bill could not be posted.' };

  const replacement = useBillStore.getState().bills.find((b) => b.id === replacementId)!;
  const settlement = transferBillSettlement(original, replacement);
  if (!settlement.ok) return { ok: false, error: settlement.error! };

  markBill(replacementId, (bill) => ({
    ...bill,
    auditTrail: [
      ...bill.auditTrail,
      { id: generateId('baud'), at: now, action: 'bill-amended', detail: `amends ${original.billNumber}: ${request.reason.trim()}` },
    ],
    updatedAt: now,
  }));
  markBill(original.id, (bill) => ({ ...bill, supersededByDocumentNumber: replacement.billNumber }));

  const final = useBillStore.getState().bills.find((b) => b.id === replacementId)!;
  return {
    ok: true,
    replacement: {
      id: replacementId,
      number: final.billNumber,
      version: documentVersion(final),
      journalEntryId: final.journalEntryId,
    },
    reversalJournalEntryId: reversal.id,
    changes: diffDocuments('bill', original as unknown as Record<string, unknown>, final as unknown as Record<string, unknown>, labels),
    settlementEffect: settlement.moved,
    inventoryEffect: {
      reversedDocumentIds: inventoryDocumentIds,
      replacementDocumentIds: useInventoryStore
        .getState()
        .documents.filter((d) => d.kind === 'bill-receipt' && d.reference === final.billNumber)
        .map((d) => d.id),
      movementCount: stock.movementCount,
    },
    linkAudit: (eventId) => {
      markBill(original.id, (b) => ({ ...b, amendmentAuditEventId: eventId }));
      markBill(replacementId, (b) => ({ ...b, amendmentAuditEventId: eventId }));
    },
  };
}

/**
 * The expense/inventory account a supplier debit note credited.
 *
 * The note's journal debits payables and credits the account being reversed
 * (plus input tax). The payables and tax accounts come from the bill's own
 * posting config, so the remaining credit line is the one being looked for.
 */
function originalCreditAccount(credit: BillSupplierCredit): string {
  if (!credit.journalEntryId) return '';
  const entry = useJournalStore.getState().entries.find((e) => e.id === credit.journalEntryId);
  if (!entry) return '';
  const credits = entry.lines.filter((l) => (Number(l.credit) || 0) > 0);
  // The largest credit that is not the tax line: tax is `taxAmount`, the rest
  // is the net being reversed.
  const net = credits.find((l) => Math.abs((Number(l.credit) || 0) - credit.netAmount) < 0.005);
  return net?.accountId ?? credits[0]?.accountId ?? '';
}

function markBill(id: string, update: (bill: Bill) => Bill): void {
  useBillStore.setState((state) => ({ bills: state.bills.map((b) => (b.id === id ? update(b) : b)) }));
}

function transferBillSettlement(
  original: Bill,
  replacement: Bill,
): { ok: boolean; error?: string; moved: SettlementAllocationRef[] } {
  const moved: SettlementAllocationRef[] = [];
  const payments: BillPayment[] = (original.payments ?? []).map((p) => ({
    ...p,
    id: generateId('bpay'),
    billId: replacement.id,
  }));
  /*
   * Supplier debit notes move with their bill. Each keeps its own number and
   * its own posted journal entry — the note is a document in its own right, and
   * amending the bill it corrects does not withdraw it.
   */
  const supplierCredits: BillSupplierCredit[] = (original.supplierCredits ?? []).map((c) => ({
    ...c,
    billId: replacement.id,
  }));

  const amountPaid = roundToCompanyPrecision(payments.reduce((sum, p) => sum + p.amount, 0));
  const creditsApplied = roundToCompanyPrecision(supplierCredits.reduce((sum, c) => sum + c.amount, 0));
  const settled = roundToCompanyPrecision(amountPaid + creditsApplied);

  const overAllocated = assertFits(settled, replacement.grandTotal - replacement.withholdingTaxTotal, 'bill');
  if (overAllocated) return { ok: false, error: overAllocated, moved: [] };
  if (settled <= tolerance()) return { ok: true, moved };

  for (const payment of payments) {
    moved.push({
      kind: payment.paymentId ? 'payment' : 'direct',
      id: payment.id,
      label: `Payment ${payment.reference || payment.id}`,
      amount: payment.amount,
    });
  }
  for (const credit of supplierCredits) {
    moved.push({ kind: 'supplier-credit', id: credit.id, label: `Supplier debit note ${credit.creditNumber}`, amount: credit.amount });
  }

  const balanceDue = roundToCompanyPrecision(
    replacement.grandTotal - replacement.withholdingTaxTotal - amountPaid - creditsApplied,
  );
  markBill(replacement.id, (bill) => ({
    ...bill,
    payments,
    supplierCredits,
    amountPaid,
    supplierCreditsApplied: creditsApplied,
    balanceDue,
    status: balanceDue <= tolerance() ? 'paid' : 'partially-paid',
  }));

  usePaymentStore.setState((state) => ({
    payments: state.payments.map((payment) => {
      if (!payment.allocations?.some((a) => a.billId === original.id && !a.reversed)) return payment;
      return {
        ...payment,
        allocations: payment.allocations.map((a) =>
          a.billId === original.id && !a.reversed
            ? { ...a, billId: replacement.id, billNumber: replacement.billNumber, updatedAt: nowIso() }
            : a),
      };
    }),
  }));

  return { ok: true, moved };
}

/* ── Customer credit note ─────────────────────────────────────────────────── */

async function amendCreditNote(
  request: AmendmentRequest,
  original: CreditNote,
  patch: Record<string, unknown>,
): Promise<Execution> {
  const now = nowIso();
  const dup = useCreditNoteStore.getState().duplicateCreditNote(original.id);
  if (!dup.ok || !dup.id) return { ok: false, error: dup.error ?? 'Could not create the amended credit note.' };
  const replacementId = dup.id;
  markCreditNote(replacementId, (note) => ({
    ...note,
    ...replacementMeta(original, original.creditNoteNumber, request.reason),
  }));

  const patched = useCreditNoteStore.getState().saveCreditNoteDraft(replacementId, {
    issueDate: original.issueDate,
    ...patch,
    lines: (patch.lines as CreditNote['lines'] | undefined)
      ?? original.lines.map((l) => ({ ...l, id: generateId('cnline'), creditNoteId: replacementId })),
  } as Partial<CreditNote>);
  if (!patched.ok) return { ok: false, error: patched.error ?? 'The corrected values could not be applied.' };

  const inventoryDocumentIds = useInventoryStore
    .getState()
    .documents.filter((d) => d.kind === 'customer-return' && d.reference === original.creditNoteNumber && d.status === 'posted')
    .map((d) => d.id);
  const stock = reverseInventory(inventoryDocumentIds);
  if (!stock.ok) return { ok: false, error: stock.error! };

  const reversal = reverseJournal('credit-note', original.id, original.creditNoteNumber, original.journalEntryId!, request.reason);
  if (!reversal.ok || !reversal.id) {
    return { ok: false, error: reversal.error ?? 'Could not reverse the credit note’s journal entry.' };
  }
  /*
   * A credit note that physically returned goods posted a SECOND journal for the
   * inventory side. It is reversed too, or the amended note would restore the
   * stock value twice.
   */
  if (original.inventoryJournalEntryId) {
    const inventoryReversal = reverseJournal(
      'credit-note',
      original.id,
      original.creditNoteNumber,
      original.inventoryJournalEntryId,
      request.reason,
    );
    if (!inventoryReversal.ok) {
      return { ok: false, error: inventoryReversal.error ?? 'Could not reverse the inventory-return journal entry.' };
    }
  }

  /*
   * Superseded before the replacement is validated: `validateCreditNoteForIssue`
   * counts every other live note against the same invoice, and the note being
   * replaced would otherwise consume the very credit its replacement needs.
   */
  markCreditNote(original.id, (note) => ({
    ...note,
    status: 'superseded',
    ...supersededMeta(replacementId, '', reversal.id!, request.reason, undefined, now),
    auditTrail: [
      ...note.auditTrail,
      { id: generateId('cnaud'), at: now, action: 'credit-note-superseded', detail: request.reason.trim() },
      { id: generateId('cnaud'), at: now, action: 'journal-created', detail: `reversal ${reversal.id}` },
    ],
    updatedAt: now,
  }));

  /*
   * Issued WITHOUT auto-applying to the original invoice: the original note's
   * applications are carried across below with their own amounts, and letting
   * the issue path apply a fresh full-value credit as well would credit the
   * customer twice.
   */
  const issued = useCreditNoteStore.getState().issueCreditNote(replacementId, { autoApplyToOriginal: false });
  if (!issued.ok) return { ok: false, error: issued.error ?? 'The amended credit note could not be posted.' };

  const replacement = useCreditNoteStore.getState().creditNotes.find((c) => c.id === replacementId)!;
  const settlement = transferCreditNoteSettlement(original, replacement);
  if (!settlement.ok) return { ok: false, error: settlement.error! };

  markCreditNote(replacementId, (note) => ({
    ...note,
    auditTrail: [
      ...note.auditTrail,
      { id: generateId('cnaud'), at: now, action: 'credit-note-amended', detail: `amends ${original.creditNoteNumber}: ${request.reason.trim()}` },
    ],
    updatedAt: now,
  }));
  markCreditNote(original.id, (note) => ({ ...note, supersededByDocumentNumber: replacement.creditNoteNumber }));

  const final = useCreditNoteStore.getState().creditNotes.find((c) => c.id === replacementId)!;
  return {
    ok: true,
    replacement: {
      id: replacementId,
      number: final.creditNoteNumber,
      version: documentVersion(final),
      journalEntryId: final.journalEntryId,
    },
    reversalJournalEntryId: reversal.id,
    changes: diffDocuments('credit-note', original as unknown as Record<string, unknown>, final as unknown as Record<string, unknown>, labels),
    settlementEffect: settlement.moved,
    inventoryEffect: {
      reversedDocumentIds: inventoryDocumentIds,
      replacementDocumentIds: useInventoryStore
        .getState()
        .documents.filter((d) => d.kind === 'customer-return' && d.reference === final.creditNoteNumber)
        .map((d) => d.id),
      movementCount: stock.movementCount,
    },
    linkAudit: (eventId) => {
      markCreditNote(original.id, (c) => ({ ...c, amendmentAuditEventId: eventId }));
      markCreditNote(replacementId, (c) => ({ ...c, amendmentAuditEventId: eventId }));
    },
  };
}

function markCreditNote(id: string, update: (note: CreditNote) => CreditNote): void {
  useCreditNoteStore.setState((state) => ({
    creditNotes: state.creditNotes.map((c) => (c.id === id ? update(c) : c)),
  }));
}

/**
 * A credit note's settlement is what it has already been used for: value
 * applied to customer invoices, and value refunded in cash.
 *
 * The applications move to the replacement note; the INVOICES they settle are
 * untouched, because the amount of credit sitting against each of them has not
 * changed — only which note carries it. A refund keeps its own bank journal
 * entry for the same reason a receipt does.
 */
function transferCreditNoteSettlement(
  original: CreditNote,
  replacement: CreditNote,
): { ok: boolean; error?: string; moved: SettlementAllocationRef[] } {
  const moved: SettlementAllocationRef[] = [];
  const applications: CreditApplication[] = (original.applications ?? [])
    .filter((a) => !a.reversed)
    .map((a) => ({ ...a, id: generateId('capp'), creditNoteId: replacement.id }));
  const refunds: CreditNoteRefund[] = (original.refunds ?? []).map((r) => ({ ...r, creditNoteId: replacement.id }));

  const amountApplied = roundToCompanyPrecision(applications.reduce((s, a) => s + a.amount, 0));
  const amountRefunded = roundToCompanyPrecision(refunds.reduce((s, r) => s + r.amount, 0));
  const used = roundToCompanyPrecision(amountApplied + amountRefunded);

  const overAllocated = assertFits(used, replacement.grandTotal, 'credit note');
  if (overAllocated) return { ok: false, error: overAllocated, moved: [] };
  if (used <= tolerance()) return { ok: true, moved };

  for (const application of applications) {
    moved.push({ kind: 'credit-note', id: application.id, label: `Applied to invoice ${application.invoiceId}`, amount: application.amount });
  }
  for (const refund of refunds) {
    moved.push({ kind: 'direct', id: refund.id, label: `Refund ${refund.reference || refund.id}`, amount: refund.amount });
  }

  markCreditNote(replacement.id, (note) => ({
    ...note,
    applications,
    refunds,
    amountApplied,
    amountRefunded,
    remainingCredit: roundToCompanyPrecision(note.grandTotal - amountApplied - amountRefunded),
    status: roundToCompanyPrecision(note.grandTotal - amountApplied - amountRefunded) <= tolerance()
      ? 'applied'
      : 'partially-applied',
  }));
  return { ok: true, moved };
}

/* ── Supplier debit note ──────────────────────────────────────────────────── */

/**
 * A supplier debit note — Ledgora's `BillSupplierCredit`.
 *
 * The one classification that is not a top-level document: it is a posted
 * sub-record of the bill it corrects, with its own number and its own journal
 * entry. The amendment is therefore the same shape as the other three — reverse
 * the posting, post a corrected note through `createSupplierCredit` (the module's
 * own path, which also handles the physical return of stock) — but the "draft"
 * step does not exist, because a debit note is created already posted.
 */
async function amendSupplierDebitNote(
  request: AmendmentRequest,
  bill: Bill,
  original: BillSupplierCredit,
  patch: Record<string, unknown>,
  _context: AmendmentContext,
): Promise<Execution> {
  const now = nowIso();

  const inventoryDocumentIds = useInventoryStore
    .getState()
    .documents.filter((d) => d.kind === 'supplier-return' && d.reference === original.creditNumber && d.status === 'posted')
    .map((d) => d.id);
  const stock = reverseInventory(inventoryDocumentIds);
  if (!stock.ok) return { ok: false, error: stock.error! };

  const reversal = reverseJournal(
    'supplier-debit-note',
    original.id,
    original.creditNumber,
    original.journalEntryId!,
    request.reason,
  );
  if (!reversal.ok || !reversal.id) {
    return { ok: false, error: reversal.error ?? 'Could not reverse the debit note’s journal entry.' };
  }

  /*
   * Withdraw the original's effect on the bill BEFORE the corrected note is
   * raised: `createSupplierCredit` refuses a credit larger than the bill's
   * balance due, and the balance is only correct once the note being replaced
   * has stopped consuming it.
   */
  const withdrawn = roundToCompanyPrecision(bill.supplierCreditsApplied - original.amount);
  markBill(bill.id, (b) => ({
    ...b,
    supplierCreditsApplied: withdrawn,
    balanceDue: roundToCompanyPrecision(b.grandTotal - b.withholdingTaxTotal - withdrawn - b.amountPaid),
    supplierCredits: b.supplierCredits.map((c) =>
      c.id === original.id
        // The replacement's id and number are stamped in below, once
        // `createSupplierCredit` has produced it. Until then the note is marked
        // superseded by its own reversal, never left looking current.
        ? { ...c, ...supersededMeta(c.id, '', reversal.id!, request.reason, undefined, now) }
        : c),
    auditTrail: [
      ...b.auditTrail,
      { id: generateId('baud'), at: now, action: 'supplier-credit-superseded', detail: `${original.creditNumber}: ${request.reason.trim()}` },
    ],
    updatedAt: now,
  }));

  /*
   * The account the note reverses is not a field on `BillSupplierCredit` — it
   * only ever existed on the journal entry the note posted. So when the
   * amendment does not name a different one, it is read back off that entry
   * rather than guessed at or defaulted to something plausible: a debit note
   * that reversed a specific expense must go on reversing that expense.
   */
  const creditAccountId = String(patch.creditAccountId ?? '') || originalCreditAccount(original);
  if (!creditAccountId) {
    return {
      ok: false,
      error: 'The account this debit note reverses could not be determined from its original posting. Choose it explicitly to amend the note.',
    };
  }
  const created = useBillStore.getState().createSupplierCredit(bill.id, {
    netAmount: Number(patch.netAmount ?? original.netAmount),
    taxAmount: Number(patch.taxAmount ?? original.taxAmount),
    creditAccountId,
    reason: String(patch.reason ?? original.reason ?? ''),
    date: String(patch.date ?? original.date),
  });
  if (!created.ok) return { ok: false, error: created.error ?? 'The amended debit note could not be posted.' };

  const updatedBill = useBillStore.getState().bills.find((b) => b.id === bill.id)!;
  const replacement = updatedBill.supplierCredits[updatedBill.supplierCredits.length - 1]!;

  markBill(bill.id, (b) => ({
    ...b,
    supplierCredits: b.supplierCredits.map((c) => {
      if (c.id === original.id) {
        return { ...c, supersededByDocumentId: replacement.id, supersededByDocumentNumber: replacement.creditNumber };
      }
      if (c.id === replacement.id) {
        return { ...c, ...replacementMeta(original, original.creditNumber, request.reason) };
      }
      return c;
    }),
  }));

  const final = useBillStore.getState().bills.find((b) => b.id === bill.id)!.supplierCredits.find((c) => c.id === replacement.id)!;
  return {
    ok: true,
    replacement: {
      id: final.id,
      number: final.creditNumber,
      version: documentVersion(final),
      journalEntryId: final.journalEntryId,
    },
    reversalJournalEntryId: reversal.id,
    changes: diffDocuments(
      'supplier-debit-note',
      original as unknown as Record<string, unknown>,
      final as unknown as Record<string, unknown>,
      labels,
    ),
    settlementEffect: [],
    inventoryEffect: {
      reversedDocumentIds: inventoryDocumentIds,
      replacementDocumentIds: useInventoryStore
        .getState()
        .documents.filter((d) => d.kind === 'supplier-return' && d.reference === final.creditNumber)
        .map((d) => d.id),
      movementCount: stock.movementCount,
    },
    linkAudit: (eventId) => {
      markBill(bill.id, (b) => ({
        ...b,
        supplierCredits: b.supplierCredits.map((c) =>
          c.id === original.id || c.id === final.id ? { ...c, amendmentAuditEventId: eventId } : c),
      }));
    },
  };
}

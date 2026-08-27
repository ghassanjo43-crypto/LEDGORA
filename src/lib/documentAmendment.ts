/**
 * What an amendment means — the pure part.
 *
 * Everything here is a function over data: which fields may be amended, whether
 * a set of findings permits the amendment, what changed between the original
 * and the revision, and what the operator is told. The probing of live stores
 * is `lib/documentAmendmentProbes`; the orchestration is
 * `services/documentAmendmentService`. Keeping the decision pure is what makes
 * it testable without constructing a workspace, exactly as `journalAmendment`
 * is separate from `journalDependencies`.
 */
import type {
  AmendableDocumentType,
  AmendmentAssessment,
  AmendmentBlocker,
  AmendmentImpact,
  DocumentFieldChange,
} from '@/types/documentAmendment';
import { companyMonetaryDecimals } from '@/lib/monetaryPrecision';

/* ── The reason ───────────────────────────────────────────────────────────── */

export const AMENDMENT_REASON_REQUIRED =
  'A meaningful amendment reason is required. It is recorded permanently in the document’s history and in the audit trail.';

/**
 * A reason must be present and say something.
 *
 * Five characters is the same floor `journalAmendment.validateReason` uses, and
 * it is a floor rather than a formality: an amendment with no stated reason is
 * an unexplained restatement of a figure a customer, a supplier or a tax return
 * relied on. The trail would record that it happened and be unable to say why,
 * which is the one question it exists to answer.
 */
export function validateAmendmentReason(reason: string | undefined): { ok: boolean; error?: string } {
  return (reason ?? '').trim().length >= 5 ? { ok: true } : { ok: false, error: AMENDMENT_REASON_REQUIRED };
}

/* ── Amendable fields ─────────────────────────────────────────────────────── */

/**
 * The fields the accounting rules can safely amend, per document type.
 *
 * Deliberately an allow-list rather than a deny-list. Everything absent from it
 * — the document number, the posted journal links, the settlement subledgers,
 * the audit trail, the template snapshot frozen at issue, the amendment chain
 * itself — is either the document's identity or a record derived from it, and a
 * patch that named one would be a way to rewrite history through the front
 * door.
 *
 * The counterparty is amendable on all four because "this bill was entered
 * against the wrong supplier" is one of the corrections operators most need,
 * and the replacement is a NEW document posted from scratch — there is no
 * subledger balance being carried across a counterparty change, because the
 * original's settlement is unapplied before the replacement is posted.
 */
const AMENDABLE_FIELDS: Record<AmendableDocumentType, readonly string[]> = {
  invoice: [
    'customerId', 'issueDate', 'dueDate', 'purchaseOrderReference', 'customerReference',
    'salespersonId', 'projectId', 'costCenterId', 'notes', 'terms', 'paymentTerms', 'lines',
  ],
  bill: [
    'supplierId', 'supplierInvoiceNumber', 'billType', 'billDate', 'dueDate',
    'purchaseOrderId', 'notes', 'lines',
  ],
  'credit-note': [
    'customerId', 'issueDate', 'creditType', 'reasonCode', 'reasonDescription',
    'projectId', 'costCenterId', 'notes', 'terms', 'lines',
  ],
  'supplier-debit-note': ['netAmount', 'taxAmount', 'creditAccountId', 'reason', 'date'],
};

export function amendableFields(type: AmendableDocumentType): readonly string[] {
  return AMENDABLE_FIELDS[type];
}

/**
 * Keep only what may be amended.
 *
 * Silently DROPS anything else rather than refusing the whole request: the
 * drawer sends the document it is editing, and a stray derived field on that
 * object is not an attempt to rewrite history. What matters is that the field
 * cannot reach the replacement, and dropping it guarantees that whether the
 * caller was a screen, a test, or something added later.
 */
export function pickAmendableFields(
  type: AmendableDocumentType,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = new Set(AMENDABLE_FIELDS[type]);
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (allowed.has(key)) clean[key] = value;
  }
  return clean;
}

/* ── Assessment ───────────────────────────────────────────────────────────── */

export const EMPTY_IMPACT: AmendmentImpact = {
  settlement: { grandTotal: 0, amountSettled: 0, balanceDue: 0, transferable: [], blocked: [] },
  inventory: { documentIds: [], movementCount: 0, reversible: true },
  tax: {},
};

export interface AssessmentInput {
  documentType: AmendableDocumentType;
  documentId: string;
  documentNumber: string;
  documentDate: string;
  version: number;
  findings: readonly AmendmentBlocker[];
  impact: AmendmentImpact;
}

/**
 * Turn the collected facts into a verdict.
 *
 * A single `blocks` finding is enough to refuse, and EVERY finding is reported
 * whatever the verdict — including the confirmations that would have applied.
 * Summarising to the first blocker would tell an operator to reopen a period
 * and let them discover the reconciled receipt only on the second attempt.
 */
export function assessDocumentAmendment(input: AssessmentInput): AmendmentAssessment {
  const findings = [...input.findings];
  const blockers = findings.filter((f) => f.severity === 'blocks');
  const confirmations = findings.filter((f) => f.severity === 'requires_confirmation');
  return {
    documentType: input.documentType,
    documentId: input.documentId,
    documentNumber: input.documentNumber,
    documentDate: input.documentDate,
    version: input.version,
    eligible: blockers.length === 0,
    findings,
    blockers,
    confirmations,
    reason: blockers.length > 0
      ? blockers.map((b) => b.message).join(' ')
      : 'This posted document can be amended. The original, its journal entry and its history are preserved.',
    impact: input.impact,
  };
}

/* ── Diffing ──────────────────────────────────────────────────────────────── */

/**
 * Amounts in the history at the company's own precision.
 *
 * An audit trail reporting "1,250.00 → 1,250.00" for a change of one fils would
 * describe a correction while hiding what was corrected — the same reason
 * `journalAmendment` formats its diff this way.
 */
function money(n: unknown): string {
  const decimals = companyMonetaryDecimals();
  const value = Number(n ?? 0);
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export interface DiffField {
  key: string;
  label: string;
  money?: boolean;
}

/** Header fields tracked per document type, with the labels operators read. */
export const HEADER_DIFF_FIELDS: Record<AmendableDocumentType, DiffField[]> = {
  invoice: [
    { key: 'customerId', label: 'Customer' },
    { key: 'issueDate', label: 'Issue date' },
    { key: 'dueDate', label: 'Due date' },
    { key: 'currency', label: 'Currency' },
    { key: 'purchaseOrderReference', label: 'PO reference' },
    { key: 'customerReference', label: 'Customer reference' },
    { key: 'paymentTerms', label: 'Payment terms' },
    { key: 'notes', label: 'Notes' },
    { key: 'subtotal', label: 'Subtotal', money: true },
    { key: 'discountTotal', label: 'Discount', money: true },
    { key: 'taxTotal', label: 'Tax', money: true },
    { key: 'grandTotal', label: 'Total', money: true },
  ],
  bill: [
    { key: 'supplierId', label: 'Supplier' },
    { key: 'supplierInvoiceNumber', label: 'Supplier invoice no.' },
    { key: 'billType', label: 'Bill type' },
    { key: 'billDate', label: 'Bill date' },
    { key: 'dueDate', label: 'Due date' },
    { key: 'currency', label: 'Currency' },
    { key: 'notes', label: 'Notes' },
    { key: 'subtotal', label: 'Subtotal', money: true },
    { key: 'taxTotal', label: 'Tax', money: true },
    { key: 'withholdingTaxTotal', label: 'Withholding tax', money: true },
    { key: 'grandTotal', label: 'Total', money: true },
  ],
  'credit-note': [
    { key: 'customerId', label: 'Customer' },
    { key: 'issueDate', label: 'Issue date' },
    { key: 'creditType', label: 'Credit type' },
    { key: 'reasonCode', label: 'Reason code' },
    { key: 'reasonDescription', label: 'Reason' },
    { key: 'currency', label: 'Currency' },
    { key: 'subtotal', label: 'Subtotal', money: true },
    { key: 'taxTotal', label: 'Tax', money: true },
    { key: 'grandTotal', label: 'Total', money: true },
  ],
  'supplier-debit-note': [
    { key: 'date', label: 'Date' },
    { key: 'reason', label: 'Reason' },
    { key: 'netAmount', label: 'Net', money: true },
    { key: 'taxAmount', label: 'Tax', money: true },
    { key: 'amount', label: 'Total', money: true },
  ],
};

/** Line fields tracked, in the order an accountant reads a line. */
const LINE_DIFF_FIELDS: DiffField[] = [
  { key: 'description', label: 'Description' },
  { key: 'quantity', label: 'Quantity' },
  { key: 'unitPrice', label: 'Unit price', money: true },
  { key: 'discountValue', label: 'Discount' },
  { key: 'taxRate', label: 'Tax rate' },
  { key: 'taxAmount', label: 'Tax amount', money: true },
  { key: 'lineTotal', label: 'Line total', money: true },
  { key: 'accountId', label: 'Account' },
  { key: 'projectId', label: 'Project' },
  { key: 'costCenterId', label: 'Cost center' },
  { key: 'inventoryItemId', label: 'Inventory item' },
  { key: 'warehouseId', label: 'Warehouse' },
];

type Bag = Record<string, unknown>;

function present(value: unknown, isMoney: boolean | undefined): string {
  if (isMoney) return money(value);
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

/**
 * Field-level before/after for the comparison step and the audit event.
 *
 * Only genuine differences are recorded. A change list padded with "unchanged"
 * rows buries the one field that actually moved, which is the single question a
 * reviewer opens the comparison to answer.
 *
 * Lines are compared POSITIONALLY, and an added or removed line is reported as
 * one change rather than as a cascade of field differences — matching a line
 * "by identity" is not possible when the replacement's lines are new records
 * with new ids, and pretending otherwise would produce a diff that reads as if
 * every line had been rewritten.
 */
export function diffDocuments(
  type: AmendableDocumentType,
  before: Bag,
  after: Bag,
  labels?: { entityName?: (id: unknown) => string; accountName?: (id: unknown) => string },
): DocumentFieldChange[] {
  const changes: DocumentFieldChange[] = [];
  const nameOf = (key: string, value: unknown): string => {
    if (labels?.entityName && (key === 'customerId' || key === 'supplierId')) return labels.entityName(value);
    if (labels?.accountName && (key === 'accountId' || key === 'creditAccountId')) return labels.accountName(value);
    return '';
  };

  for (const { key, label, money: isMoney } of HEADER_DIFF_FIELDS[type]) {
    const a = present(before[key], isMoney);
    const b = present(after[key], isMoney);
    if (a === b) continue;
    changes.push({
      field: key,
      label,
      before: nameOf(key, before[key]) || a,
      after: nameOf(key, after[key]) || b,
    });
  }

  const beforeLines = Array.isArray(before.lines) ? (before.lines as Bag[]) : [];
  const afterLines = Array.isArray(after.lines) ? (after.lines as Bag[]) : [];
  const rows = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < rows; i += 1) {
    const a = beforeLines[i];
    const b = afterLines[i];
    if (a && !b) {
      changes.push({ field: `lines.${i}`, label: `Line ${i + 1}`, before: lineSummary(a), after: 'removed' });
      continue;
    }
    if (!a && b) {
      changes.push({ field: `lines.${i}`, label: `Line ${i + 1}`, before: 'added', after: lineSummary(b) });
      continue;
    }
    if (!a || !b) continue;
    for (const { key, label, money: isMoney } of LINE_DIFF_FIELDS) {
      const x = present(a[key], isMoney);
      const y = present(b[key], isMoney);
      if (x === y) continue;
      changes.push({
        field: `lines.${i}.${key}`,
        label: `Line ${i + 1} · ${label}`,
        before: nameOf(key, a[key]) || x,
        after: nameOf(key, b[key]) || y,
      });
    }
  }

  return changes;
}

function lineSummary(line: Bag): string {
  const description = String(line.description ?? '—');
  return `${description} · ${present(line.quantity, false)} × ${money(line.unitPrice)} = ${money(line.lineTotal)}`;
}

/* ── The version chain ────────────────────────────────────────────────────── */

export interface ChainMember {
  id: string;
  number: string;
  version: number;
  status: string;
  date: string;
  total: number;
  journalEntryId?: string;
  reversalJournalEntryId?: string;
  amendmentReason?: string;
  supersededAt?: string;
  /** True for the version that is currently in force. */
  current: boolean;
}

/**
 * Order a chain oldest-first.
 *
 * Sorted by version and then by date, never by array position: the replacement
 * is appended to the store when it is created, so array order happens to be
 * right today and would stop being right the moment anything re-sorts the
 * store's own list.
 */
export function orderChain(members: ChainMember[]): ChainMember[] {
  return [...members].sort((a, b) => a.version - b.version || a.date.localeCompare(b.date));
}

/**
 * Translating a server invoice into the shape the invoice screens already read.
 *
 * ── The one rule this file exists to enforce ─────────────────────────────────
 * A server-backed invoice's totals are COPIED, never recomputed.
 *
 * The browser store recomputes totals from lines on every read (`withTotals`),
 * because in the browser the lines are the only source of truth there is. On
 * the server the totals were computed in fixed-point BigInt inside the same
 * transaction that wrote the lines, and the invoice may already have been
 * posted to the ledger against exactly those figures. Recomputing them here in
 * float would let a rounding difference of one minor unit put the screen and
 * the ledger into disagreement — and, once JoFotara is live, the screen and a
 * cleared tax document. So `toBrowserInvoice` reads the totals off the record
 * and the recompute path is not reachable from it.
 *
 * `number` is still what crosses into the UI, because that is what `Invoice`
 * has always held and Phase 4 is a backend swap, not a type migration. That is
 * safe HERE and only here: these values are display output, and every
 * arithmetic operation on them has already happened server-side.
 */
import type { Invoice, InvoiceLine, InvoiceStatus } from '@/types/invoice';
import type { ServerInvoice, ServerInvoiceLine } from '@/services/api/invoicesApi';

/**
 * A decimal string from PostgreSQL to a JS number.
 *
 * NUMERIC(28,10) can hold values `number` cannot represent exactly. Invoice
 * money is far inside the safe range, but a corrupt or unexpected value should
 * surface as a visible zero rather than a silent `NaN` propagating into totals.
 */
export function decimalToNumber(value: string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A JS number back to the decimal string the API expects. */
export function numberToDecimal(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '0';
  return value.toFixed(decimals);
}

function toBrowserLine(line: ServerInvoiceLine): InvoiceLine {
  return {
    id: line.id,
    accountId: line.accountId,
    description: line.description,
    quantity: decimalToNumber(line.quantity),
    unitPrice: decimalToNumber(line.unitPrice),
    lineSubtotal: decimalToNumber(line.lineSubtotal),
    lineTotal: decimalToNumber(line.lineTotal),
    taxAmount: decimalToNumber(line.taxAmount),
    taxRate: decimalToNumber(line.taxRate),
    discountType: (line.discountType as InvoiceLine['discountType']) ?? undefined,
    discountValue: line.discountValue === null ? undefined : decimalToNumber(line.discountValue),
    taxCodeId: line.taxCodeId ?? undefined,
    inventoryItemId: line.itemId ?? undefined,
    warehouseId: line.warehouseId ?? undefined,
    /* Set by the server only where a line actually moved stock, so the flag
     * the screen reads is derived from what the books hold rather than from a
     * separate value that could disagree with them. */
    inventoryFulfillmentMode: line.itemId ? 'issue-on-invoice' : 'none',
    issuedUnitCost: line.issuedUnitCost === null || line.issuedUnitCost === undefined
      ? undefined : decimalToNumber(line.issuedUnitCost),
    projectId: line.projectId ?? undefined,
    costCenterId: line.costCenterId ?? undefined,
    unit: line.unit || undefined,
  } as InvoiceLine;
}

/**
 * The server record as the screens expect to read it.
 *
 * Fields the server does not yet hold — the template snapshot frozen at issue,
 * the payment subledger, the audit trail — come back empty rather than
 * fabricated. `invoiceBackend.eligibility` is what stops a company that relies
 * on those from being switched over in the first place; this function's job is
 * to be honest about what is and is not there, not to paper over it.
 */
export function toBrowserInvoice(record: ServerInvoice): Invoice {
  return {
    id: record.id,
    entityId: record.issuingEntityId,
    customerId: record.customerId,
    invoiceNumber: record.invoiceNumber,
    status: record.status as InvoiceStatus,

    issueDate: record.issueDate,
    dueDate: record.dueDate,
    currency: record.transactionCurrency,
    exchangeRate: decimalToNumber(record.exchangeRate),

    purchaseOrderReference: record.purchaseOrderReference || undefined,
    customerReference: record.customerReference || undefined,

    templateId: '',
    templateVersionId: '',
    templateResolutionSource: 'entity-default',

    lines: record.lines.map(toBrowserLine),

    // Copied, not recomputed. See the file header.
    subtotal: decimalToNumber(record.subtotal),
    discountTotal: decimalToNumber(record.discountTotal),
    taxTotal: decimalToNumber(record.taxTotal),
    additionalChargesTotal: decimalToNumber(record.additionalChargesTotal),
    grandTotal: decimalToNumber(record.grandTotal),
    amountPaid: decimalToNumber(record.amountPaid),
    creditsApplied: decimalToNumber(record.creditsApplied),
    balanceDue: decimalToNumber(record.balanceDue),

    notes: record.notes || undefined,
    terms: record.terms || undefined,
    paymentTerms: record.paymentTerms || undefined,

    payments: [],

    journalEntryId: record.journalEntryId ?? undefined,
    reversalJournalEntryId: record.reversalJournalEntryId ?? undefined,
    voidReason: record.voidReason ?? undefined,

    issuedAt: record.issuedAt ?? undefined,
    voidedAt: record.voidedAt ?? undefined,

    /*
     * Carried through so the repository can send it back as `expectedVersion`.
     * `Invoice` has no such field -- the browser store never needed one -- so it
     * rides along and `invoiceRepository.invoiceVersion` reads it back.
     */
    version: record.version,

    auditTrail: [],
    createdAt: record.issuedAt ?? record.issueDate,
    updatedAt: record.issuedAt ?? record.issueDate,
  } as Invoice;
}

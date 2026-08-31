/**
 * Sales invoices, server-side.
 *
 * ══ What this owns, and what it delegates ════════════════════════════════════
 *
 * This module owns the DOCUMENT: its lifecycle, its numbering, its totals and
 * the audit trail of what happened to it. It does not own the accounting. When
 * an invoice is issued it asks `journalService` to create and post the entry,
 * because the ledger has exactly one write path and a second one that "just
 * inserts a couple of rows" is how two sets of books start to disagree.
 *
 * ══ The four rules, restated for a document ══════════════════════════════════
 *
 * ONE TRANSACTION. Numbering, the document, its lines, the ledger entry and the
 * audit event commit together or not at all. In particular a failed audit
 * insert rolls back the issue it describes.
 *
 * NOTHING IS TAKEN ON TRUST. The organization comes from the caller's
 * membership, never a request body. The invoice number is allocated here, never
 * accepted. Accounts are re-resolved against this organization inside the
 * transaction. `expectedVersion` is required for every mutation and a mismatch
 * is a refusal, not a merge.
 *
 * MONEY IS NEVER A FLOAT. Amounts arrive as strings and are summed as BigInt by
 * `money.ts`. Totals are recomputed here from the lines rather than accepted
 * from the caller — a client that sends its own total is a client that can send
 * the wrong one, and the number on a tax document is not a matter of opinion.
 *
 * ISSUED DOCUMENTS ARE NEVER DESTROYED. A draft may be edited or deleted; an
 * issued invoice may only be voided, which reverses its ledger entry and keeps
 * both. That matters more once a tax authority holds its own copy: a document
 * it has cleared cannot be quietly altered on our side.
 */
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { Database, SalesInvoiceStatus, SalesTaxCategory, SalesTaxMethod } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import type { AccountingActor } from '../accounting/audit.js';
import { assessPostingAccount } from '../accounting/accountEligibility.js';
import { loadAccountsForPosting } from '../accounting/accountService.js';
import { monetaryDecimalsFor } from '../accounting/currencyPrecision.js';
import * as Money from '../accounting/money.js';
import * as journals from '../accounting/journalService.js';
import { postSourceJournalIn } from '../accounting/sourcePostingService.js';
import * as SalesTax from '../accounting/salesTax.js';
import { toCalendarDate, toCalendarDateOrNull } from '../accounting/calendarDate.js';
import {
  resolveTaxForDate, assertOutputAccountPostable, type ResolvedTax,
} from './taxCodeService.js';

type Executor = Kysely<Database> | Transaction<Database>;
type Trx = Transaction<Database>;

/** Statuses a draft edit is still allowed in. */
const EDITABLE: readonly SalesInvoiceStatus[] = ['draft', 'approved'];

/** What `source_type` an invoice's ledger entry carries. */
export const INVOICE_SOURCE_TYPE = 'sales_invoice';
/**
 * What happened to the document. The unique index from 029 is partial on
 * this, so a posting without one is covered by nothing.
 */
export const INVOICE_ISSUE_EVENT = 'issue';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface InvoiceLineInput {
  accountId: string;
  description?: string;
  /** Decimal STRINGS throughout. See `money.ts` for why these are never numbers. */
  quantity?: string;
  unitPrice?: string;
  unit?: string;
  discountType?: 'percentage' | 'amount' | null;
  discountValue?: string | null;
  taxCodeId?: string | null;
  taxRate?: string;
  taxAmount?: string;
  itemId?: string | null;
  entityId?: string | null;
  projectId?: string | null;
  costCenterId?: string | null;
}

export interface InvoiceInput {
  issuingEntityId: string;
  /*
   * Fields the client may SEND but never decides.
   *
   * They are typed here so they can be refused explicitly. Leaving them off the
   * type would let them arrive, be read by nothing, and be discarded in
   * silence — a client asking for a USD invoice would get a JOD one and never
   * be told. Refusing is the honest answer; ignoring is not.
   */
  currency?: string;
  status?: string;
  invoiceNumber?: string;
  /**
   * Delivery, handling and the like, as a single total.
   *
   * Carried on the invoice rather than as a line because that is how the
   * browser held it, and a migrated invoice whose charges became an extra line
   * would not match the document the customer already has.
   */
  additionalChargesTotal?: string;
  customerId: string;
  issueDate: string;
  dueDate: string;
  reference?: string;
  purchaseOrderReference?: string;
  customerReference?: string;
  notes?: string;
  terms?: string;
  paymentTerms?: string;
  projectId?: string | null;
  costCenterId?: string | null;
  salespersonId?: string | null;
  templateId?: string | null;
  templateVersionId?: string | null;
  lines: InvoiceLineInput[];
}

export interface InvoiceLineRecord {
  id: string;
  lineNumber: number;
  accountId: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountType: string | null;
  discountValue: string | null;
  taxCodeId: string | null;
  taxRate: string;
  taxAmount: string;
  /** The base tax was charged on. Differs from the line total when inclusive. */
  taxableAmount: string;
  lineSubtotal: string;
  lineTotal: string;
  /**
   * The FROZEN snapshot, present only once the invoice is issued.
   *
   * Null on a draft is meaningful rather than missing: nothing is frozen until
   * issue, and a screen that showed a draft's current figures as though they
   * were a snapshot would imply a permanence the document does not yet have.
   */
  taxSnapshot: InvoiceLineTaxSnapshot | null;
  itemId: string | null;
  entityId: string | null;
  projectId: string | null;
  costCenterId: string | null;
}

/** Everything needed to reproduce and audit one line's tax, as at issue. */
export interface InvoiceLineTaxSnapshot {
  taxCodeId: string;
  code: string;
  name: string;
  category: SalesTaxCategory;
  calculationMethod: SalesTaxMethod;
  rate: string;
  rateVersionId: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  taxableAmount: string;
  taxAmount: string;
  grossAmount: string;
  outputTaxAccountId: string | null;
  /** The date the rate was resolved on — this invoice's issue date. */
  taxPointDate: string | null;
  capturedAt: string | null;
}

export interface InvoiceRecord {
  id: string;
  invoiceNumber: string;
  status: SalesInvoiceStatus;
  issuingEntityId: string;
  customerId: string;
  issueDate: string;
  dueDate: string;
  transactionCurrency: string;
  functionalCurrency: string;
  exchangeRate: string;
  purchaseOrderReference: string;
  customerReference: string;
  notes: string;
  terms: string;
  paymentTerms: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  additionalChargesTotal: string;
  grandTotal: string;
  amountPaid: string;
  creditsApplied: string;
  balanceDue: string;
  journalEntryId: string | null;
  reversalJournalEntryId: string | null;
  voidReason: string | null;
  issuedAt: string | null;
  voidedAt: string | null;
  version: number;
  lines: InvoiceLineRecord[];
}

export interface MutationOptions {
  expectedVersion?: number;
  reason?: string;
}

export const CONCURRENCY_MESSAGE =
  'This invoice was changed by another user while you were editing it. Review the latest version before applying your changes.';

/* ══ Reading ═══════════════════════════════════════════════════════════════ */

/*
 * A calendar date, read as the date the column holds.
 *
 * NOT `toISOString().slice(0, 10)`: `node-postgres` builds a bare `date` at
 * LOCAL midnight, and converting that to UTC east of Greenwich yields the
 * previous day — which would move an invoice into a different accounting
 * period and, since S2c, resolve its tax at a different rate.
 */
const dateText = toCalendarDate;
const instant = (value: unknown): string | null =>
  value ? new Date(value as string).toISOString() : null;

/**
 * Render a stored amount at the currency's own precision.
 *
 * Storage is `numeric(28,10)` and stays exact; PostgreSQL returns all ten
 * decimals, and a document showing `100.0000000000` to a customer is not a
 * document anyone would send.
 */
function display(value: unknown, decimals: number): string {
  const raw = Money.toDecimalString(Money.toAmount(value as string));
  const [whole = '0', fraction = ''] = raw.split('.');
  let end = fraction.length;
  while (end > decimals && fraction[end - 1] === '0') end -= 1;
  const kept = fraction.slice(0, end);
  return kept.length > 0 ? `${whole}.${kept}` : whole;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toLine(row: any, decimals: number): InvoiceLineRecord {
  return {
    id: row.id,
    lineNumber: row.line_number,
    accountId: row.account_id,
    description: row.description,
    quantity: display(row.quantity, decimals),
    unit: row.unit,
    unitPrice: display(row.unit_price, decimals),
    discountType: row.discount_type,
    discountValue: row.discount_value === null ? null : display(row.discount_value, decimals),
    taxCodeId: row.tax_code_id,
    taxRate: display(row.tax_rate, decimals),
    taxAmount: display(row.tax_amount, decimals),
    taxableAmount: display(row.taxable_amount ?? row.line_subtotal, decimals),
    lineSubtotal: display(row.line_subtotal, decimals),
    lineTotal: display(row.line_total, decimals),
    /* Present only when `tax_snapshot_at` says one was actually frozen. */
    taxSnapshot: row.tax_snapshot_at && row.tax_code_id ? {
      taxCodeId: row.tax_code_id,
      code: row.tax_code_code ?? '',
      name: row.tax_code_name ?? '',
      category: row.tax_category,
      calculationMethod: row.tax_calculation_method,
      rate: display(row.tax_rate, decimals),
      rateVersionId: row.tax_rate_version_id ?? null,
      effectiveFrom: toCalendarDateOrNull(row.tax_rate_effective_from),
      effectiveTo: toCalendarDateOrNull(row.tax_rate_effective_to),
      taxableAmount: display(row.taxable_amount ?? row.line_subtotal, decimals),
      taxAmount: display(row.tax_amount, decimals),
      grossAmount: display(row.line_total, decimals),
      outputTaxAccountId: row.tax_account_id ?? null,
      taxPointDate: toCalendarDateOrNull(row.tax_point_date),
      capturedAt: row.tax_snapshot_at instanceof Date
        ? row.tax_snapshot_at.toISOString() : String(row.tax_snapshot_at),
    } : null,
    itemId: row.item_id,
    entityId: row.entity_id,
    projectId: row.project_id,
    costCenterId: row.cost_center_id,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toInvoice(row: any, lines: any[]): InvoiceRecord {
  const decimals = monetaryDecimalsFor(row.transaction_currency);
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    status: row.status,
    issuingEntityId: row.issuing_entity_id,
    customerId: row.customer_id,
    issueDate: dateText(row.issue_date),
    dueDate: dateText(row.due_date),
    transactionCurrency: row.transaction_currency,
    functionalCurrency: row.functional_currency,
    exchangeRate: String(row.exchange_rate),
    purchaseOrderReference: row.purchase_order_reference,
    customerReference: row.customer_reference,
    notes: row.notes,
    terms: row.terms,
    paymentTerms: row.payment_terms,
    subtotal: display(row.subtotal, decimals),
    discountTotal: display(row.discount_total, decimals),
    taxTotal: display(row.tax_total, decimals),
    additionalChargesTotal: display(row.additional_charges_total, decimals),
    grandTotal: display(row.grand_total, decimals),
    amountPaid: display(row.amount_paid, decimals),
    creditsApplied: display(row.credits_applied, decimals),
    balanceDue: display(row.balance_due, decimals),
    journalEntryId: row.journal_entry_id,
    reversalJournalEntryId: row.reversal_journal_entry_id,
    voidReason: row.void_reason,
    issuedAt: instant(row.issued_at),
    voidedAt: instant(row.voided_at),
    version: row.version,
    lines: lines
      .map((line) => toLine(line, decimals))
      .sort((a, b) => a.lineNumber - b.lineNumber),
  };
}

async function loadInvoice(executor: Executor, actor: AccountingActor, id: string): Promise<InvoiceRecord> {
  const row = await executor
    .selectFrom('invoices').selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw errors.notFound('Invoice');

  const lines = await executor
    .selectFrom('invoice_lines').selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('invoice_id', '=', id)
    .execute();

  return toInvoice(row, lines);
}

export async function getInvoice(db: Kysely<Database>, actor: AccountingActor, id: string): Promise<InvoiceRecord> {
  return loadInvoice(db, actor, id);
}

export async function listInvoices(
  db: Kysely<Database>,
  actor: AccountingActor,
  filter: { status?: SalesInvoiceStatus; customerId?: string } = {},
): Promise<InvoiceRecord[]> {
  let query = db.selectFrom('invoices').selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId);
  if (filter.status) query = query.where('status', '=', filter.status);
  if (filter.customerId) query = query.where('customer_id', '=', filter.customerId);

  const rows = await query.orderBy('issue_date', 'desc').orderBy('invoice_number', 'desc').execute();
  if (rows.length === 0) return [];

  const lines = await db.selectFrom('invoice_lines').selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('invoice_id', 'in', rows.map((r) => r.id))
    .execute();

  return rows.map((row) => toInvoice(row, lines.filter((l) => l.invoice_id === row.id)));
}

/* ══ Numbering ═════════════════════════════════════════════════════════════ */

/**
 * Allocate the next invoice number for an issuing entity.
 *
 * Held in `invoice_numbering` and incremented under an advisory lock, never
 * derived by counting invoices: a counted sequence reuses a number after a
 * deletion, and a tax authority that has already cleared the first INV-0007
 * will reject the second. The lock is transaction-scoped, so two concurrent
 * issues serialise here instead of racing to the same number.
 */
export async function allocateInvoiceNumber(
  trx: Trx,
  organizationId: string,
  companyId: string,
  issuingEntityId: string,
  issueDate: string,
): Promise<string> {
  /*
   * The lock key includes the COMPANY, so two companies under one subscriber
   * hold different locks and number their invoices independently and
   * concurrently. Locking on the organization alone would be correct but
   * needlessly serialising — and, worse, it would read as though the two
   * companies shared a sequence, which after migration 025 they do not.
   */
  await sql`select pg_advisory_xact_lock(hashtext(${`invoice_number:${organizationId}:${companyId}:${issuingEntityId}`}))`.execute(trx);

  const existing = await trx
    .selectFrom('invoice_numbering').selectAll()
    .where('organization_id', '=', organizationId)
    .where('company_id', '=', companyId)
    .where('issuing_entity_id', '=', issuingEntityId)
    .executeTakeFirst();

  const config = existing ?? {
    prefix: 'INV-',
    include_year: true,
    sequence_length: 4,
    next_sequence: 1,
  };

  if (!existing) {
    await trx.insertInto('invoice_numbering')
      .values({
        organization_id: organizationId,
        company_id: companyId,
        issuing_entity_id: issuingEntityId,
        next_sequence: 2,
      })
      .execute();
  } else {
    await trx.updateTable('invoice_numbering')
      .set({ next_sequence: config.next_sequence + 1, updated_at: new Date() })
      .where('organization_id', '=', organizationId)
      .where('company_id', '=', companyId)
      .where('issuing_entity_id', '=', issuingEntityId)
      .execute();
  }

  const year = config.include_year ? `${issueDate.slice(0, 4)}-` : '';
  return `${config.prefix}${year}${String(config.next_sequence).padStart(config.sequence_length, '0')}`;
}

/* ══ Validation and totals ═════════════════════════════════════════════════ */

function amount(value: string | null | undefined, field: string): Money.Amount {
  try {
    return Money.toAmount(value, field);
  } catch (error) {
    if (error instanceof Money.MoneyError) throw errors.validation(error.message);
    throw error;
  }
}

interface ComputedLine {
  input: InvoiceLineInput;
  /** The base tax is charged on — net of discount, at the currency's precision. */
  lineSubtotal: Money.Amount;
  taxAmount: Money.Amount;
  lineTotal: Money.Amount;
  /**
   * What the SERVER resolved for this line, or null when the line names no tax
   * code. Never anything the client sent.
   */
  tax: ResolvedTax | null;
}

/* ══ The durable-invoice boundary ═════════════════════════════════════════ */

/**
 * What a durable sales invoice may contain, and what it may not — yet.
 *
 * ══ Everything here is REFUSED, never dropped ════════════════════════════════
 *
 * Each of these fields names a record the server cannot verify or an amount it
 * cannot derive. The tempting alternative is to ignore them: accept the invoice
 * and silently store nothing for the project, the tax, the warehouse. That is
 * the worse failure by a wide margin — the user sees a document they believe
 * carries a cost centre and a tax charge, the books carry neither, and nothing
 * anywhere says so. A refusal is recoverable; a silently different invoice is
 * discovered at an audit.
 *
 * ══ Tax, specifically ════════════════════════════════════════════════════════
 *
 * The product's tax model is per LINE and rich — ten categories including
 * zero-rated, exempt, out-of-scope and reverse-charge, seven scopes, inclusive
 * and exclusive methods, effective-dated rates, and a frozen snapshot per posted
 * line. All of it is browser-resident. The server controls exactly two facts:
 * whether the company is registered, and a default rate that nothing applies.
 *
 * So the server cannot answer "does this line attract tax, at what rate, under
 * which category". It could apply the company default to everything — which
 * taxes exempt supplies and zero-rated exports, a real filing error — or trust
 * the rate the browser sent, which is an arbitrary client number wearing the
 * costume of a tax code. Both are worse than refusing.
 *
 * A tax-bearing invoice is therefore REFUSED rather than quietly issued at zero.
 * Converting it would understate output tax on a document the customer receives
 * and the authority may clear. Server-authoritative tax is its own slice.
 */
/**
 * Figures the client may SEND but never decides.
 *
 * S2b refused tax outright because the server could not compute it. It can now
 * — from a tax code these books own, at a rate effective on the invoice's own
 * date — so the refusal moves rather than disappears: what is refused is the
 * client telling the server WHAT THE ANSWER IS.
 *
 * A rate, an amount, a category, a method or a snapshot arriving in the request
 * is not a hint to be validated, it is an attempt to author the one figure a
 * tax authority will hold a copy of. Ignoring those fields would be worse than
 * refusing: the caller would believe the invoice carried 5% and the books would
 * hold 16%, with nothing anywhere saying so. Only `taxCodeId` is accepted, and
 * every number is derived from it.
 */
const CLIENT_OWNED_TAX_FIELDS: Record<string, string> = {
  taxRate: 'a rate',
  taxAmount: 'an amount',
  taxCategory: 'a category',
  taxCalculationMethod: 'a calculation method',
  taxSnapshot: 'a snapshot',
  taxAccountId: 'an account',
};

const UNSUPPORTED_CHARGES =
  'Additional charges are not yet supported on server-held invoices: there is no controlled '
  + 'account for them, so the entry could not say where they post. Nothing has been saved.';

const UNSUPPORTED_INVENTORY =
  'This invoice sells inventory items. Stock movements and cost of sales have not moved to the '
  + 'server, so issuing here would sell stock without depleting it. Nothing has been saved.';

/** One message per browser-resident dimension, naming the field. */
const UNVERIFIABLE: Record<string, string> = {
  projectId: 'projects',
  costCenterId: 'cost centres',
  salespersonId: 'salespeople',
  templateId: 'invoice templates',
};

function refuseUnverifiable(field: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  const what = UNVERIFIABLE[field] ?? field;
  throw errors.validation(
    `This invoice references ${what}, which are still held in the browser and cannot be verified `
    + 'by the server. A durable invoice may not name a record the books cannot check. '
    + 'Nothing has been saved.',
    { fieldErrors: { [field]: `Remove the ${what} reference to save this invoice.` } },
  );
}

/**
 * Refuse anything the server cannot stand behind.
 *
 * Runs before any write, so a refused invoice leaves nothing at all — no draft,
 * no number, no line.
 */
function assertWithinBoundary(input: InvoiceInput): void {
  /* ── Tax: the code is the client's, every figure is the server's ─────── */
  for (const [index, line] of (input.lines ?? []).entries()) {
    const at = index + 1;
    for (const [field, what] of Object.entries(CLIENT_OWNED_TAX_FIELDS)) {
      const value = (line as unknown as Record<string, unknown>)[field];
      if (value === undefined || value === null || value === '') continue;
      /*
       * A zero rate is still an assertion about the tax. It is refused with
       * everything else rather than waved through, because "0" from a client
       * that believed the supply was exempt is exactly the mistake a
       * server-resolved category exists to prevent.
       */
      throw errors.validation(
        `This invoice supplies ${what} for its tax on line ${at}. Tax is calculated by the server `
        + 'from the tax code and the invoice date, so a figure sent with the request would be the '
        + 'client deciding what a tax authority is told. Send the tax code alone. Nothing has been saved.',
        { fieldErrors: { [`lines.${at}.${field}`]: 'Remove this — the server derives it from the tax code.' } },
      );
    }

    /*
     * Inventory is refused by the SHAPE of the line, not by a flag the client
     * sets. A line that names no item and no warehouse cannot move stock, so
     * this is a property of what was sent rather than a claim about it.
     */
    if (line.itemId) {
      throw errors.validation(UNSUPPORTED_INVENTORY, {
        fieldErrors: { [`lines.${at}.itemId`]: 'Remove the stock item, or issue this invoice from a demo workspace.' },
      });
    }

    refuseUnverifiable('projectId', line.projectId);
    refuseUnverifiable('costCenterId', line.costCenterId);
  }

  /* ── Charges ─────────────────────────────────────────────────────────── */
  if (input.additionalChargesTotal !== undefined
      && input.additionalChargesTotal !== ''
      && /[1-9]/.test(input.additionalChargesTotal)) {
    throw errors.validation(UNSUPPORTED_CHARGES, {
      fieldErrors: { additionalChargesTotal: 'Remove the additional charges to save this invoice.' },
    });
  }

  /* ── Decided by the server, never by the caller ───────────────────────── */
  if (input.status !== undefined) {
    throw errors.validation(
      'An invoice status is set by issuing or voiding it, not by asking for one. Nothing has been saved.',
      { fieldErrors: { status: 'Remove the status from the request.' } },
    );
  }
  if (input.invoiceNumber !== undefined) {
    throw errors.validation(
      'Invoice numbers are allocated by the server, in sequence, so two people cannot be given the '
      + 'same one. Nothing has been saved.',
      { fieldErrors: { invoiceNumber: 'Remove the invoice number from the request.' } },
    );
  }

  /* ── Browser-resident dimensions ─────────────────────────────────────── */
  refuseUnverifiable('projectId', input.projectId);
  refuseUnverifiable('costCenterId', input.costCenterId);
  refuseUnverifiable('salespersonId', input.salespersonId);
  refuseUnverifiable('templateId', input.templateId);
}

/**
 * The currency an invoice may be raised in.
 *
 * Only the company's functional currency. A foreign-currency invoice needs an
 * exchange rate, and rates are browser-resident — so the server would be
 * recording a converted figure it cannot justify. Refused rather than converted
 * at 1.0, which would silently misstate the receivable.
 */
function assertFunctionalCurrency(requested: string | undefined, functional: string): void {
  if (!requested) return;
  if (requested.trim().toUpperCase() !== functional.toUpperCase()) {
    throw errors.validation(
      `This invoice is in ${requested.toUpperCase()}, but only ${functional} invoices can be held on the `
      + 'server yet: exchange rates are still kept in the browser, so the server cannot justify a '
      + 'converted amount. Nothing has been saved.',
      { fieldErrors: { currency: `Raise this invoice in ${functional}.` } },
    );
  }
}

/**
 * Recompute every total from the lines.
 *
 * Never taken from the caller. A client that supplies its own grand total is a
 * client that can supply the wrong one, and the figure on a tax document is not
 * a matter of opinion — least of all once an authority holds a copy of it.
 */
async function computeTotals(
  trx: Executor,
  actor: AccountingActor,
  lines: InvoiceLineInput[],
  options: { additionalCharges?: string; decimals: number; taxPointDate: string },
): Promise<{
  computed: ComputedLine[];
  subtotal: Money.Amount;
  taxTotal: Money.Amount;
  chargesTotal: Money.Amount;
  grandTotal: Money.Amount;
}> {
  const { decimals, taxPointDate } = options;
  const additionalCharges = options.additionalCharges ?? '0';

  /*
   * Resolved ONCE per distinct code rather than per line, so a ten-line invoice
   * cannot end up with two different answers for one code because a rate
   * version was edited between two queries in the same loop.
   */
  const codeIds = [...new Set(
    lines.map((line) => line.taxCodeId).filter((id): id is string => Boolean(id)),
  )];
  const resolved = new Map<string, ResolvedTax>();
  for (const codeId of codeIds) {
    resolved.set(codeId, await resolveTaxForDate(trx, actor, codeId, taxPointDate));
  }

  const computed: ComputedLine[] = lines.map((line, index) => {
    const at = index + 1;
    const quantity = amount(line.quantity ?? '0', `line ${at} quantity`);
    const unitPrice = amount(line.unitPrice ?? '0', `line ${at} unitPrice`);
    if (Money.isNegative(quantity)) throw errors.validation(`Line ${at}: quantity cannot be negative.`);
    if (Money.isNegative(unitPrice)) throw errors.validation(`Line ${at}: unit price cannot be negative.`);

    // Quantity is a count, not money — multiply at scale and divide back.
    const gross = Money.multiply(quantity, unitPrice);
    const discount = amount(line.discountValue ?? '0', `line ${at} discountValue`);
    const discountAmount =
      line.discountType === 'percentage'
        ? Money.multiply(gross, discount) / 100n
        : discount;
    if (discountAmount > gross) throw errors.validation(`Line ${at}: the discount exceeds the line value.`);

    /*
     * Rounded to the CURRENCY, not left at the internal ten-digit scale.
     *
     * A percentage discount rarely lands on a minor unit — 10% of 99.999 is
     * 9.9999 — and a line net of 89.9991 JOD is an amount no customer can pay
     * and no receipt can clear to zero. The remainder is resolved here, once,
     * rather than surfacing later as a balance that will not close.
     */
    const lineAmount = Money.roundTo(gross - discountAmount, decimals);

    /*
     * The tax, from the code the line names and nothing else.
     *
     * `line.taxRate` and `line.taxAmount` are refused at the boundary above, so
     * there is no client figure here to be tempted by. A line with no code
     * bears no tax and is NOT the same as a zero-rated one — which is why the
     * category is only ever recorded when a code supplied it.
     */
    const tax = line.taxCodeId ? resolved.get(line.taxCodeId) ?? null : null;
    if (!tax) {
      return { input: line, lineSubtotal: lineAmount, taxAmount: Money.ZERO, lineTotal: lineAmount, tax: null };
    }

    const result = SalesTax.calculateTaxLine({
      lineAmount,
      rate: tax.rate,
      category: tax.category,
      method: tax.method,
      decimals,
    });

    /*
     * For INCLUSIVE tax the line amount already contains the tax, so the
     * subtotal is the extracted net and the line total is the amount the
     * customer was quoted — the gross does not grow. For EXCLUSIVE the net is
     * the line amount and the tax sits on top. Getting this backwards is how an
     * inclusive invoice silently overcharges by the rate.
     */
    return {
      input: line,
      lineSubtotal: result.taxableAmount,
      taxAmount: result.taxAmount,
      lineTotal: result.grossAmount,
      tax,
    };
  });

  const subtotal = Money.sum(computed.map((c) => c.lineSubtotal));
  const taxTotal = Money.sum(computed.map((c) => c.taxAmount));

  const chargesTotal = amount(additionalCharges ?? '0', 'additionalChargesTotal');
  if (Money.isNegative(chargesTotal)) {
    throw errors.validation('Additional charges cannot be negative.');
  }

  return { computed, subtotal, taxTotal, chargesTotal, grandTotal: subtotal + taxTotal + chargesTotal };
}

/**
 * Every account on the invoice, re-resolved against THIS organization.
 *
 * The composite foreign key would refuse a foreign account anyway, but a
 * constraint violation surfaces as a 500 and says nothing useful. This names
 * the offending line, and applies the same posting-eligibility rules the
 * ledger does — an invoice must not credit a header account any more than a
 * journal may debit one.
 */
async function assertAccountsArePostable(
  trx: Trx,
  actor: AccountingActor,
  lines: InvoiceLineInput[],
): Promise<void> {
  const ids = lines.map((line) => line.accountId).filter(Boolean);
  if (ids.some((id) => !id)) throw errors.validation('Every line needs an account.');

  // The same loader the ledger uses, so an invoice and a journal cannot
  // disagree about whether an account may receive a posting.
  const accounts = await loadAccountsForPosting(trx, actor.organizationId, actor.companyId, ids);

  for (const [index, line] of lines.entries()) {
    const at = index + 1;
    if (!line.accountId) throw errors.validation(`Line ${at}: an account is required.`);
    const account = accounts.get(line.accountId);
    if (!account) throw errors.validation(`Line ${at}: the account does not exist in this organization.`);

    const child = await trx.selectFrom('accounts').select('id')
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('parent_account_id', '=', line.accountId)
      .executeTakeFirst();

    const verdict = assessPostingAccount(account, Boolean(child));
    if (!verdict.eligible) throw errors.validation(`Line ${at}: ${verdict.message ?? 'This account cannot receive postings.'}`);
  }
}

function assertDates(input: InvoiceInput): void {
  if (!ISO_DATE.test(input.issueDate ?? '')) {
    throw errors.validation('issueDate must be an ISO date (yyyy-mm-dd).');
  }
  if (!ISO_DATE.test(input.dueDate ?? '')) {
    throw errors.validation('dueDate must be an ISO date (yyyy-mm-dd).');
  }
  if (input.dueDate < input.issueDate) {
    throw errors.validation('The due date cannot fall before the issue date.');
  }
}

async function functionalCurrencyOf(executor: Executor, organizationId: string): Promise<string> {
  const org = await executor.selectFrom('organizations').select('base_currency')
    .where('id', '=', organizationId).executeTakeFirst();
  if (!org) throw errors.notFound('Organization');
  return org.base_currency;
}

async function writeAudit(
  trx: Trx,
  actor: AccountingActor,
  invoiceId: string,
  action: string,
  detail = '',
): Promise<void> {
  await trx.insertInto('invoice_audit_events')
    .values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      invoice_id: invoiceId,
      action,
      detail,
      actor_user_id: actor.userId,
    })
    .execute();
}

async function replaceLines(
  trx: Trx,
  actor: AccountingActor,
  invoiceId: string,
  computed: ComputedLine[],
  decimals: number,
): Promise<void> {
  await trx.deleteFrom('invoice_lines')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('invoice_id', '=', invoiceId)
    .execute();

  for (const [index, line] of computed.entries()) {
    const value = line.input;
    for (const [field, raw] of [['unitPrice', value.unitPrice]] as const) {
      if (raw !== undefined && Money.exceedsPrecision(amount(raw, field), decimals)) {
        throw errors.validation(
          `Line ${index + 1}: ${field} carries more decimal places than this currency allows.`,
        );
      }
    }
    await trx.insertInto('invoice_lines').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      invoice_id: invoiceId,
      line_number: index + 1,
      account_id: value.accountId,
      item_id: value.itemId ?? null,
      description: value.description ?? '',
      quantity: value.quantity ?? '0',
      unit: value.unit ?? '',
      unit_price: value.unitPrice ?? '0',
      discount_type: value.discountType ?? null,
      discount_value: value.discountValue ?? null,
      tax_code_id: value.taxCodeId ?? null,
      /*
       * The rate the SERVER resolved, never the one the request carried — that
       * one is refused at the boundary. A draft stores it so the screen can
       * show what the invoice would charge; the snapshot columns beside it stay
       * empty until issue, because until then nothing is frozen.
       */
      tax_rate: line.tax ? Money.toDecimalString(line.tax.rate) : '0',
      tax_amount: Money.toDecimalString(line.taxAmount),
      taxable_amount: Money.toDecimalString(line.lineSubtotal),
      line_subtotal: Money.toDecimalString(line.lineSubtotal),
      line_total: Money.toDecimalString(line.lineTotal),
      entity_id: value.entityId ?? null,
      project_id: value.projectId ?? null,
      cost_center_id: value.costCenterId ?? null,
    }).execute();
  }
}

/* ══ Writing ═══════════════════════════════════════════════════════════════ */

/**
 * The customer this invoice names must actually be one, in THESE books.
 *
 * The foreign key from migration 031 already makes a cross-company or invented
 * customer unrepresentable, but a constraint violation reaches the caller as an
 * internal error — accurate and useless. This says which of the three things is
 * wrong, and it checks the two the key cannot:
 *
 *   · the party must hold the CUSTOMER role. Roles are mutable flags, not part
 *     of any key, so nothing in the schema stops an invoice naming a
 *     supplier-only party;
 *   · the party must not be ARCHIVED. Archiving means "do not put this on new
 *     documents", which is exactly this moment. Existing invoices keep naming
 *     an archived customer, which is the point of archiving rather than
 *     deleting.
 */
async function assertCustomerSelectable(
  trx: Transaction<Database>,
  actor: AccountingActor,
  customerId: string,
): Promise<void> {
  const party = await trx
    .selectFrom('business_parties')
    .select(['id', 'is_customer', 'status', 'legal_name'])
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', customerId)
    .executeTakeFirst();

  /* Another company's customer does not resolve, which is the honest answer:
   * there is no such customer in these books. */
  if (!party) {
    throw errors.validation('That customer is not in these books.', {
      fieldErrors: { customerId: 'Choose a customer from this directory.' },
    });
  }
  if (!party.is_customer) {
    throw errors.validation(`${party.legal_name} is not a customer.`, {
      fieldErrors: { customerId: 'This party does not hold the customer role.' },
    });
  }
  if (party.status !== 'active') {
    throw errors.validation(`${party.legal_name} is archived and cannot be invoiced.`, {
      fieldErrors: { customerId: 'Restore the customer, or choose another.' },
    });
  }
}

export async function createDraft(
  db: Kysely<Database>,
  actor: AccountingActor,
  input: InvoiceInput,
): Promise<InvoiceRecord> {
  assertDates(input);
  if (!input.customerId) throw errors.validation('A customer is required.');
  if (!input.issuingEntityId) throw errors.validation('An issuing entity is required.');
  if (!input.lines || input.lines.length === 0) throw errors.validation('An invoice needs at least one line.');

  /* Refused before any write, so a rejected invoice leaves nothing behind. */
  assertWithinBoundary(input);

  return db.transaction().execute(async (trx) => {
    await assertCustomerSelectable(trx, actor, input.customerId);
    await assertAccountsArePostable(trx, actor, input.lines);

    const currency = await functionalCurrencyOf(trx, actor.organizationId);
    assertFunctionalCurrency(input.currency, currency);
    const decimals = monetaryDecimalsFor(currency);

    /*
     * Computed here, where the currency's precision AND the tax date are known.
     * The tax point is the invoice's own `issueDate` — see `resolveTaxForDate`
     * for why that is the only internally consistent choice.
     */
    const { computed, subtotal, taxTotal, chargesTotal, grandTotal } =
      await computeTotals(trx, actor, input.lines, {
        additionalCharges: input.additionalChargesTotal,
        decimals,
        taxPointDate: input.issueDate,
      });
    const invoiceNumber = await allocateInvoiceNumber(trx, actor.organizationId, actor.companyId, input.issuingEntityId, input.issueDate);

    const created = await trx.insertInto('invoices').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      issuing_entity_id: input.issuingEntityId,
      customer_id: input.customerId,
      invoice_number: invoiceNumber,
      status: 'draft',
      issue_date: input.issueDate,
      due_date: input.dueDate,
      transaction_currency: currency,
      functional_currency: currency,
      purchase_order_reference: input.purchaseOrderReference ?? '',
      customer_reference: input.customerReference ?? '',
      salesperson_id: input.salespersonId ?? null,
      project_id: input.projectId ?? null,
      cost_center_id: input.costCenterId ?? null,
      template_id: input.templateId ?? null,
      template_version_id: input.templateVersionId ?? null,
      subtotal: Money.toDecimalString(subtotal),
      tax_total: Money.toDecimalString(taxTotal),
      additional_charges_total: Money.toDecimalString(chargesTotal),
      grand_total: Money.toDecimalString(grandTotal),
      balance_due: Money.toDecimalString(grandTotal),
      notes: input.notes ?? '',
      terms: input.terms ?? '',
      payment_terms: input.paymentTerms ?? '',
      created_by: actor.userId,
      updated_by: actor.userId,
    }).returning('id').executeTakeFirstOrThrow();

    await replaceLines(trx, actor, created.id, computed, decimals);
    await writeAudit(trx, actor, created.id, 'invoice.created', invoiceNumber);
    return loadInvoice(trx, actor, created.id);
  });
}

export async function updateDraft(
  db: Kysely<Database>,
  actor: AccountingActor,
  id: string,
  input: InvoiceInput,
  options: MutationOptions,
): Promise<InvoiceRecord> {
  assertDates(input);
  if (!input.lines || input.lines.length === 0) throw errors.validation('An invoice needs at least one line.');

  /* The same boundary as creation: an edit cannot introduce tax, stock or a
   * browser-only dimension that a create would have refused. */
  assertWithinBoundary(input);

  return db.transaction().execute(async (trx) => {
    const current = await lockInvoice(trx, actor, id, options.expectedVersion);
    if (!EDITABLE.includes(current.status)) {
      throw errors.conflict(
        `This invoice is ${current.status} and can no longer be edited. Void it and issue a corrected one.`,
      );
    }

    /* The customer may be changed by an edit, so it is re-checked: still in
     * these books, still holding the role, still not archived. */
    if (input.customerId) await assertCustomerSelectable(trx, actor, input.customerId);
    await assertAccountsArePostable(trx, actor, input.lines);
    const decimals = monetaryDecimalsFor(current.transaction_currency);
    assertFunctionalCurrency(input.currency, current.transaction_currency);

    /*
     * A DRAFT recalculates, and only a draft. The rule is explicit because the
     * alternative is invisible: leaving a draft on a rate that has since been
     * superseded would issue tax nobody charges any more. An ISSUED invoice
     * never passes through here — `EDITABLE` stops it above — so no posted
     * document is ever recomputed.
     */
    const { computed, subtotal, taxTotal, chargesTotal, grandTotal } =
      await computeTotals(trx, actor, input.lines, {
        additionalCharges: input.additionalChargesTotal,
        decimals,
        taxPointDate: input.issueDate,
      });

    await trx.updateTable('invoices').set({
      customer_id: input.customerId,
      issue_date: input.issueDate,
      due_date: input.dueDate,
      purchase_order_reference: input.purchaseOrderReference ?? '',
      customer_reference: input.customerReference ?? '',
      salesperson_id: input.salespersonId ?? null,
      project_id: input.projectId ?? null,
      cost_center_id: input.costCenterId ?? null,
      subtotal: Money.toDecimalString(subtotal),
      tax_total: Money.toDecimalString(taxTotal),
      additional_charges_total: Money.toDecimalString(chargesTotal),
      grand_total: Money.toDecimalString(grandTotal),
      balance_due: Money.toDecimalString(grandTotal - Money.toAmount(current.amount_paid)),
      notes: input.notes ?? '',
      terms: input.terms ?? '',
      payment_terms: input.paymentTerms ?? '',
      version: current.version + 1,
      updated_by: actor.userId,
      updated_at: new Date(),
    }).where('organization_id', '=', actor.organizationId).where('company_id', '=', actor.companyId).where('id', '=', id).execute();

    await replaceLines(trx, actor, id, computed, decimals);
    await writeAudit(trx, actor, id, 'invoice.updated');
    return loadInvoice(trx, actor, id);
  });
}

/**
 * Take the row's lock and check the concurrency token in one step.
 *
 * `forUpdate` matters: without it two concurrent issues both read version 3,
 * both believe they are current, and both proceed.
 */
async function lockInvoice(
  trx: Trx,
  actor: AccountingActor,
  id: string,
  expectedVersion: number | undefined,
) {
  const row = await trx.selectFrom('invoices').selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw errors.notFound('Invoice');

  if (expectedVersion === undefined) {
    throw errors.validation('expectedVersion is required so a concurrent change cannot be overwritten.');
  }
  if (row.version !== expectedVersion) throw errors.conflict(CONCURRENCY_MESSAGE);
  return row;
}

export async function deleteDraft(
  db: Kysely<Database>,
  actor: AccountingActor,
  id: string,
  options: MutationOptions,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const current = await lockInvoice(trx, actor, id, options.expectedVersion);
    if (!EDITABLE.includes(current.status)) {
      throw errors.conflict(
        `This invoice is ${current.status}. An issued invoice is voided, never deleted — the number has been used.`,
      );
    }
    await trx.deleteFrom('invoices')
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id).execute();
  });
}

/**
 * The account this invoice debits, decided by the server.
 *
 * ══ Why not from the request ═════════════════════════════════════════════════
 *
 * It used to arrive in the body: `receivableAccountId`, chosen by whatever
 * screen happened to be calling. A caller who named a different account
 * balanced their own entry while leaving the real receivable outstanding
 * forever — and settlement, which credits whatever the invoice recorded, would
 * then clear a balance nobody owed.
 *
 * S1 put the answer in the customer's own profile, with a real foreign key to
 * `accounts` in the same books. So the server reads it rather than being told,
 * and a customer with no receivable configured is refused with the reason
 * instead of defaulting to something plausible.
 */
async function resolveReceivableAccount(
  trx: Transaction<Database>,
  actor: AccountingActor,
  customerId: string,
): Promise<string> {
  const profile = await trx
    .selectFrom('business_party_customer_profiles')
    .select('default_receivable_account_id')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('party_id', '=', customerId)
    .executeTakeFirst();

  const accountId = profile?.default_receivable_account_id;
  if (!accountId) {
    throw errors.validation(
      'This customer has no receivable account set, so there is nothing for the invoice to debit. '
      + 'Set one on the customer record and try again.',
      { fieldErrors: { customerId: 'Set a receivable account on the customer record.' } },
    );
  }
  return accountId;
}

/* ══ Freezing the tax onto the issued lines ═══════════════════════════════ */

interface FrozenLine {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  row: any;
  taxableAmount: Money.Amount;
  taxAmount: Money.Amount;
  tax: ResolvedTax | null;
}

/**
 * Recompute each line's tax at the invoice's date and WRITE THE SNAPSHOT.
 *
 * ══ Why the snapshot is denormalised onto the line ═══════════════════════════
 *
 * `tax_code_id` alone makes an issued invoice depend on mutable configuration:
 * archive the code, end-date the rate, correct a typo in its name, and the
 * document's own history changes underneath it. A tax authority holding a copy
 * of that invoice does not see the code change with it.
 *
 * So every fact needed to reproduce the figure is copied onto the line — the
 * code's identity and name, the category, the method, the rate, WHICH rate
 * version it came from, the base, the tax, the account it posted to, and the
 * date the rate was resolved on. Nothing but a reversal may write these again.
 */
async function freezeLineTax(
  trx: Trx,
  actor: AccountingActor,
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  lines: any[],
  options: { issueDate: string; decimals: number },
): Promise<FrozenLine[]> {
  const { issueDate, decimals } = options;

  /* One resolution per code, so every line sharing a code shares one answer. */
  const codeIds = [...new Set(
    lines.map((line) => line.tax_code_id).filter((id): id is string => Boolean(id)),
  )];
  const resolved = new Map<string, ResolvedTax>();
  for (const codeId of codeIds) {
    const tax = await resolveTaxForDate(trx, actor, codeId, issueDate);
    /*
     * The account is re-checked HERE, not only when the code was configured. An
     * account can be archived, blocked, deactivated or given a child between
     * configuration and issue, and posting tax to one the ledger would refuse
     * from any other door is exactly the inconsistency this check exists for.
     */
    if (SalesTax.chargesTax(tax.category)) {
      await assertOutputAccountPostable(trx, actor, tax);
    }
    resolved.set(codeId, tax);
  }

  const frozen: FrozenLine[] = [];
  const capturedAt = new Date();

  for (const row of lines) {
    const tax = row.tax_code_id ? resolved.get(row.tax_code_id) ?? null : null;

    /*
     * The base is rebuilt from quantity, price and discount rather than read
     * back from `line_subtotal`, because for an inclusive line that column
     * holds the NET the draft extracted — feeding it back in would extract the
     * tax a second time and understate the sale on every re-issue.
     */
    const quantity = Money.toAmount(String(row.quantity ?? '0'), 'quantity');
    const unitPrice = Money.toAmount(String(row.unit_price ?? '0'), 'unitPrice');
    const gross = Money.multiply(quantity, unitPrice);
    const discount = Money.toAmount(String(row.discount_value ?? '0'), 'discountValue');
    const discountAmount = row.discount_type === 'percentage'
      ? Money.multiply(gross, discount) / 100n
      : discount;
    const lineAmount = Money.roundTo(gross - discountAmount, decimals);

    if (!tax) {
      frozen.push({ row, taxableAmount: lineAmount, taxAmount: Money.ZERO, tax: null });
      await trx.updateTable('invoice_lines').set({
        taxable_amount: Money.toDecimalString(lineAmount),
        line_subtotal: Money.toDecimalString(lineAmount),
        line_total: Money.toDecimalString(lineAmount),
        tax_amount: '0',
        tax_rate: '0',
      } as never)
        .where('organization_id', '=', actor.organizationId)
        .where('company_id', '=', actor.companyId)
        .where('id', '=', row.id)
        .execute();
      continue;
    }

    const result = SalesTax.calculateTaxLine({
      lineAmount, rate: tax.rate, category: tax.category, method: tax.method, decimals,
    });

    frozen.push({ row, taxableAmount: result.taxableAmount, taxAmount: result.taxAmount, tax });

    await trx.updateTable('invoice_lines').set({
      tax_rate: Money.toDecimalString(SalesTax.effectiveRate(tax.rate, tax.category)),
      tax_amount: Money.toDecimalString(result.taxAmount),
      taxable_amount: Money.toDecimalString(result.taxableAmount),
      line_subtotal: Money.toDecimalString(result.taxableAmount),
      line_total: Money.toDecimalString(result.grossAmount),
      tax_rate_version_id: tax.rateVersionId,
      tax_code_code: tax.code,
      tax_code_name: tax.name,
      tax_category: tax.category,
      tax_calculation_method: tax.method,
      tax_rate_effective_from: tax.effectiveFrom,
      tax_rate_effective_to: tax.effectiveTo,
      tax_account_id: tax.outputTaxAccountId,
      tax_point_date: issueDate,
      tax_snapshot_at: capturedAt,
    } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', row.id)
      .execute();
  }

  return frozen;
}

/** The one output account this invoice used, or null when it used several. */
function singleTaxAccountOf(lines: FrozenLine[]): string | null {
  const accounts = new Set(
    lines.map((line) => line.tax?.outputTaxAccountId).filter((id): id is string => Boolean(id)),
  );
  return accounts.size === 1 ? [...accounts][0]! : null;
}

/** Tax owed per output account, with the codes that contributed to each. */
function groupTaxByAccount(
  lines: FrozenLine[],
): { accountId: string; amount: Money.Amount; codes: string[] }[] {
  const byAccount = new Map<string, { amount: Money.Amount; codes: Set<string> }>();
  for (const line of lines) {
    if (!line.tax || !line.tax.outputTaxAccountId || Money.isZero(line.taxAmount)) continue;
    const entry = byAccount.get(line.tax.outputTaxAccountId)
      ?? { amount: Money.ZERO, codes: new Set<string>() };
    entry.amount = Money.add(entry.amount, line.taxAmount);
    entry.codes.add(line.tax.code);
    byAccount.set(line.tax.outputTaxAccountId, entry);
  }
  return [...byAccount.entries()].map(([accountId, entry]) => ({
    accountId, amount: entry.amount, codes: [...entry.codes].sort(),
  }));
}

/**
 * Issue an invoice: one transaction, or nothing.
 *
 * ══ The defect this replaces ═════════════════════════════════════════════════
 *
 * Issuing used to run in THREE transactions: read and lock the draft, create
 * and post the journal, then re-lock and attach it. Every gap between them was
 * a state the books could be left in. A crash after the posting committed left
 * a posted sales journal with no issued invoice behind it — revenue in the
 * ledger that no document explains, and a draft the user would issue again,
 * posting it twice.
 *
 * The old comment justified the split by saying `journalService` owns posting
 * and reaching into it with our transaction would fork its write path. That was
 * the right instinct and the wrong remedy: the answer is not three transactions
 * but one shared one, which is what `createDraftIn` / `postJournalIn` /
 * `postSourceJournalIn` now exist for. The journal is still written by
 * `journalService` and by nothing else; it simply writes inside the caller's
 * unit of work.
 *
 * ══ Retries cannot double-post ═══════════════════════════════════════════════
 *
 * The journal carries the source identity `(sales_invoice, <invoice id>, issue)`
 * and the unique index from migration 029 enforces it. A retry after a lost
 * response finds the journal already there and returns it; two concurrent
 * issues resolve to one, because the loser's INSERT is refused by the database
 * rather than by a check that two connections can both pass.
 *
 * The previous implementation supplied a source TYPE and ID but no EVENT, and
 * that index is partial on the event — so it covered nothing, and a retry wrote
 * a second journal.
 *
 * ══ What is NOT allocated here ═══════════════════════════════════════════════
 *
 * The invoice number. It is allocated when the draft is created, under an
 * advisory lock in that transaction, and issuing does not change it. Moving
 * allocation to issue time would change what a draft shows and how gaps arise,
 * which is numbering policy rather than atomicity, and is not this slice's to
 * change.
 */
export async function issueInvoice(
  db: Kysely<Database>,
  actor: AccountingActor,
  id: string,
  options: MutationOptions,
): Promise<InvoiceRecord> {
  return db.transaction().execute(async (trx) => {
    const current = await lockInvoice(trx, actor, id, options.expectedVersion);
    if (!EDITABLE.includes(current.status)) {
      throw errors.conflict(`This invoice is already ${current.status}.`);
    }

    const lines = await trx.selectFrom('invoice_lines').selectAll()
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('invoice_id', '=', id)
      .orderBy('line_number', 'asc')
      .execute();
    if (lines.length === 0) {
      throw errors.validation('An invoice needs at least one line before it can be issued.');
    }

    const receivableAccountId = await resolveReceivableAccount(trx, actor, current.customer_id);

    const issueDate = dateText(current.issue_date);
    const decimals = monetaryDecimalsFor(current.transaction_currency);

    /*
     * ══ The tax is recomputed HERE, and this is the moment it freezes ═══════
     *
     * Not carried forward from the draft. A draft's figures were resolved when
     * it was last saved, and a rate version added since would leave the posted
     * journal disagreeing with the code the invoice names. Recomputing at issue
     * against the invoice's own date makes the snapshot, the stored totals and
     * the journal one answer by construction rather than by hoping three writes
     * stayed in step.
     */
    const taxed = await freezeLineTax(trx, actor, lines, { issueDate, decimals });

    const subtotal = Money.sum(taxed.map((line) => line.taxableAmount));
    const taxDue = Money.sum(taxed.map((line) => line.taxAmount));
    const charges = Money.toAmount(current.additional_charges_total);
    const total = Money.add(Money.add(subtotal, taxDue), charges);

    /*
     * Tax is credited to a LIABILITY account, never back to the receivable.
     *
     * Crediting it to the receivable balances the entry — which is why this was
     * invisible — but it nets the customer's ledger balance down to the sale
     * value while the invoice itself says they owe the tax-inclusive total. The
     * subledger and the general ledger then disagree by exactly the tax, and the
     * tax collected on the authority's behalf is recorded as owed to nobody.
     */

    /*
     * Additional charges are part of what the customer owes, so they are inside
     * the receivable debit and need a credit of their own. Without one the entry
     * is out of balance by exactly the charges — which `journalService` would
     * refuse, turning a missing account into an unexplained posting failure.
     * Still refused: S2c brought tax, not a charges account.
     */
    if (!Money.isZero(charges)) throw errors.validation(UNSUPPORTED_CHARGES);

    /*
     * Posted through the source-posting door, inside THIS transaction, so the
     * entry and the document below it commit together or not at all.
     */
    const { journal } = await postSourceJournalIn(trx, actor, {
      sourceType: INVOICE_SOURCE_TYPE,
      sourceId: id,
      sourceEvent: INVOICE_ISSUE_EVENT,
      transactionDate: dateText(current.issue_date),
      reference: current.invoice_number,
      description: `Sales invoice ${current.invoice_number}`,
      lines: [
        { accountId: receivableAccountId, debit: Money.toDecimalString(total), memo: current.invoice_number },
        /*
         * Revenue is credited NET of tax, for both methods. On an inclusive
         * invoice that means the revenue leg is smaller than the line the
         * customer sees — which is the whole point: the difference is not the
         * seller's income, it is money held for an authority.
         */
        ...taxed.map((line) => ({
          accountId: line.row.account_id,
          credit: Money.toDecimalString(line.taxableAmount),
          memo: line.row.description,
          entityId: line.row.entity_id,
          projectId: line.row.project_id,
          costCenterId: line.row.cost_center_id,
        })),
        /*
         * One leg per output account, not one per line: several lines sharing a
         * code produce one credit, and two codes mapped to different accounts
         * stay apart — which is what makes a control-account reconciliation
         * possible at all.
         */
        ...groupTaxByAccount(taxed).map(({ accountId, amount: taxAmount, codes }) => ({
          accountId,
          credit: Money.toDecimalString(taxAmount),
          memo: `Output tax ${codes.join(', ')} — ${current.invoice_number}`,
        })),
      ],
    });

    await trx.updateTable('invoices').set({
      status: 'issued',
      journal_entry_id: journal.id,
      /*
       * Recorded so settlement credits the receivable this invoice DEBITED.
       * A receipt told to use some other account balances its own entry while
       * leaving this invoice's receivable outstanding forever.
       */
      receivable_account_id: receivableAccountId,
      /*
       * Recomputed at issue, so the stored totals, the frozen line snapshots
       * and the posted journal are one answer rather than three writes hoping
       * to agree.
       */
      subtotal: Money.toDecimalString(subtotal),
      tax_total: Money.toDecimalString(taxDue),
      grand_total: Money.toDecimalString(total),
      balance_due: Money.toDecimalString(total),
      /*
       * The single output account when the invoice used exactly one, and NULL
       * when it used several. Null is honest here: two codes mapped to
       * different control accounts have no one account this column could name,
       * and the per-line snapshots are where that detail actually lives.
       */
      tax_account_id: singleTaxAccountOf(taxed),
      additional_charges_account_id: null,
      issued_at: new Date(),
      version: current.version + 1,
      updated_by: actor.userId,
      updated_at: new Date(),
    }).where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .execute();

    await writeAudit(trx, actor, id, 'invoice.issued', journal.journalNumber);
    return loadInvoice(trx, actor, id);
  });
}

/**
 * Void an issued invoice: reverse its ledger entry, keep both documents.
 *
 * Never a delete. The number has been used, the customer may hold a copy, and
 * once a tax authority has cleared it there is a third party holding one too.
 */
export async function voidInvoice(
  db: Kysely<Database>,
  actor: AccountingActor,
  id: string,
  options: MutationOptions,
): Promise<InvoiceRecord> {
  const reason = options.reason?.trim();
  if (!reason) {
    throw errors.validation('A reason is required and is recorded against the invoice.', {
      fieldErrors: { reason: 'Explain why this invoice is being voided.' },
    });
  }

  /*
   * Company-scoped, like every other read of an invoice.
   *
   * This runs BEFORE the transaction that locks the row, so an
   * organization-only filter disclosed another company's invoice number, status
   * and journal id — and could answer "this invoice is already void" for a
   * document the caller may not see. The write below was always safe, because
   * `lockInvoice` is scoped; the disclosure happened before it.
   */
  const current = await db.selectFrom('invoices').selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!current) throw errors.notFound('Invoice');
  if (current.status === 'void') throw errors.conflict('This invoice is already void.');

  let reversalId: string | null = null;
  if (current.journal_entry_id) {
    const entry = await journals.getJournal(db, actor, current.journal_entry_id);
    const reversal = await journals.reverseJournal(
      db, actor, current.journal_entry_id,
      { expectedVersion: entry.version, reason: `Void invoice ${current.invoice_number}: ${reason}` },
    );
    reversalId = reversal.reversal.id;
  }

  return db.transaction().execute(async (trx) => {
    const locked = await lockInvoice(trx, actor, id, options.expectedVersion);
    await trx.updateTable('invoices').set({
      status: 'void',
      void_reason: reason,
      voided_at: new Date(),
      reversal_journal_entry_id: reversalId,
      balance_due: '0',
      version: locked.version + 1,
      updated_by: actor.userId,
      updated_at: new Date(),
    }).where('organization_id', '=', actor.organizationId).where('company_id', '=', actor.companyId).where('id', '=', id).execute();

    await writeAudit(trx, actor, id, 'invoice.voided', reason);
    return loadInvoice(trx, actor, id);
  });
}

/** The audit trail for one invoice, oldest first. */
export async function auditHistory(
  db: Kysely<Database>,
  actor: AccountingActor,
  id: string,
): Promise<Array<{ action: string; detail: string; at: string; actorUserId: string | null }>> {
  await loadInvoice(db, actor, id); // 404 for another tenant's id, not an empty list.
  const rows = await db.selectFrom('invoice_audit_events').selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('invoice_id', '=', id)
    .orderBy('occurred_at', 'asc')
    .execute();
  return rows.map((row) => ({
    action: row.action,
    detail: row.detail,
    at: new Date(row.occurred_at as unknown as string).toISOString(),
    actorUserId: row.actor_user_id,
  }));
}

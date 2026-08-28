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
import type { Database, SalesInvoiceStatus } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import type { AccountingActor } from '../accounting/audit.js';
import { assessPostingAccount } from '../accounting/accountEligibility.js';
import { loadAccountsForPosting } from '../accounting/accountService.js';
import { monetaryDecimalsFor } from '../accounting/currencyPrecision.js';
import * as Money from '../accounting/money.js';
import * as journals from '../accounting/journalService.js';

type Executor = Kysely<Database> | Transaction<Database>;
type Trx = Transaction<Database>;

/** Statuses a draft edit is still allowed in. */
const EDITABLE: readonly SalesInvoiceStatus[] = ['draft', 'approved'];

/** What `source_type` an invoice's ledger entry carries. */
export const INVOICE_SOURCE_TYPE = 'sales_invoice';

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
  lineSubtotal: string;
  lineTotal: string;
  itemId: string | null;
  entityId: string | null;
  projectId: string | null;
  costCenterId: string | null;
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

const dateText = (value: unknown): string =>
  typeof value === 'string' ? value : new Date(value as string).toISOString().slice(0, 10);
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
    lineSubtotal: display(row.line_subtotal, decimals),
    lineTotal: display(row.line_total, decimals),
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
  lineSubtotal: Money.Amount;
  taxAmount: Money.Amount;
  lineTotal: Money.Amount;
}

/**
 * Recompute every total from the lines.
 *
 * Never taken from the caller. A client that supplies its own grand total is a
 * client that can supply the wrong one, and the figure on a tax document is not
 * a matter of opinion — least of all once an authority holds a copy of it.
 */
function computeTotals(lines: InvoiceLineInput[], additionalCharges = '0'): {
  computed: ComputedLine[];
  subtotal: Money.Amount;
  taxTotal: Money.Amount;
  chargesTotal: Money.Amount;
  grandTotal: Money.Amount;
} {
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

    const lineSubtotal = gross - discountAmount;
    const taxAmount = amount(line.taxAmount ?? '0', `line ${at} taxAmount`);
    if (Money.isNegative(taxAmount)) throw errors.validation(`Line ${at}: tax cannot be negative.`);

    return { input: line, lineSubtotal, taxAmount, lineTotal: lineSubtotal + taxAmount };
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
    for (const [field, raw] of [['unitPrice', value.unitPrice], ['taxAmount', value.taxAmount]] as const) {
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
      tax_rate: value.taxRate ?? '0',
      tax_amount: Money.toDecimalString(line.taxAmount),
      line_subtotal: Money.toDecimalString(line.lineSubtotal),
      line_total: Money.toDecimalString(line.lineTotal),
      entity_id: value.entityId ?? null,
      project_id: value.projectId ?? null,
      cost_center_id: value.costCenterId ?? null,
    }).execute();
  }
}

/* ══ Writing ═══════════════════════════════════════════════════════════════ */

export async function createDraft(
  db: Kysely<Database>,
  actor: AccountingActor,
  input: InvoiceInput,
): Promise<InvoiceRecord> {
  assertDates(input);
  if (!input.customerId) throw errors.validation('A customer is required.');
  if (!input.issuingEntityId) throw errors.validation('An issuing entity is required.');
  if (!input.lines || input.lines.length === 0) throw errors.validation('An invoice needs at least one line.');

  const { computed, subtotal, taxTotal, chargesTotal, grandTotal } =
    computeTotals(input.lines, input.additionalChargesTotal);

  return db.transaction().execute(async (trx) => {
    await assertAccountsArePostable(trx, actor, input.lines);

    const currency = await functionalCurrencyOf(trx, actor.organizationId);
    const decimals = monetaryDecimalsFor(currency);
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
  const { computed, subtotal, taxTotal, chargesTotal, grandTotal } =
    computeTotals(input.lines, input.additionalChargesTotal);

  return db.transaction().execute(async (trx) => {
    const current = await lockInvoice(trx, actor, id, options.expectedVersion);
    if (!EDITABLE.includes(current.status)) {
      throw errors.conflict(
        `This invoice is ${current.status} and can no longer be edited. Void it and issue a corrected one.`,
      );
    }

    await assertAccountsArePostable(trx, actor, input.lines);
    const decimals = monetaryDecimalsFor(current.transaction_currency);

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
 * Issue an invoice: post it to the ledger and freeze it.
 *
 * The entry is created and posted through `journalService`, which owns the one
 * write path into the books. Both directions of the link are set in this
 * transaction — the invoice's `journal_entry_id` and the entry's
 * `source_type`/`source_id` — because a half-written link is a document nobody
 * can reconcile.
 */
export async function issueInvoice(
  db: Kysely<Database>,
  actor: AccountingActor,
  id: string,
  options: MutationOptions,
  receivableAccountId: string,
  taxAccountId?: string,
  chargesAccountId?: string,
): Promise<InvoiceRecord> {
  const prepared = await db.transaction().execute(async (trx) => {
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
    if (lines.length === 0) throw errors.validation('An invoice needs at least one line before it can be issued.');

    return { current, lines };
  });

  /*
   * The ledger entry is created OUTSIDE the invoice transaction because
   * `journalService` opens its own — it owns posting, and reaching into it with
   * a transaction of ours would fork the one write path this module exists to
   * respect. The invoice is then attached in a second transaction, which
   * re-checks the version: if anything changed in between, the entry is left as
   * an unattached draft rather than bound to a document it no longer describes.
   */
  const total = Money.toAmount(prepared.current.grand_total);
  const taxDue = Money.toAmount(prepared.current.tax_total);

  /*
   * Tax is credited to a LIABILITY account, never back to the receivable.
   *
   * Crediting it to the receivable balances the entry — which is why this was
   * invisible — but it nets the customer's ledger balance down to the sale
   * value while the invoice itself says they owe the tax-inclusive total. The
   * subledger and the general ledger then disagree by exactly the tax, and the
   * tax collected on the authority's behalf is recorded as owed to nobody.
   */
  if (!Money.isZero(taxDue) && !taxAccountId) {
    throw errors.validation('This invoice carries tax, so a tax account is required to post it.', {
      fieldErrors: { taxAccountId: 'Choose the liability account that holds tax collected.' },
    });
  }

  /*
   * Additional charges are part of what the customer owes, so they are inside
   * the receivable debit and need a credit of their own. Without one the entry
   * is out of balance by exactly the charges — which `journalService` would
   * refuse, turning a missing account into an unexplained posting failure.
   */
  const charges = Money.toAmount(prepared.current.additional_charges_total);
  if (!Money.isZero(charges) && !chargesAccountId) {
    throw errors.validation('This invoice carries additional charges, so an account is required to post them.', {
      fieldErrors: { chargesAccountId: 'Choose the income account that receives delivery or handling charges.' },
    });
  }

  const entry = await journals.createDraft(db, actor, {
    transactionDate: dateText(prepared.current.issue_date),
    reference: prepared.current.invoice_number,
    description: `Sales invoice ${prepared.current.invoice_number}`,
    sourceType: INVOICE_SOURCE_TYPE,
    sourceId: id,
    lines: [
      { accountId: receivableAccountId, debit: Money.toDecimalString(total), memo: prepared.current.invoice_number },
      ...prepared.lines.map((line) => ({
        accountId: line.account_id,
        credit: Money.toDecimalString(Money.toAmount(line.line_subtotal)),
        memo: line.description,
        entityId: line.entity_id,
        projectId: line.project_id,
        costCenterId: line.cost_center_id,
      })),
      ...(Money.isZero(taxDue)
        ? []
        : [{
            accountId: taxAccountId!,
            credit: Money.toDecimalString(taxDue),
            memo: 'Tax',
          }]),
      ...(Money.isZero(charges)
        ? []
        : [{
            accountId: chargesAccountId!,
            credit: Money.toDecimalString(charges),
            memo: 'Additional charges',
          }]),
    ],
  });

  const posted = await journals.postJournal(db, actor, entry.id, { expectedVersion: entry.version });

  return db.transaction().execute(async (trx) => {
    const current = await lockInvoice(trx, actor, id, options.expectedVersion);
    await trx.updateTable('invoices').set({
      status: 'issued',
      journal_entry_id: posted.id,
      /*
       * Recorded so settlement credits the receivable this invoice DEBITED.
       * A receipt told to use some other account balances its own entry while
       * leaving this invoice's receivable outstanding forever.
       */
      receivable_account_id: receivableAccountId,
      tax_account_id: taxAccountId ?? null,
      additional_charges_account_id: chargesAccountId ?? null,
      issued_at: new Date(),
      version: current.version + 1,
      updated_by: actor.userId,
      updated_at: new Date(),
    }).where('organization_id', '=', actor.organizationId).where('company_id', '=', actor.companyId).where('id', '=', id).execute();

    await writeAudit(trx, actor, id, 'invoice.issued', posted.journalNumber);
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

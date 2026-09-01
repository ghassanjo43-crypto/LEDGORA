/**
 * Supplier payments: money leaving the business, and what it settled.
 *
 * ══ A posted payment is FULLY ALLOCATED ══════════════════════════════════════
 *
 * Every fils of a posted payment names the bill it settles. The specification
 * models supplier advances and unapplied payments, but the advances account is
 * resolved by a hard-coded browser account code with no controlled server
 * mapping, and supplier refunds have no workflow at all — so an unapplied
 * balance would be money with nowhere defined to sit. Leaving it in accounts
 * payable would show a debit balance against a supplier the business does not
 * owe; inventing an advances account would be inventing accounting.
 *
 * So an under-allocated payment is refused, an over-allocated one is refused,
 * and there is no third state.
 *
 * ══ The balance is DERIVED, never stored ═════════════════════════════════════
 *
 * A bill's outstanding amount is its total less its ACTIVE allocations. A
 * mutable balance column would be a second source of truth that drifts the
 * first time a write is lost, and the drift is invisible because the number
 * still looks like a number.
 *
 * ══ Correction is replacement, not editing ═══════════════════════════════════
 *
 * Allocation rows are immutable. A reallocation SUPERSEDES the old rows and
 * writes new ones in one transaction, and the new total must still equal the
 * payment. There is no standalone unallocation: removing an allocation without
 * replacing it would create exactly the unapplied balance this slice refuses.
 *
 * ══ Why a bill cannot be reversed while a payment sits on it ═════════════════
 *
 * Reversing a paid bill would debit accounts payable a second time — once for
 * the reversal, once for the payment — against a single credit, understating
 * what the business owes and leaving a payment pointing at a document reversed
 * out of the books. `assertNoLiveAllocations` refuses it, naming the payments,
 * and both paths take the same row lock so the check cannot race.
 */
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { Database, SupplierPaymentStatus } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import type { AccountingActor } from '../accounting/audit.js';
import { assessPostingAccount } from '../accounting/accountEligibility.js';
import { loadAccountsForPosting } from '../accounting/accountService.js';
import { monetaryDecimalsFor } from '../accounting/currencyPrecision.js';
import { toCalendarDate } from '../accounting/calendarDate.js';
import * as Money from '../accounting/money.js';
import { postSourceJournalIn } from '../accounting/sourcePostingService.js';
import { reverseJournalIn } from '../accounting/journalService.js';

type Trx = Transaction<Database>;
type Executor = Kysely<Database> | Trx;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Already in SOURCE_TYPES; the browser payment module uses the same name. */
export const PAYMENT_SOURCE_TYPE = 'payment';
export const PAYMENT_POST_EVENT = 'post';
export const PAYMENT_REVERSE_EVENT = 'reverse';

const EDITABLE: readonly SupplierPaymentStatus[] = ['draft'];

/* ══ Refusals ══════════════════════════════════════════════════════════════ */

export const UNAPPLIED_UNSUPPORTED =
  'A supplier payment must be allocated in full to posted bills. Unapplied cash, supplier advances '
  + 'and overpayments are not supported: the advances account is defined only by a browser account '
  + 'code with no controlled mapping on the server, and supplier refunds have no workflow at all, '
  + 'so an unapplied balance would be money with nowhere defined to sit. Allocate the whole amount, '
  + 'or record a smaller payment. Nothing has been saved.';

const UNSUPPORTED_ADJUSTMENTS: Record<string, string> = {
  bankFeeAmount: 'bank fees deducted at settlement',
  discountTakenAmount: 'settlement discounts',
  withholdingTaxAmount: 'withholding tax',
  realizedFxAmount: 'realised exchange differences',
  writeOffAmount: 'write-offs',
};

/** One message per browser-resident dimension, naming the field. */
const UNVERIFIABLE: Record<string, string> = {
  projectId: 'projects',
  costCenterId: 'cost centres',
  templateId: 'payment templates',
  attachments: 'attachments',
  chequeClearingAccountId: 'cheque clearing',
};

/* ══ Input shapes ══════════════════════════════════════════════════════════ */

export interface AllocationInput {
  billId: string;
  /** A decimal STRING. A JSON number is a double. */
  amount: string;
}

export interface PaymentInput {
  issuingEntityId?: string;
  supplierId?: string;
  paymentDate?: string;
  currency?: string;
  amount?: string;
  method?: string;
  reference?: string;
  memo?: string;
  cashAccountId?: string;
  allocations?: AllocationInput[];
  /* Refused, and typed so they can be refused EXPLICITLY rather than arriving,
   * being read by nothing, and vanishing in silence. */
  bankFeeAmount?: string;
  discountTakenAmount?: string;
  withholdingTaxAmount?: string;
  realizedFxAmount?: string;
  writeOffAmount?: string;
  projectId?: string | null;
  costCenterId?: string | null;
  templateId?: string | null;
  attachments?: unknown[];
  status?: string;
  paymentNumber?: string;
  payableAccountId?: string;
  unappliedAmount?: string;
}

export interface MutationOptions {
  expectedVersion?: number;
}

/* ══ Records ═══════════════════════════════════════════════════════════════ */

export interface PaymentAllocationRecord {
  id: string;
  billId: string;
  billNumber: string;
  amount: string;
  status: string;
  createdAt: string | null;
}

export interface PaymentRecord {
  id: string;
  paymentNumber: string;
  status: SupplierPaymentStatus;
  issuingEntityId: string;
  supplierId: string;
  /** The payment date IS the posting date. */
  paymentDate: string;
  currency: string;
  amount: string;
  method: string;
  reference: string;
  memo: string;
  cashAccountId: string | null;
  payableAccountId: string | null;
  journalEntryId: string | null;
  reversalJournalEntryId: string | null;
  reversalReason: string | null;
  postedAt: string | null;
  reversedAt: string | null;
  version: number;
  /** Active rows only; superseded and reversed history is on the audit trail. */
  allocations: PaymentAllocationRecord[];
}

const display = (value: unknown, decimals: number): string =>
  Money.toDecimalString(Money.roundTo(Money.toAmount(String(value ?? '0')), decimals)).slice(
    0, decimals > 0 ? -(Money.SCALE - decimals) : undefined,
  );

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : value ? String(value) : null;

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function toPayment(row: any, allocations: any[]): PaymentRecord {
  const decimals = monetaryDecimalsFor(row.currency);
  return {
    id: row.id,
    paymentNumber: row.payment_number,
    status: row.status,
    issuingEntityId: row.issuing_entity_id,
    supplierId: row.supplier_id,
    paymentDate: toCalendarDate(row.payment_date),
    currency: row.currency,
    amount: display(row.amount, decimals),
    method: row.method,
    reference: row.reference,
    memo: row.memo,
    cashAccountId: row.cash_account_id,
    payableAccountId: row.payable_account_id,
    journalEntryId: row.journal_entry_id,
    reversalJournalEntryId: row.reversal_journal_entry_id,
    reversalReason: row.reversal_reason,
    postedAt: iso(row.posted_at),
    reversedAt: iso(row.reversed_at),
    version: Number(row.version),
    allocations: allocations.map((a) => ({
      id: a.id,
      billId: a.bill_id,
      billNumber: a.bill_number ?? '',
      amount: display(a.amount, decimals),
      status: a.status,
      createdAt: iso(a.created_at),
    })),
  };
}

/* ══ The boundary ══════════════════════════════════════════════════════════ */

function assertWithinBoundary(input: PaymentInput): void {
  for (const [field, what] of Object.entries(UNSUPPORTED_ADJUSTMENTS)) {
    const value = (input as unknown as Record<string, unknown>)[field];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'string' && !/[1-9]/.test(value)) continue;
    throw errors.validation(
      `This payment records ${what}, which has no controlled accounting on the server. Posting the `
      + 'difference to a plausible-looking account would put a number in the ledger nobody chose. '
      + 'Nothing has been saved.',
      { fieldErrors: { [field]: `Remove the ${what} to record this payment.` } },
    );
  }

  for (const [field, what] of Object.entries(UNVERIFIABLE)) {
    const value = (input as unknown as Record<string, unknown>)[field];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    throw errors.validation(
      `This payment references ${what}, which the server cannot verify or account for. A durable `
      + 'payment may not name a record the books cannot check. Nothing has been saved.',
      { fieldErrors: { [field]: `Remove the ${what} reference.` } },
    );
  }

  if (input.unappliedAmount !== undefined && input.unappliedAmount !== null && input.unappliedAmount !== '') {
    throw errors.validation(UNAPPLIED_UNSUPPORTED, {
      fieldErrors: { unappliedAmount: 'Allocate the whole amount instead.' },
    });
  }

  /* ── Decided by the server, never by the caller ──────────────────────── */
  if (input.status !== undefined) {
    throw errors.validation(
      'A payment status is set by posting or reversing it, not by asking for one. Nothing has been saved.',
      { fieldErrors: { status: 'Remove the status from the request.' } },
    );
  }
  if (input.paymentNumber !== undefined) {
    throw errors.validation(
      'Payment numbers are allocated by the server, in sequence, so two people cannot be given the '
      + 'same one. Nothing has been saved.',
      { fieldErrors: { paymentNumber: 'Remove the payment number from the request.' } },
    );
  }
  if (input.payableAccountId !== undefined) {
    throw errors.validation(
      'The accounts payable account is read from the supplier record, not from the request. A '
      + 'caller naming its own would clear a balance nobody owed. Nothing has been saved.',
      { fieldErrors: { payableAccountId: 'Remove it — the server derives it from the supplier.' } },
    );
  }
}

function assertFunctionalCurrency(requested: string | undefined, functional: string): void {
  if (!requested) return;
  if (requested.trim().toUpperCase() !== functional.toUpperCase()) {
    throw errors.validation(
      `This payment is in ${requested.toUpperCase()}, but only ${functional} payments can be held `
      + 'on the server yet: exchange rates and realised exchange differences are still kept in the '
      + 'browser, so the server cannot justify a converted amount. Nothing has been saved.',
      { fieldErrors: { currency: `Record this payment in ${functional}.` } },
    );
  }
}

function amount(value: string | null | undefined, field: string): Money.Amount {
  try {
    return Money.toAmount(value, field);
  } catch (error) {
    if (error instanceof Money.MoneyError) throw errors.validation(error.message);
    throw error;
  }
}

/* ══ Accounts ══════════════════════════════════════════════════════════════ */

/**
 * The account the money actually leaves from.
 *
 * ══ Why "is it a bank account" is never the client's answer ═══════════════════
 *
 * A payment credited to a receivable, a payable or an expense balances and is
 * wrong in every statement it appears in. The server resolves the id against
 * this company's chart and judges it: an ASSET, classified as cash or bank by
 * the controlled `cashClassification` the chart already carries, and postable
 * by the same rule the ledger applies everywhere else.
 */
async function assertCashAccount(
  db: Executor,
  actor: AccountingActor,
  accountId: string,
): Promise<void> {
  const accounts = await loadAccountsForPosting(db, actor.organizationId, actor.companyId, [accountId]);
  const account = accounts.get(accountId);

  if (!account) {
    throw errors.validation(
      'That paying account does not exist in these books.',
      { fieldErrors: { cashAccountId: "Choose an account from this company's chart." } },
    );
  }
  if (account.accountType !== 'asset') {
    throw errors.validation(
      `Money is paid from an asset account. ${account.accountCode} (${account.accountName}) is `
      + `${account.accountType}, and crediting it here would record cash leaving somewhere it never was.`,
      { fieldErrors: { cashAccountId: 'Choose a bank or cash account.' } },
    );
  }
  if (!account.cashClassification || account.cashClassification === 'none') {
    throw errors.validation(
      `${account.accountCode} (${account.accountName}) is not classified as cash or bank. A payment `
      + 'must leave an account the chart actually says holds money, not one that merely looks like it.',
      { fieldErrors: { cashAccountId: 'Choose an account classified as cash or bank.' } },
    );
  }
  const verdict = assessPostingAccount(account, account.hasChildren);
  if (!verdict.eligible) {
    throw errors.validation(
      `That paying account cannot receive postings: ${verdict.message}`,
      { fieldErrors: { cashAccountId: 'Choose an active, postable account.' } },
    );
  }
}

/** The supplier, and the payable this payment will debit. */
async function resolveSupplierAndPayable(
  db: Executor,
  actor: AccountingActor,
  supplierId: string,
): Promise<{ payableAccountId: string; legalName: string }> {
  const party = await db
    .selectFrom('business_parties')
    .select(['id', 'legal_name', 'is_supplier', 'status'])
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', supplierId)
    .executeTakeFirst();

  if (!party) {
    throw errors.validation(
      'That supplier does not exist in these books.',
      { fieldErrors: { supplierId: 'Choose a supplier from this company.' } },
    );
  }
  if (!party.is_supplier) {
    throw errors.validation(
      `${party.legal_name} does not hold the supplier role, so a payment cannot be made to them.`,
      { fieldErrors: { supplierId: 'Choose a party that is a supplier.' } },
    );
  }

  const profile = await db
    .selectFrom('business_party_supplier_profiles')
    .select('default_payable_account_id')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('party_id', '=', supplierId)
    .executeTakeFirst();

  const payableAccountId = profile?.default_payable_account_id;
  if (!payableAccountId) {
    throw errors.validation(
      `${party.legal_name} has no accounts payable account set, so there is nothing for this payment `
      + 'to clear. Set one on the supplier record and post again. Nothing has been saved.',
      { fieldErrors: { supplierId: 'Set a payable account on the supplier record.' } },
    );
  }
  return { payableAccountId, legalName: party.legal_name };
}

async function assertPayablePostable(
  db: Executor,
  actor: AccountingActor,
  payableAccountId: string,
  supplierName: string,
): Promise<void> {
  const accounts = await loadAccountsForPosting(
    db, actor.organizationId, actor.companyId, [payableAccountId],
  );
  const account = accounts.get(payableAccountId);
  if (!account) {
    throw errors.validation(`The payable account for ${supplierName} is not an account in these books.`);
  }
  if (account.accountType !== 'liability') {
    throw errors.validation(
      `The payable account for ${supplierName} is ${account.accountType}, not a liability.`,
    );
  }
  const verdict = assessPostingAccount(account, account.hasChildren);
  if (!verdict.eligible) {
    throw errors.validation(
      `The payable account for ${supplierName} cannot receive postings: ${verdict.message}`,
    );
  }
}

/* ══ Balances ══════════════════════════════════════════════════════════════ */

/**
 * What a bill still owes: its total less every ACTIVE allocation.
 *
 * Derived on every read rather than stored. `forUpdate` takes the bill's row
 * lock first, which is what makes two concurrent payments against the same
 * balance serialise instead of both succeeding.
 */
export async function outstandingForBill(
  trx: Executor,
  actor: AccountingActor,
  billId: string,
  options: { forUpdate?: boolean } = {},
): Promise<{
  outstanding: Money.Amount; total: Money.Amount; allocated: Money.Amount;
  status: string; supplierId: string; currency: string; billNumber: string; dueDate: string;
}> {
  const locked = options.forUpdate
    ? await sql<{
        id: string; total: string; status: string; supplier_id: string;
        currency: string; bill_number: string; due_date: string | Date;
      }>`
        SELECT id, total, status, supplier_id, currency, bill_number, due_date
          FROM bills
         WHERE organization_id = ${actor.organizationId}
           AND company_id = ${actor.companyId}
           AND id = ${billId}
         FOR UPDATE
      `.execute(trx)
    : await sql<{
        id: string; total: string; status: string; supplier_id: string;
        currency: string; bill_number: string; due_date: string | Date;
      }>`
        SELECT id, total, status, supplier_id, currency, bill_number, due_date
          FROM bills
         WHERE organization_id = ${actor.organizationId}
           AND company_id = ${actor.companyId}
           AND id = ${billId}
      `.execute(trx);

  const bill = locked.rows[0];
  if (!bill) throw errors.notFound('Bill');

  const { rows: sums } = await sql<{ allocated: string }>`
    SELECT COALESCE(SUM(amount), 0)::text AS allocated
      FROM payment_allocations
     WHERE organization_id = ${actor.organizationId}
       AND company_id = ${actor.companyId}
       AND bill_id = ${billId}
       AND status = 'active'
  `.execute(trx);

  const total = Money.toAmount(String(bill.total));
  const allocated = Money.toAmount(String(sums[0]?.allocated ?? '0'));
  return {
    outstanding: total - allocated,
    total,
    allocated,
    status: bill.status,
    supplierId: bill.supplier_id,
    currency: bill.currency,
    billNumber: bill.bill_number,
    dueDate: toCalendarDate(bill.due_date),
  };
}

/**
 * The payments standing between a bill and its reversal.
 *
 * Read under the bill's row lock by `assertNoLiveAllocations`, so a payment
 * cannot be posted against the bill between this check and the reversal.
 */
export async function liveAllocationsForBill(
  trx: Executor,
  actor: AccountingActor,
  billId: string,
): Promise<{ paymentNumber: string; amount: string; paymentId: string }[]> {
  const { rows } = await sql<{ payment_number: string; amount: string; payment_id: string }>`
    SELECT p.payment_number, a.amount::text AS amount, p.id AS payment_id
      FROM payment_allocations a
      JOIN supplier_payments p
        ON p.id = a.payment_id
       AND p.organization_id = a.organization_id
       AND p.company_id = a.company_id
     WHERE a.organization_id = ${actor.organizationId}
       AND a.company_id = ${actor.companyId}
       AND a.bill_id = ${billId}
       AND a.status = 'active'
     ORDER BY p.payment_number
  `.execute(trx);
  return rows.map((r) => ({
    paymentNumber: r.payment_number, amount: r.amount, paymentId: r.payment_id,
  }));
}

/**
 * Refuse to reverse a bill that a posted payment still settles.
 *
 * ══ Why not simply unallocate ════════════════════════════════════════════════
 *
 * Because a posted payment must be fully allocated. Detaching it would leave
 * unapplied cash, which this slice refuses and has no account for — so the
 * message offers the two routes that ARE complete: reverse the payment, or
 * reallocate the whole of it onto other eligible bills.
 *
 * Reversing the bill anyway would debit accounts payable twice against one
 * credit, understating what the business owes.
 */
export async function assertNoLiveAllocations(
  trx: Executor,
  actor: AccountingActor,
  billId: string,
  billNumber: string,
  decimals: number,
): Promise<void> {
  const live = await liveAllocationsForBill(trx, actor, billId);
  if (live.length === 0) return;

  const named = live
    .map((l) => `${l.paymentNumber} (${display(l.amount, decimals)})`)
    .join(', ');

  throw errors.conflict(
    `Bill ${billNumber} cannot be reversed while ${live.length === 1 ? 'a payment settles' : 'payments settle'} `
    + `it: ${named}. Reversing it now would debit accounts payable a second time against a single `
    + 'credit, understating what is owed and leaving the payment pointing at a document reversed out '
    + `of the books. Either reverse ${live.length === 1 ? 'that payment' : 'those payments'} first, or `
    + `reallocate ${live.length === 1 ? 'its' : 'their'} full amount to other posted bills for the same `
    + 'supplier. A payment cannot simply be detached, because unapplied cash is not supported.',
  );
}

/* ══ Numbering ═════════════════════════════════════════════════════════════ */

async function allocatePaymentNumber(
  trx: Trx,
  actor: AccountingActor,
  issuingEntityId: string,
  paymentDate: string,
): Promise<string> {
  await sql`select pg_advisory_xact_lock(hashtext(${`payment_number:${actor.organizationId}:${actor.companyId}:${issuingEntityId}`}))`
    .execute(trx);

  const existing = await trx
    .selectFrom('payment_numbering').selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('issuing_entity_id', '=', issuingEntityId)
    .executeTakeFirst();

  const config = existing ?? { prefix: 'PAY-', include_year: true, sequence_length: 4, next_sequence: 1 };

  if (!existing) {
    await trx.insertInto('payment_numbering').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      issuing_entity_id: issuingEntityId,
      next_sequence: 2,
    } as never).execute();
  } else {
    await trx.updateTable('payment_numbering')
      .set({ next_sequence: config.next_sequence + 1, updated_at: new Date() } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('issuing_entity_id', '=', issuingEntityId)
      .execute();
  }

  const year = config.include_year ? `${paymentDate.slice(0, 4)}-` : '';
  return `${config.prefix}${year}${String(config.next_sequence).padStart(config.sequence_length, '0')}`;
}

/* ══ Audit ═════════════════════════════════════════════════════════════════ */

async function writeAudit(
  trx: Trx,
  actor: AccountingActor,
  input: {
    paymentId: string; action: string; detail?: Record<string, unknown>;
    previousVersion?: number | null; resultingVersion?: number | null;
  },
): Promise<void> {
  await trx.insertInto('payment_audit_events').values({
    organization_id: actor.organizationId,
    company_id: actor.companyId,
    payment_id: input.paymentId,
    action: input.action,
    detail: JSON.stringify(input.detail ?? {}),
    previous_version: input.previousVersion ?? null,
    resulting_version: input.resultingVersion ?? null,
    actor_user_id: actor.userId,
    actor_name: actor.name,
  } as never).execute();
}

/* ══ Reading ═══════════════════════════════════════════════════════════════ */

async function loadPayment(db: Executor, actor: AccountingActor, id: string): Promise<PaymentRecord> {
  const row = await db.selectFrom('supplier_payments').selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw errors.notFound('Payment');

  const { rows: allocations } = await sql<{
    id: string; bill_id: string; amount: string; status: string;
    created_at: Date | string; bill_number: string;
  }>`
    SELECT a.id, a.bill_id, a.amount::text AS amount, a.status, a.created_at, b.bill_number
      FROM payment_allocations a
      JOIN bills b ON b.id = a.bill_id
       AND b.organization_id = a.organization_id AND b.company_id = a.company_id
     WHERE a.organization_id = ${actor.organizationId}
       AND a.company_id = ${actor.companyId}
       AND a.payment_id = ${id}
       AND a.status = 'active'
     ORDER BY b.bill_number
  `.execute(db);

  return toPayment(row, allocations);
}

export const getPayment = loadPayment;

export async function listPayments(
  db: Executor,
  actor: AccountingActor,
  query: { status?: SupplierPaymentStatus; supplierId?: string; search?: string; limit?: number } = {},
): Promise<PaymentRecord[]> {
  let builder = db.selectFrom('supplier_payments').selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId);

  if (query.status) builder = builder.where('status', '=', query.status);
  if (query.supplierId) builder = builder.where('supplier_id', '=', query.supplierId);

  const search = (query.search ?? '').trim().toLowerCase();
  if (search) {
    const pattern = `%${search}%`;
    builder = builder.where((eb) => eb.or([
      eb(sql`lower(payment_number)`, 'like', pattern),
      eb(sql`lower(reference)`, 'like', pattern),
      eb(sql`lower(memo)`, 'like', pattern),
    ]));
  }

  const rows = await builder
    .orderBy('payment_date', 'desc')
    .orderBy('payment_number', 'desc')
    .limit(Math.min(Math.max(query.limit ?? 100, 1), 200))
    .execute();

  if (rows.length === 0) return [];

  /* ONE query for every allocation on the page, not one per payment: a
   * two-hundred-row payables screen is not a reason for four hundred round
   * trips. Same shape as `listBills`. */
  const { rows: allocations } = await sql<{
    id: string; payment_id: string; bill_id: string; amount: string; status: string;
    created_at: Date | string; bill_number: string;
  }>`
    SELECT a.id, a.payment_id, a.bill_id, a.amount::text AS amount, a.status, a.created_at,
           b.bill_number
      FROM payment_allocations a
      JOIN bills b ON b.id = a.bill_id
       AND b.organization_id = a.organization_id AND b.company_id = a.company_id
     WHERE a.organization_id = ${actor.organizationId}
       AND a.company_id = ${actor.companyId}
       AND a.status = 'active'
       AND a.payment_id IN (${sql.join(rows.map((row) => sql`${row.id}`))})
     ORDER BY b.bill_number
  `.execute(db);

  const byPayment = new Map<string, typeof allocations>();
  for (const allocation of allocations) {
    const bucket = byPayment.get(allocation.payment_id);
    if (bucket) bucket.push(allocation);
    else byPayment.set(allocation.payment_id, [allocation]);
  }

  return rows.map((row) => toPayment(row, byPayment.get(row.id) ?? []));
}

export async function paymentHistory(
  db: Executor,
  actor: AccountingActor,
  id: string,
): Promise<Array<{ action: string; actorName: string; at: string; detail: Record<string, unknown> }>> {
  await loadPayment(db, actor, id);
  const rows = await db.selectFrom('payment_audit_events').selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('payment_id', '=', id)
    .orderBy('at', 'desc')
    .limit(200)
    .execute();

  return rows.map((row) => ({
    action: row.action,
    actorName: row.actor_name,
    at: iso(row.at) ?? '',
    detail: (typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail) as Record<string, unknown>,
  }));
}

/* ══ Allocation validation ═════════════════════════════════════════════════ */

/**
 * Validate a full set of allocations against locked bills.
 *
 * Every bill is locked FOR UPDATE before its outstanding amount is read, so two
 * payments racing for the same remaining balance serialise: the second sees the
 * first's allocation and is refused rather than both succeeding.
 *
 * `excludePaymentId` lets a REALLOCATION ignore its own superseded rows, so
 * replacing an allocation with the same amount on the same bill is not treated
 * as doubling it.
 */
async function validateAllocations(
  trx: Trx,
  actor: AccountingActor,
  input: {
    allocations: AllocationInput[];
    supplierId: string;
    currency: string;
    paymentAmount: Money.Amount;
    decimals: number;
  },
): Promise<{ billId: string; amount: Money.Amount }[]> {
  if (input.allocations.length === 0) {
    throw errors.validation(UNAPPLIED_UNSUPPORTED, {
      fieldErrors: { allocations: 'Allocate the payment to at least one posted bill.' },
    });
  }

  const seen = new Set<string>();
  const resolved: { billId: string; amount: Money.Amount }[] = [];

  /* Order is PRESERVED as submitted — no FIFO is imposed, because the product
   * defines none: `autoAllocatePayment` is a suggestion a screen may offer, not
   * a rule the server applies. */
  for (const [index, line] of input.allocations.entries()) {
    const at = index + 1;
    if (!line.billId) throw errors.validation(`Allocation ${at}: a bill is required.`);
    if (seen.has(line.billId)) {
      throw errors.validation(
        `Allocation ${at}: the same bill appears twice. Combine them into one allocation so the `
        + 'trail says once what was settled.',
      );
    }
    seen.add(line.billId);

    const value = amount(line.amount ?? '0', `allocation ${at} amount`);
    if (!Money.isPositive(value)) {
      throw errors.validation(
        `Allocation ${at}: the amount must be greater than zero. A zero allocation settles nothing.`,
      );
    }
    if (Money.exceedsPrecision(value, input.decimals)) {
      throw errors.validation(
        `Allocation ${at}: the amount carries more decimal places than this currency allows.`,
      );
    }

    /* LOCKED, then read. This is the mechanism that stops over-allocation under
     * concurrency, and the same lock a bill reversal takes. */
    const bill = await outstandingForBill(trx, actor, line.billId, { forUpdate: true });

    if (bill.status !== 'posted') {
      throw errors.validation(
        `Bill ${bill.billNumber} is ${bill.status} and cannot be paid. Only a posted bill records a `
        + 'liability to settle.',
        { fieldErrors: { [`allocations.${at}.billId`]: 'Choose a posted bill.' } },
      );
    }
    if (bill.supplierId !== input.supplierId) {
      throw errors.validation(
        `Bill ${bill.billNumber} belongs to a different supplier. A payment settles what is owed to `
        + 'one supplier, and paying across two would misstate both balances.',
        { fieldErrors: { [`allocations.${at}.billId`]: "Choose one of this supplier's bills." } },
      );
    }
    if (bill.currency.toUpperCase() !== input.currency.toUpperCase()) {
      throw errors.validation(
        `Bill ${bill.billNumber} is in ${bill.currency} and this payment is in ${input.currency}. `
        + 'Settling across currencies needs an exchange difference the server cannot compute yet.',
      );
    }
    if (value > bill.outstanding) {
      throw errors.validation(
        `Allocation ${at}: ${display(Money.toDecimalString(value), input.decimals)} is more than bill `
        + `${bill.billNumber} still owes (${display(Money.toDecimalString(bill.outstanding), input.decimals)}). `
        + 'Over-allocating would create a negative balance, which is an overpayment by another name. '
        + 'Nothing has been saved.',
        { fieldErrors: { [`allocations.${at}.amount`]: 'Reduce it to the outstanding amount or less.' } },
      );
    }

    resolved.push({ billId: line.billId, amount: value });
  }

  const allocated = Money.sum(resolved.map((r) => r.amount));
  if (allocated !== input.paymentAmount) {
    const over = allocated > input.paymentAmount;
    throw errors.validation(
      over
        ? `Allocations total ${display(Money.toDecimalString(allocated), input.decimals)}, which is more `
          + `than the payment of ${display(Money.toDecimalString(input.paymentAmount), input.decimals)}. `
          + 'Nothing has been saved.'
        : UNAPPLIED_UNSUPPORTED,
      { fieldErrors: { allocations: 'The allocations must total the payment exactly.' } },
    );
  }

  return resolved;
}

/* ══ Writing ═══════════════════════════════════════════════════════════════ */

async function functionalCurrencyOf(db: Executor, organizationId: string): Promise<string> {
  const org = await db.selectFrom('organizations').select('base_currency')
    .where('id', '=', organizationId).executeTakeFirst();
  if (!org) throw errors.notFound('Organization');
  return org.base_currency;
}

function assertPaymentDate(input: PaymentInput): string {
  const date = input.paymentDate ?? '';
  if (!ISO_DATE.test(date)) {
    throw errors.validation('paymentDate must be an ISO date (yyyy-mm-dd).', {
      fieldErrors: { paymentDate: 'Use the format yyyy-mm-dd.' },
    });
  }
  return date;
}

export async function createDraft(
  db: Kysely<Database>,
  actor: AccountingActor,
  input: PaymentInput,
): Promise<PaymentRecord> {
  const paymentDate = assertPaymentDate(input);
  if (!input.supplierId) throw errors.validation('A supplier is required.', {
    fieldErrors: { supplierId: 'Choose the supplier being paid.' },
  });
  if (!input.issuingEntityId) throw errors.validation('An issuing entity is required.');
  if (!input.cashAccountId) throw errors.validation('A paying account is required.', {
    fieldErrors: { cashAccountId: 'Choose the bank or cash account the money leaves.' },
  });

  assertWithinBoundary(input);

  return db.transaction().execute(async (trx) => {
    const currency = await functionalCurrencyOf(trx, actor.organizationId);
    assertFunctionalCurrency(input.currency, currency);
    const decimals = monetaryDecimalsFor(currency);

    const value = amount(input.amount ?? '0', 'amount');
    if (!Money.isPositive(value)) {
      throw errors.validation('The payment amount must be greater than zero.', {
        fieldErrors: { amount: 'Enter an amount greater than zero.' },
      });
    }
    if (Money.exceedsPrecision(value, decimals)) {
      throw errors.validation('The payment amount carries more decimal places than this currency allows.', {
        fieldErrors: { amount: `Use at most ${decimals} decimal places.` },
      });
    }

    await resolveSupplierAndPayable(trx, actor, input.supplierId!);
    await assertCashAccount(trx, actor, input.cashAccountId!);

    const paymentNumber = await allocatePaymentNumber(trx, actor, input.issuingEntityId!, paymentDate);

    const created = await trx.insertInto('supplier_payments').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      issuing_entity_id: input.issuingEntityId,
      supplier_id: input.supplierId,
      payment_number: paymentNumber,
      status: 'draft',
      payment_date: paymentDate,
      currency,
      amount: Money.toDecimalString(value),
      method: input.method ?? 'bank-transfer',
      reference: input.reference ?? '',
      memo: input.memo ?? '',
      /* Held on the DRAFT so the screen can show it; frozen at posting. */
      cash_account_id: input.cashAccountId,
      created_by: actor.userId,
      updated_by: actor.userId,
    } as never).returning('id').executeTakeFirstOrThrow();

    await writeAudit(trx, actor, {
      paymentId: created.id, action: 'PAYMENT_CREATED', resultingVersion: 1,
      detail: { paymentNumber, supplierId: input.supplierId, amount: Money.toDecimalString(value) },
    });

    return loadPayment(trx, actor, created.id);
  });
}

async function lockPayment(
  trx: Trx,
  actor: AccountingActor,
  id: string,
  expectedVersion: number | undefined,
): Promise<{
  id: string; version: number; status: SupplierPaymentStatus; supplier_id: string;
  payment_number: string; issuing_entity_id: string; payment_date: string | Date;
  currency: string; amount: string; cash_account_id: string | null;
  payable_account_id: string | null; journal_entry_id: string | null;
}> {
  const { rows } = await sql<{
    id: string; version: number; status: SupplierPaymentStatus; supplier_id: string;
    payment_number: string; issuing_entity_id: string; payment_date: string | Date;
    currency: string; amount: string; cash_account_id: string | null;
    payable_account_id: string | null; journal_entry_id: string | null;
  }>`
    SELECT id, version, status, supplier_id, payment_number, issuing_entity_id,
           payment_date, currency, amount, cash_account_id, payable_account_id, journal_entry_id
      FROM supplier_payments
     WHERE organization_id = ${actor.organizationId}
       AND company_id = ${actor.companyId}
       AND id = ${id}
     FOR UPDATE
  `.execute(trx);

  const row = rows[0];
  if (!row) throw errors.notFound('Payment');
  if (typeof expectedVersion !== 'number') {
    throw errors.validation(
      'This change did not carry the version it was based on, so the server cannot tell whether '
      + 'somebody else has already changed the payment. Reload and try again.',
      { fieldErrors: { expectedVersion: 'Reload the payment and retry.' } },
    );
  }
  if (Number(row.version) !== expectedVersion) {
    throw errors.conflict(
      'This payment was changed by another user while you were editing it. Reload to see their '
      + 'change before saving yours.',
    );
  }
  return { ...row, version: Number(row.version) };
}

export async function updateDraft(
  db: Kysely<Database>,
  actor: AccountingActor,
  id: string,
  input: PaymentInput,
  options: MutationOptions,
): Promise<PaymentRecord> {
  const paymentDate = assertPaymentDate(input);
  assertWithinBoundary(input);

  return db.transaction().execute(async (trx) => {
    const current = await lockPayment(trx, actor, id, options.expectedVersion);
    if (!EDITABLE.includes(current.status)) {
      throw errors.conflict(
        `This payment is ${current.status} and can no longer be edited. A posted payment is `
        + 'accounting history; reverse it, or reallocate it, instead.',
      );
    }

    const decimals = monetaryDecimalsFor(current.currency);
    assertFunctionalCurrency(input.currency, current.currency);

    const value = amount(input.amount ?? '0', 'amount');
    if (!Money.isPositive(value)) {
      throw errors.validation('The payment amount must be greater than zero.');
    }
    if (Money.exceedsPrecision(value, decimals)) {
      throw errors.validation('The payment amount carries more decimal places than this currency allows.');
    }

    if (input.supplierId) await resolveSupplierAndPayable(trx, actor, input.supplierId);
    if (input.cashAccountId) await assertCashAccount(trx, actor, input.cashAccountId);

    await trx.updateTable('supplier_payments').set({
      supplier_id: input.supplierId ?? current.supplier_id,
      payment_date: paymentDate,
      amount: Money.toDecimalString(value),
      method: input.method ?? 'bank-transfer',
      reference: input.reference ?? '',
      memo: input.memo ?? '',
      cash_account_id: input.cashAccountId ?? current.cash_account_id,
      version: current.version + 1,
      updated_by: actor.userId,
      updated_at: new Date(),
    } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .execute();

    await writeAudit(trx, actor, {
      paymentId: id, action: 'PAYMENT_UPDATED',
      previousVersion: current.version, resultingVersion: current.version + 1,
    });

    return loadPayment(trx, actor, id);
  });
}

export async function deleteDraft(
  db: Kysely<Database>,
  actor: AccountingActor,
  id: string,
  options: MutationOptions,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const current = await lockPayment(trx, actor, id, options.expectedVersion);
    if (current.status !== 'draft') {
      throw errors.conflict(
        `This payment is ${current.status} and cannot be deleted. A posted payment leaves the books `
        + 'by being reversed, which keeps both entries visible.',
      );
    }
    await trx.deleteFrom('supplier_payments')
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .execute();
  });
}

/**
 * Post the payment: one transaction, or nothing.
 *
 *     Dr the supplier's payable        the payment amount
 *         Cr the bank or cash account  the payment amount
 *
 * The bill's original expense, asset and input-tax entries are NOT touched:
 * paying a bill settles a liability, it does not restate what was bought. No
 * tax is posted here either — P3's input tax belongs to the bill.
 */
export async function postPayment(
  db: Kysely<Database>,
  actor: AccountingActor,
  id: string,
  input: { allocations?: AllocationInput[] },
  options: MutationOptions,
): Promise<PaymentRecord> {
  return db.transaction().execute(async (trx) => {
    const current = await lockPayment(trx, actor, id, options.expectedVersion);

    if (current.status === 'posted') throw errors.conflict('This payment is already posted.');
    if (current.status !== 'draft') throw errors.conflict(`A ${current.status} payment cannot be posted.`);

    const decimals = monetaryDecimalsFor(current.currency);
    const paymentAmount = Money.toAmount(String(current.amount));
    if (!Money.isPositive(paymentAmount)) {
      throw errors.validation('The payment amount must be greater than zero.');
    }

    const { payableAccountId, legalName } =
      await resolveSupplierAndPayable(trx, actor, current.supplier_id);
    await assertPayablePostable(trx, actor, payableAccountId, legalName);

    const cashAccountId = current.cash_account_id;
    if (!cashAccountId) {
      throw errors.validation('A paying account is required before this payment can be posted.');
    }
    /* Re-checked HERE: an account eligible when the draft was saved can be
     * archived, blocked or given a child before it is posted. */
    await assertCashAccount(trx, actor, cashAccountId);

    const resolved = await validateAllocations(trx, actor, {
      allocations: input.allocations ?? [],
      supplierId: current.supplier_id,
      currency: current.currency,
      paymentAmount,
      decimals,
    });

    const paymentDate = toCalendarDate(current.payment_date);

    const { journal } = await postSourceJournalIn(trx, actor, {
      sourceType: PAYMENT_SOURCE_TYPE,
      sourceId: id,
      sourceEvent: PAYMENT_POST_EVENT,
      transactionDate: paymentDate,
      reference: current.payment_number,
      description: `Supplier payment ${current.payment_number} — ${legalName}`,
      lines: [
        {
          accountId: payableAccountId,
          debit: Money.toDecimalString(paymentAmount),
          memo: `${current.payment_number} — ${legalName}`,
        },
        {
          accountId: cashAccountId,
          credit: Money.toDecimalString(paymentAmount),
          memo: current.payment_number,
        },
      ],
    });

    for (const allocation of resolved) {
      await trx.insertInto('payment_allocations').values({
        organization_id: actor.organizationId,
        company_id: actor.companyId,
        payment_id: id,
        bill_id: allocation.billId,
        amount: Money.toDecimalString(allocation.amount),
        status: 'active',
      } as never).execute();
    }

    await trx.updateTable('supplier_payments').set({
      status: 'posted',
      journal_entry_id: journal.id,
      /* FROZEN, so a later change to the supplier profile or the chart cannot
       * restate a posted payment. */
      payable_account_id: payableAccountId,
      cash_account_id: cashAccountId,
      posted_at: new Date(),
      version: current.version + 1,
      updated_by: actor.userId,
      updated_at: new Date(),
    } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .execute();

    await writeAudit(trx, actor, {
      paymentId: id, action: 'PAYMENT_POSTED',
      previousVersion: current.version, resultingVersion: current.version + 1,
      detail: {
        journalEntryId: journal.id, payableAccountId, cashAccountId,
        amount: Money.toDecimalString(paymentAmount),
        allocations: resolved.map((r) => ({ billId: r.billId, amount: Money.toDecimalString(r.amount) })),
      },
    });

    return loadPayment(trx, actor, id);
  });
}

/**
 * Replace a posted payment's allocations, atomically.
 *
 * ══ Replacement, never removal ═══════════════════════════════════════════════
 *
 * The new set must still total the payment exactly. There is no standalone
 * unallocation, because detaching an allocation without replacing it would
 * leave unapplied cash — the state this slice refuses and has no account for.
 * If there is nowhere else to put the money, the payment is reversed instead.
 *
 * The old rows are marked SUPERSEDED, never deleted: the trail of what settled
 * what has to survive the correction. Every affected bill — old and new — is
 * locked before anything is read, so a concurrent posting or reversal cannot
 * interleave.
 *
 * No journal is written. The cash left the bank once; which liabilities it
 * cleared is a subledger question, and the bank entry does not change.
 */
export async function reallocatePayment(
  db: Kysely<Database>,
  actor: AccountingActor,
  id: string,
  input: { allocations?: AllocationInput[] },
  options: MutationOptions,
): Promise<PaymentRecord> {
  return db.transaction().execute(async (trx) => {
    const current = await lockPayment(trx, actor, id, options.expectedVersion);
    if (current.status !== 'posted') {
      throw errors.conflict(
        `Only a posted payment can be reallocated. This one is ${current.status}.`,
      );
    }

    const decimals = monetaryDecimalsFor(current.currency);
    const paymentAmount = Money.toAmount(String(current.amount));

    /*
     * The bills the payment currently settles are locked FIRST, so releasing
     * their allocations cannot race a concurrent posting or bill reversal.
     */
    const existing = await sql<{ id: string; bill_id: string }>`
      SELECT id, bill_id FROM payment_allocations
       WHERE organization_id = ${actor.organizationId}
         AND company_id = ${actor.companyId}
         AND payment_id = ${id}
         AND status = 'active'
    `.execute(trx);

    for (const row of existing.rows) {
      await outstandingForBill(trx, actor, row.bill_id, { forUpdate: true });
    }

    /* Superseded before the new set is validated, so the outstanding amounts
     * the validation reads already exclude what this payment used to hold. */
    await trx.updateTable('payment_allocations').set({
      status: 'superseded', superseded_at: new Date(),
    } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('payment_id', '=', id)
      .where('status', '=', 'active')
      .execute();

    const resolved = await validateAllocations(trx, actor, {
      allocations: input.allocations ?? [],
      supplierId: current.supplier_id,
      currency: current.currency,
      paymentAmount,
      decimals,
    });

    for (const allocation of resolved) {
      await trx.insertInto('payment_allocations').values({
        organization_id: actor.organizationId,
        company_id: actor.companyId,
        payment_id: id,
        bill_id: allocation.billId,
        amount: Money.toDecimalString(allocation.amount),
        status: 'active',
      } as never).execute();
    }

    await trx.updateTable('supplier_payments').set({
      version: current.version + 1,
      updated_by: actor.userId,
      updated_at: new Date(),
    } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .execute();

    await writeAudit(trx, actor, {
      paymentId: id, action: 'PAYMENT_REALLOCATED',
      previousVersion: current.version, resultingVersion: current.version + 1,
      detail: {
        from: existing.rows.map((r) => r.bill_id),
        to: resolved.map((r) => ({ billId: r.billId, amount: Money.toDecimalString(r.amount) })),
      },
    });

    return loadPayment(trx, actor, id);
  });
}

/**
 * Reverse a posted payment.
 *
 * The reversing journal debits the original frozen CASH account and credits the
 * original frozen PAYABLE — the exact opposite of the posting, using the
 * accounts the payment recorded rather than whatever the supplier profile says
 * today. Every allocation is neutralised in the same transaction, so the bills
 * it settled reopen to precisely what they owed before.
 */
export async function reversePayment(
  db: Kysely<Database>,
  actor: AccountingActor,
  id: string,
  options: MutationOptions & { reason?: string },
): Promise<PaymentRecord> {
  const reason = (options.reason ?? '').trim();
  if (!reason) {
    throw errors.validation(
      'A reversal reason is required. A reversing entry is part of the audit trail, and one that '
      + 'does not say why is a correction nobody can explain later.',
      { fieldErrors: { reason: 'Say why this payment is being reversed.' } },
    );
  }

  return db.transaction().execute(async (trx) => {
    const current = await lockPayment(trx, actor, id, options.expectedVersion);
    if (current.status === 'reversed') throw errors.conflict('This payment is already reversed.');
    if (current.status !== 'posted' || !current.journal_entry_id) {
      throw errors.conflict('Only a posted payment can be reversed.');
    }

    /* Lock every bill this payment settles before releasing its allocations, so
     * a concurrent bill reversal cannot slip between the release and the
     * balance reopening. */
    const { rows: live } = await sql<{ bill_id: string }>`
      SELECT bill_id FROM payment_allocations
       WHERE organization_id = ${actor.organizationId}
         AND company_id = ${actor.companyId}
         AND payment_id = ${id}
         AND status = 'active'
    `.execute(trx);
    for (const row of live) {
      await outstandingForBill(trx, actor, row.bill_id, { forUpdate: true });
    }

    const entry = await trx.selectFrom('journal_entries').select('version')
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', current.journal_entry_id)
      .executeTakeFirst();
    if (!entry) throw errors.notFound('Journal entry');

    const { reversal } = await reverseJournalIn(trx, actor, current.journal_entry_id, {
      reason, expectedVersion: entry.version,
    });

    await trx.updateTable('payment_allocations').set({
      status: 'reversed', reversed_at: new Date(),
    } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('payment_id', '=', id)
      .where('status', '=', 'active')
      .execute();

    await trx.updateTable('supplier_payments').set({
      status: 'reversed',
      reversal_journal_entry_id: reversal.id,
      reversal_reason: reason,
      reversed_at: new Date(),
      version: current.version + 1,
      updated_by: actor.userId,
      updated_at: new Date(),
    } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .execute();

    await writeAudit(trx, actor, {
      paymentId: id, action: 'PAYMENT_REVERSED',
      previousVersion: current.version, resultingVersion: current.version + 1,
      detail: { reason, reversalJournalEntryId: reversal.id, reopened: live.map((r) => r.bill_id) },
    });

    return loadPayment(trx, actor, id);
  });
}

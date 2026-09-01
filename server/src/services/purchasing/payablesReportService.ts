/**
 * What the business owes its suppliers, derived — never stored.
 *
 * ══ Why nothing here is a column ═════════════════════════════════════════════
 *
 * Every figure below is computed from the bills and the payments that settle
 * them. A stored `balance_due` would be a second source of truth, and the first
 * time a write was lost it would drift from the documents silently, because a
 * wrong number still looks like a number. Deriving costs a join; a drifting
 * subledger costs an audit.
 *
 * ══ Ageing ══════════════════════════════════════════════════════════════════
 *
 * The REMAINING balance is aged by DUE date, on the six buckets the product
 * already uses everywhere else (`src/lib/statementAging.ts`): current, 1–30,
 * 31–60, 61–90, 91–120, over 120. Ageing the original total would keep a bill
 * fully overdue after it had been paid; ageing by bill date would call a bill
 * overdue before it was due.
 *
 * ══ Reconciliation ══════════════════════════════════════════════════════════
 *
 * The statement's closing balance is checked against the sum of outstanding
 * bills. It is a real check, not a formality: the two are computed by different
 * routes — one by running the movements forward, the other by netting
 * allocations against totals — and they can only agree if every payment,
 * reallocation and reversal left the subledger consistent.
 *
 * Note the GL payable account is deliberately NOT the comparison: one control
 * account carries every supplier, so its balance would never equal one
 * supplier's, and reporting the difference as a discrepancy would be reporting
 * a fact as a fault.
 */
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import type { AccountingActor } from '../accounting/audit.js';
import { monetaryDecimalsFor } from '../accounting/currencyPrecision.js';
import { toCalendarDate } from '../accounting/calendarDate.js';
import * as Money from '../accounting/money.js';

type Executor = Kysely<Database> | Transaction<Database>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type AgingBucketId = 'current' | '1-30' | '31-60' | '61-90' | '91-120' | '120-plus';

const BUCKET_ORDER: readonly AgingBucketId[] = [
  'current', '1-30', '31-60', '61-90', '91-120', '120-plus',
];

/** En dashes, matching the browser labels the screens already show. */
const BUCKET_LABELS: Record<AgingBucketId, string> = {
  current: 'Current',
  '1-30': '1–30 days',
  '31-60': '31–60 days',
  '61-90': '61–90 days',
  '91-120': '91–120 days',
  '120-plus': 'Over 120 days',
};

/** Whole days between two ISO dates, UTC midnight to UTC midnight. */
function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Zero until the due date has passed — a bill due today is not yet overdue. */
export function daysOverdue(dueDate: string, asOfDate: string): number {
  return Math.max(0, daysBetween(dueDate, asOfDate));
}

export function agingBucketFor(days: number): AgingBucketId {
  if (days <= 0) return 'current';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  if (days <= 120) return '91-120';
  return '120-plus';
}

const display = (value: unknown, decimals: number): string =>
  Money.toDecimalString(Money.roundTo(Money.toAmount(String(value ?? '0')), decimals)).slice(
    0,
    decimals > 0 ? -(Money.SCALE - decimals) : undefined,
  );

function assertDate(value: string | undefined, field: string): string {
  if (!value || !ISO_DATE.test(value)) {
    throw errors.validation(`${field} must be an ISO date (yyyy-mm-dd).`, {
      fieldErrors: { [field]: 'Use the format yyyy-mm-dd.' },
    });
  }
  return value;
}

/* ══ Records ═══════════════════════════════════════════════════════════════ */

export interface OutstandingBillRow {
  billId: string;
  billNumber: string;
  supplierId: string;
  supplierName: string;
  supplierInvoiceNumber: string;
  billDate: string;
  dueDate: string;
  currency: string;
  total: string;
  paid: string;
  outstanding: string;
  daysOverdue: number;
  agingBucket: AgingBucketId;
}

export interface AgingBucketRow {
  id: AgingBucketId;
  label: string;
  amount: string;
  billIds: string[];
}

export interface AgedPayables {
  asOfDate: string;
  currency: string;
  buckets: AgingBucketRow[];
  total: string;
  suppliers: Array<{
    supplierId: string;
    supplierName: string;
    buckets: Record<AgingBucketId, string>;
    total: string;
  }>;
}

export type StatementLineType =
  | 'opening-balance' | 'bill' | 'bill-reversal' | 'payment' | 'payment-reversal';

export interface SupplierStatementLine {
  id: string;
  type: StatementLineType;
  date: string;
  documentNumber: string;
  reference: string;
  description: string;
  /** Reduces what is owed — a payment, or a bill reversed out. */
  debit: string;
  /** Increases what is owed — a bill. */
  credit: string;
  runningBalance: string;
  journalEntryId: string | null;
}

export interface SupplierStatement {
  supplierId: string;
  supplierName: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  openingBalance: string;
  periodCharges: string;
  periodPayments: string;
  closingBalance: string;
  lines: SupplierStatementLine[];
  aging: AgedPayables;
  outstandingBills: OutstandingBillRow[];
  /** Netted independently of the running balance — see the header. */
  subledgerBalance: string;
  reconciliationDifference: string;
  isReconciled: boolean;
}

/* ══ Outstanding ═══════════════════════════════════════════════════════════ */

interface RawOutstanding {
  bill_id: string; bill_number: string; supplier_id: string; supplier_name: string;
  supplier_invoice_number: string; bill_date: string | Date; due_date: string | Date;
  currency: string; total: string; paid: string;
}

/**
 * Posted bills with something still owed, as of a date.
 *
 * The as-of date bounds the ALLOCATIONS by payment date as well as the bills by
 * bill date, so a statement run for last month is not silently reduced by a
 * payment made this month — which would make the past look as though it had
 * already been settled.
 */
async function readOutstanding(
  db: Executor,
  actor: AccountingActor,
  options: { asOfDate: string; supplierId?: string; includeSettled?: boolean },
): Promise<RawOutstanding[]> {
  const supplierId = options.supplierId ?? null;
  const { rows } = await sql<RawOutstanding>`
    SELECT b.id                       AS bill_id,
           b.bill_number              AS bill_number,
           b.supplier_id              AS supplier_id,
           p.legal_name               AS supplier_name,
           b.supplier_invoice_number  AS supplier_invoice_number,
           b.bill_date                AS bill_date,
           b.due_date                 AS due_date,
           b.currency                 AS currency,
           b.total::text              AS total,
           COALESCE((
             SELECT SUM(a.amount)
               FROM payment_allocations a
               JOIN supplier_payments sp
                 ON sp.id = a.payment_id
                AND sp.organization_id = a.organization_id
                AND sp.company_id = a.company_id
              WHERE a.organization_id = b.organization_id
                AND a.company_id = b.company_id
                AND a.bill_id = b.id
                AND a.status = 'active'
                AND sp.payment_date <= ${options.asOfDate}::date
           ), 0)::text                AS paid
      FROM bills b
      JOIN business_parties p
        ON p.id = b.supplier_id
       AND p.organization_id = b.organization_id
       AND p.company_id = b.company_id
     WHERE b.organization_id = ${actor.organizationId}
       AND b.company_id = ${actor.companyId}
       AND b.status = 'posted'
       AND b.bill_date <= ${options.asOfDate}::date
       AND (${supplierId}::uuid IS NULL OR b.supplier_id = ${supplierId}::uuid)
     ORDER BY b.due_date, b.bill_number
  `.execute(db);

  if (options.includeSettled) return rows;
  return rows.filter((row) => Money.toAmount(row.total) > Money.toAmount(row.paid));
}

function toOutstandingRow(row: RawOutstanding, asOfDate: string): OutstandingBillRow {
  const decimals = monetaryDecimalsFor(row.currency);
  const total = Money.toAmount(row.total);
  const paid = Money.toAmount(row.paid);
  const dueDate = toCalendarDate(row.due_date);
  const overdue = daysOverdue(dueDate, asOfDate);
  return {
    billId: row.bill_id,
    billNumber: row.bill_number,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    supplierInvoiceNumber: row.supplier_invoice_number,
    billDate: toCalendarDate(row.bill_date),
    dueDate,
    currency: row.currency,
    total: display(row.total, decimals),
    paid: display(row.paid, decimals),
    outstanding: display(Money.toDecimalString(total - paid), decimals),
    daysOverdue: overdue,
    agingBucket: agingBucketFor(overdue),
  };
}

export async function outstandingBills(
  db: Executor,
  actor: AccountingActor,
  options: { asOfDate?: string; supplierId?: string } = {},
): Promise<OutstandingBillRow[]> {
  const asOfDate = assertDate(options.asOfDate ?? toCalendarDate(new Date()), 'asOfDate');
  const rows = await readOutstanding(db, actor, { asOfDate, supplierId: options.supplierId });
  return rows.map((row) => toOutstandingRow(row, asOfDate));
}

/* ══ Ageing ════════════════════════════════════════════════════════════════ */

function buildAging(rows: OutstandingBillRow[], asOfDate: string, currency: string): AgedPayables {
  const decimals = monetaryDecimalsFor(currency);
  const totals = new Map<AgingBucketId, Money.Amount>(BUCKET_ORDER.map((id) => [id, Money.ZERO]));
  const ids = new Map<AgingBucketId, string[]>(BUCKET_ORDER.map((id) => [id, []]));
  const bySupplier = new Map<string, { name: string; buckets: Map<AgingBucketId, Money.Amount> }>();

  for (const row of rows) {
    const amount = Money.toAmount(row.outstanding);
    totals.set(row.agingBucket, totals.get(row.agingBucket)! + amount);
    ids.get(row.agingBucket)!.push(row.billId);

    let supplier = bySupplier.get(row.supplierId);
    if (!supplier) {
      supplier = {
        name: row.supplierName,
        buckets: new Map(BUCKET_ORDER.map((id) => [id, Money.ZERO])),
      };
      bySupplier.set(row.supplierId, supplier);
    }
    supplier.buckets.set(row.agingBucket, supplier.buckets.get(row.agingBucket)! + amount);
  }

  const buckets: AgingBucketRow[] = BUCKET_ORDER.map((id) => ({
    id,
    label: BUCKET_LABELS[id],
    amount: display(Money.toDecimalString(totals.get(id)!), decimals),
    billIds: ids.get(id)!,
  }));

  return {
    asOfDate,
    currency,
    buckets,
    total: display(Money.toDecimalString(Money.sum([...totals.values()])), decimals),
    suppliers: [...bySupplier.entries()]
      .map(([supplierId, supplier]) => ({
        supplierId,
        supplierName: supplier.name,
        buckets: Object.fromEntries(
          BUCKET_ORDER.map((id) => [
            id, display(Money.toDecimalString(supplier.buckets.get(id)!), decimals),
          ]),
        ) as Record<AgingBucketId, string>,
        total: display(Money.toDecimalString(Money.sum([...supplier.buckets.values()])), decimals),
      }))
      .sort((a, b) => a.supplierName.localeCompare(b.supplierName)),
  };
}

async function functionalCurrencyOf(db: Executor, organizationId: string): Promise<string> {
  const org = await db.selectFrom('organizations').select('base_currency')
    .where('id', '=', organizationId).executeTakeFirst();
  if (!org) throw errors.notFound('Organization');
  return org.base_currency;
}

export async function agedPayables(
  db: Executor,
  actor: AccountingActor,
  options: { asOfDate?: string; supplierId?: string } = {},
): Promise<AgedPayables> {
  const asOfDate = assertDate(options.asOfDate ?? toCalendarDate(new Date()), 'asOfDate');
  const rows = await outstandingBills(db, actor, { asOfDate, supplierId: options.supplierId });
  const currency = await functionalCurrencyOf(db, actor.organizationId);
  return buildAging(rows, asOfDate, currency);
}

/* ══ Statement ═════════════════════════════════════════════════════════════ */

interface Movement {
  id: string;
  type: StatementLineType;
  date: string;
  documentNumber: string;
  reference: string;
  description: string;
  debit: Money.Amount;
  credit: Money.Amount;
  journalEntryId: string | null;
}

/**
 * Every movement on one supplier's payable, in date order.
 *
 * A REVERSED document keeps its original movement and gains a second, opposite
 * one on the date its reversing journal was posted — which is what the ledger
 * itself shows. Dropping the original from the statement would produce a period
 * that no longer agrees with the accounts it summarises.
 */
async function readMovements(
  db: Executor,
  actor: AccountingActor,
  supplierId: string,
  through: string,
): Promise<Movement[]> {
  const { rows: bills } = await sql<{
    id: string; bill_number: string; supplier_invoice_number: string;
    bill_date: string | Date; total: string; status: string;
    journal_entry_id: string | null; reversal_journal_entry_id: string | null;
    reversal_date: string | Date | null;
  }>`
    SELECT b.id, b.bill_number, b.supplier_invoice_number, b.bill_date, b.total::text AS total,
           b.status, b.journal_entry_id, b.reversal_journal_entry_id,
           r.posting_date AS reversal_date
      FROM bills b
      LEFT JOIN journal_entries r
        ON r.id = b.reversal_journal_entry_id
       AND r.organization_id = b.organization_id
       AND r.company_id = b.company_id
     WHERE b.organization_id = ${actor.organizationId}
       AND b.company_id = ${actor.companyId}
       AND b.supplier_id = ${supplierId}
       AND b.status IN ('posted', 'reversed')
       AND b.bill_date <= ${through}::date
  `.execute(db);

  const { rows: payments } = await sql<{
    id: string; payment_number: string; reference: string; payment_date: string | Date;
    amount: string; status: string; journal_entry_id: string | null;
    reversal_journal_entry_id: string | null; reversal_date: string | Date | null;
  }>`
    SELECT p.id, p.payment_number, p.reference, p.payment_date, p.amount::text AS amount,
           p.status, p.journal_entry_id, p.reversal_journal_entry_id,
           r.posting_date AS reversal_date
      FROM supplier_payments p
      LEFT JOIN journal_entries r
        ON r.id = p.reversal_journal_entry_id
       AND r.organization_id = p.organization_id
       AND r.company_id = p.company_id
     WHERE p.organization_id = ${actor.organizationId}
       AND p.company_id = ${actor.companyId}
       AND p.supplier_id = ${supplierId}
       AND p.status IN ('posted', 'reversed')
       AND p.payment_date <= ${through}::date
  `.execute(db);

  const movements: Movement[] = [];

  for (const bill of bills) {
    movements.push({
      id: `bill:${bill.id}`,
      type: 'bill',
      date: toCalendarDate(bill.bill_date),
      documentNumber: bill.bill_number,
      reference: bill.supplier_invoice_number,
      description: `Bill ${bill.bill_number}`,
      debit: Money.ZERO,
      credit: Money.toAmount(bill.total),
      journalEntryId: bill.journal_entry_id,
    });
    if (bill.status === 'reversed' && bill.reversal_date) {
      const date = toCalendarDate(bill.reversal_date);
      if (date <= through) {
        movements.push({
          id: `bill-reversal:${bill.id}`,
          type: 'bill-reversal',
          date,
          documentNumber: bill.bill_number,
          reference: bill.supplier_invoice_number,
          description: `Bill ${bill.bill_number} reversed`,
          debit: Money.toAmount(bill.total),
          credit: Money.ZERO,
          journalEntryId: bill.reversal_journal_entry_id,
        });
      }
    }
  }

  for (const payment of payments) {
    movements.push({
      id: `payment:${payment.id}`,
      type: 'payment',
      date: toCalendarDate(payment.payment_date),
      documentNumber: payment.payment_number,
      reference: payment.reference,
      description: `Payment ${payment.payment_number}`,
      debit: Money.toAmount(payment.amount),
      credit: Money.ZERO,
      journalEntryId: payment.journal_entry_id,
    });
    if (payment.status === 'reversed' && payment.reversal_date) {
      const date = toCalendarDate(payment.reversal_date);
      if (date <= through) {
        movements.push({
          id: `payment-reversal:${payment.id}`,
          type: 'payment-reversal',
          date,
          documentNumber: payment.payment_number,
          reference: payment.reference,
          description: `Payment ${payment.payment_number} reversed`,
          debit: Money.ZERO,
          credit: Money.toAmount(payment.amount),
          journalEntryId: payment.reversal_journal_entry_id,
        });
      }
    }
  }

  /* Date, then document number, so two runs of the same period are identical
   * rather than merely equivalent. */
  movements.sort((a, b) => (
    a.date === b.date
      ? (a.documentNumber === b.documentNumber
        ? a.id.localeCompare(b.id)
        : a.documentNumber.localeCompare(b.documentNumber))
      : a.date.localeCompare(b.date)
  ));
  return movements;
}

export async function supplierStatement(
  db: Executor,
  actor: AccountingActor,
  options: { supplierId: string; periodStart?: string; periodEnd?: string },
): Promise<SupplierStatement> {
  const periodEnd = assertDate(options.periodEnd ?? toCalendarDate(new Date()), 'periodEnd');
  const periodStart = assertDate(
    options.periodStart ?? `${periodEnd.slice(0, 4)}-01-01`, 'periodStart',
  );
  if (periodStart > periodEnd) {
    throw errors.validation('The statement period ends before it starts.', {
      fieldErrors: { periodStart: 'Choose a start on or before the end date.' },
    });
  }

  const supplier = await db.selectFrom('business_parties')
    .select(['id', 'legal_name', 'is_supplier'])
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', options.supplierId)
    .executeTakeFirst();
  if (!supplier) throw errors.notFound('Supplier');
  if (!supplier.is_supplier) {
    throw errors.validation(
      `${supplier.legal_name} does not hold the supplier role, so there is no payable statement `
      + 'to produce.',
    );
  }

  const currency = await functionalCurrencyOf(db, actor.organizationId);
  const decimals = monetaryDecimalsFor(currency);

  const movements = await readMovements(db, actor, options.supplierId, periodEnd);

  /* Everything BEFORE the period start is one opening figure; the period's own
   * movements are shown line by line. */
  let opening = Money.ZERO;
  const within: Movement[] = [];
  for (const movement of movements) {
    if (movement.date < periodStart) opening += movement.credit - movement.debit;
    else within.push(movement);
  }

  const lines: SupplierStatementLine[] = [{
    id: 'opening-balance',
    type: 'opening-balance',
    date: periodStart,
    documentNumber: '',
    reference: '',
    description: 'Opening balance',
    debit: display('0', decimals),
    credit: display('0', decimals),
    runningBalance: display(Money.toDecimalString(opening), decimals),
    journalEntryId: null,
  }];

  let running = opening;
  let charges = Money.ZERO;
  let paid = Money.ZERO;
  for (const movement of within) {
    running += movement.credit - movement.debit;
    charges += movement.credit;
    paid += movement.debit;
    lines.push({
      id: movement.id,
      type: movement.type,
      date: movement.date,
      documentNumber: movement.documentNumber,
      reference: movement.reference,
      description: movement.description,
      debit: display(Money.toDecimalString(movement.debit), decimals),
      credit: display(Money.toDecimalString(movement.credit), decimals),
      runningBalance: display(Money.toDecimalString(running), decimals),
      journalEntryId: movement.journalEntryId,
    });
  }

  const outstanding = await outstandingBills(db, actor, {
    asOfDate: periodEnd, supplierId: options.supplierId,
  });
  const subledger = Money.sum(outstanding.map((row) => Money.toAmount(row.outstanding)));
  const difference = running - subledger;

  return {
    supplierId: supplier.id,
    supplierName: supplier.legal_name,
    periodStart,
    periodEnd,
    currency,
    openingBalance: display(Money.toDecimalString(opening), decimals),
    periodCharges: display(Money.toDecimalString(charges), decimals),
    periodPayments: display(Money.toDecimalString(paid), decimals),
    closingBalance: display(Money.toDecimalString(running), decimals),
    lines,
    aging: buildAging(outstanding, periodEnd, currency),
    outstandingBills: outstanding,
    subledgerBalance: display(Money.toDecimalString(subledger), decimals),
    reconciliationDifference: display(Money.toDecimalString(difference), decimals),
    isReconciled: difference === Money.ZERO,
  };
}

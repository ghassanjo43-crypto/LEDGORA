/**
 * Receipts against a sales invoice.
 *
 * ── The invariant this module exists to hold ─────────────────────────────────
 * The invoice's `amount_paid` and the ledger's receivable balance are two
 * views of one fact. Every path here moves both, in the same logical operation,
 * or moves neither. A subledger that disagrees with the general ledger is not a
 * display bug — it is an unreconcilable book, and it is what the browser store
 * could never fully guarantee because it had no ledger to disagree with.
 *
 * ── Why a receipt credits a stored account ───────────────────────────────────
 * The receivable comes from `invoices.receivable_account_id`, written at issue,
 * never from the caller. A caller-supplied receivable balances its own entry
 * while leaving the invoice's actual receivable outstanding — a difference that
 * only shows up at the year-end reconciliation nobody wants to be doing.
 *
 * ── Reversal, not deletion ───────────────────────────────────────────────────
 * A receipt entered in error is reversed: the row stays, a reversing entry is
 * posted, and both documents remain findable. This is the rule `voidInvoice`
 * already applies to invoices, for the same reason.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import type { AccountingActor } from '../accounting/audit.js';
import { monetaryDecimalsFor } from '../accounting/currencyPrecision.js';
import * as Money from '../accounting/money.js';
import * as journals from '../accounting/journalService.js';
import { INVOICE_SOURCE_TYPE, CONCURRENCY_MESSAGE, getInvoice, type InvoiceRecord } from './invoiceService.js';

/** Statuses against which a receipt may be recorded. */
const SETTLEABLE = new Set(['issued', 'sent', 'paid']);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface PaymentInput {
  paidOn: string;
  amount: string;
  /** The bank or cash account the money landed in. */
  bankAccountId: string;
  method?: string;
  reference?: string;
  /** Set when the receipt originates from a receipt document rather than here. */
  receiptId?: string | null;
}

export interface PaymentRecord {
  id: string;
  invoiceId: string;
  paidOn: string;
  amount: string;
  method: string;
  reference: string;
  bankAccountId: string | null;
  journalEntryId: string | null;
  receiptId: string | null;
  reversedAt: string | null;
  reversalJournalEntryId: string | null;
  reversalReason: string | null;
}

const dateText = (value: unknown): string =>
  typeof value === 'string' ? value : new Date(value as string).toISOString().slice(0, 10);
const instant = (value: unknown): string | null =>
  value ? new Date(value as string).toISOString() : null;

/** Render a stored amount at the currency's precision — same rule as the invoice. */
function display(value: unknown, decimals: number): string {
  const raw = Money.toDecimalString(Money.toAmount(value as string));
  const [whole = '0', fraction = ''] = raw.split('.');
  let end = fraction.length;
  while (end > decimals && fraction[end - 1] === '0') end -= 1;
  const kept = fraction.slice(0, end);
  return kept.length > 0 ? `${whole}.${kept}` : whole;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPayment(row: any, decimals: number): PaymentRecord {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    paidOn: dateText(row.paid_on),
    amount: display(row.amount, decimals),
    method: row.method ?? '',
    reference: row.reference ?? '',
    bankAccountId: row.bank_account_id ?? null,
    journalEntryId: row.journal_entry_id ?? null,
    receiptId: row.receipt_id ?? null,
    reversedAt: instant(row.reversed_at),
    reversalJournalEntryId: row.reversal_journal_entry_id ?? null,
    reversalReason: row.reversal_reason ?? null,
  };
}

function amountOf(value: string | null | undefined, field: string): Money.Amount {
  try {
    return Money.toAmount(value, field);
  } catch (error) {
    if (error instanceof Money.MoneyError) throw errors.validation(error.message);
    throw error;
  }
}

export async function listPayments(
  db: Kysely<Database>,
  actor: AccountingActor,
  invoiceId: string,
): Promise<PaymentRecord[]> {
  const invoice = await getInvoice(db, actor, invoiceId);
  const decimals = monetaryDecimalsFor(invoice.transactionCurrency);
  const rows = await db.selectFrom('invoice_payments').selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('invoice_id', '=', invoiceId)
    .orderBy('paid_on', 'asc')
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map((row) => toPayment(row, decimals));
}

/**
 * Record a receipt and post it.
 *
 * The ledger entry is created outside the invoice transaction because
 * `journalService` owns posting and opens its own — the same structure
 * `issueInvoice` uses, and for the same reason. The invoice is then updated in
 * a second transaction that re-checks the version, so a concurrent change
 * leaves an unattached draft entry rather than a receipt bound to an invoice it
 * no longer describes.
 */
export async function recordPayment(
  db: Kysely<Database>,
  actor: AccountingActor,
  invoiceId: string,
  input: PaymentInput,
  options: { expectedVersion?: number },
): Promise<InvoiceRecord> {
  if (!ISO_DATE.test(input.paidOn ?? '')) {
    throw errors.validation('A receipt date is required, as YYYY-MM-DD.', {
      fieldErrors: { paidOn: 'Enter the date the money was received.' },
    });
  }
  if (!input.bankAccountId) {
    throw errors.validation('A bank or cash account is required.', {
      fieldErrors: { bankAccountId: 'Choose the account the money was received into.' },
    });
  }

  const paid = amountOf(input.amount, 'amount');
  if (!Money.isPositive(paid)) {
    throw errors.validation('A receipt must be for more than zero.', {
      fieldErrors: { amount: 'Enter an amount greater than zero.' },
    });
  }

  const prepared = await db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom('invoices').selectAll()
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', invoiceId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw errors.notFound('Invoice');

    if (options.expectedVersion === undefined) {
      throw errors.validation('expectedVersion is required so a concurrent change cannot be overwritten.');
    }
    if (row.version !== options.expectedVersion) throw errors.conflict(CONCURRENCY_MESSAGE);

    if (!SETTLEABLE.has(row.status)) {
      throw errors.conflict(
        row.status === 'void'
          ? 'This invoice was voided. A receipt cannot be recorded against it.'
          : `This invoice is ${row.status}. Issue it before recording a receipt.`,
      );
    }
    if (!row.receivable_account_id) {
      throw errors.conflict(
        'This invoice has no receivable account recorded, so a receipt cannot be applied to it. '
        + 'Invoices migrated from browser storage were posted elsewhere and are settled there.',
      );
    }

    /*
     * Overpayment is refused rather than absorbed. An invoice showing a
     * negative balance due is a credit the customer does not know they hold,
     * and reconciling it later means reconstructing which receipt caused it.
     */
    const due = Money.toAmount(row.balance_due);
    if (paid > due) {
      throw errors.validation(
        `This receipt is more than the ${Money.toDecimalString(due)} outstanding on the invoice.`,
        { fieldErrors: { amount: 'Enter an amount no greater than the balance due.' } },
      );
    }

    return { row, due };
  });

  const entry = await journals.createDraft(db, actor, {
    transactionDate: input.paidOn,
    reference: prepared.row.invoice_number,
    description: `Receipt for invoice ${prepared.row.invoice_number}`,
    sourceType: INVOICE_SOURCE_TYPE,
    sourceId: invoiceId,
    lines: [
      { accountId: input.bankAccountId, debit: Money.toDecimalString(paid), memo: input.reference || prepared.row.invoice_number },
      { accountId: prepared.row.receivable_account_id!, credit: Money.toDecimalString(paid), memo: prepared.row.invoice_number },
    ],
  });
  const posted = await journals.postJournal(db, actor, entry.id, { expectedVersion: entry.version });

  return db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom('invoices').selectAll()
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', invoiceId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw errors.notFound('Invoice');
    if (row.version !== options.expectedVersion) throw errors.conflict(CONCURRENCY_MESSAGE);

    await trx.insertInto('invoice_payments').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      invoice_id: invoiceId,
      paid_on: input.paidOn,
      amount: Money.toDecimalString(paid),
      method: input.method ?? '',
      reference: input.reference ?? '',
      bank_account_id: input.bankAccountId,
      journal_entry_id: posted.id,
      receipt_id: input.receiptId ?? null,
      created_by: actor.userId,
    }).execute();

    const nowPaid = Money.toAmount(row.amount_paid) + paid;
    const outstanding = Money.toAmount(row.grand_total) - Money.toAmount(row.credits_applied) - nowPaid;
    const settled = Money.isZero(outstanding);

    await trx.updateTable('invoices').set({
      amount_paid: Money.toDecimalString(nowPaid),
      balance_due: Money.toDecimalString(outstanding),
      // 'paid' is a settlement state, so it is reached only by arriving at zero.
      status: settled ? 'paid' : row.status,
      paid_at: settled ? new Date() : row.paid_at,
      version: row.version + 1,
      updated_by: actor.userId,
      updated_at: new Date(),
    }).where('organization_id', '=', actor.organizationId).where('company_id', '=', actor.companyId).where('id', '=', invoiceId).execute();

    await trx.insertInto('invoice_audit_events').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      invoice_id: invoiceId,
      action: 'invoice.payment_recorded',
      detail: `${Money.toDecimalString(paid)} received on ${input.paidOn} (${posted.journalNumber})`,
      actor_user_id: actor.userId,
    }).execute();

    return getInvoice(trx as unknown as Kysely<Database>, actor, invoiceId);
  });
}

/**
 * Reverse a receipt.
 *
 * The payment row is kept and marked, the ledger entry is reversed through
 * `journalService`, and the invoice's balance is restored. Nothing is deleted:
 * the mistake stays findable, which is the whole point of recording it.
 */
export async function reversePayment(
  db: Kysely<Database>,
  actor: AccountingActor,
  paymentId: string,
  options: { expectedVersion?: number; reason?: string },
): Promise<InvoiceRecord> {
  const reason = options.reason?.trim();
  if (!reason) {
    throw errors.validation('A reason is required and is recorded against the receipt.', {
      fieldErrors: { reason: 'Explain why this receipt is being reversed.' },
    });
  }

  const payment = await db.selectFrom('invoice_payments').selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', paymentId)
    .executeTakeFirst();
  if (!payment) throw errors.notFound('Receipt');
  if (payment.reversed_at) throw errors.conflict('This receipt has already been reversed.');

  /*
   * `reverseJournal` takes the JOURNAL's version, not the invoice's. They are
   * unrelated counters, and passing the invoice's produces a conflict that
   * looks like someone else editing when nobody has touched anything.
   */
  const reversal = payment.journal_entry_id
    ? await (async () => {
      const original = await journals.getJournal(db, actor, payment.journal_entry_id!);
      return journals.reverseJournal(db, actor, payment.journal_entry_id!, {
        postingDate: dateText(payment.paid_on),
        expectedVersion: original.version,
        reason,
      });
    })()
    : null;

  return db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom('invoices').selectAll()
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', payment.invoice_id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw errors.notFound('Invoice');
    if (options.expectedVersion !== undefined && row.version !== options.expectedVersion) {
      throw errors.conflict(CONCURRENCY_MESSAGE);
    }

    const reversed = Money.toAmount(payment.amount);
    const nowPaid = Money.toAmount(row.amount_paid) - reversed;
    const outstanding = Money.toAmount(row.grand_total) - Money.toAmount(row.credits_applied) - nowPaid;

    await trx.updateTable('invoice_payments').set({
      reversed_at: new Date(),
      reversal_journal_entry_id: reversal?.reversal.id ?? null,
      reversal_reason: reason,
    }).where('organization_id', '=', actor.organizationId).where('company_id', '=', actor.companyId).where('id', '=', paymentId).execute();

    await trx.updateTable('invoices').set({
      amount_paid: Money.toDecimalString(nowPaid),
      balance_due: Money.toDecimalString(outstanding),
      /*
       * A reversal un-settles the invoice. Leaving it 'paid' with money owing
       * is how an invoice stops appearing on the very report that would chase
       * it.
       */
      status: row.status === 'paid' && !Money.isZero(outstanding) ? 'issued' : row.status,
      paid_at: Money.isZero(outstanding) ? row.paid_at : null,
      version: row.version + 1,
      updated_by: actor.userId,
      updated_at: new Date(),
    }).where('organization_id', '=', actor.organizationId).where('company_id', '=', actor.companyId).where('id', '=', payment.invoice_id).execute();

    await trx.insertInto('invoice_audit_events').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      invoice_id: payment.invoice_id,
      action: 'invoice.payment_reversed',
      detail: `${Money.toDecimalString(reversed)} reversed: ${reason}`,
      actor_user_id: actor.userId,
    }).execute();

    return getInvoice(trx as unknown as Kysely<Database>, actor, payment.invoice_id);
  });
}

/**
 * Bringing a company's browser-resident invoices into the database.
 *
 * ══ Why this is not the ordinary create path ═════════════════════════════════
 *
 * A migrated invoice is a historical fact, not a new document, and three of the
 * create path's behaviours are actively wrong for it:
 *
 *  · NUMBERS ARE PRESERVED, never allocated. These numbers are already on
 *    documents customers hold. Re-numbering them would make our records
 *    disagree with theirs — and, once an authority has cleared one, with the
 *    authority's too.
 *
 *  · NOTHING IS POSTED TO THE LEDGER. The browser's own journal already
 *    contains the entries these invoices produced; posting again would
 *    double-count every migrated sale. The link is left null and the audit
 *    trail records why, so a later reconciliation can find them deliberately
 *    rather than wonder.
 *
 *  · STATUS IS TAKEN AS GIVEN. An invoice that was issued in the browser is
 *    issued here. Importing it as a draft would invite somebody to issue it a
 *    second time.
 *
 * ══ Idempotent by construction ══════════════════════════════════════════════
 *
 * Matching is on `(organization_id, invoice_number)`, which is already unique.
 * Re-running the import skips what is present rather than duplicating it, so a
 * migration interrupted halfway is resumed by running it again.
 *
 * ══ Accounts arrive as CODES ════════════════════════════════════════════════
 *
 * The browser's account ids mean nothing here — the same chart imported to the
 * server has different ids. The client resolves its own ids to codes before
 * sending, and this maps codes to server accounts. A code with no match lands
 * on a suspense account rather than failing the import, because a migration
 * that stops on the first unmapped line strands the other nine hundred.
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database, SalesInvoiceStatus } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import type { AccountingActor } from '../accounting/audit.js';
import * as Money from '../accounting/money.js';

type Trx = Transaction<Database>;

/** Where a line goes when its account cannot be matched. */
export const SUSPENSE_ACCOUNT_CODE = '9999';
export const SUSPENSE_ACCOUNT_NAME = 'Migration suspense';

export interface ImportedLine {
  /** The account CODE from the browser's chart. Ids do not survive the move. */
  accountCode: string;
  description?: string;
  quantity?: string;
  unitPrice?: string;
  unit?: string;
  taxCodeId?: string | null;
  taxRate?: string;
  taxAmount?: string;
  lineSubtotal?: string;
  lineTotal?: string;
}

export interface ImportedInvoice {
  invoiceNumber: string;
  status: SalesInvoiceStatus;
  issuingEntityId: string;
  customerId: string;
  issueDate: string;
  dueDate: string;
  purchaseOrderReference?: string;
  customerReference?: string;
  notes?: string;
  terms?: string;
  paymentTerms?: string;
  subtotal?: string;
  taxTotal?: string;
  grandTotal?: string;
  amountPaid?: string;
  issuedAt?: string | null;
  voidedAt?: string | null;
  voidReason?: string | null;
  lines: ImportedLine[];
}

export interface ImportOutcome {
  imported: number;
  skipped: number;
  /** Lines whose account could not be matched, and where they landed instead. */
  unmatchedAccounts: Array<{ invoiceNumber: string; accountCode: string }>;
  failures: Array<{ invoiceNumber: string; reason: string }>;
  /** The sequence each entity's numbering was advanced to. */
  sequences: Array<{ issuingEntityId: string; nextSequence: number }>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The suspense account, created once per organization on first need.
 *
 * A real account in the chart rather than a null: an unmapped line still
 * carries value, and value with nowhere to sit is how a migrated total stops
 * matching the documents it came from. Postable, so the balance can be
 * journalled out to its proper home afterwards.
 */
async function suspenseAccount(trx: Trx, actor: AccountingActor): Promise<string> {
  const existing = await trx.selectFrom('accounts').select('id')
    .where('organization_id', '=', actor.organizationId)
    .where('account_code', '=', SUSPENSE_ACCOUNT_CODE)
    .executeTakeFirst();
  if (existing) return existing.id;

  const created = await trx.insertInto('accounts').values({
    organization_id: actor.organizationId,
    account_code: SUSPENSE_ACCOUNT_CODE,
    account_name: SUSPENSE_ACCOUNT_NAME,
    account_type: 'income',
    normal_balance: 'credit',
    is_postable: true,
  }).returning('id').executeTakeFirstOrThrow();
  return created.id;
}

/** Every account in this organization, by code. */
async function accountsByCode(trx: Trx, organizationId: string): Promise<Map<string, string>> {
  const rows = await trx.selectFrom('accounts').select(['id', 'account_code'])
    .where('organization_id', '=', organizationId).execute();
  return new Map(rows.map((row) => [row.account_code, row.id]));
}

/**
 * The numeric tail of a document number, or null when there is not one.
 *
 * Used only to advance the stored sequence past what has been imported. A
 * number this cannot parse is simply not considered — it will not lower the
 * sequence, which is the only outcome that could cause a collision.
 */
export function sequenceOf(invoiceNumber: string): number | null {
  const match = /(\d+)\s*$/.exec(invoiceNumber);
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 10);
  return Number.isFinite(value) ? value : null;
}

export async function importInvoices(
  db: Kysely<Database>,
  actor: AccountingActor,
  incoming: ImportedInvoice[],
): Promise<ImportOutcome> {
  if (!Array.isArray(incoming)) throw errors.validation('An array of invoices is required.');

  const outcome: ImportOutcome = {
    imported: 0, skipped: 0, unmatchedAccounts: [], failures: [], sequences: [],
  };
  /** Highest sequence seen per issuing entity, so numbering can be advanced. */
  const highest = new Map<string, number>();

  for (const invoice of incoming) {
    try {
      await db.transaction().execute(async (trx) => {
        if (!invoice.invoiceNumber?.trim()) throw errors.validation('An invoice number is required.');
        if (!ISO_DATE.test(invoice.issueDate ?? '')) throw errors.validation('issueDate must be an ISO date.');
        if (!ISO_DATE.test(invoice.dueDate ?? '')) throw errors.validation('dueDate must be an ISO date.');
        if (!invoice.lines?.length) throw errors.validation('An invoice needs at least one line.');

        const already = await trx.selectFrom('invoices').select('id')
          .where('organization_id', '=', actor.organizationId)
          .where('invoice_number', '=', invoice.invoiceNumber)
          .executeTakeFirst();
        if (already) {
          outcome.skipped += 1;
          return;
        }

        const org = await trx.selectFrom('organizations').select('base_currency')
          .where('id', '=', actor.organizationId).executeTakeFirstOrThrow();
        const byCode = await accountsByCode(trx, actor.organizationId);

        let suspense: string | null = null;
        const resolved: Array<{ line: ImportedLine; accountId: string; matched: boolean }> = [];
        for (const line of invoice.lines) {
          const accountId = byCode.get(line.accountCode ?? '');
          if (accountId) {
            resolved.push({ line, accountId, matched: true });
            continue;
          }
          suspense ??= await suspenseAccount(trx, actor);
          resolved.push({ line, accountId: suspense, matched: false });
          outcome.unmatchedAccounts.push({
            invoiceNumber: invoice.invoiceNumber, accountCode: line.accountCode ?? '(none)',
          });
        }

        /*
         * A void invoice must carry its reason, and an issued one its
         * timestamp — the table's own CHECK constraints say so. Browser records
         * predate both rules, so a missing value is filled with an honest
         * stand-in rather than allowed to abort the migration.
         */
        const status = invoice.status ?? 'draft';
        const issuedAt = invoice.issuedAt
          ? new Date(invoice.issuedAt)
          : status === 'draft' || status === 'approved' || status === 'void'
            ? null
            : new Date(`${invoice.issueDate}T00:00:00.000Z`);
        const voidedAt = status === 'void' ? new Date(invoice.voidedAt ?? `${invoice.issueDate}T00:00:00.000Z`) : null;
        const voidReason = status === 'void' ? (invoice.voidReason ?? 'Voided before migration') : null;

        const grandTotal = invoice.grandTotal ?? '0';
        const amountPaid = invoice.amountPaid ?? '0';

        const created = await trx.insertInto('invoices').values({
          organization_id: actor.organizationId,
          issuing_entity_id: invoice.issuingEntityId,
          customer_id: invoice.customerId,
          invoice_number: invoice.invoiceNumber,
          status,
          issue_date: invoice.issueDate,
          due_date: invoice.dueDate,
          transaction_currency: org.base_currency,
          functional_currency: org.base_currency,
          purchase_order_reference: invoice.purchaseOrderReference ?? '',
          customer_reference: invoice.customerReference ?? '',
          subtotal: invoice.subtotal ?? '0',
          tax_total: invoice.taxTotal ?? '0',
          grand_total: grandTotal,
          amount_paid: amountPaid,
          balance_due: Money.toDecimalString(Money.toAmount(grandTotal) - Money.toAmount(amountPaid)),
          notes: invoice.notes ?? '',
          terms: invoice.terms ?? '',
          payment_terms: invoice.paymentTerms ?? '',
          issued_at: issuedAt,
          voided_at: voidedAt,
          void_reason: voidReason,
          created_by: actor.userId,
          updated_by: actor.userId,
        }).returning('id').executeTakeFirstOrThrow();

        for (const [index, entry] of resolved.entries()) {
          await trx.insertInto('invoice_lines').values({
            organization_id: actor.organizationId,
            invoice_id: created.id,
            line_number: index + 1,
            account_id: entry.accountId,
            description: entry.line.description ?? '',
            quantity: entry.line.quantity ?? '0',
            unit: entry.line.unit ?? '',
            unit_price: entry.line.unitPrice ?? '0',
            tax_code_id: entry.line.taxCodeId ?? null,
            tax_rate: entry.line.taxRate ?? '0',
            tax_amount: entry.line.taxAmount ?? '0',
            line_subtotal: entry.line.lineSubtotal ?? '0',
            line_total: entry.line.lineTotal ?? '0',
          }).execute();
        }

        /*
         * The provenance, on the invoice itself. Somebody looking at a migrated
         * document a year from now should be able to see that it came from the
         * browser, that its ledger entry is elsewhere, and which of its lines
         * did not find their account.
         */
        await trx.insertInto('invoice_audit_events').values({
          organization_id: actor.organizationId,
          invoice_id: created.id,
          action: 'invoice.imported',
          detail:
            'Migrated from browser storage. No ledger entry was posted — the entry for this ' +
            'invoice already exists in the books it was migrated from.',
          actor_user_id: actor.userId,
        }).execute();

        const unmatched = resolved.filter((entry) => !entry.matched);
        if (unmatched.length > 0) {
          await trx.insertInto('invoice_audit_events').values({
            organization_id: actor.organizationId,
            invoice_id: created.id,
            action: 'invoice.import_account_unmatched',
            detail:
              `${unmatched.length} line(s) posted to ${SUSPENSE_ACCOUNT_CODE} ${SUSPENSE_ACCOUNT_NAME} ` +
              `because their account codes were not found: ` +
              `${unmatched.map((entry) => entry.line.accountCode ?? '(none)').join(', ')}.`,
            actor_user_id: actor.userId,
          }).execute();
        }

        outcome.imported += 1;
        const sequence = sequenceOf(invoice.invoiceNumber);
        if (sequence !== null) {
          highest.set(
            invoice.issuingEntityId,
            Math.max(highest.get(invoice.issuingEntityId) ?? 0, sequence),
          );
        }
      });
    } catch (cause) {
      outcome.failures.push({
        invoiceNumber: invoice.invoiceNumber ?? '(unnumbered)',
        reason: cause instanceof Error ? cause.message : 'Unknown error',
      });
    }
  }

  /*
   * Advance the stored sequence past everything imported.
   *
   * Without this the first invoice created after a migration reuses a number a
   * customer already holds — the precise failure the held sequence exists to
   * prevent, reintroduced by the migration itself. Never lowered: `next_sequence`
   * only moves forward.
   */
  for (const [issuingEntityId, sequence] of highest) {
    await db.transaction().execute(async (trx) => {
      const existing = await trx.selectFrom('invoice_numbering').selectAll()
        .where('organization_id', '=', actor.organizationId)
        .where('issuing_entity_id', '=', issuingEntityId)
        .executeTakeFirst();

      const next = sequence + 1;
      if (!existing) {
        await trx.insertInto('invoice_numbering')
          .values({ organization_id: actor.organizationId, issuing_entity_id: issuingEntityId, next_sequence: next })
          .execute();
        outcome.sequences.push({ issuingEntityId, nextSequence: next });
        return;
      }
      if (existing.next_sequence >= next) {
        outcome.sequences.push({ issuingEntityId, nextSequence: existing.next_sequence });
        return;
      }
      await trx.updateTable('invoice_numbering')
        .set({ next_sequence: next, updated_at: new Date() })
        .where('organization_id', '=', actor.organizationId)
        .where('issuing_entity_id', '=', issuingEntityId)
        .execute();
      outcome.sequences.push({ issuingEntityId, nextSequence: next });
    });
  }

  return outcome;
}

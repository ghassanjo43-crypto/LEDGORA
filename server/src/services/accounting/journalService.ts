/**
 * The authoritative accounting write path.
 *
 * ══ What this replaces ═══════════════════════════════════════════════════════
 *
 * Every rule below used to live in browser TypeScript: balance, period locks,
 * permissions, concurrency, the correction philosophy. All of it ran in code the
 * account holder could edit, against records only their own device held. This
 * module is the same philosophy re-stated where it can actually hold — inside a
 * PostgreSQL transaction, on rows the browser cannot reach except through here.
 *
 * ══ The four rules that shape the whole file ═════════════════════════════════
 *
 * ONE TRANSACTION. Posting, amending, reversing and replacing each run inside a
 * single `db.transaction()`. The validation, the version snapshot, the status
 * change and the audit event all commit together or none of them do. In
 * particular a failed audit insert ROLLS BACK the posting it describes: an
 * audit trail that can silently lose entries is worse than none, because it is
 * trusted.
 *
 * NOTHING IS TAKEN ON TRUST. The organization comes from the caller's
 * membership, never a request body. The journal number is generated here, never
 * accepted. Accounts and dimensions are re-resolved against this organization
 * inside the transaction. `expectedVersion` is required for every mutation of an
 * existing record, and a mismatch is a refusal rather than a merge.
 *
 * MONEY IS NEVER A FLOAT. Amounts are parsed into BigInt fixed-point by
 * `money.ts` and compared exactly. A balance check with a tolerance is a balance
 * check that accepts unbalanced entries.
 *
 * POSTED RECORDS ARE NEVER DESTROYED. A posted entry can be amended (its
 * previous version snapshotted) or reversed (a new entry withdraws it). There is
 * no code path that deletes one, and `deleteDraft` refuses anything posted.
 */
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import { writeAccountingAudit, type AccountingActor } from './audit.js';
import { assertPeriodAccepts } from './periodService.js';
import { loadAccountsForPosting } from './accountService.js';
import { assessPostingAccount } from './accountEligibility.js';
import { monetaryDecimalsFor } from './currencyPrecision.js';
import * as Money from './money.js';

type Executor = Kysely<Database> | Transaction<Database>;
type Trx = Transaction<Database>;

export type JournalStatus = 'draft' | 'posted' | 'reversed' | 'voided';

export interface JournalLineInput {
  accountId: string;
  /** Decimal STRINGS. See `money.ts` for why these are never numbers. */
  debit?: string | null;
  credit?: string | null;
  memo?: string;
  entityId?: string | null;
  projectId?: string | null;
  costCenterId?: string | null;
}

export interface JournalInput {
  transactionDate: string;
  postingDate?: string;
  reference?: string;
  description?: string;
  notes?: string;
  journalType?: string;
  /**
   * OPTIONAL AND REDUNDANT — omitting both is the recommended contract.
   *
   * An ordinary transaction is always denominated in the company's own currency
   * at par; these are derived from `organizations.base_currency`, never taken
   * from the caller. They remain accepted only so an existing client that sends
   * them keeps working, and a value that DISAGREES with the company is refused
   * rather than applied. See `resolveOrdinaryCurrency`.
   */
  transactionCurrency?: string;
  exchangeRate?: string;
  sourceType?: string | null;
  sourceId?: string | null;
  lines: JournalLineInput[];
}

export interface JournalLineRecord {
  id: string;
  lineNumber: number;
  accountId: string;
  memo: string;
  entityId: string | null;
  projectId: string | null;
  costCenterId: string | null;
  debit: string;
  credit: string;
  debitFunctional: string;
  creditFunctional: string;
}

export interface JournalRecord {
  id: string;
  journalNumber: string;
  journalType: string;
  transactionDate: string;
  postingDate: string;
  status: JournalStatus;
  reference: string;
  description: string;
  notes: string;
  transactionCurrency: string;
  functionalCurrency: string;
  exchangeRate: string;
  sourceType: string | null;
  sourceId: string | null;
  originalEntryId: string | null;
  reversalEntryId: string | null;
  replacementEntryId: string | null;
  version: number;
  postedAt: string | null;
  lines: JournalLineRecord[];
}

export interface MutationOptions {
  /** Required for every mutation of an existing record. */
  expectedVersion?: number;
  reason?: string;
}

export const CONCURRENCY_MESSAGE =
  'This transaction was changed by another user while you were editing it. Review the latest version before applying your changes.';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Both dates an entry carries, validated together.
 *
 * A malformed date would otherwise reach PostgreSQL as a `date` cast failure and
 * surface as a 500 — a server fault reported for what is plainly a bad request.
 * Returns the posting date, which defaults to the transaction date because most
 * entries are posted in the period they happened in.
 */
function resolveDates(input: JournalInput): string {
  if (!ISO_DATE.test(input.transactionDate ?? '')) {
    throw errors.validation('transactionDate must be an ISO date (yyyy-mm-dd).');
  }
  const postingDate = input.postingDate ?? input.transactionDate;
  if (!ISO_DATE.test(postingDate)) {
    throw errors.validation('postingDate must be an ISO date (yyyy-mm-dd).');
  }
  return postingDate;
}

/**
 * Parse an amount, reporting a bad one as a 400 rather than a 500.
 *
 * `Money.toAmount` throws `MoneyError` for anything that is not plainly a
 * decimal. Left alone that surfaces as "internal error", which tells the user
 * nothing and tells the log the wrong thing — a malformed amount is the
 * caller's mistake, and the message already names the offending field.
 */
function amount(value: string | number | null | undefined, field: string): Money.Amount {
  try {
    return Money.toAmount(value, field);
  } catch (error) {
    if (error instanceof Money.MoneyError) throw errors.validation(error.message);
    throw error;
  }
}

/* ══ Reading ═══════════════════════════════════════════════════════════════ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toLine(row: any): JournalLineRecord {
  return {
    id: row.id,
    lineNumber: row.line_number,
    accountId: row.account_id,
    memo: row.memo,
    entityId: row.entity_id,
    projectId: row.project_id,
    costCenterId: row.cost_center_id,
    debit: String(row.debit_transaction),
    credit: String(row.credit_transaction),
    debitFunctional: String(row.debit_functional),
    creditFunctional: String(row.credit_functional),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toJournal(row: any, lines: any[]): JournalRecord {
  const date = (value: unknown): string =>
    typeof value === 'string' ? value : new Date(value as string).toISOString().slice(0, 10);
  return {
    id: row.id,
    journalNumber: row.journal_number,
    journalType: row.journal_type,
    transactionDate: date(row.transaction_date),
    postingDate: date(row.posting_date),
    status: row.status,
    reference: row.reference,
    description: row.description,
    notes: row.notes,
    transactionCurrency: row.transaction_currency,
    functionalCurrency: row.functional_currency,
    exchangeRate: String(row.exchange_rate),
    sourceType: row.source_type,
    sourceId: row.source_id,
    originalEntryId: row.original_entry_id,
    reversalEntryId: row.reversal_entry_id,
    replacementEntryId: row.replacement_entry_id,
    version: row.version,
    postedAt: row.posted_at ? new Date(row.posted_at).toISOString() : null,
    lines: lines.map(toLine).sort((a, b) => a.lineNumber - b.lineNumber),
  };
}

/**
 * Takes the ACTOR rather than an organization id, deliberately.
 *
 * Twelve call sites reach this function, and every one of them previously
 * passed `actor.organizationId` — which is exactly how the company scope came
 * to be missing from all twelve at once. Taking the whole actor makes the
 * company impossible to leave behind.
 */
async function loadJournal(
  db: Executor,
  actor: AccountingActor,
  journalId: string,
): Promise<JournalRecord> {
  const row = await db
    .selectFrom('journal_entries')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', journalId)
    .executeTakeFirst();
  /*
   * A journal belonging to another tenant, and one belonging to a SIBLING
   * COMPANY of the same subscriber, are both indistinguishable from a record
   * that does not exist. The second case is the one that matters here: the
   * caller is a legitimate member of the organization that owns the row, so
   * anything other than "not found" would confirm the entry to somebody who has
   * no business in those books.
   */
  if (!row) throw errors.notFound('Journal entry');

  const lines = await db
    .selectFrom('journal_lines')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('journal_entry_id', '=', journalId)
    .execute();
  return toJournal(row, lines);
}

export async function getJournal(
  db: Executor,
  actor: AccountingActor,
  journalId: string,
): Promise<JournalRecord> {
  return loadJournal(db, actor, journalId);
}

export interface ListOptions {
  status?: JournalStatus;
  from?: string;
  to?: string;
  limit?: number;
}

export async function listJournals(
  db: Executor,
  actor: AccountingActor,
  options: ListOptions = {},
): Promise<JournalRecord[]> {
  let query = db
    .selectFrom('journal_entries')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId);
  if (options.status) query = query.where('status', '=', options.status);
  if (options.from) query = query.where('posting_date', '>=', options.from);
  if (options.to) query = query.where('posting_date', '<=', options.to);

  const rows = await query
    .orderBy('posting_date', 'desc')
    .orderBy('journal_number', 'desc')
    .limit(Math.min(options.limit ?? 200, 500))
    .execute();
  if (rows.length === 0) return [];

  const lines = await db
    .selectFrom('journal_lines')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where(
      'journal_entry_id',
      'in',
      rows.map((r) => r.id),
    )
    .execute();

  const byEntry = new Map<string, typeof lines>();
  for (const line of lines) {
    const bucket = byEntry.get(line.journal_entry_id) ?? [];
    bucket.push(line);
    byEntry.set(line.journal_entry_id, bucket);
  }
  return rows.map((row) => toJournal(row, byEntry.get(row.id) ?? []));
}

export interface JournalVersionRecord {
  version: number;
  changeKind: string;
  reason: string;
  actorName: string;
  at: string;
  snapshot: unknown;
}

/**
 * The entry's history, oldest first.
 *
 * Reading this needs only `general_journal.view`: someone trusted with the
 * current figures is trusted with how they got there. Restricting the history
 * more tightly than the record would let a correction be made quietly, which is
 * the opposite of what the history is for.
 */
export async function listJournalHistory(
  db: Executor,
  actor: AccountingActor,
  journalId: string,
): Promise<JournalVersionRecord[]> {
  // Confirms the entry is this organization's before returning anything.
  await loadJournal(db, actor, journalId);

  const rows = await db
    .selectFrom('journal_entry_versions')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('journal_entry_id', '=', journalId)
    .orderBy('version')
    .execute();

  return rows.map((row) => ({
    version: row.version,
    changeKind: row.change_kind,
    reason: row.reason,
    actorName: row.actor_name,
    at: new Date(row.at).toISOString(),
    snapshot: typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot,
  }));
}

/* ══ Journal numbering ═════════════════════════════════════════════════════ */

/**
 * Allocate the next journal number for this organization.
 *
 * ── Why it is generated here ────────────────────────────────────────────────
 * A browser-supplied number is a browser-chosen number: two tabs would pick the
 * same one, and a malicious client could claim an existing entry's identity. So
 * the server allocates it, inside the caller's transaction.
 *
 * ── Why an advisory lock and not a retry ────────────────────────────────────
 * `SELECT max()` then `INSERT` is a lost-update race: under READ COMMITTED two
 * concurrent transactions both read JE-000003 and both try to write JE-000004.
 *
 * Catching the resulting unique violation and retrying does NOT work, and it is
 * worth being precise about why: in PostgreSQL a constraint violation aborts the
 * entire transaction, so every statement after it fails with "current
 * transaction is aborted". A retry loop inside the transaction cannot run, and
 * this function is called from the middle of postings and reversals that must
 * not be restarted wholesale.
 *
 * So allocation is SERIALISED instead. A transaction-scoped advisory lock keyed
 * on the organization makes the read-then-write atomic with respect to other
 * allocations for the same tenant, and is released automatically at commit or
 * rollback — there is no unlock to forget. Different tenants take different
 * keys and never wait on each other.
 *
 * `journal_entries_number_unique` stays as the backstop. It is what makes the
 * guarantee structural rather than a promise that this function was always
 * called correctly.
 */
async function allocateJournalNumber(
  trx: Trx,
  organizationId: string,
  companyId: string,
): Promise<string> {
  /*
   * The lock and the search are both per COMPANY. Each set of books runs its
   * own JE sequence from one, so a subscriber's second company does not begin
   * numbering wherever the first happened to stop — and the two never contend
   * for the same lock.
   */
  await sql`select pg_advisory_xact_lock(hashtext(${`journal_number:${organizationId}:${companyId}`}))`.execute(trx);

  const row = await trx
    .selectFrom('journal_entries')
    .select(sql<string | null>`max(journal_number)`.as('highest'))
    .where('organization_id', '=', organizationId)
    .where('company_id', '=', companyId)
    .where('journal_number', 'like', 'JE-%')
    .executeTakeFirst();

  const highest = row?.highest ?? null;
  const current = highest ? Number.parseInt(highest.slice(3), 10) : 0;
  const next = Number.isFinite(current) ? current + 1 : 1;
  return `JE-${String(next).padStart(6, '0')}`;
}

/* ══ Validation ════════════════════════════════════════════════════════════ */

export interface ValidationIssue {
  rule: string;
  message: string;
  lineNumber?: number;
}

/** A line the user actually meant: it has an account or an amount. */
function isMeaningful(line: JournalLineInput): boolean {
  return Boolean(line.accountId) || Boolean(line.debit) || Boolean(line.credit);
}

/**
 * Everything a journal must satisfy to be POSTED.
 *
 * Drafts are deliberately exempt: a draft is work in progress, and refusing to
 * save an unfinished entry is how people end up keeping figures in a text file
 * instead. Posting is where the rules bite.
 */
async function validateForPosting(
  trx: Trx,
  organizationId: string,
  companyId: string,
  journal: JournalRecord,
  options: { enforceCurrentAccountEligibility?: boolean } = {},
): Promise<void> {
  const issues: ValidationIssue[] = [];
  const lines = journal.lines;

  if (lines.length < 2) {
    issues.push({ rule: 'min-lines', message: 'A journal entry needs at least two lines.' });
  }

  const accounts = await loadAccountsForPosting(
    trx,
    organizationId,
    companyId,
    lines.map((l) => l.accountId).filter(Boolean),
  );

  let totalDebit = Money.ZERO;
  let totalCredit = Money.ZERO;
  let anyDebit = false;
  let anyCredit = false;

  for (const line of lines) {
    const at = line.lineNumber;
    if (!line.accountId) {
      issues.push({ rule: 'account-required', message: `Line ${at}: an account is required.`, lineNumber: at });
      continue;
    }
    const account = accounts.get(line.accountId);
    if (!account) {
      // Covers both "deleted" and "belongs to another organization".
      issues.push({
        rule: 'account-unknown',
        message: `Line ${at}: the account does not exist in this organization.`,
        lineNumber: at,
      });
      continue;
    }
    const eligibility = assessPostingAccount(account, account.hasChildren);
    if (options.enforceCurrentAccountEligibility !== false && !eligibility.eligible) {
      issues.push({
        rule: `account-${eligibility.reason}`,
        message: `Line ${at}: ${eligibility.message}`,
        lineNumber: at,
      });
    }
    if (account.restrictedCurrency && account.restrictedCurrency !== journal.transactionCurrency) {
      issues.push({
        rule: 'account-currency',
        message: `Line ${at}: "${account.accountName}" only accepts ${account.restrictedCurrency}.`,
        lineNumber: at,
      });
    }

    const debit = amount(line.debit, `line ${at} debit`);
    const credit = amount(line.credit, `line ${at} credit`);
    if (Money.isNegative(debit) || Money.isNegative(credit)) {
      issues.push({ rule: 'negative-amount', message: `Line ${at}: amounts cannot be negative.`, lineNumber: at });
    }
    if (Money.isPositive(debit) && Money.isPositive(credit)) {
      issues.push({
        rule: 'debit-and-credit',
        message: `Line ${at}: a line cannot carry both a debit and a credit.`,
        lineNumber: at,
      });
    }
    if (Money.isZero(debit) && Money.isZero(credit)) {
      issues.push({ rule: 'zero-amount', message: `Line ${at}: enter a debit or a credit amount.`, lineNumber: at });
    }
    if (Money.isPositive(debit)) anyDebit = true;
    if (Money.isPositive(credit)) anyCredit = true;

    totalDebit = Money.add(totalDebit, amount(line.debitFunctional, `line ${at} functional debit`));
    totalCredit = Money.add(totalCredit, amount(line.creditFunctional, `line ${at} functional credit`));
  }

  if (!anyDebit) issues.push({ rule: 'no-debit', message: 'A posted entry needs at least one debit amount.' });
  if (!anyCredit) issues.push({ rule: 'no-credit', message: 'A posted entry needs at least one credit amount.' });

  // Exact equality on BigInt units. No tolerance: a tolerance accepts entries
  // that do not balance, which is the one thing this check exists to prevent.
  if (!Money.equals(totalDebit, totalCredit)) {
    issues.push({
      rule: 'unbalanced',
      message: `Entry does not balance in ${journal.functionalCurrency}: debits ${Money.describe(totalDebit)} versus credits ${Money.describe(totalCredit)}.`,
    });
  }

  if (issues.length > 0) {
    throw errors.validation(issues[0]!.message, {
      fieldErrors: Object.fromEntries(issues.map((i, index) => [`issue${index}`, i.message])),
    });
  }
}

/**
 * Dimensions must belong to this organization.
 *
 * Entities, projects and cost centers are still browser-resident in A1, so
 * there is nothing server-side to join against yet and the columns carry no
 * foreign key. What CAN be enforced now is that a caller does not smuggle a
 * value that is not a uuid at all, and the check is centralised here so the
 * cross-tenant lookup drops straight in when those tables land in A4/A8.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function normaliseDimension(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (!UUID.test(value)) throw errors.validation(`${field} must be an identifier, not a name.`);
  return value;
}

/* ══ Writing ═══════════════════════════════════════════════════════════════ */

/**
 * The organization's functional currency — the books' own currency.
 *
 * Read from `organizations.base_currency`, which is the ONE authoritative source
 * for server-backed accounting. Never from a request body, and never from a
 * browser store: those may mirror this value, but a mirror that disagrees is
 * simply wrong, and the disagreement must not be able to reach the ledger.
 */
async function functionalCurrencyOf(trx: Trx, organizationId: string): Promise<string> {
  const row = await trx
    .selectFrom('organizations')
    .select('base_currency')
    .where('id', '=', organizationId)
    .executeTakeFirst();
  if (!row) throw errors.notFound('Organization');
  return row.base_currency;
}

/** An ordinary transaction is denominated in the company's own currency, at par. */
const PAR_RATE: Money.Amount = Money.toAmount('1', 'exchangeRate');

/**
 * The currency and rate an ordinary accounting transaction MUST carry.
 *
 * ══ The policy ═══════════════════════════════════════════════════════════════
 *
 * The currency chosen when the company was created is the mandatory currency for
 * its ordinary transactions. A JOD company writes JOD journals at rate 1. There
 * is no per-transaction currency choice, and this function is where that stops
 * being a user-interface convention and becomes a rule.
 *
 * ══ Why the request's own values are not used ════════════════════════════════
 *
 * Removing the dropdown from the form removes the CHOICE, not the CAPABILITY:
 * anyone can post `{"transactionCurrency":"USD"}` to this API directly, and a
 * form-only restriction is exactly the kind of enforcement Phase A exists to
 * replace. So the values are derived here from `organizations.base_currency`,
 * inside the same transaction as the write.
 *
 * ══ Why a mismatch is REFUSED rather than quietly corrected ══════════════════
 *
 * Both satisfy the policy — the entry is JOD either way. Refusing is chosen
 * because silently rewriting USD to JOD would leave the caller believing it
 * recorded a foreign-currency transaction and the ledger holding a domestic one,
 * with nothing anywhere saying they disagreed. A caller that means JOD can send
 * JOD, or send nothing. A caller that means USD has a real problem, and should
 * be told rather than have it hidden.
 *
 * Omitting both fields is the recommended contract and is always correct.
 */
function resolveOrdinaryCurrency(
  input: Pick<JournalInput, 'transactionCurrency' | 'exchangeRate'>,
  functionalCurrency: string,
): { transactionCurrency: string; rate: Money.Amount } {
  const requested = input.transactionCurrency?.trim().toUpperCase();
  if (requested && requested !== functionalCurrency.toUpperCase()) {
    throw errors.validation(
      `This company's accounting currency is ${functionalCurrency}. An ordinary transaction cannot be recorded in ${requested}. Omit the currency, or change the company's functional currency in Company Settings.`,
    );
  }

  // Same currency both sides, so the only meaningful rate is par. A supplied
  // rate is checked rather than applied: 1.0000 is accepted because it means
  // the same thing, anything else is a foreign-currency intent this path does
  // not implement.
  if (input.exchangeRate !== undefined && input.exchangeRate !== null && input.exchangeRate !== '') {
    if (!Money.equals(amount(input.exchangeRate, 'exchangeRate'), PAR_RATE)) {
      throw errors.validation(
        `An ordinary ${functionalCurrency} transaction is recorded at an exchange rate of 1. A different rate requires foreign-currency accounting, which is not enabled for this organization.`,
      );
    }
  }

  return { transactionCurrency: functionalCurrency.toUpperCase(), rate: PAR_RATE };
}

/**
 * The currency and rate an EXISTING entry keeps through an edit.
 *
 * Deliberately anchored to what the entry already says rather than to the
 * organization's current setting. Two reasons:
 *
 * An entry's denomination is a historical fact, not a live setting. Re-deriving
 * it on every edit would mean that changing the company's functional currency
 * silently restated every draft still open — the exact "blind rewrite" the
 * policy forbids. Correcting a description must never move the money.
 *
 * And it closes the same bypass in the other direction: an edit cannot be used
 * to slip a different currency onto a record that was created correctly.
 */
function keepRecordedCurrency(
  input: Pick<JournalInput, 'transactionCurrency' | 'exchangeRate'>,
  existing: Pick<JournalRecord, 'transactionCurrency' | 'exchangeRate'>,
): { transactionCurrency: string; rate: Money.Amount } {
  const requested = input.transactionCurrency?.trim().toUpperCase();
  if (requested && requested !== existing.transactionCurrency.toUpperCase()) {
    throw errors.validation(
      `This entry is recorded in ${existing.transactionCurrency} and its currency cannot be changed by editing it. Reverse it and record a new entry instead.`,
    );
  }

  const recorded = amount(existing.exchangeRate, 'exchangeRate');
  if (input.exchangeRate !== undefined && input.exchangeRate !== null && input.exchangeRate !== '') {
    if (!Money.equals(amount(input.exchangeRate, 'exchangeRate'), recorded)) {
      throw errors.validation(
        'The exchange rate recorded on an entry cannot be changed by editing it. Reverse it and record a new entry instead.',
      );
    }
  }

  return { transactionCurrency: existing.transactionCurrency, rate: recorded };
}

async function insertLines(
  trx: Trx,
  organizationId: string,
  companyId: string,
  journalId: string,
  lines: JournalLineInput[],
  rate: Money.Amount,
  /**
   * The currency whose monetary precision these amounts must respect, or `null`
   * to skip the check.
   *
   * `null` is passed only when the lines are COPIED from an entry already in the
   * books — a reversal mirrors what it withdraws. A legacy record carrying more
   * decimals than its currency allows must still be reversible, or it could
   * never be corrected; refusing there would trap it in the ledger for ever.
   */
  precisionCurrency: string | null,
): Promise<void> {
  const meaningful = lines.filter(isMeaningful);
  if (meaningful.length === 0) return;

  /*
   * ── Monetary precision, enforced on the server ────────────────────────────
   *
   * A JOD company's posted amounts carry at most three decimals. The browser
   * validates this too, but the browser is not a boundary: this is what stops
   * `{"debit":"100.1234"}` posted straight to the API from entering the ledger.
   *
   * Refused, never rounded. Silently turning 100.1234 into 100.123 would accept
   * a figure the caller did not send and then report success for it.
   */
  if (precisionCurrency !== null) {
    const decimals = monetaryDecimalsFor(precisionCurrency);
    meaningful.forEach((line, index) => {
      for (const [field, raw] of [['debit', line.debit], ['credit', line.credit]] as const) {
        const value = amount(raw, `line ${index + 1} ${field}`);
        if (Money.exceedsPrecision(value, decimals)) {
          throw errors.validation(
            decimals === 0
              ? `Line ${index + 1}: ${precisionCurrency} does not support decimal places, but ${field} is ${String(raw)}.`
              : `Line ${index + 1}: ${precisionCurrency} supports a maximum of ${decimals} decimal place${decimals === 1 ? '' : 's'}, but ${field} is ${String(raw)}.`,
          );
        }
      }
    });
  }

  /*
   * An account id is checked against THIS organization even on a draft.
   *
   * The composite foreign key would refuse it anyway — that is the guarantee
   * that actually holds — but it would surface as a raw constraint violation,
   * which reads as a server fault rather than as the refusal it is. A draft is
   * allowed to be incomplete; it is not allowed to name another tenant's
   * account, so the answer is the same at draft time as at posting time.
   */
  const named = meaningful.map((line) => line.accountId).filter(Boolean);
  if (named.length > 0) {
    const known = await loadAccountsForPosting(trx, organizationId, companyId, named);
    const missing = named.find((id) => !known.has(id));
    if (missing) {
      /*
       * Reached for an account of ANOTHER company as well as one that does not
       * exist — `loadAccountsForPosting` is scoped to this company, so the two
       * are indistinguishable here. The database would refuse the insert
       * regardless; this produces a readable message instead of a constraint
       * violation.
       */
      throw errors.validation('An account on this entry does not exist in this company.');
    }
  }

  await trx
    .insertInto('journal_lines')
    .values(
      meaningful.map((line, index) => {
        const debit = amount(line.debit, `line ${index + 1} debit`);
        const credit = amount(line.credit, `line ${index + 1} credit`);
        return {
          organization_id: organizationId,
          company_id: companyId,
          journal_entry_id: journalId,
          line_number: index + 1,
          account_id: line.accountId,
          entity_id: normaliseDimension(line.entityId, 'entityId'),
          project_id: normaliseDimension(line.projectId, 'projectId'),
          cost_center_id: normaliseDimension(line.costCenterId, 'costCenterId'),
          memo: line.memo ?? '',
          debit_transaction: Money.toDecimalString(debit),
          credit_transaction: Money.toDecimalString(credit),
          // Translated once, at write time, and never re-derived afterwards.
          debit_functional: Money.toDecimalString(Money.multiply(debit, rate)),
          credit_functional: Money.toDecimalString(Money.multiply(credit, rate)),
          exchange_rate: Money.toDecimalString(rate),
        };
      }),
    )
    .execute();
}

/** Snapshot an entry and its lines, for `journal_entry_versions`. */
function snapshotOf(journal: JournalRecord): Record<string, unknown> {
  return { ...journal } as unknown as Record<string, unknown>;
}

/**
 * Record a version of an entry.
 *
 * `journal` is the entry AS IT STANDS AT that version — the snapshot is written
 * after the change, not before it. Two reasons, and the first is the one that
 * matters:
 *
 * `journal_entry_versions_unique (journal_entry_id, version)` means one row per
 * version. Snapshotting the SUPERSEDED state would write version 1 twice — once
 * when the draft is created and again when the first change records what it
 * replaced — and the entry's current state would never appear in its own
 * history at all.
 *
 * Writing the state at each version instead makes the history complete and
 * self-describing: version N's row says what the entry said at version N, which
 * is exactly the question an auditor asks. What changed is the difference
 * between two adjacent rows.
 */
async function writeVersion(
  trx: Trx,
  actor: AccountingActor,
  journal: JournalRecord,
  changeKind: string,
  reason: string,
  changes: unknown[] = [],
): Promise<void> {
  await trx
    .insertInto('journal_entry_versions')
    .values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      journal_entry_id: journal.id,
      version: journal.version,
      change_kind: changeKind,
      reason,
      snapshot: JSON.stringify(snapshotOf(journal)),
      changes: JSON.stringify(changes),
      actor_user_id: actor.userId,
      actor_name: actor.name,
    })
    .execute();
}

/**
 * Load a journal FOR UPDATE and check the caller's version in one step.
 *
 * The row lock is what makes the version check meaningful: without it two
 * transactions could both read version 3, both find it current, and both write
 * version 4. `forUpdate` serialises them so the second sees the first's result.
 */
async function lockAndVerify(
  trx: Trx,
  actor: AccountingActor,
  journalId: string,
  expectedVersion: number | undefined,
): Promise<JournalRecord> {
  const locked = await trx
    .selectFrom('journal_entries')
    .select(['id', 'version'])
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', journalId)
    .forUpdate()
    .executeTakeFirst();
  if (!locked) throw errors.notFound('Journal entry');

  // An omitted token is not a bypass — it is a caller that has not read the
  // record, and last-write-wins is exactly what this exists to prevent.
  if (typeof expectedVersion !== 'number' || expectedVersion !== locked.version) {
    throw errors.conflict(CONCURRENCY_MESSAGE);
  }
  return loadJournal(trx, actor, journalId);
}

export async function createDraft(
  db: Kysely<Database>,
  actor: AccountingActor,
  input: JournalInput,
  hooks: PostingHooks = {},
): Promise<JournalRecord> {
  const postingDate = resolveDates(input);

  return db.transaction().execute(async (trx) => {
    // Derived from the organization, inside the same transaction as the write.
    const functionalCurrency = await functionalCurrencyOf(trx, actor.organizationId);
    const { transactionCurrency, rate } = resolveOrdinaryCurrency(input, functionalCurrency);

    const journalNumber = await allocateJournalNumber(trx, actor.organizationId, actor.companyId);
    const created = await trx
      .insertInto('journal_entries')
      .values({
        organization_id: actor.organizationId,
        company_id: actor.companyId,
        journal_number: journalNumber,
        journal_type: input.journalType ?? 'general',
        transaction_date: input.transactionDate,
        posting_date: postingDate,
        status: 'draft',
        reference: input.reference ?? '',
        description: input.description ?? '',
        notes: input.notes ?? '',
        transaction_currency: transactionCurrency,
        functional_currency: functionalCurrency,
        exchange_rate: Money.toDecimalString(rate),
        source_type: input.sourceType ?? null,
        source_id: input.sourceId ?? null,
        created_by: actor.userId,
        updated_by: actor.userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await insertLines(trx, actor.organizationId, actor.companyId, created.id, input.lines ?? [], rate, transactionCurrency);

    const journal = await loadJournal(trx, actor, created.id);
    await writeVersion(trx, actor, journal, 'created', '');
    await hooks.afterVersion?.(trx, journal);
    await writeAccountingAudit(trx, actor, {
      action: 'JOURNAL_CREATED',
      recordType: 'journal_entry',
      recordId: journal.id,
      resultingVersion: journal.version,
      detail: { journalNumber: journal.journalNumber, lines: journal.lines.length },
    });
    return journal;
  });
}

export async function updateDraft(
  db: Kysely<Database>,
  actor: AccountingActor,
  journalId: string,
  input: JournalInput,
  options: MutationOptions,
  hooks: PostingHooks = {},
): Promise<JournalRecord> {
  return db.transaction().execute(async (trx) => {
    const existing = await lockAndVerify(trx, actor, journalId, options.expectedVersion);
    if (existing.status !== 'draft') {
      throw errors.conflict('Only a draft can be edited directly. Amend or reverse a posted entry instead.');
    }

    const { transactionCurrency, rate } = keepRecordedCurrency(input, existing);
    const postingDate = resolveDates(input);

    // Moving a draft's date re-evaluates its period: a draft may not be saved
    // into a period that is already locked.
    await assertPeriodAccepts(trx, actor.organizationId, actor.companyId, postingDate, 'amend');

    await trx
      .updateTable('journal_entries')
      .set({
        transaction_date: input.transactionDate,
        posting_date: postingDate,
        reference: input.reference ?? '',
        description: input.description ?? '',
        notes: input.notes ?? '',
        transaction_currency: transactionCurrency,
        exchange_rate: Money.toDecimalString(rate),
        version: existing.version + 1,
        updated_by: actor.userId,
        updated_at: new Date(),
      })
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', journalId)
      .execute();

    await trx
      .deleteFrom('journal_lines')
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('journal_entry_id', '=', journalId)
      .execute();
    await insertLines(trx, actor.organizationId, actor.companyId, journalId, input.lines ?? [], rate, transactionCurrency);

    const updated = await loadJournal(trx, actor, journalId);
    await writeVersion(trx, actor, updated, 'amended', options.reason ?? '');
    await hooks.afterVersion?.(trx, updated);
    await writeAccountingAudit(trx, actor, {
      action: 'JOURNAL_UPDATED',
      recordType: 'journal_entry',
      recordId: journalId,
      reason: options.reason ?? '',
      previousVersion: existing.version,
      resultingVersion: updated.version,
    });
    return updated;
  });
}

export async function deleteDraft(
  db: Kysely<Database>,
  actor: AccountingActor,
  journalId: string,
  options: MutationOptions,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const existing = await lockAndVerify(trx, actor, journalId, options.expectedVersion);
    if (existing.status !== 'draft') {
      // The only hard rule in this module with no exception.
      throw errors.conflict('A posted journal entry is never deleted. Reverse it instead.');
    }

    await trx
      .deleteFrom('journal_entries')
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', journalId)
      .execute();

    // Written AFTER the delete and outside any foreign key, so the record of
    // who removed the draft survives the draft.
    await writeAccountingAudit(trx, actor, {
      action: 'JOURNAL_DELETED_DRAFT',
      recordType: 'journal_entry',
      recordId: journalId,
      previousVersion: existing.version,
      detail: { journalNumber: existing.journalNumber },
    });
  });
}

/**
 * Post a journal entry.
 *
 * The whole sequence — lock, version check, period check, validation, balance,
 * snapshot, status change, audit — is one transaction. Any throw rolls back all
 * of it, so there is no state in which an entry is posted but unaudited, or
 * validated but half-written.
 */
export async function postJournal(
  db: Kysely<Database>,
  actor: AccountingActor,
  journalId: string,
  options: MutationOptions,
  hooks: PostingHooks = {},
): Promise<JournalRecord> {
  return db.transaction().execute(async (trx) => {
    const journal = await lockAndVerify(trx, actor, journalId, options.expectedVersion);
    if (journal.status === 'posted') throw errors.conflict('This entry is already posted.');
    if (journal.status !== 'draft') throw errors.conflict(`A ${journal.status} entry cannot be posted.`);

    await assertPeriodAccepts(trx, actor.organizationId, actor.companyId, journal.postingDate, 'post');
    await validateForPosting(trx, actor.organizationId, actor.companyId, journal);

    const now = new Date();
    await trx
      .updateTable('journal_entries')
      .set({
        status: 'posted',
        posted_at: now,
        posted_by: actor.userId,
        version: journal.version + 1,
        updated_by: actor.userId,
        updated_at: now,
      })
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', journalId)
      .execute();

    const posted = await loadJournal(trx, actor, journalId);
    await writeVersion(trx, actor, posted, 'posted', options.reason ?? '');
    await hooks.afterVersion?.(trx, posted);

    await hooks.beforeAudit?.(trx);
    await writeAccountingAudit(trx, actor, {
      action: 'JOURNAL_POSTED',
      recordType: 'journal_entry',
      recordId: journalId,
      previousVersion: journal.version,
      resultingVersion: journal.version + 1,
      detail: { journalNumber: journal.journalNumber, postingDate: journal.postingDate },
    });

    return posted;
  });
}

/**
 * Fault-injection seams.
 *
 * Used ONLY by tests, to prove that a failure between the version snapshot and
 * the audit insert rolls the posting back. Exposed as optional callbacks rather
 * than by mocking the database so the transaction under test is the real one.
 */
export interface PostingHooks {
  afterVersion?: (trx: Trx, journal: JournalRecord) => Promise<void>;
  beforeAudit?: (trx: Trx) => Promise<void>;
  beforeReplacement?: (trx: Trx) => Promise<void>;
  afterReversal?: (trx: Trx, original: JournalRecord, reversal: JournalRecord) => Promise<void>;
}

/* ══ Corrections ═══════════════════════════════════════════════════════════ */

export type AmendmentMode = 'direct_edit' | 'amend_in_place' | 'reverse_and_replace' | 'blocked';

export interface AmendmentAssessment {
  journalId: string;
  status: JournalStatus;
  version: number;
  mode: AmendmentMode;
  reasonRequired: boolean;
  explanation: string;
}

/**
 * How may this entry be corrected?
 *
 * The same philosophy the browser used, restated server-side: a draft is edited,
 * a standalone posted entry is amended with its history kept, an entry another
 * module owns belongs to that module, and a locked period stops everything.
 */
export async function assessAmendment(
  db: Executor,
  actor: AccountingActor,
  journalId: string,
): Promise<AmendmentAssessment> {
  const journal = await loadJournal(db, actor, journalId);
  const base = { journalId, status: journal.status, version: journal.version };

  const period = await (async () => {
    try {
      await assertPeriodAccepts(db, actor.organizationId, actor.companyId, journal.postingDate, 'amend');
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
  if (period) {
    return { ...base, mode: 'blocked', reasonRequired: false, explanation: period };
  }

  if (journal.status === 'draft') {
    return { ...base, mode: 'direct_edit', reasonRequired: false, explanation: 'This entry is a draft and can be edited directly.' };
  }
  if (journal.status !== 'posted') {
    return { ...base, mode: 'blocked', reasonRequired: false, explanation: `A ${journal.status} entry cannot be corrected. Record a new entry instead.` };
  }
  if (journal.sourceType) {
    return {
      ...base,
      mode: 'blocked',
      reasonRequired: false,
      explanation: `This journal was generated by ${journal.sourceType}. Correct that document instead — editing the journal alone would leave the two disagreeing.`,
    };
  }
  if (journal.reversalEntryId || journal.replacementEntryId) {
    return { ...base, mode: 'blocked', reasonRequired: false, explanation: 'This entry has already been reversed or replaced.' };
  }
  return {
    ...base,
    mode: 'amend_in_place',
    reasonRequired: true,
    explanation: 'This posted entry is standalone. The correction is applied as a new version and the original is kept in the history.',
  };
}

function requireReason(reason: string | undefined): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length < 5) {
    throw errors.validation('A reason is required and is recorded permanently in the entry’s history.');
  }
  return trimmed;
}

export async function amendPostedJournal(
  db: Kysely<Database>,
  actor: AccountingActor,
  journalId: string,
  input: JournalInput,
  options: MutationOptions,
): Promise<JournalRecord> {
  const reason = requireReason(options.reason);

  return db.transaction().execute(async (trx) => {
    const existing = await lockAndVerify(trx, actor, journalId, options.expectedVersion);
    if (existing.status !== 'posted') throw errors.conflict('Only a posted entry is amended this way.');
    if (existing.sourceType) {
      throw errors.conflict(
        `This journal was generated by ${existing.sourceType}. Correct that document instead.`,
      );
    }

    const postingDate = resolveDates(input);
    await assertPeriodAccepts(trx, actor.organizationId, actor.companyId, existing.postingDate, 'amend');
    await assertPeriodAccepts(trx, actor.organizationId, actor.companyId, postingDate, 'amend');

    // A POSTED entry's denomination is settled history. An amendment corrects
    // figures within it; it does not re-denominate them.
    const { rate } = keepRecordedCurrency(input, existing);

    await trx
      .updateTable('journal_entries')
      .set({
        transaction_date: input.transactionDate,
        posting_date: postingDate,
        reference: input.reference ?? existing.reference,
        description: input.description ?? existing.description,
        notes: input.notes ?? existing.notes,
        exchange_rate: Money.toDecimalString(rate),
        version: existing.version + 1,
        updated_by: actor.userId,
        updated_at: new Date(),
      })
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', journalId)
      .execute();

    await trx
      .deleteFrom('journal_lines')
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('journal_entry_id', '=', journalId)
      .execute();
    await insertLines(trx, actor.organizationId, actor.companyId, journalId, input.lines ?? [], rate, existing.transactionCurrency);

    const amended = await loadJournal(trx, actor, journalId);
    // A correction to a POSTED entry must still be a valid posting.
    await validateForPosting(trx, actor.organizationId, actor.companyId, amended);
    await writeVersion(trx, actor, amended, 'amended', reason);

    await writeAccountingAudit(trx, actor, {
      action: 'JOURNAL_AMENDED',
      recordType: 'journal_entry',
      recordId: journalId,
      reason,
      previousVersion: existing.version,
      resultingVersion: amended.version,
    });
    return amended;
  });
}

/** Build the reversing lines: every debit becomes a credit and vice versa. */
function reverseLines(journal: JournalRecord): JournalLineInput[] {
  return journal.lines.map((line) => ({
    accountId: line.accountId,
    debit: line.credit,
    credit: line.debit,
    memo: line.memo,
    entityId: line.entityId,
    projectId: line.projectId,
    costCenterId: line.costCenterId,
  }));
}

async function insertReversal(
  trx: Trx,
  actor: AccountingActor,
  original: JournalRecord,
  reason: string,
  postingDate: string,
): Promise<JournalRecord> {
  // Mirrors the original's denomination exactly, including a legacy one. A
  // reversal that withdrew a USD entry in JOD would not withdraw it.
  const rate = amount(original.exchangeRate, 'exchangeRate');
  const number = await allocateJournalNumber(trx, actor.organizationId, actor.companyId);
  const now = new Date();

  const created = await trx
    .insertInto('journal_entries')
    .values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      journal_number: number,
      journal_type: original.journalType,
      transaction_date: original.transactionDate,
      posting_date: postingDate,
      status: 'posted',
      reference: `REV-${original.journalNumber}`,
      description: `Reversal of ${original.journalNumber}${original.description ? ` — ${original.description}` : ''}`,
      notes: reason,
      transaction_currency: original.transactionCurrency,
      functional_currency: original.functionalCurrency,
      exchange_rate: Money.toDecimalString(rate),
      original_entry_id: original.id,
      posted_at: now,
      posted_by: actor.userId,
      created_by: actor.userId,
      updated_by: actor.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  // null: a reversal copies figures already in the books. See insertLines.
  await insertLines(trx, actor.organizationId, actor.companyId, created.id, reverseLines(original), rate, null);

  const reversal = await loadJournal(trx, actor, created.id);
  // A reversal withdraws an already-recorded posting. Re-check its balance and
  // tenant-owned references, but do not strand history because an account was
  // subsequently retired or blocked.
  await validateForPosting(trx, actor.organizationId, actor.companyId, reversal, { enforceCurrentAccountEligibility: false });
  // It is born posted, so its first version is the posted one.
  await writeVersion(trx, actor, reversal, 'posted', reason);
  return reversal;
}

export async function reverseJournal(
  db: Kysely<Database>,
  actor: AccountingActor,
  journalId: string,
  options: MutationOptions & { postingDate?: string },
  hooks: PostingHooks = {},
): Promise<{ original: JournalRecord; reversal: JournalRecord }> {
  const reason = requireReason(options.reason);

  return db.transaction().execute(async (trx) => {
    const original = await lockAndVerify(trx, actor, journalId, options.expectedVersion);
    // The specific answer before the general one: an entry that was already
    // reversed is no longer 'posted', and "only a posted entry can be reversed"
    // would be a true statement that explains nothing.
    if (original.reversalEntryId) throw errors.conflict('This entry has already been reversed.');
    if (original.status !== 'posted') throw errors.conflict('Only a posted entry can be reversed.');

    const postingDate = options.postingDate ?? original.postingDate;
    await assertPeriodAccepts(trx, actor.organizationId, actor.companyId, original.postingDate, 'amend');
    await assertPeriodAccepts(trx, actor.organizationId, actor.companyId, postingDate, 'post');

    const reversal = await insertReversal(trx, actor, original, reason, postingDate);

    await trx
      .updateTable('journal_entries')
      .set({
        reversal_entry_id: reversal.id,
        status: 'reversed',
        version: original.version + 1,
        updated_by: actor.userId,
        updated_at: new Date(),
      })
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', journalId)
      .execute();

    const withdrawn = await loadJournal(trx, actor, journalId);
    await writeVersion(trx, actor, withdrawn, 'reversed', reason);
    await hooks.afterVersion?.(trx, withdrawn);
    await hooks.afterReversal?.(trx, withdrawn, reversal);

    await writeAccountingAudit(trx, actor, {
      action: 'JOURNAL_REVERSED',
      recordType: 'journal_entry',
      recordId: journalId,
      reason,
      previousVersion: original.version,
      resultingVersion: withdrawn.version,
      detail: { reversalId: reversal.id, reversalNumber: reversal.journalNumber },
    });

    return { original: withdrawn, reversal };
  });
}

/**
 * Reverse and replace, as ONE atomic operation.
 *
 * Three records afterwards — original, reversal, replacement — all linked. If
 * the replacement fails to validate, the reversal is rolled back with it: a
 * ledger holding a reversal and no replacement is a ledger that has silently
 * lost a transaction, which is worse than the correction never happening.
 */
export async function reverseAndReplace(
  db: Kysely<Database>,
  actor: AccountingActor,
  journalId: string,
  input: JournalInput,
  options: MutationOptions & { postingDate?: string },
  hooks: PostingHooks = {},
): Promise<{ original: JournalRecord; reversal: JournalRecord; replacement: JournalRecord }> {
  const reason = requireReason(options.reason);

  return db.transaction().execute(async (trx) => {
    const original = await lockAndVerify(trx, actor, journalId, options.expectedVersion);
    if (original.reversalEntryId) throw errors.conflict('This entry has already been reversed.');
    if (original.status !== 'posted') throw errors.conflict('Only a posted entry can be reversed and replaced.');

    const postingDate = options.postingDate ?? resolveDates(input);
    await assertPeriodAccepts(trx, actor.organizationId, actor.companyId, original.postingDate, 'amend');
    await assertPeriodAccepts(trx, actor.organizationId, actor.companyId, postingDate, 'post');

    const reversal = await insertReversal(trx, actor, original, reason, original.postingDate);

    await hooks.beforeReplacement?.(trx);

    /*
     * The replacement is a NEW transaction, so it takes the ordinary-currency
     * rule rather than inheriting the original's denomination. That matters for
     * a legacy entry: replacing one recorded in another currency produces a
     * compliant entry in the company's own currency, and the original stays
     * exactly as it was posted.
     */
    const { transactionCurrency: replacementCurrency, rate } = resolveOrdinaryCurrency(
      input,
      original.functionalCurrency,
    );
    const replacementNumber = await allocateJournalNumber(trx, actor.organizationId, actor.companyId);
    const now = new Date();
    const createdReplacement = await trx
      .insertInto('journal_entries')
      .values({
        organization_id: actor.organizationId,
        company_id: actor.companyId,
        journal_number: replacementNumber,
        journal_type: original.journalType,
        transaction_date: input.transactionDate,
        posting_date: postingDate,
        status: 'posted',
        reference: input.reference ?? original.reference,
        description: input.description ?? `Replacement for ${original.journalNumber}`,
        notes: input.notes ?? reason,
        transaction_currency: replacementCurrency,
        functional_currency: original.functionalCurrency,
        exchange_rate: Money.toDecimalString(rate),
        original_entry_id: original.id,
        posted_at: now,
        posted_by: actor.userId,
        created_by: actor.userId,
        updated_by: actor.userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await insertLines(trx, actor.organizationId, actor.companyId, createdReplacement.id, input.lines ?? [], rate, replacementCurrency);
    const replacement = await loadJournal(trx, actor, createdReplacement.id);
    await validateForPosting(trx, actor.organizationId, actor.companyId, replacement);
    await writeVersion(trx, actor, replacement, 'posted', reason);

    await trx
      .updateTable('journal_entries')
      .set({
        reversal_entry_id: reversal.id,
        replacement_entry_id: replacement.id,
        status: 'reversed',
        version: original.version + 1,
        updated_by: actor.userId,
        updated_at: now,
      })
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', journalId)
      .execute();

    const withdrawn = await loadJournal(trx, actor, journalId);
    await writeVersion(trx, actor, withdrawn, 'replaced', reason);

    await writeAccountingAudit(trx, actor, {
      action: 'JOURNAL_REPLACED',
      recordType: 'journal_entry',
      recordId: journalId,
      reason,
      previousVersion: original.version,
      resultingVersion: withdrawn.version,
      detail: { reversalId: reversal.id, replacementId: replacement.id, replacementNumber },
    });

    return { original: withdrawn, reversal, replacement };
  });
}

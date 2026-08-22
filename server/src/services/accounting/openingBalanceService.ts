import { randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import type { AccountingActor } from './audit.js';
import { writeAccountingAudit } from './audit.js';
import * as Money from './money.js';
import * as journals from './journalService.js';
import { assessPostingAccount } from './accountEligibility.js';

type Executor = Kysely<Database> | Transaction<Database>;
export type OpeningBalanceStatus = 'draft' | 'submitted' | 'approved' | 'posted' | 'reversed';

export interface OpeningBalanceInput {
  bookkeepingStartDate: string;
  openingBalanceDate?: string;
  reference?: string;
  description?: string;
  lines: journals.JournalLineInput[];
}

export interface OpeningBalanceRecord {
  id: string;
  status: OpeningBalanceStatus;
  version: number;
  bookkeepingStartDate: string;
  openingBalanceDate: string;
  reference: string;
  description: string;
  preparedBy: string | null;
  submittedBy: string | null;
  approvedBy: string | null;
  postedBy: string | null;
  reversedBy: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  postedAt: string | null;
  reversedAt: string | null;
  reversalJournalEntryId: string | null;
  replacesOpeningBalanceId: string | null;
  journal: journals.JournalRecord;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateText = (value: unknown): string => typeof value === 'string' ? value : new Date(value as string).toISOString().slice(0, 10);
const instant = (value: unknown): string | null => value ? new Date(value as string).toISOString() : null;

export function precedingDate(startDate: string): string {
  if (!ISO_DATE.test(startDate)) throw errors.validation('bookkeepingStartDate must be an ISO date (yyyy-mm-dd).');
  const date = new Date(`${startDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw errors.validation('The bookkeeping start date is invalid.');
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function resolveDates(input: OpeningBalanceInput): { start: string; opening: string } {
  const start = input.bookkeepingStartDate;
  const opening = input.openingBalanceDate ?? precedingDate(start);
  if (!ISO_DATE.test(start) || !ISO_DATE.test(opening) || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(opening))) {
    throw errors.validation('Bookkeeping start and opening-balance dates must be valid ISO dates.');
  }
  if (opening >= start) throw errors.validation('The opening-balance date must be before the bookkeeping start date.');
  return { start, opening };
}

async function rowOf(executor: Executor, actor: AccountingActor, id: string, lock = false): Promise<any> {
  let query = executor.selectFrom('opening_balance_sets').selectAll()
    .where('organization_id', '=', actor.organizationId).where('id', '=', id);
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (!row) throw errors.notFound('Opening balance');
  return row;
}

async function toRecord(executor: Executor, actor: AccountingActor, row: any): Promise<OpeningBalanceRecord> {
  const journal = await journals.getJournal(executor as Kysely<Database>, actor, row.journal_entry_id);
  return {
    id: row.id, status: row.status, version: row.version,
    bookkeepingStartDate: dateText(row.bookkeeping_start_date), openingBalanceDate: dateText(row.opening_balance_date),
    reference: row.reference, description: row.description, preparedBy: row.prepared_by,
    submittedBy: row.submitted_by, approvedBy: row.approved_by, postedBy: row.posted_by, reversedBy: row.reversed_by,
    submittedAt: instant(row.submitted_at), approvedAt: instant(row.approved_at), postedAt: instant(row.posted_at), reversedAt: instant(row.reversed_at),
    reversalJournalEntryId: row.reversal_journal_entry_id, replacesOpeningBalanceId: row.replaces_opening_balance_id,
    journal,
  };
}

export async function getCurrent(db: Kysely<Database>, actor: AccountingActor): Promise<OpeningBalanceRecord | null> {
  const row = await db.selectFrom('opening_balance_sets').selectAll()
    .where('organization_id', '=', actor.organizationId)
    .orderBy('created_at', 'desc').executeTakeFirst();
  return row ? toRecord(db, actor, row) : null;
}

export async function getById(db: Kysely<Database>, actor: AccountingActor, id: string): Promise<OpeningBalanceRecord> {
  return toRecord(db, actor, await rowOf(db, actor, id));
}

export async function listEligibleAccounts(db: Kysely<Database>, actor: AccountingActor): Promise<{ accounts: unknown[]; restrictions: string[] }> {
  const rows = await db.selectFrom('accounts').selectAll().where('organization_id', '=', actor.organizationId)
    .where('active', '=', true).where('is_postable', '=', true).where('blocked', '=', false).where('archived', '=', false)
    .orderBy('account_code', 'asc').execute();
  const accounts: unknown[] = [];
  const restrictions = new Set<string>();
  for (const account of rows) {
    if (!['asset', 'liability', 'equity'].includes(account.account_type.toLowerCase())) continue;
    const child = await db.selectFrom('accounts').select('id').where('organization_id', '=', actor.organizationId)
      .where('parent_account_id', '=', account.id).executeTakeFirst();
    if (child) continue;
    const restriction = isControlAccount(account);
    if (restriction) { restrictions.add(restriction); continue; }
    accounts.push({ id: account.id, code: account.account_code, name: account.account_name, type: account.account_type, subtype: account.account_subtype, normalBalance: account.normal_balance, currency: account.restricted_currency });
  }
  return { accounts, restrictions: [...restrictions] };
}

function isControlAccount(account: { account_name: string; account_subtype: string | null }): string | null {
  const text = `${account.account_subtype ?? ''} ${account.account_name}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  if (/accounts? receivable|trade receivable|customer control/.test(text)) return 'Accounts Receivable opening details require the customer subledger workflow.';
  if (/accounts? payable|trade payable|supplier control/.test(text)) return 'Accounts Payable opening details require the supplier subledger workflow.';
  if (/inventory|stock control/.test(text)) return 'Inventory opening value must be posted through item and warehouse valuation.';
  if (/fixed asset|property plant|accumulated depreciation/.test(text)) return 'Fixed-asset opening value must be reconciled through the asset register.';
  return null;
}

async function validateOpeningJournal(executor: Executor, actor: AccountingActor, journal: journals.JournalRecord): Promise<void> {
  if (journal.sourceType !== 'opening_balance') throw errors.conflict('The linked journal is not an opening-balance journal.');
  const lines = journal.lines.filter((line) => !Money.isZero(Money.toAmount(line.debit)) || !Money.isZero(Money.toAmount(line.credit)));
  if (lines.length < 2) throw errors.validation('Opening balances need at least two non-zero account lines.');
  let debit = Money.ZERO;
  let credit = Money.ZERO;
  for (const line of lines) {
    const account = await executor.selectFrom('accounts').selectAll()
      .where('organization_id', '=', actor.organizationId).where('id', '=', line.accountId).executeTakeFirst();
    if (!account) throw errors.validation(`Line ${line.lineNumber}: the account does not exist in this organization.`);
    const hasChildren = Boolean(await executor.selectFrom('accounts').select('id')
      .where('organization_id', '=', actor.organizationId).where('parent_account_id', '=', account.id).executeTakeFirst());
    const eligibility = assessPostingAccount({
      id: account.id, accountCode: account.account_code, accountName: account.account_name,
      accountType: account.account_type as 'asset' | 'liability' | 'equity' | 'income' | 'expense', accountSubtype: account.account_subtype,
      normalBalance: account.normal_balance as 'debit' | 'credit', parentAccountId: account.parent_account_id,
      restrictedCurrency: account.restricted_currency, isPostable: account.is_postable, active: account.active,
      blocked: account.blocked, archived: account.archived, systemAccount: account.system_account,
    }, hasChildren);
    if (!eligibility.eligible) throw errors.validation(`Line ${line.lineNumber}: ${eligibility.message}`);
    if (!['asset', 'liability', 'equity'].includes(account.account_type.toLowerCase())) {
      throw errors.validation(`Line ${line.lineNumber}: opening balances initially support only asset, liability and equity accounts.`);
    }
    const restriction = isControlAccount(account);
    if (restriction) throw errors.validation(`Line ${line.lineNumber}: ${restriction}`);
    debit = Money.add(debit, Money.toAmount(line.debitFunctional));
    credit = Money.add(credit, Money.toAmount(line.creditFunctional));
  }
  if (!Money.equals(debit, credit)) throw errors.validation('Total opening-balance debits must equal total credits exactly.');
}

function journalInput(id: string, dates: { start: string; opening: string }, input: OpeningBalanceInput): journals.JournalInput {
  return {
    transactionDate: dates.opening, postingDate: dates.opening,
    reference: input.reference ?? `OPENING-${dates.start}`,
    description: input.description ?? `Opening balances before Ledgora bookkeeping begins on ${dates.start}`,
    notes: 'Initial company migration opening balances.', journalType: 'opening_balance',
    sourceType: 'opening_balance', sourceId: id, lines: input.lines ?? [],
  };
}

export async function createOrLoadDraft(db: Kysely<Database>, actor: AccountingActor, input: OpeningBalanceInput): Promise<OpeningBalanceRecord> {
  const existing = await getCurrent(db, actor);
  if (existing && existing.status !== 'reversed') return existing;
  const dates = resolveDates(input);
  const id = randomUUID();
  const journal = await journals.createDraft(db, actor, journalInput(id, dates, input), {
    afterVersion: async (trx, created) => {
      await trx.insertInto('opening_balance_sets').values({
        id, organization_id: actor.organizationId, journal_entry_id: created.id,
        bookkeeping_start_date: dates.start, opening_balance_date: dates.opening,
        reference: input.reference ?? `OPENING-${dates.start}`, description: input.description ?? '',
        prepared_by: actor.userId,
      }).execute();
      await writeAccountingAudit(trx, actor, { action: 'OPENING_BALANCE_CREATED', recordType: 'opening_balance', recordId: id, resultingVersion: 1, detail: { journalId: created.id, bookkeepingStartDate: dates.start, openingBalanceDate: dates.opening } });
    },
  });
  return toRecord(db, actor, { ...(await rowOf(db, actor, id)), journal_entry_id: journal.id });
}

export async function updateDraft(db: Kysely<Database>, actor: AccountingActor, id: string, input: OpeningBalanceInput, expectedVersion: number | undefined): Promise<OpeningBalanceRecord> {
  const row = await rowOf(db, actor, id);
  if (row.status !== 'draft') throw errors.conflict('Only a draft opening balance can be edited.');
  const dates = resolveDates(input);
  await journals.updateDraft(db, actor, row.journal_entry_id, journalInput(id, dates, input), { expectedVersion: (await journals.getJournal(db, actor, row.journal_entry_id)).version }, {
    afterVersion: async (trx) => {
      const result = await trx.updateTable('opening_balance_sets').set({
        bookkeeping_start_date: dates.start, opening_balance_date: dates.opening,
        reference: input.reference ?? '', description: input.description ?? '', version: row.version + 1, updated_at: new Date(),
      }).where('organization_id', '=', actor.organizationId).where('id', '=', id).where('status', '=', 'draft').where('version', '=', expectedVersion ?? -1).executeTakeFirst();
      if (result.numUpdatedRows !== 1n) throw errors.conflict(journals.CONCURRENCY_MESSAGE);
      await writeAccountingAudit(trx, actor, { action: 'OPENING_BALANCE_UPDATED', recordType: 'opening_balance', recordId: id, previousVersion: row.version, resultingVersion: row.version + 1 });
    },
  });
  return getById(db, actor, id);
}

async function transition(db: Kysely<Database>, actor: AccountingActor, id: string, expectedVersion: number | undefined, from: OpeningBalanceStatus, to: OpeningBalanceStatus, action: 'OPENING_BALANCE_SUBMITTED' | 'OPENING_BALANCE_APPROVED'): Promise<OpeningBalanceRecord> {
  return db.transaction().execute(async (trx) => {
    const row = await rowOf(trx, actor, id, true);
    if (row.version !== expectedVersion) throw errors.conflict(journals.CONCURRENCY_MESSAGE);
    if (row.status !== from) throw errors.conflict(`Only a ${from} opening balance can be ${to}.`);
    const journal = await journals.getJournal(trx as Kysely<Database>, actor, row.journal_entry_id);
    await validateOpeningJournal(trx, actor, journal);
    const now = new Date();
    await trx.updateTable('opening_balance_sets').set({ status: to, version: row.version + 1, updated_at: now,
      ...(to === 'submitted' ? { submitted_by: actor.userId, submitted_at: now } : { approved_by: actor.userId, approved_at: now }),
    }).where('organization_id', '=', actor.organizationId).where('id', '=', id).execute();
    await writeAccountingAudit(trx, actor, { action, recordType: 'opening_balance', recordId: id, previousVersion: row.version, resultingVersion: row.version + 1, detail: { journalId: journal.id } });
    return toRecord(trx, actor, await rowOf(trx, actor, id));
  });
}

export const submit = (db: Kysely<Database>, actor: AccountingActor, id: string, version?: number) => transition(db, actor, id, version, 'draft', 'submitted', 'OPENING_BALANCE_SUBMITTED');
export const approve = (db: Kysely<Database>, actor: AccountingActor, id: string, version?: number) => transition(db, actor, id, version, 'submitted', 'approved', 'OPENING_BALANCE_APPROVED');

export async function post(db: Kysely<Database>, actor: AccountingActor, id: string, expectedVersion?: number): Promise<OpeningBalanceRecord> {
  const row = await rowOf(db, actor, id);
  const journal = await journals.getJournal(db, actor, row.journal_entry_id);
  await journals.postJournal(db, actor, journal.id, { expectedVersion: journal.version }, {
    afterVersion: async (trx, posted) => {
      const locked = await rowOf(trx, actor, id, true);
      if (locked.version !== expectedVersion) throw errors.conflict(journals.CONCURRENCY_MESSAGE);
      if (locked.status !== 'approved') throw errors.conflict('Only an approved opening balance can be posted.');
      await validateOpeningJournal(trx, actor, posted);
      const now = new Date();
      await trx.updateTable('opening_balance_sets').set({ status: 'posted', version: locked.version + 1, posted_by: actor.userId, posted_at: now, updated_at: now })
        .where('organization_id', '=', actor.organizationId).where('id', '=', id).execute();
      await writeAccountingAudit(trx, actor, { action: 'OPENING_BALANCE_POSTED', recordType: 'opening_balance', recordId: id, previousVersion: locked.version, resultingVersion: locked.version + 1, detail: { journalId: posted.id } });
    },
  });
  return getById(db, actor, id);
}

export async function reverse(db: Kysely<Database>, actor: AccountingActor, id: string, expectedVersion: number | undefined, reason: string | undefined): Promise<OpeningBalanceRecord> {
  const row = await rowOf(db, actor, id);
  if (row.status !== 'posted') throw errors.conflict('Only posted opening balances can be reversed.');
  const journal = await journals.getJournal(db, actor, row.journal_entry_id);
  await journals.reverseJournal(db, actor, journal.id, { expectedVersion: journal.version, reason }, {
    afterReversal: async (trx, _withdrawn, reversal) => {
      const locked = await rowOf(trx, actor, id, true);
      if (locked.version !== expectedVersion || locked.status !== 'posted') throw errors.conflict(journals.CONCURRENCY_MESSAGE);
      const now = new Date();
      await trx.updateTable('opening_balance_sets').set({ status: 'reversed', version: locked.version + 1, reversed_by: actor.userId, reversed_at: now, reversal_journal_entry_id: reversal.id, updated_at: now })
        .where('organization_id', '=', actor.organizationId).where('id', '=', id).execute();
      await writeAccountingAudit(trx, actor, { action: 'OPENING_BALANCE_REVERSED', recordType: 'opening_balance', recordId: id, reason: reason ?? '', previousVersion: locked.version, resultingVersion: locked.version + 1 });
    },
  });
  return getById(db, actor, id);
}

export async function createReplacement(
  db: Kysely<Database>, actor: AccountingActor, reversedId: string, input: OpeningBalanceInput,
): Promise<OpeningBalanceRecord> {
  const original = await rowOf(db, actor, reversedId);
  if (original.status !== 'reversed') throw errors.conflict('A replacement can be created only after the original opening balance is reversed.');
  const active = await db.selectFrom('opening_balance_sets').select('id')
    .where('organization_id', '=', actor.organizationId).where('status', 'in', ['draft', 'submitted', 'approved', 'posted']).executeTakeFirst();
  if (active) throw errors.conflict('An active opening-balance set already exists for this company.');
  const dates = resolveDates(input);
  const id = randomUUID();
  await journals.createDraft(db, actor, journalInput(id, dates, input), {
    afterVersion: async (trx, created) => {
      await trx.insertInto('opening_balance_sets').values({
        id, organization_id: actor.organizationId, journal_entry_id: created.id,
        bookkeeping_start_date: dates.start, opening_balance_date: dates.opening,
        reference: input.reference ?? `OPENING-${dates.start}`, description: input.description ?? '',
        prepared_by: actor.userId, replaces_opening_balance_id: original.id,
      }).execute();
      await writeAccountingAudit(trx, actor, {
        action: 'OPENING_BALANCE_REPLACEMENT_CREATED', recordType: 'opening_balance', recordId: id,
        resultingVersion: 1, detail: { replacesOpeningBalanceId: original.id, journalId: created.id },
      });
    },
  });
  return getById(db, actor, id);
}

export async function auditHistory(db: Kysely<Database>, actor: AccountingActor, id: string): Promise<unknown[]> {
  await rowOf(db, actor, id);
  return db.selectFrom('accounting_audit_events').selectAll().where('organization_id', '=', actor.organizationId)
    .where('record_type', '=', 'opening_balance').where('record_id', '=', id).orderBy('at', 'asc').execute();
}

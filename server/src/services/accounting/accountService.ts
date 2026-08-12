/**
 * The Chart of Accounts, server-authoritative.
 *
 * ══ Organization scoping ═════════════════════════════════════════════════════
 *
 * Every function takes an {@link AccountingActor} whose `organizationId` came
 * from the caller's MEMBERSHIP, never from a request body, and every query
 * filters on it. An id alone is not authority: asking for another tenant's
 * account by uuid returns "not found", identical to asking for one that does
 * not exist, so the API cannot be used to probe which ids are real.
 *
 * ══ Accounts are deactivated, not deleted ════════════════════════════════════
 *
 * Once a journal line references an account, the account is part of history and
 * must keep resolving forever — a general ledger whose account names have gone
 * missing is not a ledger. `deleteAccount` therefore refuses as soon as any
 * line points at it and directs the caller to deactivate instead. The database
 * enforces this too (`ON DELETE RESTRICT`), so a future query that forgets is
 * still refused.
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import { writeAccountingAudit, type AccountingActor } from './audit.js';

type Executor = Kysely<Database> | Transaction<Database>;

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type NormalBalance = 'debit' | 'credit';

export interface AccountRecord {
  id: string;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  accountSubtype: string | null;
  normalBalance: NormalBalance;
  parentAccountId: string | null;
  restrictedCurrency: string | null;
  isPostable: boolean;
  active: boolean;
  systemAccount: boolean;
}

export interface CreateAccountInput {
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  accountSubtype?: string | null;
  normalBalance?: NormalBalance;
  parentAccountId?: string | null;
  restrictedCurrency?: string | null;
  isPostable?: boolean;
  systemAccount?: boolean;
}

export type UpdateAccountInput = Partial<Omit<CreateAccountInput, 'accountCode'>> & {
  accountCode?: string;
  active?: boolean;
};

/** The side an account normally increases on, when the caller does not say. */
const DEFAULT_NORMAL_BALANCE: Record<AccountType, NormalBalance> = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  income: 'credit',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRecord(row: any): AccountRecord {
  return {
    id: row.id,
    accountCode: row.account_code,
    accountName: row.account_name,
    accountType: row.account_type,
    accountSubtype: row.account_subtype,
    normalBalance: row.normal_balance,
    parentAccountId: row.parent_account_id,
    restrictedCurrency: row.restricted_currency,
    isPostable: row.is_postable,
    active: row.active,
    systemAccount: row.system_account,
  };
}

export async function listAccounts(
  db: Executor,
  actor: AccountingActor,
  options: { includeInactive?: boolean } = {},
): Promise<AccountRecord[]> {
  let query = db
    .selectFrom('accounts')
    .selectAll()
    .where('organization_id', '=', actor.organizationId);
  if (!options.includeInactive) query = query.where('active', '=', true);
  const rows = await query.orderBy('account_code').execute();
  return rows.map(toRecord);
}

/**
 * One account, or a 404.
 *
 * Deliberately the SAME error for "belongs to another tenant" and "does not
 * exist". Distinguishing them would turn this endpoint into an oracle for
 * whether a given uuid is a real account somewhere in the system.
 */
export async function getAccount(
  db: Executor,
  actor: AccountingActor,
  accountId: string,
): Promise<AccountRecord> {
  const row = await db
    .selectFrom('accounts')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('id', '=', accountId)
    .executeTakeFirst();
  if (!row) throw errors.notFound('Account');
  return toRecord(row);
}

/** Resolve ids to accounts, refusing any that is not this organization's. */
export async function loadAccountsForPosting(
  db: Executor,
  organizationId: string,
  accountIds: readonly string[],
): Promise<Map<string, AccountRecord>> {
  if (accountIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('accounts')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('id', 'in', [...new Set(accountIds)])
    .execute();
  return new Map(rows.map((row) => [row.id, toRecord(row)]));
}

async function assertParentIsUsable(
  db: Executor,
  organizationId: string,
  parentAccountId: string | null | undefined,
  selfId?: string,
): Promise<void> {
  if (!parentAccountId) return;
  if (selfId && parentAccountId === selfId) {
    throw errors.validation('An account cannot be its own parent.');
  }
  const parent = await db
    .selectFrom('accounts')
    .select(['id', 'is_postable', 'parent_account_id'])
    .where('organization_id', '=', organizationId)
    .where('id', '=', parentAccountId)
    .executeTakeFirst();
  // Cross-tenant parents surface as "not found" for the reason above.
  if (!parent) throw errors.validation('The parent account does not exist in this organization.');
  if (parent.is_postable) {
    throw errors.validation('A postable account cannot have children. Make the parent a header account first.');
  }

  /*
   * Walk up to the root. A cycle would make the hierarchy infinite and every
   * report that recurses through it hang, so it is refused here as well as
   * being unreachable through the composite foreign key.
   */
  if (selfId) {
    const seen = new Set<string>([selfId]);
    let cursor: string | null = parent.parent_account_id;
    while (cursor) {
      if (seen.has(cursor)) throw errors.validation('That parent would create a cycle in the account hierarchy.');
      seen.add(cursor);
      const next: { parent_account_id: string | null } | undefined = await db
        .selectFrom('accounts')
        .select('parent_account_id')
        .where('organization_id', '=', organizationId)
        .where('id', '=', cursor)
        .executeTakeFirst();
      cursor = next?.parent_account_id ?? null;
    }
  }
}

export async function createAccount(
  db: Kysely<Database>,
  actor: AccountingActor,
  input: CreateAccountInput,
): Promise<AccountRecord> {
  const code = input.accountCode.trim();
  const name = input.accountName.trim();
  if (!code) throw errors.validation('An account code is required.');
  if (!name) throw errors.validation('An account name is required.');

  return db.transaction().execute(async (trx) => {
    await assertParentIsUsable(trx, actor.organizationId, input.parentAccountId);

    const duplicate = await trx
      .selectFrom('accounts')
      .select('id')
      .where('organization_id', '=', actor.organizationId)
      .where('account_code', '=', code)
      .executeTakeFirst();
    if (duplicate) throw errors.conflict(`Account code "${code}" already exists in this organization.`);

    const row = await trx
      .insertInto('accounts')
      .values({
        organization_id: actor.organizationId,
        account_code: code,
        account_name: name,
        account_type: input.accountType,
        account_subtype: input.accountSubtype ?? null,
        normal_balance: input.normalBalance ?? DEFAULT_NORMAL_BALANCE[input.accountType],
        parent_account_id: input.parentAccountId ?? null,
        restricted_currency: input.restrictedCurrency ?? null,
        is_postable: input.isPostable ?? true,
        system_account: input.systemAccount ?? false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeAccountingAudit(trx, actor, {
      action: 'ACCOUNT_CREATED',
      recordType: 'account',
      recordId: row.id,
      detail: { accountCode: code, accountName: name, accountType: input.accountType },
    });

    return toRecord(row);
  });
}

export async function updateAccount(
  db: Kysely<Database>,
  actor: AccountingActor,
  accountId: string,
  input: UpdateAccountInput,
): Promise<AccountRecord> {
  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('accounts')
      .selectAll()
      .where('organization_id', '=', actor.organizationId)
      .where('id', '=', accountId)
      .executeTakeFirst();
    if (!existing) throw errors.notFound('Account');

    if (input.parentAccountId !== undefined) {
      await assertParentIsUsable(trx, actor.organizationId, input.parentAccountId, accountId);
    }

    if (input.accountCode !== undefined && input.accountCode.trim() !== existing.account_code) {
      const code = input.accountCode.trim();
      if (!code) throw errors.validation('An account code is required.');
      const clash = await trx
        .selectFrom('accounts')
        .select('id')
        .where('organization_id', '=', actor.organizationId)
        .where('account_code', '=', code)
        .executeTakeFirst();
      if (clash) throw errors.conflict(`Account code "${code}" already exists in this organization.`);
    }

    /*
     * Turning a header into a postable account is fine; the reverse is not once
     * it has children, because a postable account may not have any.
     */
    if (input.isPostable === true) {
      const child = await trx
        .selectFrom('accounts')
        .select('id')
        .where('organization_id', '=', actor.organizationId)
        .where('parent_account_id', '=', accountId)
        .executeTakeFirst();
      if (child) throw errors.validation('This account has children and cannot be made postable.');
    }

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (input.accountCode !== undefined) patch.account_code = input.accountCode.trim();
    if (input.accountName !== undefined) patch.account_name = input.accountName.trim();
    if (input.accountType !== undefined) patch.account_type = input.accountType;
    if (input.accountSubtype !== undefined) patch.account_subtype = input.accountSubtype;
    if (input.normalBalance !== undefined) patch.normal_balance = input.normalBalance;
    if (input.parentAccountId !== undefined) patch.parent_account_id = input.parentAccountId;
    if (input.restrictedCurrency !== undefined) patch.restricted_currency = input.restrictedCurrency;
    if (input.isPostable !== undefined) patch.is_postable = input.isPostable;
    if (input.active !== undefined) patch.active = input.active;

    const row = await trx
      .updateTable('accounts')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set(patch as any)
      .where('organization_id', '=', actor.organizationId)
      .where('id', '=', accountId)
      .returningAll()
      .executeTakeFirstOrThrow();

    const deactivated = input.active === false && existing.active;
    const reactivated = input.active === true && !existing.active;
    await writeAccountingAudit(trx, actor, {
      action: deactivated ? 'ACCOUNT_DEACTIVATED' : reactivated ? 'ACCOUNT_REACTIVATED' : 'ACCOUNT_UPDATED',
      recordType: 'account',
      recordId: accountId,
      detail: { changed: Object.keys(patch).filter((k) => k !== 'updated_at') },
    });

    return toRecord(row);
  });
}

/**
 * Delete an account that has never been used.
 *
 * Refuses the moment a journal line references it, and says what to do instead.
 * A system account is never deletable at all: Ledgora created it because some
 * posting path depends on it existing.
 */
export async function deleteAccount(
  db: Kysely<Database>,
  actor: AccountingActor,
  accountId: string,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('accounts')
      .select(['id', 'system_account', 'account_code'])
      .where('organization_id', '=', actor.organizationId)
      .where('id', '=', accountId)
      .executeTakeFirst();
    if (!existing) throw errors.notFound('Account');
    if (existing.system_account) {
      throw errors.conflict('This is a system account and cannot be deleted. Deactivate it instead.');
    }

    const used = await trx
      .selectFrom('journal_lines')
      .select('id')
      .where('organization_id', '=', actor.organizationId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    if (used) {
      throw errors.conflict(
        'This account is referenced by journal entries and cannot be deleted. Deactivate it instead so historical reports keep resolving.',
      );
    }

    const child = await trx
      .selectFrom('accounts')
      .select('id')
      .where('organization_id', '=', actor.organizationId)
      .where('parent_account_id', '=', accountId)
      .executeTakeFirst();
    if (child) throw errors.conflict('This account has children. Remove or re-parent them first.');

    await trx
      .deleteFrom('accounts')
      .where('organization_id', '=', actor.organizationId)
      .where('id', '=', accountId)
      .execute();

    await writeAccountingAudit(trx, actor, {
      action: 'ACCOUNT_DEACTIVATED',
      recordType: 'account',
      recordId: accountId,
      detail: { deleted: true, accountCode: existing.account_code },
    });
  });
}

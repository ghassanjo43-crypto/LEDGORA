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

/**
 * The controlled cash vocabulary.
 *
 * The cash-flow section reads THIS, never a name or a free-text subtype. A
 * classification that can be changed by renaming a label is not a
 * classification, and a statement that turns on spelling is not one either.
 */
export const CASH_CLASSIFICATIONS = [
  'none',
  'cash_and_cash_equivalents',
  'restricted_cash',
  'bank_overdraft',
] as const;
export type CashClassification = (typeof CASH_CLASSIFICATIONS)[number];

export const PRESENTATION_TYPES = [
  'ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'COST_OF_SALES', 'OPERATING_EXPENSE',
  'OTHER_INCOME_EXPENSE', 'FINANCE', 'TAX', 'DISCONTINUED_OPERATIONS', 'OCI', 'CONTROL',
] as const;

export const IFRS_STATEMENTS = [
  'STATEMENT_OF_FINANCIAL_POSITION', 'PROFIT_OR_LOSS', 'OCI',
  'STATEMENT_OF_CHANGES_IN_EQUITY', 'CASH_FLOW', 'NOTES', 'CONTROL',
] as const;

export const CASH_FLOW_CATEGORIES = [
  'OPERATING', 'INVESTING', 'FINANCING', 'NON_CASH', 'NOT_APPLICABLE',
] as const;

export const PROFIT_OR_LOSS_CATEGORIES = [
  'OPERATING', 'INVESTING', 'FINANCING', 'INCOME_TAXES', 'DISCONTINUED_OPERATIONS', 'NOT_APPLICABLE',
] as const;

/**
 * Which of the ledger's five types each presentation class posts as.
 *
 * The pairing is not a preference. `presentation_type` is what the chart of
 * accounts screen reads back and `account_type` is what every statement is
 * aggregated by, so an account presented as a finance cost and posted as an
 * asset would appear in one place on the screen and on the opposite side of the
 * balance sheet. Storing that combination is refused rather than displayed.
 *
 * The three that could fall either way are recorded as `income` because their
 * normal balance is a credit; a debit against an income-type account is what a
 * loss IS, and it posts correctly. `CONTROL` is a bookkeeping device with a
 * debit balance, so `asset`.
 */
const PRESENTATION_LEDGER_TYPE: Record<string, AccountType> = {
  ASSET: 'asset',
  LIABILITY: 'liability',
  EQUITY: 'equity',
  INCOME: 'income',
  COST_OF_SALES: 'expense',
  OPERATING_EXPENSE: 'expense',
  FINANCE: 'expense',
  TAX: 'expense',
  OTHER_INCOME_EXPENSE: 'income',
  OCI: 'income',
  DISCONTINUED_OPERATIONS: 'income',
  CONTROL: 'asset',
};

/** The presentation fields, which travel together and validate together. */
export interface AccountPresentation {
  presentationType: string;
  ifrsStatement: string;
  ifrsCategory: string;
  ifrsSubcategory: string;
  cashFlowCategory: string;
  profitOrLossCategory: string;
  description: string;
  industryTag: string;
}

export interface AccountRecord extends AccountPresentation {
  id: string;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  accountSubtype: string | null;
  cashClassification: CashClassification;
  normalBalance: NormalBalance;
  parentAccountId: string | null;
  restrictedCurrency: string | null;
  sortOrder: number;
  isPostable: boolean;
  active: boolean;
  blocked: boolean;
  archived: boolean;
  systemAccount: boolean;
  hasChildren?: boolean;
}

export interface CreateAccountInput extends Partial<AccountPresentation> {
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  accountSubtype?: string | null;
  cashClassification?: string | null;
  normalBalance?: NormalBalance;
  parentAccountId?: string | null;
  restrictedCurrency?: string | null;
  sortOrder?: number;
  isPostable?: boolean;
  active?: boolean;
  blocked?: boolean;
  archived?: boolean;
  systemAccount?: boolean;
}

export type UpdateAccountInput = Partial<Omit<CreateAccountInput, 'accountCode'>> & {
  accountCode?: string;
  active?: boolean;
};

/* ══ Controlled vocabularies ═══════════════════════════════════════════════ */

/**
 * One enumerated field, or a refusal that names what was offered.
 *
 * Empty means "no opinion" and is always allowed; a WRONG value is never
 * silently dropped to empty, because an account stored with no classification
 * when the caller asked for one is the same lie as storing the wrong one.
 */
function enumerated(
  label: string,
  allowed: readonly string[],
  value: string | null | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return '';
  if (!allowed.includes(trimmed)) {
    throw errors.validation(
      `"${trimmed}" is not a recognised ${label}. Choose one of: ${allowed.join(', ')}.`,
    );
  }
  return trimmed;
}

/**
 * Refuse a presentation class that contradicts the ledger type.
 *
 * Checked against the account's FINAL type, so changing the type of a
 * classified account is caught as readily as classifying it wrongly to begin
 * with.
 */
function assertPresentationFits(presentationType: string, accountType: AccountType): void {
  if (!presentationType) return;
  const expected = PRESENTATION_LEDGER_TYPE[presentationType];
  if (expected && expected !== accountType) {
    throw errors.validation(
      `A ${presentationType} account is posted as ${expected} in the ledger, not as ${accountType}. `
      + 'Change both together, or leave the presentation unset.',
    );
  }
}

/**
 * Whether a cash classification can be true of this account AT ALL.
 *
 * Checked against the account's FINAL state rather than the patch, so changing
 * a classified cash account into an expense — or into a header — is refused
 * instead of leaving a row the database would then reject anyway. Producing the
 * constraint's message would name a constraint; producing this one names the
 * accounting rule the caller broke.
 */
function assertCashClassificationFits(
  classification: CashClassification,
  accountType: AccountType,
  isPostable: boolean,
): void {
  if (classification === 'none') return;
  if (!isPostable) {
    throw errors.validation(
      'Only a posting account can be classified as cash. A header account carries no balance of '
      + 'its own, and classifying both a parent and its child would count the same money twice.',
    );
  }
  const wantsAsset = classification === 'cash_and_cash_equivalents' || classification === 'restricted_cash';
  if (wantsAsset && accountType !== 'asset') {
    throw errors.validation(`A ${classification.replace(/_/g, ' ')} account must be an asset.`);
  }
  if (classification === 'bank_overdraft' && accountType !== 'liability') {
    throw errors.validation('A bank overdraft is a liability, so it must be a liability account.');
  }
}

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
    cashClassification: (row.cash_classification ?? 'none') as CashClassification,
    normalBalance: row.normal_balance,
    parentAccountId: row.parent_account_id,
    restrictedCurrency: row.restricted_currency,
    sortOrder: row.sort_order ?? 0,
    presentationType: row.presentation_type ?? '',
    ifrsStatement: row.ifrs_statement ?? '',
    ifrsCategory: row.ifrs_category ?? '',
    ifrsSubcategory: row.ifrs_subcategory ?? '',
    cashFlowCategory: row.cash_flow_category ?? '',
    profitOrLossCategory: row.profit_or_loss_category ?? '',
    description: row.description ?? '',
    industryTag: row.industry_tag ?? '',
    isPostable: row.is_postable,
    active: row.active,
    blocked: row.blocked,
    archived: row.archived,
    systemAccount: row.system_account,
  };
}

/** The enumerated fields of a patch, validated together. */
function presentationPatch(input: Partial<AccountPresentation>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const presentationType = enumerated('account presentation type', PRESENTATION_TYPES, input.presentationType);
  if (presentationType !== undefined) patch.presentation_type = presentationType;
  const ifrsStatement = enumerated('IFRS statement', IFRS_STATEMENTS, input.ifrsStatement);
  if (ifrsStatement !== undefined) patch.ifrs_statement = ifrsStatement;
  const cashFlowCategory = enumerated('cash-flow category', CASH_FLOW_CATEGORIES, input.cashFlowCategory);
  if (cashFlowCategory !== undefined) patch.cash_flow_category = cashFlowCategory;
  const profitOrLoss = enumerated('profit-or-loss category', PROFIT_OR_LOSS_CATEGORIES, input.profitOrLossCategory);
  if (profitOrLoss !== undefined) patch.profit_or_loss_category = profitOrLoss;
  if (input.ifrsCategory !== undefined) patch.ifrs_category = (input.ifrsCategory ?? '').trim();
  if (input.ifrsSubcategory !== undefined) patch.ifrs_subcategory = (input.ifrsSubcategory ?? '').trim();
  if (input.description !== undefined) patch.description = (input.description ?? '').trim();
  if (input.industryTag !== undefined) patch.industry_tag = (input.industryTag ?? '').trim();
  return patch;
}

export async function listAccounts(
  db: Executor,
  actor: AccountingActor,
  options: { includeInactive?: boolean } = {},
): Promise<AccountRecord[]> {
  let query = db
    .selectFrom('accounts')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId);
  if (!options.includeInactive) query = query.where('active', '=', true);
  /*
   * Sibling order first, code second. The code alone was a stable order but not
   * the CHOSEN one, and a chart of accounts is arranged deliberately. Ties fall
   * back to the code so the result is total either way — two accounts sharing a
   * sort order still come back in the same sequence on every request, which is
   * what a hydrating client compares against.
   */
  const rows = await query.orderBy('sort_order').orderBy('account_code').execute();
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
    .where('company_id', '=', actor.companyId)
    .where('id', '=', accountId)
    .executeTakeFirst();
  if (!row) throw errors.notFound('Account');
  return toRecord(row);
}

/**
 * Resolve ids to accounts, refusing any that is not THIS COMPANY'S.
 *
 * Scoped by company as well as organization, so an id belonging to a sibling
 * company under the same subscriber simply does not resolve. The caller reports
 * it as "no such account", which is the honest answer: there is no such account
 * in these books. The composite foreign key would refuse the posting anyway —
 * this is what turns that constraint violation into a readable message.
 */
export async function loadAccountsForPosting(
  db: Executor,
  organizationId: string,
  companyId: string,
  accountIds: readonly string[],
): Promise<Map<string, AccountRecord>> {
  if (accountIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('accounts')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('company_id', '=', companyId)
    .where('id', 'in', [...new Set(accountIds)])
    .execute();
  const children = await db
    .selectFrom('accounts')
    .select('parent_account_id')
    .where('organization_id', '=', organizationId)
    .where('company_id', '=', companyId)
    .where('parent_account_id', 'in', rows.map((row) => row.id))
    .execute();
  const parentIds = new Set(children.map((row) => row.parent_account_id).filter(Boolean));
  return new Map(rows.map((row) => [row.id, { ...toRecord(row), hasChildren: parentIds.has(row.id) }]));
}

/** One past the last sibling, so a new account lands at the end of its group. */
async function nextSortOrder(
  db: Executor,
  actor: AccountingActor,
  parentAccountId: string | null,
): Promise<number> {
  let query = db
    .selectFrom('accounts')
    .select('sort_order')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId);
  query = parentAccountId
    ? query.where('parent_account_id', '=', parentAccountId)
    : query.where('parent_account_id', 'is', null);
  const siblings = await query.execute();
  return siblings.reduce((max, row) => Math.max(max, row.sort_order ?? 0), -1) + 1;
}

async function assertParentIsUsable(
  db: Executor,
  organizationId: string,
  companyId: string,
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
    .where('company_id', '=', companyId)
    .where('id', '=', parentAccountId)
    .executeTakeFirst();
  /*
   * A parent in another COMPANY surfaces as "not found", exactly as a
   * cross-tenant one does. The composite foreign key would refuse the row
   * anyway; this makes the refusal a sentence rather than a constraint name.
   */
  if (!parent) throw errors.validation('The parent account does not exist in this company.');
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
        .where('company_id', '=', companyId)
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
  const active = input.active ?? !input.archived;
  const archived = input.archived ?? false;
  if (active && archived) throw errors.validation('An archived account cannot be active.');

  const isPostable = input.isPostable ?? true;
  const cashClassification = (enumerated(
    'cash classification', CASH_CLASSIFICATIONS, input.cashClassification,
  ) || 'none') as CashClassification;
  assertCashClassificationFits(cashClassification, input.accountType, isPostable);
  assertPresentationFits((input.presentationType ?? '').trim(), input.accountType);

  return db.transaction().execute(async (trx) => {
    await assertParentIsUsable(trx, actor.organizationId, actor.companyId, input.parentAccountId);

    const duplicate = await trx
      .selectFrom('accounts')
      .select('id')
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('account_code', '=', code)
      .executeTakeFirst();
    if (duplicate) throw errors.conflict(`Account code "${code}" already exists in this organization.`);

    /*
     * Append to the parent's siblings when the caller does not choose a
     * position. Defaulting to 0 would put every new account first, which is the
     * opposite of what "add an account" means.
     */
    const sortOrder = input.sortOrder ?? (await nextSortOrder(trx, actor, input.parentAccountId ?? null));

    const row = await trx
      .insertInto('accounts')
      .values({
        organization_id: actor.organizationId,
        company_id: actor.companyId,
        account_code: code,
        account_name: name,
        account_type: input.accountType,
        account_subtype: input.accountSubtype ?? null,
        cash_classification: cashClassification,
        normal_balance: input.normalBalance ?? DEFAULT_NORMAL_BALANCE[input.accountType],
        parent_account_id: input.parentAccountId ?? null,
        restricted_currency: input.restrictedCurrency ?? null,
        sort_order: sortOrder,
        is_postable: isPostable,
        active,
        blocked: input.blocked ?? false,
        archived,
        system_account: input.systemAccount ?? false,
        ...presentationPatch(input),
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
      .where('company_id', '=', actor.companyId)
      .where('id', '=', accountId)
      .executeTakeFirst();
    if (!existing) throw errors.notFound('Account');

    const nextActive = input.active ?? existing.active;
    const nextArchived = input.archived ?? existing.archived;
    if (nextActive && nextArchived) {
      throw errors.validation('An archived account cannot be active. Unarchive it before reactivating it.');
    }

    if (input.parentAccountId !== undefined) {
      await assertParentIsUsable(trx, actor.organizationId, actor.companyId, input.parentAccountId, accountId);
    }

    if (input.accountCode !== undefined && input.accountCode.trim() !== existing.account_code) {
      const code = input.accountCode.trim();
      if (!code) throw errors.validation('An account code is required.');
      const clash = await trx
        .selectFrom('accounts')
        .select('id')
        .where('organization_id', '=', actor.organizationId)
        .where('company_id', '=', actor.companyId)
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
        .where('company_id', '=', actor.companyId)
        .where('parent_account_id', '=', accountId)
        .executeTakeFirst();
      if (child) throw errors.validation('This account has children and cannot be made postable.');
    }

    /*
     * The cash rules are checked against what the account WILL BE, not against
     * the patch. Changing a classified bank account's type to `expense` while
     * leaving the classification alone is exactly as wrong as classifying an
     * expense account as cash, and only the merged state can see it.
     */
    const nextType = (input.accountType ?? existing.account_type) as AccountType;
    const nextPostable = input.isPostable ?? existing.is_postable;
    const nextCash = (enumerated('cash classification', CASH_CLASSIFICATIONS, input.cashClassification)
      ?? existing.cash_classification ?? 'none') as CashClassification;
    assertCashClassificationFits(nextCash, nextType, nextPostable);

    const patch: Record<string, unknown> = { updated_at: new Date(), ...presentationPatch(input) };

    /*
     * A type change with NO presentation alongside it leaves the old class
     * behind — an account that becomes an expense while still presented as an
     * asset. Rather than refuse an otherwise reasonable request, the stale
     * class is cleared: the account then presents as whatever its ledger type
     * implies, which is true, instead of as something that is not.
     */
    if (input.accountType !== undefined && input.presentationType === undefined) {
      const current = existing.presentation_type ?? '';
      if (current && PRESENTATION_LEDGER_TYPE[current] !== nextType) patch.presentation_type = '';
    }
    assertPresentationFits(String(patch.presentation_type ?? existing.presentation_type ?? ''), nextType);
    if (input.cashClassification !== undefined) patch.cash_classification = nextCash;
    if (input.sortOrder !== undefined) patch.sort_order = input.sortOrder;
    if (input.accountCode !== undefined) patch.account_code = input.accountCode.trim();
    if (input.accountName !== undefined) patch.account_name = input.accountName.trim();
    if (input.accountType !== undefined) patch.account_type = input.accountType;
    if (input.accountSubtype !== undefined) patch.account_subtype = input.accountSubtype;
    if (input.normalBalance !== undefined) patch.normal_balance = input.normalBalance;
    if (input.parentAccountId !== undefined) patch.parent_account_id = input.parentAccountId;
    if (input.restrictedCurrency !== undefined) patch.restricted_currency = input.restrictedCurrency;
    if (input.isPostable !== undefined) patch.is_postable = input.isPostable;
    if (input.active !== undefined) patch.active = input.active;
    if (input.blocked !== undefined) patch.blocked = input.blocked;
    if (input.archived !== undefined) patch.archived = input.archived;

    const row = await trx
      .updateTable('accounts')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set(patch as any)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
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
      .where('company_id', '=', actor.companyId)
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
      .where('company_id', '=', actor.companyId)
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
      .where('company_id', '=', actor.companyId)
      .where('parent_account_id', '=', accountId)
      .executeTakeFirst();
    if (child) throw errors.conflict('This account has children. Remove or re-parent them first.');

    await trx
      .deleteFrom('accounts')
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
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

/**
 * Set the order of one parent's children, atomically.
 *
 * ══ Why a whole list and not "move this one up" ══════════════════════════════
 *
 * A swap is two updates, and two updates are two chances to end up with a chart
 * that is half reordered — the browser did this in a single synchronous
 * `set()`, where it could not be observed half-done, and the network cannot
 * offer that. Sending the intended sequence instead makes the operation
 * idempotent: replaying it produces the same chart, and a retry after a dropped
 * connection is safe rather than a second swap.
 *
 * ══ What it refuses ══════════════════════════════════════════════════════════
 *
 * The list must name exactly the children of that parent — no more, no fewer,
 * no duplicates. A partial list would leave the unnamed accounts holding stale
 * positions that collide with the new ones, and an order with collisions is not
 * an order. Naming an account from another parent (or another company) is
 * refused for the same reason it is refused everywhere else: it is not in these
 * books.
 */
export async function reorderAccounts(
  db: Kysely<Database>,
  actor: AccountingActor,
  parentAccountId: string | null,
  orderedIds: readonly string[],
): Promise<AccountRecord[]> {
  return db.transaction().execute(async (trx) => {
    let query = trx
      .selectFrom('accounts')
      .select('id')
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId);
    query = parentAccountId
      ? query.where('parent_account_id', '=', parentAccountId)
      : query.where('parent_account_id', 'is', null);
    const siblings = await query.execute();

    const present = new Set(siblings.map((row) => row.id));
    const requested = new Set(orderedIds);
    if (requested.size !== orderedIds.length) {
      throw errors.validation('The same account appears twice in the requested order.');
    }
    if (requested.size !== present.size || [...requested].some((id) => !present.has(id))) {
      throw errors.validation(
        'The requested order must list every account under this parent exactly once. '
        + 'Reload the chart of accounts and try again.',
      );
    }

    for (const [index, id] of orderedIds.entries()) {
      await trx
        .updateTable('accounts')
        .set({ sort_order: index, updated_at: new Date() })
        .where('organization_id', '=', actor.organizationId)
        .where('company_id', '=', actor.companyId)
        .where('id', '=', id)
        .execute();
    }

    await writeAccountingAudit(trx, actor, {
      action: 'ACCOUNT_UPDATED',
      recordType: 'account',
      /* Null for the roots: `record_id` is a uuid column, and there is no
       * account whose children these are. */
      recordId: parentAccountId,
      detail: { reordered: orderedIds.length, parentAccountId },
    });

    return listAccounts(trx, actor, { includeInactive: true });
  });
}

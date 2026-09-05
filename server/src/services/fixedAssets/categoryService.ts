/**
 * Asset categories — the accounting configuration an asset copies.
 *
 * ══ A category is a DEFAULT, never a live lookup ══════════════════════════════
 *
 * When an asset is created it FREEZES the category's method, useful life and
 * convention onto its own row. Nothing afterwards reads them back. That is the
 * whole reason those columns are duplicated on the asset: a bookkeeper who
 * shortens the default life for computers bought this year must not silently
 * re-price every computer bought in the last five, and a category edit that
 * could do so is indistinguishable from a bug once the depreciation is posted.
 *
 * The ACCOUNT mappings are deliberately NOT copied. They are not a policy the
 * asset carries; they are where this company's depreciation posts, and F2 will
 * freeze the trio onto each posting as it makes it — which is the point at
 * which "which account did this charge use" becomes a fact rather than a
 * setting. Until then there is nothing to freeze.
 *
 * ══ Saving a category posts nothing ══════════════════════════════════════════
 *
 * Creating, editing, archiving and reactivating a category write two rows: the
 * category and its audit event. No journal, no voucher, no ledger line. A
 * category is a statement about what WOULD be posted.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import {
  type FixedAssetActor,
  DEPRECIATION_METHODS,
  DEPRECIATION_CONVENTIONS,
  MAX_USEFUL_LIFE_MONTHS,
  REFUSED_CONVENTIONS,
  REFUSED_METHODS,
  asDuplicate,
  assertAccountForRole,
  assertVersion,
  decimalAmount,
  trimmed,
  writeFixedAssetAudit,
} from './fixedAssetCore.js';

export interface CategoryInput {
  code: string;
  name: string;
  description?: string;
  defaultMethod?: string;
  defaultUsefulLifeMonths?: number | null;
  defaultResidualPercent?: string | number | null;
  depreciationConvention?: string;
  assetCostAccountId?: string | null;
  accumulatedDepreciationAccountId?: string | null;
  depreciationExpenseAccountId?: string | null;
}

export interface CategoryRecord {
  id: string;
  code: string;
  name: string;
  description: string;
  defaultMethod: string;
  defaultUsefulLifeMonths: number | null;
  defaultResidualPercent: string;
  depreciationConvention: string;
  assetCostAccountId: string | null;
  accumulatedDepreciationAccountId: string | null;
  depreciationExpenseAccountId: string | null;
  /** Resolved for display, so a list does not have to join the chart itself. */
  assetCostAccountLabel: string;
  accumulatedDepreciationAccountLabel: string;
  depreciationExpenseAccountLabel: string;
  /** True when all three mappings are present. F2 will refuse to post without them. */
  mappingComplete: boolean;
  status: string;
  version: number;
  /** How many non-archived assets name this category. Drives the archive refusal. */
  activeAssetCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ListCategoriesQuery {
  status?: 'active' | 'archived';
  search?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const iso = (value: unknown): string | null =>
  (value instanceof Date ? value.toISOString() : (value as string | null) ?? null);

const label = (code: unknown, name: unknown): string =>
  (code ? `${String(code)} — ${String(name ?? '')}` : '');

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function hydrate(row: any): CategoryRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description ?? '',
    defaultMethod: row.default_method,
    defaultUsefulLifeMonths:
      row.default_useful_life_months === null ? null : Number(row.default_useful_life_months),
    defaultResidualPercent: String(row.default_residual_percent ?? '0'),
    depreciationConvention: row.depreciation_convention,
    assetCostAccountId: row.asset_cost_account_id ?? null,
    accumulatedDepreciationAccountId: row.accumulated_depreciation_account_id ?? null,
    depreciationExpenseAccountId: row.depreciation_expense_account_id ?? null,
    assetCostAccountLabel: label(row.cost_code, row.cost_name),
    accumulatedDepreciationAccountLabel: label(row.accum_code, row.accum_name),
    depreciationExpenseAccountLabel: label(row.expense_code, row.expense_name),
    mappingComplete: Boolean(
      row.asset_cost_account_id
      && row.accumulated_depreciation_account_id
      && row.depreciation_expense_account_id,
    ),
    status: row.status,
    version: Number(row.version),
    activeAssetCount: Number(row.active_asset_count ?? '0'),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/**
 * The category with its three account labels and its live asset count.
 *
 * The count is a sub-select rather than a stored column for the reason every
 * other count in this codebase is: a stored one is a second answer that drifts
 * the first time anything fails halfway.
 */
const selectCategories = (db: Kysely<Database>, actor: FixedAssetActor) => db
  .selectFrom('fixed_asset_categories as c')
  .leftJoin('accounts as cost', (join) => join
    .onRef('cost.id', '=', 'c.asset_cost_account_id')
    .onRef('cost.organization_id', '=', 'c.organization_id')
    .onRef('cost.company_id', '=', 'c.company_id'))
  .leftJoin('accounts as accum', (join) => join
    .onRef('accum.id', '=', 'c.accumulated_depreciation_account_id')
    .onRef('accum.organization_id', '=', 'c.organization_id')
    .onRef('accum.company_id', '=', 'c.company_id'))
  .leftJoin('accounts as expense', (join) => join
    .onRef('expense.id', '=', 'c.depreciation_expense_account_id')
    .onRef('expense.organization_id', '=', 'c.organization_id')
    .onRef('expense.company_id', '=', 'c.company_id'))
  .selectAll('c')
  .select([
    'cost.account_code as cost_code', 'cost.account_name as cost_name',
    'accum.account_code as accum_code', 'accum.account_name as accum_name',
    'expense.account_code as expense_code', 'expense.account_name as expense_name',
  ])
  .select((eb) => eb
    .selectFrom('fixed_assets as a')
    .select((inner) => inner.fn.countAll<string>().as('n'))
    .whereRef('a.category_id', '=', 'c.id')
    .whereRef('a.organization_id', '=', 'c.organization_id')
    .whereRef('a.company_id', '=', 'c.company_id')
    .where('a.status', '<>', 'archived')
    .as('active_asset_count'))
  .where('c.organization_id', '=', actor.organizationId)
  .where('c.company_id', '=', actor.companyId);

export async function listCategories(
  db: Kysely<Database>,
  actor: FixedAssetActor,
  query: ListCategoriesQuery = {},
): Promise<CategoryRecord[]> {
  let builder = selectCategories(db, actor);
  if (query.status) builder = builder.where('c.status', '=', query.status);
  if (query.search) {
    const term = `%${query.search.trim().toLowerCase()}%`;
    builder = builder.where((eb) => eb.or([
      eb(eb.fn('lower', ['c.code']), 'like', term),
      eb(eb.fn('lower', ['c.name']), 'like', term),
    ]));
  }
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const rows = await builder.orderBy('c.code', 'asc').limit(limit).execute();
  return rows.map(hydrate);
}

export async function getCategory(
  db: Kysely<Database>,
  actor: FixedAssetActor,
  id: string,
): Promise<CategoryRecord> {
  const row = await selectCategories(db, actor).where('c.id', '=', id).executeTakeFirst();
  if (!row) throw errors.notFound('Asset category');
  return hydrate(row);
}

export async function categoryHistory(
  db: Kysely<Database>,
  actor: FixedAssetActor,
  id: string,
): Promise<Array<Record<string, unknown>>> {
  await getCategory(db, actor, id);
  return readHistory(db, actor, 'category', id);
}

export async function readHistory(
  db: Kysely<Database>,
  actor: FixedAssetActor,
  subjectType: 'category' | 'asset',
  subjectId: string,
): Promise<Array<Record<string, unknown>>> {
  const rows = await db
    .selectFrom('fixed_asset_audit_events')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('subject_type', '=', subjectType)
    .where('subject_id', '=', subjectId)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    previousVersion: row.previous_version,
    resultingVersion: row.resulting_version,
    reason: row.reason,
    detail: typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail,
    /* The actor is the server's, taken from the session. A client-supplied one
     * never reaches this table — see the route schemas, which are `.strict()`. */
    actorName: row.actor_name,
    occurredAt: iso(row.created_at),
  }));
}

/* ── Validation ────────────────────────────────────────────────────────────── */

/** Every rule that does not need the database. Runs before the transaction opens. */
function assertShape(input: CategoryInput): void {
  const fieldErrors: Record<string, string> = {};

  if (!trimmed(input.code)) fieldErrors.code = 'A category code is required.';
  if (!trimmed(input.name)) fieldErrors.name = 'A category name is required.';

  const method = input.defaultMethod ?? 'straight_line';
  if (!(DEPRECIATION_METHODS as readonly string[]).includes(method)) {
    /* Named refusals first: a real method this product has not established gets
     * the sentence that says which piece is missing. */
    const refusal = REFUSED_METHODS[method];
    throw errors.validation(
      refusal
      ?? `"${method}" is not a depreciation method this product implements. Choose straight line, `
        + 'or none for assets such as land that do not depreciate.',
      { fieldErrors: { defaultMethod: 'Choose straight line, or none.' } },
    );
  }

  const convention = input.depreciationConvention ?? 'full_month';
  if (!(DEPRECIATION_CONVENTIONS as readonly string[]).includes(convention)) {
    const refusal = REFUSED_CONVENTIONS[convention];
    throw errors.validation(
      refusal
      ?? `"${convention}" is not a depreciation convention this product implements. It prorates in `
        + 'whole calendar months, counting the month depreciation starts in full.',
      { fieldErrors: { depreciationConvention: 'Choose the full-month convention.' } },
    );
  }

  const life = input.defaultUsefulLifeMonths ?? null;
  if (method === 'none') {
    if (life !== null && life !== 0) {
      fieldErrors.defaultUsefulLifeMonths =
        'An asset that does not depreciate has no useful life to state. Leave it blank.';
    }
  } else if (life === null || !Number.isInteger(life) || life < 1) {
    fieldErrors.defaultUsefulLifeMonths =
      `A default useful life is required, in MONTHS, and must be at least 1. `
      + 'This product measures useful life in months everywhere; it does not convert years.';
  } else if (life > MAX_USEFUL_LIFE_MONTHS) {
    fieldErrors.defaultUsefulLifeMonths =
      `A useful life of ${life} months is longer than the ${MAX_USEFUL_LIFE_MONTHS}-month `
      + '(100-year) limit these books accept.';
  }

  if (Object.keys(fieldErrors).length) {
    throw errors.validation('Check the category details and try again.', { fieldErrors });
  }
}

/** The percentage, checked as an exact decimal rather than a float. */
function residualPercent(input: CategoryInput): string {
  const text = decimalAmount(
    input.defaultResidualPercent, 'defaultResidualPercent', 'default residual percentage',
  );
  /* Compared as a decimal string would be fragile; the value is bounded and
   * small, so a numeric comparison here is safe and the CHECK backs it up. */
  if (Number(text) > 100) {
    throw errors.validation(
      'A residual value cannot be more than 100% of what the asset cost.',
      { fieldErrors: { defaultResidualPercent: 'Enter a percentage between 0 and 100.' } },
    );
  }
  return text;
}

async function assertAccounts(
  db: Kysely<Database>,
  actor: FixedAssetActor,
  input: CategoryInput,
): Promise<void> {
  await assertAccountForRole(db, actor, 'assetCost', input.assetCostAccountId, 'assetCostAccountId');
  await assertAccountForRole(
    db, actor, 'accumulatedDepreciation',
    input.accumulatedDepreciationAccountId, 'accumulatedDepreciationAccountId',
  );
  await assertAccountForRole(
    db, actor, 'depreciationExpense',
    input.depreciationExpenseAccountId, 'depreciationExpenseAccountId',
  );

  /*
   * And no account may hold two of these roles.
   *
   * The database refuses it too, but a CHECK violation reaches a bookkeeper as
   * a constraint name. This says what the collision would DO: a depreciation
   * entry whose debit and credit land on the same account posts nothing and
   * balances perfectly, which is the worst kind of wrong.
   */
  const pairs: Array<[FixedAssetAccountKey, FixedAssetAccountKey, string]> = [
    ['assetCostAccountId', 'accumulatedDepreciationAccountId',
      'the asset cost account and the accumulated depreciation account'],
    ['assetCostAccountId', 'depreciationExpenseAccountId',
      'the asset cost account and the depreciation expense account'],
    ['accumulatedDepreciationAccountId', 'depreciationExpenseAccountId',
      'the accumulated depreciation account and the depreciation expense account'],
  ];
  for (const [left, right, what] of pairs) {
    const a = input[left];
    const b = input[right];
    if (a && b && a === b) {
      throw errors.validation(
        `The same account cannot be both ${what}. A depreciation entry posted through one account `
        + 'twice would balance to zero and record nothing.',
        { fieldErrors: { [right]: 'Choose a different account for this role.' } },
      );
    }
  }
}

type FixedAssetAccountKey =
  | 'assetCostAccountId'
  | 'accumulatedDepreciationAccountId'
  | 'depreciationExpenseAccountId';

const DUPLICATES = {
  fixed_asset_categories_code_uidx:
    'That asset category code is already used in these books. Codes are compared without regard to '
    + 'case, so "MACH" and "mach" are the same code.',
};

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function columns(input: CategoryInput, actor: FixedAssetActor): Record<string, any> {
  const method = input.defaultMethod ?? 'straight_line';
  return {
    code: trimmed(input.code),
    name: trimmed(input.name),
    description: trimmed(input.description),
    default_method: method,
    default_useful_life_months: method === 'none' ? null : input.defaultUsefulLifeMonths,
    default_residual_percent: residualPercent(input),
    depreciation_convention: input.depreciationConvention ?? 'full_month',
    asset_cost_account_id: input.assetCostAccountId ?? null,
    accumulated_depreciation_account_id: input.accumulatedDepreciationAccountId ?? null,
    depreciation_expense_account_id: input.depreciationExpenseAccountId ?? null,
    updated_by: actor.userId,
  };
}

/** The facts an audit entry keeps, so a reader can see what actually moved. */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function auditFacts(row: any): Record<string, unknown> {
  /*
   * SNAKE CASE, matching `columns()` exactly.
   *
   * The trail stores `before` and `after` side by side and a reader diffs them.
   * Two spellings of the same field would make every change look like a field
   * appearing and another disappearing, which is worse than no diff at all.
   */
  return {
    code: row.code,
    name: row.name,
    description: row.description ?? '',
    default_method: row.default_method,
    default_useful_life_months:
      row.default_useful_life_months === null ? null : Number(row.default_useful_life_months),
    default_residual_percent: String(row.default_residual_percent ?? '0'),
    depreciation_convention: row.depreciation_convention,
    asset_cost_account_id: row.asset_cost_account_id ?? null,
    accumulated_depreciation_account_id: row.accumulated_depreciation_account_id ?? null,
    depreciation_expense_account_id: row.depreciation_expense_account_id ?? null,
    status: row.status,
  };
}

/* ── Writes ────────────────────────────────────────────────────────────────── */

export async function createCategory(
  db: Kysely<Database>,
  actor: FixedAssetActor,
  input: CategoryInput,
): Promise<CategoryRecord> {
  assertShape(input);
  await assertAccounts(db, actor, input);

  const id = await db.transaction().execute(async (trx) => {
    let created: { id: string };
    try {
      created = await trx
        .insertInto('fixed_asset_categories')
        .values({
          organization_id: actor.organizationId,
          company_id: actor.companyId,
          created_by: actor.userId,
          ...columns(input, actor),
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow();
    } catch (cause) {
      asDuplicate(cause, DUPLICATES);
    }

    await writeFixedAssetAudit(trx, actor, {
      subjectType: 'category',
      subjectId: created.id,
      action: 'CATEGORY_CREATED',
      resultingVersion: 1,
      detail: { after: { ...columns(input, actor), status: 'active' } },
    });
    return created.id;
  });

  return getCategory(db, actor, id);
}

export async function updateCategory(
  db: Kysely<Database>,
  actor: FixedAssetActor,
  id: string,
  expectedVersion: number,
  input: CategoryInput,
): Promise<CategoryRecord> {
  assertShape(input);
  await assertAccounts(db, actor, input);

  await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('fixed_asset_categories')
      .selectAll()
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();

    if (!current) throw errors.notFound('Asset category');
    assertVersion(Number(current.version), expectedVersion);

    const nextVersion = Number(current.version) + 1;
    try {
      await trx
        .updateTable('fixed_asset_categories')
        .set({ ...columns(input, actor), version: nextVersion, updated_at: new Date() } as never)
        .where('organization_id', '=', actor.organizationId)
        .where('company_id', '=', actor.companyId)
        .where('id', '=', id)
        .execute();
    } catch (cause) {
      asDuplicate(cause, DUPLICATES);
    }

    /*
     * Before AND after. A category edit changes where a future charge posts and
     * what a future asset copies, and "the mapping changed" is only useful to
     * somebody who can see what it changed from.
     */
    await writeFixedAssetAudit(trx, actor, {
      subjectType: 'category',
      subjectId: id,
      action: 'CATEGORY_UPDATED',
      previousVersion: Number(current.version),
      resultingVersion: nextVersion,
      detail: {
        before: auditFacts(current),
        after: { ...columns(input, actor), status: current.status },
      },
    });
  });

  return getCategory(db, actor, id);
}

/**
 * Archive or bring back. Never a delete.
 *
 * A category is named by assets that have already been registered, and removing
 * the row would leave them pointing at nothing — which is exactly the state the
 * RESTRICT key refuses to create. Archiving keeps the identity and takes it out
 * of the pickers.
 *
 * Archiving is REFUSED while assets still need it. The established lifecycle
 * offers no historical-only mode: an asset's category is a live reference that
 * F2 will read to decide where its depreciation posts, so a category behind a
 * working asset is not finished with.
 */
export async function setCategoryArchived(
  db: Kysely<Database>,
  actor: FixedAssetActor,
  id: string,
  expectedVersion: number,
  archived: boolean,
): Promise<CategoryRecord> {
  await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('fixed_asset_categories')
      .selectAll()
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();

    if (!current) throw errors.notFound('Asset category');
    assertVersion(Number(current.version), expectedVersion);

    if (archived) {
      const inUse = await trx
        .selectFrom('fixed_assets')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('organization_id', '=', actor.organizationId)
        .where('company_id', '=', actor.companyId)
        .where('category_id', '=', id)
        .where('status', '<>', 'archived')
        .executeTakeFirst();
      const count = Number(inUse?.n ?? '0');
      if (count > 0) {
        throw errors.conflict(
          `Category ${current.code} still has ${count} asset(s) in the register that are not `
          + 'archived. An asset\'s category says where its depreciation will post, so it cannot be '
          + 'retired while an asset still needs it. Move those assets to another category, or '
          + 'archive them first.',
        );
      }
    }

    const nextVersion = Number(current.version) + 1;
    await trx
      .updateTable('fixed_asset_categories')
      .set({
        status: archived ? 'archived' : 'active',
        version: nextVersion,
        updated_by: actor.userId,
        updated_at: new Date(),
      } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .execute();

    await writeFixedAssetAudit(trx, actor, {
      subjectType: 'category',
      subjectId: id,
      action: archived ? 'CATEGORY_ARCHIVED' : 'CATEGORY_REACTIVATED',
      previousVersion: Number(current.version),
      resultingVersion: nextVersion,
      detail: {
        before: { status: current.status },
        after: { status: archived ? 'archived' : 'active' },
        code: current.code,
      },
    });
  });

  return getCategory(db, actor, id);
}

export async function countCategories(
  db: Kysely<Database>,
  actor: FixedAssetActor,
): Promise<number> {
  const row = await db
    .selectFrom('fixed_asset_categories')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .executeTakeFirst();
  return Number(row?.n ?? '0');
}

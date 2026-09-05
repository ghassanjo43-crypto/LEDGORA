/**
 * The asset register — what the business owns, and the policy that will apply
 * to it.
 *
 * ══ What is NOT in this file ═════════════════════════════════════════════════
 *
 * No cost. No accumulated depreciation. No carrying amount. No "in service", no
 * "fully depreciated", no "disposed". Every one of those is the RESULT of a
 * posting, and this slice posts nothing — so there is no column to hold one and
 * no status a client can claim one with. An asset here is `draft` (registered,
 * configured, and carrying no accounting at all) or `archived`.
 *
 * The product itself settled this, and settled it the same way: its own
 * `createAsset` writes `originalCost: 0` unconditionally, with the comment
 * "Register balances always start empty — they are built by postings", and the
 * New-asset form offers no cost field. Cost is first typed into the PURCHASE
 * form, which posts a voucher.
 *
 * ══ Policy is FROZEN at creation, not looked up ══════════════════════════════
 *
 * Method, useful life and convention are copied from the category onto the
 * asset's own row when it is created, and never read back from the category
 * afterwards. Editing a category default therefore cannot re-price an asset
 * somebody already configured — see `categoryService` for why that matters.
 *
 * ══ The freeze seam ══════════════════════════════════════════════════════════
 *
 * Once accounting exists for an asset, its cost basis inputs must stop moving:
 * a residual value or a useful life edited after depreciation has been charged
 * reinterprets a charge that is already in the ledger. `countAccountingActivityFor`
 * is structurally zero in F1, and the rules below are written and tested against
 * it NOW so they are in place before the first capitalisation can meet them.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import { toCalendarDate, toCalendarDateOrNull } from '../accounting/calendarDate.js';
import {
  type FixedAssetActor,
  DEPRECIATION_CONVENTIONS,
  DEPRECIATION_METHODS,
  MAX_USEFUL_LIFE_MONTHS,
  REFUSED_CONVENTIONS,
  REFUSED_METHODS,
  asDuplicate,
  assertVersion,
  calendarDateInput,
  countAccountingActivityFor,
  decimalAmount,
  monetaryDecimals,
  renderMonetary,
  trimmed,
  writeFixedAssetAudit,
} from './fixedAssetCore.js';
import { readHistory } from './categoryService.js';

type Trx = Transaction<Database>;

export interface AssetInput {
  /** Blank means "allocate one". Both are established product behaviour. */
  assetCode?: string | null;
  name: string;
  description?: string;
  categoryId: string;
  acquisitionDate: string;
  depreciationStartDate?: string | null;
  depreciationMethod?: string;
  usefulLifeMonths?: number | null;
  depreciationConvention?: string;
  residualValue?: string | number | null;
  quantity?: number;
  location?: string;
  custodian?: string;
  branch?: string;
  department?: string;
  supplierPartyId?: string | null;
  purchaseReference?: string;
  notes?: string;
}

export interface AssetRecord {
  id: string;
  assetCode: string;
  name: string;
  description: string;
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  acquisitionDate: string;
  depreciationStartDate: string | null;
  depreciationMethod: string;
  usefulLifeMonths: number | null;
  /** Always "months". Said in the payload so no client has to assume it. */
  usefulLifeUnit: 'months';
  depreciationConvention: string;
  residualValue: string;
  quantity: number;
  location: string;
  custodian: string;
  branch: string;
  department: string;
  supplierPartyId: string | null;
  supplierName: string;
  purchaseReference: string;
  notes: string;
  status: string;
  version: number;
  /**
   * How many posted accounting facts exist for this asset. Zero throughout F1,
   * and returned so a screen states it rather than assuming it.
   */
  accountingActivityCount: number;
  /** True while cost-basis policy may still be edited. */
  policyEditable: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ListAssetsQuery {
  status?: 'draft' | 'archived';
  categoryId?: string;
  search?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const iso = (value: unknown): string | null =>
  (value instanceof Date ? value.toISOString() : (value as string | null) ?? null);

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function hydrate(row: any, activity: number, decimals: number): AssetRecord {
  return {
    id: row.id,
    assetCode: row.asset_code,
    name: row.name,
    description: row.description ?? '',
    categoryId: row.category_id,
    categoryCode: row.category_code ?? '',
    categoryName: row.category_name ?? '',
    /*
     * Read through `toCalendarDate`, never `toISOString`. `node-postgres` parses
     * a bare `date` at LOCAL midnight, and east of Greenwich converting that to
     * UTC lands on the previous day — an asset acquired on 2026-03-01 coming
     * back as 2026-02-28, and losing another day on every round trip.
     */
    acquisitionDate: toCalendarDate(row.acquisition_date),
    depreciationStartDate: toCalendarDateOrNull(row.depreciation_start_date),
    depreciationMethod: row.depreciation_method,
    usefulLifeMonths: row.useful_life_months === null ? null : Number(row.useful_life_months),
    usefulLifeUnit: 'months',
    depreciationConvention: row.depreciation_convention,
    /*
     * At the tenant's own precision. `numeric(28,10)` comes back as
     * `99.9900000000`, and a form that round-trips that shows a bookkeeper ten
     * decimal places for a two-decimal currency — then sends them back.
     */
    residualValue: renderMonetary(row.residual_value ?? '0', decimals),
    quantity: Number(row.quantity ?? 1),
    location: row.location ?? '',
    custodian: row.custodian ?? '',
    branch: row.branch ?? '',
    department: row.department ?? '',
    supplierPartyId: row.supplier_party_id ?? null,
    supplierName: row.supplier_name ?? '',
    purchaseReference: row.purchase_reference ?? '',
    notes: row.notes ?? '',
    status: row.status,
    version: Number(row.version),
    accountingActivityCount: activity,
    policyEditable: activity === 0,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const selectAssets = (db: Kysely<Database>, actor: FixedAssetActor) => db
  .selectFrom('fixed_assets as a')
  .innerJoin('fixed_asset_categories as c', (join) => join
    .onRef('c.id', '=', 'a.category_id')
    .onRef('c.organization_id', '=', 'a.organization_id')
    .onRef('c.company_id', '=', 'a.company_id'))
  .leftJoin('business_parties as p', (join) => join
    .onRef('p.id', '=', 'a.supplier_party_id')
    .onRef('p.organization_id', '=', 'a.organization_id')
    .onRef('p.company_id', '=', 'a.company_id'))
  .selectAll('a')
  .select([
    'c.code as category_code',
    'c.name as category_name',
    'p.legal_name as supplier_name',
  ])
  .where('a.organization_id', '=', actor.organizationId)
  .where('a.company_id', '=', actor.companyId);

export async function listAssets(
  db: Kysely<Database>,
  actor: FixedAssetActor,
  query: ListAssetsQuery = {},
): Promise<AssetRecord[]> {
  let builder = selectAssets(db, actor);

  /*
   * No status filter means EVERYTHING, archived included. An archived asset
   * must stay findable: it is the record of something the business owned, and a
   * register that hid it would answer "we never had one" to an auditor who
   * knows otherwise.
   */
  if (query.status) builder = builder.where('a.status', '=', query.status);
  if (query.categoryId) builder = builder.where('a.category_id', '=', query.categoryId);
  if (query.search) {
    const term = `%${query.search.trim().toLowerCase()}%`;
    builder = builder.where((eb) => eb.or([
      eb(eb.fn('lower', ['a.asset_code']), 'like', term),
      eb(eb.fn('lower', ['a.name']), 'like', term),
      eb(eb.fn('lower', ['a.location']), 'like', term),
      eb(eb.fn('lower', ['a.custodian']), 'like', term),
      eb(eb.fn('lower', ['a.purchase_reference']), 'like', term),
    ]));
  }

  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const rows = await builder.orderBy('a.asset_code', 'asc').limit(limit).execute();
  const decimals = await monetaryDecimals(db, actor);
  /* Structurally zero in F1; read per asset rather than assumed, so the day it
   * stops being zero every caller already tells the truth. */
  return Promise.all(
    rows.map(async (row) => hydrate(
      row, await countAccountingActivityFor(db, actor, row.id), decimals,
    )),
  );
}

export async function getAsset(
  db: Kysely<Database>,
  actor: FixedAssetActor,
  id: string,
): Promise<AssetRecord> {
  const row = await selectAssets(db, actor).where('a.id', '=', id).executeTakeFirst();
  if (!row) throw errors.notFound('Fixed asset');
  return hydrate(
    row,
    await countAccountingActivityFor(db, actor, id),
    await monetaryDecimals(db, actor),
  );
}

export async function assetHistory(
  db: Kysely<Database>,
  actor: FixedAssetActor,
  id: string,
): Promise<Array<Record<string, unknown>>> {
  await getAsset(db, actor, id);
  return readHistory(db, actor, 'asset', id);
}

/* ── Validation ────────────────────────────────────────────────────────────── */

interface ResolvedPolicy {
  method: string;
  usefulLifeMonths: number | null;
  convention: string;
}

/**
 * The policy this asset will carry, refusing every method and convention this
 * product cannot evaluate BY NAME.
 *
 * `undefined` means "take the category's default"; an explicit value overrides
 * it. That is the product's own behaviour — its form pre-fills from the
 * category and lets the value be changed.
 */
function resolvePolicy(
  input: AssetInput,
  category: { default_method: string; default_useful_life_months: number | null; depreciation_convention: string },
): ResolvedPolicy {
  const method = input.depreciationMethod ?? category.default_method;
  if (!(DEPRECIATION_METHODS as readonly string[]).includes(method)) {
    throw errors.validation(
      REFUSED_METHODS[method]
      ?? `"${method}" is not a depreciation method this product implements. Choose straight line, `
        + 'or none for assets such as land that do not depreciate.',
      { fieldErrors: { depreciationMethod: 'Choose straight line, or none.' } },
    );
  }

  const convention = input.depreciationConvention ?? category.depreciation_convention;
  if (!(DEPRECIATION_CONVENTIONS as readonly string[]).includes(convention)) {
    throw errors.validation(
      REFUSED_CONVENTIONS[convention]
      ?? `"${convention}" is not a depreciation convention this product implements. It prorates in `
        + 'whole calendar months, counting the month depreciation starts in full.',
      { fieldErrors: { depreciationConvention: 'Choose the full-month convention.' } },
    );
  }

  const life = input.usefulLifeMonths === undefined
    ? (category.default_useful_life_months === null ? null : Number(category.default_useful_life_months))
    : input.usefulLifeMonths;

  if (method === 'none') {
    if (life !== null && life !== 0) {
      throw errors.validation(
        'An asset that does not depreciate has no useful life to state. Leave it blank.',
        { fieldErrors: { usefulLifeMonths: 'Leave blank for an asset that does not depreciate.' } },
      );
    }
    return { method, usefulLifeMonths: null, convention };
  }

  if (life === null || !Number.isInteger(life) || life < 1) {
    throw errors.validation(
      'A useful life is required, in MONTHS, and must be at least 1. This product measures useful '
      + 'life in months everywhere; it does not convert years, because 2.5 years is not a whole '
      + 'number of them and the rounding would be invisible.',
      { fieldErrors: { usefulLifeMonths: 'Enter a whole number of months, 1 or more.' } },
    );
  }
  if (life > MAX_USEFUL_LIFE_MONTHS) {
    throw errors.validation(
      `A useful life of ${life} months is longer than the ${MAX_USEFUL_LIFE_MONTHS}-month `
      + '(100-year) limit these books accept.',
      { fieldErrors: { usefulLifeMonths: `Enter at most ${MAX_USEFUL_LIFE_MONTHS} months.` } },
    );
  }
  return { method, usefulLifeMonths: life, convention };
}

function assertShape(input: AssetInput): void {
  const fieldErrors: Record<string, string> = {};
  if (!trimmed(input.name)) fieldErrors.name = 'An asset name is required.';
  if (!input.categoryId) fieldErrors.categoryId = 'An asset category is required.';

  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1) {
    fieldErrors.quantity =
      'A register record represents at least one unit. Enter a whole number, 1 or more.';
  }

  if (Object.keys(fieldErrors).length) {
    throw errors.validation('Check the asset details and try again.', { fieldErrors });
  }
}

/** The category, refused if it is another company's or is retired. */
async function requireCategory(
  db: Kysely<Database> | Trx,
  actor: FixedAssetActor,
  categoryId: string,
  { forNewAsset }: { forNewAsset: boolean },
) {
  const category = await db
    .selectFrom('fixed_asset_categories')
    .select([
      'id', 'code', 'name', 'status',
      'default_method', 'default_useful_life_months', 'depreciation_convention',
    ])
    /* Company scope in the QUERY: another company's category must be invisible,
     * not visible-and-refused. */
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', categoryId)
    .executeTakeFirst();

  if (!category) {
    throw errors.validation('That asset category does not exist in these books.', {
      fieldErrors: { categoryId: 'Choose a category from this company.' },
    });
  }
  if (forNewAsset && category.status !== 'active') {
    throw errors.validation(
      `Category ${category.code} is archived and cannot take new assets.`,
      { fieldErrors: { categoryId: 'Choose an active category.' } },
    );
  }
  return category;
}

async function assertSupplier(
  db: Kysely<Database> | Trx,
  actor: FixedAssetActor,
  supplierPartyId: string | null | undefined,
): Promise<void> {
  if (!supplierPartyId) return;
  const party = await db
    .selectFrom('business_parties')
    .select(['id', 'legal_name', 'status', 'is_supplier'])
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', supplierPartyId)
    .executeTakeFirst();
  if (!party) {
    throw errors.validation('That supplier does not exist in these books.', {
      fieldErrors: { supplierPartyId: 'Choose a supplier from this company.' },
    });
  }
  /*
   * A party is a set of ROLES, not a kind. The product's own supplier picker
   * offers those flagged supplier (or both), so a customer-only party here
   * would be a record nobody could have chosen through the screen.
   */
  if (!party.is_supplier) {
    throw errors.validation(
      `${party.legal_name} is not recorded as a supplier in these books.`,
      { fieldErrors: { supplierPartyId: 'Choose a party with the supplier role.' } },
    );
  }
}

const DUPLICATES = {
  fixed_assets_code_uidx:
    'That asset code is already used in these books. Codes are compared without regard to case, so '
    + '"AST-0001" and "ast-0001" are the same code.',
};

/**
 * The next held asset code.
 *
 * The advisory lock keys on the company, so two companies under one subscriber
 * number their assets independently and concurrently. The sequence is HELD,
 * never derived from a MAX over the register: counting existing rows reuses a
 * code after an archive, and two assets that ever shared a code cannot be told
 * apart in a history afterwards.
 *
 * A caller-supplied code still wins — that is the product's behaviour, and the
 * unique index is what makes either safe.
 */
async function allocateAssetCode(trx: Trx, actor: FixedAssetActor): Promise<string> {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${`fixed_asset_number:${actor.organizationId}:${actor.companyId}`})
    )
  `.execute(trx);

  const existing = await trx
    .selectFrom('fixed_asset_numbering')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('kind', '=', 'asset')
    .executeTakeFirst();

  const config = existing ?? { prefix: 'AST-', sequence_length: 4, next_sequence: 1 };

  if (!existing) {
    await trx.insertInto('fixed_asset_numbering').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      kind: 'asset',
      prefix: 'AST-',
      next_sequence: 2,
    } as never).execute();
  } else {
    await trx.updateTable('fixed_asset_numbering')
      .set({ next_sequence: Number(config.next_sequence) + 1, updated_at: new Date() } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('kind', '=', 'asset')
      .execute();
  }

  return `${config.prefix}${String(config.next_sequence).padStart(Number(config.sequence_length), '0')}`;
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function columns(
  input: AssetInput,
  policy: ResolvedPolicy,
  actor: FixedAssetActor,
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
): Record<string, any> {
  const acquisitionDate = calendarDateInput(
    input.acquisitionDate, 'acquisitionDate', 'acquisition date', { required: true },
  )!;
  const startDate = calendarDateInput(
    input.depreciationStartDate, 'depreciationStartDate', 'depreciation start date',
    { required: false },
  );

  /*
   * String comparison is correct for ISO dates and is deliberate: parsing both
   * into `Date` to compare them is how a timezone gets into a calendar
   * question that has none.
   */
  if (startDate && startDate < acquisitionDate) {
    throw errors.validation(
      'Depreciation cannot be intended to start before the asset was acquired.',
      { fieldErrors: { depreciationStartDate: 'Choose a date on or after the acquisition date.' } },
    );
  }

  return {
    name: trimmed(input.name),
    description: trimmed(input.description),
    category_id: input.categoryId,
    acquisition_date: acquisitionDate,
    depreciation_start_date: startDate,
    depreciation_method: policy.method,
    useful_life_months: policy.usefulLifeMonths,
    depreciation_convention: policy.convention,
    residual_value: decimalAmount(input.residualValue, 'residualValue', 'residual value'),
    quantity: input.quantity ?? 1,
    location: trimmed(input.location),
    custodian: trimmed(input.custodian),
    branch: trimmed(input.branch),
    department: trimmed(input.department),
    supplier_party_id: input.supplierPartyId ?? null,
    purchase_reference: trimmed(input.purchaseReference),
    notes: trimmed(input.notes),
    updated_by: actor.userId,
  };
}

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
    asset_code: row.asset_code,
    name: row.name,
    description: row.description ?? '',
    category_id: row.category_id,
    acquisition_date: toCalendarDate(row.acquisition_date),
    depreciation_start_date: toCalendarDateOrNull(row.depreciation_start_date),
    depreciation_method: row.depreciation_method,
    useful_life_months: row.useful_life_months === null ? null : Number(row.useful_life_months),
    depreciation_convention: row.depreciation_convention,
    residual_value: String(row.residual_value ?? '0'),
    quantity: Number(row.quantity ?? 1),
    location: row.location ?? '',
    custodian: row.custodian ?? '',
    branch: row.branch ?? '',
    department: row.department ?? '',
    supplier_party_id: row.supplier_party_id ?? null,
    purchase_reference: row.purchase_reference ?? '',
    notes: row.notes ?? '',
    status: row.status,
  };
}

/* ── Writes ────────────────────────────────────────────────────────────────── */

export async function createAsset(
  db: Kysely<Database>,
  actor: FixedAssetActor,
  input: AssetInput,
): Promise<AssetRecord> {
  assertShape(input);
  const category = await requireCategory(db, actor, input.categoryId, { forNewAsset: true });
  const policy = resolvePolicy(input, category);
  await assertSupplier(db, actor, input.supplierPartyId);

  const id = await db.transaction().execute(async (trx) => {
    const supplied = trimmed(input.assetCode);
    const assetCode = supplied || await allocateAssetCode(trx, actor);

    let created: { id: string };
    try {
      created = await trx
        .insertInto('fixed_assets')
        .values({
          organization_id: actor.organizationId,
          company_id: actor.companyId,
          asset_code: assetCode,
          created_by: actor.userId,
          ...columns(input, policy, actor),
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow();
    } catch (cause) {
      asDuplicate(cause, DUPLICATES);
    }

    await writeFixedAssetAudit(trx, actor, {
      subjectType: 'asset',
      subjectId: created.id,
      action: 'ASSET_REGISTERED',
      resultingVersion: 1,
      detail: {
        after: {
          asset_code: assetCode,
          ...columns(input, policy, actor),
          status: 'draft',
        },
        /* Which category the policy came from, and what it said at the time.
         * A later category edit does not move this asset, and this is the
         * record that makes that visible rather than merely true. */
        copiedFromCategory: {
          id: category.id,
          code: category.code,
          defaultMethod: category.default_method,
          defaultUsefulLifeMonths: category.default_useful_life_months,
          depreciationConvention: category.depreciation_convention,
        },
        codeSource: supplied ? 'supplied' : 'allocated',
      },
    });
    return created.id;
  });

  return getAsset(db, actor, id);
}

export async function updateAsset(
  db: Kysely<Database>,
  actor: FixedAssetActor,
  id: string,
  expectedVersion: number,
  input: AssetInput,
): Promise<AssetRecord> {
  assertShape(input);
  const category = await requireCategory(db, actor, input.categoryId, { forNewAsset: false });
  const policy = resolvePolicy(input, category);
  await assertSupplier(db, actor, input.supplierPartyId);

  await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('fixed_assets')
      .selectAll()
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();

    if (!current) throw errors.notFound('Fixed asset');
    assertVersion(Number(current.version), expectedVersion);

    /*
     * ══ The freeze, in place before anything can meet it ═══════════════════
     *
     * Once a charge has been posted against this asset, the inputs that
     * produced it stop moving. A useful life edited after depreciation has run
     * reinterprets a figure already in the ledger — the same charge, computed
     * two different ways, with no record of which one the books contain. The
     * correct response is a prospective estimate change, which needs an
     * effective date and a recalculation rule this product has not established,
     * so F1 refuses rather than inventing one.
     *
     * `countAccountingActivityFor` returns zero throughout F1, so this refuses
     * nothing yet and cannot be forgotten later.
     */
    const activity = await countAccountingActivityFor(trx, actor, id);
    if (activity > 0) {
      const frozen: Array<[string, unknown, unknown, string]> = [
        ['depreciationMethod', policy.method, current.depreciation_method, 'depreciation method'],
        ['usefulLifeMonths', policy.usefulLifeMonths, current.useful_life_months === null ? null : Number(current.useful_life_months), 'useful life'],
        ['depreciationConvention', policy.convention, current.depreciation_convention, 'depreciation convention'],
        ['residualValue', decimalAmount(input.residualValue, 'residualValue', 'residual value'), String(current.residual_value ?? '0'), 'residual value'],
        ['categoryId', input.categoryId, current.category_id, 'category'],
        ['acquisitionDate', calendarDateInput(input.acquisitionDate, 'acquisitionDate', 'acquisition date', { required: true }), toCalendarDate(current.acquisition_date), 'acquisition date'],
        ['depreciationStartDate', calendarDateInput(input.depreciationStartDate, 'depreciationStartDate', 'depreciation start date', { required: false }), toCalendarDateOrNull(current.depreciation_start_date), 'depreciation start date'],
      ];
      for (const [field, next, was, what] of frozen) {
        /* Compared as strings so `120` and `'120'` from two drivers do not read
         * as a change nobody made. */
        if (String(next ?? '') !== String(was ?? '')) {
          throw errors.validation(
            `Asset ${current.asset_code} already has ${activity} posted accounting entr(y/ies), so `
            + `its ${what} can no longer change — the depreciation already charged was computed `
            + 'from the old one.',
            { fieldErrors: { [field]: 'Locked once accounting exists for this asset.' } },
          );
        }
      }
    }

    const nextVersion = Number(current.version) + 1;
    try {
      await trx
        .updateTable('fixed_assets')
        .set({ ...columns(input, policy, actor), version: nextVersion, updated_at: new Date() } as never)
        .where('organization_id', '=', actor.organizationId)
        .where('company_id', '=', actor.companyId)
        .where('id', '=', id)
        .execute();
    } catch (cause) {
      asDuplicate(cause, DUPLICATES);
    }

    await writeFixedAssetAudit(trx, actor, {
      subjectType: 'asset',
      subjectId: id,
      action: 'ASSET_UPDATED',
      previousVersion: Number(current.version),
      resultingVersion: nextVersion,
      detail: {
        before: auditFacts(current),
        after: {
          asset_code: current.asset_code,
          ...columns(input, policy, actor),
          status: current.status,
        },
      },
    });
  });

  return getAsset(db, actor, id);
}

/**
 * Archive or bring back. Never a delete.
 *
 * An archived asset stays in the register, stays searchable and keeps its
 * history: it is the record of something the business owned, and deleting it
 * would answer "we never had one" to somebody who knows otherwise. Archiving
 * takes it out of the working list and nothing else.
 *
 * This is NOT a disposal. Disposal derecognises a cost and an accumulated
 * depreciation, posts a gain or a loss, and is F3.
 */
export async function setAssetArchived(
  db: Kysely<Database>,
  actor: FixedAssetActor,
  id: string,
  expectedVersion: number,
  archived: boolean,
  reason: string,
): Promise<AssetRecord> {
  await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('fixed_assets')
      .selectAll()
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();

    if (!current) throw errors.notFound('Fixed asset');
    assertVersion(Number(current.version), expectedVersion);

    /* Bringing an asset back needs its category back too, or it would rejoin
     * the working register pointing at configuration nobody may use. */
    if (!archived) {
      const category = await trx
        .selectFrom('fixed_asset_categories')
        .select(['code', 'status'])
        .where('organization_id', '=', actor.organizationId)
        .where('company_id', '=', actor.companyId)
        .where('id', '=', current.category_id)
        .executeTakeFirst();
      if (category && category.status !== 'active') {
        throw errors.conflict(
          `Asset ${current.asset_code} belongs to category ${category.code}, which is archived. `
          + 'Reactivate the category first, or move the asset to an active one.',
        );
      }
    }

    const nextVersion = Number(current.version) + 1;
    await trx
      .updateTable('fixed_assets')
      .set({
        status: archived ? 'archived' : 'draft',
        version: nextVersion,
        updated_by: actor.userId,
        updated_at: new Date(),
      } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .execute();

    await writeFixedAssetAudit(trx, actor, {
      subjectType: 'asset',
      subjectId: id,
      action: archived ? 'ASSET_ARCHIVED' : 'ASSET_REACTIVATED',
      previousVersion: Number(current.version),
      resultingVersion: nextVersion,
      reason: trimmed(reason),
      detail: {
        before: { status: current.status },
        after: { status: archived ? 'archived' : 'draft' },
        assetCode: current.asset_code,
      },
    });
  });

  return getAsset(db, actor, id);
}

export async function countAssets(
  db: Kysely<Database>,
  actor: FixedAssetActor,
): Promise<number> {
  const row = await db
    .selectFrom('fixed_assets')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .executeTakeFirst();
  return Number(row?.n ?? '0');
}

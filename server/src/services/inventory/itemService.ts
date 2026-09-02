/**
 * The item register — a catalogue of what the business buys and sells.
 *
 * ══ One entity, eleven types ═════════════════════════════════════════════════
 *
 * "Item", "product" and "service" are not three records. The product has always
 * modelled one entity discriminated by `itemType`, and `itemClassification()`
 * collapses it to product-or-service for display only. Splitting them here
 * would make a service that later becomes a stocked good a different row, and
 * every document that ever named it would point at the wrong one.
 *
 * ══ There is no quantity here ════════════════════════════════════════════════
 *
 * No on-hand, no available, no committed, no average cost, no value. An item is
 * a NAME; a balance is the sum of posted movements, and movements are I2. There
 * is no column here a client could write a quantity into, which is a stronger
 * guarantee than a service that declines to.
 *
 * ══ Tracked status, and why the rule is set now ══════════════════════════════
 *
 * `service` and `non-inventory` can never be tracked — enforced by CHECK, so no
 * client can mark a stocked good "service" to slip past a subledger that does
 * not exist yet. The harder rule is the future one: once movements exist, an
 * item's tracked status and valuation method must freeze, because changing
 * either would reinterpret history that has already been posted. That rule is
 * written and tested HERE, against a movement count that is structurally zero
 * in I1, so the guard is in place before the first movement can ever meet it
 * rather than being remembered afterwards.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import {
  type InventoryActor,
  assertAccountForRole,
  assertTaxCodeForDirection,
  assertVersion,
  asDuplicate,
  decimalOrNull,
  ensureBaseUnits,
  nullIfBlank,
  trimmed,
  writeInventoryAudit,
} from './inventoryCore.js';

export const ITEM_TYPES = [
  'inventory', 'non-inventory', 'service', 'raw-material', 'component',
  'subassembly', 'finished-good', 'packaging', 'consumable', 'spare-part', 'scrap',
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** The two types that are never stock, whatever a caller claims. */
const NEVER_TRACKED: ReadonlySet<string> = new Set(['service', 'non-inventory']);

export interface ItemInput {
  itemCode: string;
  barcode?: string | null;
  name: string;
  nameSecondary?: string;
  description?: string;
  itemType: string;
  isInventoryTracked?: boolean;
  isPurchasable?: boolean;
  isSellable?: boolean;
  trackingMode?: string;
  valuationMethod?: string;
  baseUnitId: string;
  defaultSellingPrice?: string | null;
  defaultPurchasePrice?: string | null;
  standardCost?: string | null;
  salesDescription?: string;
  purchaseDescription?: string;
  salesTaxCodeId?: string | null;
  purchaseTaxCodeId?: string | null;
  inventoryAccountId?: string | null;
  cogsAccountId?: string | null;
  salesAccountId?: string | null;
  purchaseAccountId?: string | null;
  inventoryAdjustmentAccountId?: string | null;
}

export interface ItemRecord {
  id: string;
  itemCode: string;
  barcode: string | null;
  name: string;
  nameSecondary: string;
  description: string;
  itemType: string;
  isInventoryTracked: boolean;
  isPurchasable: boolean;
  isSellable: boolean;
  trackingMode: string;
  valuationMethod: string;
  baseUnitId: string;
  baseUnitCode: string;
  baseUnitDecimalPlaces: number;
  defaultSellingPrice: string | null;
  defaultPurchasePrice: string | null;
  standardCost: string | null;
  salesDescription: string;
  purchaseDescription: string;
  salesTaxCodeId: string | null;
  purchaseTaxCodeId: string | null;
  inventoryAccountId: string | null;
  cogsAccountId: string | null;
  salesAccountId: string | null;
  purchaseAccountId: string | null;
  inventoryAdjustmentAccountId: string | null;
  status: string;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ListItemsQuery {
  status?: 'active' | 'inactive' | 'archived';
  itemType?: string;
  tracked?: boolean;
  search?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const iso = (value: unknown): string | null =>
  (value instanceof Date ? value.toISOString() : (value as string | null) ?? null);

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function hydrate(row: any): ItemRecord {
  return {
    id: row.id,
    itemCode: row.item_code,
    barcode: row.barcode ?? null,
    name: row.name,
    nameSecondary: row.name_secondary ?? '',
    description: row.description ?? '',
    itemType: row.item_type,
    isInventoryTracked: Boolean(row.is_inventory_tracked),
    isPurchasable: Boolean(row.is_purchasable),
    isSellable: Boolean(row.is_sellable),
    trackingMode: row.tracking_mode,
    valuationMethod: row.valuation_method,
    baseUnitId: row.base_unit_id,
    baseUnitCode: row.base_unit_code ?? '',
    baseUnitDecimalPlaces: Number(row.base_unit_decimal_places ?? 0),
    defaultSellingPrice: row.default_selling_price ?? null,
    defaultPurchasePrice: row.default_purchase_price ?? null,
    standardCost: row.standard_cost ?? null,
    salesDescription: row.sales_description ?? '',
    purchaseDescription: row.purchase_description ?? '',
    salesTaxCodeId: row.sales_tax_code_id ?? null,
    purchaseTaxCodeId: row.purchase_tax_code_id ?? null,
    inventoryAccountId: row.inventory_account_id ?? null,
    cogsAccountId: row.cogs_account_id ?? null,
    salesAccountId: row.sales_account_id ?? null,
    purchaseAccountId: row.purchase_account_id ?? null,
    inventoryAdjustmentAccountId: row.inventory_adjustment_account_id ?? null,
    status: row.status,
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const selectItems = (db: Kysely<Database>, actor: InventoryActor) => db
  .selectFrom('inventory_items as i')
  .innerJoin('units_of_measure as u', (join) => join
    .onRef('u.id', '=', 'i.base_unit_id')
    .onRef('u.organization_id', '=', 'i.organization_id')
    .onRef('u.company_id', '=', 'i.company_id'))
  .selectAll('i')
  .select(['u.code as base_unit_code', 'u.decimal_places as base_unit_decimal_places'])
  .where('i.organization_id', '=', actor.organizationId)
  .where('i.company_id', '=', actor.companyId);

export async function listItems(
  db: Kysely<Database>,
  actor: InventoryActor,
  query: ListItemsQuery = {},
): Promise<ItemRecord[]> {
  await ensureBaseUnits(db, actor);
  let builder = selectItems(db, actor);

  if (query.status) builder = builder.where('i.status', '=', query.status);
  if (query.itemType) builder = builder.where('i.item_type', '=', query.itemType);
  if (query.tracked !== undefined) {
    builder = builder.where('i.is_inventory_tracked', '=', query.tracked);
  }
  if (query.search) {
    const term = `%${query.search.trim().toLowerCase()}%`;
    builder = builder.where((eb) => eb.or([
      eb(eb.fn('lower', ['i.item_code']), 'like', term),
      eb(eb.fn('lower', ['i.name']), 'like', term),
      eb(eb.fn('lower', ['i.barcode']), 'like', term),
    ]));
  }

  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const rows = await builder.orderBy('i.item_code', 'asc').limit(limit).execute();
  return rows.map(hydrate);
}

export async function getItem(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
): Promise<ItemRecord> {
  const row = await selectItems(db, actor).where('i.id', '=', id).executeTakeFirst();
  if (!row) throw errors.notFound('Item');
  return hydrate(row);
}

export async function itemHistory(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
): Promise<Array<Record<string, unknown>>> {
  await getItem(db, actor, id);
  const rows = await db
    .selectFrom('inventory_audit_events')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('subject_type', '=', 'item')
    .where('subject_id', '=', id)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    resultingVersion: row.resulting_version,
    detail: typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail,
    actorName: row.actor_name,
    occurredAt: iso(row.created_at),
  }));
}

/* ── Validation ────────────────────────────────────────────────────────────── */

/**
 * Every rule that does not need the database, in one place.
 *
 * Runs before the transaction opens, so a refused item leaves nothing behind —
 * no row, no audit line, no half-written mapping.
 */
function assertShape(input: ItemInput): void {
  const fieldErrors: Record<string, string> = {};

  if (!trimmed(input.itemCode)) fieldErrors.itemCode = 'An item code is required.';
  if (!trimmed(input.name)) fieldErrors.name = 'An item name is required.';
  if (!input.baseUnitId) fieldErrors.baseUnitId = 'A base unit is required.';
  if (!ITEM_TYPES.includes(input.itemType as ItemType)) {
    fieldErrors.itemType = 'Choose one of the supported item types.';
  }
  if (input.trackingMode && !['none', 'lot', 'serial'].includes(input.trackingMode)) {
    fieldErrors.trackingMode = 'Tracking must be none, lot or serial.';
  }
  if (input.valuationMethod
      && !['weighted-average', 'standard', 'fifo'].includes(input.valuationMethod)) {
    fieldErrors.valuationMethod = 'Valuation must be weighted-average, standard or fifo.';
  }

  const sellable = input.isSellable ?? true;
  const purchasable = input.isPurchasable ?? true;
  if (!sellable && !purchasable) {
    fieldErrors.isSellable = 'An item must be sellable, purchasable, or both.';
  }

  if (NEVER_TRACKED.has(input.itemType) && input.isInventoryTracked) {
    fieldErrors.isInventoryTracked =
      `A ${input.itemType} item cannot be inventory tracked — it has no stock to track.`;
  }

  if (Object.keys(fieldErrors).length) {
    throw errors.validation('Check the item details and try again.', { fieldErrors });
  }
}

/** Everything that needs the books: the unit, the tax codes and the accounts. */
async function assertReferences(
  db: Kysely<Database>,
  actor: InventoryActor,
  input: ItemInput,
): Promise<void> {
  const unit = await db
    .selectFrom('units_of_measure')
    .select(['id', 'code', 'status'])
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', input.baseUnitId)
    .executeTakeFirst();

  if (!unit) {
    throw errors.validation('That unit of measure does not exist in these books.', {
      fieldErrors: { baseUnitId: 'Choose a unit from this company.' },
    });
  }
  /* An archived unit may stay on items that already use it, but must not be
   * chosen for new work — the same rule the chart of accounts applies. */
  if (unit.status !== 'active') {
    throw errors.validation(
      `Unit ${unit.code} is ${unit.status} and cannot be given to an item.`,
      { fieldErrors: { baseUnitId: 'Choose an active unit.' } },
    );
  }

  await assertTaxCodeForDirection(db, actor, input.salesTaxCodeId, 'sales', 'salesTaxCodeId');
  await assertTaxCodeForDirection(db, actor, input.purchaseTaxCodeId, 'purchase', 'purchaseTaxCodeId');

  await assertAccountForRole(db, actor, 'inventory', input.inventoryAccountId, 'inventoryAccountId');
  await assertAccountForRole(db, actor, 'cogs', input.cogsAccountId, 'cogsAccountId');
  await assertAccountForRole(db, actor, 'sales', input.salesAccountId, 'salesAccountId');
  await assertAccountForRole(db, actor, 'purchase', input.purchaseAccountId, 'purchaseAccountId');
  await assertAccountForRole(
    db, actor, 'adjustment', input.inventoryAdjustmentAccountId, 'inventoryAdjustmentAccountId',
  );
}

const DUPLICATES = {
  inventory_items_code_uidx: 'That item code is already used in these books.',
  inventory_items_barcode_uidx: 'That barcode is already used by another item in these books.',
};

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function columns(input: ItemInput, actor: InventoryActor): Record<string, any> {
  return {
    item_code: trimmed(input.itemCode),
    barcode: nullIfBlank(input.barcode),
    name: trimmed(input.name),
    name_secondary: trimmed(input.nameSecondary),
    description: trimmed(input.description),
    item_type: input.itemType,
    is_inventory_tracked: NEVER_TRACKED.has(input.itemType)
      ? false
      : Boolean(input.isInventoryTracked),
    is_purchasable: input.isPurchasable ?? true,
    is_sellable: input.isSellable ?? true,
    tracking_mode: input.trackingMode ?? 'none',
    valuation_method: input.valuationMethod ?? 'weighted-average',
    base_unit_id: input.baseUnitId,
    default_selling_price: decimalOrNull(
      input.defaultSellingPrice, 'defaultSellingPrice', 'default selling price',
    ),
    default_purchase_price: decimalOrNull(
      input.defaultPurchasePrice, 'defaultPurchasePrice', 'default purchase price',
    ),
    standard_cost: decimalOrNull(input.standardCost, 'standardCost', 'standard cost'),
    sales_description: trimmed(input.salesDescription),
    purchase_description: trimmed(input.purchaseDescription),
    sales_tax_code_id: input.salesTaxCodeId ?? null,
    purchase_tax_code_id: input.purchaseTaxCodeId ?? null,
    inventory_account_id: input.inventoryAccountId ?? null,
    cogs_account_id: input.cogsAccountId ?? null,
    sales_account_id: input.salesAccountId ?? null,
    purchase_account_id: input.purchaseAccountId ?? null,
    inventory_adjustment_account_id: input.inventoryAdjustmentAccountId ?? null,
    updated_by: actor.userId,
  };
}

/* ── Writes ────────────────────────────────────────────────────────────────── */

export async function createItem(
  db: Kysely<Database>,
  actor: InventoryActor,
  input: ItemInput,
): Promise<ItemRecord> {
  assertShape(input);
  await ensureBaseUnits(db, actor);
  await assertReferences(db, actor, input);

  const id = await db.transaction().execute(async (trx) => {
    let created: { id: string };
    try {
      created = await trx
        .insertInto('inventory_items')
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

    await writeInventoryAudit(trx, actor, {
      subjectType: 'item',
      subjectId: created.id,
      action: 'ITEM_CREATED',
      resultingVersion: 1,
      detail: {
        itemCode: trimmed(input.itemCode),
        itemType: input.itemType,
        tracked: NEVER_TRACKED.has(input.itemType) ? false : Boolean(input.isInventoryTracked),
      },
    });
    return created.id;
  });

  return getItem(db, actor, id);
}

export async function updateItem(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
  expectedVersion: number,
  input: ItemInput,
): Promise<ItemRecord> {
  assertShape(input);
  await assertReferences(db, actor, input);

  await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('inventory_items')
      .select(['id', 'version', 'status', 'item_code', 'item_type', 'is_inventory_tracked', 'valuation_method'])
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();

    if (!current) throw errors.notFound('Item');
    assertVersion(Number(current.version), expectedVersion);

    /*
     * The future-safe rule, in place before the first movement can meet it.
     *
     * Changing an item between tracked and non-tracked — or changing how it is
     * valued — reinterprets every movement already posted against it: stock
     * that was relieved at average cost cannot be re-read as FIFO, and a good
     * that became a service leaves quantities nothing will ever consume. Once
     * movements exist, both freeze. In I1 the count is structurally zero, so
     * this refuses nothing yet and cannot be forgotten later.
     */
    const movements = await countMovementsFor(trx as unknown as Kysely<Database>, actor, id);
    if (movements > 0) {
      const tracked = NEVER_TRACKED.has(input.itemType) ? false : Boolean(input.isInventoryTracked);
      if (tracked !== Boolean(current.is_inventory_tracked)) {
        throw errors.validation(
          `Item ${current.item_code} already has ${movements} stock movement(s), so whether it is `
          + 'inventory tracked can no longer change. Archive it and create a replacement.',
          { fieldErrors: { isInventoryTracked: 'Locked once stock has moved.' } },
        );
      }
      const valuation = input.valuationMethod ?? current.valuation_method;
      if (valuation !== current.valuation_method) {
        throw errors.validation(
          `Item ${current.item_code} already has ${movements} stock movement(s), so its valuation `
          + 'method can no longer change — the cost already posted was computed the old way.',
          { fieldErrors: { valuationMethod: 'Locked once stock has moved.' } },
        );
      }
    }

    const nextVersion = Number(current.version) + 1;
    try {
      await trx
        .updateTable('inventory_items')
        .set({ ...columns(input, actor), version: nextVersion, updated_at: new Date() } as never)
        .where('organization_id', '=', actor.organizationId)
        .where('company_id', '=', actor.companyId)
        .where('id', '=', id)
        .execute();
    } catch (cause) {
      asDuplicate(cause, DUPLICATES);
    }

    await writeInventoryAudit(trx, actor, {
      subjectType: 'item',
      subjectId: id,
      action: 'ITEM_UPDATED',
      resultingVersion: nextVersion,
      detail: { itemCode: trimmed(input.itemCode) },
    });
  });

  return getItem(db, actor, id);
}

/**
 * Archive or bring back.
 *
 * Never a delete. An item is named by documents that have already been issued,
 * and removing the row would leave those documents pointing at nothing — which
 * is exactly the state migration 037 refuses to create. Archiving keeps the
 * identity and takes it out of the pickers.
 */
export async function setItemArchived(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
  expectedVersion: number,
  archived: boolean,
): Promise<ItemRecord> {
  await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('inventory_items')
      .select(['id', 'version', 'status', 'item_code'])
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();

    if (!current) throw errors.notFound('Item');
    assertVersion(Number(current.version), expectedVersion);

    const nextVersion = Number(current.version) + 1;
    await trx
      .updateTable('inventory_items')
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

    await writeInventoryAudit(trx, actor, {
      subjectType: 'item',
      subjectId: id,
      action: archived ? 'ITEM_ARCHIVED' : 'ITEM_REACTIVATED',
      resultingVersion: nextVersion,
      detail: { itemCode: current.item_code },
    });
  });

  return getItem(db, actor, id);
}

/**
 * How many posted stock movements name this item.
 *
 * Structurally zero in I1 — the table does not exist — and this is the seam I2
 * fills in. It returns 0 rather than throwing so the freeze rules above can be
 * written, tested and shipped now instead of being remembered later.
 */
export async function countMovementsFor(
  _db: Kysely<Database>,
  _actor: InventoryActor,
  _itemId: string,
): Promise<number> {
  return 0;
}

export async function countItems(
  db: Kysely<Database>,
  actor: InventoryActor,
): Promise<number> {
  const row = await db
    .selectFrom('inventory_items')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .executeTakeFirst();
  return Number(row?.n ?? '0');
}

/**
 * The warehouse register — the places stock will one day sit.
 *
 * ══ No quantities live here ══════════════════════════════════════════════════
 *
 * A warehouse is an identity and an address. What is in it is the sum of posted
 * movements, and there is no column here that could hold a balance.
 *
 * ══ Why the default warehouse is a pointer, not a flag ═══════════════════════
 *
 * The product has never had `isDefault` on a warehouse. It has one pointer,
 * `InventorySettings.defaultWarehouseId`, and that difference matters: a flag on
 * every row makes "exactly one default" a rule somebody must enforce on every
 * write and which two concurrent writers can break. A single pointer makes more
 * than one default unrepresentable, so the rule needs no enforcement at all.
 * The pointer lives in `settingsService`; nothing here decides a default.
 *
 * ══ No bins ═════════════════════════════════════════════════════════════════
 *
 * `StockMovement.locationId` exists as a field in the browser model, but no
 * location, bin or zone entity is defined anywhere in the product. There is
 * nothing here to implement without inventing one, so warehouses are flat.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import {
  type InventoryActor,
  assertVersion,
  asDuplicate,
  trimmed,
  writeInventoryAudit,
} from './inventoryCore.js';

export const WAREHOUSE_TYPES = [
  'main', 'raw-material', 'wip', 'finished-goods', 'returns',
  'quarantine', 'scrap', 'site', 'transit', 'virtual',
] as const;

export interface WarehouseInput {
  code: string;
  name: string;
  description?: string;
  warehouseType?: string;
  location?: string;
}

export interface WarehouseRecord {
  id: string;
  code: string;
  name: string;
  description: string;
  warehouseType: string;
  location: string;
  status: string;
  /** True when the company's settings point at this one. Derived, never stored. */
  isDefault: boolean;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
}

const iso = (value: unknown): string | null =>
  (value instanceof Date ? value.toISOString() : (value as string | null) ?? null);

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function hydrate(row: any, defaultWarehouseId: string | null): WarehouseRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description ?? '',
    warehouseType: row.warehouse_type,
    location: row.location ?? '',
    status: row.status,
    isDefault: defaultWarehouseId !== null && row.id === defaultWarehouseId,
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function defaultWarehouseOf(
  db: Kysely<Database>,
  actor: InventoryActor,
): Promise<string | null> {
  const row = await db
    .selectFrom('inventory_settings')
    .select('default_warehouse_id')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .executeTakeFirst();
  return row?.default_warehouse_id ?? null;
}

export interface ListWarehousesQuery {
  status?: 'active' | 'inactive' | 'archived';
  search?: string;
  limit?: number;
}

export async function listWarehouses(
  db: Kysely<Database>,
  actor: InventoryActor,
  query: ListWarehousesQuery = {},
): Promise<WarehouseRecord[]> {
  let builder = db
    .selectFrom('warehouses')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId);

  if (query.status) builder = builder.where('status', '=', query.status);
  if (query.search) {
    const term = `%${query.search.trim().toLowerCase()}%`;
    builder = builder.where((eb) => eb.or([
      eb(eb.fn('lower', ['code']), 'like', term),
      eb(eb.fn('lower', ['name']), 'like', term),
      eb(eb.fn('lower', ['location']), 'like', term),
    ]));
  }

  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const [rows, fallback] = await Promise.all([
    builder.orderBy('code', 'asc').limit(limit).execute(),
    defaultWarehouseOf(db, actor),
  ]);
  return rows.map((row) => hydrate(row, fallback));
}

export async function getWarehouse(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
): Promise<WarehouseRecord> {
  const [row, fallback] = await Promise.all([
    db.selectFrom('warehouses')
      .selectAll()
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .executeTakeFirst(),
    defaultWarehouseOf(db, actor),
  ]);
  if (!row) throw errors.notFound('Warehouse');
  return hydrate(row, fallback);
}

export async function warehouseHistory(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
): Promise<Array<Record<string, unknown>>> {
  await getWarehouse(db, actor, id);
  const rows = await db
    .selectFrom('inventory_audit_events')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('subject_type', '=', 'warehouse')
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

function assertShape(input: WarehouseInput): void {
  const fieldErrors: Record<string, string> = {};
  if (!trimmed(input.code)) fieldErrors.code = 'A warehouse code is required.';
  if (!trimmed(input.name)) fieldErrors.name = 'A warehouse name is required.';
  if (input.warehouseType
      && !WAREHOUSE_TYPES.includes(input.warehouseType as (typeof WAREHOUSE_TYPES)[number])) {
    fieldErrors.warehouseType = 'Choose one of the supported warehouse types.';
  }
  if (Object.keys(fieldErrors).length) {
    throw errors.validation('Check the warehouse details and try again.', { fieldErrors });
  }
}

const DUPLICATES = {
  warehouses_code_uidx: 'That warehouse code is already used in these books.',
};

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
const columns = (input: WarehouseInput, actor: InventoryActor): Record<string, any> => ({
  code: trimmed(input.code),
  name: trimmed(input.name),
  description: trimmed(input.description),
  warehouse_type: input.warehouseType ?? 'main',
  location: trimmed(input.location),
  updated_by: actor.userId,
});

export async function createWarehouse(
  db: Kysely<Database>,
  actor: InventoryActor,
  input: WarehouseInput,
): Promise<WarehouseRecord> {
  assertShape(input);

  const id = await db.transaction().execute(async (trx) => {
    let created: { id: string };
    try {
      created = await trx
        .insertInto('warehouses')
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
      subjectType: 'warehouse',
      subjectId: created.id,
      action: 'WAREHOUSE_CREATED',
      resultingVersion: 1,
      detail: { code: trimmed(input.code) },
    });
    return created.id;
  });

  return getWarehouse(db, actor, id);
}

export async function updateWarehouse(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
  expectedVersion: number,
  input: WarehouseInput,
): Promise<WarehouseRecord> {
  assertShape(input);

  await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('warehouses')
      .select(['id', 'version', 'code'])
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();

    if (!current) throw errors.notFound('Warehouse');
    assertVersion(Number(current.version), expectedVersion);

    const nextVersion = Number(current.version) + 1;
    try {
      await trx
        .updateTable('warehouses')
        .set({ ...columns(input, actor), version: nextVersion, updated_at: new Date() } as never)
        .where('organization_id', '=', actor.organizationId)
        .where('company_id', '=', actor.companyId)
        .where('id', '=', id)
        .execute();
    } catch (cause) {
      asDuplicate(cause, DUPLICATES);
    }

    await writeInventoryAudit(trx, actor, {
      subjectType: 'warehouse',
      subjectId: id,
      action: 'WAREHOUSE_UPDATED',
      resultingVersion: nextVersion,
      detail: { code: trimmed(input.code) },
    });
  });

  return getWarehouse(db, actor, id);
}

/**
 * Archive or bring back.
 *
 * A warehouse the company still points at as its default may not be archived:
 * the pointer would survive aiming at somewhere nothing may be stored, and the
 * next slice would resolve it happily. Clear the default first — said plainly,
 * because "cannot archive" with no reason is the least useful refusal there is.
 */
export async function setWarehouseArchived(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
  expectedVersion: number,
  archived: boolean,
): Promise<WarehouseRecord> {
  await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('warehouses')
      .select(['id', 'version', 'code'])
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();

    if (!current) throw errors.notFound('Warehouse');
    assertVersion(Number(current.version), expectedVersion);

    if (archived) {
      const settings = await trx
        .selectFrom('inventory_settings')
        .select('default_warehouse_id')
        .where('organization_id', '=', actor.organizationId)
        .where('company_id', '=', actor.companyId)
        .forUpdate()
        .executeTakeFirst();
      if (settings?.default_warehouse_id === id) {
        throw errors.validation(
          `Warehouse ${current.code} is this company's default and cannot be archived while it is. `
          + 'Point the default at another warehouse first, or clear it.',
          { fieldErrors: { status: 'Clear the default warehouse first.' } },
        );
      }
    }

    const nextVersion = Number(current.version) + 1;
    await trx
      .updateTable('warehouses')
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
      subjectType: 'warehouse',
      subjectId: id,
      action: archived ? 'WAREHOUSE_ARCHIVED' : 'WAREHOUSE_REACTIVATED',
      resultingVersion: nextVersion,
      detail: { code: current.code },
    });
  });

  return getWarehouse(db, actor, id);
}

export async function countWarehouses(
  db: Kysely<Database>,
  actor: InventoryActor,
): Promise<number> {
  const row = await db
    .selectFrom('warehouses')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .executeTakeFirst();
  return Number(row?.n ?? '0');
}

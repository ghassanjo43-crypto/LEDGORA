/**
 * Units of measure — base units only, and deliberately so.
 *
 * ══ Why there is no conversion ═══════════════════════════════════════════════
 *
 * The product's unit model is code, name, symbol, category and decimal places.
 * There is no conversion factor in it, no relation between two units, and no
 * function anywhere that converts one into another. An item names ONE base
 * unit; its purchase and sales unit fields exist in the browser type but have
 * never had a defined relationship to the base.
 *
 * Inventing one would mean this code deciding how many pieces are in a box, or
 * that a kilogram of something is a litre of it. Those are facts about a
 * business's goods, not about software, and a wrong factor silently multiplies
 * every quantity and every cost that flows through it. So conversion is DEFERRED
 * — named here, absent from the schema, and reintroduced by whichever slice
 * models it properly.
 *
 * ══ Why quantity precision is not currency precision ═════════════════════════
 *
 * `decimal_places` is the unit's own. A kilogram is weighed to three places in
 * books that round money to two, and tying them together would re-round every
 * weight the day a company changed currency.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import {
  type InventoryActor,
  assertVersion,
  asDuplicate,
  ensureBaseUnits,
  trimmed,
  writeInventoryAudit,
} from './inventoryCore.js';

export const UNIT_CATEGORIES = [
  'quantity', 'weight', 'volume', 'length', 'area', 'time', 'custom',
] as const;

/** Said out loud so a reader meets the argument rather than the gap. */
export const CONVERSION_DEFERRED =
  'Unit conversions are not available. The product defines no conversion factor between units, and '
  + 'inventing one would mean deciding how many of something is in a box — a fact about your goods '
  + 'rather than about the software. An item is measured in one base unit until conversions are '
  + 'modelled properly.';

export interface UnitInput {
  code: string;
  name: string;
  symbol?: string;
  category?: string;
  decimalPlaces?: number;
}

export interface UnitRecord {
  id: string;
  code: string;
  name: string;
  symbol: string;
  category: string;
  decimalPlaces: number;
  status: string;
  isSystem: boolean;
  version: number;
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
const hydrate = (row: any): UnitRecord => ({
  id: row.id,
  code: row.code,
  name: row.name,
  symbol: row.symbol ?? '',
  category: row.category,
  decimalPlaces: Number(row.decimal_places ?? 0),
  status: row.status,
  isSystem: Boolean(row.is_system),
  version: Number(row.version),
});

export async function listUnits(
  db: Kysely<Database>,
  actor: InventoryActor,
  query: { status?: string; search?: string } = {},
): Promise<UnitRecord[]> {
  /* Seeding on read, because an item requires a base unit while the unit
   * MANAGEMENT screen is an Inventory feature: a subscriber entitled to the
   * shared catalogue but not to Inventory would otherwise have nothing to pick
   * and no way to make one. Idempotent — it inserts only into an empty
   * register, and the unique index settles a race. */
  await ensureBaseUnits(db, actor);

  let builder = db
    .selectFrom('units_of_measure')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId);

  if (query.status) builder = builder.where('status', '=', query.status);
  if (query.search) {
    const term = `%${query.search.trim().toLowerCase()}%`;
    builder = builder.where((eb) => eb.or([
      eb(eb.fn('lower', ['code']), 'like', term),
      eb(eb.fn('lower', ['name']), 'like', term),
    ]));
  }

  const rows = await builder.orderBy('code', 'asc').execute();
  return rows.map(hydrate);
}

export async function getUnit(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
): Promise<UnitRecord> {
  const row = await db
    .selectFrom('units_of_measure')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw errors.notFound('Unit of measure');
  return hydrate(row);
}

function assertShape(input: UnitInput): void {
  const fieldErrors: Record<string, string> = {};
  if (!trimmed(input.code)) fieldErrors.code = 'A unit code is required.';
  if (!trimmed(input.name)) fieldErrors.name = 'A unit name is required.';
  if (input.category
      && !UNIT_CATEGORIES.includes(input.category as (typeof UNIT_CATEGORIES)[number])) {
    fieldErrors.category = 'Choose one of the supported unit categories.';
  }
  const dp = input.decimalPlaces ?? 0;
  if (!Number.isInteger(dp) || dp < 0 || dp > 6) {
    fieldErrors.decimalPlaces = 'Quantity decimal places must be a whole number from 0 to 6.';
  }
  if (Object.keys(fieldErrors).length) {
    throw errors.validation('Check the unit details and try again.', { fieldErrors });
  }
}

const DUPLICATES = {
  units_of_measure_code_uidx: 'That unit code is already used in these books.',
};

export async function createUnit(
  db: Kysely<Database>,
  actor: InventoryActor,
  input: UnitInput,
): Promise<UnitRecord> {
  assertShape(input);

  const id = await db.transaction().execute(async (trx) => {
    let created: { id: string };
    try {
      created = await trx
        .insertInto('units_of_measure')
        .values({
          organization_id: actor.organizationId,
          company_id: actor.companyId,
          code: trimmed(input.code),
          name: trimmed(input.name),
          symbol: trimmed(input.symbol),
          category: input.category ?? 'quantity',
          decimal_places: input.decimalPlaces ?? 0,
          created_by: actor.userId,
          updated_by: actor.userId,
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow();
    } catch (cause) {
      asDuplicate(cause, DUPLICATES);
    }

    await writeInventoryAudit(trx, actor, {
      subjectType: 'unit',
      subjectId: created.id,
      action: 'UNIT_CREATED',
      resultingVersion: 1,
      detail: { code: trimmed(input.code) },
    });
    return created.id;
  });

  return getUnit(db, actor, id);
}

export async function updateUnit(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
  expectedVersion: number,
  input: UnitInput,
): Promise<UnitRecord> {
  assertShape(input);

  await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('units_of_measure')
      .select(['id', 'version', 'code'])
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();

    if (!current) throw errors.notFound('Unit of measure');
    assertVersion(Number(current.version), expectedVersion);

    const nextVersion = Number(current.version) + 1;
    try {
      await trx
        .updateTable('units_of_measure')
        .set({
          code: trimmed(input.code),
          name: trimmed(input.name),
          symbol: trimmed(input.symbol),
          category: input.category ?? 'quantity',
          decimal_places: input.decimalPlaces ?? 0,
          version: nextVersion,
          updated_by: actor.userId,
          updated_at: new Date(),
        } as never)
        .where('organization_id', '=', actor.organizationId)
        .where('company_id', '=', actor.companyId)
        .where('id', '=', id)
        .execute();
    } catch (cause) {
      asDuplicate(cause, DUPLICATES);
    }

    await writeInventoryAudit(trx, actor, {
      subjectType: 'unit',
      subjectId: id,
      action: 'UNIT_UPDATED',
      resultingVersion: nextVersion,
      detail: { code: trimmed(input.code) },
    });
  });

  return getUnit(db, actor, id);
}

/**
 * Archive or bring back.
 *
 * A unit still measuring an active item may not be archived: the item would go
 * on being measured in something the company has retired, and the picker would
 * offer no way to correct it. The refusal names the count, because "in use" is
 * not an answer anybody can act on.
 */
export async function setUnitArchived(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
  expectedVersion: number,
  archived: boolean,
): Promise<UnitRecord> {
  await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('units_of_measure')
      .select(['id', 'version', 'code'])
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();

    if (!current) throw errors.notFound('Unit of measure');
    assertVersion(Number(current.version), expectedVersion);

    if (archived) {
      const users = await trx
        .selectFrom('inventory_items')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('organization_id', '=', actor.organizationId)
        .where('company_id', '=', actor.companyId)
        .where('base_unit_id', '=', id)
        .where('status', '!=', 'archived')
        .executeTakeFirst();
      const count = Number(users?.n ?? '0');
      if (count > 0) {
        throw errors.validation(
          `Unit ${current.code} still measures ${count} active item(s) and cannot be archived. `
          + 'Move those items to another unit first.',
          { fieldErrors: { status: `${count} active item(s) use this unit.` } },
        );
      }
    }

    const nextVersion = Number(current.version) + 1;
    await trx
      .updateTable('units_of_measure')
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
      subjectType: 'unit',
      subjectId: id,
      action: archived ? 'UNIT_ARCHIVED' : 'UNIT_REACTIVATED',
      resultingVersion: nextVersion,
      detail: { code: current.code },
    });
  });

  return getUnit(db, actor, id);
}

export async function countUnits(
  db: Kysely<Database>,
  actor: InventoryActor,
): Promise<number> {
  const row = await db
    .selectFrom('units_of_measure')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .executeTakeFirst();
  return Number(row?.n ?? '0');
}

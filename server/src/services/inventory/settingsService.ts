/**
 * The company's inventory accounting profile.
 *
 * ══ What this is for ═════════════════════════════════════════════════════════
 *
 * The accounts a stock movement will one day post through, decided once for the
 * company and overridable per item. Established precedence is item → category →
 * company settings → a well-known chart code; the category layer is absent in
 * I1 because nothing posts yet, so a middle tier would be a mapping no code
 * reads. It returns with the movements that need it.
 *
 * ══ Why no journal is written here ═══════════════════════════════════════════
 *
 * Changing where inventory posts does not restate what has already posted. A
 * document froze its accounts when it was issued, and a later mapping change
 * must never reach back into it — so this writes configuration and an audit
 * line, and nothing else. When movements arrive they will freeze their accounts
 * at posting time exactly as invoices and bills already do.
 *
 * ══ Why the default warehouse is here rather than on the warehouse ═══════════
 *
 * One pointer makes "more than one default" unrepresentable. A flag on every
 * row would make it a rule two concurrent writers could break.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import {
  type InventoryActor,
  assertAccountForRole,
  assertVersion,
  writeInventoryAudit,
} from './inventoryCore.js';

export interface InventorySettingsInput {
  defaultValuationMethod?: string;
  defaultWarehouseId?: string | null;
  defaultInventoryAccountId?: string | null;
  defaultCogsAccountId?: string | null;
  defaultSalesAccountId?: string | null;
  defaultPurchaseAccountId?: string | null;
  inventoryGainAccountId?: string | null;
  inventoryLossAccountId?: string | null;
  stockInTransitAccountId?: string | null;
  /** Where a standalone receipt's offset lands. Required before receiving. */
  goodsReceivedNotInvoicedAccountId?: string | null;
}

export interface InventorySettingsRecord extends Required<
  Omit<InventorySettingsInput, 'defaultValuationMethod'>
> {
  defaultValuationMethod: string;
  version: number;
}

const EMPTY: InventorySettingsRecord = {
  defaultValuationMethod: 'weighted-average',
  defaultWarehouseId: null,
  defaultInventoryAccountId: null,
  defaultCogsAccountId: null,
  defaultSalesAccountId: null,
  defaultPurchaseAccountId: null,
  inventoryGainAccountId: null,
  inventoryLossAccountId: null,
  stockInTransitAccountId: null,
  goodsReceivedNotInvoicedAccountId: null,
  version: 0,
};

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
const hydrate = (row: any): InventorySettingsRecord => ({
  defaultValuationMethod: row.default_valuation_method,
  defaultWarehouseId: row.default_warehouse_id ?? null,
  defaultInventoryAccountId: row.default_inventory_account_id ?? null,
  defaultCogsAccountId: row.default_cogs_account_id ?? null,
  defaultSalesAccountId: row.default_sales_account_id ?? null,
  defaultPurchaseAccountId: row.default_purchase_account_id ?? null,
  inventoryGainAccountId: row.inventory_gain_account_id ?? null,
  inventoryLossAccountId: row.inventory_loss_account_id ?? null,
  stockInTransitAccountId: row.stock_in_transit_account_id ?? null,
  goodsReceivedNotInvoicedAccountId: row.goods_received_not_invoiced_account_id ?? null,
  version: Number(row.version),
});

/**
 * The company's profile, or an unsaved one.
 *
 * `version: 0` means "no row yet" and is what an update must send to create
 * one. A missing profile is not an error: a company that has never configured
 * inventory has simply not configured it.
 */
export async function getSettings(
  db: Kysely<Database>,
  actor: InventoryActor,
): Promise<InventorySettingsRecord> {
  const row = await db
    .selectFrom('inventory_settings')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .executeTakeFirst();
  return row ? hydrate(row) : { ...EMPTY };
}

async function assertReferences(
  db: Kysely<Database>,
  actor: InventoryActor,
  input: InventorySettingsInput,
): Promise<void> {
  if (input.defaultValuationMethod
      && !['weighted-average', 'standard'].includes(input.defaultValuationMethod)) {
    throw errors.validation(
      'A company default valuation method must be weighted-average or standard.',
      { fieldErrors: { defaultValuationMethod: 'Choose weighted-average or standard.' } },
    );
  }

  if (input.defaultWarehouseId) {
    const warehouse = await db
      .selectFrom('warehouses')
      .select(['id', 'code', 'status'])
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', input.defaultWarehouseId)
      .executeTakeFirst();
    if (!warehouse) {
      throw errors.validation('That warehouse does not exist in these books.', {
        fieldErrors: { defaultWarehouseId: 'Choose a warehouse from this company.' },
      });
    }
    if (warehouse.status !== 'active') {
      throw errors.validation(
        `Warehouse ${warehouse.code} is ${warehouse.status} and cannot be the default.`,
        { fieldErrors: { defaultWarehouseId: 'Choose an active warehouse.' } },
      );
    }
  }

  await assertAccountForRole(
    db, actor, 'inventory', input.defaultInventoryAccountId, 'defaultInventoryAccountId',
  );
  await assertAccountForRole(db, actor, 'cogs', input.defaultCogsAccountId, 'defaultCogsAccountId');
  await assertAccountForRole(db, actor, 'sales', input.defaultSalesAccountId, 'defaultSalesAccountId');
  await assertAccountForRole(
    db, actor, 'purchase', input.defaultPurchaseAccountId, 'defaultPurchaseAccountId',
  );
  await assertAccountForRole(db, actor, 'gain', input.inventoryGainAccountId, 'inventoryGainAccountId');
  await assertAccountForRole(db, actor, 'loss', input.inventoryLossAccountId, 'inventoryLossAccountId');
  await assertAccountForRole(
    db, actor, 'transit', input.stockInTransitAccountId, 'stockInTransitAccountId',
  );
  /*
   * The receipt offset. Deliberately typeless -- a business may accrue goods
   * received into a liability or hold them in a clearing asset -- but the
   * shared rules still apply: same company, active, postable, never cash.
   */
  await assertAccountForRole(
    db, actor, 'grni', input.goodsReceivedNotInvoicedAccountId,
    'goodsReceivedNotInvoicedAccountId',
  );
}

export async function updateSettings(
  db: Kysely<Database>,
  actor: InventoryActor,
  expectedVersion: number,
  input: InventorySettingsInput,
): Promise<InventorySettingsRecord> {
  await assertReferences(db, actor, input);

  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const values: Record<string, any> = {
    default_valuation_method: input.defaultValuationMethod ?? 'weighted-average',
    default_warehouse_id: input.defaultWarehouseId ?? null,
    default_inventory_account_id: input.defaultInventoryAccountId ?? null,
    default_cogs_account_id: input.defaultCogsAccountId ?? null,
    default_sales_account_id: input.defaultSalesAccountId ?? null,
    default_purchase_account_id: input.defaultPurchaseAccountId ?? null,
    inventory_gain_account_id: input.inventoryGainAccountId ?? null,
    inventory_loss_account_id: input.inventoryLossAccountId ?? null,
    stock_in_transit_account_id: input.stockInTransitAccountId ?? null,
    goods_received_not_invoiced_account_id: input.goodsReceivedNotInvoicedAccountId ?? null,
    updated_by: actor.userId,
  };

  await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('inventory_settings')
      .select('version')
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .forUpdate()
      .executeTakeFirst();

    if (!current) {
      /* No profile yet. `expectedVersion` 0 is the caller saying so; anything
       * else means they are editing a row that has since been removed. */
      assertVersion(0, expectedVersion);
      await trx
        .insertInto('inventory_settings')
        .values({
          organization_id: actor.organizationId,
          company_id: actor.companyId,
          created_by: actor.userId,
          version: 1,
          ...values,
        } as never)
        .execute();
      await writeInventoryAudit(trx, actor, {
        subjectType: 'settings',
        action: 'INVENTORY_SETTINGS_CREATED',
        resultingVersion: 1,
        detail: { ...input },
      });
      return;
    }

    assertVersion(Number(current.version), expectedVersion);
    const nextVersion = Number(current.version) + 1;
    await trx
      .updateTable('inventory_settings')
      .set({ ...values, version: nextVersion, updated_at: new Date() } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .execute();

    /* Audited because a mapping change decides where future cost lands, and
     * somebody will eventually need to know when it changed and who did it. */
    await writeInventoryAudit(trx, actor, {
      subjectType: 'settings',
      action: 'INVENTORY_SETTINGS_UPDATED',
      resultingVersion: nextVersion,
      detail: { ...input },
    });
  });

  return getSettings(db, actor);
}

/**
 * The stock a supplier bill brings in.
 *
 * ══ Why this exists rather than a second posting path ════════════════════════
 *
 * A stocked bill is one document that does two things: it records what is owed
 * and it records what arrived. The bill's own journal already debits inventory
 * and credits the payable in a single balanced entry, so the movements it
 * produces must NOT post a journal of their own — a second one would double
 * both the asset and the liability.
 *
 * So the stock document created here carries the BILL's journal id. The
 * subledger and the general ledger then read the same figure from the same
 * entry, which is what makes them reconcile exactly rather than nearly.
 *
 * ══ Why the cost is the line's taxable amount ════════════════════════════════
 *
 * Recoverable input tax is not part of what stock cost the business — it is a
 * claim on an authority. The bill's journal debits inventory with the line's
 * TAXABLE amount and debits the recoverable tax separately, so the movement is
 * costed at the same taxable amount. Under an inclusive tax code that is the
 * figure left after the tax is extracted, which is the cost either way.
 *
 * ══ What this deliberately is not ════════════════════════════════════════════
 *
 * There is no goods-received-not-invoiced clearing here, and no matching. This
 * product recognises a stocked purchase when the bill posts — `useGrni` is
 * seeded false and read by nothing, and `purchaseRecognitionMode` is `on-bill`
 * and likewise read by nothing — so inventory and the liability arise together
 * and there is nothing to match them against. Receipt-first purchasing, price
 * variance and three-way matching are decisions this product has not made.
 */
import { sql, type Transaction } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import * as Money from '../accounting/money.js';
import { type InventoryActor, writeInventoryAudit } from './inventoryCore.js';
import {
  SUPPORTED_VALUATION,
  UNSUPPORTED_VALUATION,
  lockItems,
  latestPostingDate,
  onHandAt,
  toQuantity,
} from './stockLedger.js';

export interface BillReceiptLine {
  /** The bill line this stock came from, for the audit trail. */
  billLineId: string;
  lineNumber: number;
  itemId: string;
  warehouseId: string;
  /** Exact decimal strings, already validated by the bill. */
  quantity: string;
  /** The line's TAXABLE amount — what the bill's journal debits inventory. */
  totalCost: string;
}

export interface ResolvedStockedItem {
  id: string;
  code: string;
  name: string;
  baseUnitId: string;
  baseUnitCode: string;
  unitDecimals: number;
  inventoryAccountId: string;
}

export const BILL_BACKDATING_REFUSED =
  'This bill would bring stock in before that item\'s most recent movement. Costs already posted '
  + 'are never recalculated in this product, so a movement inserted behind an existing issue would '
  + 'leave that issue costed against a position it no longer describes. Post the bill on or after '
  + 'that date, or reverse the later stock documents first.';

/**
 * The item a stocked bill line may name.
 *
 * Every rule the stock ledger applies to a movement applies here too, checked
 * at the moment of posting rather than when the line was typed: an item can be
 * archived, or re-typed as a service, between the two.
 */
export async function resolveStockedItem(
  trx: Transaction<Database>,
  actor: InventoryActor,
  itemId: string,
  at: number,
): Promise<ResolvedStockedItem> {
  const row = await trx
    .selectFrom('inventory_items as i')
    .innerJoin('units_of_measure as u', (join) => join
      .onRef('u.id', '=', 'i.base_unit_id')
      .onRef('u.organization_id', '=', 'i.organization_id')
      .onRef('u.company_id', '=', 'i.company_id'))
    .select([
      'i.id', 'i.item_code', 'i.name', 'i.status', 'i.is_inventory_tracked', 'i.item_type',
      'i.valuation_method', 'i.base_unit_id', 'i.inventory_account_id',
      'u.code as unit_code', 'u.decimal_places as unit_decimals',
    ])
    .where('i.organization_id', '=', actor.organizationId)
    .where('i.company_id', '=', actor.companyId)
    .where('i.id', '=', itemId)
    .executeTakeFirst();

  const field = `lines.${at}.itemId`;
  if (!row) {
    throw errors.validation(`Line ${at} names an item that is not in this company's catalogue.`, {
      fieldErrors: { [field]: 'Choose an item from this company.' },
    });
  }
  if (row.status !== 'active') {
    throw errors.validation(
      `Item ${row.item_code} is ${row.status} and cannot be purchased into stock.`,
      { fieldErrors: { [field]: 'Reactivate the item first.' } },
    );
  }
  if (!row.is_inventory_tracked) {
    throw errors.validation(
      `Item ${row.item_code} is not stock-tracked, so buying it does not increase any quantity. `
      + `Record a ${row.item_type} purchase as an ordinary expense line instead.`,
      { fieldErrors: { [field]: 'This item holds no stock.' } },
    );
  }
  if (row.valuation_method !== SUPPORTED_VALUATION) {
    throw errors.validation(UNSUPPORTED_VALUATION(row.valuation_method, row.item_code), {
      fieldErrors: { [field]: 'Only weighted-average items can move.' },
    });
  }

  /*
   * An item with no inventory account of its own cannot fall back to the
   * company default here: the bill's journal debits the account named ON THE
   * LINE, and a line whose account is not the item's stock account would credit
   * the payable while debiting something else entirely.
   */
  if (!row.inventory_account_id) {
    throw errors.validation(
      `Item ${row.item_code} has no inventory account, so a stocked purchase of it has nowhere to `
      + 'post. Set one on the item before buying it into stock.',
      { fieldErrors: { [field]: 'Give the item an inventory account.' } },
    );
  }

  return {
    id: row.id,
    code: row.item_code,
    name: row.name,
    baseUnitId: row.base_unit_id,
    baseUnitCode: row.unit_code,
    unitDecimals: Number(row.unit_decimals ?? 0),
    inventoryAccountId: row.inventory_account_id,
  };
}

export async function resolveStockedWarehouse(
  trx: Transaction<Database>,
  actor: InventoryActor,
  warehouseId: string,
  at: number,
): Promise<{ id: string; code: string }> {
  const row = await trx
    .selectFrom('warehouses')
    .select(['id', 'code', 'status'])
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', warehouseId)
    .executeTakeFirst();

  const field = `lines.${at}.warehouseId`;
  if (!row) {
    throw errors.validation(`Line ${at} names a warehouse that is not in these books.`, {
      fieldErrors: { [field]: 'Choose a warehouse from this company.' },
    });
  }
  if (row.status !== 'active') {
    throw errors.validation(
      `Warehouse ${row.code} is ${row.status} and cannot receive stock.`,
      { fieldErrors: { [field]: 'Choose an active warehouse.' } },
    );
  }
  return { id: row.id, code: row.code };
}

async function allocateNumber(
  trx: Transaction<Database>,
  actor: InventoryActor,
  postingDate: string,
): Promise<string> {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${`inv_doc_number:${actor.organizationId}:${actor.companyId}:bill-receipt`})
    )
  `.execute(trx);

  const existing = await trx
    .selectFrom('inventory_document_numbering')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('kind', '=', 'bill-receipt')
    .forUpdate()
    .executeTakeFirst();

  const config = existing ?? {
    prefix: 'BRC-', include_year: true, sequence_length: 4, next_sequence: 1,
  };

  if (!existing) {
    await trx.insertInto('inventory_document_numbering').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      kind: 'bill-receipt',
      prefix: 'BRC-',
      next_sequence: 2,
    } as never).execute();
  } else {
    await trx.updateTable('inventory_document_numbering')
      .set({ next_sequence: config.next_sequence + 1, updated_at: new Date() } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('kind', '=', 'bill-receipt')
      .execute();
  }

  const year = config.include_year ? `${postingDate.slice(0, 4)}-` : '';
  return `${config.prefix}${year}${String(config.next_sequence).padStart(config.sequence_length, '0')}`;
}

/**
 * Bring a posted bill's stock into the ledger.
 *
 * Called from inside the bill's own posting transaction, AFTER its journal
 * exists, so the stock document can carry that journal rather than make one.
 */
export async function postBillReceipt(
  trx: Transaction<Database>,
  actor: InventoryActor,
  input: {
    billId: string;
    billNumber: string;
    journalEntryId: string;
    movementDate: string;
    postingDate: string;
    lines: BillReceiptLine[];
    items: Map<string, ResolvedStockedItem>;
    warehouses: Map<string, { id: string; code: string }>;
  },
): Promise<{ documentId: string; movements: number }> {
  if (input.lines.length === 0) throw errors.validation('No stocked lines to receive.');

  /* Sorted, for the same reason every other stock write sorts: a deterministic
   * order is what stops two documents touching the same items deadlocking. */
  await lockItems(trx, actor, input.lines.map((line) => line.itemId));

  for (const line of input.lines) {
    const item = input.items.get(line.itemId)!;
    const latest = await latestPostingDate(trx, actor, line.itemId);
    if (latest && input.postingDate < latest) {
      throw errors.validation(
        `${BILL_BACKDATING_REFUSED} Item ${item.code} already has a movement posted on ${latest}.`,
        { fieldErrors: { postingDate: `On or after ${latest}.` } },
      );
    }
  }

  const documentNumber = await allocateNumber(trx, actor, input.postingDate);

  const created = await trx
    .insertInto('inventory_documents')
    .values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      document_number: documentNumber,
      kind: 'bill-receipt',
      movement_date: input.movementDate,
      posting_date: input.postingDate,
      reference: input.billNumber,
      memo: `Stock received on bill ${input.billNumber}`,
      /* The BILL's journal. This document posts none of its own. */
      journal_entry_id: input.journalEntryId,
      source_bill_id: input.billId,
      idempotency_key: `bill:${input.billId}:receipt`,
      created_by: actor.userId,
    } as never)
    .returning('id')
    .executeTakeFirstOrThrow();

  let lineNumber = 0;
  for (const line of input.lines) {
    const item = input.items.get(line.itemId)!;
    const warehouse = input.warehouses.get(line.warehouseId)!;
    const quantity = toQuantity(line.quantity, item.unitDecimals, `lines.${line.lineNumber}.quantity`);
    const total = Money.toAmount(line.totalCost, 'totalCost');
    /* Derived, never sent: the unit cost is what the line actually cost divided
     * by what actually arrived. */
    const unitCost = quantity === 0n
      ? Money.ZERO
      : (total * 10n ** BigInt(Money.SCALE)) / quantity;

    lineNumber += 1;
    await trx.insertInto('inventory_movements').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      document_id: created.id,
      line_number: lineNumber,
      movement_type: 'receipt',
      item_id: item.id,
      warehouse_id: warehouse.id,
      base_unit_id: item.baseUnitId,
      direction: 'in',
      quantity: Money.toDecimalString(quantity),
      unit_cost: Money.toDecimalString(unitCost),
      total_cost: Money.toDecimalString(total),
      inventory_account_id: item.inventoryAccountId,
      /* The offset is the payable, and it is the BILL's credit — recorded here
       * so a reader can see where the other side went without leaving the
       * subledger. */
      offset_account_id: null,
      item_code: item.code,
      item_name: item.name,
      warehouse_code: warehouse.code,
      base_unit_code: item.baseUnitCode,
      movement_date: input.movementDate,
      posting_date: input.postingDate,
      created_by: actor.userId,
    } as never).execute();
  }

  await writeInventoryAudit(trx, actor, {
    subjectType: 'item',
    subjectId: null,
    action: 'STOCK_RECEIVED_ON_BILL',
    resultingVersion: 1,
    detail: { billId: input.billId, billNumber: input.billNumber, documentNumber, lines: lineNumber },
  });

  return { documentId: created.id, movements: lineNumber };
}

export const BILL_REVERSAL_CONSUMED =
  'This bill brought stock in that has since been used. Reversing it would take out more than is '
  + 'there and leave the warehouse below zero, so the position cannot be restored exactly. Record '
  + 'a supplier return or a correcting adjustment instead.';

/**
 * Take a reversed bill's stock back out.
 *
 * Called from inside the bill's reversal transaction, after its reversing
 * journal exists. Both the original movements and their counters are marked
 * reversed, so the pair leaves every sum — the same "as if it never happened"
 * restoration the rest of the stock ledger uses.
 */
export async function reverseBillReceipt(
  trx: Transaction<Database>,
  actor: InventoryActor,
  input: {
    billId: string;
    billNumber: string;
    reversalJournalEntryId: string;
    reason: string;
  },
): Promise<{ reversed: number } | null> {
  const original = await trx
    .selectFrom('inventory_documents')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('source_bill_id', '=', input.billId)
    .where('kind', '=', 'bill-receipt')
    .where('status', '=', 'posted')
    .forUpdate()
    .executeTakeFirst();

  /* A bill with no stocked lines has nothing here, which is not an error. */
  if (!original) return null;

  const movements = await trx
    .selectFrom('inventory_movements')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('document_id', '=', original.id)
    .orderBy('line_number', 'asc')
    .execute();

  await lockItems(trx, actor, movements.map((m) => m.item_id));

  /*
   * Every unit this bill brought in must still be there. If it is not, the
   * stock has been issued, transferred or adjusted away, and taking it back out
   * would drive a warehouse below zero — which this product refuses.
   */
  for (const movement of movements) {
    const available = await onHandAt(trx, actor, movement.item_id, movement.warehouse_id);
    const quantity = Money.toAmount(movement.quantity, 'quantity');
    if (available < quantity) {
      throw errors.conflict(
        `${BILL_REVERSAL_CONSUMED} ${movement.item_code}: ${Money.describe(available)} remain in `
        + `${movement.warehouse_code}, and bill ${input.billNumber} brought in `
        + `${Money.describe(quantity)}.`,
      );
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const documentNumber = await allocateNumber(trx, actor, today);

  const counter = await trx
    .insertInto('inventory_documents')
    .values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      document_number: documentNumber,
      kind: 'bill-receipt',
      movement_date: today,
      posting_date: today,
      reference: input.billNumber,
      memo: `Reversal of stock received on bill ${input.billNumber}`,
      status: 'reversed',
      journal_entry_id: input.reversalJournalEntryId,
      source_bill_id: input.billId,
      idempotency_key: `bill:${input.billId}:receipt-reversal`,
      reversal_of_document_id: original.id,
      reversal_reason: input.reason,
      created_by: actor.userId,
    } as never)
    .returning('id')
    .executeTakeFirstOrThrow();

  let line = 0;
  for (const movement of movements) {
    line += 1;
    const made = await trx
      .insertInto('inventory_movements')
      .values({
        organization_id: actor.organizationId,
        company_id: actor.companyId,
        document_id: counter.id,
        line_number: line,
        movement_type: 'adjustment-out',
        item_id: movement.item_id,
        warehouse_id: movement.warehouse_id,
        base_unit_id: movement.base_unit_id,
        direction: 'out',
        quantity: movement.quantity,
        /* The ORIGINAL cost, never today's average. */
        unit_cost: movement.unit_cost,
        total_cost: movement.total_cost,
        inventory_account_id: movement.inventory_account_id,
        offset_account_id: movement.offset_account_id,
        item_code: movement.item_code,
        item_name: movement.item_name,
        warehouse_code: movement.warehouse_code,
        base_unit_code: movement.base_unit_code,
        movement_date: today,
        posting_date: today,
        status: 'reversed',
        reversal_of_movement_id: movement.id,
        created_by: actor.userId,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx.updateTable('inventory_movements')
      .set({ status: 'reversed', reversed_by_movement_id: made.id } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', movement.id)
      .execute();
  }

  await trx.updateTable('inventory_documents')
    .set({
      status: 'reversed',
      reversed_by_document_id: counter.id,
      reversal_reason: input.reason,
      version: Number(original.version) + 1,
      updated_at: new Date(),
    } as never)
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', original.id)
    .execute();

  await writeInventoryAudit(trx, actor, {
    subjectType: 'item',
    subjectId: null,
    action: 'STOCK_RECEIPT_REVERSED_WITH_BILL',
    resultingVersion: Number(original.version) + 1,
    detail: { billId: input.billId, billNumber: input.billNumber, reason: input.reason },
  });

  return { reversed: line };
}

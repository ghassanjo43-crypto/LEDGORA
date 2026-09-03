/**
 * The stock a sales invoice takes out, and what it cost.
 *
 * ══ Why this posts a journal of its own ══════════════════════════════════════
 *
 * I3's stocked bill does the opposite: its stock document carries the BILL's
 * journal, because a bill debits inventory and credits the payable in one
 * balanced entry and a second journal would double both sides.
 *
 * A sale is not symmetrical with that, and the asymmetry is the whole design.
 * The invoice's entry is Dr Receivable / Cr Revenue / Cr Output Tax — it has no
 * inventory leg at all, because what the customer owes has nothing to do with
 * what the goods cost. Cost of sales is a second, separate measurement, made
 * against a position the revenue entry never reads. So it is a second balanced
 * entry: Dr Cost of Sales / Cr Inventory, linked to the same invoice.
 *
 * That is the product's own rule, not a choice made here. The browser's builder
 * states it: "The COGS half of an inventory invoice: Dr COGS / Cr Inventory at
 * average cost... The revenue/tax/receivable half is posted by the invoice
 * itself, so COGS posts exactly once."
 *
 * Both entries go through the same source-posting door under the same source
 * id, distinguished only by their event. So the pair is idempotent together:
 * `journal_entries_source_event_unique` will not let a retry post a second
 * revenue entry OR a second cost entry, and neither can exist without the
 * other, because both are written in the invoice's one transaction.
 *
 * ══ Why the cost is not on the request ═══════════════════════════════════════
 *
 * Nothing here reads a cost from the caller. The cost of what left is the
 * weighted average prevailing in these books at the moment of posting, computed
 * by `outboundCost` from the movements themselves. A caller that could name it
 * could report whatever margin it liked.
 *
 * ══ What this deliberately is not ════════════════════════════════════════════
 *
 * There is no delivery here, and no partial fulfilment. This product has no
 * sales order, delivery note, shipment or reservation — not as an entity, a
 * table, a status or a lifecycle — and `salesRecognitionMode` is 'on-invoice',
 * the only value it is ever given and read by no branch anywhere. Stock leaves
 * when the invoice is issued because that is the only moment this product has
 * ever defined. Separate delivery fulfilment remains deferred.
 */
import { sql, type Transaction } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import * as Money from '../accounting/money.js';
import { postSourceJournalIn } from '../accounting/sourcePostingService.js';
import type { AccountingActor } from '../accounting/audit.js';
import { type InventoryActor, writeInventoryAudit } from './inventoryCore.js';
import {
  SUPPORTED_VALUATION,
  UNSUPPORTED_VALUATION,
  lockItems,
  latestPostingDate,
  onHandAt,
  positionOf,
  outboundCost,
  toQuantity,
} from './stockLedger.js';

/** The source event the cost-of-sales entry is filed under. */
export const COST_OF_SALES_EVENT = 'cost-of-sales';
/** And its reversal, so a void is idempotent the same way. */
export const COST_OF_SALES_REVERSAL_EVENT = 'cost-of-sales-reversal';

/*
 * The same actor, told to the stock ledger.
 *
 * `AccountingActor` carries a nullable request id and `InventoryActor` does
 * not. Narrowed once here rather than at every call site, so the two halves of
 * this file cannot drift into disagreeing about who is acting.
 */
const stockActor = (actor: AccountingActor): InventoryActor => ({
  organizationId: actor.organizationId,
  companyId: actor.companyId,
  userId: actor.userId,
  name: actor.name,
  requestId: actor.requestId ?? undefined,
});

export interface InvoiceIssueLine {
  /** The invoice line this stock left on, for the audit trail. */
  invoiceLineId: string;
  lineNumber: number;
  itemId: string;
  warehouseId: string;
  /** An exact decimal string, already validated by the invoice. */
  quantity: string;
  description: string;
}

export interface SoldItem {
  id: string;
  code: string;
  name: string;
  baseUnitId: string;
  baseUnitCode: string;
  unitDecimals: number;
  inventoryAccountId: string;
  cogsAccountId: string;
}

export const INVOICE_BACKDATING_REFUSED =
  'This invoice would take stock out before that item\'s most recent movement. Costs already '
  + 'posted are never recalculated in this product, so a movement inserted behind an existing one '
  + 'would be costed at an average that no longer describes the position it left. Issue the '
  + 'invoice on or after that date, or reverse the later stock documents first.';

export const INVOICE_NEGATIVE_STOCK_REFUSED =
  'This invoice would sell more than is in the warehouse. Negative stock is not permitted: the '
  + 'product models a policy for it in the browser only, and no controlled server setting exists, '
  + 'so allowing it here would be inventing an accounting position rather than applying one. '
  + 'Receive the stock first, or reduce the quantity.';

/**
 * The item a stocked invoice line may name.
 *
 * Every rule the stock ledger applies to a movement applies here too, and it is
 * checked at the moment of posting rather than when the line was typed: an item
 * can be archived, or re-typed as a service, between the two.
 */
export async function resolveSoldItem(
  trx: Transaction<Database>,
  actor: AccountingActor,
  itemId: string,
  at: number,
  defaultCogsAccountId: string | null,
): Promise<SoldItem> {
  const row = await trx
    .selectFrom('inventory_items as i')
    .innerJoin('units_of_measure as u', (join) => join
      .onRef('u.id', '=', 'i.base_unit_id')
      .onRef('u.organization_id', '=', 'i.organization_id')
      .onRef('u.company_id', '=', 'i.company_id'))
    .select([
      'i.id', 'i.item_code', 'i.name', 'i.status', 'i.is_inventory_tracked', 'i.item_type',
      'i.valuation_method', 'i.base_unit_id', 'i.inventory_account_id', 'i.cogs_account_id',
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
      `Item ${row.item_code} is ${row.status} and cannot be sold from stock.`,
      { fieldErrors: { [field]: 'Reactivate the item first.' } },
    );
  }
  if (!row.is_inventory_tracked) {
    throw errors.validation(
      `Item ${row.item_code} is not stock-tracked, so selling it reduces no quantity and has no `
      + `cost to recognise. Invoice a ${row.item_type} as an ordinary revenue line instead.`,
      { fieldErrors: { [field]: 'This item holds no stock.' } },
    );
  }
  if (row.valuation_method !== SUPPORTED_VALUATION) {
    throw errors.validation(UNSUPPORTED_VALUATION(row.valuation_method, row.item_code), {
      fieldErrors: { [field]: 'Only weighted-average items can move.' },
    });
  }
  if (!row.inventory_account_id) {
    throw errors.validation(
      `Item ${row.item_code} has no inventory account, so selling it has nothing to credit. `
      + 'Set one on the item before selling it from stock.',
      { fieldErrors: { [field]: 'Give the item an inventory account.' } },
    );
  }

  /*
   * The item's own account, then the company profile's — the fallback shape the
   * rest of the stock ledger already uses for the inventory side. Neither is
   * invented: both columns exist on the I1 accounting profile, and an item that
   * resolves to neither is refused rather than posted to a guess.
   */
  const cogsAccountId = row.cogs_account_id ?? defaultCogsAccountId;
  if (!cogsAccountId) {
    throw errors.validation(
      `Item ${row.item_code} has no cost-of-sales account, and this company has set no default, `
      + 'so the cost of selling it has nowhere to post. Set one on the item or on the inventory '
      + 'accounting profile.',
      { fieldErrors: { [field]: 'Give the item a cost-of-sales account.' } },
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
    cogsAccountId,
  };
}

export async function resolveSellingWarehouse(
  trx: Transaction<Database>,
  actor: AccountingActor,
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
      `Warehouse ${row.code} is ${row.status} and cannot ship stock.`,
      { fieldErrors: { [field]: 'Choose an active warehouse.' } },
    );
  }
  return { id: row.id, code: row.code };
}

/** The company's default cost-of-sales account, or null if it has set none. */
export async function defaultCogsAccount(
  trx: Transaction<Database>,
  actor: AccountingActor,
): Promise<string | null> {
  const row = await trx
    .selectFrom('inventory_settings')
    .select(['default_cogs_account_id'])
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .executeTakeFirst();
  return row?.default_cogs_account_id ?? null;
}

async function allocateNumber(
  trx: Transaction<Database>,
  actor: AccountingActor,
  postingDate: string,
): Promise<string> {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${`inv_doc_number:${actor.organizationId}:${actor.companyId}:invoice-issue`})
    )
  `.execute(trx);

  const existing = await trx
    .selectFrom('inventory_document_numbering')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('kind', '=', 'invoice-issue')
    .forUpdate()
    .executeTakeFirst();

  const config = existing ?? {
    prefix: 'SIS-', include_year: true, sequence_length: 4, next_sequence: 1,
  };

  if (!existing) {
    await trx.insertInto('inventory_document_numbering').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      kind: 'invoice-issue',
      prefix: 'SIS-',
      next_sequence: 2,
    } as never).execute();
  } else {
    await trx.updateTable('inventory_document_numbering')
      .set({ next_sequence: config.next_sequence + 1, updated_at: new Date() } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('kind', '=', 'invoice-issue')
      .execute();
  }

  const year = config.include_year ? `${postingDate.slice(0, 4)}-` : '';
  return `${config.prefix}${year}${String(config.next_sequence).padStart(config.sequence_length, '0')}`;
}

export interface IssuedCost {
  invoiceLineId: string;
  /** The average this line was actually costed at, frozen onto the line. */
  unitCost: string;
  totalCost: string;
}

/**
 * Take an issued invoice's stock out, and recognise what it cost.
 *
 * Called from inside the invoice's own issuing transaction, so the movements,
 * the cost entry and the invoice commit together or not at all.
 */
export async function postInvoiceIssue(
  trx: Transaction<Database>,
  actor: AccountingActor,
  input: {
    invoiceId: string;
    invoiceNumber: string;
    movementDate: string;
    postingDate: string;
    monetaryDecimals: number;
    lines: InvoiceIssueLine[];
    items: Map<string, SoldItem>;
    warehouses: Map<string, { id: string; code: string }>;
  },
): Promise<{ documentId: string; journalEntryId: string; costs: IssuedCost[] }> {
  if (input.lines.length === 0) throw errors.validation('No stocked lines to issue.');

  /*
   * Sorted, and taken BEFORE anything is read for costing. Two invoices selling
   * the same item concurrently must not both read the same position and cost
   * against it — one has to wait, or the second is costed at an average the
   * first has already moved and the warehouse can go below zero unnoticed.
   */
  await lockItems(trx, stockActor(actor), input.lines.map((line) => line.itemId));

  for (const line of input.lines) {
    const item = input.items.get(line.itemId)!;
    const latest = await latestPostingDate(trx, stockActor(actor), line.itemId);
    if (latest && input.postingDate < latest) {
      throw errors.validation(
        `${INVOICE_BACKDATING_REFUSED} Item ${item.code} already has a movement posted on ${latest}.`,
        { fieldErrors: { issueDate: `On or after ${latest}.` } },
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
      kind: 'invoice-issue',
      movement_date: input.movementDate,
      posting_date: input.postingDate,
      reference: input.invoiceNumber,
      memo: `Stock sold on invoice ${input.invoiceNumber}`,
      source_invoice_id: input.invoiceId,
      idempotency_key: `invoice:${input.invoiceId}:issue`,
      created_by: actor.userId,
    } as never)
    .returning('id')
    .executeTakeFirstOrThrow();

  const costs: IssuedCost[] = [];
  /* Accumulated per account, so several lines sharing a code produce one leg. */
  const debits = new Map<string, Money.Amount>();
  const credits = new Map<string, Money.Amount>();
  const add = (into: Map<string, Money.Amount>, accountId: string, value: Money.Amount): void => {
    into.set(accountId, (into.get(accountId) ?? Money.ZERO) + value);
  };

  let lineNumber = 0;
  for (const line of input.lines) {
    const item = input.items.get(line.itemId)!;
    const warehouse = input.warehouses.get(line.warehouseId)!;
    const quantity = toQuantity(line.quantity, item.unitDecimals, `lines.${line.lineNumber}.quantity`);
    /*
     * Availability is asked of the WAREHOUSE, because that is where the goods
     * either are or are not. Both reads happen after the lock and after every
     * earlier line of this same invoice has been written, so an invoice selling
     * the same item twice sees the first sale when it costs the second.
     */
    const available = await onHandAt(trx, stockActor(actor), item.id, warehouse.id);
    if (available < quantity) {
      throw errors.validation(
        `${INVOICE_NEGATIVE_STOCK_REFUSED} ${item.code} has ${Money.describe(available)} in `
        + `${warehouse.code} and this line sells ${Money.describe(quantity)}.`,
        {
          fieldErrors: {
            [`lines.${line.lineNumber}.quantity`]:
              `At most ${Money.describe(available)} available.`,
          },
        },
      );
    }

    /*
     * The cost is asked of the COMPANY, because the average is company-wide:
     * the same item costs the same whichever building it shipped from, and that
     * is why the lock is per item rather than per item-and-warehouse.
     * `outboundCost` costs a sale that empties the position at exactly what
     * remains, so selling three units bought for ten one at a time lands on
     * zero rather than stranding a fraction in an empty warehouse.
     */
    const position = await positionOf(trx, stockActor(actor), item.id);
    const total = outboundCost(position, quantity, input.monetaryDecimals);
    const unitCost = quantity === 0n
      ? Money.ZERO
      : (total * 10n ** BigInt(Money.SCALE)) / quantity;

    lineNumber += 1;
    await trx.insertInto('inventory_movements').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      document_id: created.id,
      line_number: lineNumber,
      movement_type: 'issue',
      item_id: item.id,
      warehouse_id: warehouse.id,
      base_unit_id: item.baseUnitId,
      direction: 'out',
      quantity: Money.toDecimalString(quantity),
      unit_cost: Money.toDecimalString(unitCost),
      total_cost: Money.toDecimalString(total),
      inventory_account_id: item.inventoryAccountId,
      /* Where the other side went, recorded so a reader never has to leave the
       * subledger to find the expense this sale recognised. */
      offset_account_id: item.cogsAccountId,
      item_code: item.code,
      item_name: item.name,
      warehouse_code: warehouse.code,
      base_unit_code: item.baseUnitCode,
      movement_date: input.movementDate,
      posting_date: input.postingDate,
      created_by: actor.userId,
    } as never).execute();

    add(debits, item.cogsAccountId, total);
    add(credits, item.inventoryAccountId, total);
    costs.push({
      invoiceLineId: line.invoiceLineId,
      unitCost: Money.toDecimalString(unitCost),
      totalCost: Money.toDecimalString(total),
    });
  }

  /*
   * One balanced entry for the whole invoice, posted through the same
   * source-posting door the revenue entry uses. Same source id, different
   * event: the unique constraint then makes a second cost entry for this
   * invoice impossible, independently of anything this service remembers.
   */
  const { journal } = await postSourceJournalIn(trx, actor, {
    sourceType: 'sales_invoice',
    sourceId: input.invoiceId,
    sourceEvent: COST_OF_SALES_EVENT,
    transactionDate: input.movementDate,
    postingDate: input.postingDate,
    reference: input.invoiceNumber,
    description: `Cost of sales — invoice ${input.invoiceNumber}`,
    lines: [
      ...[...debits.entries()].map(([accountId, value]) => ({
        accountId,
        debit: Money.toDecimalString(value),
        memo: `Cost of sales — ${input.invoiceNumber}`,
      })),
      ...[...credits.entries()].map(([accountId, value]) => ({
        accountId,
        credit: Money.toDecimalString(value),
        memo: `Stock sold — ${input.invoiceNumber}`,
      })),
    ],
  });

  await trx.updateTable('inventory_documents')
    .set({ journal_entry_id: journal.id } as never)
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', created.id)
    .execute();

  await writeInventoryAudit(trx, stockActor(actor), {
    subjectType: 'item',
    subjectId: null,
    action: 'STOCK_SOLD_ON_INVOICE',
    resultingVersion: 1,
    detail: {
      invoiceId: input.invoiceId,
      invoiceNumber: input.invoiceNumber,
      documentNumber,
      lines: lineNumber,
    },
  });

  return { documentId: created.id, journalEntryId: journal.id, costs };
}

/**
 * Put a voided invoice's stock back, and take its cost of sales off.
 *
 * Called from inside the invoice's voiding transaction. Both the original
 * movements and their counters are marked reversed, so the pair leaves every
 * sum — the same "as if it never happened" restoration the rest of the stock
 * ledger uses, and the same one I3 applies to a reversed bill.
 *
 * Unlike a reversed purchase, this can never be refused for want of stock: it
 * puts goods BACK, so no warehouse can be driven below zero by it. The counter
 * carries the ORIGINAL cost rather than today's average, so a sale reversed
 * after later purchases restores exactly the value it removed.
 */
export async function reverseInvoiceIssue(
  trx: Transaction<Database>,
  actor: AccountingActor,
  input: { invoiceId: string; invoiceNumber: string; reason: string },
): Promise<{ reversed: number; journalEntryId: string } | null> {
  const original = await trx
    .selectFrom('inventory_documents')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('source_invoice_id', '=', input.invoiceId)
    .where('kind', '=', 'invoice-issue')
    .where('status', '=', 'posted')
    .forUpdate()
    .executeTakeFirst();

  /* An invoice with no stocked lines has nothing here, which is not an error. */
  if (!original) return null;

  const movements = await trx
    .selectFrom('inventory_movements')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('document_id', '=', original.id)
    .orderBy('line_number', 'asc')
    .execute();

  await lockItems(trx, stockActor(actor), movements.map((m) => m.item_id));

  const today = new Date().toISOString().slice(0, 10);
  const documentNumber = await allocateNumber(trx, actor, today);

  const counter = await trx
    .insertInto('inventory_documents')
    .values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      document_number: documentNumber,
      kind: 'invoice-issue',
      movement_date: today,
      posting_date: today,
      reference: input.invoiceNumber,
      memo: `Reversal of stock sold on invoice ${input.invoiceNumber}`,
      status: 'reversed',
      source_invoice_id: input.invoiceId,
      idempotency_key: `invoice:${input.invoiceId}:issue-reversal`,
      reversal_of_document_id: original.id,
      reversal_reason: input.reason,
      created_by: actor.userId,
    } as never)
    .returning('id')
    .executeTakeFirstOrThrow();

  const debits = new Map<string, Money.Amount>();
  const credits = new Map<string, Money.Amount>();
  const add = (into: Map<string, Money.Amount>, accountId: string, value: Money.Amount): void => {
    into.set(accountId, (into.get(accountId) ?? Money.ZERO) + value);
  };

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
        movement_type: 'adjustment-in',
        item_id: movement.item_id,
        warehouse_id: movement.warehouse_id,
        base_unit_id: movement.base_unit_id,
        direction: 'in',
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

    const total = Money.toAmount(movement.total_cost, 'totalCost');
    add(debits, movement.inventory_account_id, total);
    if (movement.offset_account_id) add(credits, movement.offset_account_id, total);
  }

  /*
   * The mirror of the cost entry: Dr Inventory / Cr Cost of Sales, at the cost
   * that was actually recognised. Posted under its own event, so a retried void
   * cannot produce a second one.
   */
  const { journal } = await postSourceJournalIn(trx, actor, {
    sourceType: 'sales_invoice',
    sourceId: input.invoiceId,
    sourceEvent: COST_OF_SALES_REVERSAL_EVENT,
    transactionDate: today,
    postingDate: today,
    reference: input.invoiceNumber,
    description: `Cost of sales reversed — invoice ${input.invoiceNumber}`,
    lines: [
      ...[...debits.entries()].map(([accountId, value]) => ({
        accountId,
        debit: Money.toDecimalString(value),
        memo: `Stock returned — ${input.invoiceNumber}`,
      })),
      ...[...credits.entries()].map(([accountId, value]) => ({
        accountId,
        credit: Money.toDecimalString(value),
        memo: `Cost of sales reversed — ${input.invoiceNumber}`,
      })),
    ],
  });

  await trx.updateTable('inventory_documents')
    .set({ journal_entry_id: journal.id } as never)
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', counter.id)
    .execute();

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

  await writeInventoryAudit(trx, stockActor(actor), {
    subjectType: 'item',
    subjectId: null,
    action: 'STOCK_SALE_REVERSED_WITH_INVOICE',
    resultingVersion: Number(original.version) + 1,
    detail: {
      invoiceId: input.invoiceId,
      invoiceNumber: input.invoiceNumber,
      reason: input.reason,
    },
  });

  return { reversed: line, journalEntryId: journal.id };
}

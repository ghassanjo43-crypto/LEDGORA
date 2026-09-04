/**
 * Physical stock counts.
 *
 * ══ Why a count is one call ══════════════════════════════════════════════════
 *
 * The expected quantity is summed from posted movements INSIDE the posting
 * transaction, under the same item locks the rest of the stock ledger takes,
 * and the variance is measured against it there. So the number the variance is
 * computed from and the number the adjustment settles are the same number, read
 * once. No window exists in which a movement could arrive and make them
 * disagree, which is why this needs neither a warehouse freeze nor a
 * roll-forward rule — and this product establishes neither.
 *
 * A durable multi-session count would create that window, and something would
 * then have to say what happens inside it. Nothing here says. See migration 041
 * for the full reasoning; the short version is that inventing it would be
 * inventing warehouse-control policy, and the count this product actually has
 * needs none.
 *
 * ══ Why the book quantity is never accepted from a caller ════════════════════
 *
 * A client that could send the expected quantity could send any variance it
 * liked, and the adjustment would post it. The counted quantity is the only
 * figure a human can supply here, because it is the only one that comes from
 * outside the database — somebody walked the shelves. Everything else is read.
 *
 * ══ Why this posts through the I2 adjustment engine ══════════════════════════
 *
 * A count variance IS an inventory adjustment, and I2 already answers every
 * question one raises: the gain account for a positive and the loss account for
 * a negative, both from the company profile and re-checked at posting; an
 * inbound at the item's current average unless a validated cost is supplied; an
 * outbound at the weighted average; one balanced journal; period locks; and
 * backdating refused behind an item's last movement. Rewriting any of that here
 * would be a second answer to a question already answered.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import * as Money from '../accounting/money.js';
import { monetaryDecimalsFor, renderAmount } from '../accounting/currencyPrecision.js';
import { toCalendarDate } from '../accounting/calendarDate.js';
import { type InventoryActor, writeInventoryAudit } from './inventoryCore.js';
import {
  SUPPORTED_VALUATION, UNSUPPORTED_VALUATION, lockItems, onHandAt, toQuantity,
} from './stockLedger.js';
import { postDocumentIn, reverseDocument, type LineInput } from './stockDocumentService.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface CountLineInput {
  itemId: string;
  /** Exact, non-negative, at the unit's precision. The only figure a human supplies. */
  countedQuantity: string;
  /**
   * What a found unit is worth, for a POSITIVE variance only.
   *
   * Optional, and it follows I2's established adjustment rule exactly: with
   * none, stock comes in at what the item is currently worth. Sending one for a
   * negative variance is refused rather than ignored — an outbound is costed by
   * the ledger, never by the caller, and silently dropping the figure would let
   * somebody believe they had set it.
   */
  unitCost?: string | null;
  note?: string;
}

export interface CountInput {
  warehouseId: string;
  countDate: string;
  postingDate?: string;
  memo?: string;
  /** Required: an adjustment must say why stock changed. */
  reason: string;
  idempotencyKey: string;
  lines: CountLineInput[];
}

export interface CountLineRecord {
  id: string;
  lineNumber: number;
  itemId: string;
  itemCode: string;
  itemName: string;
  baseUnitCode: string;
  expectedQuantity: string;
  countedQuantity: string;
  varianceQuantity: string;
  unitCost: string;
  varianceValue: string;
  note: string;
}

export interface CountRecord {
  id: string;
  countNumber: string;
  status: 'posted' | 'reversed';
  warehouseId: string;
  warehouseCode: string;
  countDate: string;
  postingDate: string;
  memo: string;
  adjustmentDocumentId: string | null;
  adjustmentDocumentNumber: string | null;
  journalEntryId: string | null;
  reversalOfCountId: string | null;
  reversedByCountId: string | null;
  reversalReason: string;
  version: number;
  countedBy: string | null;
  createdAt: string;
  lines: CountLineRecord[];
}

export const COUNT_EMPTY =
  'A count needs at least one line. Counting nothing says nothing — a warehouse with no stock is '
  + 'recorded by counting its items at zero, not by submitting an empty sheet.';

export const COUNT_DUPLICATE_ITEM =
  'The same item appears twice in this count. One shelf produces one observation; two would be two '
  + 'different truths about the same quantity.';

export const COUNT_OUTBOUND_COST_REFUSED =
  'A unit cost may only be given for an item counted HIGHER than the books. Stock going out is '
  + 'costed at the weighted average these books hold, never at a figure supplied with the request.';

/* ══ Reading ═══════════════════════════════════════════════════════════════ */

async function decimalsFor(executor: Kysely<Database> | Transaction<Database>, actor: InventoryActor): Promise<number> {
  const org = await executor.selectFrom('organizations').select('base_currency')
    .where('id', '=', actor.organizationId).executeTakeFirst();
  return monetaryDecimalsFor(org?.base_currency);
}

/** The one renderer, shared with invoices, receipts and the stock reports. */
const display = renderAmount;

async function loadCount(
  executor: Kysely<Database> | Transaction<Database>,
  actor: InventoryActor,
  id: string,
): Promise<CountRecord> {
  const row = await executor
    .selectFrom('stock_counts as c')
    .innerJoin('warehouses as w', (join) => join
      .onRef('w.id', '=', 'c.warehouse_id')
      .onRef('w.organization_id', '=', 'c.organization_id')
      .onRef('w.company_id', '=', 'c.company_id'))
    .leftJoin('inventory_documents as d', (join) => join
      .onRef('d.id', '=', 'c.adjustment_document_id')
      .onRef('d.organization_id', '=', 'c.organization_id')
      .onRef('d.company_id', '=', 'c.company_id'))
    .select([
      'c.id', 'c.count_number', 'c.status', 'c.warehouse_id', 'c.count_date', 'c.posting_date',
      'c.memo', 'c.adjustment_document_id', 'c.reversal_of_count_id', 'c.reversed_by_count_id',
      'c.reversal_reason', 'c.version', 'c.counted_by', 'c.created_at',
      'w.code as warehouse_code',
      'd.document_number as adjustment_number', 'd.journal_entry_id as journal_entry_id',
    ])
    .where('c.organization_id', '=', actor.organizationId)
    .where('c.company_id', '=', actor.companyId)
    .where('c.id', '=', id)
    .executeTakeFirst();

  if (!row) throw errors.notFound('Stock count');

  const decimals = await decimalsFor(executor, actor);
  const lines = await executor
    .selectFrom('stock_count_lines')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('count_id', '=', id)
    .orderBy('line_number', 'asc')
    .execute();

  return {
    id: row.id,
    countNumber: row.count_number,
    status: row.status as 'posted' | 'reversed',
    warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code,
    countDate: toCalendarDate(row.count_date),
    postingDate: toCalendarDate(row.posting_date),
    memo: row.memo,
    adjustmentDocumentId: row.adjustment_document_id,
    adjustmentDocumentNumber: row.adjustment_number ?? null,
    journalEntryId: row.journal_entry_id ?? null,
    reversalOfCountId: row.reversal_of_count_id,
    reversedByCountId: row.reversed_by_count_id,
    reversalReason: row.reversal_reason,
    version: Number(row.version),
    countedBy: row.counted_by,
    createdAt: new Date(row.created_at as unknown as string).toISOString(),
    lines: lines.map((line) => ({
      id: line.id,
      lineNumber: line.line_number,
      itemId: line.item_id,
      itemCode: line.item_code,
      itemName: line.item_name,
      baseUnitCode: line.base_unit_code,
      /*
       * A quantity follows the UNIT, not the currency: trailing zeros below the
       * unit's own precision are dropped, so ten reads as "10" rather than
       * "10.000000". Money beside it follows the company's currency.
       */
      expectedQuantity: display(line.expected_quantity, 0),
      countedQuantity: display(line.counted_quantity, 0),
      varianceQuantity: display(line.variance_quantity, 0),
      unitCost: display(line.unit_cost, decimals),
      varianceValue: display(line.variance_value, decimals),
      note: line.note,
    })),
  };
}

export async function getCount(
  db: Kysely<Database>, actor: InventoryActor, id: string,
): Promise<CountRecord> {
  return loadCount(db, actor, id);
}

export async function listCounts(
  db: Kysely<Database>,
  actor: InventoryActor,
  query: { warehouseId?: string; status?: 'posted' | 'reversed'; limit?: number } = {},
): Promise<{ counts: CountRecord[] }> {
  let statement = db
    .selectFrom('stock_counts')
    .select('id')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId);

  if (query.warehouseId) statement = statement.where('warehouse_id', '=', query.warehouseId);
  if (query.status) statement = statement.where('status', '=', query.status);

  const rows = await statement
    .orderBy('posting_date', 'desc')
    .orderBy('created_at', 'desc')
    .limit(Math.min(Math.max(query.limit ?? 50, 1), 200))
    .execute();

  const counts: CountRecord[] = [];
  for (const row of rows) counts.push(await loadCount(db, actor, row.id));
  return { counts };
}

/* ══ Numbering ═════════════════════════════════════════════════════════════ */

async function allocateNumber(
  trx: Transaction<Database>, actor: InventoryActor, postingDate: string,
): Promise<string> {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${`stock_count_number:${actor.organizationId}:${actor.companyId}`})
    )
  `.execute(trx);

  const existing = await trx
    .selectFrom('stock_count_numbering')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .forUpdate()
    .executeTakeFirst();

  const config = existing ?? {
    prefix: 'SC-', include_year: true, sequence_length: 4, next_sequence: 1,
  };

  if (!existing) {
    await trx.insertInto('stock_count_numbering').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      next_sequence: 2,
    } as never).execute();
  } else {
    await trx.updateTable('stock_count_numbering')
      .set({ next_sequence: config.next_sequence + 1, updated_at: new Date() } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .execute();
  }

  const year = config.include_year ? `${postingDate.slice(0, 4)}-` : '';
  return `${config.prefix}${year}${String(config.next_sequence).padStart(config.sequence_length, '0')}`;
}

/* ══ Posting ═══════════════════════════════════════════════════════════════ */

interface CountedItem {
  id: string;
  code: string;
  name: string;
  baseUnitId: string;
  baseUnitCode: string;
  unitDecimals: number;
}

async function resolveCountedItem(
  trx: Transaction<Database>, actor: InventoryActor, itemId: string, at: number,
): Promise<CountedItem> {
  const row = await trx
    .selectFrom('inventory_items as i')
    .innerJoin('units_of_measure as u', (join) => join
      .onRef('u.id', '=', 'i.base_unit_id')
      .onRef('u.organization_id', '=', 'i.organization_id')
      .onRef('u.company_id', '=', 'i.company_id'))
    .select([
      'i.id', 'i.item_code', 'i.name', 'i.status', 'i.is_inventory_tracked', 'i.item_type',
      'i.valuation_method', 'i.base_unit_id',
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
      `Item ${row.item_code} is ${row.status} and cannot be counted into a new adjustment. Its `
      + 'history stays readable; reactivate it to change its quantity.',
      { fieldErrors: { [field]: 'Reactivate the item first.' } },
    );
  }
  if (!row.is_inventory_tracked) {
    throw errors.validation(
      `Item ${row.item_code} is not stock-tracked, so it holds no quantity to count. A `
      + `${row.item_type} has nothing on a shelf.`,
      { fieldErrors: { [field]: 'This item holds no stock.' } },
    );
  }
  if (row.valuation_method !== SUPPORTED_VALUATION) {
    throw errors.validation(UNSUPPORTED_VALUATION(row.valuation_method, row.item_code), {
      fieldErrors: { [field]: 'Only weighted-average items can move.' },
    });
  }

  return {
    id: row.id,
    code: row.item_code,
    name: row.name,
    baseUnitId: row.base_unit_id,
    baseUnitCode: row.unit_code,
    unitDecimals: Number(row.unit_decimals ?? 0),
  };
}

function assertShape(input: CountInput): void {
  if (!input.lines?.length) throw errors.validation(COUNT_EMPTY);
  if (!input.idempotencyKey?.trim()) {
    throw errors.validation('An idempotency key is required so a retry cannot count twice.');
  }
  if (!input.reason?.trim()) {
    throw errors.validation(
      'A count needs a reason, and it is recorded permanently against the adjustment it posts.',
      { fieldErrors: { reason: 'Say what this count was.' } },
    );
  }
  if (!ISO_DATE.test(input.countDate ?? '')) {
    throw errors.validation('countDate must be an ISO date (yyyy-mm-dd).');
  }
  if (input.postingDate !== undefined && !ISO_DATE.test(input.postingDate)) {
    throw errors.validation('postingDate must be an ISO date (yyyy-mm-dd).');
  }

  const seen = new Set<string>();
  for (const [index, line] of input.lines.entries()) {
    if (!line.itemId) {
      throw errors.validation(`Line ${index + 1} must name the item that was counted.`, {
        fieldErrors: { [`lines.${index + 1}.itemId`]: 'Choose an item.' },
      });
    }
    if (seen.has(line.itemId)) {
      throw errors.validation(COUNT_DUPLICATE_ITEM, {
        fieldErrors: { [`lines.${index + 1}.itemId`]: 'This item is already on the sheet.' },
      });
    }
    seen.add(line.itemId);
  }
}

async function findByKey(
  executor: Kysely<Database> | Transaction<Database>, actor: InventoryActor, key: string,
): Promise<string | null> {
  const row = await executor
    .selectFrom('stock_counts')
    .select('id')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('idempotency_key', '=', key)
    .executeTakeFirst();
  return row?.id ?? null;
}

/**
 * Record a physical count and settle its variance.
 *
 * One transaction: the count, its lines, the adjustment's movements, the
 * journal and every audit event commit together or not at all.
 */
export async function postCount(
  db: Kysely<Database>,
  actor: InventoryActor,
  input: CountInput,
): Promise<{ count: CountRecord; created: boolean }> {
  assertShape(input);

  const existingId = await findByKey(db, actor, input.idempotencyKey);
  if (existingId) return { count: await loadCount(db, actor, existingId), created: false };

  const postingDate = input.postingDate ?? input.countDate;

  const outcome = await db.transaction().execute(async (trx) => {
    /* The window between the read above and here is exactly where a retry lands. */
    const raced = await findByKey(trx, actor, input.idempotencyKey);
    if (raced) return { id: raced, created: false };

    const warehouse = await trx
      .selectFrom('warehouses')
      .select(['id', 'code', 'status'])
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', input.warehouseId)
      .executeTakeFirst();
    if (!warehouse) {
      throw errors.validation('That warehouse is not in these books.', {
        fieldErrors: { warehouseId: 'Choose a warehouse from this company.' },
      });
    }
    if (warehouse.status !== 'active') {
      throw errors.validation(
        `Warehouse ${warehouse.code} is ${warehouse.status} and cannot be counted into a new `
        + 'adjustment. Its history stays readable.',
        { fieldErrors: { warehouseId: 'Choose an active warehouse.' } },
      );
    }

    /*
     * Locked BEFORE the expected quantities are read, in item order, and held
     * until the adjustment has posted. That is what makes "expected" and
     * "settled" the same number: a concurrent sale of a counted item waits here
     * rather than landing between the two reads.
     */
    await lockItems(trx, actor, input.lines.map((line) => line.itemId));

    const items = new Map<string, CountedItem>();
    const measured: Array<{
      item: CountedItem;
      expected: Money.Amount;
      counted: Money.Amount;
      variance: Money.Amount;
      unitCost: string | null | undefined;
      note: string;
    }> = [];

    for (const [index, line] of input.lines.entries()) {
      const at = index + 1;
      const item = await resolveCountedItem(trx, actor, line.itemId, at);
      items.set(item.id, item);

      /*
       * A counted quantity is a physical observation: exact, non-negative, at
       * the unit's own precision. Zero is a real answer and a very different
       * one from "not counted" — an item left off the sheet is simply not in
       * this count, and its quantity is untouched.
       */
      const counted = toQuantity(
        line.countedQuantity, item.unitDecimals, `lines.${at}.countedQuantity`, { allowZero: true },
      );

      /* Read from the ledger, never from the request. */
      const expected = await onHandAt(trx, actor, item.id, warehouse.id);
      const variance = counted - expected;

      const hasCost = line.unitCost !== undefined && line.unitCost !== null && line.unitCost !== '';
      if (hasCost && variance <= 0n) {
        throw errors.validation(COUNT_OUTBOUND_COST_REFUSED, {
          fieldErrors: { [`lines.${at}.unitCost`]: 'Remove the unit cost.' },
        });
      }

      measured.push({
        item, expected, counted, variance, unitCost: line.unitCost, note: line.note ?? '',
      });
    }

    /*
     * Only the lines that actually differ become movements. A count that agrees
     * with the books everywhere posts no adjustment and no journal at all —
     * which is the correct outcome, and one worth recording: somebody checked.
     */
    const adjustmentLines: LineInput[] = measured
      .filter((row) => row.variance !== 0n)
      .map((row) => ({
        itemId: row.item.id,
        warehouseId: warehouse.id,
        quantity: Money.toDecimalString(row.variance < 0n ? -row.variance : row.variance),
        direction: row.variance > 0n ? ('in' as const) : ('out' as const),
        /* Only ever set for an inbound; refused above for anything else. */
        unitCost: row.variance > 0n ? (row.unitCost ?? null) : null,
      }));

    let documentId: string | null = null;
    if (adjustmentLines.length > 0) {
      const posted = await postDocumentIn(trx, actor, {
        kind: 'adjustment',
        movementDate: input.countDate,
        postingDate,
        reference: input.memo ?? '',
        memo: `Stock count in ${warehouse.code}`,
        reason: input.reason.trim(),
        idempotencyKey: `count:${input.idempotencyKey}`,
        lines: adjustmentLines,
      });
      documentId = posted.id;
    }

    const countNumber = await allocateNumber(trx, actor, postingDate);
    const created = await trx
      .insertInto('stock_counts')
      .values({
        organization_id: actor.organizationId,
        company_id: actor.companyId,
        count_number: countNumber,
        warehouse_id: warehouse.id,
        count_date: input.countDate,
        posting_date: postingDate,
        memo: input.memo ?? '',
        adjustment_document_id: documentId,
        idempotency_key: input.idempotencyKey,
        counted_by: actor.userId,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();

    /*
     * What each variance was actually costed at, read back from the movements
     * the engine wrote rather than recomputed here. Recomputing would be a
     * second answer to the same question, and the subledger would be the only
     * one of the two anybody could reconcile.
     */
    const costs = new Map<string, { unitCost: string; totalCost: string }>();
    if (documentId) {
      const movements = await trx
        .selectFrom('inventory_movements')
        .select(['item_id', 'unit_cost', 'total_cost'])
        .where('organization_id', '=', actor.organizationId)
        .where('company_id', '=', actor.companyId)
        .where('document_id', '=', documentId)
        .execute();
      for (const movement of movements) {
        costs.set(movement.item_id, {
          unitCost: movement.unit_cost, totalCost: movement.total_cost,
        });
      }
    }

    let lineNumber = 0;
    for (const row of measured) {
      lineNumber += 1;
      const cost = costs.get(row.item.id);
      const signedValue = cost
        ? (row.variance < 0n
          ? Money.toDecimalString(-Money.toAmount(cost.totalCost, 'totalCost'))
          : cost.totalCost)
        : '0';
      await trx.insertInto('stock_count_lines').values({
        organization_id: actor.organizationId,
        company_id: actor.companyId,
        count_id: created.id,
        line_number: lineNumber,
        item_id: row.item.id,
        base_unit_id: row.item.baseUnitId,
        expected_quantity: Money.toDecimalString(row.expected),
        counted_quantity: Money.toDecimalString(row.counted),
        variance_quantity: Money.toDecimalString(row.variance),
        unit_cost: cost?.unitCost ?? '0',
        variance_value: signedValue,
        item_code: row.item.code,
        item_name: row.item.name,
        base_unit_code: row.item.baseUnitCode,
        note: row.note,
      } as never).execute();
    }

    await writeInventoryAudit(trx, actor, {
      subjectType: 'item',
      subjectId: null,
      action: 'STOCK_COUNT_POSTED',
      resultingVersion: 1,
      detail: {
        countId: created.id,
        countNumber,
        warehouse: warehouse.code,
        lines: lineNumber,
        variances: adjustmentLines.length,
      },
    });

    return { id: created.id, created: true };
  });

  return { count: await loadCount(db, actor, outcome.id), created: outcome.created };
}

/* ══ Reversal ══════════════════════════════════════════════════════════════ */

export const COUNT_ALREADY_REVERSED = 'This count has already been reversed.';

/**
 * Withdraw a count, and the adjustment it posted.
 *
 * The adjustment is reversed through I2's own mechanism, so the counter-
 * movements carry the ORIGINAL costs and both rows are marked reversed — the
 * pair leaves every sum. The count itself is never edited or deleted: it is the
 * record of what somebody saw on a shelf on a day, and that does not stop
 * having happened.
 */
export async function reverseCount(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
  expectedVersion: number,
  reason: string,
): Promise<CountRecord> {
  if ((reason ?? '').trim().length < 5) {
    throw errors.validation(
      'A reason of at least five characters is required, and it is recorded permanently against '
      + 'both the count and the journal it withdraws.',
      { fieldErrors: { reason: 'Say why this count is being withdrawn.' } },
    );
  }

  const current = await db
    .selectFrom('stock_counts')
    .select(['id', 'status', 'version', 'adjustment_document_id', 'count_number'])
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!current) throw errors.notFound('Stock count');
  if (current.status === 'reversed') throw errors.conflict(COUNT_ALREADY_REVERSED);

  /*
   * The adjustment is reversed FIRST and through its own service, because that
   * is where the dependency and backdating protections live: a count whose
   * stock has since been sold cannot be withdrawn, and I2 is the thing that
   * knows so.
   */
  if (current.adjustment_document_id) {
    const document = await db
      .selectFrom('inventory_documents')
      .select(['version'])
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', current.adjustment_document_id)
      .executeTakeFirstOrThrow();
    await reverseDocument(
      db, actor, current.adjustment_document_id, Number(document.version),
      `Count ${current.count_number} withdrawn: ${reason.trim()}`,
    );
  }

  await db.transaction().execute(async (trx) => {
    const locked = await trx
      .selectFrom('stock_counts')
      .select(['id', 'status', 'version'])
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!locked) throw errors.notFound('Stock count');
    if (locked.status === 'reversed') throw errors.conflict(COUNT_ALREADY_REVERSED);
    if (Number(locked.version) !== expectedVersion) {
      throw errors.conflict(
        'This count was changed by another user while you were looking at it. Review the latest '
        + 'version before withdrawing it.',
      );
    }

    await trx.updateTable('stock_counts')
      .set({
        status: 'reversed',
        reversal_reason: reason.trim(),
        version: Number(locked.version) + 1,
        updated_at: new Date(),
      } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .execute();

    await writeInventoryAudit(trx, actor, {
      subjectType: 'item',
      subjectId: null,
      action: 'STOCK_COUNT_REVERSED',
      resultingVersion: Number(locked.version) + 1,
      detail: { countId: id, countNumber: current.count_number, reason: reason.trim() },
    });
  });

  return loadCount(db, actor, id);
}

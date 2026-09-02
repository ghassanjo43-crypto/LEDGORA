/**
 * The stock ledger: what is on hand, what it is worth, and how the next issue
 * is costed.
 *
 * ══ Everything here is a SUM over posted movements ═══════════════════════════
 *
 * Quantity on hand is the signed sum of unreversed movements for an item in a
 * warehouse. Value is the signed sum of their costs for the item across the
 * company. Nothing is cached and nothing is stored, so there is no second
 * answer that can drift from the ledger.
 *
 * ══ Why value is per ITEM and quantity is per item AND warehouse ═════════════
 *
 * The product costs an item company-wide, which is what makes a transfer
 * cost-neutral: the same average leaves one warehouse and arrives in another,
 * so no value is created or destroyed by moving a box. Availability, on the
 * other hand, is a question about a place — you cannot issue from a warehouse
 * that has none — so quantity is tracked per item and warehouse too.
 *
 * ══ Weighted average, and only weighted average ══════════════════════════════
 *
 * The product implements exactly one costing method. FIFO exists in the type
 * union and nowhere else — no layers, no consumption, no code — and standard
 * costing exists only inside manufacturing work orders, not as a movement
 * valuation. An item declaring either therefore cannot move, because averaging
 * it silently would report a cost of sales the business never chose.
 *
 * ══ Exact decimals, and why no rounding residual can survive ═════════════════
 *
 * `total_cost` is computed once, at the company's monetary precision, and is
 * the single figure behind BOTH the subledger value and the journal amount — so
 * the two reconcile exactly rather than nearly. When an issue takes the whole
 * remaining quantity it is costed at the whole remaining value, which is the
 * only way a repeated fractional average lands on exactly zero instead of a
 * fraction of a cent that nothing would ever clear.
 */
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import * as Money from '../accounting/money.js';
import { toCalendarDate } from '../accounting/calendarDate.js';
import type { InventoryActor } from './inventoryCore.js';

export type LedgerExecutor = Kysely<Database> | Transaction<Database>;

/** The only costing method this product actually implements. */
export const SUPPORTED_VALUATION = 'weighted-average';

export const UNSUPPORTED_VALUATION = (method: string, code: string): string =>
  `Item ${code} is valued at ${method}, which this product does not implement. Only `
  + 'weighted-average costing exists — there are no cost layers and no standard-cost variance '
  + 'posting — and averaging a FIFO item silently would report a cost of sales the business never '
  + 'chose. Change the item to weighted-average, or leave it out of stock movements.';

export interface Position {
  /** Company-wide quantity for the item. */
  quantity: Money.Amount;
  /** Company-wide value for the item, at monetary precision. */
  value: Money.Amount;
}

/**
 * The company-wide position for one item, from posted movements only.
 *
 * `FOR UPDATE` is deliberately absent: these rows are immutable and the
 * concurrency guarantee comes from the advisory locks taken before this is
 * called. Locking the rows would also not help — a concurrent writer INSERTS a
 * new movement rather than updating an existing one.
 */
export async function positionOf(
  db: LedgerExecutor,
  actor: InventoryActor,
  itemId: string,
): Promise<Position> {
  const { rows } = await sql<{ quantity: string | null; value: string | null }>`
    SELECT
      COALESCE(SUM(CASE WHEN direction = 'in' THEN quantity ELSE -quantity END), 0)::text   AS quantity,
      COALESCE(SUM(CASE WHEN direction = 'in' THEN total_cost ELSE -total_cost END), 0)::text AS value
      FROM inventory_movements
     WHERE organization_id = ${actor.organizationId}
       AND company_id = ${actor.companyId}
       AND item_id = ${itemId}
       AND status = 'posted'
  `.execute(db);

  return {
    quantity: Money.toAmount(rows[0]?.quantity ?? '0', 'quantity'),
    value: Money.toAmount(rows[0]?.value ?? '0', 'value'),
  };
}

/** On-hand for one item in one warehouse. The question availability asks. */
export async function onHandAt(
  db: LedgerExecutor,
  actor: InventoryActor,
  itemId: string,
  warehouseId: string,
): Promise<Money.Amount> {
  const { rows } = await sql<{ quantity: string | null }>`
    SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN quantity ELSE -quantity END), 0)::text AS quantity
      FROM inventory_movements
     WHERE organization_id = ${actor.organizationId}
       AND company_id = ${actor.companyId}
       AND item_id = ${itemId}
       AND warehouse_id = ${warehouseId}
       AND status = 'posted'
  `.execute(db);
  return Money.toAmount(rows[0]?.quantity ?? '0', 'quantity');
}

/**
 * The latest posting date already recorded for an item.
 *
 * Backdating behind this is refused. The product never recalculates a posted
 * cost — `replayMovements` reads each outbound's persisted cost precisely so
 * history is not rewritten — and without recalculation a movement inserted
 * before an existing issue would leave that issue costed at an average that no
 * longer corresponds to anything. Refusing is the honest boundary; a
 * recalculating model is a decision this product has not made.
 */
export async function latestPostingDate(
  db: LedgerExecutor,
  actor: InventoryActor,
  itemId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('inventory_movements')
    .select((eb) => eb.fn.max('posting_date').as('latest'))
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('item_id', '=', itemId)
    .where('status', '=', 'posted')
    .executeTakeFirst();
  const latest = row?.latest as unknown;
  if (!latest) return null;
  /*
   * Read as a CALENDAR date, never through UTC.
   *
   * node-postgres parses a bare `date` into a Date at LOCAL midnight, and east
   * of Greenwich `.toISOString()` on that is the previous day — so a movement
   * posted on the 5th would report the 4th, and the backdating guard would
   * accept a posting it should refuse. PGlite returns these as strings, which
   * is why only the real-PostgreSQL probe catches it.
   */
  return toCalendarDate(latest);
}

/* ── Costing ───────────────────────────────────────────────────────────────── */

/**
 * What one unit is worth right now: value ÷ quantity, at full scale.
 *
 * Zero when nothing is on hand — a receipt sets the first cost, and an issue
 * from an empty position is refused long before this is asked.
 */
export function averageCost(position: Position): Money.Amount {
  if (position.quantity === 0n) return Money.ZERO;
  return (position.value * 10n ** BigInt(Money.SCALE)) / position.quantity;
}

/**
 * The cost of taking `quantity` out of `position`, at monetary precision.
 *
 * The whole-quantity case is not an optimisation. A repeatedly-rounded average
 * leaves a fraction behind — three units bought for ten, issued one at a time,
 * would strand a cent in a warehouse holding nothing — so an issue that empties
 * the position is costed at exactly what remains.
 */
export function outboundCost(
  position: Position,
  quantity: Money.Amount,
  monetaryDecimals: number,
): Money.Amount {
  if (quantity === position.quantity) return position.value;
  const unit = averageCost(position);
  const raw = Money.multiply(quantity, unit);
  return Money.roundTo(raw, monetaryDecimals);
}

/**
 * The cost of putting `quantity` in at `unitCost`, at monetary precision.
 */
export function inboundCost(
  quantity: Money.Amount,
  unitCost: Money.Amount,
  monetaryDecimals: number,
): Money.Amount {
  return Money.roundTo(Money.multiply(quantity, unitCost), monetaryDecimals);
}

/* ── Locking ───────────────────────────────────────────────────────────────── */

/**
 * Take an exclusive lock on every item a document touches, in a deterministic
 * order, for the life of the transaction.
 *
 * Sorted, and that is the whole point: two transfers moving the same two items
 * in opposite directions would deadlock if each locked its own source first.
 * Sorting by item id means every transaction in the system asks for the same
 * locks in the same sequence, so one waits and neither dies.
 *
 * Per ITEM rather than per item-and-warehouse because the average is
 * company-wide: two concurrent issues of the same item from different
 * warehouses both read and advance the same value, and letting them run
 * concurrently would cost one of them from a position the other had already
 * changed.
 */
export async function lockItems(
  trx: Transaction<Database>,
  actor: InventoryActor,
  itemIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(itemIds)].sort();
  for (const itemId of unique) {
    await sql`
      SELECT pg_advisory_xact_lock(
        hashtext(${`inv:${actor.organizationId}:${actor.companyId}`}),
        hashtext(${`item:${itemId}`})
      )
    `.execute(trx);
  }
}

/* ── Quantity parsing ──────────────────────────────────────────────────────── */

/**
 * A quantity, as an exact decimal, validated against the unit's own precision.
 *
 * Quantity precision is the UNIT's and never the currency's: a kilogram is
 * weighed to three places in books that round money to two, and borrowing the
 * monetary scale here would silently re-round every weight the day a company
 * changed currency.
 */
export function toQuantity(
  value: string | number | null | undefined,
  unitDecimals: number,
  field: string,
): Money.Amount {
  const text = String(value ?? '').trim();
  if (!text) {
    throw errors.validation('A quantity is required.', { fieldErrors: { [field]: 'Enter a quantity.' } });
  }
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw errors.validation(
      'A quantity must be a plain positive decimal, such as 2.500.',
      { fieldErrors: { [field]: 'Enter a quantity like 2.500 — no signs, spaces or exponents.' } },
    );
  }
  const amount = Money.toAmount(text, field);
  if (amount === 0n) {
    throw errors.validation(
      'A quantity of zero moves nothing and would post an empty journal.',
      { fieldErrors: { [field]: 'Enter a quantity greater than zero.' } },
    );
  }
  if (Money.exceedsPrecision(amount, unitDecimals)) {
    throw errors.validation(
      `That quantity is finer than the unit allows: this unit is kept to ${unitDecimals} decimal `
      + 'place(s), and a figure the unit cannot express would be rounded by something other than you.',
      { fieldErrors: { [field]: `Use at most ${unitDecimals} decimal place(s).` } },
    );
  }
  return amount;
}

/** A supplied unit cost: exact, non-negative, at monetary precision. */
export function toUnitCost(
  value: string | number | null | undefined,
  monetaryDecimals: number,
  field: string,
): Money.Amount {
  const text = String(value ?? '').trim();
  if (!text) {
    throw errors.validation('A unit cost is required.', { fieldErrors: { [field]: 'Enter a unit cost.' } });
  }
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw errors.validation(
      'A unit cost must be a plain decimal amount, such as 12.500.',
      { fieldErrors: { [field]: 'Enter an amount like 12.500 — no signs, spaces or exponents.' } },
    );
  }
  const amount = Money.toAmount(text, field);
  if (Money.exceedsPrecision(amount, monetaryDecimals)) {
    throw errors.validation(
      `That unit cost is finer than this company's currency: amounts are kept to ${monetaryDecimals} `
      + 'decimal place(s).',
      { fieldErrors: { [field]: `Use at most ${monetaryDecimals} decimal place(s).` } },
    );
  }
  return amount;
}

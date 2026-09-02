/**
 * What the books say is in the warehouse, and what it is worth.
 *
 * ══ Every figure here is a sum over the movement ledger ══════════════════════
 *
 * There is no cache, no snapshot and no maintained balance table. A report that
 * read one would eventually disagree with the ledger, and the day it did nobody
 * would know which to believe. The cost of recomputing is a GROUP BY; the cost
 * of a stale projection is an inventory nobody trusts.
 *
 * ══ Why the reconciliation compares like with like ═══════════════════════════
 *
 * The subledger value is the signed sum of `total_cost`. The general-ledger
 * balance is the signed sum of the journal lines those same movements posted.
 * Because a movement's `total_cost` is the single figure behind BOTH — computed
 * once, at the company's monetary precision — the two agree exactly rather than
 * nearly, and a difference means something is actually wrong rather than that
 * somebody rounded twice.
 *
 * A transfer is deliberately absent from the general-ledger side: it posts no
 * journal, and it changes no value, so it cancels on the subledger side too.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import type { InventoryActor } from './inventoryCore.js';

export interface StockOnHandRow {
  itemId: string;
  itemCode: string;
  itemName: string;
  warehouseId: string;
  warehouseCode: string;
  baseUnitCode: string;
  quantity: string;
  /** Company-wide value share is not split per warehouse; see `valuation`. */
  value: string;
}

export interface StockOnHandQuery {
  itemId?: string;
  warehouseId?: string;
  asOfDate?: string;
  /** Include positions that have netted to zero. Off by default. */
  includeEmpty?: boolean;
}

/**
 * On-hand per item and warehouse.
 *
 * `value` is the signed sum of the costs of the movements in THAT warehouse. It
 * sums across warehouses to the item's company-wide value, which is the figure
 * the valuation report and the general ledger both use — transfers move cost
 * with the goods, so the split stays meaningful.
 */
export async function stockOnHand(
  db: Kysely<Database>,
  actor: InventoryActor,
  query: StockOnHandQuery = {},
): Promise<StockOnHandRow[]> {
  const { rows } = await sql<{
    item_id: string; item_code: string; item_name: string;
    warehouse_id: string; warehouse_code: string; base_unit_code: string;
    quantity: string; value: string;
  }>`
    SELECT
      m.item_id,
      MAX(m.item_code)      AS item_code,
      MAX(m.item_name)      AS item_name,
      m.warehouse_id,
      MAX(m.warehouse_code) AS warehouse_code,
      MAX(m.base_unit_code) AS base_unit_code,
      SUM(CASE WHEN m.direction = 'in' THEN m.quantity   ELSE -m.quantity   END)::text AS quantity,
      SUM(CASE WHEN m.direction = 'in' THEN m.total_cost ELSE -m.total_cost END)::text AS value
      FROM inventory_movements m
     WHERE m.organization_id = ${actor.organizationId}
       AND m.company_id = ${actor.companyId}
       AND m.status = 'posted'
       AND (${query.itemId ?? null}::uuid IS NULL OR m.item_id = ${query.itemId ?? null}::uuid)
       AND (${query.warehouseId ?? null}::uuid IS NULL OR m.warehouse_id = ${query.warehouseId ?? null}::uuid)
       AND (${query.asOfDate ?? null}::date IS NULL OR m.posting_date <= ${query.asOfDate ?? null}::date)
     GROUP BY m.item_id, m.warehouse_id
     ${sql.raw(query.includeEmpty ? '' : 'HAVING SUM(CASE WHEN m.direction = \'in\' THEN m.quantity ELSE -m.quantity END) <> 0')}
     ORDER BY MAX(m.item_code), MAX(m.warehouse_code)
  `.execute(db);

  return rows.map((row) => ({
    itemId: row.item_id,
    itemCode: row.item_code,
    itemName: row.item_name,
    warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code,
    baseUnitCode: row.base_unit_code,
    quantity: row.quantity,
    value: row.value,
  }));
}

export interface ValuationRow {
  itemId: string;
  itemCode: string;
  itemName: string;
  baseUnitCode: string;
  quantity: string;
  value: string;
  /** value ÷ quantity, or null when nothing is on hand. */
  averageCost: string | null;
  inventoryAccountId: string;
}

/** Company-wide quantity, value and average per item — the valuation report. */
export async function valuation(
  db: Kysely<Database>,
  actor: InventoryActor,
  query: { asOfDate?: string } = {},
): Promise<{ rows: ValuationRow[]; totalValue: string }> {
  const { rows } = await sql<{
    item_id: string; item_code: string; item_name: string; base_unit_code: string;
    quantity: string; value: string; average_cost: string | null; inventory_account_id: string;
  }>`
    SELECT
      m.item_id,
      MAX(m.item_code)      AS item_code,
      MAX(m.item_name)      AS item_name,
      MAX(m.base_unit_code) AS base_unit_code,
      MAX(m.inventory_account_id::text) AS inventory_account_id,
      SUM(CASE WHEN m.direction = 'in' THEN m.quantity   ELSE -m.quantity   END)::text AS quantity,
      SUM(CASE WHEN m.direction = 'in' THEN m.total_cost ELSE -m.total_cost END)::text AS value,
      CASE
        WHEN SUM(CASE WHEN m.direction = 'in' THEN m.quantity ELSE -m.quantity END) = 0 THEN NULL
        ELSE (
          SUM(CASE WHEN m.direction = 'in' THEN m.total_cost ELSE -m.total_cost END)
          / SUM(CASE WHEN m.direction = 'in' THEN m.quantity ELSE -m.quantity END)
        )::text
      END AS average_cost
      FROM inventory_movements m
     WHERE m.organization_id = ${actor.organizationId}
       AND m.company_id = ${actor.companyId}
       AND m.status = 'posted'
       AND (${query.asOfDate ?? null}::date IS NULL OR m.posting_date <= ${query.asOfDate ?? null}::date)
     GROUP BY m.item_id
     HAVING SUM(CASE WHEN m.direction = 'in' THEN m.quantity ELSE -m.quantity END) <> 0
        OR SUM(CASE WHEN m.direction = 'in' THEN m.total_cost ELSE -m.total_cost END) <> 0
     ORDER BY MAX(m.item_code)
  `.execute(db);

  const total = rows.reduce((sum, row) => sum + Number(row.value), 0);

  return {
    rows: rows.map((row) => ({
      itemId: row.item_id,
      itemCode: row.item_code,
      itemName: row.item_name,
      baseUnitCode: row.base_unit_code,
      quantity: row.quantity,
      value: row.value,
      averageCost: row.average_cost,
      inventoryAccountId: row.inventory_account_id,
    })),
    /* Formatted from the exact per-row strings, never accumulated in a float
     * before display: the sum here is for a heading, and the rows are the
     * figures anything reconciles against. */
    totalValue: total.toFixed(10),
  };
}

export interface StockCardEntry {
  movementId: string;
  documentId: string;
  documentNumber: string;
  kind: string;
  movementType: string;
  warehouseId: string;
  warehouseCode: string;
  direction: 'in' | 'out';
  quantity: string;
  unitCost: string;
  totalCost: string;
  movementDate: string;
  postingDate: string;
  /** Running quantity and value AFTER this movement, company-wide. */
  runningQuantity: string;
  runningValue: string;
}

/**
 * One item's history in order, with the running position after each movement.
 *
 * The running figures are computed by the database over the same ordering the
 * valuation engine uses — posting date, then creation, then id — so the last
 * row of a stock card equals the valuation report for that item exactly.
 */
export async function stockCard(
  db: Kysely<Database>,
  actor: InventoryActor,
  itemId: string,
  query: { warehouseId?: string; from?: string; to?: string } = {},
): Promise<StockCardEntry[]> {
  const item = await db
    .selectFrom('inventory_items')
    .select('id')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', itemId)
    .executeTakeFirst();
  if (!item) throw errors.notFound('Item');

  const { rows } = await sql<{
    movement_id: string; document_id: string; document_number: string; kind: string;
    movement_type: string; warehouse_id: string; warehouse_code: string; direction: 'in' | 'out';
    quantity: string; unit_cost: string; total_cost: string;
    movement_date: string; posting_date: string;
    running_quantity: string; running_value: string;
  }>`
    SELECT
      m.id AS movement_id, m.document_id, d.document_number, d.kind,
      m.movement_type, m.warehouse_id, m.warehouse_code, m.direction,
      m.quantity::text, m.unit_cost::text, m.total_cost::text,
      m.movement_date::text, m.posting_date::text,
      SUM(CASE WHEN m.direction = 'in' THEN m.quantity ELSE -m.quantity END)
        OVER (ORDER BY m.posting_date, m.created_at, m.id
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::text AS running_quantity,
      SUM(CASE WHEN m.direction = 'in' THEN m.total_cost ELSE -m.total_cost END)
        OVER (ORDER BY m.posting_date, m.created_at, m.id
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::text AS running_value
      FROM inventory_movements m
      JOIN inventory_documents d
        ON d.id = m.document_id
       AND d.organization_id = m.organization_id
       AND d.company_id = m.company_id
     WHERE m.organization_id = ${actor.organizationId}
       AND m.company_id = ${actor.companyId}
       AND m.item_id = ${itemId}
       AND m.status = 'posted'
       AND (${query.warehouseId ?? null}::uuid IS NULL OR m.warehouse_id = ${query.warehouseId ?? null}::uuid)
       AND (${query.from ?? null}::date IS NULL OR m.posting_date >= ${query.from ?? null}::date)
       AND (${query.to ?? null}::date IS NULL OR m.posting_date <= ${query.to ?? null}::date)
     ORDER BY m.posting_date, m.created_at, m.id
  `.execute(db);

  return rows.map((row) => ({
    movementId: row.movement_id,
    documentId: row.document_id,
    documentNumber: row.document_number,
    kind: row.kind,
    movementType: row.movement_type,
    warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code,
    direction: row.direction,
    quantity: row.quantity,
    unitCost: row.unit_cost,
    totalCost: row.total_cost,
    movementDate: row.movement_date,
    postingDate: row.posting_date,
    runningQuantity: row.running_quantity,
    runningValue: row.running_value,
  }));
}

export interface ReconciliationRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  subledgerValue: string;
  generalLedgerBalance: string;
  difference: string;
}

export interface ReconciliationResult {
  asOfDate: string | null;
  rows: ReconciliationRow[];
  balanced: boolean;
}

/**
 * Inventory subledger against the general ledger, by control account.
 *
 * A difference is surfaced, never hidden and never silently absorbed. The
 * expected state is exact equality: both sides are sums of the same
 * `total_cost` figures, so anything else means a journal was posted or reversed
 * without its movements, or the other way round.
 */
export async function reconcile(
  db: Kysely<Database>,
  actor: InventoryActor,
  query: { asOfDate?: string } = {},
): Promise<ReconciliationResult> {
  const asOf = query.asOfDate ?? null;

  const { rows } = await sql<{
    account_id: string; account_code: string; account_name: string;
    subledger: string; gl: string; difference: string;
  }>`
    WITH subledger AS (
      SELECT
        m.inventory_account_id AS account_id,
        SUM(CASE WHEN m.direction = 'in' THEN m.total_cost ELSE -m.total_cost END) AS value
        FROM inventory_movements m
       WHERE m.organization_id = ${actor.organizationId}
         AND m.company_id = ${actor.companyId}
         AND m.status = 'posted'
         AND (${asOf}::date IS NULL OR m.posting_date <= ${asOf}::date)
       GROUP BY m.inventory_account_id
    ),
    ledger AS (
      SELECT
        l.account_id,
        SUM(COALESCE(l.debit_functional, 0) - COALESCE(l.credit_functional, 0)) AS balance
        FROM journal_lines l
        JOIN journal_entries e
          ON e.id = l.journal_entry_id
         AND e.organization_id = l.organization_id
         AND e.company_id = l.company_id
       WHERE l.organization_id = ${actor.organizationId}
         AND l.company_id = ${actor.companyId}
         /*
          * Both, exactly as the ledger service counts them. Reversing an entry
          * withdraws it from posted and adds a cancelling one; counting only
          * posted rows would leave the reversal in and the original out, and the
          * account would read as if the entry had happened backwards.
          */
         AND e.status IN ('posted', 'reversed')
         AND (${asOf}::date IS NULL OR e.posting_date <= ${asOf}::date)
         AND l.account_id IN (SELECT account_id FROM subledger)
       GROUP BY l.account_id
    )
    SELECT
      a.id AS account_id,
      a.account_code,
      a.account_name,
      COALESCE(s.value, 0)::text   AS subledger,
      COALESCE(g.balance, 0)::text AS gl,
      (COALESCE(s.value, 0) - COALESCE(g.balance, 0))::text AS difference
      FROM subledger s
      FULL OUTER JOIN ledger g ON g.account_id = s.account_id
      JOIN accounts a ON a.id = COALESCE(s.account_id, g.account_id)
     ORDER BY a.account_code
  `.execute(db);

  const mapped = rows.map((row) => ({
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    subledgerValue: row.subledger,
    generalLedgerBalance: row.gl,
    difference: row.difference,
  }));

  return {
    asOfDate: asOf,
    rows: mapped,
    balanced: mapped.every((row) => Number(row.difference) === 0),
  };
}

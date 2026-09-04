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
import { monetaryDecimalsFor, renderAmount } from '../accounting/currencyPrecision.js';
import * as Money from '../accounting/money.js';

/**
 * How many decimals this company's money is written to.
 *
 * Every figure these reports return passes through it. Before I5 they did not:
 * the aggregates came straight back from `numeric(28,10)`, so an inventory
 * value read `50.0000000000` in every currency while the invoice beside it read
 * `50.000`. The scale is a storage decision and stays one; this is the
 * rendering side of that boundary, shared with invoices and receipts so the two
 * cannot disagree about what JPY looks like.
 */
async function companyDecimals(
  db: Kysely<Database>, actor: InventoryActor,
): Promise<number> {
  const org = await db.selectFrom('organizations').select('base_currency')
    .where('id', '=', actor.organizationId).executeTakeFirst();
  return monetaryDecimalsFor(org?.base_currency);
}

/**
 * Quantities are counted, not valued, so they follow the UNIT rather than the
 * currency. Six places is the ledger's own quantity precision; trailing zeros
 * below it are dropped, so a whole number reads as one.
 */
const QUANTITY_DECIMALS = 0;
const quantityText = (value: unknown): string => renderAmount(value, QUANTITY_DECIMALS);

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

  const decimals = await companyDecimals(db, actor);
  return rows.map((row) => ({
    itemId: row.item_id,
    itemCode: row.item_code,
    itemName: row.item_name,
    warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code,
    baseUnitCode: row.base_unit_code,
    quantity: quantityText(row.quantity),
    value: renderAmount(row.value, decimals),
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

  /*
   * Summed as exact scaled integers, never as numbers.
   *
   * This used to be `rows.reduce((s, r) => s + Number(r.value), 0)`, which is a
   * float sum of the very figures the general ledger is reconciled against —
   * the one place a binary rounding error would be both invisible and
   * load-bearing. The comment beneath it already said the total must never be
   * accumulated in a float; now it is not.
   */
  const decimals = await companyDecimals(db, actor);
  const total = rows.reduce((sum, row) => sum + Money.toAmount(row.value, 'value'), Money.ZERO);

  return {
    rows: rows.map((row) => ({
      itemId: row.item_id,
      itemCode: row.item_code,
      itemName: row.item_name,
      baseUnitCode: row.base_unit_code,
      quantity: quantityText(row.quantity),
      value: renderAmount(row.value, decimals),
      /*
       * The average is a DIVISION, so it carries more places than money does —
       * and it is not money: it is what one unit is worth, and rounding it to
       * the currency would make quantity times average stop equalling value.
       * Rendered at the ledger's own scale rather than the currency's.
       */
      averageCost: row.average_cost === null ? null : renderAmount(row.average_cost, Money.SCALE),
      inventoryAccountId: row.inventory_account_id,
    })),
    totalValue: renderAmount(Money.toDecimalString(total), decimals),
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
  /**
   * `posted` or `reversed`. A reversed row STAYS on the card: the audit
   * question is what happened, and a withdrawal that vanished would leave a
   * card that could not explain its own balance.
   */
  status: 'posted' | 'reversed';
  /** The movement this one withdraws, and the one that withdrew it. */
  reversalOfMovementId: string | null;
  reversedByMovementId: string | null;
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
    status: 'posted' | 'reversed';
    reversal_of_movement_id: string | null; reversed_by_movement_id: string | null;
  }>`
    SELECT
      m.id AS movement_id, m.document_id, d.document_number, d.kind,
      m.movement_type, m.warehouse_id, m.warehouse_code, m.direction,
      m.quantity::text, m.unit_cost::text, m.total_cost::text,
      m.movement_date::text, m.posting_date::text,
      m.status, m.reversal_of_movement_id::text, m.reversed_by_movement_id::text,
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
       /*
        * Reversed rows are INCLUDED, deliberately.
        *
        * A reversal writes an opposite movement and marks both rows reversed,
        * so the pair contributes exactly zero to every running total — the
        * balance is identical whether they are shown or hidden. Hiding them
        * would leave a card that cannot account for its own history, which is
        * the one thing a stock card exists to do.
        */
       AND (${query.warehouseId ?? null}::uuid IS NULL OR m.warehouse_id = ${query.warehouseId ?? null}::uuid)
       AND (${query.from ?? null}::date IS NULL OR m.posting_date >= ${query.from ?? null}::date)
       AND (${query.to ?? null}::date IS NULL OR m.posting_date <= ${query.to ?? null}::date)
     ORDER BY m.posting_date, m.created_at, m.id
  `.execute(db);

  const decimals = await companyDecimals(db, actor);
  return rows.map((row) => ({
    movementId: row.movement_id,
    documentId: row.document_id,
    documentNumber: row.document_number,
    kind: row.kind,
    movementType: row.movement_type,
    warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code,
    direction: row.direction,
    quantity: quantityText(row.quantity),
    unitCost: renderAmount(row.unit_cost, Money.SCALE),
    totalCost: renderAmount(row.total_cost, decimals),
    movementDate: row.movement_date,
    postingDate: row.posting_date,
    runningQuantity: quantityText(row.running_quantity),
    runningValue: renderAmount(row.running_value, decimals),
    status: row.status,
    reversalOfMovementId: row.reversal_of_movement_id,
    reversedByMovementId: row.reversed_by_movement_id,
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

/**
 * A journal entry that touched an inventory control account without an
 * inventory document behind it.
 *
 * This is the honest explanation of a difference, and the reason a
 * reconciliation report never posts anything: a manual journal to an inventory
 * account is a legitimate act with a legitimate reason, and only the person who
 * wrote it knows whether the fix is another journal or a stock adjustment.
 * Correcting it automatically would guess.
 */
export interface ReconciliationException {
  journalEntryId: string;
  journalNumber: string;
  postingDate: string;
  accountId: string;
  accountCode: string;
  description: string;
  sourceType: string | null;
  reference: string;
  amount: string;
}

export interface ReconciliationResult {
  asOfDate: string | null;
  rows: ReconciliationRow[];
  /** The sum of the account rows — equal to them by construction, not by a second query. */
  totals: { subledgerValue: string; generalLedgerBalance: string; difference: string };
  balanced: boolean;
  /** Present when a difference exists and something explains it. */
  exceptions: ReconciliationException[];
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

  const decimals = await companyDecimals(db, actor);

  /*
   * Exact, as scaled integers. `balanced` used to be
   * `every((row) => Number(row.difference) === 0)` — a float comparison
   * deciding whether the books agree, which is the one question that must not
   * be answered approximately.
   */
  let subledgerTotal = Money.ZERO;
  let ledgerTotal = Money.ZERO;
  let differenceTotal = Money.ZERO;

  const mapped = rows.map((row) => {
    subledgerTotal += Money.toAmount(row.subledger, 'subledger');
    ledgerTotal += Money.toAmount(row.gl, 'generalLedger');
    differenceTotal += Money.toAmount(row.difference, 'difference');
    return {
      accountId: row.account_id,
      accountCode: row.account_code,
      accountName: row.account_name,
      subledgerValue: renderAmount(row.subledger, decimals),
      generalLedgerBalance: renderAmount(row.gl, decimals),
      difference: renderAmount(row.difference, decimals),
    };
  });

  const balanced = rows.every((row) => Money.toAmount(row.difference, 'difference') === Money.ZERO);

  return {
    asOfDate: asOf,
    rows: mapped,
    totals: {
      subledgerValue: renderAmount(Money.toDecimalString(subledgerTotal), decimals),
      generalLedgerBalance: renderAmount(Money.toDecimalString(ledgerTotal), decimals),
      difference: renderAmount(Money.toDecimalString(differenceTotal), decimals),
    },
    balanced,
    exceptions: balanced ? [] : await reconcilingExceptions(db, actor, asOf, decimals),
  };
}

/**
 * The journal entries that could explain a difference.
 *
 * An inventory control account's balance should be the sum of the movements
 * behind it. Every journal this product posts to one is produced by an
 * inventory document — a receipt, an issue, a transfer, an adjustment, a
 * stocked bill or a stocked sale — and each of those documents records the
 * journal it created. So an entry touching an inventory account that NO
 * document claims is, by construction, one somebody wrote by hand.
 *
 * They are reported with their references and never corrected. A manual journal
 * to an inventory account may be entirely right; deciding otherwise, and
 * posting an adjustment to "fix" it, would be this report inventing a
 * correction nobody asked for.
 */
async function reconcilingExceptions(
  db: Kysely<Database>,
  actor: InventoryActor,
  asOf: string | null,
  decimals: number,
): Promise<ReconciliationException[]> {
  const { rows } = await sql<{
    journal_entry_id: string; journal_number: string; posting_date: string;
    account_id: string; account_code: string; description: string;
    source_type: string | null; reference: string; amount: string;
  }>`
    WITH control_accounts AS (
      SELECT DISTINCT inventory_account_id AS id
        FROM inventory_movements
       WHERE organization_id = ${actor.organizationId} AND company_id = ${actor.companyId}
         AND inventory_account_id IS NOT NULL
      UNION
      SELECT DISTINCT inventory_account_id
        FROM inventory_items
       WHERE organization_id = ${actor.organizationId} AND company_id = ${actor.companyId}
         AND inventory_account_id IS NOT NULL
      UNION
      SELECT default_inventory_account_id
        FROM inventory_settings
       WHERE organization_id = ${actor.organizationId} AND company_id = ${actor.companyId}
         AND default_inventory_account_id IS NOT NULL
    ),
    stock_journals AS (
      SELECT DISTINCT journal_entry_id
        FROM inventory_documents
       WHERE organization_id = ${actor.organizationId} AND company_id = ${actor.companyId}
         AND journal_entry_id IS NOT NULL
    )
    SELECT
      e.id AS journal_entry_id,
      e.journal_number,
      e.posting_date::text,
      l.account_id,
      a.account_code,
      COALESCE(NULLIF(e.description, ''), COALESCE(l.memo, '')) AS description,
      e.source_type,
      COALESCE(e.reference, '') AS reference,
      SUM(COALESCE(l.debit_functional, 0) - COALESCE(l.credit_functional, 0))::text AS amount
      FROM journal_lines l
      JOIN journal_entries e
        ON e.id = l.journal_entry_id
       AND e.organization_id = l.organization_id
       AND e.company_id = l.company_id
      JOIN accounts a ON a.id = l.account_id
     WHERE l.organization_id = ${actor.organizationId}
       AND l.company_id = ${actor.companyId}
       AND e.status IN ('posted', 'reversed')
       AND (${asOf}::date IS NULL OR e.posting_date <= ${asOf}::date)
       AND l.account_id IN (SELECT id FROM control_accounts)
       AND e.id NOT IN (SELECT journal_entry_id FROM stock_journals)
     GROUP BY e.id, e.journal_number, e.posting_date, l.account_id, a.account_code,
              e.description, l.memo, e.source_type, e.reference
     ORDER BY e.posting_date, e.journal_number
  `.execute(db);

  return rows.map((row) => ({
    journalEntryId: row.journal_entry_id,
    journalNumber: row.journal_number,
    postingDate: row.posting_date,
    accountId: row.account_id,
    accountCode: row.account_code,
    description: row.description,
    sourceType: row.source_type,
    reference: row.reference,
    amount: renderAmount(row.amount, decimals),
  }));
}

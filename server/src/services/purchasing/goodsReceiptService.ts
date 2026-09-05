/**
 * Goods receipts: where an ordered purchase becomes stock, and a liability the
 * supplier has not yet invoiced.
 *
 * ══ What a posted receipt does, and what it deliberately does not ════════════
 *
 *   Dr Inventory                       (the order's net attributable to what
 *     Cr Goods received not invoiced     actually arrived)
 *
 * There is no Accounts Payable line and no Input Tax line, and that is the
 * whole design rather than an omission. No supplier has invoiced anything, so
 * nobody is owed a determinate amount; and the rate, category and
 * recoverability a tax authority will be shown are the ones in force on the
 * SUPPLIER INVOICE's date, frozen from that document. Recognising either here
 * would put a payable in the books that no supplier document supports and
 * freeze a tax treatment from an order the authority never sees. AP2 posts the
 * bill, recognises both, and settles the GRNI accrual against it.
 *
 * ══ One transaction, or nothing ══════════════════════════════════════════════
 *
 * The order lock, the remaining-quantity check, the receipt, its lines, the I2
 * movements, the weighted-average valuation, the Inventory/GRNI journal, the
 * order's derived status and every audit event happen inside ONE database
 * transaction. A failure anywhere takes all of it back, because a receipt that
 * moved stock without its journal — or advanced an order's status without the
 * stock — is a set of books nobody can reconcile and nobody can find the cause
 * of.
 *
 * ══ Why over-receipt is impossible rather than merely refused ════════════════
 *
 * Remaining quantity is not stored. It is summed from posted, unreversed
 * receipt lines INSIDE the transaction, after the order's row and its lines
 * have been locked FOR UPDATE. Two concurrent receipts for the last unit of the
 * same line therefore serialise on that lock: the second re-reads the sum the
 * first committed and is refused. A stored counter could not give that
 * guarantee at all, and a check taken before the lock would give the appearance
 * of one.
 *
 * ══ Why the cost comes from the ORDER and not from the receiver ══════════════
 *
 * The person on the loading bay counts boxes; they do not agree prices. So a
 * receipt line names an order line and a quantity, and everything else — the
 * supplier, the item, the unit, the destination warehouse, the permitted
 * quantity and the value — is derived from the order under the same lock. A
 * client-supplied cost would be the caller choosing what its own stock is worth.
 *
 * The line's whole net is recognised across its receipts EXACTLY: a partial
 * receipt takes its pro-rata share at the currency's precision, and the receipt
 * that completes the line takes whatever remains of the net. That is the same
 * rule the stock ledger uses when an issue empties a position, and it is what
 * stops a repeatedly-rounded share stranding a fraction of a fils in GRNI that
 * no invoice could ever clear.
 *
 * ══ Correction is reversal, never an edit ════════════════════════════════════
 *
 * A posted receipt is evidence, frozen by a database trigger. Reversal
 * withdraws the movements at their ORIGINAL quantity and cost through I2's own
 * mechanism — never at today's average — posts the reversing Inventory/GRNI
 * entry, and restores the order line's remaining quantity by the only means
 * that cannot drift: the receipt leaves the set of posted receipts the
 * remaining quantity is summed over.
 */
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import * as Money from '../accounting/money.js';
import { toCalendarDate } from '../accounting/calendarDate.js';
import { monetaryDecimalsFor } from '../accounting/currencyPrecision.js';
import type { InventoryActor } from '../inventory/inventoryCore.js';
import { toQuantity } from '../inventory/stockLedger.js';
import {
  postDocumentIn,
  reverseDocumentIn,
  assertReversalReason,
  type LineInput as StockLineInput,
} from '../inventory/stockDocumentService.js';
import { assertNoLiveMatches } from './receiptMatching.js';
import {
  RECEIVABLE,
  allocatePurchasingNumber,
  refreshOrderStatusIn,
  writePurchasingAudit,
  type AuditRecord,
  type OrderStatus,
} from './purchaseOrderService.js';

type Trx = Transaction<Database>;
type Executor = Kysely<Database> | Trx;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ReceiptStatus = 'posted' | 'reversed';

/* ══ Refusals ══════════════════════════════════════════════════════════════ */

/**
 * Facts a receiver may not author.
 *
 * Every one of these is derived from the order inside the posting transaction.
 * A request carrying one is refused rather than ignored: a client that could
 * send a unit cost, an available quantity or a match state would be deciding
 * what the stock is worth or what the books already believe.
 */
const DERIVED_FROM_THE_ORDER: Record<string, string> = {
  itemId: 'an item',
  warehouseId: 'a warehouse',
  unitId: 'a unit',
  unitCost: 'a unit cost',
  totalCost: 'a value',
  supplierId: 'a supplier',
  description: 'a line description',
  accountId: 'an account',
  inventoryAccountId: 'an inventory account',
  grniAccountId: 'a goods-received-not-invoiced account',
  availableQuantity: 'an available quantity',
  orderedQuantity: 'an ordered quantity',
  receivedQuantity: 'a cumulative received quantity',
  remainingQuantity: 'a remaining quantity',
  movementValue: 'a movement value',
  journalValue: 'a journal value',
  receiptNumber: 'a receipt number',
  status: 'a status',
  totalValue: 'a total value',
};

/** What AP2 owns, and AP1 must not pretend to. */
const AP2_OWNED: Record<string, string> = {
  billId: 'a supplier bill',
  billLineId: 'a supplier bill line',
  matchStatus: 'a match state',
  matched: 'a match state',
  invoiced: 'an invoiced state',
  settled: 'a settled state',
  priceVariance: 'a price variance',
  quantityVariance: 'a quantity variance',
  tolerance: 'a match tolerance',
  accrualRelease: 'an accrual release',
  returnQuantity: 'a purchase return',
  debitNoteId: 'a debit note',
};

/** Dimensions this slice has no accounting for. */
const UNSUPPORTED: Record<string, string> = {
  lotId: 'lot tracking',
  serialNumbers: 'serial-number tracking',
  expiryDate: 'expiry dates',
  binId: 'bin locations',
  projectId: 'project dimensions',
  costCenterId: 'cost-centre dimensions',
  landedCost: 'landed costs',
  freightAmount: 'freight capitalisation',
  currency: 'foreign-currency purchasing',
  exchangeRate: 'foreign-currency purchasing',
  attachments: 'attachments',
};

export const MATCHING_DEFERRED =
  'A goods receipt is matched by posting a supplier bill against it, which clears the '
  + 'goods-received-not-invoiced accrual and recognises the payable and the recoverable input tax. '
  + 'Matching is exact: a bill whose net differs from what the goods were received at is refused, '
  + 'because purchase-price variance has no defined destination under weighted-average costing in '
  + 'this product. Tolerances, variance postings, purchase returns, debit notes and supplier '
  + 'credits are not implemented.';

function refuseField(field: string, value: unknown, what: string, why: string): void {
  if (value === undefined || value === null || value === '') return;
  if (Array.isArray(value) && value.length === 0) return;
  throw errors.validation(
    `A goods receipt may not carry ${what}: ${why} Nothing has been saved.`,
    { fieldErrors: { [field]: `Remove ${what}.` } },
  );
}

function assertWithinBoundary(input: ReceiptInput): void {
  const check = (prefix: string, record: Record<string, unknown>): void => {
    for (const [field, what] of Object.entries(DERIVED_FROM_THE_ORDER)) {
      refuseField(`${prefix}${field}`, record[field], what,
        'every commercial fact on a receipt is derived from the purchase order line it names, '
        + 'inside the posting transaction, so the person counting boxes cannot also decide the '
        + 'price.');
    }
    for (const [field, what] of Object.entries(AP2_OWNED)) {
      refuseField(`${prefix}${field}`, record[field], what, MATCHING_DEFERRED);
    }
    for (const [field, what] of Object.entries(UNSUPPORTED)) {
      refuseField(`${prefix}${field}`, record[field], what,
        `${what} is not implemented, and a field the books never read would make a screen believe `
        + 'otherwise.');
    }
  };

  check('', input as unknown as Record<string, unknown>);
  for (const [index, line] of (input.lines ?? []).entries()) {
    check(`lines.${index + 1}.`, line as unknown as Record<string, unknown>);
  }
}

/* ══ Input ═════════════════════════════════════════════════════════════════ */

export interface ReceiptLineInput {
  /** The ONLY authority a line names, and the only thing it may name. */
  orderLineId: string;
  /** How much actually arrived. An exact decimal string. */
  quantity: string;
}

export interface ReceiptInput {
  orderId: string;
  receiptDate: string;
  /** When the books take it. Defaults to the receipt date. */
  postingDate?: string;
  /** The supplier's delivery-note number. Theirs, not Ledgora's. */
  deliveryNoteReference?: string;
  memo?: string;
  /** A retry must carry the SAME key, or it is a second delivery. */
  idempotencyKey: string;
  lines: ReceiptLineInput[];
}

/* ══ Records ═══════════════════════════════════════════════════════════════ */

export interface ReceiptLineRecord {
  id: string;
  lineNumber: number;
  orderLineId: string;
  orderLineNumber: number | null;
  itemId: string;
  itemCode: string;
  itemName: string;
  baseUnitId: string;
  baseUnitCode: string;
  warehouseId: string;
  warehouseCode: string;
  receivedQuantity: string;
  unitCost: string;
  totalCost: string;
  movementId: string | null;
}

export interface ReceiptRecord {
  id: string;
  receiptNumber: string;
  orderId: string;
  orderNumber: string;
  supplierId: string;
  supplierName: string;
  receiptDate: string;
  postingDate: string;
  deliveryNoteReference: string;
  memo: string;
  status: ReceiptStatus;
  totalValue: string;
  inventoryDocumentId: string | null;
  inventoryDocumentNumber: string | null;
  journalEntryId: string | null;
  reversalDocumentId: string | null;
  reversalReason: string;
  reversedAt: string | null;
  /**
   * Whether any of this receipt has been settled by a posted supplier bill.
   *
   * Derived from ACTIVE allocations, never stored: a reversed bill's rows leave
   * that set, and the receipt is awaiting an invoice again. Stated explicitly so
   * a client never has to infer "settled" from the absence of a field.
   */
  matched: boolean;
  /** What supplier bills have cleared of this receipt's value, so far. */
  clearedValue: string;
  /** The accrual still open on this receipt: total value less what was cleared. */
  openValue: string;
  version: number;
  createdAt: string | null;
  lines: ReceiptLineRecord[];
}

/* ══ Reading ═══════════════════════════════════════════════════════════════ */

const stamp = (value: unknown): string | null =>
  (value instanceof Date ? value.toISOString() : (value as string | null) ?? null);

async function loadReceipts(
  db: Executor,
  actor: InventoryActor,
  ids: readonly string[],
): Promise<ReceiptRecord[]> {
  if (ids.length === 0) return [];

  const headers = await db
    .selectFrom('goods_receipts as r')
    .innerJoin('purchase_orders as o', (join) => join
      .onRef('o.id', '=', 'r.order_id')
      .onRef('o.organization_id', '=', 'r.organization_id')
      .onRef('o.company_id', '=', 'r.company_id'))
    .leftJoin('business_parties as p', (join) => join
      .onRef('p.id', '=', 'r.supplier_id')
      .onRef('p.organization_id', '=', 'r.organization_id')
      .onRef('p.company_id', '=', 'r.company_id'))
    .leftJoin('inventory_documents as d', (join) => join
      .onRef('d.id', '=', 'r.inventory_document_id')
      .onRef('d.organization_id', '=', 'r.organization_id')
      .onRef('d.company_id', '=', 'r.company_id'))
    .selectAll('r')
    .select([
      'o.order_number', 'p.legal_name as supplier_name',
      'd.document_number as inventory_document_number', 'd.journal_entry_id',
    ])
    .where('r.organization_id', '=', actor.organizationId)
    .where('r.company_id', '=', actor.companyId)
    .where('r.id', 'in', ids as string[])
    .execute();

  const lines = await db
    .selectFrom('goods_receipt_lines as l')
    .leftJoin('purchase_order_lines as ol', (join) => join
      .onRef('ol.id', '=', 'l.order_line_id')
      .onRef('ol.organization_id', '=', 'l.organization_id')
      .onRef('ol.company_id', '=', 'l.company_id'))
    .selectAll('l')
    .select('ol.line_number as order_line_number')
    .where('l.organization_id', '=', actor.organizationId)
    .where('l.company_id', '=', actor.companyId)
    .where('l.receipt_id', 'in', ids as string[])
    .orderBy('l.line_number', 'asc')
    .execute();

  /*
   * What posted bills have cleared of each receipt, from ACTIVE allocations.
   * A reversed bill's rows leave this sum, which is how a receipt returns to
   * awaiting an invoice without anything being recomputed or stored.
   */
  const clearedByReceipt = new Map<string, Money.Amount>();
  const clearings = await db
    .selectFrom('bill_receipt_matches')
    .select((eb) => [
      'receipt_id',
      eb.fn.sum<string>('matched_receipt_value').as('value'),
    ])
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('receipt_id', 'in', ids as string[])
    .where('status', '=', 'active')
    .groupBy('receipt_id')
    .execute();
  for (const row of clearings) {
    clearedByReceipt.set(row.receipt_id, Money.toAmount(String(row.value ?? '0'), 'cleared'));
  }

  const byReceipt = new Map<string, ReceiptLineRecord[]>();
  for (const line of lines) {
    const list = byReceipt.get(line.receipt_id) ?? [];
    list.push({
      id: line.id,
      lineNumber: Number(line.line_number),
      orderLineId: line.order_line_id,
      orderLineNumber: line.order_line_number === null ? null : Number(line.order_line_number),
      itemId: line.item_id,
      itemCode: line.item_code,
      itemName: line.item_name,
      baseUnitId: line.base_unit_id,
      baseUnitCode: line.base_unit_code,
      warehouseId: line.warehouse_id,
      warehouseCode: line.warehouse_code,
      receivedQuantity: line.received_quantity,
      unitCost: line.unit_cost,
      totalCost: line.total_cost,
      movementId: line.movement_id,
    });
    byReceipt.set(line.receipt_id, list);
  }

  const position = new Map(ids.map((id, index) => [id, index]));
  return headers
    .sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0))
    .map((row) => ({
      id: row.id,
      receiptNumber: row.receipt_number,
      orderId: row.order_id,
      orderNumber: row.order_number,
      supplierId: row.supplier_id,
      supplierName: row.supplier_name ?? '',
      receiptDate: toCalendarDate(row.receipt_date),
      postingDate: toCalendarDate(row.posting_date),
      deliveryNoteReference: row.delivery_note_reference,
      memo: row.memo,
      status: row.status as ReceiptStatus,
      totalValue: row.total_value,
      inventoryDocumentId: row.inventory_document_id,
      inventoryDocumentNumber: row.inventory_document_number ?? null,
      journalEntryId: row.journal_entry_id ?? null,
      reversalDocumentId: row.reversal_document_id,
      reversalReason: row.reversal_reason,
      reversedAt: stamp(row.reversed_at),
      matched: (clearedByReceipt.get(row.id) ?? Money.ZERO) !== Money.ZERO,
      clearedValue: Money.toDecimalString(clearedByReceipt.get(row.id) ?? Money.ZERO),
      openValue: Money.toDecimalString(
        Money.toAmount(row.total_value, 'totalValue') - (clearedByReceipt.get(row.id) ?? Money.ZERO),
      ),
      version: Number(row.version),
      createdAt: stamp(row.created_at),
      lines: byReceipt.get(row.id) ?? [],
    }));
}

export async function getReceipt(
  db: Executor,
  actor: InventoryActor,
  id: string,
): Promise<ReceiptRecord> {
  const [receipt] = await loadReceipts(db, actor, [id]);
  if (!receipt) throw errors.notFound('Goods receipt');
  return receipt;
}

export interface ReceiptQuery {
  orderId?: string;
  supplierId?: string;
  status?: ReceiptStatus;
  /**
   * Receipts still waiting for a supplier invoice. In AP1 that is every posted,
   * unreversed receipt — there is no matching, so nothing can leave the set.
   */
  awaitingInvoice?: boolean;
  limit?: number;
}

export async function listReceipts(
  db: Kysely<Database>,
  actor: InventoryActor,
  query: ReceiptQuery = {},
): Promise<ReceiptRecord[]> {
  let builder = db
    .selectFrom('goods_receipts')
    .select('id')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId);

  if (query.orderId) builder = builder.where('order_id', '=', query.orderId);
  if (query.supplierId) builder = builder.where('supplier_id', '=', query.supplierId);
  if (query.status) builder = builder.where('status', '=', query.status);
  if (query.awaitingInvoice) builder = builder.where('status', '=', 'posted');

  const rows = await builder
    .orderBy('posting_date', 'desc')
    .orderBy('created_at', 'desc')
    .limit(Math.min(Math.max(query.limit ?? 100, 1), 500))
    .execute();

  const loaded = await loadReceipts(db, actor, rows.map((row) => row.id));
  /*
   * "Awaiting an invoice" means something is still OPEN, not merely that the
   * receipt is posted — a fully billed receipt is settled. The clearings are
   * summed during hydration, so the filter is applied here rather than in the
   * query; a page may therefore come back shorter than its limit, which is the
   * honest outcome when the alternative is listing settled receipts as waiting.
   */
  if (!query.awaitingInvoice) return loaded;
  return loaded.filter((receipt) => Money.toAmount(receipt.openValue, 'openValue') > 0n);
}

export async function receiptHistory(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
): Promise<AuditRecord[]> {
  const rows = await db
    .selectFrom('purchasing_audit_events')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('subject_type', '=', 'receipt')
    .where('subject_id', '=', id)
    .orderBy('at', 'desc')
    .execute();

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    detail: row.detail,
    previousVersion: row.previous_version,
    resultingVersion: row.resulting_version,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    at: row.at instanceof Date ? row.at.toISOString() : (row.at as unknown as string | null),
  }));
}

/* ══ Posting ═══════════════════════════════════════════════════════════════ */

function assertShape(input: ReceiptInput): { receiptDate: string; postingDate: string } {
  if (!input.idempotencyKey?.trim()) {
    throw errors.validation('An idempotency key is required so a retry cannot receive twice.', {
      fieldErrors: { idempotencyKey: 'Send a key that stays the same across retries.' },
    });
  }
  if (!input.orderId) {
    throw errors.validation(
      'A goods receipt must name the purchase order it is delivering against. AP1 has no other '
      + 'authoritative source for the quantity that may arrive or what it cost, so a receipt '
      + 'without a controlled order would be stock and a liability nobody authorised. Record an '
      + 'unordered purchase as a direct stocked supplier bill instead.',
      { fieldErrors: { orderId: 'Choose an issued purchase order.' } },
    );
  }
  const receiptDate = input.receiptDate ?? '';
  if (!ISO_DATE.test(receiptDate)) {
    throw errors.validation('receiptDate must be an ISO date (yyyy-mm-dd).', {
      fieldErrors: { receiptDate: 'Use the format yyyy-mm-dd.' },
    });
  }
  const postingDate = input.postingDate ?? receiptDate;
  if (!ISO_DATE.test(postingDate)) {
    throw errors.validation('postingDate must be an ISO date (yyyy-mm-dd).', {
      fieldErrors: { postingDate: 'Use the format yyyy-mm-dd.' },
    });
  }
  if (!input.lines?.length) {
    throw errors.validation('Add at least one line to receive.', {
      fieldErrors: { lines: 'Choose what arrived.' },
    });
  }
  const seen = new Set<string>();
  for (const [index, line] of input.lines.entries()) {
    if (!line.orderLineId) {
      throw errors.validation(
        `Line ${index + 1} does not name a purchase-order line. Every receipt line derives its `
        + 'item, unit, warehouse, permitted quantity and cost from one, so a line without one '
        + 'could receive something nobody ordered.',
        { fieldErrors: { [`lines.${index + 1}.orderLineId`]: 'Choose an order line.' } },
      );
    }
    if (seen.has(line.orderLineId)) {
      throw errors.validation(
        `Line ${index + 1} receives against an order line this receipt has already taken. Combine `
        + 'them into one line, or record the second delivery as its own receipt.',
        { fieldErrors: { [`lines.${index + 1}.orderLineId`]: 'This line is already on this receipt.' } },
      );
    }
    seen.add(line.orderLineId);
  }
  return { receiptDate, postingDate };
}

async function findByKey(
  db: Executor,
  actor: InventoryActor,
  key: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('goods_receipts')
    .select('id')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('idempotency_key', '=', key)
    .executeTakeFirst();
  return row?.id ?? null;
}

/**
 * Receive goods against an issued purchase order.
 *
 * Returns `created: false` when the idempotency key had already posted, so a
 * caller can tell "your delivery is now in the books" from "your delivery was
 * already in the books" — a distinction that decides whether a screen should
 * say a second receipt exists.
 */
export async function postReceipt(
  db: Kysely<Database>,
  actor: InventoryActor,
  input: ReceiptInput,
): Promise<{ receipt: ReceiptRecord; created: boolean }> {
  assertWithinBoundary(input);
  const dates = assertShape(input);

  const already = await findByKey(db, actor, input.idempotencyKey);
  if (already) return { receipt: await getReceipt(db, actor, already), created: false };

  const outcome = await db.transaction().execute(async (trx) => {
    /* The window between the read above and here is exactly where a retry lands. */
    const raced = await findByKey(trx, actor, input.idempotencyKey);
    if (raced) return { id: raced, created: false };

    /*
     * The order first, FOR UPDATE, and before anything is summed.
     *
     * Every receipt against this order queues here, which is what makes the
     * remaining-quantity read below authoritative rather than a snapshot that
     * a concurrent receipt has already invalidated. Taking it before the item
     * advisory locks the stock engine uses also fixes one global lock order —
     * order row, then order lines, then items — so two receipts touching the
     * same items in different orders cannot deadlock.
     */
    const order = await trx
      .selectFrom('purchase_orders')
      .selectAll()
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', input.orderId)
      .forUpdate()
      .executeTakeFirst();
    if (!order) {
      throw errors.validation(
        'That purchase order is not in these books. A receipt may only deliver against an order '
        + "this company owns — which is what stops one company's goods arriving on another's "
        + 'shelves.',
        { fieldErrors: { orderId: 'Choose a purchase order from this company.' } },
      );
    }
    if (!RECEIVABLE.includes(order.status as OrderStatus)) {
      throw errors.conflict(
        order.status === 'draft' || order.status === 'approved'
          ? 'This purchase order has not been issued to the supplier yet, so nothing can have '
            + 'arrived against it. Issue it first — approval authorises the spend, issue is what '
            + 'sends the document.'
          : `This purchase order is ${order.status.replace('_', ' ')} and cannot receive more `
            + 'stock. Its history and everything already received are untouched.',
      );
    }

    /*
     * The order's lines, locked in a deterministic order.
     *
     * By id rather than by line number, because id is the order every other
     * transaction in the system can agree on without first reading the rows it
     * is about to lock.
     */
    const orderLines = await trx
      .selectFrom('purchase_order_lines')
      .selectAll()
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('order_id', '=', order.id)
      .orderBy('id', 'asc')
      .forUpdate()
      .execute();

    const byId = new Map(orderLines.map((line) => [line.id, line]));
    const decimals = await monetaryDecimalsOf(trx, actor);
    const unitDecimals = new Map(
      await Promise.all(orderLines.map(async (line) => [
        line.base_unit_id, await unitDecimalsOf(trx, actor, line.base_unit_id),
      ] as const)),
    );

    /* Already received, per line, from POSTED receipts only. */
    const receivedRows = await trx
      .selectFrom('goods_receipt_lines as l')
      .innerJoin('goods_receipts as r', (join) => join
        .onRef('r.id', '=', 'l.receipt_id')
        .onRef('r.organization_id', '=', 'l.organization_id')
        .onRef('r.company_id', '=', 'l.company_id'))
      .select((eb) => [
        'l.order_line_id',
        eb.fn.sum<string>('l.received_quantity').as('quantity'),
        eb.fn.sum<string>('l.total_cost').as('value'),
      ])
      .where('l.organization_id', '=', actor.organizationId)
      .where('l.company_id', '=', actor.companyId)
      .where('l.order_id', '=', order.id)
      .where('r.status', '=', 'posted')
      .groupBy('l.order_line_id')
      .execute();

    const receivedSoFarByLine = new Map<string, { quantity: Money.Amount; value: Money.Amount }>();
    for (const row of receivedRows) {
      receivedSoFarByLine.set(row.order_line_id, {
        quantity: Money.toAmount(String(row.quantity ?? '0'), 'quantity'),
        value: Money.toAmount(String(row.value ?? '0'), 'value'),
      });
    }

    interface Planned {
      orderLineId: string;
      itemId: string;
      baseUnitId: string;
      warehouseId: string;
      itemCode: string;
      itemName: string;
      baseUnitCode: string;
      warehouseCode: string;
      quantity: Money.Amount;
      value: Money.Amount;
    }

    const planned: Planned[] = [];
    for (const [index, line] of input.lines.entries()) {
      const at = index + 1;
      const orderLine = byId.get(line.orderLineId);
      if (!orderLine) {
        throw errors.validation(
          `Line ${at} names an order line that does not belong to purchase order `
          + `${order.order_number}. A receipt line's item, unit, warehouse, permitted quantity and `
          + 'cost all come from its order line, so one from another order would receive the wrong '
          + 'goods at the wrong price.',
          { fieldErrors: { [`lines.${at}.orderLineId`]: 'Choose a line from this order.' } },
        );
      }

      /*
       * Validated against the UNIT's precision, and refused at zero: a receipt
       * of nothing moves nothing and would post an empty journal. A negative
       * quantity is not a return — returns are AP2 — and is refused by shape.
       */
      const quantity = toQuantity(
        line.quantity, unitDecimals.get(orderLine.base_unit_id) ?? 0, `lines.${at}.quantity`,
      );

      const ordered = Money.toAmount(orderLine.ordered_quantity, 'orderedQuantity');
      const receivedSoFar = receivedSoFarByLine.get(orderLine.id)
        ?? { quantity: Money.ZERO, value: Money.ZERO };
      const remaining = ordered - receivedSoFar.quantity;

      if (remaining <= 0n) {
        throw errors.validation(
          `Line ${at}: order line ${orderLine.line_number} (${orderLine.item_code}) has already `
          + 'been received in full. There is no over-receipt tolerance in this product: a delivery '
          + 'larger than the order is a commercial change, and amending the order is what records '
          + 'that decision.',
          { fieldErrors: { [`lines.${at}.quantity`]: 'Nothing remains on this line.' } },
        );
      }
      if (quantity > remaining) {
        throw errors.validation(
          `Line ${at}: ${Money.describe(quantity)} would exceed what is still outstanding on order `
          + `line ${orderLine.line_number} (${orderLine.item_code}), which is `
          + `${Money.describe(remaining)}. There is no over-receipt tolerance in this product — a `
          + 'delivery larger than the order is a commercial change, and amending the order is what '
          + 'records that decision.',
          { fieldErrors: { [`lines.${at}.quantity`]: `At most ${Money.describe(remaining)}.` } },
        );
      }

      /*
       * The value, from the ORDER, and exact across the whole line.
       *
       * The receipt that completes a line takes whatever is left of its net,
       * rather than its own rounded pro-rata share. Three units bought for ten
       * and received one at a time would otherwise strand a fraction in GRNI
       * that no supplier invoice could ever clear.
       */
      const net = Money.toAmount(orderLine.net_amount, 'netAmount');
      const value = quantity === remaining
        ? net - receivedSoFar.value
        : Money.roundTo(shareOf(net, quantity, ordered), decimals);

      planned.push({
        orderLineId: orderLine.id,
        itemId: orderLine.item_id,
        baseUnitId: orderLine.base_unit_id,
        warehouseId: orderLine.warehouse_id,
        itemCode: orderLine.item_code,
        itemName: orderLine.item_name,
        baseUnitCode: orderLine.base_unit_code,
        warehouseCode: orderLine.warehouse_code,
        quantity,
        value: value < 0n ? Money.ZERO : value,
      });
    }

    const totalValue = Money.sum(planned.map((row) => row.value));
    const receiptNumber = await allocatePurchasingNumber(
      trx, actor, 'goods-receipt', dates.postingDate,
    );

    /*
     * The receipt row first, so the stock document can name it: the movement's
     * document carries `source_goods_receipt_id`, which is what lets any
     * movement be traced back to the arrival and the order behind it. The
     * document pointer comes back the other way a moment later, once the
     * document exists.
     */
    let created: { id: string };
    try {
      created = await trx.insertInto('goods_receipts').values({
        organization_id: actor.organizationId,
        company_id: actor.companyId,
        receipt_number: receiptNumber,
        order_id: order.id,
        supplier_id: order.supplier_id,
        receipt_date: dates.receiptDate,
        posting_date: dates.postingDate,
        delivery_note_reference: (input.deliveryNoteReference ?? '').trim(),
        memo: (input.memo ?? '').trim(),
        status: 'posted',
        total_value: Money.toDecimalString(totalValue),
        idempotency_key: input.idempotencyKey,
        received_by: actor.userId,
      } as never).returning('id').executeTakeFirstOrThrow();
    } catch (cause) {
      if (isDuplicateKey(cause)) {
        /* Lost the race. The statement has aborted this transaction, so the
         * honest move is to roll back and answer from the winner outside. */
        throw errors.conflict(
          'That delivery is already being recorded. Retry in a moment — it will not be received '
          + 'twice.',
        );
      }
      throw cause;
    }

    /*
     * The stock, through the I2 engine and nothing beside it.
     *
     * The engine takes the item locks in sorted order, refuses backdating
     * behind an item's own history, enforces the posting-period gate,
     * re-validates the Inventory and GRNI accounts at the moment of writing,
     * advances the weighted average and posts ONE balanced Dr Inventory /
     * Cr GRNI entry from the same `total_cost` the movement carries. A second
     * valuation engine here would be a second answer, and the two would
     * disagree the first time either changed.
     */
    const stockLines: StockLineInput[] = planned.map((row) => ({
      itemId: row.itemId,
      warehouseId: row.warehouseId,
      quantity: Money.toDecimalString(row.quantity),
      serverTotalCost: Money.toDecimalString(row.value),
    }));

    const document = await postDocumentIn(trx, actor, {
      kind: 'purchase-receipt',
      movementDate: dates.receiptDate,
      postingDate: dates.postingDate,
      reference: receiptNumber,
      memo: `Received on ${order.order_number}`,
      idempotencyKey: `goods-receipt:${created.id}`,
      sourceGoodsReceiptId: created.id,
      lines: stockLines,
    });

    await trx.updateTable('goods_receipts')
      .set({ inventory_document_id: document.id } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', created.id)
      .execute();

    /*
     * What each line was ACTUALLY costed at, read back from the movements the
     * engine wrote rather than recomputed here. Recomputing would be a second
     * answer to the same question, and only one of the two would reconcile.
     */
    const movements = await trx
      .selectFrom('inventory_movements')
      .select(['id', 'line_number', 'unit_cost', 'total_cost'])
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('document_id', '=', document.id)
      .orderBy('line_number', 'asc')
      .execute();

    if (movements.length !== planned.length) {
      /* Unreachable: one receipt line makes exactly one inbound movement. Said
       * out loud so a future change to the engine cannot silently break it. */
      throw errors.conflict(
        'The stock ledger recorded a different number of movements from the lines received. '
        + 'Nothing has been saved.',
      );
    }

    let lineNumber = 0;
    for (const row of planned) {
      const movement = movements[lineNumber]!;
      lineNumber += 1;
      await trx.insertInto('goods_receipt_lines').values({
        organization_id: actor.organizationId,
        company_id: actor.companyId,
        receipt_id: created.id,
        line_number: lineNumber,
        order_id: order.id,
        order_line_id: row.orderLineId,
        item_id: row.itemId,
        base_unit_id: row.baseUnitId,
        warehouse_id: row.warehouseId,
        received_quantity: Money.toDecimalString(row.quantity),
        unit_cost: movement.unit_cost,
        total_cost: movement.total_cost,
        movement_id: movement.id,
        item_code: row.itemCode,
        item_name: row.itemName,
        base_unit_code: row.baseUnitCode,
        warehouse_code: row.warehouseCode,
      } as never).execute();
    }

    /* Derived from the receipts that now include this one, under the same lock. */
    const status = await refreshOrderStatusIn(trx, actor, order.id);

    await writePurchasingAudit(trx, actor, {
      subjectType: 'receipt',
      subjectId: created.id,
      action: 'GOODS_RECEIPT_POSTED',
      resultingVersion: 1,
      detail: {
        receiptNumber,
        orderId: order.id,
        orderNumber: order.order_number,
        lines: planned.length,
        totalValue: Money.toDecimalString(totalValue),
        inventoryDocumentId: document.id,
      },
    });
    await writePurchasingAudit(trx, actor, {
      subjectType: 'order',
      subjectId: order.id,
      action: 'PURCHASE_ORDER_RECEIPT_POSTED',
      detail: { receiptId: created.id, receiptNumber, status },
    });

    return { id: created.id, created: true };
  });

  return { receipt: await getReceipt(db, actor, outcome.id), created: outcome.created };
}

async function unitDecimalsOf(
  trx: Trx,
  actor: InventoryActor,
  unitId: string,
): Promise<number> {
  const row = await trx
    .selectFrom('units_of_measure')
    .select('decimal_places')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', unitId)
    .executeTakeFirst();
  return Number(row?.decimal_places ?? 0);
}

async function monetaryDecimalsOf(trx: Trx, actor: InventoryActor): Promise<number> {
  const org = await trx
    .selectFrom('organizations')
    .select('base_currency')
    .where('id', '=', actor.organizationId)
    .executeTakeFirst();
  return monetaryDecimalsFor(org?.base_currency);
}

/**
 * `whole x part / total`, on scaled amounts, rounded half away from zero.
 *
 * Every value here is positive — a quantity, a net amount, an ordered quantity
 * — so the rounding is a plain half-up. Truncating instead would bias every
 * partial receipt downwards, and a hundred of them would leave a visible
 * residue in GRNI that no invoice could clear.
 */
function shareOf(whole: Money.Amount, part: Money.Amount, total: Money.Amount): Money.Amount {
  if (total === 0n) return Money.ZERO;
  return (whole * part + total / 2n) / total;
}

function isDuplicateKey(cause: unknown): boolean {
  const code = (cause as { code?: string })?.code;
  const message = String((cause as { message?: string })?.message ?? '');
  return code === '23505' || /goods_receipts_key_unique|duplicate key/i.test(message);
}

/* ══ Reversal ══════════════════════════════════════════════════════════════ */

export const ALREADY_REVERSED = 'This goods receipt has already been reversed.';

/**
 * Dependencies that must block a reversal, checked in one place.
 *
 * Today there is exactly one class of them and I2 owns it: the received
 * quantity has to still be in the warehouse, because a reversal restores a
 * position rather than driving one below zero. AP2 adds a second — a receipt
 * matched to a posted supplier invoice cannot be withdrawn without unmatching
 * it first — and it belongs here, beside this comment, rather than in a new
 * ledger. The check is named and called separately so adding it does not mean
 * redesigning anything.
 */
async function assertNoLiveDependencies(
  trx: Trx,
  actor: InventoryActor,
  receiptId: string,
  receiptNumber: string,
): Promise<void> {
  /*
   * AP2's answer, in the place AP1 left for it: a receipt whose accrual a
   * posted bill has cleared cannot be withdrawn. The payable and the recovered
   * input tax were recognised against these goods, and taking the receipt away
   * would leave both standing with nothing behind them. The bill is reversed
   * first — which its own rules refuse while a payment settles it — and only
   * then the receipt.
   */
  await assertNoLiveMatches(trx, actor, receiptId, receiptNumber);
}

/**
 * Withdraw a posted receipt: the stock, the accounting and the order status.
 *
 * Idempotent by construction. A retry of the same attempt carries the version
 * the receipt had BEFORE the reversal, so a second call with that version finds
 * the work already done and answers with it instead of failing — and two
 * simultaneous calls produce exactly one reversal, because the second waits on
 * the row lock and then takes that same path.
 */
export async function reverseReceipt(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
  expectedVersion: number,
  reason: string,
): Promise<ReceiptRecord> {
  const text = assertReversalReason(reason);

  await db.transaction().execute(async (trx) => {
    const receipt = await trx
      .selectFrom('goods_receipts')
      .selectAll()
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!receipt) throw errors.notFound('Goods receipt');

    if (receipt.status === 'reversed') {
      /*
       * The retry case: the caller is holding the version this receipt had
       * before it was withdrawn, so this IS the request that withdrew it,
       * arriving a second time. Answering with the result rather than an error
       * is what makes the operation idempotent.
       */
      if (Number(receipt.version) === expectedVersion + 1) return;
      throw errors.conflict(ALREADY_REVERSED);
    }
    if (Number(receipt.version) !== expectedVersion) {
      throw errors.conflict(
        'This goods receipt was changed by another user while you were looking at it. Review the '
        + 'latest version before withdrawing it.',
      );
    }

    await assertNoLiveDependencies(trx, actor, id, receipt.receipt_number);

    /* The order, locked before its status is re-derived below. */
    const order = await trx
      .selectFrom('purchase_orders')
      .select(['id', 'order_number', 'status'])
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', receipt.order_id)
      .forUpdate()
      .executeTakeFirstOrThrow();

    /*
     * The stock, through I2's own reversal — inside THIS transaction.
     *
     * That is where the dependency and quantity controls live: the received
     * goods must still be on the shelf, because the counter-movements carry the
     * ORIGINAL quantity and cost and a reversal is not allowed to drive a
     * warehouse below zero. It also posts the reversing Inventory/GRNI entry,
     * so the subledger and the ledger leave together.
     */
    let reversalDocumentId: string | null = null;
    if (receipt.inventory_document_id) {
      const document = await trx
        .selectFrom('inventory_documents')
        .select(['version'])
        .where('organization_id', '=', actor.organizationId)
        .where('company_id', '=', actor.companyId)
        .where('id', '=', receipt.inventory_document_id)
        .executeTakeFirstOrThrow();
      reversalDocumentId = await reverseDocumentIn(
        trx, actor, receipt.inventory_document_id, Number(document.version),
        `Goods receipt ${receipt.receipt_number} withdrawn: ${text}`,
      );
    }

    await trx.updateTable('goods_receipts').set({
      status: 'reversed',
      reversal_document_id: reversalDocumentId,
      reversal_reason: text,
      reversed_at: new Date(),
      reversed_by: actor.userId,
      version: Number(receipt.version) + 1,
      updated_at: new Date(),
    } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .execute();

    /*
     * The order's remaining quantity is restored by this and nothing else: it
     * is summed over POSTED receipts, and this one has just left that set.
     */
    const status = await refreshOrderStatusIn(trx, actor, order.id);

    await writePurchasingAudit(trx, actor, {
      subjectType: 'receipt',
      subjectId: id,
      action: 'GOODS_RECEIPT_REVERSED',
      previousVersion: Number(receipt.version),
      resultingVersion: Number(receipt.version) + 1,
      detail: { receiptNumber: receipt.receipt_number, reason: text, reversalDocumentId },
    });
    await writePurchasingAudit(trx, actor, {
      subjectType: 'order',
      subjectId: order.id,
      action: 'PURCHASE_ORDER_RECEIPT_REVERSED',
      detail: { receiptId: id, receiptNumber: receipt.receipt_number, status },
    });
  });

  return getReceipt(db, actor, id);
}

/* ══ Received not invoiced ═════════════════════════════════════════════════ */

export interface GrniRow {
  /** The stock document that credited GRNI. Always present. */
  documentId: string;
  documentNumber: string;
  documentKind: string;
  postingDate: string;
  /** Null for a standalone warehouse receipt, which has no order behind it. */
  receiptId: string | null;
  receiptNumber: string | null;
  orderId: string | null;
  orderNumber: string | null;
  supplierId: string | null;
  supplierName: string | null;
  itemId: string;
  itemCode: string;
  itemName: string;
  warehouseId: string;
  warehouseCode: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  quantity: string;
  /** What the receipt credited to the accrual. Frozen by AP1. */
  value: string;
  /** What supplier bills have since cleared, from ACTIVE matches only. */
  clearedValue: string;
  /** Still owed to nobody in particular: value less what was cleared. */
  openValue: string;
  /** True once a bill has cleared any of this line. Never inferred. */
  matched: boolean;
}

export interface GrniSchedule {
  asOfDate: string | null;
  rows: GrniRow[];
  total: string;
  /** The GRNI credit standing in the general ledger at the same cutoff. */
  generalLedgerBalance: string;
  difference: string;
  balanced: boolean;
  /**
   * Whether the product can match a receipt to a supplier invoice at all.
   *
   * True since AP2. Stated rather than assumed, so a reader knows an unmatched
   * row is genuinely awaiting an invoice rather than awaiting a feature.
   */
  matchingImplemented: boolean;
}

/**
 * What has been received and not yet invoiced, and whether it agrees with the
 * ledger.
 *
 * ══ Why the schedule covers more than AP1's own receipts ═════════════════════
 *
 * The standalone warehouse receipt that I2 has always supported credits the
 * SAME goods-received-not-invoiced account. A schedule listing only ordered
 * receipts would therefore never equal the account it claims to explain, and
 * the difference would look like a bug in the books rather than a document the
 * report had chosen to ignore. So every posted, unreversed inbound movement
 * whose frozen offset is the GRNI account appears here, labelled by the kind of
 * document that made it — with a null supplier for the ones that have no order
 * behind them, because inventing one would be worse than saying so.
 *
 * ══ Why the offset account is read from the MOVEMENT ═════════════════════════
 *
 * `offset_account_id` is frozen on the movement at posting. Reading the current
 * profile instead would silently re-scope the whole schedule the day somebody
 * changed the mapping, and last year's receipts would vanish from a report that
 * still had to reconcile to last year's ledger.
 */
export async function grniSchedule(
  db: Kysely<Database>,
  actor: InventoryActor,
  query: { asOfDate?: string; supplierId?: string; itemId?: string } = {},
): Promise<GrniSchedule> {
  const asOf = query.asOfDate ?? null;

  const settings = await db
    .selectFrom('inventory_settings')
    .select('goods_received_not_invoiced_account_id')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .executeTakeFirst();

  /*
   * Which accounts this schedule is about.
   *
   * Normally the one on the profile. But the profile can be re-pointed, or
   * cleared, after receipts have already posted — and the movements keep the
   * account they actually credited. So the accounts a receipt movement has
   * frozen are added too: a schedule that silently dropped last year's receipts
   * because somebody changed a setting would stop explaining last year's ledger,
   * with nothing to say why.
   */
  const frozen = await db
    .selectFrom('inventory_movements')
    .select('offset_account_id')
    .distinct()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('status', '=', 'posted')
    .where('movement_type', '=', 'receipt')
    .where('direction', '=', 'in')
    .where('offset_account_id', 'is not', null)
    .execute();

  const accountIds = [...new Set([
    ...(settings?.goods_received_not_invoiced_account_id
      ? [settings.goods_received_not_invoiced_account_id] : []),
    ...frozen.map((row) => row.offset_account_id).filter((id): id is string => Boolean(id)),
  ])];

  if (accountIds.length === 0) {
    return {
      asOfDate: asOf,
      rows: [],
      total: '0',
      generalLedgerBalance: '0',
      difference: '0',
      balanced: true,
      matchingImplemented: true as const,
    };
  }

  let builder = db
    .selectFrom('inventory_movements as m')
    .innerJoin('inventory_documents as d', (join) => join
      .onRef('d.id', '=', 'm.document_id')
      .onRef('d.organization_id', '=', 'm.organization_id')
      .onRef('d.company_id', '=', 'm.company_id'))
    .innerJoin('accounts as a', (join) => join
      .onRef('a.id', '=', 'm.offset_account_id')
      .onRef('a.organization_id', '=', 'm.organization_id')
      .onRef('a.company_id', '=', 'm.company_id'))
    .leftJoin('goods_receipts as r', (join) => join
      .onRef('r.id', '=', 'd.source_goods_receipt_id')
      .onRef('r.organization_id', '=', 'd.organization_id')
      .onRef('r.company_id', '=', 'd.company_id'))
    .leftJoin('purchase_orders as o', (join) => join
      .onRef('o.id', '=', 'r.order_id')
      .onRef('o.organization_id', '=', 'r.organization_id')
      .onRef('o.company_id', '=', 'r.company_id'))
    /*
     * The receipt line behind this movement, so a clearing can be attributed to
     * it. A standalone warehouse receipt has none, and nothing can clear one —
     * which is exactly why its open value always equals its full value.
     */
    .leftJoin('goods_receipt_lines as rl', (join) => join
      .onRef('rl.movement_id', '=', 'm.id')
      .onRef('rl.organization_id', '=', 'm.organization_id')
      .onRef('rl.company_id', '=', 'm.company_id'))
    .leftJoin('business_parties as p', (join) => join
      .onRef('p.id', '=', 'r.supplier_id')
      .onRef('p.organization_id', '=', 'r.organization_id')
      .onRef('p.company_id', '=', 'r.company_id'))
    .select([
      'd.id as document_id', 'd.document_number', 'd.kind', 'd.posting_date',
      'r.id as receipt_id', 'r.receipt_number',
      'o.id as order_id', 'o.order_number',
      'r.supplier_id', 'p.legal_name as supplier_name',
      'm.item_id', 'm.item_code', 'm.item_name',
      'm.warehouse_id', 'm.warehouse_code',
      'm.quantity', 'm.total_cost',
      'a.id as account_id', 'a.account_code', 'a.account_name',
      'rl.id as receipt_line_id',
    ])
    .where('m.organization_id', '=', actor.organizationId)
    .where('m.company_id', '=', actor.companyId)
    .where('m.status', '=', 'posted')
    .where('m.direction', '=', 'in')
    .where('m.movement_type', '=', 'receipt')
    /* The frozen offset, not today's mapping. */
    .where('m.offset_account_id', 'in', accountIds);

  if (asOf) builder = builder.where('m.posting_date', '<=', asOf);
  if (query.supplierId) builder = builder.where('r.supplier_id', '=', query.supplierId);
  if (query.itemId) builder = builder.where('m.item_id', '=', query.itemId);

  const rows = await builder
    .orderBy('m.posting_date', 'asc')
    .orderBy('d.document_number', 'asc')
    .orderBy('m.line_number', 'asc')
    .execute();

  /*
   * What supplier bills have cleared against these receipt lines, from ACTIVE
   * allocations only. A reversed bill's rows leave this sum, which is exactly
   * how its capacity — and its share of the accrual — comes back.
   */
  const receiptLineIds = rows
    .map((row) => row.receipt_line_id)
    .filter((id): id is string => Boolean(id));
  const cleared = new Map<string, Money.Amount>();
  if (receiptLineIds.length > 0) {
    const clearings = await db
      .selectFrom('bill_receipt_matches')
      .select((eb) => [
        'receipt_line_id',
        eb.fn.sum<string>('matched_receipt_value').as('value'),
      ])
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('receipt_line_id', 'in', receiptLineIds)
      .where('status', '=', 'active')
      .groupBy('receipt_line_id')
      .execute();
    for (const row of clearings) {
      cleared.set(row.receipt_line_id, Money.toAmount(String(row.value ?? '0'), 'cleared'));
    }
  }

  let total = Money.ZERO;
  const mapped: GrniRow[] = rows.map((row) => {
    const value = Money.toAmount(row.total_cost, 'value');
    const clearedValue = (row.receipt_line_id && cleared.get(row.receipt_line_id)) || Money.ZERO;
    const openValue = value - clearedValue;
    /*
     * The OPEN value is what the schedule totals, because that is what the
     * account actually holds: the receipt credited it and the bill debited it
     * back. Totalling the gross receipt value would report an accrual the
     * ledger no longer carries.
     */
    total += openValue;
    return {
      documentId: row.document_id,
      documentNumber: row.document_number,
      documentKind: row.kind,
      postingDate: toCalendarDate(row.posting_date),
      receiptId: row.receipt_id,
      receiptNumber: row.receipt_number,
      orderId: row.order_id,
      orderNumber: row.order_number,
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      itemId: row.item_id,
      itemCode: row.item_code,
      itemName: row.item_name,
      warehouseId: row.warehouse_id,
      warehouseCode: row.warehouse_code,
      accountId: row.account_id,
      accountCode: row.account_code,
      accountName: row.account_name,
      quantity: row.quantity,
      value: row.total_cost,
      clearedValue: Money.toDecimalString(clearedValue),
      openValue: Money.toDecimalString(openValue),
      matched: clearedValue !== Money.ZERO,
    };
  });

  /*
   * The ledger side, counted exactly as the ledger service counts it: posted
   * AND reversed entries both, because reversing withdraws an entry and adds a
   * cancelling one — counting only posted rows would leave the reversal in and
   * the original out, and the account would read as if the receipt had happened
   * backwards. GRNI is a credit balance, so the sign is flipped to compare with
   * the schedule's positive values.
   */
  const { rows: balance } = await sql<{ balance: string }>`
    SELECT COALESCE(SUM(COALESCE(l.credit_functional, 0) - COALESCE(l.debit_functional, 0)), 0)::text
           AS balance
      FROM journal_lines l
      JOIN journal_entries e
        ON e.id = l.journal_entry_id
       AND e.organization_id = l.organization_id
       AND e.company_id = l.company_id
     WHERE l.organization_id = ${actor.organizationId}
       AND l.company_id = ${actor.companyId}
       AND l.account_id = ANY(${accountIds}::uuid[])
       AND e.status IN ('posted', 'reversed')
       AND (${asOf}::date IS NULL OR e.posting_date <= ${asOf}::date)
  `.execute(db);
  const ledger = Money.toAmount(balance[0]?.balance ?? '0', 'balance');

  /*
   * Compared as exact scaled integers. A float comparison deciding whether the
   * books agree is the one question that must never be answered approximately.
   *
   * The comparison is only meaningful when the schedule was not narrowed: a
   * supplier or item filter shows part of the account, and calling that
   * "unbalanced" would be reporting the filter as a discrepancy.
   */
  const whole = !query.supplierId && !query.itemId;
  const difference = whole ? total - ledger : Money.ZERO;

  return {
    asOfDate: asOf,
    rows: mapped,
    total: Money.toDecimalString(total),
    generalLedgerBalance: Money.toDecimalString(ledger),
    difference: Money.toDecimalString(difference),
    balanced: whole ? difference === Money.ZERO : true,
    matchingImplemented: true as const,
  };
}

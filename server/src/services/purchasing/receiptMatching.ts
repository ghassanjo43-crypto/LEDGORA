/**
 * Matching a supplier bill to AP1 goods receipts, and clearing the accrual.
 *
 * ══ What matching recognises ═════════════════════════════════════════════════
 *
 * AP1 put the goods in stock against an accrual — Dr Inventory / Cr GRNI — and
 * recognised no debt and no tax, because no supplier had invoiced anything. The
 * bill is what changes that:
 *
 *   Dr Goods received not invoiced   (the matched receipt value, exactly)
 *   Dr Recoverable input tax         (P3, on the bill's own posting date)
 *       Cr Accounts payable          (what the supplier is owed)
 *
 * and NO inventory movement. The goods arrived once and were costed once. This
 * module therefore never calls the stock engine, never writes a movement, and
 * never touches an AP1 movement's frozen cost or the average it fed.
 *
 * ══ Why the value must match exactly, and what happens when it does not ══════
 *
 * The product does not resolve what a receipt-to-invoice price difference does.
 * The inventory specification states the bill entry as three legs with no
 * variance line; the only purchase-price-variance it defines sits under
 * standard costing, which this product does not implement for movements. And
 * the difference could not be allocated even if a destination existed: this is
 * moving-average costing with no cost layers, so nothing can say how many of a
 * PARTICULAR receipt's units are still on hand.
 *
 * So a matched line's net must equal the receipt's own frozen value for that
 * quantity, and a difference is REFUSED by name. That is not a limitation
 * dressed up as a rule — it is the only answer that leaves inventory, profit
 * and the accrual where the evidence puts them. A future slice that establishes
 * a variance policy has `value_difference` waiting for it, and the constraint
 * saying it has always been zero.
 *
 * ══ Why capacity is summed and never stored ══════════════════════════════════
 *
 * A receipt line's matched, unmatched and remaining figures are sums over
 * ACTIVE allocations, taken under that line's row lock inside the posting
 * transaction. Two bills competing for the last unit therefore serialise on the
 * lock: the second re-reads what the first committed and is refused. A stored
 * counter could not give that guarantee, and a check taken before the lock
 * would only look like one.
 *
 * ══ How a partial clearing stays exact ═══════════════════════════════════════
 *
 * The bill that settles the LAST of a receipt line takes whatever remains of its
 * value, rather than its own rounded share. That is the rule AP1 already uses
 * when a receipt completes an order line, and it is what makes the clearings
 * sum to the receipt's value to the fils instead of stranding a rounding
 * residue in GRNI that no invoice could ever clear.
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import * as Money from '../accounting/money.js';
import { toCalendarDate } from '../accounting/calendarDate.js';
import { assessPostingAccount } from '../accounting/accountEligibility.js';
import type { InventoryActor } from '../inventory/inventoryCore.js';
import { toQuantity } from '../inventory/stockLedger.js';
import { writePurchasingAudit } from './purchaseOrderService.js';

type Trx = Transaction<Database>;
type Executor = Kysely<Database> | Trx;

/* ══ Refusals ══════════════════════════════════════════════════════════════ */

export const VARIANCE_DEFERRED =
  'Purchase-price variance has no defined destination in this product. The inventory specification '
  + 'states the supplier-bill entry as goods-received-not-invoiced, input tax and the payable — '
  + 'three legs, with no variance line — and the only purchase-price variance it defines sits under '
  + 'standard costing, which is not implemented for stock movements. Nor could the difference be '
  + 'allocated: stock is valued at a moving average with no cost layers, so nothing can say how '
  + 'many of this receipt\'s units are still on hand. Recording it anywhere would be inventing an '
  + 'accounting rule, so the bill is refused instead.';

export const RETURNS_DEFERRED =
  'Purchase returns, supplier debit notes and supplier credits are not implemented. A return has no '
  + 'stated journal before the bill is posted, a supplier credit has no tax code, no effective-dated '
  + 'rate and no tax point, and neither has any treatment once the bill has been paid. Those are '
  + 'three undefined accounting rules, and this product will not invent them.';

export const BILLED_BEFORE_RECEIVED =
  'This bill would settle more than has actually arrived. Billing ahead of the goods needs a '
  + 'goods-invoiced-not-received asset to hold the difference, and this product defines none — so '
  + 'the amount would have nowhere to sit. Receive the goods first, or bill only what is in.';

/* ══ Capacity ══════════════════════════════════════════════════════════════ */

export interface ReceiptLineCapacity {
  receiptLineId: string;
  receiptId: string;
  receiptNumber: string;
  receiptDate: string;
  postingDate: string;
  orderId: string;
  orderLineId: string;
  orderNumber: string;
  supplierId: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  baseUnitId: string;
  baseUnitCode: string;
  warehouseId: string;
  warehouseCode: string;
  /** What arrived, and what it was costed at. Both frozen by AP1. */
  receivedQuantity: string;
  unitCost: string;
  receiptValue: string;
  /** Summed from ACTIVE allocations. Never stored. */
  matchedQuantity: string;
  matchedValue: string;
  remainingQuantity: string;
  /** The accrual still open on this line: receipt value less what bills cleared. */
  remainingValue: string;
}

/** Active allocations against a set of receipt lines, as exact amounts. */
async function activeMatches(
  db: Executor,
  actor: InventoryActor,
  receiptLineIds: readonly string[],
): Promise<Map<string, { quantity: Money.Amount; value: Money.Amount }>> {
  const totals = new Map<string, { quantity: Money.Amount; value: Money.Amount }>();
  if (receiptLineIds.length === 0) return totals;

  const rows = await db
    .selectFrom('bill_receipt_matches')
    .select((eb) => [
      'receipt_line_id',
      eb.fn.sum<string>('matched_quantity').as('quantity'),
      eb.fn.sum<string>('matched_receipt_value').as('value'),
    ])
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('receipt_line_id', 'in', receiptLineIds as string[])
    .where('status', '=', 'active')
    .groupBy('receipt_line_id')
    .execute();

  for (const row of rows) {
    totals.set(row.receipt_line_id, {
      quantity: Money.toAmount(String(row.quantity ?? '0'), 'quantity'),
      value: Money.toAmount(String(row.value ?? '0'), 'value'),
    });
  }
  return totals;
}

/**
 * Receipt lines a supplier bill may still settle.
 *
 * Only posted, unreversed receipts, and only lines with something left. The
 * remaining value is the receipt's own frozen value less what active bills have
 * already cleared — which is exactly the open accrual, so this list and the
 * GRNI schedule cannot disagree.
 */
export async function eligibleReceiptLines(
  db: Kysely<Database>,
  actor: InventoryActor,
  query: { supplierId?: string; orderId?: string; receiptId?: string } = {},
): Promise<ReceiptLineCapacity[]> {
  let builder = db
    .selectFrom('goods_receipt_lines as l')
    .innerJoin('goods_receipts as r', (join) => join
      .onRef('r.id', '=', 'l.receipt_id')
      .onRef('r.organization_id', '=', 'l.organization_id')
      .onRef('r.company_id', '=', 'l.company_id'))
    .innerJoin('purchase_orders as o', (join) => join
      .onRef('o.id', '=', 'r.order_id')
      .onRef('o.organization_id', '=', 'r.organization_id')
      .onRef('o.company_id', '=', 'r.company_id'))
    .select([
      'l.id as line_id', 'l.receipt_id', 'l.order_id', 'l.order_line_id',
      'l.item_id', 'l.item_code', 'l.item_name', 'l.base_unit_id', 'l.base_unit_code',
      'l.warehouse_id', 'l.warehouse_code',
      'l.received_quantity', 'l.unit_cost', 'l.total_cost',
      'r.receipt_number', 'r.receipt_date', 'r.posting_date', 'r.supplier_id',
      'o.order_number',
    ])
    .where('l.organization_id', '=', actor.organizationId)
    .where('l.company_id', '=', actor.companyId)
    /* A reversed receipt has no accrual left to clear. */
    .where('r.status', '=', 'posted');

  if (query.supplierId) builder = builder.where('r.supplier_id', '=', query.supplierId);
  if (query.orderId) builder = builder.where('l.order_id', '=', query.orderId);
  if (query.receiptId) builder = builder.where('l.receipt_id', '=', query.receiptId);

  const rows = await builder
    .orderBy('r.posting_date', 'asc')
    .orderBy('r.receipt_number', 'asc')
    .orderBy('l.line_number', 'asc')
    .execute();

  const matched = await activeMatches(db, actor, rows.map((row) => row.line_id));

  const open: ReceiptLineCapacity[] = [];
  for (const row of rows) {
    const received = Money.toAmount(row.received_quantity, 'receivedQuantity');
    const value = Money.toAmount(row.total_cost, 'totalCost');
    const got = matched.get(row.line_id) ?? { quantity: Money.ZERO, value: Money.ZERO };
    const remainingQuantity = received - got.quantity;
    if (remainingQuantity <= 0n) continue;

    open.push({
      receiptLineId: row.line_id,
      receiptId: row.receipt_id,
      receiptNumber: row.receipt_number,
      receiptDate: toCalendarDate(row.receipt_date),
      postingDate: toCalendarDate(row.posting_date),
      orderId: row.order_id,
      orderLineId: row.order_line_id,
      orderNumber: row.order_number,
      supplierId: row.supplier_id,
      itemId: row.item_id,
      itemCode: row.item_code,
      itemName: row.item_name,
      baseUnitId: row.base_unit_id,
      baseUnitCode: row.base_unit_code,
      warehouseId: row.warehouse_id,
      warehouseCode: row.warehouse_code,
      receivedQuantity: row.received_quantity,
      unitCost: row.unit_cost,
      receiptValue: row.total_cost,
      matchedQuantity: Money.toDecimalString(got.quantity),
      matchedValue: Money.toDecimalString(got.value),
      remainingQuantity: Money.toDecimalString(remainingQuantity),
      remainingValue: Money.toDecimalString(value - got.value),
    });
  }
  return open;
}

/* ══ Resolving a draft line against its receipt ════════════════════════════ */

export interface ResolvedReceiptLine {
  receiptLineId: string;
  receiptId: string;
  receiptNumber: string;
  orderId: string;
  orderLineId: string;
  supplierId: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  baseUnitId: string;
  baseUnitCode: string;
  unitDecimals: number;
  /** Frozen by AP1. */
  receivedQuantity: Money.Amount;
  unitCost: Money.Amount;
  receiptValue: Money.Amount;
  /** The account AP1's movement actually credited. Frozen, never re-derived. */
  grniAccountId: string;
}

/**
 * The receipt line a bill line names, with everything the bill derives from it.
 *
 * The GRNI account comes from the MOVEMENT's frozen offset rather than from the
 * inventory profile: re-reading today's setting would let a mapping change
 * restate which account an old accrual is sitting in, and the clearing would
 * then debit an account the receipt never credited.
 */
export async function resolveReceiptLine(
  trx: Trx,
  actor: InventoryActor,
  receiptLineId: string,
  at: number,
): Promise<ResolvedReceiptLine> {
  const row = await trx
    .selectFrom('goods_receipt_lines as l')
    .innerJoin('goods_receipts as r', (join) => join
      .onRef('r.id', '=', 'l.receipt_id')
      .onRef('r.organization_id', '=', 'l.organization_id')
      .onRef('r.company_id', '=', 'l.company_id'))
    .innerJoin('units_of_measure as u', (join) => join
      .onRef('u.id', '=', 'l.base_unit_id')
      .onRef('u.organization_id', '=', 'l.organization_id')
      .onRef('u.company_id', '=', 'l.company_id'))
    .leftJoin('inventory_movements as m', (join) => join
      .onRef('m.id', '=', 'l.movement_id')
      .onRef('m.organization_id', '=', 'l.organization_id')
      .onRef('m.company_id', '=', 'l.company_id'))
    .select([
      'l.id as line_id', 'l.receipt_id', 'l.order_id', 'l.order_line_id',
      'l.item_id', 'l.item_code', 'l.item_name', 'l.base_unit_id', 'l.base_unit_code',
      'l.received_quantity', 'l.unit_cost', 'l.total_cost',
      'r.receipt_number', 'r.supplier_id', 'r.status as receipt_status',
      'u.decimal_places as unit_decimals',
      'm.offset_account_id as grni_account_id',
      'm.status as movement_status',
    ])
    .where('l.organization_id', '=', actor.organizationId)
    .where('l.company_id', '=', actor.companyId)
    .where('l.id', '=', receiptLineId)
    .executeTakeFirst();

  const field = `lines.${at}.receiptLineId`;
  if (!row) {
    throw errors.validation(
      `Line ${at} names a goods receipt line that is not in these books. A bill may only settle a `
      + "receipt this company owns — which is what stops one company's invoice clearing another's "
      + 'accrual.',
      { fieldErrors: { [field]: 'Choose a receipt line from this company.' } },
    );
  }
  if (row.receipt_status !== 'posted') {
    throw errors.validation(
      `Line ${at}: goods receipt ${row.receipt_number} has been reversed, so there is no accrual `
      + 'left for a bill to clear. The goods left the books when it was withdrawn.',
      { fieldErrors: { [field]: 'Choose a posted receipt.' } },
    );
  }
  if (!row.grni_account_id || row.movement_status !== 'posted') {
    throw errors.validation(
      `Line ${at}: the stock movement behind receipt ${row.receipt_number} is missing or no longer `
      + 'posted, so the account its accrual credited cannot be read. A clearing must debit the '
      + 'account the receipt actually credited, and this one cannot be established.',
      { fieldErrors: { [field]: 'This receipt line cannot be matched.' } },
    );
  }

  return {
    receiptLineId: row.line_id,
    receiptId: row.receipt_id,
    receiptNumber: row.receipt_number,
    orderId: row.order_id,
    orderLineId: row.order_line_id,
    supplierId: row.supplier_id,
    itemId: row.item_id,
    itemCode: row.item_code,
    itemName: row.item_name,
    baseUnitId: row.base_unit_id,
    baseUnitCode: row.base_unit_code,
    unitDecimals: Number(row.unit_decimals ?? 0),
    receivedQuantity: Money.toAmount(row.received_quantity, 'receivedQuantity'),
    unitCost: Money.toAmount(row.unit_cost, 'unitCost'),
    receiptValue: Money.toAmount(row.total_cost, 'totalCost'),
    grniAccountId: row.grni_account_id,
  };
}

/**
 * The account a clearing may debit, re-checked at the moment it is written.
 *
 * Frozen on the movement, but an account frozen there can be archived, blocked,
 * deactivated or given a child before the bill is posted — and debiting one the
 * ledger would refuse from any other door is exactly the inconsistency this
 * catches.
 */
export async function assertGrniPostable(
  trx: Trx,
  actor: InventoryActor,
  accountId: string,
  at: number,
): Promise<void> {
  const account = await trx
    .selectFrom('accounts')
    .select([
      'id', 'account_code', 'account_name', 'cash_classification',
      'is_postable', 'active', 'blocked', 'archived',
    ])
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', accountId)
    .executeTakeFirst();

  if (!account) {
    throw errors.validation(
      `Line ${at}: the goods-received-not-invoiced account this receipt credited is not in this `
      + "company's chart of accounts.",
    );
  }
  if (account.cash_classification && account.cash_classification !== 'none') {
    throw errors.validation(
      `Line ${at}: ${account.account_code} (${account.account_name}) is a cash or bank account and `
      + 'cannot carry a goods-received accrual. Stock is not money.',
    );
  }
  const children = await trx
    .selectFrom('accounts')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('parent_account_id', '=', accountId)
    .executeTakeFirst();
  const verdict = assessPostingAccount(
    {
      archived: account.archived, blocked: account.blocked,
      active: account.active, isPostable: account.is_postable,
    },
    Number(children?.n ?? '0') > 0,
  );
  if (!verdict.eligible) {
    throw errors.validation(
      `Line ${at}: ${account.account_code} (${account.account_name}) cannot receive this clearing. `
      + verdict.message,
    );
  }
}

/* ══ Posting ═══════════════════════════════════════════════════════════════ */

export interface PlannedMatch {
  billLineId: string;
  lineNumber: number;
  receipt: ResolvedReceiptLine;
  quantity: Money.Amount;
  /** The receipt value attributable to this quantity. Exact by construction. */
  receiptValue: Money.Amount;
  /** What the bill line's own net came to. Must equal the above. */
  billValue: Money.Amount;
}

/**
 * `whole x part / total`, on scaled amounts, rounded half away from zero.
 *
 * Every value is positive here. Truncating instead would bias every partial
 * clearing downwards, and enough of them would leave a residue in the accrual.
 */
function shareOf(whole: Money.Amount, part: Money.Amount, total: Money.Amount): Money.Amount {
  if (total === 0n) return Money.ZERO;
  return (whole * part + total / 2n) / total;
}

/**
 * Lock every receipt line a bill is about to settle, in a deterministic order,
 * and work out what each clearing is worth.
 *
 * Ordered by id, because that is the order every other transaction can agree on
 * without first reading the rows it is about to lock. The bill's own row is
 * already locked by the caller, so the global order is bill, then receipt lines,
 * and two bills touching the same receipts cannot deadlock.
 */
export async function planMatches(
  trx: Trx,
  actor: InventoryActor,
  input: {
    supplierId: string;
    decimals: number;
    lines: Array<{
      billLineId: string;
      lineNumber: number;
      receiptLineId: string;
      matchedQuantity: string;
      /** The line's server-computed net, from P3. Never the client's figure. */
      netAmount: Money.Amount;
    }>;
  },
): Promise<PlannedMatch[]> {
  const ordered = [...input.lines].sort((a, b) => (a.receiptLineId < b.receiptLineId ? -1 : 1));

  /* The rows themselves, locked before anything is summed. */
  await trx
    .selectFrom('goods_receipt_lines')
    .select('id')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', 'in', ordered.map((l) => l.receiptLineId))
    .orderBy('id', 'asc')
    .forUpdate()
    .execute();

  const already = await activeMatches(trx, actor, ordered.map((l) => l.receiptLineId));

  const planned: PlannedMatch[] = [];
  /* Advanced line by line, so one bill settling the same receipt line twice —
   * refused below — could not slip through by reading a stale sum. */
  const consumed = new Map<string, { quantity: Money.Amount; value: Money.Amount }>();

  for (const line of input.lines) {
    const at = line.lineNumber;
    const receipt = await resolveReceiptLine(trx, actor, line.receiptLineId, at);

    if (receipt.supplierId !== input.supplierId) {
      throw errors.validation(
        `Line ${at}: goods receipt ${receipt.receiptNumber} is from a different supplier. A bill `
        + 'settles what one supplier delivered; clearing another supplier\'s accrual with it would '
        + 'move a debt between two parties.',
        { fieldErrors: { [`lines.${at}.receiptLineId`]: 'Choose a receipt from this supplier.' } },
      );
    }

    if (consumed.has(line.receiptLineId)) {
      throw errors.validation(
        `Line ${at} settles a goods receipt line this bill has already taken. Combine them into `
        + 'one line: two lines against one delivery would split a clearing nothing can attribute.',
        { fieldErrors: { [`lines.${at}.receiptLineId`]: 'This receipt line is already on this bill.' } },
      );
    }

    const quantity = toQuantity(
      line.matchedQuantity, receipt.unitDecimals, `lines.${at}.matchedQuantity`,
    );
    const priorMatched = already.get(line.receiptLineId) ?? { quantity: Money.ZERO, value: Money.ZERO };
    const remaining = receipt.receivedQuantity - priorMatched.quantity;

    if (remaining <= 0n) {
      throw errors.validation(
        `Line ${at}: receipt ${receipt.receiptNumber} (${receipt.itemCode}) has already been billed `
        + 'in full. Its accrual is cleared, and billing it again would recognise the same debt twice.',
        { fieldErrors: { [`lines.${at}.matchedQuantity`]: 'Nothing remains on this receipt line.' } },
      );
    }
    if (quantity > remaining) {
      throw errors.validation(
        `${BILLED_BEFORE_RECEIVED} Line ${at}: ${Money.describe(quantity)} exceeds the `
        + `${Money.describe(remaining)} of ${receipt.itemCode} still unbilled on receipt `
        + `${receipt.receiptNumber}.`,
        { fieldErrors: { [`lines.${at}.matchedQuantity`]: `At most ${Money.describe(remaining)}.` } },
      );
    }

    /*
     * The clearing that completes a receipt line takes whatever remains of its
     * value, so the clearings sum to the receipt's own figure exactly rather
     * than to a rounded approximation of it.
     */
    const receiptValue = quantity === remaining
      ? receipt.receiptValue - priorMatched.value
      : Money.roundTo(
        shareOf(receipt.receiptValue, quantity, receipt.receivedQuantity), input.decimals,
      );

    /*
     * ══ Exact value, or nothing ═══════════════════════════════════════════
     *
     * The bill's own net for this quantity must be what the goods were costed
     * at. A difference is a purchase-price variance, and this product resolves
     * no destination for one — so it is refused with the reason, rather than
     * absorbed into inventory, profit or a made-up account.
     */
    if (line.netAmount !== receiptValue) {
      throw errors.validation(
        `Line ${at}: the supplier invoiced ${Money.describe(line.netAmount)} for goods received at `
        + `${Money.describe(receiptValue)} on ${receipt.receiptNumber}. ${VARIANCE_DEFERRED}`,
        {
          fieldErrors: {
            [`lines.${at}.unitPrice`]:
              `Invoice this line at ${Money.describe(receiptValue)} net, or reverse the receipt and `
              + 'raise a corrected order.',
          },
        },
      );
    }

    await assertGrniPostable(trx, actor, receipt.grniAccountId, at);

    consumed.set(line.receiptLineId, { quantity, value: receiptValue });
    planned.push({
      billLineId: line.billLineId,
      lineNumber: at,
      receipt,
      quantity,
      receiptValue,
      billValue: line.netAmount,
    });
  }

  return planned;
}

/**
 * Write the allocations, and record what each cleared.
 *
 * Called inside the bill's own posting transaction, after its journal exists,
 * so the clearing and the entry that carries it commit together or not at all.
 */
export async function recordMatches(
  trx: Trx,
  actor: InventoryActor,
  billId: string,
  billNumber: string,
  planned: readonly PlannedMatch[],
): Promise<void> {
  for (const match of planned) {
    const unitPrice = match.quantity === 0n
      ? Money.ZERO
      : (match.billValue * 10n ** BigInt(Money.SCALE)) / match.quantity;

    await trx.insertInto('bill_receipt_matches').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      bill_id: billId,
      bill_line_id: match.billLineId,
      receipt_id: match.receipt.receiptId,
      receipt_line_id: match.receipt.receiptLineId,
      order_id: match.receipt.orderId,
      order_line_id: match.receipt.orderLineId,
      supplier_id: match.receipt.supplierId,
      item_id: match.receipt.itemId,
      base_unit_id: match.receipt.baseUnitId,
      matched_quantity: Money.toDecimalString(match.quantity),
      receipt_unit_cost: Money.toDecimalString(match.receipt.unitCost),
      matched_receipt_value: Money.toDecimalString(match.receiptValue),
      bill_net_unit_price: Money.toDecimalString(unitPrice),
      matched_bill_value: Money.toDecimalString(match.billValue),
      /* Exact by construction, and asserted by a CHECK besides. */
      value_difference: '0',
      grni_account_id: match.receipt.grniAccountId,
      matched_by: actor.userId,
    } as never).execute();

    await writePurchasingAudit(trx, actor, {
      subjectType: 'match',
      subjectId: match.receipt.receiptLineId,
      action: 'RECEIPT_MATCHED_TO_BILL',
      detail: {
        billId,
        billNumber,
        receiptNumber: match.receipt.receiptNumber,
        item: match.receipt.itemCode,
        quantity: Money.toDecimalString(match.quantity),
        cleared: Money.toDecimalString(match.receiptValue),
      },
    });
  }
}

/**
 * Withdraw a bill's allocations, returning capacity to the receipts.
 *
 * The rows are marked, never removed: the history of what was once cleared is
 * the explanation for a payable that stood in the books for a while, and a
 * reader who found the reversing journal would otherwise have nothing to join
 * it to. Capacity comes back because the row leaves the ACTIVE set the sums
 * read, not because a counter moved.
 */
export async function reverseMatchesForBill(
  trx: Trx,
  actor: InventoryActor,
  billId: string,
  billNumber: string,
  reason: string,
): Promise<number> {
  const live = await trx
    .selectFrom('bill_receipt_matches')
    .select(['id', 'receipt_line_id', 'matched_quantity', 'matched_receipt_value'])
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('bill_id', '=', billId)
    .where('status', '=', 'active')
    .orderBy('id', 'asc')
    .forUpdate()
    .execute();

  if (live.length === 0) return 0;

  await trx.updateTable('bill_receipt_matches')
    .set({
      status: 'reversed',
      reversal_reason: reason,
      reversed_at: new Date(),
      reversed_by: actor.userId,
    } as never)
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('bill_id', '=', billId)
    .where('status', '=', 'active')
    .execute();

  for (const row of live) {
    await writePurchasingAudit(trx, actor, {
      subjectType: 'match',
      subjectId: row.receipt_line_id,
      action: 'RECEIPT_MATCH_REVERSED',
      detail: {
        billId,
        billNumber,
        reason,
        quantity: row.matched_quantity,
        restored: row.matched_receipt_value,
      },
    });
  }

  return live.length;
}

/**
 * Whether a goods receipt still has a live bill behind it.
 *
 * AP1 left this question for AP2 to answer. A receipt whose accrual a posted
 * bill has cleared cannot be withdrawn: the payable and the recovered input tax
 * were recognised against these goods, and taking the receipt away would leave
 * both standing with nothing behind them. The bill is reversed first — under
 * P4's own rule that a paid bill cannot be — and only then the receipt.
 */
export async function assertNoLiveMatches(
  trx: Trx,
  actor: InventoryActor,
  receiptId: string,
  receiptNumber: string,
): Promise<void> {
  const rows = await trx
    .selectFrom('bill_receipt_matches as m')
    .innerJoin('bills as b', (join) => join
      .onRef('b.id', '=', 'm.bill_id')
      .onRef('b.organization_id', '=', 'm.organization_id')
      .onRef('b.company_id', '=', 'm.company_id'))
    .select(['b.bill_number', 'b.supplier_invoice_number'])
    .where('m.organization_id', '=', actor.organizationId)
    .where('m.company_id', '=', actor.companyId)
    .where('m.receipt_id', '=', receiptId)
    .where('m.status', '=', 'active')
    .execute();

  if (rows.length === 0) return;

  const names = [...new Set(rows.map((r) => r.bill_number))].join(', ');
  throw errors.validation(
    `Goods receipt ${receiptNumber} has been billed and cannot be withdrawn. ${names} recognised a `
    + 'payable and recovered input tax against these goods, and reversing the receipt would leave '
    + 'both in the books with nothing behind them. Reverse the bill first — which its own rules '
    + 'refuse while a payment settles it — and then withdraw the receipt.',
  );
}

/* ══ Reporting ═════════════════════════════════════════════════════════════ */

export interface MatchHistoryRow {
  matchId: string;
  status: string;
  matchedAt: string | null;
  billId: string;
  billNumber: string;
  supplierInvoiceNumber: string;
  billStatus: string;
  billPostingDate: string;
  supplierId: string;
  supplierName: string;
  receiptId: string;
  receiptNumber: string;
  receiptPostingDate: string;
  orderId: string;
  orderNumber: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  baseUnitCode: string;
  matchedQuantity: string;
  receiptUnitCost: string;
  matchedReceiptValue: string;
  billNetUnitPrice: string;
  matchedBillValue: string;
  /** Zero on every row in this slice, and reported so it can be checked. */
  valueDifference: string;
  accountCode: string;
  accountName: string;
  reversalReason: string;
}

/**
 * What each bill settled, and when.
 *
 * Archived suppliers, items and accounts still appear: a clearing that happened
 * does not stop having happened because a master record was tidied away, and a
 * report that dropped it would stop explaining a payable still in the books.
 */
export async function matchHistory(
  db: Kysely<Database>,
  actor: InventoryActor,
  query: {
    supplierId?: string; receiptId?: string; billId?: string;
    status?: 'active' | 'reversed'; limit?: number;
  } = {},
): Promise<MatchHistoryRow[]> {
  let builder = db
    .selectFrom('bill_receipt_matches as m')
    .innerJoin('bills as b', (join) => join
      .onRef('b.id', '=', 'm.bill_id')
      .onRef('b.organization_id', '=', 'm.organization_id')
      .onRef('b.company_id', '=', 'm.company_id'))
    .innerJoin('goods_receipts as r', (join) => join
      .onRef('r.id', '=', 'm.receipt_id')
      .onRef('r.organization_id', '=', 'm.organization_id')
      .onRef('r.company_id', '=', 'm.company_id'))
    .innerJoin('purchase_orders as o', (join) => join
      .onRef('o.id', '=', 'm.order_id')
      .onRef('o.organization_id', '=', 'm.organization_id')
      .onRef('o.company_id', '=', 'm.company_id'))
    .leftJoin('business_parties as p', (join) => join
      .onRef('p.id', '=', 'm.supplier_id')
      .onRef('p.organization_id', '=', 'm.organization_id')
      .onRef('p.company_id', '=', 'm.company_id'))
    .leftJoin('inventory_items as i', (join) => join
      .onRef('i.id', '=', 'm.item_id')
      .onRef('i.organization_id', '=', 'm.organization_id')
      .onRef('i.company_id', '=', 'm.company_id'))
    .leftJoin('units_of_measure as u', (join) => join
      .onRef('u.id', '=', 'm.base_unit_id')
      .onRef('u.organization_id', '=', 'm.organization_id')
      .onRef('u.company_id', '=', 'm.company_id'))
    .leftJoin('accounts as a', (join) => join
      .onRef('a.id', '=', 'm.grni_account_id')
      .onRef('a.organization_id', '=', 'm.organization_id')
      .onRef('a.company_id', '=', 'm.company_id'))
    .select([
      'm.id as match_id', 'm.status', 'm.created_at', 'm.matched_quantity',
      'm.receipt_unit_cost', 'm.matched_receipt_value',
      'm.bill_net_unit_price', 'm.matched_bill_value', 'm.value_difference',
      'm.reversal_reason', 'm.item_id', 'm.supplier_id',
      'b.id as bill_id', 'b.bill_number', 'b.supplier_invoice_number',
      'b.status as bill_status', 'b.posting_date as bill_posting_date',
      'r.id as receipt_id', 'r.receipt_number', 'r.posting_date as receipt_posting_date',
      'o.id as order_id', 'o.order_number',
      'p.legal_name as supplier_name',
      'i.item_code', 'i.name as item_name',
      'u.code as unit_code',
      'a.account_code', 'a.account_name',
    ])
    .where('m.organization_id', '=', actor.organizationId)
    .where('m.company_id', '=', actor.companyId);

  if (query.supplierId) builder = builder.where('m.supplier_id', '=', query.supplierId);
  if (query.receiptId) builder = builder.where('m.receipt_id', '=', query.receiptId);
  if (query.billId) builder = builder.where('m.bill_id', '=', query.billId);
  if (query.status) builder = builder.where('m.status', '=', query.status);

  const rows = await builder
    .orderBy('m.created_at', 'desc')
    .limit(Math.min(Math.max(query.limit ?? 200, 1), 1000))
    .execute();

  return rows.map((row) => ({
    matchId: row.match_id,
    status: row.status,
    matchedAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : (row.created_at as unknown as string | null),
    billId: row.bill_id,
    billNumber: row.bill_number,
    supplierInvoiceNumber: row.supplier_invoice_number,
    billStatus: row.bill_status,
    billPostingDate: toCalendarDate(row.bill_posting_date),
    supplierId: row.supplier_id,
    supplierName: row.supplier_name ?? '',
    receiptId: row.receipt_id,
    receiptNumber: row.receipt_number,
    receiptPostingDate: toCalendarDate(row.receipt_posting_date),
    orderId: row.order_id,
    orderNumber: row.order_number,
    itemId: row.item_id,
    itemCode: row.item_code ?? '',
    itemName: row.item_name ?? '',
    baseUnitCode: row.unit_code ?? '',
    matchedQuantity: row.matched_quantity,
    receiptUnitCost: row.receipt_unit_cost,
    matchedReceiptValue: row.matched_receipt_value,
    billNetUnitPrice: row.bill_net_unit_price,
    matchedBillValue: row.matched_bill_value,
    valueDifference: row.value_difference,
    accountCode: row.account_code ?? '',
    accountName: row.account_name ?? '',
    reversalReason: row.reversal_reason,
  }));
}

export interface GrniAgeBand {
  label: string;
  /** Inclusive lower bound in days since the receipt posted. */
  fromDays: number;
  /** Exclusive upper bound, or null for the open-ended oldest band. */
  toDays: number | null;
  value: string;
}

export interface GrniAgingRow {
  supplierId: string | null;
  supplierName: string;
  receiptId: string;
  receiptNumber: string;
  receiptPostingDate: string;
  ageDays: number;
  openValue: string;
  band: string;
}

export interface GrniAging {
  asOfDate: string;
  rows: GrniAgingRow[];
  bands: GrniAgeBand[];
  total: string;
}

/**
 * How long each open accrual has been sitting, by receipt and supplier.
 *
 * Aged from the receipt's POSTING date, because that is the day the accrual
 * entered the ledger. The day the goods physically arrived can be earlier, and
 * ageing a ledger balance from a warehouse date would report a figure the books
 * did not yet carry.
 */
export async function grniAging(
  db: Kysely<Database>,
  actor: InventoryActor,
  query: { asOfDate?: string } = {},
): Promise<GrniAging> {
  const asOf = query.asOfDate ?? new Date().toISOString().slice(0, 10);

  const rows = await db
    .selectFrom('goods_receipt_lines as l')
    .innerJoin('goods_receipts as r', (join) => join
      .onRef('r.id', '=', 'l.receipt_id')
      .onRef('r.organization_id', '=', 'l.organization_id')
      .onRef('r.company_id', '=', 'l.company_id'))
    .leftJoin('business_parties as p', (join) => join
      .onRef('p.id', '=', 'r.supplier_id')
      .onRef('p.organization_id', '=', 'r.organization_id')
      .onRef('p.company_id', '=', 'r.company_id'))
    .select([
      'l.id as line_id', 'l.total_cost',
      'r.id as receipt_id', 'r.receipt_number', 'r.posting_date', 'r.supplier_id',
      'p.legal_name as supplier_name',
    ])
    .where('l.organization_id', '=', actor.organizationId)
    .where('l.company_id', '=', actor.companyId)
    .where('r.status', '=', 'posted')
    .where('r.posting_date', '<=', asOf)
    .orderBy('r.posting_date', 'asc')
    .execute();

  const cleared = await activeMatches(db, actor, rows.map((row) => row.line_id));

  /*
   * Ordinary purchasing ladders. The oldest band is open-ended on purpose: an
   * accrual nobody has invoiced in three months is the one worth looking at,
   * and capping it would hide the worst of it in a bucket labelled with a range.
   */
  const bands: GrniAgeBand[] = [
    { label: '0-30 days', fromDays: 0, toDays: 31, value: '0' },
    { label: '31-60 days', fromDays: 31, toDays: 61, value: '0' },
    { label: '61-90 days', fromDays: 61, toDays: 91, value: '0' },
    { label: 'Over 90 days', fromDays: 91, toDays: null, value: '0' },
  ];
  const bandTotals = bands.map(() => Money.ZERO);

  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  let total = Money.ZERO;
  const mapped: GrniAgingRow[] = [];

  for (const row of rows) {
    const value = Money.toAmount(row.total_cost, 'value');
    const got = cleared.get(row.line_id)?.value ?? Money.ZERO;
    const open = value - got;
    if (open <= 0n) continue;

    const posting = toCalendarDate(row.posting_date);
    /*
     * Whole days between two CALENDAR dates, both read as UTC midnight, so a
     * timezone east of Greenwich cannot age a balance by an extra day.
     */
    const ageDays = Math.max(
      0, Math.round((asOfMs - Date.parse(`${posting}T00:00:00Z`)) / 86_400_000),
    );
    const found = bands.findIndex(
      (band) => ageDays >= band.fromDays && (band.toDays === null || ageDays < band.toDays),
    );
    const bandIndex = found === -1 ? bands.length - 1 : found;
    bandTotals[bandIndex] = bandTotals[bandIndex]! + open;
    total += open;

    mapped.push({
      supplierId: row.supplier_id,
      supplierName: row.supplier_name ?? '',
      receiptId: row.receipt_id,
      receiptNumber: row.receipt_number,
      receiptPostingDate: posting,
      ageDays,
      openValue: Money.toDecimalString(open),
      band: bands[bandIndex]!.label,
    });
  }

  return {
    asOfDate: asOf,
    rows: mapped,
    bands: bands.map((band, index) => ({
      ...band, value: Money.toDecimalString(bandTotals[index]!),
    })),
    total: Money.toDecimalString(total),
  };
}

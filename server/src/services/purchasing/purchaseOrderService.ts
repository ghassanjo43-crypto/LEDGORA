/**
 * Purchase orders: a commitment to buy, and nothing in the ledger.
 *
 * ══ Nothing here posts ═══════════════════════════════════════════════════════
 *
 * Creating, editing, approving, issuing, closing and cancelling an order all
 * leave the general ledger exactly as they found it. Nothing has arrived, no
 * supplier is owed and no tax point has occurred, so there is no entry to make.
 * Inventory is recognised by the GOODS RECEIPT, and the liability and the
 * recoverable input tax by the supplier bill in AP2.
 *
 * ══ Every figure is the server's ═════════════════════════════════════════════
 *
 * A caller sends quantities, unit prices, a discount and a tax CODE. It never
 * sends a line amount, a discount amount, a tax rate, a tax amount, a total, an
 * order number or a status. Each of those is computed here in exact decimals,
 * and a client that could author any of them could author what the business
 * believes it committed to.
 *
 * ══ Why the tax on an order is only ever an ESTIMATE ═════════════════════════
 *
 * The tax point of a purchase is the supplier's invoice, and the rate,
 * category and recoverability that a filing depends on are the ones in force on
 * ITS date. An order raised in March for goods invoiced in May must not freeze
 * March's rate. So the figures here are resolved from the code the buyer
 * expects to apply, stored under `estimated_` names, and no snapshot column
 * exists on the order at all — the frozen snapshot is written onto the bill
 * line, by AP2.
 *
 * What the estimate IS used for is the receipt's provisional cost: the line's
 * net of separately recoverable input tax, which under an inclusive code is
 * what is left once the tax has been extracted. That is a cost, not a tax
 * position, and it is exactly the figure AP2 will compare the invoice against.
 *
 * ══ What is refused, by name ═════════════════════════════════════════════════
 *
 * Foreign currency; alternate units; a client-supplied number, status, total,
 * received or remaining quantity; a negative quantity or price; a fixed,
 * compound, reverse-charge, import, withholding or partially recoverable tax;
 * projects, cost centres, lots, serials, expiry dates, bins, landed costs and
 * every AP2 concern — matching, tolerances, variance, returns and debit notes.
 * Each is a decision this product has not made, and a field that arrives, is
 * read by nothing and vanishes is how a client comes to believe otherwise.
 */
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../../db/schema.js';
import { errors } from '../../lib/errors.js';
import * as Money from '../accounting/money.js';
import * as SalesTax from '../accounting/salesTax.js';
import { monetaryDecimalsFor } from '../accounting/currencyPrecision.js';
import { toCalendarDate, toCalendarDateOrNull } from '../accounting/calendarDate.js';
import { resolveTaxForDate, type ResolvedTax } from '../invoicing/taxCodeService.js';
import { toQuantity } from '../inventory/stockLedger.js';
import type { InventoryActor } from '../inventory/inventoryCore.js';

type Trx = Transaction<Database>;
type Executor = Kysely<Database> | Trx;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The lifecycle, as migration 042 constrains it. */
export type OrderStatus =
  | 'draft' | 'approved' | 'issued' | 'partially_received' | 'received' | 'closed' | 'cancelled';

/** A draft is the only state whose commercial facts may still be rewritten. */
const EDITABLE: readonly OrderStatus[] = ['draft'];

/** The states an order may be received against. */
export const RECEIVABLE: readonly OrderStatus[] = ['issued', 'partially_received'];

/* ══ Refusals ══════════════════════════════════════════════════════════════ */

/**
 * Figures a client may send but never decides.
 *
 * Refused rather than ignored: a request carrying a total the server did not
 * compute is a client that believes it is authoring the commitment, and
 * silently dropping the field leaves it believing that.
 */
const SERVER_OWNED: Record<string, string> = {
  orderNumber: 'an order number',
  status: 'a status',
  subtotal: 'a subtotal',
  discountTotal: 'a discount total',
  taxTotal: 'a tax total',
  estimatedTaxTotal: 'a tax total',
  total: 'a total',
  receivedQuantity: 'a received quantity',
  remainingQuantity: 'a remaining quantity',
  taxRate: 'a tax rate',
  taxAmount: 'a tax amount',
  taxableAmount: 'a taxable base',
  netAmount: 'a net amount',
  grossAmount: 'a gross amount',
  lineNet: 'a line net',
  lineSubtotal: 'a line subtotal',
  discountAmount: 'a discount amount',
  taxCategory: 'a tax category',
  taxCalculationMethod: 'a tax calculation method',
  taxRecoverability: 'a recoverability',
  taxAccountId: 'a tax account',
  accountId: 'an account',
};

/** Dimensions and workflows this slice has no accounting for. */
const UNSUPPORTED: Record<string, string> = {
  projectId: 'project dimensions',
  costCenterId: 'cost-centre dimensions',
  lotId: 'lot tracking',
  serialNumbers: 'serial-number tracking',
  expiryDate: 'expiry dates',
  binId: 'bin locations',
  unitId: 'alternate units of measure',
  unitOfMeasureId: 'alternate units of measure',
  exchangeRate: 'foreign-currency purchasing',
  landedCost: 'landed costs',
  freightAmount: 'freight capitalisation',
  additionalChargesTotal: 'additional charges',
  billId: 'supplier-invoice matching',
  matchStatus: 'supplier-invoice matching',
  matchTolerance: 'match tolerances',
  priceTolerance: 'match tolerances',
  quantityTolerance: 'match tolerances',
  purchasePriceVarianceAccountId: 'purchase-price variance',
  requisitionId: 'purchase requisitions',
  attachments: 'attachments',
};

export const AP2_DEFERRED =
  'Supplier-invoice matching, two- and three-way match approval, price and quantity tolerances, '
  + 'purchase-price variance, receipt accrual release, purchase returns, debit notes and supplier '
  + 'credits are not implemented. AP1 records the commitment, the arrival and the '
  + 'goods-received-not-invoiced liability; nothing here can settle any of them, and a field that '
  + 'implied otherwise would be a workflow the books cannot honour.';

function refuse(field: string, value: unknown, table: Record<string, string>): void {
  if (value === undefined || value === null || value === '') return;
  if (Array.isArray(value) && value.length === 0) return;
  const what = table[field] ?? field;
  const isServerOwned = table === SERVER_OWNED;
  throw errors.validation(
    isServerOwned
      ? `A purchase order may not carry ${what} chosen by the client: every amount, every tax `
        + 'figure, the number and the status are computed by the server from the lines, the tax '
        + 'code and the receipts. Nothing has been saved.'
      : `This purchase order references ${what}, which the server cannot account for. ${AP2_DEFERRED} `
        + 'Nothing has been saved.',
    { fieldErrors: { [field]: isServerOwned ? 'Remove this field.' : `Remove the ${what}.` } },
  );
}

/** Every refusal, run before a single row is written. */
function assertWithinBoundary(input: OrderInput): void {
  const record = input as unknown as Record<string, unknown>;
  for (const field of Object.keys(SERVER_OWNED)) refuse(field, record[field], SERVER_OWNED);
  for (const field of Object.keys(UNSUPPORTED)) refuse(field, record[field], UNSUPPORTED);
  for (const [index, line] of (input.lines ?? []).entries()) {
    const row = line as unknown as Record<string, unknown>;
    for (const field of Object.keys(SERVER_OWNED)) {
      if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
        refuse(`lines.${index + 1}.${field}`, row[field], { [`lines.${index + 1}.${field}`]: SERVER_OWNED[field]! });
      }
    }
    for (const field of Object.keys(UNSUPPORTED)) {
      if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
        refuse(`lines.${index + 1}.${field}`, row[field], { [`lines.${index + 1}.${field}`]: UNSUPPORTED[field]! });
      }
    }
  }
}

/* ══ Input shapes ══════════════════════════════════════════════════════════ */

export interface OrderLineInput {
  itemId: string;
  warehouseId: string;
  description?: string;
  /** Decimal STRINGS throughout: an exact figure never passes through a float. */
  quantity: string;
  unitPrice: string;
  discountType?: 'percentage' | 'amount' | null;
  discountValue?: string | null;
  /** The tax CODE, and nothing else about the tax. */
  taxCodeId?: string | null;
}

export interface OrderInput {
  supplierId?: string;
  orderDate?: string;
  expectedDate?: string | null;
  /** The SUPPLIER's own reference. Never Ledgora's order number. */
  supplierReference?: string;
  memo?: string;
  /** Refused when present and different from the functional currency. */
  currency?: string;
  lines?: OrderLineInput[];
}

/* ══ Records ═══════════════════════════════════════════════════════════════ */

export interface OrderLineRecord {
  id: string;
  lineNumber: number;
  itemId: string;
  itemCode: string;
  itemName: string;
  baseUnitId: string;
  baseUnitCode: string;
  warehouseId: string;
  warehouseCode: string;
  description: string;
  orderedQuantity: string;
  unitPrice: string;
  discountType: string | null;
  discountValue: string;
  discountAmount: string;
  lineSubtotal: string;
  lineNet: string;
  taxCodeId: string | null;
  estimatedTaxRate: string;
  estimatedTaxCategory: string | null;
  estimatedTaxMethod: string | null;
  estimatedTaxAmount: string;
  /** What a receipt of the WHOLE line would cost. Net of recoverable tax. */
  netAmount: string;
  grossAmount: string;
  /** Derived from posted, unreversed receipts. Never stored. */
  receivedQuantity: string;
  remainingQuantity: string;
  /** The value already recognised against this line, from those receipts. */
  receivedValue: string;
}

export interface OrderRecord {
  id: string;
  orderNumber: string;
  supplierId: string;
  supplierName: string;
  orderDate: string;
  expectedDate: string | null;
  status: OrderStatus;
  currency: string;
  supplierReference: string;
  memo: string;
  subtotal: string;
  discountTotal: string;
  /** Commercial expectation. Never a statutory tax figure. */
  estimatedTaxTotal: string;
  total: string;
  approvedAt: string | null;
  issuedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  closureReason: string;
  version: number;
  createdAt: string | null;
  lines: OrderLineRecord[];
}

export interface AuditRecord {
  id: string;
  action: string;
  detail: unknown;
  previousVersion: number | null;
  resultingVersion: number | null;
  actorUserId: string | null;
  actorName: string;
  at: string | null;
}

/* ══ Audit ═════════════════════════════════════════════════════════════════ */

export async function writePurchasingAudit(
  trx: Executor,
  actor: InventoryActor,
  input: {
    subjectType: 'order' | 'receipt';
    subjectId: string;
    action: string;
    detail?: Record<string, unknown>;
    previousVersion?: number | null;
    resultingVersion?: number | null;
  },
): Promise<void> {
  await trx.insertInto('purchasing_audit_events').values({
    organization_id: actor.organizationId,
    company_id: actor.companyId,
    subject_type: input.subjectType,
    subject_id: input.subjectId,
    action: input.action,
    detail: JSON.stringify(input.detail ?? {}),
    previous_version: input.previousVersion ?? null,
    resulting_version: input.resultingVersion ?? null,
    actor_user_id: actor.userId,
    actor_name: actor.name,
    request_id: actor.requestId ?? '',
  } as never).execute();
}

/* ══ Shared helpers ════════════════════════════════════════════════════════ */

export const STALE_ORDER =
  'This purchase order was changed by another user while you were editing it. Reload it and try '
  + 'again so you do not overwrite their change.';

function assertVersion(current: number, expected: number): void {
  if (current !== expected) throw errors.conflict(STALE_ORDER);
}

async function functionalCurrencyOf(db: Executor, organizationId: string): Promise<string> {
  const org = await db.selectFrom('organizations').select('base_currency')
    .where('id', '=', organizationId).executeTakeFirst();
  if (!org) throw errors.notFound('Organization');
  return org.base_currency;
}

/**
 * Only the company's functional currency, exactly as bills and invoices insist.
 *
 * A foreign-currency order would commit to an amount that the receipt has to
 * capitalise into stock, and rates and exchange differences are browser-
 * resident — so the server would be recording a converted cost it cannot
 * justify. Refused rather than converted at 1.0.
 */
function assertFunctionalCurrency(requested: string | undefined, functional: string): void {
  if (!requested) return;
  if (requested.trim().toUpperCase() !== functional.toUpperCase()) {
    throw errors.validation(
      `This order is in ${requested.toUpperCase()}, but only ${functional} purchase orders can be `
      + 'held on the server: exchange rates and exchange differences are still kept in the browser, '
      + 'so the cost a receipt capitalised could not be justified. Nothing has been saved.',
      { fieldErrors: { currency: `Record this order in ${functional}.` } },
    );
  }
}

function amount(value: string | number | null | undefined, field: string): Money.Amount {
  try {
    return Money.toAmount(value, field);
  } catch (cause) {
    if (cause instanceof Money.MoneyError) throw errors.validation(cause.message);
    throw cause;
  }
}

/* ══ Master data ═══════════════════════════════════════════════════════════ */

async function resolveSupplier(
  trx: Executor,
  actor: InventoryActor,
  supplierId: string,
): Promise<{ id: string; legalName: string }> {
  const party = await trx
    .selectFrom('business_parties')
    .select(['id', 'legal_name', 'is_supplier', 'status'])
    .where('organization_id', '=', actor.organizationId)
    /* Company scope in the QUERY: another company's supplier must be invisible,
     * not visible-and-refused. */
    .where('company_id', '=', actor.companyId)
    .where('id', '=', supplierId)
    .executeTakeFirst();

  if (!party) {
    throw errors.validation(
      'That supplier does not exist in these books. A purchase order may only name a supplier this '
      + "company owns — which is what stops one company's order committing another's money.",
      { fieldErrors: { supplierId: 'Choose a supplier from this company.' } },
    );
  }
  if (!party.is_supplier) {
    throw errors.validation(
      `${party.legal_name} is in this directory but does not hold the supplier role, so nothing can `
      + 'be ordered from them. Give the party the supplier role first.',
      { fieldErrors: { supplierId: 'Choose a party that is a supplier.' } },
    );
  }
  if (party.status !== 'active') {
    throw errors.validation(
      `${party.legal_name} is ${party.status} and cannot be put on a new purchase order. Orders `
      + 'already raised with them are untouched, which is the difference between archiving and '
      + 'deleting.',
      { fieldErrors: { supplierId: 'Choose an active supplier.' } },
    );
  }
  return { id: party.id, legalName: party.legal_name };
}

interface ResolvedItem {
  id: string;
  code: string;
  name: string;
  baseUnitId: string;
  baseUnitCode: string;
  unitDecimals: number;
}

/**
 * An item a purchase order may commit to.
 *
 * Every rule the stock ledger will apply at the receipt is applied here too, so
 * a buyer finds out at ordering time rather than when the goods are on the
 * loading bay. The receipt re-checks all of it — an item can be archived or
 * re-typed as a service between the two, and the moment that matters is the
 * moment the movement is written.
 */
async function resolveItem(
  trx: Executor,
  actor: InventoryActor,
  itemId: string,
  at: number,
): Promise<ResolvedItem> {
  const row = await trx
    .selectFrom('inventory_items as i')
    .innerJoin('units_of_measure as u', (join) => join
      .onRef('u.id', '=', 'i.base_unit_id')
      .onRef('u.organization_id', '=', 'i.organization_id')
      .onRef('u.company_id', '=', 'i.company_id'))
    .select([
      'i.id', 'i.item_code', 'i.name', 'i.status', 'i.is_inventory_tracked', 'i.is_purchasable',
      'i.item_type', 'i.valuation_method', 'i.base_unit_id',
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
      `Item ${row.item_code} is ${row.status} and cannot be ordered. Reactivate it first.`,
      { fieldErrors: { [field]: 'Choose an active item.' } },
    );
  }
  if (!row.is_purchasable) {
    throw errors.validation(
      `Item ${row.item_code} is not marked purchasable, so ordering it would commit the business to `
      + 'buying something the catalogue says it does not buy.',
      { fieldErrors: { [field]: 'Mark the item purchasable, or choose another.' } },
    );
  }
  if (!row.is_inventory_tracked) {
    throw errors.validation(
      `Item ${row.item_code} is not stock-tracked, so receiving it would increase no quantity and `
      + `there would be nothing for a goods receipt to record. Buy a ${row.item_type} item on a `
      + 'supplier bill as an ordinary expense line instead.',
      { fieldErrors: { [field]: 'This item holds no stock.' } },
    );
  }
  if (row.valuation_method !== 'weighted-average') {
    throw errors.validation(
      `Item ${row.item_code} is valued at ${row.valuation_method}, which this product does not `
      + 'implement — there are no cost layers and no standard-cost variance posting, and averaging '
      + 'it silently would report a cost the business never chose. Change the item to '
      + 'weighted-average, or leave it off the order.',
      { fieldErrors: { [field]: 'Only weighted-average items can be received.' } },
    );
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

async function resolveWarehouse(
  trx: Executor,
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
      `Warehouse ${row.code} is ${row.status} and cannot be the destination of a new order.`,
      { fieldErrors: { [field]: 'Choose an active warehouse.' } },
    );
  }
  return { id: row.id, code: row.code };
}

/* ══ Amounts ═══════════════════════════════════════════════════════════════ */

interface ComputedLine {
  input: OrderLineInput;
  item: ResolvedItem;
  warehouse: { id: string; code: string };
  quantity: Money.Amount;
  unitPrice: Money.Amount;
  discountAmount: Money.Amount;
  lineSubtotal: Money.Amount;
  lineNet: Money.Amount;
  tax: ResolvedTax | null;
  netAmount: Money.Amount;
  taxAmount: Money.Amount;
  grossAmount: Money.Amount;
}

/**
 * Every amount on the order, from the lines.
 *
 * The arithmetic is the one the bill service established, deliberately, so an
 * order and the bill that eventually settles it cannot disagree about what a
 * discount means:
 *
 *   lineSubtotal = quantity x unitPrice          (GROSS, before discount)
 *   discount     = % of lineSubtotal, or a fixed amount, clamped to [0, gross]
 *   lineNet      = lineSubtotal - discount       (the tax base)
 *   subtotal     = sum of lineSubtotal           (gross)
 *   total        = sum of gross line amounts
 *
 * A discount larger than its line is CLAMPED rather than refused, because that
 * is what the rest of the product does; a NEGATIVE one is refused, because it
 * is not a discount.
 */
async function computeLines(
  trx: Executor,
  actor: InventoryActor,
  lines: OrderLineInput[],
  options: { decimals: number; taxPointDate: string },
): Promise<{
  computed: ComputedLine[];
  subtotal: Money.Amount;
  discountTotal: Money.Amount;
  taxTotal: Money.Amount;
  total: Money.Amount;
}> {
  const { decimals, taxPointDate } = options;

  /*
   * Resolved ONCE per distinct code, so a ten-line order cannot end up with two
   * answers for one code because a rate version changed between two queries.
   * `'purchase'` is the usage: a sales-only code is refused outright.
   */
  const codeIds = [...new Set(
    lines.map((line) => line.taxCodeId).filter((id): id is string => Boolean(id)),
  )];
  const resolved = new Map<string, ResolvedTax>();
  for (const codeId of codeIds) {
    resolved.set(codeId, await resolveTaxForDate(trx, actor, codeId, taxPointDate, 'purchase'));
  }

  const computed: ComputedLine[] = [];
  for (const [index, line] of lines.entries()) {
    const at = index + 1;
    const item = await resolveItem(trx, actor, line.itemId, at);
    const warehouse = await resolveWarehouse(trx, actor, line.warehouseId, at);

    /*
     * The quantity is validated against the UNIT's precision, never the
     * currency's: a kilogram is weighed to three places in books that round
     * money to two, and a figure the unit cannot express would be rounded by
     * something other than the person who typed it. Zero and negative are
     * refused by `toQuantity` — ordering nothing is not an order.
     */
    const quantity = toQuantity(line.quantity, item.unitDecimals, `lines.${at}.quantity`);
    const unitPrice = amount(line.unitPrice ?? '0', `lines.${at}.unitPrice`);
    if (Money.isNegative(unitPrice)) {
      throw errors.validation(`Line ${at}: a unit price cannot be negative.`, {
        fieldErrors: { [`lines.${at}.unitPrice`]: 'Enter zero or more.' },
      });
    }
    if (Money.exceedsPrecision(unitPrice, decimals)) {
      throw errors.validation(
        `Line ${at}: that unit price is finer than this company's currency, which is kept to `
        + `${decimals} decimal place(s).`,
        { fieldErrors: { [`lines.${at}.unitPrice`]: `Use at most ${decimals} decimal place(s).` } },
      );
    }

    /* Quantity is a count, not money — multiply at scale and round back. */
    const lineSubtotal = Money.roundTo(Money.multiply(quantity, unitPrice), decimals);

    const discountValue = amount(line.discountValue ?? '0', `lines.${at}.discountValue`);
    if (Money.isNegative(discountValue)) {
      throw errors.validation(`Line ${at}: a discount cannot be negative.`, {
        fieldErrors: { [`lines.${at}.discountValue`]: 'Enter zero or more.' },
      });
    }
    if (line.discountType && line.discountType !== 'percentage' && line.discountType !== 'amount') {
      throw errors.validation(
        `Line ${at}: "${line.discountType}" is not a discount this server supports. Use a `
        + 'percentage or a fixed amount. Nothing has been saved.',
        { fieldErrors: { [`lines.${at}.discountType`]: 'Choose percentage or amount.' } },
      );
    }

    let discountAmount = Money.ZERO;
    if (Money.isPositive(discountValue)) {
      discountAmount = line.discountType === 'amount'
        ? Money.roundTo(discountValue, decimals)
        : Money.roundTo(Money.multiply(lineSubtotal, discountValue) / 100n, decimals);
    }
    if (discountAmount > lineSubtotal) discountAmount = lineSubtotal;

    const lineNet = lineSubtotal - discountAmount;

    /*
     * The tax, from the code the line names and nothing else. A line with no
     * code bears no tax, and that is NOT the same as a zero-rated purchase —
     * which is why the category is only ever recorded when a code supplied it.
     *
     * EXCLUSIVE: `lineNet` is the cost and the tax is added on top.
     * INCLUSIVE: `lineNet` is what the supplier will charge, and the cost is
     * what remains once the recoverable tax is taken out of it. Getting that
     * backwards would capitalise the tax into stock and overstate inventory by
     * exactly the rate.
     */
    const tax = line.taxCodeId ? resolved.get(line.taxCodeId) ?? null : null;
    if (!tax) {
      computed.push({
        input: line, item, warehouse, quantity, unitPrice, discountAmount,
        lineSubtotal, lineNet, tax: null,
        netAmount: lineNet, taxAmount: Money.ZERO, grossAmount: lineNet,
      });
      continue;
    }

    const result = SalesTax.calculateTaxLine({
      lineAmount: lineNet,
      rate: tax.rate,
      category: tax.category,
      method: tax.method,
      decimals,
    });

    computed.push({
      input: line, item, warehouse, quantity, unitPrice, discountAmount,
      lineSubtotal, lineNet, tax,
      netAmount: result.taxableAmount,
      taxAmount: result.taxAmount,
      grossAmount: result.grossAmount,
    });
  }

  return {
    computed,
    subtotal: Money.sum(computed.map((c) => c.lineSubtotal)),
    discountTotal: Money.sum(computed.map((c) => c.discountAmount)),
    taxTotal: Money.sum(computed.map((c) => c.taxAmount)),
    total: Money.sum(computed.map((c) => c.grossAmount)),
  };
}

/* ══ Numbering ═════════════════════════════════════════════════════════════ */

const PREFIX: Record<'purchase-order' | 'goods-receipt', string> = {
  'purchase-order': 'PO-',
  'goods-receipt': 'GR-',
};

/**
 * The next held number for a purchasing document.
 *
 * The advisory lock keys on the company AND the kind, so two companies under
 * one subscriber number their orders independently and concurrently, and orders
 * never contend with receipts. The sequence is HELD, never derived from a MAX:
 * counting existing rows reuses a number after a deletion, and a reused order
 * number is two commitments with one identity.
 */
export async function allocatePurchasingNumber(
  trx: Trx,
  actor: InventoryActor,
  kind: 'purchase-order' | 'goods-receipt',
  onDate: string,
): Promise<string> {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${`purchasing_number:${actor.organizationId}:${actor.companyId}:${kind}`})
    )
  `.execute(trx);

  const existing = await trx
    .selectFrom('purchasing_document_numbering')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('kind', '=', kind)
    .executeTakeFirst();

  const config = existing ?? {
    prefix: PREFIX[kind], include_year: true, sequence_length: 4, next_sequence: 1,
  };

  if (!existing) {
    await trx.insertInto('purchasing_document_numbering').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      kind,
      prefix: PREFIX[kind],
      next_sequence: 2,
    } as never).execute();
  } else {
    await trx.updateTable('purchasing_document_numbering')
      .set({ next_sequence: config.next_sequence + 1, updated_at: new Date() } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('kind', '=', kind)
      .execute();
  }

  const year = config.include_year ? `${onDate.slice(0, 4)}-` : '';
  return `${config.prefix}${year}${String(config.next_sequence).padStart(config.sequence_length, '0')}`;
}

/* ══ Reading ═══════════════════════════════════════════════════════════════ */

/**
 * What each order line has actually received, summed from POSTED receipts.
 *
 * Never a stored counter. A stored counter is a second answer that drifts from
 * the receipts the first time anything fails halfway, and afterwards nobody can
 * say which one was right — while the one people act on is the wrong one.
 */
export async function receivedByOrderLine(
  db: Executor,
  actor: InventoryActor,
  orderIds: readonly string[],
): Promise<Map<string, { quantity: Money.Amount; value: Money.Amount }>> {
  const totals = new Map<string, { quantity: Money.Amount; value: Money.Amount }>();
  if (orderIds.length === 0) return totals;

  const rows = await db
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
    .where('l.order_id', 'in', orderIds as string[])
    .where('r.status', '=', 'posted')
    .groupBy('l.order_line_id')
    .execute();

  for (const row of rows) {
    totals.set(row.order_line_id, {
      quantity: Money.toAmount(String(row.quantity ?? '0'), 'quantity'),
      value: Money.toAmount(String(row.value ?? '0'), 'value'),
    });
  }
  return totals;
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function hydrateLine(row: any, received: { quantity: Money.Amount; value: Money.Amount }): OrderLineRecord {
  const ordered = Money.toAmount(row.ordered_quantity, 'orderedQuantity');
  const remaining = ordered - received.quantity;
  return {
    id: row.id,
    lineNumber: Number(row.line_number),
    itemId: row.item_id,
    itemCode: row.item_code ?? '',
    itemName: row.item_name ?? '',
    baseUnitId: row.base_unit_id,
    baseUnitCode: row.base_unit_code ?? '',
    warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code ?? '',
    description: row.description ?? '',
    orderedQuantity: row.ordered_quantity,
    unitPrice: row.unit_price,
    discountType: row.discount_type,
    discountValue: row.discount_value,
    discountAmount: row.discount_amount,
    lineSubtotal: row.line_subtotal,
    lineNet: row.line_net,
    taxCodeId: row.tax_code_id,
    estimatedTaxRate: row.estimated_tax_rate,
    estimatedTaxCategory: row.estimated_tax_category,
    estimatedTaxMethod: row.estimated_tax_method,
    estimatedTaxAmount: row.estimated_tax_amount,
    netAmount: row.net_amount,
    grossAmount: row.gross_amount,
    receivedQuantity: Money.toDecimalString(received.quantity),
    remainingQuantity: Money.toDecimalString(remaining < 0n ? 0n : remaining),
    receivedValue: Money.toDecimalString(received.value),
  };
}

async function loadOrders(
  db: Executor,
  actor: InventoryActor,
  ids: readonly string[],
): Promise<OrderRecord[]> {
  if (ids.length === 0) return [];

  const orders = await db
    .selectFrom('purchase_orders as o')
    .leftJoin('business_parties as p', (join) => join
      .onRef('p.id', '=', 'o.supplier_id')
      .onRef('p.organization_id', '=', 'o.organization_id')
      .onRef('p.company_id', '=', 'o.company_id'))
    .selectAll('o')
    .select('p.legal_name as supplier_name')
    .where('o.organization_id', '=', actor.organizationId)
    .where('o.company_id', '=', actor.companyId)
    .where('o.id', 'in', ids as string[])
    .execute();

  const lines = await db
    .selectFrom('purchase_order_lines')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('order_id', 'in', ids as string[])
    .orderBy('line_number', 'asc')
    .execute();

  const received = await receivedByOrderLine(db, actor, ids);
  const byOrder = new Map<string, OrderLineRecord[]>();
  for (const line of lines) {
    const list = byOrder.get(line.order_id) ?? [];
    list.push(hydrateLine(line, received.get(line.id) ?? { quantity: Money.ZERO, value: Money.ZERO }));
    byOrder.set(line.order_id, list);
  }

  const stamp = (value: unknown): string | null =>
    (value instanceof Date ? value.toISOString() : (value as string | null) ?? null);

  const order = new Map(ids.map((id, index) => [id, index]));
  return orders
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      supplierId: row.supplier_id,
      supplierName: row.supplier_name ?? '',
      orderDate: toCalendarDate(row.order_date),
      expectedDate: toCalendarDateOrNull(row.expected_date),
      status: row.status as OrderStatus,
      currency: row.currency,
      supplierReference: row.supplier_reference,
      memo: row.memo,
      subtotal: row.subtotal,
      discountTotal: row.discount_total,
      estimatedTaxTotal: row.estimated_tax_total,
      total: row.total,
      approvedAt: stamp(row.approved_at),
      issuedAt: stamp(row.issued_at),
      closedAt: stamp(row.closed_at),
      cancelledAt: stamp(row.cancelled_at),
      closureReason: row.closure_reason,
      version: Number(row.version),
      createdAt: stamp(row.created_at),
      lines: byOrder.get(row.id) ?? [],
    }));
}

export async function getOrder(
  db: Executor,
  actor: InventoryActor,
  id: string,
): Promise<OrderRecord> {
  const [order] = await loadOrders(db, actor, [id]);
  if (!order) throw errors.notFound('Purchase order');
  return order;
}

export interface OrderQuery {
  status?: OrderStatus;
  supplierId?: string;
  /** Only orders with something still receivable. */
  open?: boolean;
  search?: string;
  limit?: number;
}

export async function listOrders(
  db: Kysely<Database>,
  actor: InventoryActor,
  query: OrderQuery = {},
): Promise<OrderRecord[]> {
  let builder = db
    .selectFrom('purchase_orders')
    .select('id')
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId);

  if (query.status) builder = builder.where('status', '=', query.status);
  if (query.supplierId) builder = builder.where('supplier_id', '=', query.supplierId);
  if (query.open) builder = builder.where('status', 'in', [...RECEIVABLE] as string[]);
  if (query.search) {
    const term = `%${query.search.trim().toLowerCase()}%`;
    builder = builder.where((eb) => eb.or([
      eb(sql`lower(order_number)`, 'like', term),
      eb(sql`lower(supplier_reference)`, 'like', term),
      eb(sql`lower(memo)`, 'like', term),
    ]));
  }

  const rows = await builder
    .orderBy('order_date', 'desc')
    .orderBy('created_at', 'desc')
    .limit(Math.min(Math.max(query.limit ?? 100, 1), 500))
    .execute();

  return loadOrders(db, actor, rows.map((row) => row.id));
}

export async function orderHistory(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
): Promise<AuditRecord[]> {
  const rows = await db
    .selectFrom('purchasing_audit_events')
    .selectAll()
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('subject_type', '=', 'order')
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

/* ══ Writing ═══════════════════════════════════════════════════════════════ */

function assertOrderShape(input: OrderInput): { orderDate: string; expectedDate: string | null } {
  if (!input.supplierId) {
    throw errors.validation('A supplier is required.', {
      fieldErrors: { supplierId: 'Choose the supplier this order is placed with.' },
    });
  }
  const orderDate = input.orderDate ?? '';
  if (!ISO_DATE.test(orderDate)) {
    throw errors.validation('orderDate must be an ISO date (yyyy-mm-dd).', {
      fieldErrors: { orderDate: 'Use the format yyyy-mm-dd.' },
    });
  }
  const expected = input.expectedDate ?? null;
  if (expected !== null && expected !== '' && !ISO_DATE.test(expected)) {
    throw errors.validation('expectedDate must be an ISO date (yyyy-mm-dd).', {
      fieldErrors: { expectedDate: 'Use the format yyyy-mm-dd.' },
    });
  }
  if (expected && expected < orderDate) {
    throw errors.validation(
      'Goods cannot be expected before the order is placed.',
      { fieldErrors: { expectedDate: `On or after ${orderDate}.` } },
    );
  }
  if (!input.lines || input.lines.length === 0) {
    throw errors.validation('A purchase order needs at least one line.', {
      fieldErrors: { lines: 'Add a line.' },
    });
  }
  return { orderDate, expectedDate: expected === '' ? null : expected };
}

async function writeLines(
  trx: Trx,
  actor: InventoryActor,
  orderId: string,
  computed: ComputedLine[],
): Promise<void> {
  let lineNumber = 0;
  for (const line of computed) {
    lineNumber += 1;
    await trx.insertInto('purchase_order_lines').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      order_id: orderId,
      line_number: lineNumber,
      item_id: line.item.id,
      base_unit_id: line.item.baseUnitId,
      warehouse_id: line.warehouse.id,
      description: (line.input.description ?? '').trim(),
      ordered_quantity: Money.toDecimalString(line.quantity),
      unit_price: Money.toDecimalString(line.unitPrice),
      discount_type: line.input.discountType ?? null,
      discount_value: Money.toDecimalString(amount(line.input.discountValue ?? '0', 'discountValue')),
      discount_amount: Money.toDecimalString(line.discountAmount),
      line_subtotal: Money.toDecimalString(line.lineSubtotal),
      line_net: Money.toDecimalString(line.lineNet),
      tax_code_id: line.tax?.taxCodeId ?? null,
      estimated_tax_rate: Money.toDecimalString(line.tax?.rate ?? Money.ZERO),
      estimated_tax_category: line.tax?.category ?? null,
      estimated_tax_method: line.tax?.method ?? null,
      estimated_tax_amount: Money.toDecimalString(line.taxAmount),
      net_amount: Money.toDecimalString(line.netAmount),
      gross_amount: Money.toDecimalString(line.grossAmount),
      item_code: line.item.code,
      item_name: line.item.name,
      base_unit_code: line.item.baseUnitCode,
      warehouse_code: line.warehouse.code,
    } as never).execute();
  }
}

export async function createOrder(
  db: Kysely<Database>,
  actor: InventoryActor,
  input: OrderInput,
): Promise<OrderRecord> {
  /* Refused before any write, so a rejected order leaves nothing behind. */
  assertWithinBoundary(input);
  const dates = assertOrderShape(input);

  const id = await db.transaction().execute(async (trx) => {
    const supplier = await resolveSupplier(trx, actor, input.supplierId!);
    const currency = await functionalCurrencyOf(trx, actor.organizationId);
    assertFunctionalCurrency(input.currency, currency);
    const decimals = monetaryDecimalsFor(currency);

    /*
     * The tax point of the ESTIMATE is the order's own date — the only date the
     * order has. It is explicitly not the tax point of the purchase, which is
     * the supplier invoice's, and nothing here is ever read as a filing figure.
     */
    const { computed, subtotal, discountTotal, taxTotal, total } =
      await computeLines(trx, actor, input.lines!, { decimals, taxPointDate: dates.orderDate });

    const orderNumber = await allocatePurchasingNumber(trx, actor, 'purchase-order', dates.orderDate);

    const created = await trx.insertInto('purchase_orders').values({
      organization_id: actor.organizationId,
      company_id: actor.companyId,
      order_number: orderNumber,
      supplier_id: supplier.id,
      order_date: dates.orderDate,
      expected_date: dates.expectedDate,
      status: 'draft',
      currency,
      supplier_reference: (input.supplierReference ?? '').trim(),
      memo: (input.memo ?? '').trim(),
      subtotal: Money.toDecimalString(subtotal),
      discount_total: Money.toDecimalString(discountTotal),
      estimated_tax_total: Money.toDecimalString(taxTotal),
      total: Money.toDecimalString(total),
      created_by: actor.userId,
    } as never).returning('id').executeTakeFirstOrThrow();

    await writeLines(trx, actor, created.id, computed);

    await writePurchasingAudit(trx, actor, {
      subjectType: 'order',
      subjectId: created.id,
      action: 'PURCHASE_ORDER_CREATED',
      resultingVersion: 1,
      detail: { orderNumber, supplierId: supplier.id, lines: computed.length },
    });

    return created.id;
  });

  return getOrder(db, actor, id);
}

export async function updateOrder(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
  expectedVersion: number,
  input: OrderInput,
): Promise<OrderRecord> {
  assertWithinBoundary(input);
  const dates = assertOrderShape(input);

  await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('purchase_orders')
      .selectAll()
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw errors.notFound('Purchase order');
    assertVersion(Number(current.version), expectedVersion);

    if (!EDITABLE.includes(current.status as OrderStatus)) {
      throw errors.conflict(
        `This purchase order is ${current.status.replace('_', ' ')} and its commercial terms can no `
        + 'longer be rewritten. An approved order has been authorised, an issued one is in a '
        + "supplier's hands and a received one has stock and a journal behind it. Cancel it and "
        + 'raise a replacement, or close the unreceived balance.',
      );
    }

    const supplier = await resolveSupplier(trx, actor, input.supplierId!);
    assertFunctionalCurrency(input.currency, current.currency);
    const decimals = monetaryDecimalsFor(current.currency);

    const { computed, subtotal, discountTotal, taxTotal, total } =
      await computeLines(trx, actor, input.lines!, { decimals, taxPointDate: dates.orderDate });

    /*
     * A draft's lines are replaced wholesale. There are no receipts against a
     * draft — receiving requires an issued order — so the trigger that freezes
     * a received line cannot fire, and nothing downstream is describing them.
     */
    await trx.deleteFrom('purchase_order_lines')
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('order_id', '=', id)
      .execute();

    await trx.updateTable('purchase_orders').set({
      supplier_id: supplier.id,
      order_date: dates.orderDate,
      expected_date: dates.expectedDate,
      supplier_reference: (input.supplierReference ?? '').trim(),
      memo: (input.memo ?? '').trim(),
      subtotal: Money.toDecimalString(subtotal),
      discount_total: Money.toDecimalString(discountTotal),
      estimated_tax_total: Money.toDecimalString(taxTotal),
      total: Money.toDecimalString(total),
      version: Number(current.version) + 1,
      updated_at: new Date(),
    } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .execute();

    await writeLines(trx, actor, id, computed);

    await writePurchasingAudit(trx, actor, {
      subjectType: 'order',
      subjectId: id,
      action: 'PURCHASE_ORDER_EDITED',
      previousVersion: Number(current.version),
      resultingVersion: Number(current.version) + 1,
      detail: { lines: computed.length },
    });
  });

  return getOrder(db, actor, id);
}

/* ── Lifecycle ─────────────────────────────────────────────────────────────── */

interface TransitionOptions {
  from: readonly OrderStatus[];
  to: OrderStatus;
  action: string;
  refusal: (status: string) => string;
  /** Extra columns the transition stamps. */
  stamp: (actor: InventoryActor) => Record<string, unknown>;
  reason?: string;
}

async function transition(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
  expectedVersion: number,
  options: TransitionOptions,
): Promise<OrderRecord> {
  await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('purchase_orders')
      .selectAll()
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw errors.notFound('Purchase order');
    assertVersion(Number(current.version), expectedVersion);

    if (!options.from.includes(current.status as OrderStatus)) {
      throw errors.conflict(options.refusal(current.status));
    }

    /*
     * Cancelling abandons the commitment entirely, so it is refused once any
     * stock has actually arrived: the receipt, its movements and its journal
     * are permanent, and an order marked "cancelled" standing behind them would
     * say the goods were never ordered. Closing is the act for that case — it
     * abandons the UNRECEIVED balance and leaves the history alone.
     */
    if (options.to === 'cancelled') {
      const { rows } = await sql<{ n: string }>`
        SELECT COUNT(*)::text AS n FROM goods_receipts
         WHERE organization_id = ${actor.organizationId}
           AND company_id = ${actor.companyId}
           AND order_id = ${id}
           AND status = 'posted'
      `.execute(trx);
      if (Number(rows[0]?.n ?? '0') > 0) {
        throw errors.conflict(
          'This purchase order has stock received against it and cannot be cancelled: the receipt, '
          + 'its movements and its journal are permanent, and an order that claimed to have been '
          + 'cancelled would contradict them. Close it instead — that abandons only what has not '
          + 'arrived.',
        );
      }
    }

    await trx.updateTable('purchase_orders').set({
      status: options.to,
      ...(options.reason === undefined ? {} : { closure_reason: options.reason }),
      ...options.stamp(actor),
      version: Number(current.version) + 1,
      updated_at: new Date(),
    } as never)
      .where('organization_id', '=', actor.organizationId)
      .where('company_id', '=', actor.companyId)
      .where('id', '=', id)
      .execute();

    await writePurchasingAudit(trx, actor, {
      subjectType: 'order',
      subjectId: id,
      action: options.action,
      previousVersion: Number(current.version),
      resultingVersion: Number(current.version) + 1,
      detail: {
        from: current.status,
        to: options.to,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      },
    });
  });

  return getOrder(db, actor, id);
}

export async function approveOrder(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
  expectedVersion: number,
): Promise<OrderRecord> {
  return transition(db, actor, id, expectedVersion, {
    from: ['draft'],
    to: 'approved',
    action: 'PURCHASE_ORDER_APPROVED',
    refusal: (status) => `Only a draft purchase order can be approved; this one is ${status.replace('_', ' ')}.`,
    stamp: (who) => ({ approved_at: new Date(), approved_by: who.userId }),
  });
}

/**
 * Issue the order to the supplier.
 *
 * Kept apart from approval because the two are different authorities and the
 * permission catalogue already says so: approving is a second pair of eyes,
 * issuing is the act that puts the document in another company's hands. Only an
 * issued order may be received against — there is no path from draft straight
 * to stock.
 */
export async function issueOrder(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
  expectedVersion: number,
): Promise<OrderRecord> {
  return transition(db, actor, id, expectedVersion, {
    from: ['approved'],
    to: 'issued',
    action: 'PURCHASE_ORDER_ISSUED',
    refusal: (status) => (status === 'draft'
      ? 'This purchase order has not been approved yet. Approval and issue are separate acts: one '
        + 'authorises the spend, the other sends the document to the supplier.'
      : `Only an approved purchase order can be issued; this one is ${status.replace('_', ' ')}.`),
    stamp: (who) => ({ issued_at: new Date(), issued_by: who.userId }),
  });
}

export function assertClosureReason(reason: string): string {
  const text = (reason ?? '').trim();
  if (text.length < 5) {
    throw errors.validation(
      'A reason of at least five characters is required, and it is recorded permanently against the '
      + 'order. Abandoning a commitment is a decision somebody has to be able to defend later.',
      { fieldErrors: { reason: 'Say why this order is being abandoned.' } },
    );
  }
  return text;
}

/**
 * Close the order: abandon what has not arrived, keep what has.
 *
 * The row is never deleted, and neither are its receipts, movements or
 * journals. Closing says the business no longer expects the balance.
 */
export async function closeOrder(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
  expectedVersion: number,
  reason: string,
): Promise<OrderRecord> {
  const text = assertClosureReason(reason);
  return transition(db, actor, id, expectedVersion, {
    from: ['approved', 'issued', 'partially_received', 'received'],
    to: 'closed',
    action: 'PURCHASE_ORDER_CLOSED',
    refusal: (status) => `A ${status.replace('_', ' ')} purchase order cannot be closed.`,
    stamp: () => ({ closed_at: new Date() }),
    reason: text,
  });
}

export async function cancelOrder(
  db: Kysely<Database>,
  actor: InventoryActor,
  id: string,
  expectedVersion: number,
  reason: string,
): Promise<OrderRecord> {
  const text = assertClosureReason(reason);
  return transition(db, actor, id, expectedVersion, {
    from: ['draft', 'approved', 'issued'],
    to: 'cancelled',
    action: 'PURCHASE_ORDER_CANCELLED',
    refusal: (status) => `A ${status.replace('_', ' ')} purchase order cannot be cancelled.`,
    stamp: () => ({ cancelled_at: new Date() }),
    reason: text,
  });
}

/* ── Derived receipt status ────────────────────────────────────────────────── */

/**
 * Re-derive an order's receipt status from the receipt ledger.
 *
 * Called inside the receipt's own posting and reversal transactions, under the
 * order's row lock, so the status and the receipts it describes commit
 * together. It never invents a state: `closed` and `cancelled` are decisions a
 * person made and are left exactly as they are, and an order with no posted
 * receipts goes back to `issued` — which is how a reversal restores what the
 * order looked like before the goods arrived.
 */
export async function refreshOrderStatusIn(
  trx: Trx,
  actor: InventoryActor,
  orderId: string,
): Promise<OrderStatus> {
  const order = await trx
    .selectFrom('purchase_orders')
    .select(['id', 'status', 'version'])
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', orderId)
    .executeTakeFirstOrThrow();

  const settled: readonly string[] = ['closed', 'cancelled', 'draft', 'approved'];
  if (settled.includes(order.status)) return order.status as OrderStatus;

  const lines = await trx
    .selectFrom('purchase_order_lines')
    .select(['id', 'ordered_quantity'])
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('order_id', '=', orderId)
    .execute();

  const received = await receivedByOrderLine(trx, actor, [orderId]);

  let anything = false;
  let everything = true;
  for (const line of lines) {
    const ordered = Money.toAmount(line.ordered_quantity, 'orderedQuantity');
    const got = received.get(line.id)?.quantity ?? Money.ZERO;
    if (got > 0n) anything = true;
    if (got < ordered) everything = false;
  }

  const next: OrderStatus = !anything ? 'issued' : (everything ? 'received' : 'partially_received');
  if (next === order.status) return next;

  await trx.updateTable('purchase_orders').set({
    status: next,
    version: Number(order.version) + 1,
    updated_at: new Date(),
  } as never)
    .where('organization_id', '=', actor.organizationId)
    .where('company_id', '=', actor.companyId)
    .where('id', '=', orderId)
    .execute();

  return next;
}

/* ── Open-quantity reporting ───────────────────────────────────────────────── */

export interface OpenLineRow {
  orderId: string;
  orderNumber: string;
  orderDate: string;
  expectedDate: string | null;
  status: OrderStatus;
  supplierId: string;
  supplierName: string;
  orderLineId: string;
  lineNumber: number;
  itemId: string;
  itemCode: string;
  itemName: string;
  baseUnitCode: string;
  warehouseId: string;
  warehouseCode: string;
  orderedQuantity: string;
  receivedQuantity: string;
  remainingQuantity: string;
  netAmount: string;
  receivedValue: string;
  /** The order's net value that has not yet arrived. */
  remainingValue: string;
}

/**
 * Every order line with something still to come.
 *
 * Read from the orders and the receipts at the moment of asking. There is no
 * stored open quantity to go stale, and archived items, warehouses or suppliers
 * still appear — a commitment does not stop existing because a master record
 * was tidied away.
 */
export async function openOrderLines(
  db: Kysely<Database>,
  actor: InventoryActor,
  query: { supplierId?: string; itemId?: string; warehouseId?: string } = {},
): Promise<OpenLineRow[]> {
  let builder = db
    .selectFrom('purchase_order_lines as l')
    .innerJoin('purchase_orders as o', (join) => join
      .onRef('o.id', '=', 'l.order_id')
      .onRef('o.organization_id', '=', 'l.organization_id')
      .onRef('o.company_id', '=', 'l.company_id'))
    .leftJoin('business_parties as p', (join) => join
      .onRef('p.id', '=', 'o.supplier_id')
      .onRef('p.organization_id', '=', 'o.organization_id')
      .onRef('p.company_id', '=', 'o.company_id'))
    .select([
      'l.id as line_id', 'l.line_number', 'l.item_id', 'l.item_code', 'l.item_name',
      'l.base_unit_code', 'l.warehouse_id', 'l.warehouse_code', 'l.ordered_quantity',
      'l.net_amount',
      'o.id as order_id', 'o.order_number', 'o.order_date', 'o.expected_date', 'o.status',
      'o.supplier_id', 'p.legal_name as supplier_name',
    ])
    .where('l.organization_id', '=', actor.organizationId)
    .where('l.company_id', '=', actor.companyId)
    .where('o.status', 'in', [...RECEIVABLE] as string[]);

  if (query.supplierId) builder = builder.where('o.supplier_id', '=', query.supplierId);
  if (query.itemId) builder = builder.where('l.item_id', '=', query.itemId);
  if (query.warehouseId) builder = builder.where('l.warehouse_id', '=', query.warehouseId);

  const rows = await builder
    .orderBy('o.order_date', 'asc')
    .orderBy('o.order_number', 'asc')
    .orderBy('l.line_number', 'asc')
    .execute();

  const orderIds = [...new Set(rows.map((row) => row.order_id))];
  const received = await receivedByOrderLine(db, actor, orderIds);

  const open: OpenLineRow[] = [];
  for (const row of rows) {
    const ordered = Money.toAmount(row.ordered_quantity, 'orderedQuantity');
    const got = received.get(row.line_id) ?? { quantity: Money.ZERO, value: Money.ZERO };
    const remaining = ordered - got.quantity;
    if (remaining <= 0n) continue;

    const net = Money.toAmount(row.net_amount, 'netAmount');
    open.push({
      orderId: row.order_id,
      orderNumber: row.order_number,
      orderDate: toCalendarDate(row.order_date),
      expectedDate: toCalendarDateOrNull(row.expected_date),
      status: row.status as OrderStatus,
      supplierId: row.supplier_id,
      supplierName: row.supplier_name ?? '',
      orderLineId: row.line_id,
      lineNumber: Number(row.line_number),
      itemId: row.item_id,
      itemCode: row.item_code,
      itemName: row.item_name,
      baseUnitCode: row.base_unit_code,
      warehouseId: row.warehouse_id,
      warehouseCode: row.warehouse_code,
      orderedQuantity: row.ordered_quantity,
      receivedQuantity: Money.toDecimalString(got.quantity),
      remainingQuantity: Money.toDecimalString(remaining),
      netAmount: row.net_amount,
      receivedValue: Money.toDecimalString(got.value),
      /* What is left of the committed net value, exactly: the whole net less
       * what has already been recognised, never a re-derived pro-rata figure
       * that could disagree with the receipts by a rounding step. */
      remainingValue: Money.toDecimalString(net - got.value),
    });
  }
  return open;
}

/**
 * Advanced Purchasing AP1 through the real stack.
 *
 * What these have to prove is not that the endpoints answer. It is that a
 * purchase order changes nothing in the books, that a goods receipt recognises
 * inventory against a goods-received-not-invoiced credit and NOTHING else, that
 * the quantity ledger and the general ledger say the same thing after every
 * sequence, that a client cannot choose what its own stock is worth, that
 * nothing can be received twice or beyond what was ordered, and that everything
 * AP2 owns is refused by name rather than approximated.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createMigrator } from '../src/db/migrator.js';
import {
  authHeaders, createTestContext, login, seedUser,
  type SessionCookies, type TestContext,
} from './helpers/testApp.js';

let ctx: TestContext;
let admin: SessionCookies;
const password = 'Steady-Lantern-71-Qv';
const ENTITY = '11111111-1111-1111-1111-111111111111';

beforeEach(async () => {
  ctx = await createTestContext();
  await seedUser(ctx, { email: 'super@ledgora.test', platformRoles: ['super_admin'] });
  admin = await login(ctx, 'super@ledgora.test');
});
afterEach(async () => ctx.close());

const call = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string, user: SessionCookies, payload?: Record<string, unknown>,
) => ctx.app.inject({ method, url, headers: authHeaders(user), payload });

async function planId(code: string): Promise<string> {
  const r = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
  return r.json().plans.find((p: { code: string }) => p.code === code).id;
}

interface Books {
  org: string;
  user: SessionCookies;
  stock: string;
  grni: string;
  payable: string;
  inputTax: string;
  expense: string;
  gain: string;
  loss: string;
  bank: string;
  unitEA: string;
  unitKG: string;
  main: string;
  spare: string;
  item: string;
  itemB: string;
  itemKg: string;
  service: string;
  notPurchasable: string;
  supplier: string;
  supplierB: string;
  currency: string;
}

/** A company with a chart, a profile, two warehouses, items and two suppliers. */
async function books(
  name: string,
  options: { plan?: string; role?: string; currency?: string; country?: string } = {},
): Promise<Books> {
  const plan = options.plan ?? 'enterprise';
  const role = options.role ?? 'admin';
  const currency = options.currency ?? 'JOD';

  const sub = await ctx.app.inject({
    method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(admin),
    payload: {
      fullName: `${name} Owner`, email: `owner@${name.toLowerCase()}.test`,
      organizationLegalName: `${name} LLC`, country: options.country ?? 'JO',
      baseCurrency: currency,
      planId: await planId(plan), onboarding: 'temporary', paymentConfirmed: true,
    },
  });
  expect(sub.statusCode, sub.body).toBe(201);
  const org = sub.json().subscriber.organizationId;

  const invited = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: authHeaders(admin),
    payload: {
      fullName: `${name} Person`, email: `${name.toLowerCase()}@ap.test`,
      organizationId: org, role, onboarding: 'invitation',
    },
  });
  expect(invited.statusCode, invited.body).toBe(201);
  await ctx.app.inject({
    method: 'POST', url: '/api/auth/reset-password',
    payload: { token: invited.json().credential.invitationToken, newPassword: password },
  });
  const user = await login(ctx, `${name.toLowerCase()}@ap.test`, password);

  const account = async (
    code: string, accName: string, type: string, extra: Record<string, unknown> = {},
  ): Promise<string> => {
    const r = await call('POST', '/api/accounting/accounts', user, {
      accountCode: code, accountName: accName, accountType: type, ...extra,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().account.id;
  };

  const stock = await account('1210', 'Inventory', 'asset');
  const grni = await account('2150', 'Goods received not invoiced', 'liability');
  const payable = await account('2100', 'Trade payables', 'liability');
  const inputTax = await account('1260', 'Recoverable input tax', 'asset');
  const expense = await account('5100', 'Consumables used', 'expense');
  const gain = await account('4300', 'Inventory gain', 'income');
  const loss = await account('5600', 'Inventory loss', 'expense');
  const bank = await account('1100', 'Bank', 'asset', {
    cashClassification: 'cash_and_cash_equivalents',
  });

  const units = (await call('GET', '/api/inventory/units', user)).json().units;
  const unitEA = units.find((u: { code: string }) => u.code === 'EA').id;
  const unitKG = units.find((u: { code: string }) => u.code === 'KG').id;

  const warehouse = async (code: string): Promise<string> => {
    const r = await call('POST', '/api/inventory/warehouses', user, { code, name: `${code} store` });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().warehouse.id;
  };
  const main = await warehouse('MAIN');
  const spare = await warehouse('SPARE');

  const profile = await call('PATCH', '/api/inventory/settings', user, {
    expectedVersion: 0,
    defaultInventoryAccountId: stock,
    goodsReceivedNotInvoicedAccountId: grni,
    inventoryGainAccountId: gain,
    inventoryLossAccountId: loss,
  });
  expect(profile.statusCode, profile.body).toBe(200);

  const item = async (payload: Record<string, unknown>): Promise<string> => {
    const r = await call('POST', '/api/inventory/items', user, payload);
    expect(r.statusCode, r.body).toBe(201);
    return r.json().item.id;
  };

  const sku = await item({
    itemCode: 'SKU-1', name: 'Widget', itemType: 'inventory',
    isInventoryTracked: true, baseUnitId: unitEA, inventoryAccountId: stock,
  });
  const skuB = await item({
    itemCode: 'SKU-2', name: 'Sprocket', itemType: 'inventory',
    isInventoryTracked: true, baseUnitId: unitEA, inventoryAccountId: stock,
  });
  const kg = await item({
    itemCode: 'SKU-KG', name: 'Powder', itemType: 'inventory',
    isInventoryTracked: true, baseUnitId: unitKG, inventoryAccountId: stock,
  });
  const service = await item({
    itemCode: 'SRV-1', name: 'Consulting', itemType: 'service', baseUnitId: unitEA,
  });
  const notPurchasable = await item({
    itemCode: 'SKU-SELL', name: 'Sale only', itemType: 'inventory',
    isInventoryTracked: true, isPurchasable: false, isSellable: true,
    baseUnitId: unitEA, inventoryAccountId: stock,
  });

  const vendor = async (code: string, legalName: string): Promise<string> => {
    const r = await call('POST', '/api/vendors', user, {
      partyCode: code, legalName, supplier: { defaultPayableAccountId: payable },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().supplier.id;
  };

  return {
    org, user, stock, grni, payable, inputTax, expense, gain, loss, bank,
    unitEA, unitKG, main, spare,
    item: sku, itemB: skuB, itemKg: kg, service, notPurchasable,
    supplier: await vendor('ACME', 'Acme Supplies'),
    supplierB: await vendor('BETA', 'Beta Trading'),
    currency,
  };
}

/* ── Helpers ───────────────────────────────────────────────────────────────── */

let keySeed = 0;
const key = (): string => `ap1-${Date.now()}-${keySeed++}`;

const orderLine = (b: Books, over: Record<string, unknown> = {}) => ({
  itemId: b.item, warehouseId: b.main, quantity: '10', unitPrice: '5.000', ...over,
});

const draftOrder = (b: Books, lines: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) =>
  call('POST', '/api/purchasing/orders', b.user, {
    supplierId: b.supplier, orderDate: '2026-03-01', lines, ...over,
  });

async function issuedOrder(
  b: Books,
  lines: Array<Record<string, unknown>> = [orderLine(b)],
  over: Record<string, unknown> = {},
): Promise<{ id: string; version: number; lineIds: string[]; number: string }> {
  const created = await draftOrder(b, lines, over);
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().order.id;

  const approved = await call('POST', `/api/purchasing/orders/${id}/approve`, b.user, {
    expectedVersion: created.json().order.version,
  });
  expect(approved.statusCode, approved.body).toBe(200);

  const issued = await call('POST', `/api/purchasing/orders/${id}/issue`, b.user, {
    expectedVersion: approved.json().order.version,
  });
  expect(issued.statusCode, issued.body).toBe(200);

  return {
    id,
    version: issued.json().order.version,
    lineIds: issued.json().order.lines.map((l: { id: string }) => l.id),
    number: issued.json().order.orderNumber,
  };
}

const receive = (
  b: Books,
  orderId: string,
  lines: Array<{ orderLineId: string; quantity: string }>,
  over: Record<string, unknown> = {},
) => call('POST', '/api/purchasing/receipts', b.user, {
  orderId, receiptDate: '2026-03-05', idempotencyKey: key(), lines, ...over,
});

async function glBalance(b: Books, accountId: string): Promise<number> {
  const { rows } = await sql<{ balance: string }>`
    SELECT COALESCE(SUM(COALESCE(l.debit_functional,0) - COALESCE(l.credit_functional,0)), 0)::text
             AS balance
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.journal_entry_id
     WHERE l.organization_id = ${b.org} AND l.account_id = ${accountId}
       AND e.status IN ('posted','reversed')
  `.execute(ctx.db);
  return Number(rows[0]!.balance);
}

async function onHand(b: Books, itemId?: string): Promise<number> {
  const { rows } = await sql<{ quantity: string }>`
    SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN quantity ELSE -quantity END), 0)::text
             AS quantity
      FROM inventory_movements
     WHERE organization_id = ${b.org} AND status = 'posted'
       AND (${itemId ?? null}::uuid IS NULL OR item_id = ${itemId ?? null}::uuid)
  `.execute(ctx.db);
  return Number(rows[0]!.quantity);
}

async function stockValue(b: Books): Promise<number> {
  const { rows } = await sql<{ value: string }>`
    SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN total_cost ELSE -total_cost END), 0)::text
             AS value
      FROM inventory_movements
     WHERE organization_id = ${b.org} AND status = 'posted'
  `.execute(ctx.db);
  return Number(rows[0]!.value);
}

async function countRows(table: string, org: string): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    SELECT COUNT(*)::text AS n FROM ${sql.table(table)} WHERE organization_id = ${org}
  `.execute(ctx.db);
  return Number(rows[0]!.n);
}

async function taxCode(
  b: Books, code: string, category: string, method: string, rate: string, account: string | null,
): Promise<string> {
  const r = await call('POST', '/api/tax-codes', b.user, {
    code, name: `${code} tax`, category, calculationMethod: method,
    direction: 'purchase', effectiveFrom: '2020-01-01',
    inputTaxAccountId: account, rate,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().taxCode.id;
}

/* ══ The order is a commitment, not a transaction ══════════════════════════ */

describe('a purchase order', () => {
  it('is created as a draft with a server-allocated number and server totals', async () => {
    const b = await books('Draft');
    const created = await draftOrder(b, [orderLine(b, { quantity: '10', unitPrice: '5.000' })]);
    expect(created.statusCode, created.body).toBe(201);

    const order = created.json().order;
    expect(order.status).toBe('draft');
    expect(order.orderNumber).toMatch(/^PO-2026-0001$/);
    expect(order.currency).toBe('JOD');
    expect(Number(order.subtotal)).toBe(50);
    expect(Number(order.total)).toBe(50);
    expect(Number(order.estimatedTaxTotal)).toBe(0);
    expect(order.lines[0].baseUnitCode).toBe('EA');
    expect(order.lines[0].warehouseCode).toBe('MAIN');
    expect(Number(order.lines[0].netAmount)).toBe(50);
    /* Derived, never stored. */
    expect(Number(order.lines[0].receivedQuantity)).toBe(0);
    expect(Number(order.lines[0].remainingQuantity)).toBe(10);
  });

  it('numbers orders sequentially and uniquely within one company', async () => {
    const b = await books('Numbering');
    const first = await draftOrder(b, [orderLine(b)]);
    const second = await draftOrder(b, [orderLine(b)]);
    expect(first.json().order.orderNumber).toBe('PO-2026-0001');
    expect(second.json().order.orderNumber).toBe('PO-2026-0002');
  });

  it('creates NO journal, liability, tax or inventory at any point in its life', async () => {
    const b = await books('NoLedger');
    const order = await issuedOrder(b, [orderLine(b, { taxCodeId: null })]);

    const closed = await call('POST', `/api/purchasing/orders/${order.id}/close`, b.user, {
      expectedVersion: order.version, reason: 'Supplier withdrew the quotation',
    });
    expect(closed.statusCode, closed.body).toBe(200);

    expect(await countRows('journal_entries', b.org)).toBe(0);
    expect(await countRows('inventory_movements', b.org)).toBe(0);
    expect(await glBalance(b, b.payable)).toBe(0);
    expect(await glBalance(b, b.stock)).toBe(0);
    expect(await glBalance(b, b.grni)).toBe(0);
  });

  it('computes discounts, estimated tax and totals from the lines', async () => {
    const b = await books('Amounts');
    const vat = await taxCode(b, 'VATIN', 'standard', 'exclusive', '16.000000', b.inputTax);

    const created = await draftOrder(b, [
      orderLine(b, { quantity: '10', unitPrice: '5.000', discountType: 'percentage', discountValue: '10', taxCodeId: vat }),
      orderLine(b, { itemId: b.itemB, quantity: '2', unitPrice: '3.000' }),
    ]);
    expect(created.statusCode, created.body).toBe(201);
    const order = created.json().order;

    /* 50 gross, 5 discount, 45 net, 7.200 estimated tax, 52.200 gross. */
    expect(Number(order.lines[0].lineSubtotal)).toBe(50);
    expect(Number(order.lines[0].discountAmount)).toBe(5);
    expect(Number(order.lines[0].netAmount)).toBe(45);
    expect(Number(order.lines[0].estimatedTaxAmount)).toBe(7.2);
    expect(Number(order.lines[0].grossAmount)).toBe(52.2);

    expect(Number(order.subtotal)).toBe(56);
    expect(Number(order.discountTotal)).toBe(5);
    expect(Number(order.estimatedTaxTotal)).toBe(7.2);
    expect(Number(order.total)).toBe(58.2);
  });

  it('extracts an INCLUSIVE tax from the price before it becomes a cost', async () => {
    const b = await books('InclusiveOrder');
    const vat = await taxCode(b, 'VATIN', 'standard', 'inclusive', '16.000000', b.inputTax);

    const created = await draftOrder(b, [orderLine(b, { quantity: '1', unitPrice: '116.000', taxCodeId: vat })]);
    const line = created.json().order.lines[0];
    /* 116 inclusive at 16% is 100 of cost and 16 of tax. */
    expect(Number(line.netAmount)).toBe(100);
    expect(Number(line.estimatedTaxAmount)).toBe(16);
    expect(Number(line.grossAmount)).toBe(116);
  });

  it('refuses a client-supplied total, number, status or tax figure', async () => {
    const b = await books('ClientFigures');
    for (const field of ['orderNumber', 'status', 'total', 'estimatedTaxTotal', 'subtotal']) {
      const r = await draftOrder(b, [orderLine(b)], { [field]: 'x' });
      expect(r.statusCode, `${field}: ${r.body}`).toBe(400);
    }
    for (const field of ['unitCost', 'netAmount', 'taxRate', 'taxAmount', 'accountId']) {
      const r = await draftOrder(b, [orderLine(b, { [field]: '1' })]);
      expect(r.statusCode, `${field}: ${r.body}`).toBe(400);
    }
  });

  it('refuses an inactive or cross-company supplier', async () => {
    const b = await books('SupplierGuard');
    const other = await books('SupplierOther');

    const cross = await draftOrder(b, [orderLine(b)], { supplierId: other.supplier });
    expect(cross.statusCode, cross.body).toBe(400);
    expect(cross.json().error.message).toMatch(/does not exist in these books/i);

    const supplier = (await call('GET', `/api/vendors/${b.supplier}`, b.user)).json().supplier;
    const archived = await call('POST', `/api/vendors/${b.supplier}/archive`, b.user, {
      expectedVersion: supplier.version, archived: true,
    });
    expect(archived.statusCode, archived.body).toBe(200);

    const after = await draftOrder(b, [orderLine(b)]);
    expect(after.statusCode, after.body).toBe(400);
    expect(after.json().error.message).toMatch(/archived/i);
  });

  it('refuses a service, a non-purchasable item and a cross-company item', async () => {
    const b = await books('ItemGuard');
    const other = await books('ItemOther');

    const service = await draftOrder(b, [orderLine(b, { itemId: b.service })]);
    expect(service.statusCode, service.body).toBe(400);
    expect(service.json().error.message).toMatch(/not stock-tracked/i);

    const sellOnly = await draftOrder(b, [orderLine(b, { itemId: b.notPurchasable })]);
    expect(sellOnly.statusCode, sellOnly.body).toBe(400);
    expect(sellOnly.json().error.message).toMatch(/not marked purchasable/i);

    const cross = await draftOrder(b, [orderLine(b, { itemId: other.item })]);
    expect(cross.statusCode, cross.body).toBe(400);
    expect(cross.json().error.message).toMatch(/not in this company/i);

    const crossWarehouse = await draftOrder(b, [orderLine(b, { warehouseId: other.main })]);
    expect(crossWarehouse.statusCode, crossWarehouse.body).toBe(400);
  });

  it('refuses a negative or zero quantity, a negative price and an alternate unit', async () => {
    const b = await books('QuantityGuard');
    /* A minus sign never reaches the service: the route pattern refuses it. */
    for (const quantity of ['-1', '0']) {
      const r = await draftOrder(b, [orderLine(b, { quantity })]);
      expect(r.statusCode, `${quantity}: ${r.body}`).toBe(400);
    }
    expect((await draftOrder(b, [orderLine(b, { unitPrice: '-2' })])).statusCode).toBe(400);
    const unit = await draftOrder(b, [orderLine(b, { unitId: b.unitKG })]);
    expect(unit.statusCode, unit.body).toBe(400);
  });

  it('refuses a quantity finer than the item base unit allows', async () => {
    const b = await books('UnitPrecision');
    /* EA is kept to zero decimal places; KG to three. */
    expect((await draftOrder(b, [orderLine(b, { quantity: '1.5' })])).statusCode).toBe(400);
    const kg = await draftOrder(b, [orderLine(b, { itemId: b.itemKg, quantity: '1.500' })]);
    expect(kg.statusCode, kg.body).toBe(201);
    expect((await draftOrder(b, [orderLine(b, { itemId: b.itemKg, quantity: '1.5005' })])).statusCode).toBe(400);
  });

  it('refuses every deferred dimension and every AP2 concern by name', async () => {
    const b = await books('Deferred');
    for (const field of [
      'projectId', 'costCenterId', 'lotId', 'binId', 'landedCost', 'exchangeRate',
      'matchStatus', 'priceTolerance', 'purchasePriceVarianceAccountId', 'requisitionId',
    ]) {
      const r = await draftOrder(b, [orderLine(b)], { [field]: 'x' });
      expect(r.statusCode, `${field}: ${r.body}`).toBe(400);
    }
  });

  it('refuses a foreign currency rather than converting it', async () => {
    const b = await books('Currency');
    const r = await draftOrder(b, [orderLine(b)], { currency: 'USD' });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.message).toMatch(/JOD/);
  });

  it('refuses a sales-only tax code on a purchase order', async () => {
    const b = await books('TaxDirection');
    const sales = await call('POST', '/api/tax-codes', b.user, {
      code: 'VATOUT', name: 'Output VAT', category: 'standard', calculationMethod: 'exclusive',
      direction: 'sales', effectiveFrom: '2020-01-01', rate: '16.000000',
      outputTaxAccountId: b.payable,
    });
    expect(sales.statusCode, sales.body).toBe(201);

    const r = await draftOrder(b, [orderLine(b, { taxCodeId: sales.json().taxCode.id })]);
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.message).toMatch(/sales documents/i);
  });
});

/* ══ Lifecycle ═════════════════════════════════════════════════════════════ */

describe('the order lifecycle', () => {
  it('moves draft to approved to issued, and keeps the two apart', async () => {
    const b = await books('Lifecycle');
    const created = await draftOrder(b, [orderLine(b)]);
    const id = created.json().order.id;

    /* Issue before approval is refused: they are different authorities. */
    const early = await call('POST', `/api/purchasing/orders/${id}/issue`, b.user, {
      expectedVersion: created.json().order.version,
    });
    expect(early.statusCode, early.body).toBe(409);
    expect(early.json().error.message).toMatch(/not been approved/i);

    const approved = await call('POST', `/api/purchasing/orders/${id}/approve`, b.user, {
      expectedVersion: created.json().order.version,
    });
    expect(approved.json().order.status).toBe('approved');
    expect(approved.json().order.approvedAt).toBeTruthy();

    const issued = await call('POST', `/api/purchasing/orders/${id}/issue`, b.user, {
      expectedVersion: approved.json().order.version,
    });
    expect(issued.json().order.status).toBe('issued');
    expect(issued.json().order.issuedAt).toBeTruthy();
  });

  it('edits a draft under an optimistic version and refuses a stale one', async () => {
    const b = await books('Edit');
    const created = await draftOrder(b, [orderLine(b)]);
    const id = created.json().order.id;
    const version = created.json().order.version;

    const edited = await call('PATCH', `/api/purchasing/orders/${id}`, b.user, {
      expectedVersion: version, supplierId: b.supplierB, orderDate: '2026-03-02',
      lines: [orderLine(b, { quantity: '4', unitPrice: '2.500' })],
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(Number(edited.json().order.total)).toBe(10);
    expect(edited.json().order.supplierId).toBe(b.supplierB);

    const stale = await call('PATCH', `/api/purchasing/orders/${id}`, b.user, {
      expectedVersion: version, supplierId: b.supplier, orderDate: '2026-03-02',
      lines: [orderLine(b)],
    });
    expect(stale.statusCode, stale.body).toBe(409);
  });

  it('refuses to edit an order that is no longer a draft', async () => {
    const b = await books('EditAfterIssue');
    const order = await issuedOrder(b);
    const r = await call('PATCH', `/api/purchasing/orders/${order.id}`, b.user, {
      expectedVersion: order.version, supplierId: b.supplier, orderDate: '2026-03-01',
      lines: [orderLine(b, { quantity: '1' })],
    });
    expect(r.statusCode, r.body).toBe(409);
  });

  it('cancels an unreceived order and keeps the row', async () => {
    const b = await books('Cancel');
    const order = await issuedOrder(b);
    const cancelled = await call('POST', `/api/purchasing/orders/${order.id}/cancel`, b.user, {
      expectedVersion: order.version, reason: 'Requirement withdrawn',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json().order.status).toBe('cancelled');
    expect(cancelled.json().order.closureReason).toBe('Requirement withdrawn');
    expect(await countRows('purchase_orders', b.org)).toBe(1);
  });

  it('refuses cancellation once stock has arrived, and closes instead', async () => {
    const b = await books('CancelAfterReceipt');
    const order = await issuedOrder(b);
    const posted = await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '4' }]);
    expect(posted.statusCode, posted.body).toBe(201);

    const current = (await call('GET', `/api/purchasing/orders/${order.id}`, b.user)).json().order;
    const cancelled = await call('POST', `/api/purchasing/orders/${order.id}/cancel`, b.user, {
      expectedVersion: current.version, reason: 'Changed our minds',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(409);
    expect(cancelled.json().error.message).toMatch(/cannot be cancelled/i);

    const closed = await call('POST', `/api/purchasing/orders/${order.id}/close`, b.user, {
      expectedVersion: current.version, reason: 'Balance abandoned',
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().order.status).toBe('closed');
    /* Closing destroys nothing. */
    expect(await onHand(b)).toBe(4);
    expect(await countRows('goods_receipts', b.org)).toBe(1);
  });

  it('requires a reason before abandoning a commitment', async () => {
    const b = await books('ClosureReason');
    const order = await issuedOrder(b);
    const r = await call('POST', `/api/purchasing/orders/${order.id}/cancel`, b.user, {
      expectedVersion: order.version, reason: 'no',
    });
    expect(r.statusCode, r.body).toBe(400);
  });

  it('records immutable audit history with the server actor', async () => {
    const b = await books('Audit');
    const order = await issuedOrder(b);
    const events = (await call('GET', `/api/purchasing/orders/${order.id}/history`, b.user))
      .json().events;
    expect(events.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining([
        'PURCHASE_ORDER_CREATED', 'PURCHASE_ORDER_APPROVED', 'PURCHASE_ORDER_ISSUED',
      ]),
    );
    expect(events[0].actorName).toBe('Audit Person');
    expect(events[0].at).toBeTruthy();
  });
});

/* ══ The receipt is the recognition point ══════════════════════════════════ */

describe('a goods receipt', () => {
  it('posts Dr Inventory / Cr GRNI and nothing else', async () => {
    const b = await books('Recognise');
    const order = await issuedOrder(b, [orderLine(b, { quantity: '10', unitPrice: '5.000' })]);

    const posted = await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '10' }]);
    expect(posted.statusCode, posted.body).toBe(201);
    const receipt = posted.json().receipt;

    expect(receipt.receiptNumber).toBe('GR-2026-0001');
    expect(receipt.status).toBe('posted');
    expect(receipt.matched).toBe(false);
    expect(Number(receipt.totalValue)).toBe(50);

    expect(await onHand(b)).toBe(10);
    expect(await stockValue(b)).toBe(50);
    expect(await glBalance(b, b.stock)).toBe(50);
    expect(await glBalance(b, b.grni)).toBe(-50);
    /* No payable, no input tax. */
    expect(await glBalance(b, b.payable)).toBe(0);
    expect(await glBalance(b, b.inputTax)).toBe(0);

    /* Exactly one movement, and its value IS the journal amount. */
    const { rows } = await sql<{ n: string; total: string }>`
      SELECT COUNT(*)::text AS n, COALESCE(SUM(total_cost),0)::text AS total
        FROM inventory_movements WHERE organization_id = ${b.org}
    `.execute(ctx.db);
    expect(Number(rows[0]!.n)).toBe(1);
    expect(Number(rows[0]!.total)).toBe(50);
  });

  it('keeps recoverable input tax out of the stock cost — exclusive and inclusive', async () => {
    for (const [method, price, cost] of [
      ['exclusive', '5.000', 50], ['inclusive', '5.800', 50],
    ] as const) {
      const b = await books(`Tax${method}`);
      const vat = await taxCode(b, 'VATIN', 'standard', method, '16.000000', b.inputTax);
      const order = await issuedOrder(b, [orderLine(b, { quantity: '10', unitPrice: price, taxCodeId: vat })]);

      const posted = await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '10' }]);
      expect(posted.statusCode, posted.body).toBe(201);

      expect(await stockValue(b)).toBe(cost);
      expect(await glBalance(b, b.stock)).toBe(cost);
      expect(await glBalance(b, b.grni)).toBe(-cost);
      /* No tax is recognised or frozen at the receipt. */
      expect(await glBalance(b, b.inputTax)).toBe(0);
    }
  });

  it('supports partial and repeated receipts against one order line', async () => {
    const b = await books('Partial');
    const order = await issuedOrder(b, [orderLine(b, { quantity: '10', unitPrice: '5.000' })]);

    const first = await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '4' }]);
    expect(first.statusCode, first.body).toBe(201);

    let current = (await call('GET', `/api/purchasing/orders/${order.id}`, b.user)).json().order;
    expect(current.status).toBe('partially_received');
    expect(Number(current.lines[0].receivedQuantity)).toBe(4);
    expect(Number(current.lines[0].remainingQuantity)).toBe(6);

    const second = await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '6' }]);
    expect(second.statusCode, second.body).toBe(201);

    current = (await call('GET', `/api/purchasing/orders/${order.id}`, b.user)).json().order;
    expect(current.status).toBe('received');
    expect(Number(current.lines[0].remainingQuantity)).toBe(0);

    expect(await onHand(b)).toBe(10);
    expect(await glBalance(b, b.stock)).toBe(50);
    expect(await glBalance(b, b.grni)).toBe(-50);
  });

  it('recognises the whole ordered net across partial receipts, exactly', async () => {
    const b = await books('ExactSplit');
    /* 3 at 3.333 is 9.999; a third of it does not divide evenly at three places. */
    const order = await issuedOrder(b, [orderLine(b, {
      itemId: b.itemKg, quantity: '3.000', unitPrice: '3.333',
    })]);

    for (const quantity of ['1.000', '1.000', '1.000']) {
      const r = await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity }]);
      expect(r.statusCode, r.body).toBe(201);
    }

    /* Not a fils more or less than the order committed to. */
    expect(await stockValue(b)).toBe(9.999);
    expect(await glBalance(b, b.stock)).toBe(9.999);
    expect(await glBalance(b, b.grni)).toBe(-9.999);
  });

  it('receives selected lines across several warehouses in one delivery', async () => {
    const b = await books('MultiLine');
    const order = await issuedOrder(b, [
      orderLine(b, { quantity: '10', unitPrice: '5.000' }),
      orderLine(b, { itemId: b.itemB, warehouseId: b.spare, quantity: '4', unitPrice: '2.000' }),
    ]);

    const posted = await receive(b, order.id, [
      { orderLineId: order.lineIds[0]!, quantity: '2' },
      { orderLineId: order.lineIds[1]!, quantity: '4' },
    ]);
    expect(posted.statusCode, posted.body).toBe(201);

    expect(await onHand(b, b.item)).toBe(2);
    expect(await onHand(b, b.itemB)).toBe(4);
    expect(await glBalance(b, b.stock)).toBe(18);
    expect(await glBalance(b, b.grni)).toBe(-18);

    const current = (await call('GET', `/api/purchasing/orders/${order.id}`, b.user)).json().order;
    expect(current.status).toBe('partially_received');
  });

  it('advances the weighted average exactly', async () => {
    const b = await books('Average');
    const order = await issuedOrder(b, [
      orderLine(b, { quantity: '10', unitPrice: '5.000' }),
      orderLine(b, { quantity: '10', unitPrice: '7.000' }),
    ]);
    await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '10' }]);
    await receive(b, order.id, [{ orderLineId: order.lineIds[1]!, quantity: '10' }]);

    /* 50 + 70 over 20 units is 6.000 a unit. */
    expect(await onHand(b, b.item)).toBe(20);
    expect(await stockValue(b)).toBe(120);

    const valuation = (await call('GET', '/api/inventory/valuation', b.user)).json();
    const row = valuation.rows.find((r: { itemCode: string }) => r.itemCode === 'SKU-1');
    expect(Number(row.averageCost)).toBe(6);
  });

  it('appears in the stock card, the valuation and the GL reconciliation', async () => {
    const b = await books('Reports');
    const order = await issuedOrder(b);
    await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '10' }]);

    const card = (await call('GET', `/api/inventory/items/${b.item}/stock-card`, b.user))
      .json().entries;
    expect(card).toHaveLength(1);
    expect(card[0].movementType).toBe('receipt');
    expect(Number(card[0].runningQuantity)).toBe(10);

    const reconciliation = (await call('GET', '/api/inventory/reconciliation', b.user)).json();
    expect(reconciliation.balanced).toBe(true);
  });

  it('refuses a receipt without a controlled purchase order', async () => {
    const b = await books('NoOrder');
    const r = await call('POST', '/api/purchasing/receipts', b.user, {
      receiptDate: '2026-03-05', idempotencyKey: key(),
      lines: [{ orderLineId: '11111111-2222-3333-4444-555555555555', quantity: '1' }],
    });
    expect(r.statusCode, r.body).toBe(400);
  });

  it('refuses a receipt against a draft, approved, cancelled or closed order', async () => {
    const b = await books('NotIssued');
    const created = await draftOrder(b, [orderLine(b)]);
    const id = created.json().order.id;
    const lineId = created.json().order.lines[0].id;

    const onDraft = await receive(b, id, [{ orderLineId: lineId, quantity: '1' }]);
    expect(onDraft.statusCode, onDraft.body).toBe(409);
    expect(onDraft.json().error.message).toMatch(/not been issued/i);

    const approved = await call('POST', `/api/purchasing/orders/${id}/approve`, b.user, {
      expectedVersion: created.json().order.version,
    });
    const onApproved = await receive(b, id, [{ orderLineId: lineId, quantity: '1' }]);
    expect(onApproved.statusCode, onApproved.body).toBe(409);

    await call('POST', `/api/purchasing/orders/${id}/cancel`, b.user, {
      expectedVersion: approved.json().order.version, reason: 'Abandoned before issue',
    });
    const onCancelled = await receive(b, id, [{ orderLineId: lineId, quantity: '1' }]);
    expect(onCancelled.statusCode, onCancelled.body).toBe(409);
  });

  it('refuses an over-receipt with no tolerance of any kind', async () => {
    const b = await books('OverReceipt');
    const order = await issuedOrder(b, [orderLine(b, { quantity: '10' })]);

    const tooMany = await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '11' }]);
    expect(tooMany.statusCode, tooMany.body).toBe(400);
    expect(tooMany.json().error.message).toMatch(/no over-receipt tolerance/i);

    /*
     * A partial first, so the order stays receivable and the refusal comes from
     * the LINE rather than from the order's own state. Both refusals matter and
     * they are different guards.
     */
    await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '9' }]);
    const overByOne = await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '2' }]);
    expect(overByOne.statusCode, overByOne.body).toBe(400);
    expect(overByOne.json().error.message).toMatch(/no over-receipt tolerance/i);

    await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '1' }]);
    /* Now the whole order is in, and the header refuses anything further. */
    const again = await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '1' }]);
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.message).toMatch(/cannot receive more stock/i);

    expect(await onHand(b)).toBe(10);
  });

  it('refuses an order line from a different order', async () => {
    const b = await books('WrongLine');
    const one = await issuedOrder(b, [orderLine(b)]);
    const two = await issuedOrder(b, [orderLine(b, { itemId: b.itemB })]);

    const r = await receive(b, one.id, [{ orderLineId: two.lineIds[0]!, quantity: '1' }]);
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.message).toMatch(/does not belong to purchase order/i);
  });

  it('refuses a client-supplied item, cost, warehouse or match state', async () => {
    const b = await books('ReceiptFigures');
    const order = await issuedOrder(b);
    for (const field of [
      'itemId', 'warehouseId', 'unitCost', 'totalCost', 'remainingQuantity',
      'matchStatus', 'billId', 'lotId', 'projectId',
    ]) {
      const r = await receive(b, order.id, [
        { orderLineId: order.lineIds[0]!, quantity: '1', [field]: 'x' } as never,
      ]);
      expect(r.statusCode, `${field}: ${r.body}`).toBe(400);
    }
  });

  it('refuses the same order line twice on ONE receipt', async () => {
    const b = await books('DuplicateLine');
    const order = await issuedOrder(b);
    const r = await receive(b, order.id, [
      { orderLineId: order.lineIds[0]!, quantity: '1' },
      { orderLineId: order.lineIds[0]!, quantity: '1' },
    ]);
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.message).toMatch(/already taken/i);
  });

  it('answers a repeated idempotency key with the receipt it already made', async () => {
    const b = await books('Idempotent');
    const order = await issuedOrder(b);
    const idempotencyKey = key();
    const payload = {
      orderId: order.id, receiptDate: '2026-03-05', idempotencyKey,
      lines: [{ orderLineId: order.lineIds[0]!, quantity: '3' }],
    };

    const first = await call('POST', '/api/purchasing/receipts', b.user, payload);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().created).toBe(true);

    const second = await call('POST', '/api/purchasing/receipts', b.user, payload);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().created).toBe(false);
    expect(second.json().receipt.id).toBe(first.json().receipt.id);

    expect(await countRows('goods_receipts', b.org)).toBe(1);
    expect(await countRows('inventory_movements', b.org)).toBe(1);
    expect(await countRows('journal_entries', b.org)).toBe(1);
    expect(await onHand(b)).toBe(3);
  });

  it('lets only ONE of several simultaneous deliveries take the last unit', async () => {
    const b = await books('Race');
    const order = await issuedOrder(b, [orderLine(b, { quantity: '1' })]);

    const attempts = await Promise.all(
      Array.from({ length: 4 }, () =>
        receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '1' }])),
    );
    expect(attempts.filter((r) => r.statusCode === 201)).toHaveLength(1);

    expect(await onHand(b)).toBe(1);
    expect(await countRows('inventory_movements', b.org)).toBe(1);
    expect(await glBalance(b, b.grni)).toBe(-5);
  });

  it('enforces the posting-period lock', async () => {
    const b = await books('PeriodLock');
    const order = await issuedOrder(b);

    const period = await call('POST', '/api/accounting/periods', b.user, {
      fiscalYear: 2026, periodNumber: 3, startDate: '2026-03-01', endDate: '2026-03-31',
    });
    expect(period.statusCode, period.body).toBe(201);
    const locked = await call('PATCH', `/api/accounting/periods/${period.json().period.id}`, b.user, {
      status: 'locked', reason: 'Month closed for reporting',
    });
    expect(locked.statusCode, locked.body).toBe(200);

    const r = await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '1' }]);
    expect(r.statusCode, r.body).toBe(409);
    expect(await countRows('inventory_movements', b.org)).toBe(0);
  });

  it('refuses posting when the GRNI account is missing, or is a bank account', async () => {
    const b = await books('AccountGuard');
    const settings = (await call('GET', '/api/inventory/settings', b.user)).json().settings;

    const cleared = await call('PATCH', '/api/inventory/settings', b.user, {
      expectedVersion: settings.version,
      defaultInventoryAccountId: b.stock,
      goodsReceivedNotInvoicedAccountId: null,
      inventoryGainAccountId: b.gain, inventoryLossAccountId: b.loss,
    });
    expect(cleared.statusCode, cleared.body).toBe(200);

    const order = await issuedOrder(b);
    const missing = await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '1' }]);
    expect(missing.statusCode, missing.body).toBe(400);
    expect(missing.json().error.message).toMatch(/goods-received-not-invoiced/i);

    const bank = await call('PATCH', '/api/inventory/settings', b.user, {
      expectedVersion: cleared.json().settings.version,
      defaultInventoryAccountId: b.stock,
      goodsReceivedNotInvoicedAccountId: b.bank,
      inventoryGainAccountId: b.gain, inventoryLossAccountId: b.loss,
    });
    expect(bank.statusCode, bank.body).toBe(400);
    expect(await countRows('inventory_movements', b.org)).toBe(0);
  });

  it('refuses posting when the GRNI account has been blocked since it was mapped', async () => {
    const b = await books('ArchivedGrni');
    const order = await issuedOrder(b);

    const account = (await call('GET', `/api/accounting/accounts/${b.grni}`, b.user)).json().account;
    const blocked = await call('PATCH', `/api/accounting/accounts/${b.grni}`, b.user, {
      expectedVersion: account.version, accountCode: account.accountCode,
      accountName: account.accountName, accountType: account.accountType, blocked: true,
    });
    expect(blocked.statusCode, blocked.body).toBe(200);

    const r = await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '1' }]);
    expect(r.statusCode, r.body).toBe(400);
    expect(await countRows('inventory_movements', b.org)).toBe(0);
  });

  it('rolls everything back together when the posting fails part-way', async () => {
    const b = await books('Atomic');
    const order = await issuedOrder(b, [
      orderLine(b, { quantity: '5' }),
      orderLine(b, { itemId: b.itemB, quantity: '5' }),
    ]);

    /* The second line asks for more than remains, and it is validated after the
     * first has already been planned. Nothing at all may survive. */
    const r = await receive(b, order.id, [
      { orderLineId: order.lineIds[0]!, quantity: '5' },
      { orderLineId: order.lineIds[1]!, quantity: '9' },
    ]);
    expect(r.statusCode, r.body).toBe(400);

    expect(await countRows('goods_receipts', b.org)).toBe(0);
    expect(await countRows('goods_receipt_lines', b.org)).toBe(0);
    expect(await countRows('inventory_movements', b.org)).toBe(0);
    expect(await countRows('journal_entries', b.org)).toBe(0);
    expect(await onHand(b)).toBe(0);

    const current = (await call('GET', `/api/purchasing/orders/${order.id}`, b.user)).json().order;
    expect(current.status).toBe('issued');
  });

  it('reads calendar dates correctly east of Greenwich', async () => {
    const b = await books('Dates');
    const order = await issuedOrder(b);
    const posted = await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '1' }], {
      receiptDate: '2026-03-05', postingDate: '2026-03-06',
    });
    expect(posted.statusCode, posted.body).toBe(201);
    expect(posted.json().receipt.receiptDate).toBe('2026-03-05');
    expect(posted.json().receipt.postingDate).toBe('2026-03-06');
  });
});

/* ══ Reversal ══════════════════════════════════════════════════════════════ */

describe('reversing a goods receipt', () => {
  it('withdraws the stock at its ORIGINAL cost and restores the order', async () => {
    const b = await books('Reverse');
    const order = await issuedOrder(b, [orderLine(b, { quantity: '10', unitPrice: '5.000' })]);
    const posted = await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '6' }]);
    const receipt = posted.json().receipt;

    const reversed = await call(
      'POST', `/api/purchasing/receipts/${receipt.id}/reverse`, b.user,
      { expectedVersion: receipt.version, reason: 'Wrong goods delivered' },
    );
    expect(reversed.statusCode, reversed.body).toBe(200);
    expect(reversed.json().receipt.status).toBe('reversed');
    expect(reversed.json().receipt.reversalDocumentId).toBeTruthy();

    expect(await onHand(b)).toBe(0);
    expect(await stockValue(b)).toBe(0);
    expect(await glBalance(b, b.stock)).toBe(0);
    expect(await glBalance(b, b.grni)).toBe(0);

    const current = (await call('GET', `/api/purchasing/orders/${order.id}`, b.user)).json().order;
    expect(current.status).toBe('issued');
    expect(Number(current.lines[0].remainingQuantity)).toBe(10);
    expect(Number(current.lines[0].receivedQuantity)).toBe(0);
  });

  it('reverses at the original cost even after the average has moved', async () => {
    const b = await books('ReverseAfterAverage');
    const order = await issuedOrder(b, [
      orderLine(b, { quantity: '10', unitPrice: '5.000' }),
      orderLine(b, { quantity: '10', unitPrice: '9.000' }),
    ]);
    const first = await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '10' }]);
    await receive(b, order.id, [{ orderLineId: order.lineIds[1]!, quantity: '10' }]);

    /* The average is now 7.000; the first receipt came in at 5.000. */
    const receipt = first.json().receipt;
    const reversed = await call(
      'POST', `/api/purchasing/receipts/${receipt.id}/reverse`, b.user,
      { expectedVersion: receipt.version, reason: 'Returned to supplier by agreement' },
    );
    expect(reversed.statusCode, reversed.body).toBe(200);

    /* Exactly the 90 of the second receipt remains, not 10 x 7. */
    expect(await onHand(b)).toBe(10);
    expect(await stockValue(b)).toBe(90);
    expect(await glBalance(b, b.stock)).toBe(90);
    expect(await glBalance(b, b.grni)).toBe(-90);
  });

  it('is refused once the stock has been used', async () => {
    const b = await books('ReverseConsumed');
    const order = await issuedOrder(b, [orderLine(b, { quantity: '10', unitPrice: '5.000' })]);
    const posted = await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '10' }]);

    const issue = await call('POST', '/api/inventory/documents', b.user, {
      kind: 'issue', movementDate: '2026-03-10', idempotencyKey: key(),
      lines: [{ itemId: b.item, warehouseId: b.main, quantity: '7', expenseAccountId: b.expense }],
    });
    expect(issue.statusCode, issue.body).toBe(201);

    const receipt = posted.json().receipt;
    const reversed = await call(
      'POST', `/api/purchasing/receipts/${receipt.id}/reverse`, b.user,
      { expectedVersion: receipt.version, reason: 'Too late, it has been used' },
    );
    expect(reversed.statusCode, reversed.body).toBe(400);
    expect(reversed.json().error.message).toMatch(/remain|has been used/i);

    /* And nothing moved. */
    expect(await onHand(b)).toBe(3);
    const still = (await call('GET', `/api/purchasing/receipts/${receipt.id}`, b.user)).json().receipt;
    expect(still.status).toBe('posted');
  });

  it('produces exactly one reversal from simultaneous requests', async () => {
    const b = await books('ReverseRace');
    const order = await issuedOrder(b);
    const posted = await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '5' }]);
    const receipt = posted.json().receipt;

    const attempts = await Promise.all(
      Array.from({ length: 4 }, () => call(
        'POST', `/api/purchasing/receipts/${receipt.id}/reverse`, b.user,
        { expectedVersion: receipt.version, reason: 'Simultaneous withdrawal' },
      )),
    );
    /* Every one of them may succeed — the retries are idempotent — but there is
     * exactly ONE reversal document and one reversing journal. */
    expect(attempts.every((r) => r.statusCode === 200 || r.statusCode === 409)).toBe(true);

    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM inventory_documents
       WHERE organization_id = ${b.org} AND reversal_of_document_id IS NOT NULL
    `.execute(ctx.db);
    expect(Number(rows[0]!.n)).toBe(1);
    expect(await onHand(b)).toBe(0);
    expect(await glBalance(b, b.grni)).toBe(0);
  });

  it('refuses a stale version and requires a reason', async () => {
    const b = await books('ReverseGuards');
    const order = await issuedOrder(b);
    const posted = await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '2' }]);
    const receipt = posted.json().receipt;

    const short = await call('POST', `/api/purchasing/receipts/${receipt.id}/reverse`, b.user, {
      expectedVersion: receipt.version, reason: 'no',
    });
    expect(short.statusCode, short.body).toBe(400);

    const stale = await call('POST', `/api/purchasing/receipts/${receipt.id}/reverse`, b.user, {
      expectedVersion: receipt.version + 5, reason: 'Wrong version entirely',
    });
    expect(stale.statusCode, stale.body).toBe(409);
  });

  it('leaves the receipt and its history in place', async () => {
    const b = await books('ReverseHistory');
    const order = await issuedOrder(b);
    const posted = await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '2' }]);
    const receipt = posted.json().receipt;
    await call('POST', `/api/purchasing/receipts/${receipt.id}/reverse`, b.user, {
      expectedVersion: receipt.version, reason: 'Recorded in error',
    });

    const still = (await call('GET', `/api/purchasing/receipts/${receipt.id}`, b.user)).json().receipt;
    expect(still.receiptNumber).toBe(receipt.receiptNumber);
    expect(still.lines).toHaveLength(1);
    const events = (await call('GET', `/api/purchasing/receipts/${receipt.id}/history`, b.user))
      .json().events;
    expect(events.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['GOODS_RECEIPT_POSTED', 'GOODS_RECEIPT_REVERSED']),
    );
  });
});

/* ══ Immutability, enforced by the database ════════════════════════════════ */

describe('what the database itself refuses', () => {
  it('refuses to edit or delete a posted receipt', async () => {
    const b = await books('Immutable');
    const order = await issuedOrder(b);
    const posted = await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '2' }]);
    const id = posted.json().receipt.id;

    await expect(sql`
      UPDATE goods_receipts SET total_value = 999 WHERE id = ${id}
    `.execute(ctx.db)).rejects.toThrow(/cannot be edited/i);

    await expect(sql`
      DELETE FROM goods_receipts WHERE id = ${id}
    `.execute(ctx.db)).rejects.toThrow(/cannot be deleted/i);

    await expect(sql`
      UPDATE goods_receipt_lines SET received_quantity = 99 WHERE receipt_id = ${id}
    `.execute(ctx.db)).rejects.toThrow(/cannot be edited/i);
  });

  it('refuses to rewrite an order line a receipt was derived from', async () => {
    const b = await books('FrozenLine');
    const order = await issuedOrder(b);
    await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '2' }]);

    await expect(sql`
      UPDATE purchase_order_lines SET ordered_quantity = 99 WHERE id = ${order.lineIds[0]!}
    `.execute(ctx.db)).rejects.toThrow(/goods receipt against it/i);

    await expect(sql`
      UPDATE purchase_orders SET supplier_id = ${b.supplierB} WHERE id = ${order.id}
    `.execute(ctx.db)).rejects.toThrow(/supplier cannot be changed/i);

    await expect(sql`
      DELETE FROM purchase_orders WHERE id = ${order.id}
    `.execute(ctx.db)).rejects.toThrow(/cannot be deleted/i);
  });

  it('makes a cross-company order, line or receipt structurally impossible', async () => {
    const b = await books('CrossCompany');
    const other = await books('CrossOther');
    const order = await issuedOrder(b);

    /* Another company's supplier on this company's order. */
    await expect(sql`
      INSERT INTO purchase_orders
        (organization_id, company_id, order_number, supplier_id, order_date, currency)
      SELECT organization_id, company_id, 'PO-X', ${other.supplier}, DATE '2026-03-01', 'JOD'
        FROM purchase_orders WHERE id = ${order.id}
    `.execute(ctx.db)).rejects.toThrow();

    /* A receipt claiming a supplier its own order does not name. */
    await expect(sql`
      INSERT INTO goods_receipts
        (organization_id, company_id, receipt_number, order_id, supplier_id,
         receipt_date, posting_date, idempotency_key)
      SELECT organization_id, company_id, 'GR-X', ${order.id}, ${b.supplierB},
             DATE '2026-03-05', DATE '2026-03-05', 'k-x'
        FROM purchase_orders WHERE id = ${order.id}
    `.execute(ctx.db)).rejects.toThrow();
  });
});

/* ══ The two purchasing workflows stay apart ═══════════════════════════════ */

describe('direct stocked bills and receipt-first purchasing', () => {
  it('leaves the I3 direct stocked bill working exactly as it did', async () => {
    const b = await books('DirectBill');
    const bill = await call('POST', '/api/bills', b.user, {
      issuingEntityId: ENTITY, supplierId: b.supplier, supplierInvoiceNumber: 'SUP-1',
      billDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{
        description: 'Widgets', accountId: b.expense, itemId: b.item, warehouseId: b.main,
        quantity: '4', unitPrice: '2.500',
      }],
    });
    expect(bill.statusCode, bill.body).toBe(201);
    const posted = await call('POST', `/api/bills/${bill.json().bill.id}/post`, b.user, {
      expectedVersion: bill.json().bill.version,
    });
    expect(posted.statusCode, posted.body).toBe(200);

    /* Inventory and the payable arise together; GRNI is untouched. */
    expect(await onHand(b)).toBe(4);
    expect(await glBalance(b, b.stock)).toBe(10);
    expect(await glBalance(b, b.payable)).toBe(-10);
    expect(await glBalance(b, b.grni)).toBe(0);
  });

  it('still refuses a purchase-order or goods-receipt reference on a direct bill', async () => {
    const b = await books('HalfLink');
    for (const field of ['purchaseOrderId', 'goodsReceiptId']) {
      const r = await call('POST', '/api/bills', b.user, {
        issuingEntityId: ENTITY, supplierId: b.supplier, supplierInvoiceNumber: `SUP-${field}`,
        billDate: '2026-03-01', dueDate: '2026-03-31',
        [field]: 'PO-2026-0001',
        lines: [{
          description: 'Widgets', accountId: b.expense, itemId: b.item, warehouseId: b.main,
          quantity: '1', unitPrice: '1.000',
        }],
      });
      expect(r.statusCode, `${field}: ${r.body}`).toBe(400);
      expect(r.json().error.message).toMatch(/purchase orders|goods receipts/i);
    }
  });

  it('has no matching, variance, return or debit-note endpoint', async () => {
    const b = await books('AP2Absent');
    for (const path of [
      '/api/purchasing/matches', '/api/purchasing/three-way-match',
      '/api/purchasing/price-variance', '/api/purchasing/returns',
      '/api/purchasing/debit-notes', '/api/inventory/goods-receipts',
    ]) {
      const r = await call('GET', path, b.user);
      expect(r.statusCode, path).toBe(404);
    }
  });

  it('never reports a receipt as matched, invoiced or settled', async () => {
    const b = await books('NeverMatched');
    const order = await issuedOrder(b);
    await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '2' }]);

    const listed = (await call('GET', '/api/purchasing/receipts?awaitingInvoice=true', b.user)).json();
    expect(listed.matchingSupported).toBe(false);
    expect(listed.receipts).toHaveLength(1);
    expect(listed.receipts[0].matched).toBe(false);
  });
});

/* ══ Reporting ═════════════════════════════════════════════════════════════ */

describe('purchase order and GRNI reporting', () => {
  it('lists open orders and their remaining quantities', async () => {
    const b = await books('OpenBook');
    const order = await issuedOrder(b, [
      orderLine(b, { quantity: '10', unitPrice: '5.000' }),
      orderLine(b, { itemId: b.itemB, quantity: '4', unitPrice: '2.000' }),
    ]);
    await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '4' }]);

    const open = (await call('GET', '/api/purchasing/orders/open-lines', b.user)).json().lines;
    expect(open).toHaveLength(2);
    const first = open.find((l: { itemCode: string }) => l.itemCode === 'SKU-1');
    expect(Number(first.receivedQuantity)).toBe(4);
    expect(Number(first.remainingQuantity)).toBe(6);
    expect(Number(first.remainingValue)).toBe(30);

    const openOnly = (await call('GET', '/api/purchasing/orders?open=true', b.user)).json().orders;
    expect(openOnly).toHaveLength(1);
    expect(openOnly[0].status).toBe('partially_received');
  });

  it('drops a line from the open book once it is fully received', async () => {
    const b = await books('OpenClosed');
    const order = await issuedOrder(b, [orderLine(b, { quantity: '3' })]);
    await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '3' }]);
    const open = (await call('GET', '/api/purchasing/orders/open-lines', b.user)).json().lines;
    expect(open).toHaveLength(0);
  });

  it('reconciles the GRNI schedule exactly to the general ledger', async () => {
    const b = await books('Grni');
    const order = await issuedOrder(b, [
      orderLine(b, { quantity: '10', unitPrice: '5.000' }),
      orderLine(b, { itemId: b.itemB, warehouseId: b.spare, quantity: '4', unitPrice: '2.000' }),
    ]);
    await receive(b, order.id, [
      { orderLineId: order.lineIds[0]!, quantity: '6' },
      { orderLineId: order.lineIds[1]!, quantity: '4' },
    ]);

    const schedule = (await call('GET', '/api/purchasing/grni', b.user)).json();
    expect(schedule.rows).toHaveLength(2);
    expect(Number(schedule.total)).toBe(38);
    expect(Number(schedule.generalLedgerBalance)).toBe(38);
    expect(Number(schedule.difference)).toBe(0);
    expect(schedule.balanced).toBe(true);
    expect(schedule.matchingImplemented).toBe(false);
    expect(schedule.rows.every((r: { matched: boolean }) => r.matched === false)).toBe(true);
    expect(schedule.rows[0].supplierName).toBe('Acme Supplies');
    expect(schedule.rows[0].orderNumber).toBe(order.number);
  });

  it('includes an order-less warehouse receipt, so the schedule still equals the account', async () => {
    const b = await books('GrniMixed');
    const order = await issuedOrder(b, [orderLine(b, { quantity: '2', unitPrice: '5.000' })]);
    await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '2' }]);

    const standalone = await call('POST', '/api/inventory/documents', b.user, {
      kind: 'receipt', movementDate: '2026-03-06', idempotencyKey: key(),
      lines: [{ itemId: b.itemB, warehouseId: b.main, quantity: '3', unitCost: '4.000' }],
    });
    expect(standalone.statusCode, standalone.body).toBe(201);

    const schedule = (await call('GET', '/api/purchasing/grni', b.user)).json();
    expect(Number(schedule.total)).toBe(22);
    expect(Number(schedule.generalLedgerBalance)).toBe(22);
    expect(schedule.balanced).toBe(true);

    const orderless = schedule.rows.find((r: { receiptId: string | null }) => r.receiptId === null);
    expect(orderless.documentKind).toBe('receipt');
    expect(orderless.supplierId).toBeNull();
  });

  it('removes a reversed receipt from the schedule and from the ledger together', async () => {
    const b = await books('GrniReversed');
    const order = await issuedOrder(b);
    const posted = await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '4' }]);
    const receipt = posted.json().receipt;
    await call('POST', `/api/purchasing/receipts/${receipt.id}/reverse`, b.user, {
      expectedVersion: receipt.version, reason: 'Withdrawn after inspection',
    });

    const schedule = (await call('GET', '/api/purchasing/grni', b.user)).json();
    expect(schedule.rows).toHaveLength(0);
    expect(Number(schedule.total)).toBe(0);
    expect(Number(schedule.generalLedgerBalance)).toBe(0);
    expect(schedule.balanced).toBe(true);
  });

  it('keeps historical reporting after a supplier, item or warehouse is archived', async () => {
    const b = await books('ArchivedMasters');
    const order = await issuedOrder(b);
    await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '2' }]);

    const supplier = (await call('GET', `/api/vendors/${b.supplier}`, b.user)).json().supplier;
    await call('POST', `/api/vendors/${b.supplier}/archive`, b.user, {
      expectedVersion: supplier.version, archived: true,
    });
    const item = (await call('GET', `/api/inventory/items/${b.item}`, b.user)).json().item;
    await call('POST', `/api/inventory/items/${b.item}/archive`, b.user, {
      expectedVersion: item.version, archived: true,
    });

    const schedule = (await call('GET', '/api/purchasing/grni', b.user)).json();
    expect(schedule.rows).toHaveLength(1);
    expect(schedule.rows[0].supplierName).toBe('Acme Supplies');
    expect(schedule.rows[0].itemCode).toBe('SKU-1');
    expect(Number(schedule.total)).toBe(10);
  });
});

/* ══ Currency precision ════════════════════════════════════════════════════ */

describe('monetary precision', () => {
  it('keeps three decimal places in JOD', async () => {
    const b = await books('JodPrecision');
    const order = await issuedOrder(b, [orderLine(b, { quantity: '3', unitPrice: '1.333' })]);
    await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '3' }]);
    expect(await stockValue(b)).toBe(3.999);
    expect(await glBalance(b, b.grni)).toBe(-3.999);
  });

  it('keeps two decimal places in USD', async () => {
    const b = await books('UsdPrecision', { currency: 'USD', country: 'US' });
    const order = await issuedOrder(b, [orderLine(b, { quantity: '3', unitPrice: '1.33' })]);
    await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '3' }]);
    expect(await stockValue(b)).toBe(3.99);
    expect(await glBalance(b, b.grni)).toBe(-3.99);
  });

  it('rounds to whole units in a zero-decimal currency', async () => {
    const b = await books('JpyPrecision', { currency: 'JPY', country: 'JP' });
    const order = await issuedOrder(b, [orderLine(b, { quantity: '3', unitPrice: '100' })]);
    await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '3' }]);
    expect(await stockValue(b)).toBe(300);
    expect(await glBalance(b, b.grni)).toBe(-300);
    /* A fractional price the currency cannot express is refused, not rounded. */
    const fractional = await draftOrder(b, [orderLine(b, { unitPrice: '10.5' })]);
    expect(fractional.statusCode, fractional.body).toBe(400);
  });
});

/* ══ Permissions, entitlements and isolation ═══════════════════════════════ */

describe('who may do what', () => {
  it('lets a Standard User author an order but not approve, issue or receive', async () => {
    const b = await books('Member', { role: 'member' });
    const created = await draftOrder(b, [orderLine(b)]);
    expect(created.statusCode, created.body).toBe(201);

    const approved = await call('POST', `/api/purchasing/orders/${created.json().order.id}/approve`,
      b.user, { expectedVersion: created.json().order.version });
    expect(approved.statusCode).toBe(403);

    const received = await call('POST', '/api/purchasing/receipts', b.user, {
      orderId: created.json().order.id, receiptDate: '2026-03-05', idempotencyKey: key(),
      lines: [{ orderLineId: created.json().order.lines[0].id, quantity: '1' }],
    });
    expect(received.statusCode).toBe(403);
  });

  it('lets an Accountant post and reverse a receipt but not approve an order', async () => {
    const adminBooks = await books('AccountantSetup');
    const order = await issuedOrder(adminBooks);

    /* A second person in the SAME organization, as an accountant. */
    const invited = await ctx.app.inject({
      method: 'POST', url: '/api/admin/users', headers: authHeaders(admin),
      payload: {
        fullName: 'Book Keeper', email: 'keeper@ap.test', organizationId: adminBooks.org,
        role: 'accountant', onboarding: 'invitation',
      },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    await ctx.app.inject({
      method: 'POST', url: '/api/auth/reset-password',
      payload: { token: invited.json().credential.invitationToken, newPassword: password },
    });
    const keeper = await login(ctx, 'keeper@ap.test', password);

    const received = await ctx.app.inject({
      method: 'POST', url: '/api/purchasing/receipts', headers: authHeaders(keeper),
      payload: {
        orderId: order.id, receiptDate: '2026-03-05', idempotencyKey: key(),
        lines: [{ orderLineId: order.lineIds[0]!, quantity: '1' }],
      },
    });
    expect(received.statusCode, received.body).toBe(201);

    const second = await draftOrder(adminBooks, [orderLine(adminBooks)]);
    const approve = await ctx.app.inject({
      method: 'POST', url: `/api/purchasing/orders/${second.json().order.id}/approve`,
      headers: authHeaders(keeper), payload: { expectedVersion: second.json().order.version },
    });
    expect(approve.statusCode).toBe(403);
  });

  /*
   * The gate is `inventory_advanced`, and the test has to prove it is that and
   * not `inventory_basic` — otherwise a tenant who merely keeps stock would be
   * assumed to have bought receipt-first purchasing.
   *
   * No PUBLIC package sells one without the other (Manufacturing and Enterprise
   * carry both; the rest carry neither), so the entitlement row is narrowed
   * directly. That is the only way to reach the boundary this rule is about.
   */
  it('refuses a tenant without the advanced-inventory entitlement', async () => {
    const b = await books('ProTier', { plan: 'manufacturing' });

    await sql`
      UPDATE organization_entitlements
         SET modules = (
           SELECT COALESCE(jsonb_agg(m), '[]'::jsonb)
             FROM jsonb_array_elements(modules::jsonb) AS m
            WHERE m <> '"inventory_advanced"'::jsonb
         )::text::jsonb
       WHERE organization_id = ${b.org}
    `.execute(ctx.db);

    const orders = await call('GET', '/api/purchasing/orders', b.user);
    expect(orders.statusCode, orders.body).toBe(403);

    const receipts = await call('GET', '/api/purchasing/receipts', b.user);
    expect(receipts.statusCode, receipts.body).toBe(403);

    const grni = await call('GET', '/api/purchasing/grni', b.user);
    expect(grni.statusCode, grni.body).toBe(403);

    /* And ordinary stock still works, so the gate is on AP1 and not on stock. */
    const stock = await call('GET', '/api/inventory/stock-on-hand', b.user);
    expect(stock.statusCode, stock.body).toBe(200);
  });

  it('never shows one company an order belonging to another', async () => {
    const b = await books('IsolationA');
    const other = await books('IsolationB');
    const order = await issuedOrder(other, [orderLine(other)]);

    const seen = await call('GET', `/api/purchasing/orders/${order.id}`, b.user);
    expect(seen.statusCode).toBe(404);

    const listed = (await call('GET', '/api/purchasing/orders', b.user)).json().orders;
    expect(listed).toHaveLength(0);
  });
});

/* ══ Migration ═════════════════════════════════════════════════════════════ */

describe('migration 042', () => {
  it('rolls back and reapplies when nothing has been ordered', async () => {
    const migrator = createMigrator(ctx.db);
    const down = await migrator.migrateDown();
    expect(down.error).toBeUndefined();
    expect(down.results?.[0]?.migrationName).toBe('042_purchase_orders');

    const up = await migrator.migrateToLatest();
    expect(up.error).toBeUndefined();

    const { rows } = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM information_schema.tables
       WHERE table_name IN ('purchase_orders','purchase_order_lines','goods_receipts',
                            'goods_receipt_lines','purchasing_document_numbering',
                            'purchasing_audit_events')
    `.execute(ctx.db);
    expect(rows[0]!.n).toBe(6);
  });

  it('REFUSES to roll back over a real commitment', async () => {
    const b = await books('RollbackOrders');
    const order = await issuedOrder(b);
    await receive(b, order.id, [{ orderLineId: order.lineIds[0]!, quantity: '2' }]);

    const down = await createMigrator(ctx.db).migrateDown();
    expect(down.error).toBeDefined();
    expect(String((down.error as Error).message)).toMatch(/Refusing to roll back 042/);

    /* And nothing was destroyed. */
    expect(await onHand(b)).toBe(2);
    expect(await countRows('purchase_orders', b.org)).toBe(1);
  });
});

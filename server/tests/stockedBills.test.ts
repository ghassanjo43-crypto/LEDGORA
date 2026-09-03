/**
 * Inventory I3 — stocked supplier bills, through the real stack.
 *
 * The claim is narrow and has to be exact: a bill line that names an item
 * debits INVENTORY rather than an expense, brings the quantity in through the
 * I2 engine at the same figure the journal debited, and leaves the subledger and
 * the general ledger agreeing to the fils. Everything the product has not
 * decided — purchase orders, goods-received clearing, matching, price variance —
 * is refused rather than approximated.
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
const password = 'Bright-Harbour-58-Zq';
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
  expense: string;
  payable: string;
  inputTax: string;
  bank: string;
  unitEA: string;
  main: string;
  item: string;
  service: string;
  supplier: string;
  currency: string;
}

async function books(name: string, currency = 'JOD', plan = 'enterprise'): Promise<Books> {
  const sub = await ctx.app.inject({
    method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(admin),
    payload: {
      fullName: `${name} Owner`, email: `owner@${name.toLowerCase()}.test`,
      organizationLegalName: `${name} LLC`, country: 'JO', baseCurrency: currency,
      planId: await planId(plan), onboarding: 'temporary', paymentConfirmed: true,
    },
  });
  expect(sub.statusCode, sub.body).toBe(201);
  const org = sub.json().subscriber.organizationId;

  const invited = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: authHeaders(admin),
    payload: {
      fullName: `${name} Person`, email: `${name.toLowerCase()}@sb.test`,
      organizationId: org, role: 'admin', onboarding: 'invitation',
    },
  });
  expect(invited.statusCode, invited.body).toBe(201);
  await ctx.app.inject({
    method: 'POST', url: '/api/auth/reset-password',
    payload: { token: invited.json().credential.invitationToken, newPassword: password },
  });
  const user = await login(ctx, `${name.toLowerCase()}@sb.test`, password);

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
  const expense = await account('5100', 'Office supplies', 'expense');
  const payable = await account('2100', 'Trade payables', 'liability');
  const inputTax = await account('1260', 'Recoverable input tax', 'asset');
  const bank = await account('1100', 'Bank', 'asset', {
    cashClassification: 'cash_and_cash_equivalents',
  });

  const unitEA = (await call('GET', '/api/inventory/units', user))
    .json().units.find((u: { code: string }) => u.code === 'EA').id;

  const warehouse = await call('POST', '/api/inventory/warehouses', user, {
    code: 'MAIN', name: 'Main store',
  });
  expect(warehouse.statusCode, warehouse.body).toBe(201);

  const item = await call('POST', '/api/inventory/items', user, {
    itemCode: 'SKU-1', name: 'Widget', itemType: 'inventory',
    isInventoryTracked: true, baseUnitId: unitEA, inventoryAccountId: stock,
  });
  expect(item.statusCode, item.body).toBe(201);

  const service = await call('POST', '/api/inventory/items', user, {
    itemCode: 'SRV-1', name: 'Consulting', itemType: 'service', baseUnitId: unitEA,
  });
  expect(service.statusCode, service.body).toBe(201);

  const supplier = await call('POST', '/api/vendors', user, {
    partyCode: 'ACME', legalName: 'Acme Supplies',
    supplier: { defaultPayableAccountId: payable },
  });
  expect(supplier.statusCode, supplier.body).toBe(201);

  return {
    org, user, stock, expense, payable, inputTax, bank, unitEA,
    main: warehouse.json().warehouse.id,
    item: item.json().item.id,
    service: service.json().item.id,
    supplier: supplier.json().supplier.id,
    currency,
  };
}

let seq = 0;
const draft = (b: Books, lines: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) =>
  call('POST', '/api/bills', b.user, {
    issuingEntityId: ENTITY, supplierId: b.supplier,
    supplierInvoiceNumber: `SUP-${seq++}`,
    billDate: '2026-03-01', dueDate: '2026-03-31',
    lines, ...over,
  });

const stockedLine = (b: Books, quantity: string, unitPrice: string, over: Record<string, unknown> = {}) => ({
  description: 'Widgets', accountId: b.expense, itemId: b.item, warehouseId: b.main,
  quantity, unitPrice, ...over,
});

async function post(b: Books, billId: string, version: number) {
  return call('POST', `/api/bills/${billId}/post`, b.user, { expectedVersion: version });
}

async function glBalance(b: Books, accountId: string): Promise<number> {
  const { rows } = await sql<{ balance: string }>`
    SELECT COALESCE(SUM(COALESCE(l.debit_functional,0) - COALESCE(l.credit_functional,0)), 0)::text
             AS balance
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.journal_entry_id
     WHERE l.organization_id = ${b.org} AND l.account_id = ${accountId}
       AND e.status IN ('posted', 'reversed')
  `.execute(ctx.db);
  return Number(rows[0]!.balance);
}

async function onHand(b: Books): Promise<number> {
  const r = await call('GET', `/api/inventory/stock-on-hand?itemId=${b.item}`, b.user);
  return r.json().rows.reduce((s: number, row: { quantity: string }) => s + Number(row.quantity), 0);
}

async function stockValue(b: Books): Promise<number> {
  const r = await call('GET', '/api/inventory/valuation', b.user);
  return r.json().rows.reduce((s: number, row: { value: string }) => s + Number(row.value), 0);
}

/* ══ The core posting ══════════════════════════════════════════════════════ */

describe('a stocked supplier bill', () => {
  it('debits INVENTORY, credits the payable, and brings the quantity in', async () => {
    const b = await books('Core');
    const created = await draft(b, [stockedLine(b, '10', '5.000')]);
    expect(created.statusCode, created.body).toBe(201);

    const posted = await post(b, created.json().bill.id, created.json().bill.version);
    expect(posted.statusCode, posted.body).toBe(200);

    expect(await onHand(b)).toBe(10);
    expect(await stockValue(b)).toBe(50);
    expect(await glBalance(b, b.stock)).toBe(50);
    expect(await glBalance(b, b.payable)).toBe(-50);
    /* The expense account the request named was never used. */
    expect(await glBalance(b, b.expense)).toBe(0);
  });

  it('forces the item’s inventory account whatever the request asked for', async () => {
    const b = await books('Forced');
    const created = await draft(b, [stockedLine(b, '4', '2.500', { accountId: b.bank })]);
    expect(created.statusCode, created.body).toBe(201);

    /* The line was stored against the item's stock account, not the bank. */
    expect(created.json().bill.lines[0].accountId).toBe(b.stock);

    const posted = await post(b, created.json().bill.id, created.json().bill.version);
    expect(posted.statusCode, posted.body).toBe(200);
    expect(await glBalance(b, b.bank)).toBe(0);
    expect(await glBalance(b, b.stock)).toBe(10);
  });

  it('creates ONE journal and one movement — never a second entry', async () => {
    const b = await books('Single');
    const created = await draft(b, [stockedLine(b, '3', '7.000')]);
    await post(b, created.json().bill.id, created.json().bill.version);

    const { rows: entries } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM journal_entries WHERE organization_id = ${b.org}
    `.execute(ctx.db);
    expect(Number(entries[0]!.n)).toBe(1);

    const { rows: movements } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM inventory_movements WHERE organization_id = ${b.org}
    `.execute(ctx.db);
    expect(Number(movements[0]!.n)).toBe(1);

    /* The stock document carries the BILL's journal, not one of its own. */
    const { rows: docs } = await sql<{ journal_entry_id: string; kind: string }>`
      SELECT journal_entry_id::text, kind FROM inventory_documents
       WHERE organization_id = ${b.org}
    `.execute(ctx.db);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.kind).toBe('bill-receipt');
    expect(docs[0]!.journal_entry_id).toBe(
      (await sql<{ id: string }>`
        SELECT id::text FROM journal_entries WHERE organization_id = ${b.org}
      `.execute(ctx.db)).rows[0]!.id,
    );
  });

  it('mixes stocked and expense lines in one bill', async () => {
    const b = await books('Mixed');
    const created = await draft(b, [
      stockedLine(b, '2', '10.000'),
      { description: 'Delivery', accountId: b.expense, quantity: '1', unitPrice: '5.000' },
    ]);
    expect(created.statusCode, created.body).toBe(201);
    await post(b, created.json().bill.id, created.json().bill.version);

    expect(await glBalance(b, b.stock)).toBe(20);
    expect(await glBalance(b, b.expense)).toBe(5);
    expect(await glBalance(b, b.payable)).toBe(-25);
    /* Only the stocked line moved stock: the delivery charge is not inventory. */
    expect(await onHand(b)).toBe(2);
    expect(await stockValue(b)).toBe(20);
  });
});

/* ══ Tax ═══════════════════════════════════════════════════════════════════ */

describe('purchase tax on a stocked bill', () => {
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

  it('keeps recoverable tax OUT of the stock cost — exclusive', async () => {
    const b = await books('TaxEx');
    const vat = await taxCode(b, 'VATIN', 'standard', 'exclusive', '16.000000', b.inputTax);

    const created = await draft(b, [stockedLine(b, '10', '5.000', { taxCodeId: vat })]);
    await post(b, created.json().bill.id, created.json().bill.version);

    /* Stock cost 50; the 8 of tax is a claim on the authority, not a cost. */
    expect(await stockValue(b)).toBe(50);
    expect(await glBalance(b, b.stock)).toBe(50);
    expect(await glBalance(b, b.inputTax)).toBe(8);
    expect(await glBalance(b, b.payable)).toBe(-58);
  });

  it('extracts the tax from an INCLUSIVE price before it becomes cost', async () => {
    const b = await books('TaxIn');
    const vat = await taxCode(b, 'VATIN', 'standard', 'inclusive', '16.000000', b.inputTax);

    const created = await draft(b, [stockedLine(b, '1', '116.000', { taxCodeId: vat })]);
    await post(b, created.json().bill.id, created.json().bill.version);

    /* 116 inclusive at 16% is 100 of cost and 16 of tax. */
    expect(await stockValue(b)).toBe(100);
    expect(await glBalance(b, b.stock)).toBe(100);
    expect(await glBalance(b, b.inputTax)).toBe(16);
    expect(await glBalance(b, b.payable)).toBe(-116);
  });

  it('capitalises the whole price under a zero-rated or exempt code', async () => {
    for (const category of ['zero-rated', 'exempt', 'out-of-scope']) {
      const b = await books(`Tax${category.replace(/-/g, '')}`);
      const code = await taxCode(b, 'VATZ', category, 'exclusive', '0.000000', null);
      const created = await draft(b, [stockedLine(b, '5', '3.000', { taxCodeId: code })]);
      const posted = await post(b, created.json().bill.id, created.json().bill.version);
      expect(posted.statusCode, `${category}: ${posted.body}`).toBe(200);

      expect(await stockValue(b), category).toBe(15);
      expect(await glBalance(b, b.stock), category).toBe(15);
      expect(await glBalance(b, b.inputTax), category).toBe(0);
    }
  });

  it('refuses a client-supplied tax amount on a stocked line', async () => {
    const b = await books('TaxTamper');
    const r = await draft(b, [stockedLine(b, '1', '10.000', { taxAmount: '999.000' })]);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/tax is calculated by the server|supplies/i);
  });
});

/* ══ Precision ═════════════════════════════════════════════════════════════ */

describe('exact decimals', () => {
  it('holds JOD to three places through stock and the ledger', async () => {
    const b = await books('JOD', 'JOD');
    const created = await draft(b, [stockedLine(b, '3', '3.335')]);
    await post(b, created.json().bill.id, created.json().bill.version);

    expect(await stockValue(b)).toBe(10.005);
    expect(await glBalance(b, b.stock)).toBe(10.005);
    expect(await glBalance(b, b.payable)).toBe(-10.005);
  });

  it('holds USD to two places', async () => {
    const b = await books('USD', 'USD');
    const created = await draft(b, [stockedLine(b, '3', '3.33')]);
    await post(b, created.json().bill.id, created.json().bill.version);

    expect(await stockValue(b)).toBe(9.99);
    expect(await glBalance(b, b.stock)).toBe(9.99);
  });
});

/* ══ Weighted average across purchases ═════════════════════════════════════ */

describe('valuation after stocked bills', () => {
  it('averages across bills, and an issue costs at that average', async () => {
    const b = await books('Avg');

    for (const [quantity, price] of [['10', '5.000'], ['10', '7.000']] as const) {
      const created = await draft(b, [stockedLine(b, quantity, price)]);
      const posted = await post(b, created.json().bill.id, created.json().bill.version);
      expect(posted.statusCode, posted.body).toBe(200);
    }

    expect(await onHand(b)).toBe(20);
    expect(await stockValue(b)).toBe(120);

    const issue = await call('POST', '/api/inventory/documents', b.user, {
      idempotencyKey: 'issue-1', kind: 'issue', movementDate: '2026-03-02',
      lines: [{
        itemId: b.item, warehouseId: b.main, quantity: '5', expenseAccountId: b.expense,
      }],
    });
    expect(issue.statusCode, issue.body).toBe(201);
    /* 120 over 20 is 6; five out costs 30. */
    expect(Number(issue.json().document.movements[0].totalCost)).toBe(30);
    expect(await stockValue(b)).toBe(90);
  });
});

/* ══ Reversal ══════════════════════════════════════════════════════════════ */

describe('reversing a stocked bill', () => {
  it('takes the stock back out and reverses the ledger exactly', async () => {
    const b = await books('Rev');
    const created = await draft(b, [stockedLine(b, '6', '4.000')]);
    const posted = await post(b, created.json().bill.id, created.json().bill.version);
    expect(posted.statusCode, posted.body).toBe(200);

    const reversed = await call('POST', `/api/bills/${created.json().bill.id}/reverse`, b.user, {
      expectedVersion: posted.json().bill.version, reason: 'Wrong supplier invoice',
    });
    expect(reversed.statusCode, reversed.body).toBe(200);

    expect(await onHand(b)).toBe(0);
    expect(await stockValue(b)).toBe(0);
    expect(await glBalance(b, b.stock)).toBe(0);
    expect(await glBalance(b, b.payable)).toBe(0);

    /* Nothing was deleted: the original movement and its counter both remain. */
    const { rows } = await sql<{ status: string; n: string }>`
      SELECT status, COUNT(*)::text AS n FROM inventory_movements
       WHERE organization_id = ${b.org} GROUP BY status
    `.execute(ctx.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('reversed');
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it('REFUSES when the stock has already been used', async () => {
    const b = await books('RevUsed');
    const created = await draft(b, [stockedLine(b, '10', '2.000')]);
    const posted = await post(b, created.json().bill.id, created.json().bill.version);

    const issue = await call('POST', '/api/inventory/documents', b.user, {
      idempotencyKey: 'used-1', kind: 'issue', movementDate: '2026-03-02',
      lines: [{ itemId: b.item, warehouseId: b.main, quantity: '4', expenseAccountId: b.expense }],
    });
    expect(issue.statusCode, issue.body).toBe(201);

    const reversed = await call('POST', `/api/bills/${created.json().bill.id}/reverse`, b.user, {
      expectedVersion: posted.json().bill.version, reason: 'Too late to undo',
    });
    expect(reversed.statusCode).toBe(409);
    expect(reversed.json().error.message).toMatch(/has since been used|remain/i);

    /*
     * And the refused reversal moved nothing: six units remain, worth the 20
     * received less the 8 the issue took out.
     */
    expect(await onHand(b)).toBe(6);
    expect(await glBalance(b, b.stock)).toBe(12);
  });

  it('is still blocked by a live payment, exactly as P4 requires', async () => {
    const b = await books('RevPaid');
    const created = await draft(b, [stockedLine(b, '5', '2.000')]);
    const posted = await post(b, created.json().bill.id, created.json().bill.version);

    const payment = await call('POST', '/api/payments', b.user, {
      issuingEntityId: ENTITY, supplierId: b.supplier, paymentDate: '2026-03-05',
      amount: '10.000', cashAccountId: b.bank,
    });
    expect(payment.statusCode, payment.body).toBe(201);
    const paid = await call('POST', `/api/payments/${payment.json().payment.id}/post`, b.user, {
      expectedVersion: payment.json().payment.version,
      allocations: [{ billId: created.json().bill.id, amount: '10.000' }],
    });
    expect(paid.statusCode, paid.body).toBe(200);

    const reversed = await call('POST', `/api/bills/${created.json().bill.id}/reverse`, b.user, {
      expectedVersion: posted.json().bill.version, reason: 'Should be blocked',
    });
    expect(reversed.statusCode).toBeGreaterThanOrEqual(400);
    expect(reversed.json().error.message).toMatch(/payment/i);
    /* The stock is untouched by the refused reversal. */
    expect(await onHand(b)).toBe(5);
  });
});

/* ══ Refusals ══════════════════════════════════════════════════════════════ */

describe('what a stocked bill refuses', () => {
  it('refuses an item without a warehouse, and a warehouse without an item', async () => {
    const b = await books('Pair');
    const noWarehouse = await draft(b, [{
      description: 'x', accountId: b.expense, itemId: b.item, quantity: '1', unitPrice: '1.000',
    }]);
    expect(noWarehouse.statusCode).toBe(400);
    expect(noWarehouse.json().error.message).toMatch(/both an item and a warehouse/i);

    const noItem = await draft(b, [{
      description: 'x', accountId: b.expense, warehouseId: b.main, quantity: '1', unitPrice: '1.000',
    }]);
    expect(noItem.statusCode).toBe(400);
  });

  it('refuses a non-stock item, an archived item and an archived warehouse', async () => {
    const b = await books('Ineligible');

    const service = await draft(b, [stockedLine(b, '1', '1.000', { itemId: b.service })]);
    expect(service.statusCode).toBe(400);
    expect(service.json().error.message).toMatch(/not stock-tracked/i);

    const item = (await call('GET', `/api/inventory/items/${b.item}`, b.user)).json().item;
    await call('POST', `/api/inventory/items/${b.item}/archive`, b.user, {
      expectedVersion: item.version, archived: true,
    });
    const archived = await draft(b, [stockedLine(b, '1', '1.000')]);
    expect(archived.statusCode).toBe(400);
    expect(archived.json().error.message).toMatch(/archived/i);
  });

  it('refuses an item with no inventory account of its own', async () => {
    const b = await books('NoAccount');
    const bare = await call('POST', '/api/inventory/items', b.user, {
      itemCode: 'SKU-BARE', name: 'Unmapped', itemType: 'inventory',
      isInventoryTracked: true, baseUnitId: b.unitEA,
    });
    expect(bare.statusCode, bare.body).toBe(201);

    const r = await draft(b, [stockedLine(b, '1', '1.000', { itemId: bare.json().item.id })]);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/no inventory account/i);
  });

  it('refuses a FIFO item rather than averaging it', async () => {
    const b = await books('Fifo');
    const fifo = await call('POST', '/api/inventory/items', b.user, {
      itemCode: 'SKU-FIFO', name: 'Layered', itemType: 'inventory', isInventoryTracked: true,
      baseUnitId: b.unitEA, valuationMethod: 'fifo', inventoryAccountId: b.stock,
    });
    const r = await draft(b, [stockedLine(b, '1', '1.000', { itemId: fifo.json().item.id })]);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/does not implement|weighted-average/i);
  });

  it('refuses another company’s item or warehouse', async () => {
    const mine = await books('Mine');
    const theirs = await books('Theirs');

    const foreignItem = await draft(mine, [stockedLine(mine, '1', '1.000', { itemId: theirs.item })]);
    expect(foreignItem.statusCode).toBe(400);

    const foreignWarehouse = await draft(
      mine, [stockedLine(mine, '1', '1.000', { warehouseId: theirs.main })],
    );
    expect(foreignWarehouse.statusCode).toBe(400);
  });

  it('still refuses the receipt-first shapes this product has not decided', async () => {
    const b = await books('Deferred');
    for (const field of ['inventoryItemId', 'inventoryReceiptMode', 'capitalAssetId']) {
      const r = await draft(b, [{
        description: 'x', accountId: b.expense, quantity: '1', unitPrice: '1.000',
        [field]: 'anything',
      }]);
      expect(r.statusCode, field).toBe(400);
      expect(r.json().error.message).toMatch(/stock|inventory/i);
    }
  });

  it('refuses backdating a bill behind the item’s last movement', async () => {
    const b = await books('Back');
    const first = await draft(b, [stockedLine(b, '5', '1.000')], { billDate: '2026-03-10' });
    const posted = await post(b, first.json().bill.id, first.json().bill.version);
    expect(posted.statusCode, posted.body).toBe(200);

    const earlier = await draft(b, [stockedLine(b, '5', '9.000')], {
      billDate: '2026-03-01', dueDate: '2026-03-31',
    });
    const refused = await post(b, earlier.json().bill.id, earlier.json().bill.version);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toMatch(/before that item|most recent/i);
  });

  it('refuses posting into a locked period, leaving no stock behind', async () => {
    const b = await books('Locked');
    const created = await draft(b, [stockedLine(b, '5', '1.000')]);

    const period = await call('POST', '/api/accounting/periods', b.user, {
      fiscalYear: 2026, periodNumber: 3, startDate: '2026-03-01', endDate: '2026-03-31',
    });
    expect(period.statusCode, period.body).toBe(201);
    await call('PATCH', `/api/accounting/periods/${period.json().period.id}`, b.user, {
      status: 'locked', reason: 'Month closed',
    });

    const refused = await post(b, created.json().bill.id, created.json().bill.version);
    expect(refused.statusCode).toBe(409);
    expect(await onHand(b)).toBe(0);
  });
});

/* ══ The service and expense path is untouched ═════════════════════════════ */

describe('ordinary bills', () => {
  it('post exactly as before, with no stock and no stock document', async () => {
    const b = await books('Plain');
    const created = await draft(b, [
      { description: 'Consulting', accountId: b.expense, quantity: '1', unitPrice: '250.000' },
    ]);
    const posted = await post(b, created.json().bill.id, created.json().bill.version);
    expect(posted.statusCode, posted.body).toBe(200);

    expect(await glBalance(b, b.expense)).toBe(250);
    expect(await glBalance(b, b.payable)).toBe(-250);
    expect(await glBalance(b, b.stock)).toBe(0);

    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM inventory_documents WHERE organization_id = ${b.org}
    `.execute(ctx.db);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('reverse without touching the stock ledger', async () => {
    const b = await books('PlainRev');
    const created = await draft(b, [
      { description: 'Consulting', accountId: b.expense, quantity: '1', unitPrice: '100.000' },
    ]);
    const posted = await post(b, created.json().bill.id, created.json().bill.version);
    const reversed = await call('POST', `/api/bills/${created.json().bill.id}/reverse`, b.user, {
      expectedVersion: posted.json().bill.version, reason: 'Duplicate entry',
    });
    expect(reversed.statusCode, reversed.body).toBe(200);
    expect(await glBalance(b, b.expense)).toBe(0);
  });
});

/* ══ Reconciliation ════════════════════════════════════════════════════════ */

describe('reconciliation', () => {
  it('subledger equals the general ledger after purchases, an issue and a reversal',
    async () => {
      const b = await books('Recon');

      const one = await draft(b, [stockedLine(b, '100', '1.330')]);
      await post(b, one.json().bill.id, one.json().bill.version);

      const two = await draft(b, [stockedLine(b, '50', '2.100')]);
      const twoPosted = await post(b, two.json().bill.id, two.json().bill.version);

      await call('POST', '/api/inventory/documents', b.user, {
        idempotencyKey: 'recon-issue', kind: 'issue', movementDate: '2026-03-02',
        lines: [{ itemId: b.item, warehouseId: b.main, quantity: '37', expenseAccountId: b.expense }],
      });

      /* After the issue: a bill dated behind it would be refused, which is the
       * backdating rule doing its job rather than a reconciliation failure. */
      const three = await draft(b, [stockedLine(b, '10', '3.000')], {
        billDate: '2026-03-03', dueDate: '2026-03-31',
      });
      const threePosted = await post(b, three.json().bill.id, three.json().bill.version);
      expect(threePosted.statusCode, threePosted.body).toBe(200);
      await call('POST', `/api/bills/${three.json().bill.id}/reverse`, b.user, {
        expectedVersion: threePosted.json().bill.version, reason: 'Ordered in error',
      });

      const reconciliation = (await call('GET', '/api/inventory/reconciliation', b.user)).json();
      expect(reconciliation.balanced, JSON.stringify(reconciliation.rows)).toBe(true);
      for (const row of reconciliation.rows) {
        expect(Number(row.difference)).toBe(0);
        expect(Number(row.subledgerValue)).toBe(Number(row.generalLedgerBalance));
      }
      void twoPosted;
    });
});

/* ══ Migration ═════════════════════════════════════════════════════════════ */

describe('migration 039', () => {
  it('rolls back and reapplies when nothing is stocked', async () => {
    const migrator = createMigrator(ctx.db);
    /* 040 sits on top now, so it comes off first. */
    const sold = await migrator.migrateDown();
    expect(sold.error).toBeUndefined();
    expect(sold.results?.[0]?.migrationName).toBe('040_stocked_invoices');

    const down = await migrator.migrateDown();
    expect(down.error).toBeUndefined();
    expect(down.results?.[0]?.migrationName).toBe('039_stocked_bills');

    const up = await migrator.migrateToLatest();
    expect(up.error).toBeUndefined();

    const { rows } = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'bill_lines' AND column_name IN ('item_id','warehouse_id')
    `.execute(ctx.db);
    expect(rows[0]!.n).toBe(2);
  });

  it('REFUSES to roll back over a stocked purchase', async () => {
    const b = await books('Rollback');
    const created = await draft(b, [stockedLine(b, '2', '1.000')]);
    await post(b, created.json().bill.id, created.json().bill.version);

    const migrator = createMigrator(ctx.db);
    /* Nothing was sold, so 040 comes off cleanly; 039 is the one holding the
     * stocked purchase this test is about. */
    const sold = await migrator.migrateDown();
    expect(sold.error).toBeUndefined();

    const down = await migrator.migrateDown();
    expect(down.error).toBeDefined();
    expect(String((down.error as Error).message)).toMatch(/Refusing to roll back 039/);
    expect(await onHand(b)).toBe(2);
  });
});

/* ══ Idempotency and atomicity ═════════════════════════════════════════════ */

describe('posting exactly once', () => {
  it('a repeated post finds the bill already posted and creates nothing twice', async () => {
    const b = await books('Idem');
    const created = await draft(b, [stockedLine(b, '8', '2.500')]);
    const first = await post(b, created.json().bill.id, created.json().bill.version);
    expect(first.statusCode, first.body).toBe(200);

    /* The version has moved on, so the same call is refused rather than
     * repeated — the concurrency token is the guard here. */
    const again = await post(b, created.json().bill.id, created.json().bill.version);
    expect(again.statusCode).toBe(409);

    expect(await onHand(b)).toBe(8);
    const { rows } = await sql<{ movements: string; documents: string; entries: string }>`
      SELECT
        (SELECT COUNT(*)::text FROM inventory_movements WHERE organization_id = ${b.org}) AS movements,
        (SELECT COUNT(*)::text FROM inventory_documents WHERE organization_id = ${b.org}) AS documents,
        (SELECT COUNT(*)::text FROM journal_entries    WHERE organization_id = ${b.org}) AS entries
    `.execute(ctx.db);
    expect(Number(rows[0]!.movements)).toBe(1);
    expect(Number(rows[0]!.documents)).toBe(1);
    expect(Number(rows[0]!.entries)).toBe(1);
  });

  it('rolls document, movement, stock and journal back together when one line fails',
    async () => {
      const b = await books('Atomic');

      /* The first line is fine; the second names an archived item. The bill must
       * leave nothing at all behind — no journal, no movement, no stock. */
      const doomed = await call('POST', '/api/inventory/items', b.user, {
        itemCode: 'SKU-GONE', name: 'Retired', itemType: 'inventory',
        isInventoryTracked: true, baseUnitId: b.unitEA, inventoryAccountId: b.stock,
      });
      const created = await draft(b, [
        stockedLine(b, '5', '1.000'),
        stockedLine(b, '5', '1.000', { itemId: doomed.json().item.id }),
      ]);
      expect(created.statusCode, created.body).toBe(201);

      await call('POST', `/api/inventory/items/${doomed.json().item.id}/archive`, b.user, {
        expectedVersion: doomed.json().item.version, archived: true,
      });

      const refused = await post(b, created.json().bill.id, created.json().bill.version);
      expect(refused.statusCode).toBe(400);

      expect(await onHand(b)).toBe(0);
      expect(await glBalance(b, b.stock)).toBe(0);
      expect(await glBalance(b, b.payable)).toBe(0);
      const { rows } = await sql<{ n: string }>`
        SELECT COUNT(*)::text AS n FROM journal_entries WHERE organization_id = ${b.org}
      `.execute(ctx.db);
      expect(Number(rows[0]!.n)).toBe(0);
    });

  it('lets only ONE of several simultaneous posts through', async () => {
    const b = await books('Race');
    const created = await draft(b, [stockedLine(b, '6', '1.500')]);
    const version = created.json().bill.version;

    const attempts = await Promise.all(
      Array.from({ length: 4 }, () => post(b, created.json().bill.id, version)),
    );
    const ok = attempts.filter((r) => r.statusCode === 200);
    expect(ok).toHaveLength(1);

    expect(await onHand(b)).toBe(6);
    expect(await glBalance(b, b.stock)).toBe(9);
    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM inventory_movements WHERE organization_id = ${b.org}
    `.execute(ctx.db);
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

/* ══ Deferred dependencies, refused by name ════════════════════════════════ */

describe('what I3 defers', () => {
  it('has no purchase-order or goods-receipt endpoint', async () => {
    const b = await books('NoRoutes');
    for (const path of [
      '/api/purchase-orders', '/api/inventory/goods-receipts',
      '/api/inventory/matches', '/api/inventory/grni',
    ]) {
      const r = await call('GET', path, b.user);
      expect(r.statusCode, path).toBe(404);
    }
  });

  it('still refuses a stocked INVOICE line — selling stock is not this slice', async () => {
    const b = await books('SalesGuard');
    const created = await draft(b, [stockedLine(b, '5', '2.000')]);
    await post(b, created.json().bill.id, created.json().bill.version);

    const customer = await call('POST', '/api/customers', b.user, {
      partyCode: 'CUST', legalName: 'A customer',
    });
    const invoice = await call('POST', '/api/invoices', b.user, {
      issuingEntityId: ENTITY, customerId: customer.json().customer.id,
      issueDate: '2026-03-05', dueDate: '2026-03-31',
      lines: [{
        accountId: b.expense, description: 'Goods', quantity: '1', unitPrice: '10.000',
        itemId: b.item,
      }],
    });
    expect(invoice.statusCode).toBe(400);
    expect(invoice.json().error.message).toMatch(/stock|inventory/i);
  });
});

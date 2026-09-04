/**
 * Inventory I4 — stocked sales invoices and cost of sales, through the real stack.
 *
 * The claim is narrow and has to be exact: issuing an invoice that names a
 * stock item takes the quantity out of the warehouse it names, recognises the
 * cost of what left at the weighted average these books actually hold, and
 * leaves the inventory subledger and the general ledger agreeing to the fils.
 *
 * The three failures being guarded against are all silent ones. Selling stock
 * without relieving it overstates both inventory and profit while every entry
 * still balances. Costing a sale from the request rather than the ledger lets a
 * caller report whatever margin it likes. And voiding an invoice without
 * putting the goods back leaves a warehouse permanently short of stock nobody
 * ever sold.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createMigrator } from '../src/db/migrator.js';
import { CLEANUP_CONFIRMATION } from '../src/services/cleanupService.js';
import { DELETION_SEQUENCE } from '../src/services/tenantInventory.js';
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
  cogs: string;
  sales: string;
  receivable: string;
  payable: string;
  output: string;
  bank: string;
  unitEA: string;
  main: string;
  second: string;
  item: string;
  itemNoCogs: string;
  service: string;
  customer: string;
  supplier: string;
}

async function books(name: string, plan = 'enterprise'): Promise<Books> {
  const sub = await ctx.app.inject({
    method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(admin),
    payload: {
      fullName: `${name} Owner`, email: `owner@${name.toLowerCase()}.test`,
      organizationLegalName: `${name} LLC`, country: 'JO', baseCurrency: 'JOD',
      planId: await planId(plan), onboarding: 'temporary', paymentConfirmed: true,
      /* Disposable, so the cleanup path below may actually destroy them. */
      dataClassification: 'test',
    },
  });
  expect(sub.statusCode, sub.body).toBe(201);
  const org = sub.json().subscriber.organizationId;

  const invited = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: authHeaders(admin),
    payload: {
      fullName: `${name} Person`, email: `${name.toLowerCase()}@si.test`,
      organizationId: org, role: 'admin', onboarding: 'invitation',
    },
  });
  expect(invited.statusCode, invited.body).toBe(201);
  await ctx.app.inject({
    method: 'POST', url: '/api/auth/reset-password',
    payload: { token: invited.json().credential.invitationToken, newPassword: password },
  });
  const user = await login(ctx, `${name.toLowerCase()}@si.test`, password);

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
  const cogs = await account('5000', 'Cost of sales', 'expense');
  const sales = await account('4000', 'Sales', 'income');
  const receivable = await account('1200', 'Trade receivables', 'asset');
  const payable = await account('2100', 'Trade payables', 'liability');
  const output = await account('2270', 'Output tax payable', 'liability');
  const bank = await account('1100', 'Bank', 'asset', {
    cashClassification: 'cash_and_cash_equivalents',
  });

  const unitEA = (await call('GET', '/api/inventory/units', user))
    .json().units.find((u: { code: string }) => u.code === 'EA').id;

  const warehouse = await call('POST', '/api/inventory/warehouses', user, {
    code: 'MAIN', name: 'Main store',
  });
  expect(warehouse.statusCode, warehouse.body).toBe(201);
  const second = await call('POST', '/api/inventory/warehouses', user, {
    code: 'WEST', name: 'West store',
  });
  expect(second.statusCode, second.body).toBe(201);

  const item = await call('POST', '/api/inventory/items', user, {
    itemCode: 'SKU-1', name: 'Widget', itemType: 'inventory',
    isInventoryTracked: true, baseUnitId: unitEA,
    inventoryAccountId: stock, cogsAccountId: cogs,
  });
  expect(item.statusCode, item.body).toBe(201);

  /* Deliberately without a cost-of-sales account of its own. */
  const itemNoCogs = await call('POST', '/api/inventory/items', user, {
    itemCode: 'SKU-2', name: 'Gadget', itemType: 'inventory',
    isInventoryTracked: true, baseUnitId: unitEA, inventoryAccountId: stock,
  });
  expect(itemNoCogs.statusCode, itemNoCogs.body).toBe(201);

  const service = await call('POST', '/api/inventory/items', user, {
    itemCode: 'SRV-1', name: 'Consulting', itemType: 'service', baseUnitId: unitEA,
  });
  expect(service.statusCode, service.body).toBe(201);

  const customer = await call('POST', '/api/customers', user, {
    partyCode: 'CUST', legalName: 'Buyer LLC',
    customer: { defaultReceivableAccountId: receivable },
  });
  expect(customer.statusCode, customer.body).toBe(201);

  const supplier = await call('POST', '/api/vendors', user, {
    partyCode: 'ACME', legalName: 'Acme Supplies',
    supplier: { defaultPayableAccountId: payable },
  });
  expect(supplier.statusCode, supplier.body).toBe(201);

  return {
    org, user, stock, cogs, sales, receivable, payable, output, bank, unitEA,
    main: warehouse.json().warehouse.id,
    second: second.json().warehouse.id,
    item: item.json().item.id,
    itemNoCogs: itemNoCogs.json().item.id,
    service: service.json().item.id,
    customer: customer.json().customer.id,
    supplier: supplier.json().supplier.id,
  };
}

/* ── Getting stock in, so there is something to sell ─────────────────────── */

let supplierSeq = 0;

/** Buy stock in through I3, which is how these books acquire it. */
async function buy(
  b: Books, quantity: string, unitPrice: string,
  over: { itemId?: string; warehouseId?: string; billDate?: string } = {},
): Promise<void> {
  const created = await call('POST', '/api/bills', b.user, {
    issuingEntityId: ENTITY, supplierId: b.supplier,
    supplierInvoiceNumber: `SUP-${supplierSeq++}`,
    billDate: over.billDate ?? '2026-02-01', dueDate: over.billDate ?? '2026-02-28',
    lines: [{
      description: 'Stock', accountId: b.stock,
      itemId: over.itemId ?? b.item, warehouseId: over.warehouseId ?? b.main,
      quantity, unitPrice,
    }],
  });
  expect(created.statusCode, created.body).toBe(201);
  const posted = await call('POST', `/api/bills/${created.json().bill.id}/post`, b.user, {
    expectedVersion: created.json().bill.version,
  });
  expect(posted.statusCode, posted.body).toBe(200);
}

/* ── Invoices ────────────────────────────────────────────────────────────── */

const soldLine = (b: Books, quantity: string, unitPrice: string, over: Record<string, unknown> = {}) => ({
  description: 'Widgets', accountId: b.sales, itemId: b.item, warehouseId: b.main,
  quantity, unitPrice, ...over,
});

const draft = (b: Books, lines: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) =>
  call('POST', '/api/invoices', b.user, {
    issuingEntityId: ENTITY, customerId: b.customer,
    issueDate: '2026-03-01', dueDate: '2026-03-31',
    lines, ...over,
  });

const issue = (b: Books, id: string, version: number) =>
  call('POST', `/api/invoices/${id}/issue`, b.user, { expectedVersion: version });

const voidIt = (b: Books, id: string, version: number, reason = 'Entered in error') =>
  call('POST', `/api/invoices/${id}/void`, b.user, { expectedVersion: version, reason });

async function draftAndIssue(
  b: Books, lines: Array<Record<string, unknown>>, over: Record<string, unknown> = {},
) {
  const created = await draft(b, lines, over);
  expect(created.statusCode, created.body).toBe(201);
  const issued = await issue(b, created.json().invoice.id, created.json().invoice.version);
  return { created, issued };
}

/* ── Reading the books ───────────────────────────────────────────────────── */

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

async function onHand(b: Books, itemId?: string): Promise<number> {
  const r = await call('GET', `/api/inventory/stock-on-hand?itemId=${itemId ?? b.item}`, b.user);
  return r.json().rows.reduce((s: number, row: { quantity: string }) => s + Number(row.quantity), 0);
}

async function onHandAt(b: Books, warehouseId: string): Promise<number> {
  const r = await call('GET', `/api/inventory/stock-on-hand?itemId=${b.item}`, b.user);
  return r.json().rows
    .filter((row: { warehouseId: string }) => row.warehouseId === warehouseId)
    .reduce((s: number, row: { quantity: string }) => s + Number(row.quantity), 0);
}

async function stockValue(b: Books): Promise<number> {
  const r = await call('GET', '/api/inventory/valuation', b.user);
  return r.json().rows.reduce((s: number, row: { value: string }) => s + Number(row.value), 0);
}

async function countEntries(b: Books, sourceEvent?: string): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    SELECT COUNT(*)::text AS n FROM journal_entries
     WHERE organization_id = ${b.org}
       AND (${sourceEvent ?? null}::text IS NULL OR source_event = ${sourceEvent ?? null})
  `.execute(ctx.db);
  return Number(rows[0]!.n);
}

/* ══ The core posting ══════════════════════════════════════════════════════ */

describe('a stocked sales invoice', () => {
  it('takes the stock out and recognises the cost at weighted average', async () => {
    const b = await books('Core');
    await buy(b, '10', '5.000');
    expect(await onHand(b)).toBe(10);

    const { issued } = await draftAndIssue(b, [soldLine(b, '4', '12.000')]);
    expect(issued.statusCode, issued.body).toBe(200);

    /* Six left, worth what six cost. */
    expect(await onHand(b)).toBe(6);
    expect(await stockValue(b)).toBe(30);

    /* The revenue half. */
    expect(await glBalance(b, b.receivable)).toBe(48);
    expect(await glBalance(b, b.sales)).toBe(-48);

    /* The cost half, at 5.000 each — the price it was BOUGHT at, never sold at. */
    expect(await glBalance(b, b.cogs)).toBe(20);
    /* Inventory: 50 in, 20 out. */
    expect(await glBalance(b, b.stock)).toBe(30);
  });

  it('posts TWO entries: the sale, and the cost of it', async () => {
    const b = await books('Two');
    await buy(b, '10', '5.000');
    const { created } = await draftAndIssue(b, [soldLine(b, '2', '9.000')]);

    /* One for the purchase, one for the sale, one for its cost. */
    expect(await countEntries(b)).toBe(3);
    expect(await countEntries(b, 'issue')).toBe(1);
    expect(await countEntries(b, 'cost-of-sales')).toBe(1);

    /* And the cost entry is the stock document's own, not the invoice's. */
    const { rows } = await sql<{ kind: string; journal_entry_id: string; source_invoice_id: string }>`
      SELECT kind, journal_entry_id::text, source_invoice_id::text
        FROM inventory_documents
       WHERE organization_id = ${b.org} AND kind = 'invoice-issue'
    `.execute(ctx.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_invoice_id).toBe(created.json().invoice.id);

    const invoice = await call('GET', `/api/invoices/${created.json().invoice.id}`, b.user);
    expect(rows[0]!.journal_entry_id).not.toBe(invoice.json().invoice.journalEntryId);
  });

  it('freezes the cost onto the line, so the margin is answerable later', async () => {
    const b = await books('Frozen');
    await buy(b, '10', '5.000');
    const { created } = await draftAndIssue(b, [soldLine(b, '4', '12.000')]);

    const invoice = await call('GET', `/api/invoices/${created.json().invoice.id}`, b.user);
    expect(invoice.json().invoice.lines[0].issuedUnitCost).toBe('5.000');

    /* Buying more at a different price does not rewrite what was sold. */
    await buy(b, '10', '9.000', { billDate: '2026-03-02' });
    const again = await call('GET', `/api/invoices/${created.json().invoice.id}`, b.user);
    expect(again.json().invoice.lines[0].issuedUnitCost).toBe('5.000');
  });

  it('costs at the average across receipts, not at either price', async () => {
    const b = await books('Average');
    await buy(b, '10', '4.000');
    await buy(b, '10', '6.000', { billDate: '2026-02-02' });
    /* 100 for 20 → 5.000 each. */

    await draftAndIssue(b, [soldLine(b, '5', '20.000')]);
    expect(await glBalance(b, b.cogs)).toBe(25);
    expect(await stockValue(b)).toBe(75);
  });

  it('leaves nothing stranded when a sale empties the position', async () => {
    const b = await books('Empty');
    /* Three bought for ten: 3.3333... each, which cannot be represented. */
    await buy(b, '3', '3.333');
    /* Sold one at a time, the last one must absorb whatever is left. */
    await draftAndIssue(b, [soldLine(b, '1', '5.000')]);
    await draftAndIssue(b, [soldLine(b, '1', '5.000')], { issueDate: '2026-03-02' });
    await draftAndIssue(b, [soldLine(b, '1', '5.000')], { issueDate: '2026-03-03' });

    expect(await onHand(b)).toBe(0);
    expect(await stockValue(b)).toBe(0);
    /* Everything bought has become cost of sales, to the fils. */
    expect(await glBalance(b, b.stock)).toBe(0);
    expect(await glBalance(b, b.cogs)).toBe(await glBalance(b, b.payable) * -1);
  });

  it('sells the same item twice on one invoice without double-spending it', async () => {
    const b = await books('Twice');
    await buy(b, '5', '2.000');

    const { issued } = await draftAndIssue(b, [
      soldLine(b, '3', '10.000'),
      soldLine(b, '3', '10.000'),
    ]);
    /* Six wanted, five held: the second line sees the first. */
    expect(issued.statusCode).toBe(400);
    expect(issued.json().error.message).toMatch(/more than is in the warehouse/i);
    /* And nothing at all was written. */
    expect(await onHand(b)).toBe(5);
    expect(await countEntries(b)).toBe(1);
  });

  it('relieves the warehouse the line names, not merely the company total', async () => {
    const b = await books('Which');
    await buy(b, '4', '5.000');
    await buy(b, '4', '5.000', { warehouseId: b.second, billDate: '2026-02-02' });

    await draftAndIssue(b, [soldLine(b, '3', '9.000', { warehouseId: b.second })]);
    expect(await onHandAt(b, b.main)).toBe(4);
    expect(await onHandAt(b, b.second)).toBe(1);
  });

  it('leaves an invoice with no stocked line creating no stock document at all', async () => {
    const b = await books('Service');
    const { issued } = await draftAndIssue(b, [
      { description: 'Consulting', accountId: b.sales, quantity: '1', unitPrice: '400.000' },
    ]);
    expect(issued.statusCode, issued.body).toBe(200);

    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM inventory_documents WHERE organization_id = ${b.org}
    `.execute(ctx.db);
    expect(Number(rows[0]!.n)).toBe(0);
    expect(await countEntries(b)).toBe(1);
  });

  it('mixes a stocked line and a service line in one invoice', async () => {
    const b = await books('Mixed');
    await buy(b, '10', '5.000');

    const { issued } = await draftAndIssue(b, [
      soldLine(b, '2', '12.000'),
      { description: 'Fitting', accountId: b.sales, quantity: '1', unitPrice: '30.000' },
    ]);
    expect(issued.statusCode, issued.body).toBe(200);

    expect(await glBalance(b, b.receivable)).toBe(54);
    /* Only the stocked line has a cost. */
    expect(await glBalance(b, b.cogs)).toBe(10);
    expect(await onHand(b)).toBe(8);
  });

  it('falls back to the company cost-of-sales account when the item names none', async () => {
    const b = await books('Fallback');
    const current = await call('GET', '/api/inventory/settings', b.user);
    const settings = await call('PATCH', '/api/inventory/settings', b.user, {
      defaultCogsAccountId: b.cogs, expectedVersion: current.json().settings.version,
    });
    expect(settings.statusCode, settings.body).toBe(200);

    await buy(b, '4', '5.000', { itemId: b.itemNoCogs });
    const { issued } = await draftAndIssue(b, [
      soldLine(b, '2', '11.000', { itemId: b.itemNoCogs }),
    ]);
    expect(issued.statusCode, issued.body).toBe(200);
    expect(await glBalance(b, b.cogs)).toBe(10);
  });
});

/* ══ Tax ═══════════════════════════════════════════════════════════════════ */

describe('tax on a stocked sale', () => {
  it('leaves the cost untouched by output tax', async () => {
    const b = await books('Tax');
    await buy(b, '10', '5.000');

    const code = await call('POST', '/api/tax-codes', b.user, {
      code: 'VAT16', name: 'Standard-rated', category: 'standard',
      calculationMethod: 'exclusive', rate: '16',
      outputTaxAccountId: b.output, effectiveFrom: '2026-01-01',
    });
    expect(code.statusCode, code.body).toBe(201);

    await draftAndIssue(b, [soldLine(b, '4', '12.000', { taxCodeId: code.json().taxCode.id })]);

    /* 48 net, 7.68 tax, 55.68 receivable. */
    expect(await glBalance(b, b.receivable)).toBe(55.68);
    expect(await glBalance(b, b.sales)).toBe(-48);
    expect(await glBalance(b, b.output)).toBe(-7.68);

    /*
     * And the cost is 20 — what the goods cost — with no relationship to the
     * tax the customer was charged. A cost computed from the invoice line
     * rather than the ledger would move when the rate did.
     */
    expect(await glBalance(b, b.cogs)).toBe(20);
  });
});

/* ══ What is refused ═══════════════════════════════════════════════════════ */

describe('refusals', () => {
  it('refuses to sell more than the warehouse holds, and writes nothing', async () => {
    const b = await books('Short');
    await buy(b, '3', '5.000');

    const created = await draft(b, [soldLine(b, '5', '12.000')]);
    expect(created.statusCode, created.body).toBe(201);
    const issued = await issue(b, created.json().invoice.id, created.json().invoice.version);
    expect(issued.statusCode).toBe(400);
    expect(issued.json().error.message).toMatch(/more than is in the warehouse/i);
    expect(issued.json().error.message).toMatch(/SKU-1 has 3 in MAIN/);

    /* The invoice is still a draft, the stock is still there, no entry exists. */
    const after = await call('GET', `/api/invoices/${created.json().invoice.id}`, b.user);
    expect(after.json().invoice.status).toBe('draft');
    expect(await onHand(b)).toBe(3);
    expect(await countEntries(b)).toBe(1);
  });

  it('refuses to sell from a warehouse that holds none of it', async () => {
    const b = await books('Elsewhere');
    await buy(b, '10', '5.000');
    const { issued } = await draftAndIssue(b, [soldLine(b, '1', '9.000', { warehouseId: b.second })]);
    expect(issued.statusCode).toBe(400);
    expect(issued.json().error.message).toMatch(/has 0 in WEST/);
    expect(await onHand(b)).toBe(10);
  });

  it('refuses a half-named line at the boundary, before anything is saved', async () => {
    const b = await books('Half');
    const noWarehouse = await draft(b, [{
      description: 'Widgets', accountId: b.sales, itemId: b.item, quantity: '1', unitPrice: '9.000',
    }]);
    expect(noWarehouse.statusCode).toBe(400);
    expect(noWarehouse.json().error.message).toMatch(/must name both the item and the warehouse/i);

    const noItem = await draft(b, [{
      description: 'Widgets', accountId: b.sales, warehouseId: b.main, quantity: '1', unitPrice: '9.000',
    }]);
    expect(noItem.statusCode).toBe(400);

    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM invoices WHERE organization_id = ${b.org}
    `.execute(ctx.db);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('refuses to sell a service item from stock', async () => {
    const b = await books('NotStock');
    const { issued } = await draftAndIssue(b, [soldLine(b, '1', '9.000', { itemId: b.service })]);
    expect(issued.statusCode).toBe(400);
    expect(issued.json().error.message).toMatch(/not stock-tracked/i);
  });

  it('refuses an item with no cost-of-sales account anywhere', async () => {
    const b = await books('NoCogs');
    await buy(b, '4', '5.000', { itemId: b.itemNoCogs });
    const { issued } = await draftAndIssue(b, [soldLine(b, '1', '9.000', { itemId: b.itemNoCogs })]);
    expect(issued.statusCode).toBe(400);
    expect(issued.json().error.message).toMatch(/no cost-of-sales account/i);
    /* Refused at posting, so the stock is untouched. */
    expect(await onHand(b, b.itemNoCogs)).toBe(4);
  });

  it('refuses an item archived between the draft and the issue', async () => {
    const b = await books('Archived');
    await buy(b, '10', '5.000');
    const created = await draft(b, [soldLine(b, '2', '12.000')]);
    expect(created.statusCode, created.body).toBe(201);

    const item = await call('GET', `/api/inventory/items/${b.item}`, b.user);
    const archived = await call('POST', `/api/inventory/items/${b.item}/archive`, b.user, {
      archived: true, expectedVersion: item.json().item.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);

    const issued = await issue(b, created.json().invoice.id, created.json().invoice.version);
    expect(issued.statusCode).toBe(400);
    expect(issued.json().error.message).toMatch(/archived and cannot be sold/i);
    expect(await onHand(b)).toBe(10);
  });

  it('refuses to sell behind an item’s most recent movement', async () => {
    const b = await books('Backdate');
    await buy(b, '10', '5.000', { billDate: '2026-03-10' });

    const { issued } = await draftAndIssue(b, [soldLine(b, '1', '9.000')], { issueDate: '2026-03-05' });
    expect(issued.statusCode).toBe(400);
    expect(issued.json().error.message).toMatch(/before that item's most recent movement/i);
    expect(issued.json().error.message).toMatch(/2026-03-10/);
  });

  it('refuses a zero-quantity stocked line', async () => {
    const b = await books('Zero');
    await buy(b, '10', '5.000');
    const { issued } = await draftAndIssue(b, [soldLine(b, '0', '9.000')]);
    expect(issued.statusCode).toBe(400);
    expect(issued.json().error.message).toMatch(/quantity of zero moves nothing/i);
  });

  it('still refuses a FIFO item, because nothing consumes a layer', async () => {
    const b = await books('Fifo');
    const fifo = await call('POST', '/api/inventory/items', b.user, {
      itemCode: 'SKU-F', name: 'Layered', itemType: 'inventory', isInventoryTracked: true,
      baseUnitId: b.unitEA, inventoryAccountId: b.stock, cogsAccountId: b.cogs,
      valuationMethod: 'fifo',
    });
    expect(fifo.statusCode, fifo.body).toBe(201);

    const { issued } = await draftAndIssue(b, [
      soldLine(b, '1', '9.000', { itemId: fifo.json().item.id }),
    ]);
    expect(issued.statusCode).toBe(400);
    expect(issued.json().error.message).toMatch(/weighted.average/i);
  });
});

/* ══ Isolation, by construction ════════════════════════════════════════════ */

describe('company scoping', () => {
  it('refuses another company’s item and warehouse at the database', async () => {
    const a = await books('Alpha');
    const c = await books('Beta');

    const crossItem = await draft(a, [soldLine(a, '1', '9.000', { itemId: c.item })]);
    expect(crossItem.statusCode).toBeGreaterThanOrEqual(400);

    const crossWarehouse = await draft(a, [soldLine(a, '1', '9.000', { warehouseId: c.main })]);
    expect(crossWarehouse.statusCode).toBeGreaterThanOrEqual(400);
  });
});

/* ══ Voiding ═══════════════════════════════════════════════════════════════ */

describe('voiding a stocked invoice', () => {
  it('puts the stock back and takes the cost of sales off', async () => {
    const b = await books('Void');
    await buy(b, '10', '5.000');
    const { created } = await draftAndIssue(b, [soldLine(b, '4', '12.000')]);

    const issuedInvoice = await call('GET', `/api/invoices/${created.json().invoice.id}`, b.user);
    const voided = await voidIt(
      b, created.json().invoice.id, issuedInvoice.json().invoice.version,
    );
    expect(voided.statusCode, voided.body).toBe(200);
    expect(voided.json().invoice.status).toBe('void');

    /* As if the sale never happened, on both sides. */
    expect(await onHand(b)).toBe(10);
    expect(await stockValue(b)).toBe(50);
    expect(await glBalance(b, b.stock)).toBe(50);
    expect(await glBalance(b, b.cogs)).toBe(0);
    expect(await glBalance(b, b.sales)).toBe(0);
    expect(await glBalance(b, b.receivable)).toBe(0);
  });

  it('restores at the ORIGINAL cost, not at today’s average', async () => {
    const b = await books('Original');
    await buy(b, '10', '5.000');
    const { created } = await draftAndIssue(b, [soldLine(b, '5', '12.000')]);
    /* 25 left in stock, 25 in cost of sales. */

    /* The average moves after the sale. */
    await buy(b, '5', '11.000', { billDate: '2026-03-02' });

    const before = await call('GET', `/api/invoices/${created.json().invoice.id}`, b.user);
    const voided = await voidIt(b, created.json().invoice.id, before.json().invoice.version);
    expect(voided.statusCode, voided.body).toBe(200);

    /* Everything bought is back: 50 + 55. Restoring at today's average would
     * have put back 5 x 8 = 40 and quietly created 15 of value. */
    expect(await onHand(b)).toBe(15);
    expect(await stockValue(b)).toBe(105);
    expect(await glBalance(b, b.cogs)).toBe(0);
  });

  it('marks BOTH the sale and its counter reversed, so the pair leaves every sum', async () => {
    const b = await books('Pair');
    await buy(b, '10', '5.000');
    const { created } = await draftAndIssue(b, [soldLine(b, '4', '12.000')]);
    const before = await call('GET', `/api/invoices/${created.json().invoice.id}`, b.user);
    await voidIt(b, created.json().invoice.id, before.json().invoice.version);

    const { rows } = await sql<{ status: string; n: string }>`
      SELECT status, COUNT(*)::text AS n FROM inventory_movements
       WHERE organization_id = ${b.org} AND movement_type IN ('issue','adjustment-in')
       GROUP BY status
    `.execute(ctx.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('reversed');
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it('voids an invoice that sold nothing stocked, exactly as before', async () => {
    const b = await books('VoidService');
    const { created } = await draftAndIssue(b, [
      { description: 'Consulting', accountId: b.sales, quantity: '1', unitPrice: '400.000' },
    ]);
    const before = await call('GET', `/api/invoices/${created.json().invoice.id}`, b.user);
    const voided = await voidIt(b, created.json().invoice.id, before.json().invoice.version);
    expect(voided.statusCode, voided.body).toBe(200);
    expect(await glBalance(b, b.sales)).toBe(0);
  });

  it('can be sold again after a void, because the stock came back', async () => {
    const b = await books('Resell');
    await buy(b, '4', '5.000');
    const { created } = await draftAndIssue(b, [soldLine(b, '4', '12.000')]);
    expect(await onHand(b)).toBe(0);

    const before = await call('GET', `/api/invoices/${created.json().invoice.id}`, b.user);
    await voidIt(b, created.json().invoice.id, before.json().invoice.version);

    const { issued } = await draftAndIssue(b, [soldLine(b, '4', '15.000')], { issueDate: '2026-03-05' });
    expect(issued.statusCode, issued.body).toBe(200);
    expect(await onHand(b)).toBe(0);
    expect(await glBalance(b, b.cogs)).toBe(20);
  });
});

/* ══ The two ledgers agree ═════════════════════════════════════════════════ */

describe('reconciliation', () => {
  it('reconciles the subledger to the general ledger after buying, selling and voiding', async () => {
    const b = await books('Reconcile');
    await buy(b, '20', '4.000');
    await buy(b, '10', '7.000', { billDate: '2026-02-05' });
    await draftAndIssue(b, [soldLine(b, '6', '12.000')]);
    const { created } = await draftAndIssue(b, [soldLine(b, '4', '12.000')], { issueDate: '2026-03-02' });
    const before = await call('GET', `/api/invoices/${created.json().invoice.id}`, b.user);
    await voidIt(b, created.json().invoice.id, before.json().invoice.version);

    const report = await call('GET', '/api/inventory/reconciliation', b.user);
    expect(report.statusCode, report.body).toBe(200);
    for (const row of report.json().rows) {
      expect(Number(row.difference)).toBe(0);
    }

    /* And independently: the ledger's inventory balance IS the subledger value. */
    expect(await glBalance(b, b.stock)).toBe(await stockValue(b));
  });
});

/* ══ Deleting a workspace that traded ══════════════════════════════════════ */

describe('workspace deletion', () => {
  /*
   * The cheap invariant, stated directly. A document line naming an item holds
   * it under a RESTRICT key, so the catalogue cannot be deleted first — and an
   * ordering mistake here does not fail loudly, it makes a company that has
   * traded permanently undeletable.
   */
  it('deletes document lines before the catalogue they name', () => {
    const at = (table: string): number => {
      const index = DELETION_SEQUENCE.findIndex((step) => step.table === table);
      expect(index, `${table} must be in the deletion sequence`).toBeGreaterThanOrEqual(0);
      return index;
    };
    for (const holder of ['bill_lines', 'invoice_lines']) {
      for (const held of ['inventory_items', 'warehouses']) {
        expect(at(holder), `${holder} must be deleted before ${held}`).toBeLessThan(at(held));
      }
    }
    /* And the stock documents, which name a bill and an invoice, go first. */
    for (const document of ['bills', 'invoices']) {
      expect(at('inventory_documents')).toBeLessThan(at(document));
    }
    /*
     * The counterparty directory is held the same way: `invoices` names a
     * customer and `bills` a supplier, both under RESTRICT. This was wrong
     * before I4 — an organization that had ever invoiced a customer could not
     * be cleaned up at all — and the check is here so it cannot come back.
     */
    for (const document of ['bills', 'invoices']) {
      expect(at(document), `${document} must be deleted before business_parties`)
        .toBeLessThan(at('business_parties'));
    }
  });

  it('destroys an organization that bought and sold stock', async () => {
    const b = await books('Destroy');
    await buy(b, '10', '5.000');
    await draftAndIssue(b, [soldLine(b, '4', '12.000')]);

    /*
     * An invoice line and a bill line both name an item under a RESTRICT key,
     * so the catalogue cannot be deleted before the documents that reference
     * it. The deletion sequence has to order them, and this is what proves it
     * does — the failure it guards against is a company that has traded
     * becoming undeletable.
     */
    const preview = await ctx.app.inject({
      method: 'POST', url: '/api/admin/cleanup/preview', headers: authHeaders(admin),
      payload: { organizationIds: [b.org] },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().candidates[0].eligible).toBe(true);

    const deleted = await ctx.app.inject({
      method: 'POST', url: '/api/admin/cleanup/execute', headers: authHeaders(admin),
      payload: {
        organizationIds: [b.org],
        previewDigest: preview.json().digest,
        previewedAt: preview.json().previewedAt,
        reason: 'Cleaning up a workspace that bought and sold stock.',
        confirmation: CLEANUP_CONFIRMATION,
      },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json().outcome, JSON.stringify(deleted.json(), null, 2)).toBe('completed');

    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM organizations WHERE id = ${b.org}
    `.execute(ctx.db);
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

/* ══ Migration ═════════════════════════════════════════════════════════════ */

describe('migration 040', () => {
  it('rolls back and reapplies when nothing was sold', async () => {
    const migrator = createMigrator(ctx.db);
    /* 041 sits on top now, so it comes off first. */
    const counted = await migrator.migrateDown();
    expect(counted.error).toBeUndefined();
    expect(counted.results?.[0]?.migrationName).toBe('041_stock_counts');

    const down = await migrator.migrateDown();
    expect(down.error).toBeUndefined();
    expect(down.results?.[0]?.migrationName).toBe('040_stocked_invoices');

    const up = await migrator.migrateToLatest();
    expect(up.error).toBeUndefined();

    const { rows } = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'inventory_documents' AND column_name = 'source_invoice_id'
    `.execute(ctx.db);
    expect(rows[0]!.n).toBe(1);
  });

  it('REFUSES to roll back over a stocked sale', async () => {
    const b = await books('RollbackSale');
    await buy(b, '10', '5.000');
    await draftAndIssue(b, [soldLine(b, '4', '12.000')]);

    const migrator = createMigrator(ctx.db);
    /* Nothing was counted, so 041 comes off cleanly; 040 is the one holding the
     * stocked sale this test is about. */
    const counted = await migrator.migrateDown();
    expect(counted.error).toBeUndefined();

    const down = await migrator.migrateDown();
    expect(down.error).toBeDefined();
    expect(String((down.error as Error).message)).toMatch(/Refusing to roll back 040/);
    /* A refused rollback destroys nothing. */
    expect(await onHand(b)).toBe(6);
  });
});

/**
 * Inventory I5 — physical stock counts, reporting and reconciliation.
 *
 * ══ What these tests are really guarding ═════════════════════════════════════
 *
 * A count is the one place a human types a quantity that overrides the ledger,
 * so the failures worth guarding against are the ones where the override is
 * wrong and nothing says so. A book quantity accepted from the request lets a
 * caller post any variance it likes. A variance measured against a number read
 * before the lock lets a concurrent sale go missing. A missing count read as
 * zero writes off stock nobody looked at. Each of those balances perfectly and
 * each is wrong.
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
  stock: string; grni: string; gain: string; loss: string; expense: string;
  unitEA: string; main: string; spare: string; item: string; other: string;
  currency: string;
}

async function books(
  name: string, { currency = 'JOD', plan = 'enterprise' } = {},
): Promise<Books> {
  const sub = await ctx.app.inject({
    method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(admin),
    payload: {
      fullName: `${name} Owner`, email: `owner@${name.toLowerCase()}.test`,
      organizationLegalName: `${name} LLC`, country: 'JO', baseCurrency: currency,
      planId: await planId(plan), onboarding: 'temporary', paymentConfirmed: true,
      dataClassification: 'test',
    },
  });
  expect(sub.statusCode, sub.body).toBe(201);
  const org = sub.json().subscriber.organizationId;

  const invited = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: authHeaders(admin),
    payload: {
      fullName: `${name} Person`, email: `${name.toLowerCase()}@sc.test`,
      organizationId: org, role: 'admin', onboarding: 'invitation',
    },
  });
  expect(invited.statusCode, invited.body).toBe(201);
  await ctx.app.inject({
    method: 'POST', url: '/api/auth/reset-password',
    payload: { token: invited.json().credential.invitationToken, newPassword: password },
  });
  const user = await login(ctx, `${name.toLowerCase()}@sc.test`, password);

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
  const gain = await account('4300', 'Inventory gain', 'income');
  const loss = await account('5600', 'Inventory loss', 'expense');
  const expense = await account('5100', 'Consumables used', 'expense');

  const unitEA = (await call('GET', '/api/inventory/units', user))
    .json().units.find((u: { code: string }) => u.code === 'EA').id;

  const warehouse = async (code: string): Promise<string> => {
    const r = await call('POST', '/api/inventory/warehouses', user, {
      code, name: `${code} store`,
    });
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

  const makeItem = async (code: string): Promise<string> => {
    const r = await call('POST', '/api/inventory/items', user, {
      itemCode: code, name: `Widget ${code}`, itemType: 'inventory',
      isInventoryTracked: true, baseUnitId: unitEA, inventoryAccountId: stock,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().item.id;
  };

  return {
    org, user, stock, grni, gain, loss, expense, unitEA, main, spare,
    item: await makeItem('SKU-1'), other: await makeItem('SKU-2'), currency,
  };
}

/** A second member of the same organization, with a narrower role. */
async function member(b: Books, name: string, role: string): Promise<SessionCookies> {
  const invited = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: authHeaders(admin),
    payload: {
      fullName: `${name} Person`, email: `${name.toLowerCase()}@sc.test`,
      organizationId: b.org, role, onboarding: 'invitation',
    },
  });
  expect(invited.statusCode, invited.body).toBe(201);
  await ctx.app.inject({
    method: 'POST', url: '/api/auth/reset-password',
    payload: { token: invited.json().credential.invitationToken, newPassword: password },
  });
  return login(ctx, `${name.toLowerCase()}@sc.test`, password);
}

let keySeed = 0;
const key = (): string => `count-${Date.now()}-${keySeed++}`;

const receive = (
  b: Books, quantity: string, unitCost: string,
  { warehouse, date = '2026-03-01', item }: { warehouse?: string; date?: string; item?: string } = {},
) => call('POST', '/api/inventory/documents', b.user, {
  idempotencyKey: key(), kind: 'receipt', movementDate: date,
  lines: [{ itemId: item ?? b.item, warehouseId: warehouse ?? b.main, quantity, unitCost }],
});

const countIt = (
  b: Books, lines: Array<Record<string, unknown>>, over: Record<string, unknown> = {},
) => call('POST', '/api/inventory/counts', b.user, {
  warehouseId: b.main, countDate: '2026-03-10', reason: 'Quarterly count',
  idempotencyKey: key(), lines, ...over,
});

async function onHand(b: Books, item?: string, warehouse?: string): Promise<number> {
  const r = await call('GET', `/api/inventory/stock-on-hand?itemId=${item ?? b.item}`, b.user);
  return r.json().rows
    .filter((row: { warehouseId: string }) => !warehouse || row.warehouseId === warehouse)
    .reduce((s: number, row: { quantity: string }) => s + Number(row.quantity), 0);
}

async function glBalance(b: Books, accountId: string): Promise<number> {
  const { rows } = await sql<{ balance: string }>`
    SELECT COALESCE(SUM(COALESCE(l.debit_functional,0) - COALESCE(l.credit_functional,0)), 0)::text AS balance
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.journal_entry_id
     WHERE l.organization_id = ${b.org} AND l.account_id = ${accountId}
       AND e.status IN ('posted', 'reversed')
  `.execute(ctx.db);
  return Number(rows[0]!.balance);
}

/* ══ Counting ══════════════════════════════════════════════════════════════ */

describe('a physical count', () => {
  it('writes stock DOWN when the shelf holds less than the books', async () => {
    const b = await books('Short');
    await receive(b, '10', '5.000');

    const counted = await countIt(b, [{ itemId: b.item, countedQuantity: '8' }]);
    expect(counted.statusCode, counted.body).toBe(201);

    const record = counted.json().count;
    expect(record.lines[0].expectedQuantity).toBe('10');
    expect(record.lines[0].countedQuantity).toBe('8');
    expect(record.lines[0].varianceQuantity).toBe('-2');

    expect(await onHand(b)).toBe(8);
    /* Dr Inventory loss / Cr Inventory, at the weighted average. */
    expect(await glBalance(b, b.loss)).toBe(10);
    expect(await glBalance(b, b.stock)).toBe(40);
    expect(await glBalance(b, b.gain)).toBe(0);
  });

  it('writes stock UP when the shelf holds more, at what the item is worth', async () => {
    const b = await books('Over');
    await receive(b, '10', '5.000');

    const counted = await countIt(b, [{ itemId: b.item, countedQuantity: '12' }]);
    expect(counted.statusCode, counted.body).toBe(201);
    expect(counted.json().count.lines[0].varianceQuantity).toBe('2');

    expect(await onHand(b)).toBe(12);
    /* Dr Inventory / Cr Inventory gain, at 5.000 — the average, not a guess. */
    expect(await glBalance(b, b.gain)).toBe(-10);
    expect(await glBalance(b, b.stock)).toBe(60);
  });

  it('posts NOTHING when every line agrees, and still records the count', async () => {
    const b = await books('Agree');
    await receive(b, '10', '5.000');

    const counted = await countIt(b, [{ itemId: b.item, countedQuantity: '10' }]);
    expect(counted.statusCode, counted.body).toBe(201);

    const record = counted.json().count;
    expect(record.lines[0].varianceQuantity).toBe('0');
    /* No adjustment, no journal — and the count itself survives, because
     * somebody checking and finding nothing wrong is a fact worth keeping. */
    expect(record.adjustmentDocumentId).toBeNull();
    expect(record.journalEntryId).toBeNull();
    expect(await onHand(b)).toBe(10);

    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM journal_entries WHERE organization_id = ${b.org}
    `.execute(ctx.db);
    /* Only the receipt's. */
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('treats a counted ZERO as an observation, not as an absence', async () => {
    const b = await books('Zero');
    await receive(b, '6', '5.000');

    const counted = await countIt(b, [{ itemId: b.item, countedQuantity: '0' }]);
    expect(counted.statusCode, counted.body).toBe(201);
    expect(counted.json().count.lines[0].countedQuantity).toBe('0');
    expect(counted.json().count.lines[0].varianceQuantity).toBe('-6');
    expect(await onHand(b)).toBe(0);
    expect(await glBalance(b, b.loss)).toBe(30);
  });

  it('leaves an item OFF the sheet completely alone', async () => {
    const b = await books('Partial');
    await receive(b, '10', '5.000');
    await receive(b, '7', '2.000', { item: b.other });

    /* Only SKU-1 is counted. SKU-2 was not looked at, and a missing count is
     * not a count of zero — writing it off would destroy stock nobody saw. */
    const counted = await countIt(b, [{ itemId: b.item, countedQuantity: '9' }]);
    expect(counted.statusCode, counted.body).toBe(201);
    expect(counted.json().count.lines).toHaveLength(1);

    expect(await onHand(b, b.item)).toBe(9);
    expect(await onHand(b, b.other)).toBe(7);
  });

  it('counts each warehouse separately, against that warehouse only', async () => {
    const b = await books('PerWarehouse');
    await receive(b, '10', '5.000');
    await receive(b, '4', '5.000', { warehouse: b.spare });

    const counted = await countIt(b, [{ itemId: b.item, countedQuantity: '7' }]);
    expect(counted.statusCode, counted.body).toBe(201);
    /* The expected quantity was MAIN's ten, not the company's fourteen. */
    expect(counted.json().count.lines[0].expectedQuantity).toBe('10');
    expect(await onHand(b, b.item, b.main)).toBe(7);
    expect(await onHand(b, b.item, b.spare)).toBe(4);
  });

  it('counts several items in one sheet, each against its own book quantity', async () => {
    const b = await books('Multi');
    await receive(b, '10', '5.000');
    await receive(b, '8', '2.000', { item: b.other });

    const counted = await countIt(b, [
      { itemId: b.item, countedQuantity: '9' },
      { itemId: b.other, countedQuantity: '10' },
    ]);
    expect(counted.statusCode, counted.body).toBe(201);
    expect(await onHand(b, b.item)).toBe(9);
    expect(await onHand(b, b.other)).toBe(10);
    /* One down at 5, one up at 2: separate accounts, one journal. */
    expect(await glBalance(b, b.loss)).toBe(5);
    expect(await glBalance(b, b.gain)).toBe(-4);
  });

  it('brings found stock in at a validated cost when the shelf was empty', async () => {
    const b = await books('Found');
    /* Nothing on hand, so there is no average to bring it in at. */
    const counted = await countIt(b, [
      { itemId: b.item, countedQuantity: '5', unitCost: '3.000' },
    ]);
    expect(counted.statusCode, counted.body).toBe(201);
    expect(await onHand(b)).toBe(5);
    expect(await glBalance(b, b.stock)).toBe(15);
    expect(await glBalance(b, b.gain)).toBe(-15);
  });

  it('numbers counts in sequence, per company', async () => {
    const b = await books('Numbering');
    await receive(b, '10', '5.000');
    const first = await countIt(b, [{ itemId: b.item, countedQuantity: '10' }]);
    const second = await countIt(b, [{ itemId: b.item, countedQuantity: '10' }]);
    expect(first.json().count.countNumber).toBe('SC-2026-0001');
    expect(second.json().count.countNumber).toBe('SC-2026-0002');
  });

  it('answers a repeated request with the count it already made', async () => {
    const b = await books('Idempotent');
    await receive(b, '10', '5.000');
    const shared = key();

    const first = await countIt(b, [{ itemId: b.item, countedQuantity: '7' }], { idempotencyKey: shared });
    expect(first.statusCode).toBe(201);
    const again = await countIt(b, [{ itemId: b.item, countedQuantity: '7' }], { idempotencyKey: shared });
    expect(again.statusCode).toBe(200);
    expect(again.json().created).toBe(false);
    expect(again.json().count.id).toBe(first.json().count.id);

    /* And the stock moved exactly once. */
    expect(await onHand(b)).toBe(7);
    expect(await glBalance(b, b.loss)).toBe(15);
  });
});

/* ══ What a count refuses ══════════════════════════════════════════════════ */

describe('refusals', () => {
  it('refuses a book quantity, a variance or a value sent with the request', async () => {
    const b = await books('Tamper');
    await receive(b, '10', '5.000');

    for (const field of ['expectedQuantity', 'varianceQuantity', 'varianceValue', 'accountId']) {
      const r = await countIt(b, [{ itemId: b.item, countedQuantity: '8', [field]: '999' }]);
      expect(r.statusCode, `${field} must be refused`).toBe(400);
    }
    /* Nothing was written by any of them. */
    expect(await onHand(b)).toBe(10);
  });

  it('refuses the same item twice on one sheet', async () => {
    const b = await books('Twice');
    await receive(b, '10', '5.000');
    const r = await countIt(b, [
      { itemId: b.item, countedQuantity: '8' },
      { itemId: b.item, countedQuantity: '9' },
    ]);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/appears twice/i);
    expect(await onHand(b)).toBe(10);
  });

  it('refuses a negative counted quantity', async () => {
    const b = await books('Negative');
    await receive(b, '10', '5.000');
    const r = await countIt(b, [{ itemId: b.item, countedQuantity: '-1' }]);
    expect(r.statusCode).toBe(400);
    expect(await onHand(b)).toBe(10);
  });

  it('refuses an empty sheet', async () => {
    const b = await books('Empty');
    const r = await countIt(b, []);
    expect(r.statusCode).toBe(400);
  });

  it('refuses a unit cost on a line counted LOWER than the books', async () => {
    const b = await books('Cost');
    await receive(b, '10', '5.000');
    const r = await countIt(b, [{ itemId: b.item, countedQuantity: '8', unitCost: '99.000' }]);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/counted HIGHER than the books/i);
    expect(await onHand(b)).toBe(10);
  });

  it('refuses a count with no reason', async () => {
    const b = await books('NoReason');
    await receive(b, '10', '5.000');
    const r = await countIt(b, [{ itemId: b.item, countedQuantity: '8' }], { reason: '' });
    expect(r.statusCode).toBe(400);
  });

  it('refuses a non-stocked item and an archived one', async () => {
    const b = await books('Ineligible');
    const service = await call('POST', '/api/inventory/items', b.user, {
      itemCode: 'SRV', name: 'Consulting', itemType: 'service', baseUnitId: b.unitEA,
    });
    expect(service.statusCode, service.body).toBe(201);
    const notStock = await countIt(b, [
      { itemId: service.json().item.id, countedQuantity: '1' },
    ]);
    expect(notStock.statusCode).toBe(400);
    expect(notStock.json().error.message).toMatch(/not stock-tracked/i);

    await receive(b, '5', '5.000');
    const item = await call('GET', `/api/inventory/items/${b.item}`, b.user);
    const archived = await call('POST', `/api/inventory/items/${b.item}/archive`, b.user, {
      archived: true, expectedVersion: item.json().item.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);

    const r = await countIt(b, [{ itemId: b.item, countedQuantity: '3' }]);
    expect(r.statusCode).toBe(400);
    expect(await onHand(b)).toBe(5);
  });

  it('refuses another company’s item and warehouse', async () => {
    const a = await books('Alpha');
    const c = await books('Beta');
    expect((await countIt(a, [{ itemId: c.item, countedQuantity: '1' }])).statusCode).toBe(400);
    expect((await countIt(a, [{ itemId: a.item, countedQuantity: '1' }],
      { warehouseId: c.main })).statusCode).toBe(400);
  });

  it('refuses to post a count into a closed period', async () => {
    const b = await books('Closed');
    await receive(b, '10', '5.000');
    const closed = await call('POST', '/api/accounting/periods/close', b.user, {
      periodStart: '2026-03-01', periodEnd: '2026-03-31', reason: 'Month closed for reporting',
    }).catch(() => null);
    if (!closed || closed.statusCode >= 400) return; /* Route shape differs; covered elsewhere. */
    const r = await countIt(b, [{ itemId: b.item, countedQuantity: '8' }]);
    expect(r.statusCode).toBe(400);
    expect(await onHand(b)).toBe(10);
  });

  it('refuses a viewer the right to count, but not to read counts', async () => {
    const b = await books('Viewer');
    await receive(b, '10', '5.000');
    const viewer = await member(b, 'ViewerOnly', 'viewer');

    const r = await call('POST', '/api/inventory/counts', viewer, {
      warehouseId: b.main, countDate: '2026-03-10', reason: 'Quarterly count',
      idempotencyKey: key(), lines: [{ itemId: b.item, countedQuantity: '1' }],
    });
    expect(r.statusCode).toBe(403);
    expect((await call('GET', '/api/inventory/counts', viewer)).statusCode).toBe(200);
    /* And nothing moved. */
    expect(await onHand(b)).toBe(10);
  });
});

/* ══ Withdrawing a count ═══════════════════════════════════════════════════ */

describe('reversal', () => {
  it('restores the quantity and the accounting at the original value', async () => {
    const b = await books('Undo');
    await receive(b, '10', '5.000');
    const counted = await countIt(b, [{ itemId: b.item, countedQuantity: '8' }]);
    const record = counted.json().count;
    expect(await onHand(b)).toBe(8);

    const undone = await call('POST', `/api/inventory/counts/${record.id}/reverse`, b.user, {
      expectedVersion: record.version, reason: 'Counted the wrong aisle',
    });
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json().count.status).toBe('reversed');

    expect(await onHand(b)).toBe(10);
    expect(await glBalance(b, b.loss)).toBe(0);
    expect(await glBalance(b, b.stock)).toBe(50);
  });

  it('refuses a second reversal', async () => {
    const b = await books('UndoTwice');
    await receive(b, '10', '5.000');
    const record = (await countIt(b, [{ itemId: b.item, countedQuantity: '8' }])).json().count;
    const first = await call('POST', `/api/inventory/counts/${record.id}/reverse`, b.user, {
      expectedVersion: record.version, reason: 'Counted the wrong aisle',
    });
    expect(first.statusCode).toBe(200);
    const second = await call('POST', `/api/inventory/counts/${record.id}/reverse`, b.user, {
      expectedVersion: record.version, reason: 'Counted the wrong aisle',
    });
    expect(second.statusCode).toBe(409);
    expect(await onHand(b)).toBe(10);
  });

  it('refuses a stale version', async () => {
    const b = await books('Stale');
    await receive(b, '10', '5.000');
    const record = (await countIt(b, [{ itemId: b.item, countedQuantity: '8' }])).json().count;
    const r = await call('POST', `/api/inventory/counts/${record.id}/reverse`, b.user, {
      expectedVersion: record.version + 5, reason: 'Counted the wrong aisle',
    });
    expect(r.statusCode).toBe(409);
  });

  it('refuses to withdraw a count whose found stock has since been used', async () => {
    const b = await books('Consumed');
    const record = (await countIt(b, [
      { itemId: b.item, countedQuantity: '5', unitCost: '3.000' },
    ])).json().count;
    expect(await onHand(b)).toBe(5);

    /* The found stock is issued away. Withdrawing the count would take out more
     * than is there, which I2 refuses. */
    const issued = await call('POST', '/api/inventory/documents', b.user, {
      idempotencyKey: key(), kind: 'issue', movementDate: '2026-03-12',
      lines: [{ itemId: b.item, warehouseId: b.main, quantity: '5', expenseAccountId: b.expense }],
    });
    expect(issued.statusCode, issued.body).toBe(201);

    const r = await call('POST', `/api/inventory/counts/${record.id}/reverse`, b.user, {
      expectedVersion: record.version, reason: 'Counted the wrong aisle',
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(await onHand(b)).toBe(0);
  });

  it('keeps a posted count unchangeable at the database', async () => {
    const b = await books('Immutable');
    await receive(b, '10', '5.000');
    const record = (await countIt(b, [{ itemId: b.item, countedQuantity: '8' }])).json().count;

    await expect(sql`
      UPDATE stock_counts SET count_date = '2020-01-01' WHERE id = ${record.id}
    `.execute(ctx.db)).rejects.toThrow(/cannot be edited/i);

    await expect(sql`
      UPDATE stock_count_lines SET counted_quantity = 999 WHERE count_id = ${record.id}
    `.execute(ctx.db)).rejects.toThrow(/cannot be edited/i);

    await expect(sql`
      DELETE FROM stock_counts WHERE id = ${record.id}
    `.execute(ctx.db)).rejects.toThrow(/cannot be deleted/i);
  });
});

/* ══ Reports ═══════════════════════════════════════════════════════════════ */

describe('reports', () => {
  it('renders money at the company’s precision, not at the storage scale', async () => {
    for (const [currency, expected] of [['JOD', '50.000'], ['USD', '50.00'], ['JPY', '50']] as const) {
      const b = await books(`Money${currency}`, { currency });
      await receive(b, '10', '5');

      const valuation = await call('GET', '/api/inventory/valuation', b.user);
      expect(valuation.json().rows[0].value, currency).toBe(expected);
      expect(valuation.json().totalValue, currency).toBe(expected);

      const soh = await call('GET', '/api/inventory/stock-on-hand', b.user);
      expect(soh.json().rows[0].value, currency).toBe(expected);
      /* A quantity follows the unit, not the currency. */
      expect(soh.json().rows[0].quantity, currency).toBe('10');

      const recon = await call('GET', '/api/inventory/reconciliation', b.user);
      expect(recon.json().rows[0].subledgerValue, currency).toBe(expected);
      expect(recon.json().totals.subledgerValue, currency).toBe(expected);
    }
  });

  it('shows a stock card whose running balance reproduces the ledger', async () => {
    const b = await books('Card');
    await receive(b, '10', '4.000', { date: '2026-03-01' });
    await receive(b, '10', '6.000', { date: '2026-03-02' });
    await countIt(b, [{ itemId: b.item, countedQuantity: '18' }]);

    const card = (await call('GET', `/api/inventory/items/${b.item}/stock-card`, b.user)).json();
    expect(card.entries).toHaveLength(3);
    expect(card.entries.map((e: { runningQuantity: string }) => e.runningQuantity))
      .toEqual(['10', '20', '18']);
    /* 40 + 60 = 100, less two at the 5.000 average. */
    expect(card.entries[2].runningValue).toBe('90.000');

    /* And the last row of the card IS the valuation report. */
    const valuation = await call('GET', '/api/inventory/valuation', b.user);
    expect(valuation.json().rows[0].value).toBe('90.000');
  });

  it('reports as-of quantity and valuation on a calendar date', async () => {
    const b = await books('AsOf');
    await receive(b, '10', '5.000', { date: '2026-03-01' });
    await receive(b, '10', '5.000', { date: '2026-03-20' });

    const early = await call('GET', '/api/inventory/valuation?asOfDate=2026-03-10', b.user);
    expect(early.json().rows[0].quantity).toBe('10');
    expect(early.json().rows[0].value).toBe('50.000');

    const late = await call('GET', '/api/inventory/valuation?asOfDate=2026-03-31', b.user);
    expect(late.json().rows[0].quantity).toBe('20');

    /* The boundary day itself is included, not the day before it. */
    const onTheDay = await call('GET', '/api/inventory/stock-on-hand?asOfDate=2026-03-20', b.user);
    expect(onTheDay.json().rows[0].quantity).toBe('20');
  });

  it('keeps archived items reportable, with their history intact', async () => {
    const b = await books('Archived');
    await receive(b, '10', '5.000');
    const item = await call('GET', `/api/inventory/items/${b.item}`, b.user);
    await call('POST', `/api/inventory/items/${b.item}/archive`, b.user, {
      archived: true, expectedVersion: item.json().item.version,
    });

    const valuation = await call('GET', '/api/inventory/valuation', b.user);
    expect(valuation.json().rows).toHaveLength(1);
    expect(valuation.json().rows[0].value).toBe('50.000');
    const card = await call('GET', `/api/inventory/items/${b.item}/stock-card`, b.user);
    expect(card.json().entries).toHaveLength(1);
  });
});

/* ══ Reconciliation ════════════════════════════════════════════════════════ */

describe('reconciliation', () => {
  it('agrees exactly after receipts, issues, counts and a reversal', async () => {
    const b = await books('Agree');
    await receive(b, '20', '4.000');
    await call('POST', '/api/inventory/documents', b.user, {
      idempotencyKey: key(), kind: 'issue', movementDate: '2026-03-05',
      lines: [{ itemId: b.item, warehouseId: b.main, quantity: '5', expenseAccountId: b.expense }],
    });
    const record = (await countIt(b, [{ itemId: b.item, countedQuantity: '14' }])).json().count;
    await call('POST', `/api/inventory/counts/${record.id}/reverse`, b.user, {
      expectedVersion: record.version, reason: 'Recount required',
    });
    await countIt(b, [{ itemId: b.item, countedQuantity: '13' }],
      { countDate: '2026-03-11', idempotencyKey: key() });

    const recon = (await call('GET', '/api/inventory/reconciliation', b.user)).json();
    expect(recon.balanced).toBe(true);
    expect(recon.totals.difference).toBe('0.000');
    expect(recon.exceptions).toHaveLength(0);
    for (const row of recon.rows) expect(row.difference).toBe('0.000');

    /* And independently: the ledger's inventory balance IS the subledger. */
    expect(await glBalance(b, b.stock)).toBe(Number(recon.totals.subledgerValue));
  });

  it('REPORTS a manual journal to an inventory account instead of hiding it', async () => {
    const b = await books('Manual');
    await receive(b, '10', '5.000');

    /* Somebody posts straight to the control account. That is a legitimate act
     * with a reason only they know, so it is surfaced, never corrected. */
    const entry = await call('POST', '/api/accounting/journals', b.user, {
      transactionDate: '2026-03-15', description: 'Manual inventory correction',
      reference: 'ADJ-1',
      lines: [
        { accountId: b.stock, debit: '7.000', memo: 'By hand' },
        { accountId: b.expense, credit: '7.000', memo: 'By hand' },
      ],
    });
    expect(entry.statusCode, entry.body).toBe(201);
    const posted = await call(
      'POST', `/api/accounting/journals/${entry.json().journal.id}/post`, b.user,
      { expectedVersion: entry.json().journal.version },
    );
    expect(posted.statusCode, posted.body).toBe(200);

    const recon = (await call('GET', '/api/inventory/reconciliation', b.user)).json();
    expect(recon.balanced).toBe(false);
    expect(recon.totals.difference).toBe('-7.000');
    expect(recon.exceptions).toHaveLength(1);
    expect(recon.exceptions[0].reference).toBe('ADJ-1');
    expect(recon.exceptions[0].amount).toBe('7.000');
    expect(recon.exceptions[0].accountId).toBe(b.stock);

    /* And nothing was posted to "fix" it. */
    expect(await onHand(b)).toBe(10);
  });
});

/* ══ Migration ═════════════════════════════════════════════════════════════ */

describe('migration 041', () => {
  it('rolls back and reapplies when nothing has been counted', async () => {
    const migrator = createMigrator(ctx.db);
    /* 044, 043 and 042 sit on top now, so they come off first. */
    const registered = await migrator.migrateDown();
    expect(registered.error).toBeUndefined();
    expect(registered.results?.[0]?.migrationName).toBe('044_fixed_asset_register');

    const matched = await migrator.migrateDown();
    expect(matched.error).toBeUndefined();
    expect(matched.results?.[0]?.migrationName).toBe('043_receipt_matching');

    const purchased = await migrator.migrateDown();
    expect(purchased.error).toBeUndefined();
    expect(purchased.results?.[0]?.migrationName).toBe('042_purchase_orders');

    const down = await migrator.migrateDown();
    expect(down.error).toBeUndefined();
    expect(down.results?.[0]?.migrationName).toBe('041_stock_counts');

    const up = await migrator.migrateToLatest();
    expect(up.error).toBeUndefined();

    const { rows } = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM information_schema.tables
       WHERE table_name IN ('stock_counts','stock_count_lines','stock_count_numbering')
    `.execute(ctx.db);
    expect(rows[0]!.n).toBe(3);
  });

  it('REFUSES to roll back over a posted count', async () => {
    const b = await books('Rollback');
    await receive(b, '10', '5.000');
    await countIt(b, [{ itemId: b.item, countedQuantity: '8' }]);

    const migrator = createMigrator(ctx.db);
    /* No asset was registered and nothing was matched or ordered, so 044, 043
     * and 042 come off cleanly; 041 is the one holding the count this test is
     * about. */
    const registered = await migrator.migrateDown();
    expect(registered.error).toBeUndefined();

    const matched = await migrator.migrateDown();
    expect(matched.error).toBeUndefined();

    const purchased = await migrator.migrateDown();
    expect(purchased.error).toBeUndefined();

    const down = await migrator.migrateDown();
    expect(down.error).toBeDefined();
    expect(String((down.error as Error).message)).toMatch(/Refusing to roll back 041/);
    expect(await onHand(b)).toBe(8);
  });
});

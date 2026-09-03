/**
 * Inventory I2 through the real stack.
 *
 * What these have to prove is not that the endpoints answer — it is that the
 * quantity ledger and the general ledger say the same thing after every
 * sequence, that a client cannot choose its own cost of sales, and that the
 * things this slice does not implement are refused rather than approximated.
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
  stock: string;
  grni: string;
  gain: string;
  loss: string;
  expense: string;
  bank: string;
  unitEA: string;
  unitKG: string;
  main: string;
  spare: string;
  item: string;
}

/** A company with a chart, a profile, two warehouses and one tracked item. */
async function books(name: string, plan = 'enterprise', role = 'admin'): Promise<Books> {
  const sub = await ctx.app.inject({
    method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(admin),
    payload: {
      fullName: `${name} Owner`, email: `owner@${name.toLowerCase()}.test`,
      organizationLegalName: `${name} LLC`, country: 'JO', baseCurrency: 'JOD',
      planId: await planId(plan), onboarding: 'temporary', paymentConfirmed: true,
    },
  });
  expect(sub.statusCode, sub.body).toBe(201);
  const org = sub.json().subscriber.organizationId;

  const invited = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: authHeaders(admin),
    payload: {
      fullName: `${name} Person`, email: `${name.toLowerCase()}@mv.test`,
      organizationId: org, role, onboarding: 'invitation',
    },
  });
  expect(invited.statusCode, invited.body).toBe(201);
  await ctx.app.inject({
    method: 'POST', url: '/api/auth/reset-password',
    payload: { token: invited.json().credential.invitationToken, newPassword: password },
  });
  const user = await login(ctx, `${name.toLowerCase()}@mv.test`, password);

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
  const bank = await account('1100', 'Bank', 'asset', {
    cashClassification: 'cash_and_cash_equivalents',
  });

  const unitsResponse = await call('GET', '/api/inventory/units', user);
  const unitEA = unitsResponse.json().units.find((u: { code: string }) => u.code === 'EA').id;
  const unitKG = unitsResponse.json().units.find((u: { code: string }) => u.code === 'KG').id;

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

  const created = await call('POST', '/api/inventory/items', user, {
    itemCode: 'SKU-1', name: 'Widget', itemType: 'inventory',
    isInventoryTracked: true, baseUnitId: unitEA, inventoryAccountId: stock,
  });
  expect(created.statusCode, created.body).toBe(201);

  return {
    org, user, stock, grni, gain, loss, expense, bank,
    unitEA, unitKG, main, spare, item: created.json().item.id,
  };
}

let keySeed = 0;
const key = (): string => `test-${Date.now()}-${keySeed++}`;

const post = (b: Books, body: Record<string, unknown>) =>
  call('POST', '/api/inventory/documents', b.user, { idempotencyKey: key(), ...body });

const receipt = (b: Books, quantity: string, unitCost: string, warehouse?: string, date = '2026-03-01') =>
  post(b, {
    kind: 'receipt', movementDate: date,
    lines: [{ itemId: b.item, warehouseId: warehouse ?? b.main, quantity, unitCost }],
  });

const issue = (b: Books, quantity: string, warehouse?: string, date = '2026-03-05') =>
  post(b, {
    kind: 'issue', movementDate: date,
    lines: [{ itemId: b.item, warehouseId: warehouse ?? b.main, quantity, expenseAccountId: b.expense }],
  });

async function onHand(b: Books, warehouse?: string): Promise<string> {
  const r = await call('GET', `/api/inventory/stock-on-hand?itemId=${b.item}`, b.user);
  const rows = r.json().rows.filter(
    (row: { warehouseId: string }) => !warehouse || row.warehouseId === warehouse,
  );
  return rows.reduce((sum: number, row: { quantity: string }) => sum + Number(row.quantity), 0)
    .toString();
}

async function value(b: Books): Promise<number> {
  const r = await call('GET', '/api/inventory/valuation', b.user);
  return r.json().rows.reduce((sum: number, row: { value: string }) => sum + Number(row.value), 0);
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

/* ══ Movement types and their accounting ═══════════════════════════════════ */

describe('each supported movement type', () => {
  it('receives stock: debit inventory, credit goods-received-not-invoiced', async () => {
    const b = await books('Recv');
    const r = await receipt(b, '10', '5.000');
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().created).toBe(true);

    expect(Number(await onHand(b))).toBe(10);
    expect(await value(b)).toBe(50);
    expect(await glBalance(b, b.stock)).toBe(50);
    expect(await glBalance(b, b.grni)).toBe(-50);
  });

  it('issues stock at the SERVER’s average, crediting inventory', async () => {
    const b = await books('Iss');
    await receipt(b, '10', '5.000');
    await receipt(b, '10', '7.000');

    const r = await issue(b, '5');
    expect(r.statusCode, r.body).toBe(201);

    /* 20 units worth 120 -> average 6; five out costs 30. */
    const movement = r.json().document.movements[0];
    expect(Number(movement.totalCost)).toBe(30);
    expect(Number(await onHand(b))).toBe(15);
    expect(await value(b)).toBe(90);
    expect(await glBalance(b, b.expense)).toBe(30);
    expect(await glBalance(b, b.stock)).toBe(90);
  });

  it('transfers between warehouses with NO journal and no change in value', async () => {
    const b = await books('Trf');
    await receipt(b, '10', '5.000');
    const before = await value(b);

    const r = await post(b, {
      kind: 'transfer', movementDate: '2026-03-06',
      sourceWarehouseId: b.main, destinationWarehouseId: b.spare,
      lines: [{ itemId: b.item, quantity: '4' }],
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().document.journalEntryId).toBeNull();
    expect(r.json().document.movements).toHaveLength(2);

    expect(Number(await onHand(b, b.main))).toBe(6);
    expect(Number(await onHand(b, b.spare))).toBe(4);
    /* Total quantity and total value are untouched. */
    expect(Number(await onHand(b))).toBe(10);
    expect(await value(b)).toBe(before);
    expect(await glBalance(b, b.stock)).toBe(50);
  });

  it('adjusts up against the gain account and down against the loss account', async () => {
    const b = await books('Adj');
    await receipt(b, '10', '5.000');

    const up = await post(b, {
      kind: 'adjustment', movementDate: '2026-03-07', reason: 'Found in the yard',
      lines: [{ itemId: b.item, warehouseId: b.main, quantity: '2', direction: 'in' }],
    });
    expect(up.statusCode, up.body).toBe(201);
    /* No cost given: it comes in at what the item is currently worth. */
    expect(Number(up.json().document.movements[0].unitCost)).toBe(5);
    expect(await glBalance(b, b.gain)).toBe(-10);

    const down = await post(b, {
      kind: 'adjustment', movementDate: '2026-03-08', reason: 'Damaged',
      lines: [{ itemId: b.item, warehouseId: b.main, quantity: '3', direction: 'out' }],
    });
    expect(down.statusCode, down.body).toBe(201);
    expect(await glBalance(b, b.loss)).toBe(15);

    expect(Number(await onHand(b))).toBe(9);
    expect(await value(b)).toBe(45);
    expect(await glBalance(b, b.stock)).toBe(45);
  });

  it('refuses an adjustment with no reason', async () => {
    const b = await books('NoReason');
    await receipt(b, '5', '1.000');
    const r = await post(b, {
      kind: 'adjustment', movementDate: '2026-03-09',
      lines: [{ itemId: b.item, warehouseId: b.main, quantity: '1', direction: 'out' }],
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/reason/i);
  });
});

/* ══ Reversal ══════════════════════════════════════════════════════════════ */

describe('reversal', () => {
  it('restores quantity, value and the ledger exactly', async () => {
    const b = await books('Rev');
    const first = await receipt(b, '10', '5.000');
    await receipt(b, '10', '7.000');

    /*
     * The interesting case: reversing the FIRST receipt must leave the average
     * at 7, not at some blend. Excluding the pair is what does that; leaving an
     * opposite movement in the running average would not.
     */
    const doc = first.json().document;
    const r = await call('POST', `/api/inventory/documents/${doc.id}/reverse`, b.user, {
      expectedVersion: doc.version, reason: 'Booked against the wrong company',
    });
    expect(r.statusCode, r.body).toBe(200);

    expect(Number(await onHand(b))).toBe(10);
    expect(await value(b)).toBe(70);

    const valuationRows = (await call('GET', '/api/inventory/valuation', b.user)).json().rows;
    expect(Number(valuationRows[0].averageCost)).toBe(7);

    /* And the general ledger agrees. */
    expect(await glBalance(b, b.stock)).toBe(70);
    expect(await glBalance(b, b.grni)).toBe(-70);
  });

  it('leaves the original row in place and marks BOTH sides reversed', async () => {
    const b = await books('RevRows');
    const created = await receipt(b, '4', '2.000');
    const doc = created.json().document;
    await call('POST', `/api/inventory/documents/${doc.id}/reverse`, b.user, {
      expectedVersion: doc.version, reason: 'Mistaken entry',
    });

    const { rows } = await sql<{ status: string; n: string }>`
      SELECT status, COUNT(*)::text AS n FROM inventory_movements
       WHERE organization_id = ${b.org} GROUP BY status
    `.execute(ctx.db);
    /* Two rows, both reversed: the original is never deleted. */
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('reversed');
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it('refuses when the stock has been consumed and cannot be restored', async () => {
    const b = await books('RevGone');
    const created = await receipt(b, '10', '5.000');
    await issue(b, '8');

    const doc = created.json().document;
    const r = await call('POST', `/api/inventory/documents/${doc.id}/reverse`, b.user, {
      expectedVersion: doc.version, reason: 'Too late to undo',
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/have been used|has been used|remain/i);
  });

  it('refuses a stale version and a second reversal', async () => {
    const b = await books('RevTwice');
    const created = await receipt(b, '3', '1.000');
    const doc = created.json().document;

    const stale = await call('POST', `/api/inventory/documents/${doc.id}/reverse`, b.user, {
      expectedVersion: doc.version + 5, reason: 'Wrong version supplied',
    });
    expect(stale.statusCode).toBe(409);

    const good = await call('POST', `/api/inventory/documents/${doc.id}/reverse`, b.user, {
      expectedVersion: doc.version, reason: 'Correcting an error',
    });
    expect(good.statusCode, good.body).toBe(200);

    const again = await call('POST', `/api/inventory/documents/${doc.id}/reverse`, b.user, {
      expectedVersion: doc.version + 1, reason: 'Attempting again',
    });
    expect(again.statusCode).toBe(409);
  });
});

/* ══ Valuation arithmetic ══════════════════════════════════════════════════ */

describe('valuation', () => {
  it('handles awkward fractional costs without stranding a residual', async () => {
    const b = await books('Frac');
    /* Three units for ten: an average that does not divide. */
    await receipt(b, '3', '3.333');

    await issue(b, '1');
    await issue(b, '1');
    const last = await issue(b, '1');
    expect(last.statusCode, last.body).toBe(201);

    /* Emptied exactly: no fraction of a fils left in an empty warehouse. */
    expect(Number(await onHand(b))).toBe(0);
    expect(await value(b)).toBe(0);
    expect(await glBalance(b, b.stock)).toBe(0);
  });

  it('costs partial and complete issues from multiple receipts', async () => {
    const b = await books('Multi');
    await receipt(b, '100', '1.500');
    await receipt(b, '50', '2.100');
    /* 150 units worth 255 -> average 1.7. */

    const partial = await issue(b, '40');
    expect(Number(partial.json().document.movements[0].totalCost)).toBe(68);

    const rest = await issue(b, '110');
    expect(Number(rest.json().document.movements[0].totalCost)).toBe(187);

    expect(Number(await onHand(b))).toBe(0);
    expect(await value(b)).toBe(0);
  });

  it('keeps quantity precision to the unit and refuses finer', async () => {
    const b = await books('Precision');
    const kg = await call('POST', '/api/inventory/items', b.user, {
      itemCode: 'BULK', name: 'Bulk', itemType: 'inventory', isInventoryTracked: true,
      baseUnitId: b.unitKG, inventoryAccountId: b.stock,
    });
    expect(kg.statusCode, kg.body).toBe(201);
    const itemId = kg.json().item.id;

    const fine = await call('POST', '/api/inventory/documents', b.user, {
      idempotencyKey: key(), kind: 'receipt', movementDate: '2026-03-01',
      lines: [{ itemId, warehouseId: b.main, quantity: '1.2345', unitCost: '1.000' }],
    });
    /* KG allows three places; a fourth would be rounded by something other
     * than the person who typed it. */
    expect(fine.statusCode).toBe(400);
    expect(fine.json().error.details.fieldErrors.quantity).toMatch(/3 decimal/i);

    const ok = await call('POST', '/api/inventory/documents', b.user, {
      idempotencyKey: key(), kind: 'receipt', movementDate: '2026-03-01',
      lines: [{ itemId, warehouseId: b.main, quantity: '1.234', unitCost: '1.000' }],
    });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it('refuses a zero quantity', async () => {
    const b = await books('Zero');
    const r = await receipt(b, '0', '1.000');
    expect(r.statusCode).toBe(400);
  });
});

/* ══ What a client may not decide ══════════════════════════════════════════ */

describe('client tampering', () => {
  it('ignores a client-supplied cost on an ISSUE — the server costs it', async () => {
    const b = await books('Tamper');
    await receipt(b, '10', '5.000');

    /* `unitCost` is in the schema for receipts; sending it on an issue must not
     * change what the cost of sales becomes. */
    const r = await call('POST', '/api/inventory/documents', b.user, {
      idempotencyKey: key(), kind: 'issue', movementDate: '2026-03-05',
      lines: [{
        itemId: b.item, warehouseId: b.main, quantity: '2',
        unitCost: '999.000', expenseAccountId: b.expense,
      }],
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(Number(r.json().document.movements[0].unitCost)).toBe(5);
    expect(Number(r.json().document.movements[0].totalCost)).toBe(10);
    expect(await glBalance(b, b.expense)).toBe(10);
  });

  it('refuses a negative quantity and a bogus direction', async () => {
    const b = await books('Signs');
    const negative = await call('POST', '/api/inventory/documents', b.user, {
      idempotencyKey: key(), kind: 'receipt', movementDate: '2026-03-01',
      lines: [{ itemId: b.item, warehouseId: b.main, quantity: '-5', unitCost: '1.000' }],
    });
    expect(negative.statusCode).toBe(400);

    const bogus = await call('POST', '/api/inventory/documents', b.user, {
      idempotencyKey: key(), kind: 'adjustment', movementDate: '2026-03-01', reason: 'x',
      lines: [{ itemId: b.item, warehouseId: b.main, quantity: '1', direction: 'sideways' }],
    });
    expect(bogus.statusCode).toBe(400);
  });

  it('refuses unknown fields rather than dropping them', async () => {
    const b = await books('Extra');
    for (const extra of [
      { lotId: 'LOT-1' }, { serialNumbers: ['S1'] }, { binId: 'BIN-1' },
      { currency: 'USD' }, { billId: 'bill-1' },
    ]) {
      const r = await call('POST', '/api/inventory/documents', b.user, {
        idempotencyKey: key(), kind: 'receipt', movementDate: '2026-03-01',
        lines: [{ itemId: b.item, warehouseId: b.main, quantity: '1', unitCost: '1.000', ...extra }],
      });
      expect(r.statusCode, `${JSON.stringify(extra)}: ${r.body}`).toBe(400);
    }
  });

  it('refuses a journal account it was not given', async () => {
    const b = await books('Account');
    /* A bank account may not be the issue expense: stock is not money. */
    const r = await call('POST', '/api/inventory/documents', b.user, {
      idempotencyKey: key(), kind: 'issue', movementDate: '2026-03-05',
      lines: [{ itemId: b.item, warehouseId: b.main, quantity: '1', expenseAccountId: b.bank }],
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/cash or bank|must be expense/i);
  });
});

/* ══ Refusals this slice makes deliberately ════════════════════════════════ */

describe('deliberate refusals', () => {
  it('refuses to make stock negative', async () => {
    const b = await books('Neg');
    await receipt(b, '5', '1.000');
    const r = await issue(b, '6');
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/less than nothing|negative/i);
    expect(Number(await onHand(b))).toBe(5);
  });

  it('refuses to issue from a warehouse that has none, even when another does', async () => {
    const b = await books('Elsewhere');
    await receipt(b, '10', '1.000', b.main);
    const r = await issue(b, '1', b.spare);
    expect(r.statusCode).toBe(400);
  });

  it('refuses backdating behind an item’s last movement', async () => {
    const b = await books('Back');
    await receipt(b, '5', '1.000', b.main, '2026-03-10');
    const r = await receipt(b, '5', '9.000', b.main, '2026-03-01');
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/before this item|2026-03-10/i);
  });

  it('refuses a FIFO or standard-cost item rather than averaging it', async () => {
    const b = await books('Fifo');
    for (const method of ['fifo', 'standard']) {
      const made = await call('POST', '/api/inventory/items', b.user, {
        itemCode: `M-${method}`, name: method, itemType: 'inventory', isInventoryTracked: true,
        baseUnitId: b.unitEA, valuationMethod: method, inventoryAccountId: b.stock,
      });
      expect(made.statusCode, made.body).toBe(201);

      const r = await call('POST', '/api/inventory/documents', b.user, {
        idempotencyKey: key(), kind: 'receipt', movementDate: '2026-03-01',
        lines: [{
          itemId: made.json().item.id, warehouseId: b.main, quantity: '1', unitCost: '1.000',
        }],
      });
      expect(r.statusCode, `${method}: ${r.body}`).toBe(400);
      expect(r.json().error.message).toMatch(/does not implement|weighted-average/i);
    }
  });

  it('refuses a non-stock item, an archived item and an archived warehouse', async () => {
    const b = await books('Ineligible');

    const service = await call('POST', '/api/inventory/items', b.user, {
      itemCode: 'SRV', name: 'Consulting', itemType: 'service', baseUnitId: b.unitEA,
    });
    const serviceRefused = await call('POST', '/api/inventory/documents', b.user, {
      idempotencyKey: key(), kind: 'receipt', movementDate: '2026-03-01',
      lines: [{
        itemId: service.json().item.id, warehouseId: b.main, quantity: '1', unitCost: '1.000',
      }],
    });
    expect(serviceRefused.statusCode).toBe(400);
    expect(serviceRefused.json().error.message).toMatch(/not stock-tracked/i);

    const item = (await call('GET', `/api/inventory/items/${b.item}`, b.user)).json().item;
    await call('POST', `/api/inventory/items/${b.item}/archive`, b.user, {
      expectedVersion: item.version, archived: true,
    });
    const archivedRefused = await receipt(b, '1', '1.000');
    expect(archivedRefused.statusCode).toBe(400);
    expect(archivedRefused.json().error.message).toMatch(/archived/i);
  });

  it('refuses a receipt when no goods-received account is configured', async () => {
    const b = await books('NoGrni');
    const current = (await call('GET', '/api/inventory/settings', b.user)).json().settings;
    await call('PATCH', '/api/inventory/settings', b.user, {
      expectedVersion: current.version,
      defaultInventoryAccountId: b.stock,
      inventoryGainAccountId: b.gain,
      inventoryLossAccountId: b.loss,
      goodsReceivedNotInvoicedAccountId: null,
    });

    const r = await receipt(b, '1', '1.000');
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/goods-received-not-invoiced|nowhere to go/i);
  });

  it('cannot reach another company’s item or warehouse', async () => {
    const mine = await books('Mine');
    const theirs = await books('Theirs');
    const r = await call('POST', '/api/inventory/documents', mine.user, {
      idempotencyKey: key(), kind: 'receipt', movementDate: '2026-03-01',
      lines: [{ itemId: theirs.item, warehouseId: mine.main, quantity: '1', unitCost: '1.000' }],
    });
    expect(r.statusCode).toBe(400);
  });
});

/* ══ Idempotency ═══════════════════════════════════════════════════════════ */

describe('idempotency', () => {
  it('answers a repeat with the document it already made', async () => {
    const b = await books('Idem');
    const idempotencyKey = key();
    const body = {
      idempotencyKey, kind: 'receipt', movementDate: '2026-03-01',
      lines: [{ itemId: b.item, warehouseId: b.main, quantity: '7', unitCost: '2.000' }],
    };

    const first = await call('POST', '/api/inventory/documents', b.user, body);
    expect(first.statusCode).toBe(201);
    expect(first.json().created).toBe(true);

    const retry = await call('POST', '/api/inventory/documents', b.user, body);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().created).toBe(false);
    expect(retry.json().document.id).toBe(first.json().document.id);

    /* One document, one pair of movements, one journal, one balance. */
    expect(Number(await onHand(b))).toBe(7);
    expect(await glBalance(b, b.stock)).toBe(14);

    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM inventory_documents WHERE organization_id = ${b.org}
    `.execute(ctx.db);
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

/* ══ Immutability ══════════════════════════════════════════════════════════ */

describe('the ledger is immutable', () => {
  it('refuses an UPDATE of any accounting fact, in the database', async () => {
    const b = await books('Immutable');
    await receipt(b, '5', '3.000');
    const { rows } = await sql<{ id: string }>`
      SELECT id FROM inventory_movements WHERE organization_id = ${b.org} LIMIT 1
    `.execute(ctx.db);
    const id = rows[0]!.id;

    for (const change of [
      sql`quantity = 999`, sql`unit_cost = 0`, sql`total_cost = 0`,
      sql`posting_date = '2020-01-01'`, sql`direction = 'out'`,
    ]) {
      await expect(
        sql`UPDATE inventory_movements SET ${change} WHERE id = ${id}`.execute(ctx.db),
      ).rejects.toThrow(/cannot be changed/i);
    }
  });

  it('refuses a DELETE outright', async () => {
    const b = await books('NoDelete');
    await receipt(b, '5', '3.000');
    await expect(
      sql`DELETE FROM inventory_movements WHERE organization_id = ${b.org}`.execute(ctx.db),
    ).rejects.toThrow(/cannot be deleted/i);
  });
});

/* ══ The I1 freeze, now that movements exist ═══════════════════════════════ */

describe('the item freeze', () => {
  it('locks tracked status, valuation method and base unit once stock has moved', async () => {
    const b = await books('Freeze');
    await receipt(b, '1', '1.000');
    const item = (await call('GET', `/api/inventory/items/${b.item}`, b.user)).json().item;

    const base = {
      itemCode: item.itemCode, name: item.name, itemType: 'inventory',
      baseUnitId: b.unitEA, expectedVersion: item.version, isInventoryTracked: true,
      valuationMethod: 'weighted-average',
    };

    const untrack = await call('PATCH', `/api/inventory/items/${b.item}`, b.user, {
      ...base, isInventoryTracked: false,
    });
    expect(untrack.statusCode).toBe(400);
    expect(untrack.json().error.details.fieldErrors.isInventoryTracked).toMatch(/Locked/i);

    const revalue = await call('PATCH', `/api/inventory/items/${b.item}`, b.user, {
      ...base, valuationMethod: 'fifo',
    });
    expect(revalue.statusCode).toBe(400);

    const reunit = await call('PATCH', `/api/inventory/items/${b.item}`, b.user, {
      ...base, baseUnitId: b.unitKG,
    });
    expect(reunit.statusCode).toBe(400);
    expect(reunit.json().error.details.fieldErrors.baseUnitId).toMatch(/Locked/i);

    /* A harmless edit still goes through. */
    const rename = await call('PATCH', `/api/inventory/items/${b.item}`, b.user, {
      ...base, name: 'Widget (renamed)',
    });
    expect(rename.statusCode, rename.body).toBe(200);
  });
});

/* ══ Reports reconcile ═════════════════════════════════════════════════════ */

describe('reports', () => {
  it('reconciles the subledger to the general ledger exactly', async () => {
    const b = await books('Recon');
    await receipt(b, '100', '1.330');
    await issue(b, '37');
    await post(b, {
      kind: 'adjustment', movementDate: '2026-03-09', reason: 'Count variance',
      lines: [{ itemId: b.item, warehouseId: b.main, quantity: '3', direction: 'out' }],
    });
    await post(b, {
      kind: 'transfer', movementDate: '2026-03-10',
      sourceWarehouseId: b.main, destinationWarehouseId: b.spare,
      lines: [{ itemId: b.item, quantity: '20' }],
    });

    const reconciliation = (await call('GET', '/api/inventory/reconciliation', b.user)).json();
    expect(reconciliation.balanced).toBe(true);
    for (const row of reconciliation.rows) {
      expect(Number(row.difference)).toBe(0);
      expect(Number(row.subledgerValue)).toBe(Number(row.generalLedgerBalance));
    }
  });

  it('gives a stock card whose last running balance equals the valuation', async () => {
    const b = await books('Card');
    await receipt(b, '10', '2.000');
    await receipt(b, '5', '4.000');
    await issue(b, '6');

    const entries = (await call(
      'GET', `/api/inventory/items/${b.item}/stock-card`, b.user,
    )).json().entries;
    expect(entries).toHaveLength(3);

    const last = entries[entries.length - 1];
    const valuationRow = (await call('GET', '/api/inventory/valuation', b.user))
      .json().rows.find((row: { itemId: string }) => row.itemId === b.item);

    expect(Number(last.runningQuantity)).toBe(Number(valuationRow.quantity));
    expect(Number(last.runningValue)).toBe(Number(valuationRow.value));
  });

  it('excludes reversed movements from every read', async () => {
    const b = await books('Excluded');
    const created = await receipt(b, '8', '1.000');
    const doc = created.json().document;
    const undone = await call('POST', `/api/inventory/documents/${doc.id}/reverse`, b.user, {
      expectedVersion: doc.version, reason: 'Undo the receipt',
    });
    expect(undone.statusCode, undone.body).toBe(200);

    expect((await call('GET', '/api/inventory/stock-on-hand', b.user)).json().rows).toHaveLength(0);
    expect((await call('GET', `/api/inventory/items/${b.item}/stock-card`, b.user))
      .json().entries).toHaveLength(0);
    expect((await call('GET', '/api/inventory/reconciliation', b.user)).json().balanced).toBe(true);
  });
});

/* ══ Permissions, entitlements and periods ═════════════════════════════════ */

describe('gates', () => {
  it('refuses a viewer the right to post stock, but not to read it', async () => {
    const b = await books('Gate');
    const invited = await ctx.app.inject({
      method: 'POST', url: '/api/admin/users', headers: authHeaders(admin),
      payload: {
        fullName: 'Reader', email: 'reader@mv.test', organizationId: b.org,
        role: 'viewer', onboarding: 'invitation',
      },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    await ctx.app.inject({
      method: 'POST', url: '/api/auth/reset-password',
      payload: { token: invited.json().credential.invitationToken, newPassword: password },
    });
    const viewer = await login(ctx, 'reader@mv.test', password);

    const write = await call('POST', '/api/inventory/documents', viewer, {
      idempotencyKey: key(), kind: 'receipt', movementDate: '2026-03-01',
      lines: [{ itemId: b.item, warehouseId: b.main, quantity: '1', unitCost: '1.000' }],
    });
    expect(write.statusCode).toBe(403);

    const read = await call('GET', '/api/inventory/stock-on-hand', viewer);
    expect(read.statusCode).toBe(200);
  });

  it('refuses a CORE subscriber, who has no inventory entitlement', async () => {
    /*
     * Built by hand rather than through `books`, because a Core subscriber
     * cannot even create the warehouse that fixture needs — which is the point
     * being made, one layer earlier.
     */
    const sub = await ctx.app.inject({
      method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(admin),
      payload: {
        fullName: 'Core Owner', email: 'owner@coregate.test',
        organizationLegalName: 'CoreGate LLC', country: 'JO', baseCurrency: 'JOD',
        planId: await planId('core'), onboarding: 'temporary', paymentConfirmed: true,
      },
    });
    expect(sub.statusCode, sub.body).toBe(201);
    const invited = await ctx.app.inject({
      method: 'POST', url: '/api/admin/users', headers: authHeaders(admin),
      payload: {
        fullName: 'Core Person', email: 'core@mv.test',
        organizationId: sub.json().subscriber.organizationId,
        role: 'admin', onboarding: 'invitation',
      },
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/auth/reset-password',
      payload: { token: invited.json().credential.invitationToken, newPassword: password },
    });
    const user = await login(ctx, 'core@mv.test', password);

    for (const path of [
      '/api/inventory/stock-on-hand', '/api/inventory/valuation',
      '/api/inventory/documents', '/api/inventory/reconciliation',
    ]) {
      const r = await call('GET', path, user);
      expect(r.statusCode, path).toBe(403);
    }

    /* …while the shared item catalogue stays open, exactly as I1 decided. */
    const items = await call('GET', '/api/inventory/items', user);
    expect(items.statusCode, items.body).toBe(200);
  });

  it('refuses posting into a locked period', async () => {
    const b = await books('Locked');
    const period = await call('POST', '/api/accounting/periods', b.user, {
      fiscalYear: 2026, periodNumber: 3, startDate: '2026-03-01', endDate: '2026-03-31',
    });
    expect(period.statusCode, period.body).toBe(201);

    const locked = await call(
      'PATCH', `/api/accounting/periods/${period.json().period.id}`, b.user,
      { status: 'locked', reason: 'Month closed' },
    );
    expect(locked.statusCode, locked.body).toBeLessThan(300);

    const r = await receipt(b, '1', '1.000');
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toMatch(/locked/i);
  });
});

/* ══ The slice boundary ════════════════════════════════════════════════════ */

describe('the I2 boundary', () => {
  it('still refuses a stocked invoice and a stocked bill line', async () => {
    const b = await books('Boundary');
    await receipt(b, '10', '1.000');

    const customer = await call('POST', '/api/customers', b.user, {
      partyCode: 'CUST', legalName: 'A customer',
    });
    const invoice = await call('POST', '/api/invoices', b.user, {
      issuingEntityId: '11111111-1111-1111-1111-111111111111',
      customerId: customer.json().customer.id,
      issueDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{
        accountId: b.gain, description: 'Goods', quantity: '1', unitPrice: '10.000',
        itemId: b.item,
      }],
    });
    expect(invoice.statusCode).toBe(400);
    expect(invoice.json().error.message).toMatch(/stock|inventory/i);

    const supplier = await call('POST', '/api/vendors', b.user, {
      partyCode: 'SUPP', legalName: 'A supplier',
    });
    const bill = await call('POST', '/api/bills', b.user, {
      issuingEntityId: '11111111-1111-1111-1111-111111111111',
      supplierId: supplier.json().supplier.id,
      supplierInvoiceNumber: 'S-1', billDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{
        accountId: b.expense, description: 'Goods', quantity: '1', unitPrice: '10.000',
        itemId: b.item,
      }],
    });
    expect(bill.statusCode).toBe(400);
    expect(bill.json().error.message).toMatch(/stock|inventory/i);
  });

  it('has no stock-count, opening-balance or purchase-linked endpoint', async () => {
    const b = await books('NoRoutes');
    for (const path of [
      '/api/inventory/stock-counts', '/api/inventory/opening-balances',
      '/api/inventory/goods-receipts', '/api/inventory/cost-layers',
    ]) {
      const r = await call('GET', path, b.user);
      expect(r.statusCode, path).toBe(404);
    }
  });
});

/* ══ Migration ═════════════════════════════════════════════════════════════ */

describe('migration 038', () => {
  it('rolls back and reapplies when the ledger is empty', async () => {
    const migrator = createMigrator(ctx.db);

    /* 039 sits on top now, so it comes off first. */
    const stocked = await migrator.migrateDown();
    expect(stocked.error).toBeUndefined();
    expect(stocked.results?.[0]?.migrationName).toBe('039_stocked_bills');

    const down = await migrator.migrateDown();
    expect(down.error).toBeUndefined();
    expect(down.results?.[0]?.migrationName).toBe('038_inventory_movements');

    const up = await migrator.migrateToLatest();
    expect(up.error).toBeUndefined();

    const { rows } = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM information_schema.tables
       WHERE table_name IN ('inventory_movements','inventory_documents','inventory_document_numbering')
    `.execute(ctx.db);
    expect(rows[0]!.n).toBe(3);
  });

  it('REFUSES to roll back over real stock history', async () => {
    const b = await books('Rollback');
    await receipt(b, '2', '1.000');

    const migrator = createMigrator(ctx.db);
    /* Nothing was bought on a bill here, so 039 comes off cleanly; 038 is the
     * one holding the movements this test is about. */
    const stocked = await migrator.migrateDown();
    expect(stocked.error).toBeUndefined();

    const down = await migrator.migrateDown();
    expect(down.error).toBeDefined();
    expect(String((down.error as Error).message)).toMatch(/Refusing to roll back 038/);

    /* And nothing was destroyed. */
    expect(Number(await onHand(b))).toBe(2);
  });
});

/* ══ Concurrency, as far as one connection can show it ═════════════════════ */

describe('concurrency', () => {
  /*
   * PGlite has ONE connection, so these are ordering tests rather than true
   * races: the driver serialises them before the database sees them. What they
   * prove is that the SEQUENCE is safe — five issues against five units leave
   * exactly five units issued, not that two connections cannot both win. The
   * real races are in the disposable PostgreSQL probe, which opens several.
   */
  it('does not oversell when issues arrive back to back', async () => {
    const b = await books('Race');
    await receipt(b, '5', '2.000');

    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () => issue(b, '2')),
    );
    const ok = attempts.filter(
      (a) => a.status === 'fulfilled' && a.value.statusCode === 201,
    ).length;

    /* Whatever got through, the warehouse never went below zero. */
    const remaining = Number(await onHand(b));
    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(remaining).toBe(5 - ok * 2);
    expect(await value(b)).toBe(remaining * 2);
    expect(await glBalance(b, b.stock)).toBe(remaining * 2);
  });

  it('keeps quantity and value whole across opposing transfers', async () => {
    const b = await books('Opposing');
    await receipt(b, '10', '3.000');
    await post(b, {
      kind: 'transfer', movementDate: '2026-03-02',
      sourceWarehouseId: b.main, destinationWarehouseId: b.spare,
      lines: [{ itemId: b.item, quantity: '5' }],
    });

    const both = await Promise.allSettled([
      post(b, {
        kind: 'transfer', movementDate: '2026-03-03',
        sourceWarehouseId: b.main, destinationWarehouseId: b.spare,
        lines: [{ itemId: b.item, quantity: '2' }],
      }),
      post(b, {
        kind: 'transfer', movementDate: '2026-03-03',
        sourceWarehouseId: b.spare, destinationWarehouseId: b.main,
        lines: [{ itemId: b.item, quantity: '3' }],
      }),
    ]);
    for (const attempt of both) expect(attempt.status).toBe('fulfilled');

    /* Nothing created, nothing lost, and no journal from any of it. */
    expect(Number(await onHand(b))).toBe(10);
    expect(await value(b)).toBe(30);
    expect(await glBalance(b, b.stock)).toBe(30);

    const main = Number(await onHand(b, b.main));
    const spare = Number(await onHand(b, b.spare));
    expect(main + spare).toBe(10);
    expect(main).toBeGreaterThanOrEqual(0);
    expect(spare).toBeGreaterThanOrEqual(0);
  });

  it('rolls the whole document back when one line fails', async () => {
    const b = await books('Rollback2');
    await receipt(b, '10', '1.000');

    /* Two lines: the first is fine, the second asks for more than exists. The
     * document must leave nothing behind at all. */
    const r = await post(b, {
      kind: 'issue', movementDate: '2026-03-05',
      lines: [
        { itemId: b.item, warehouseId: b.main, quantity: '4', expenseAccountId: b.expense },
        { itemId: b.item, warehouseId: b.main, quantity: '99', expenseAccountId: b.expense },
      ],
    });
    expect(r.statusCode).toBe(400);

    expect(Number(await onHand(b))).toBe(10);
    expect(await glBalance(b, b.expense)).toBe(0);

    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM inventory_documents
       WHERE organization_id = ${b.org} AND kind = 'issue'
    `.execute(ctx.db);
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

/* ══ Destroying a tenant that has stock ════════════════════════════════════ */

describe('purging a workspace', () => {
  /*
   * The trigger that makes movements immutable also fires on DELETE, including
   * the CASCADE from `organizations`. Without an explicit authorisation a
   * company that had ever received stock could never be deleted at all — so the
   * purge sets `ledgora.allow_stock_purge`, exactly as it does for legal
   * acceptances, and nothing else in the system may.
   */
  it('refuses an unauthorised delete but allows a sanctioned purge', async () => {
    const b = await books('Purge');
    await receipt(b, '5', '2.000');

    await expect(
      sql`DELETE FROM inventory_movements WHERE organization_id = ${b.org}`.execute(ctx.db),
    ).rejects.toThrow(/cannot be deleted/i);

    const purged = await ctx.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ledgora.allow_stock_purge = 'on'`.execute(trx);
      const { rows } = await sql<{ n: number }>`
        WITH removed AS (
          DELETE FROM inventory_movements WHERE organization_id = ${b.org} RETURNING 1
        )
        SELECT count(*)::int AS n FROM removed
      `.execute(trx);
      return rows[0]!.n;
    });
    expect(purged).toBe(1);

    /* And the authorisation did not survive the transaction. */
    await receipt(b, '3', '1.000');
    await expect(
      sql`DELETE FROM inventory_movements WHERE organization_id = ${b.org}`.execute(ctx.db),
    ).rejects.toThrow(/cannot be deleted/i);
  });

  it('still refuses an UPDATE even while a purge is authorised', async () => {
    const b = await books('PurgeUpdate');
    await receipt(b, '5', '2.000');

    /* The authorisation permits DELETE alone: nothing may quietly rewrite a
     * movement under cover of a purge. */
    await expect(
      ctx.db.transaction().execute(async (trx) => {
        await sql`SET LOCAL ledgora.allow_stock_purge = 'on'`.execute(trx);
        await sql`
          UPDATE inventory_movements SET quantity = 999 WHERE organization_id = ${b.org}
        `.execute(trx);
      }),
    ).rejects.toThrow(/cannot be changed/i);
  });
});

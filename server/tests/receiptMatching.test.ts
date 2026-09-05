/**
 * Advanced Purchasing AP2 through the real stack.
 *
 * What these have to prove is that a supplier bill turns an accrual into a debt
 * and does nothing else: it clears goods-received-not-invoiced for exactly the
 * value the receipt was costed at, recognises the payable and the recoverable
 * input tax once each, creates NO inventory movement, and refuses every shape
 * the product has no accounting for — a price the goods were not received at, a
 * quantity that never arrived, another supplier's delivery, a return.
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
const password = 'Quiet-Meridian-33-Kx';
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
  main: string;
  spare: string;
  item: string;
  itemB: string;
  supplier: string;
  supplierB: string;
  currency: string;
}

async function books(
  name: string,
  options: { plan?: string; role?: string; currency?: string; country?: string } = {},
): Promise<Books> {
  const plan = options.plan ?? 'enterprise';
  const currency = options.currency ?? 'JOD';
  const slug = name.toLowerCase();

  const sub = await ctx.app.inject({
    method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(admin),
    payload: {
      fullName: `${name} Owner`, email: `owner-${slug}@ap2.test`,
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
      fullName: `${name} Person`, email: `${slug}@ap2.test`,
      organizationId: org, role: options.role ?? 'admin', onboarding: 'invitation',
    },
  });
  expect(invited.statusCode, invited.body).toBe(201);
  await ctx.app.inject({
    method: 'POST', url: '/api/auth/reset-password',
    payload: { token: invited.json().credential.invitationToken, newPassword: password },
  });
  const user = await login(ctx, `${slug}@ap2.test`, password);

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

  const item = async (code: string, itemName: string): Promise<string> => {
    const r = await call('POST', '/api/inventory/items', user, {
      itemCode: code, name: itemName, itemType: 'inventory',
      isInventoryTracked: true, baseUnitId: unitEA, inventoryAccountId: stock,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().item.id;
  };

  const vendor = async (code: string, legalName: string): Promise<string> => {
    const r = await call('POST', '/api/vendors', user, {
      partyCode: code, legalName, supplier: { defaultPayableAccountId: payable },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().supplier.id;
  };

  return {
    org, user, stock, grni, payable, inputTax, expense, gain, loss, bank, main, spare,
    item: await item('SKU-1', 'Widget'),
    itemB: await item('SKU-2', 'Sprocket'),
    supplier: await vendor('ACME', 'Acme Supplies'),
    supplierB: await vendor('BETA', 'Beta Trading'),
    currency,
  };
}

/* ── Helpers ───────────────────────────────────────────────────────────────── */

let keySeed = 0;
const key = (): string => `ap2-${Date.now()}-${keySeed++}`;

interface Received {
  orderId: string;
  receiptId: string;
  receiptNumber: string;
  /** One entry per received line, in order. */
  lines: Array<{ receiptLineId: string; quantity: string; totalCost: string }>;
  version: number;
}

/** An issued order, received in full or in part, ready to be billed. */
async function received(
  b: Books,
  lines: Array<{ itemId?: string; warehouseId?: string; quantity: string; unitPrice: string }>,
  options: { receive?: string[]; supplierId?: string } = {},
): Promise<Received> {
  const created = await call('POST', '/api/purchasing/orders', b.user, {
    supplierId: options.supplierId ?? b.supplier,
    orderDate: '2026-03-01',
    lines: lines.map((line) => ({
      itemId: line.itemId ?? b.item,
      warehouseId: line.warehouseId ?? b.main,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
    })),
  });
  expect(created.statusCode, created.body).toBe(201);
  const orderId = created.json().order.id;

  const approved = await call('POST', `/api/purchasing/orders/${orderId}/approve`, b.user, {
    expectedVersion: created.json().order.version,
  });
  const issued = await call('POST', `/api/purchasing/orders/${orderId}/issue`, b.user, {
    expectedVersion: approved.json().order.version,
  });
  expect(issued.statusCode, issued.body).toBe(200);
  const orderLineIds = issued.json().order.lines.map((l: { id: string }) => l.id);

  const posted = await call('POST', '/api/purchasing/receipts', b.user, {
    orderId, receiptDate: '2026-03-05', idempotencyKey: key(),
    lines: orderLineIds.map((id: string, index: number) => ({
      orderLineId: id,
      quantity: options.receive?.[index] ?? lines[index]!.quantity,
    })),
  });
  expect(posted.statusCode, posted.body).toBe(201);
  const receipt = posted.json().receipt;

  return {
    orderId,
    receiptId: receipt.id,
    receiptNumber: receipt.receiptNumber,
    version: receipt.version,
    lines: receipt.lines.map((l: { id: string; receivedQuantity: string; totalCost: string }) => ({
      receiptLineId: l.id, quantity: l.receivedQuantity, totalCost: l.totalCost,
    })),
  };
}

let invoiceSeed = 0;
const matchedBill = (
  b: Books,
  lines: Array<Record<string, unknown>>,
  over: Record<string, unknown> = {},
) => call('POST', '/api/bills', b.user, {
  issuingEntityId: ENTITY, supplierId: b.supplier,
  supplierInvoiceNumber: `INV-${invoiceSeed++}`,
  billDate: '2026-03-10', dueDate: '2026-04-10',
  lines, ...over,
});

const postBill = (b: Books, billId: string, version: number) =>
  call('POST', `/api/bills/${billId}/post`, b.user, { expectedVersion: version });

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

async function countRows(table: string, org: string): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    SELECT COUNT(*)::text AS n FROM ${sql.table(table)} WHERE organization_id = ${org}
  `.execute(ctx.db);
  return Number(rows[0]!.n);
}

async function stockValue(b: Books): Promise<number> {
  const { rows } = await sql<{ value: string }>`
    SELECT COALESCE(SUM(CASE WHEN direction='in' THEN total_cost ELSE -total_cost END),0)::text
             AS value
      FROM inventory_movements WHERE organization_id = ${b.org} AND status = 'posted'
  `.execute(ctx.db);
  return Number(rows[0]!.value);
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

/* ══ The clearing ══════════════════════════════════════════════════════════ */

describe('a receipt-matched supplier bill', () => {
  it('clears GRNI, recognises the payable and moves no stock', async () => {
    const b = await books('Clear');
    const got = await received(b, [{ quantity: '10', unitPrice: '5.000' }]);

    expect(await glBalance(b, b.grni)).toBe(-50);
    expect(await glBalance(b, b.payable)).toBe(0);

    const bill = await matchedBill(b, [{
      description: 'Widgets',
      receiptLineId: got.lines[0]!.receiptLineId,
      matchedQuantity: '10',
      quantity: '10', unitPrice: '5.000',
    }]);
    expect(bill.statusCode, bill.body).toBe(201);
    expect(bill.json().bill.workflow).toBe('receipt-matched');

    const posted = await postBill(b, bill.json().bill.id, bill.json().bill.version);
    expect(posted.statusCode, posted.body).toBe(200);

    /* The accrual comes off at exactly the figure it went on at. */
    expect(await glBalance(b, b.grni)).toBe(0);
    expect(await glBalance(b, b.payable)).toBe(-50);
    /* Inventory is untouched: the goods arrived once and were costed once. */
    expect(await glBalance(b, b.stock)).toBe(50);
    expect(await stockValue(b)).toBe(50);
    expect(await countRows('inventory_movements', b.org)).toBe(1);
    expect(await countRows('bill_receipt_matches', b.org)).toBe(1);
  });

  it('recognises recoverable input tax at the BILL, never at the receipt', async () => {
    const b = await books('Tax');
    const vat = await taxCode(b, 'VATIN', 'standard', 'exclusive', '16.000000', b.inputTax);
    const got = await received(b, [{ quantity: '10', unitPrice: '5.000' }]);

    /* Nothing at the receipt. */
    expect(await glBalance(b, b.inputTax)).toBe(0);

    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '10',
      quantity: '10', unitPrice: '5.000', taxCodeId: vat,
    }]);
    await postBill(b, bill.json().bill.id, bill.json().bill.version);

    expect(await glBalance(b, b.grni)).toBe(0);
    expect(await glBalance(b, b.inputTax)).toBe(8);
    expect(await glBalance(b, b.payable)).toBe(-58);
    /* And the stock is still costed net of the tax it can reclaim. */
    expect(await stockValue(b)).toBe(50);
  });

  it('extracts an INCLUSIVE tax so the net still equals the receipt', async () => {
    const b = await books('Inclusive');
    const vat = await taxCode(b, 'VATIN', 'standard', 'inclusive', '16.000000', b.inputTax);
    const got = await received(b, [{ quantity: '10', unitPrice: '5.000' }]);

    /* 5.800 inclusive at 16% leaves 5.000 of cost — the receipt's own figure. */
    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '10',
      quantity: '10', unitPrice: '5.800', taxCodeId: vat,
    }]);
    const posted = await postBill(b, bill.json().bill.id, bill.json().bill.version);
    expect(posted.statusCode, posted.body).toBe(200);

    expect(await glBalance(b, b.grni)).toBe(0);
    expect(await glBalance(b, b.inputTax)).toBe(8);
    expect(await glBalance(b, b.payable)).toBe(-58);
  });

  it('keeps zero-rated, exempt and out-of-scope apart, and clears the same', async () => {
    for (const category of ['zero-rated', 'exempt', 'out-of-scope']) {
      const b = await books(`Zero${category.replace(/-/g, '')}`);
      const code = await taxCode(b, 'VATZ', category, 'exclusive', '0.000000', null);
      const got = await received(b, [{ quantity: '4', unitPrice: '2.500' }]);

      const bill = await matchedBill(b, [{
        receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
        quantity: '4', unitPrice: '2.500', taxCodeId: code,
      }]);
      const posted = await postBill(b, bill.json().bill.id, bill.json().bill.version);
      expect(posted.statusCode, posted.body).toBe(200);

      expect(await glBalance(b, b.grni)).toBe(0);
      expect(await glBalance(b, b.payable)).toBe(-10);
      expect(await glBalance(b, b.inputTax)).toBe(0);

      const line = (await call('GET', `/api/bills/${bill.json().bill.id}`, b.user))
        .json().bill.lines[0];
      /* The frozen snapshot keeps the three apart, which is the whole point of
       * recording a category that always charges zero. */
      expect(line.taxSnapshot.category).toBe(category);
    }
  });

  it('clears one receipt across several bills, exactly', async () => {
    const b = await books('PartialBills');
    /* 3 at 3.333 is 9.999 — a value a third of which does not divide evenly. */
    const got = await received(b, [{ quantity: '3', unitPrice: '3.333' }]);
    expect(await glBalance(b, b.grni)).toBe(-9.999);

    for (const quantity of ['1', '1', '1']) {
      const bill = await matchedBill(b, [{
        receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: quantity,
        quantity, unitPrice: '3.333',
      }]);
      expect(bill.statusCode, bill.body).toBe(201);
      const posted = await postBill(b, bill.json().bill.id, bill.json().bill.version);
      expect(posted.statusCode, posted.body).toBe(200);
    }

    /* Not a fils more or less than the receipt put there. */
    expect(await glBalance(b, b.grni)).toBe(0);
    expect(await glBalance(b, b.payable)).toBe(-9.999);
    expect(await countRows('bill_receipt_matches', b.org)).toBe(3);
  });

  it('matches one bill to several receipts', async () => {
    const b = await books('MultiReceipt');
    const first = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);
    const second = await received(b, [{ itemId: b.itemB, quantity: '6', unitPrice: '2.500' }]);

    const bill = await matchedBill(b, [
      {
        receiptLineId: first.lines[0]!.receiptLineId, matchedQuantity: '4',
        quantity: '4', unitPrice: '5.000',
      },
      {
        receiptLineId: second.lines[0]!.receiptLineId, matchedQuantity: '6',
        quantity: '6', unitPrice: '2.500',
      },
    ]);
    expect(bill.statusCode, bill.body).toBe(201);
    const posted = await postBill(b, bill.json().bill.id, bill.json().bill.version);
    expect(posted.statusCode, posted.body).toBe(200);

    expect(await glBalance(b, b.grni)).toBe(0);
    expect(await glBalance(b, b.payable)).toBe(-35);
    expect(await countRows('bill_receipt_matches', b.org)).toBe(2);
  });

  it('clears only the matched portion, leaving the rest accrued', async () => {
    const b = await books('PartialClear');
    const got = await received(b, [{ quantity: '10', unitPrice: '5.000' }]);

    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    await postBill(b, bill.json().bill.id, bill.json().bill.version);

    expect(await glBalance(b, b.grni)).toBe(-30);
    expect(await glBalance(b, b.payable)).toBe(-20);

    const schedule = (await call('GET', '/api/purchasing/grni', b.user)).json();
    expect(Number(schedule.total)).toBe(30);
    expect(Number(schedule.generalLedgerBalance)).toBe(30);
    expect(schedule.balanced).toBe(true);
    expect(Number(schedule.rows[0].clearedValue)).toBe(20);
    expect(Number(schedule.rows[0].openValue)).toBe(30);
    expect(schedule.rows[0].matched).toBe(true);
  });
});

/* ══ What matching refuses ═════════════════════════════════════════════════ */

describe('what a matched bill refuses', () => {
  it('refuses a price the goods were not received at, and says why', async () => {
    const b = await books('Variance');
    const got = await received(b, [{ quantity: '10', unitPrice: '5.000' }]);

    for (const unitPrice of ['5.200', '4.900']) {
      const bill = await matchedBill(b, [{
        receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '10',
        quantity: '10', unitPrice,
      }]);
      expect(bill.statusCode, bill.body).toBe(201);
      const posted = await postBill(b, bill.json().bill.id, bill.json().bill.version);
      expect(posted.statusCode, posted.body).toBe(400);
      expect(posted.json().error.message).toMatch(/purchase-price variance has no defined destination/i);
    }

    /* And nothing was cleared, recognised or moved by the attempts. */
    expect(await glBalance(b, b.grni)).toBe(-50);
    expect(await glBalance(b, b.payable)).toBe(0);
    expect(await countRows('bill_receipt_matches', b.org)).toBe(0);
  });

  it('refuses billing more than has arrived', async () => {
    const b = await books('OverBill');
    const got = await received(b, [{ quantity: '10', unitPrice: '5.000' }], { receive: ['4'] });

    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '6',
      quantity: '6', unitPrice: '5.000',
    }]);
    const posted = await postBill(b, bill.json().bill.id, bill.json().bill.version);
    expect(posted.statusCode, posted.body).toBe(400);
    expect(posted.json().error.message).toMatch(/goods-invoiced-not-received|more than has actually arrived/i);
  });

  it('refuses a second bill for a receipt already settled in full', async () => {
    const b = await books('DoubleBill');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);

    const first = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    await postBill(b, first.json().bill.id, first.json().bill.version);

    const second = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    const posted = await postBill(b, second.json().bill.id, second.json().bill.version);
    expect(posted.statusCode, posted.body).toBe(400);
    expect(posted.json().error.message).toMatch(/already been billed in full/i);
    expect(await glBalance(b, b.payable)).toBe(-20);
  });

  it("refuses another supplier's receipt", async () => {
    const b = await books('WrongSupplier');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }],
      { supplierId: b.supplierB });

    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    const posted = await postBill(b, bill.json().bill.id, bill.json().bill.version);
    expect(posted.statusCode, posted.body).toBe(400);
    expect(posted.json().error.message).toMatch(/different supplier/i);
  });

  it("refuses another company's receipt outright", async () => {
    const b = await books('IsoA');
    const other = await books('IsoB');
    const got = await received(other, [{ quantity: '4', unitPrice: '5.000' }]);

    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    /* Refused when the draft is written: the receipt is invisible from here. */
    expect(bill.statusCode, bill.body).toBe(400);
    expect(bill.json().error.message).toMatch(/not in these books/i);
  });

  it('refuses a reversed receipt', async () => {
    const b = await books('ReversedReceipt');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);

    const reversed = await call('POST', `/api/purchasing/receipts/${got.receiptId}/reverse`, b.user, {
      expectedVersion: got.version, reason: 'Wrong goods delivered',
    });
    expect(reversed.statusCode, reversed.body).toBe(200);

    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    expect(bill.statusCode, bill.body).toBe(400);
    expect(bill.json().error.message).toMatch(/has been reversed/i);
  });

  it('refuses the same receipt line twice on one bill', async () => {
    const b = await books('DuplicateLine');
    const got = await received(b, [{ quantity: '10', unitPrice: '5.000' }]);

    const bill = await matchedBill(b, [
      {
        receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
        quantity: '4', unitPrice: '5.000',
      },
      {
        receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '6',
        quantity: '6', unitPrice: '5.000',
      },
    ]);
    const posted = await postBill(b, bill.json().bill.id, bill.json().bill.version);
    expect(posted.statusCode, posted.body).toBe(400);
    expect(posted.json().error.message).toMatch(/already taken/i);
  });

  it('refuses mixing direct stock recognition with matching on one bill', async () => {
    const b = await books('MixedBill');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);

    const bill = await matchedBill(b, [
      {
        receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
        quantity: '4', unitPrice: '5.000',
      },
      {
        accountId: b.expense, itemId: b.itemB, warehouseId: b.main,
        quantity: '2', unitPrice: '1.000',
      },
    ]);
    expect(bill.statusCode, bill.body).toBe(400);
    expect(bill.json().error.message).toMatch(/two different purchasing workflows/i);
  });

  it('refuses one line that both receives and settles', async () => {
    const b = await books('BothOnOneLine');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);
    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      itemId: b.item, warehouseId: b.main,
      quantity: '4', unitPrice: '5.000',
    }]);
    expect(bill.statusCode, bill.body).toBe(400);
    expect(bill.json().error.message).toMatch(/enters inventory once/i);
  });

  it('refuses a stated workflow that disagrees with the lines', async () => {
    const b = await books('WrongWorkflow');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);
    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }], { workflow: 'expense' });
    expect(bill.statusCode, bill.body).toBe(400);
    expect(bill.json().error.message).toMatch(/its lines make it a receipt-matched one/i);
  });

  it('refuses a match with no quantity, and a quantity with no match', async () => {
    const b = await books('ShapeGuards');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);

    const noQuantity = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, quantity: '4', unitPrice: '5.000',
    }]);
    expect(noQuantity.statusCode, noQuantity.body).toBe(400);

    const noMatch = await matchedBill(b, [{
      accountId: b.expense, matchedQuantity: '4', quantity: '4', unitPrice: '5.000',
    }]);
    expect(noMatch.statusCode, noMatch.body).toBe(400);
  });

  it('refuses returns, debit notes and supplier credits by name', async () => {
    const b = await books('NoReturns');
    for (const field of ['debitNoteId', 'supplierCreditId', 'returnOfBillId', 'creditNoteId']) {
      const r = await matchedBill(b, [{
        accountId: b.expense, quantity: '1', unitPrice: '1.000',
      }], { [field]: 'x' });
      expect(r.statusCode, `${field}: ${r.body}`).toBe(400);
      expect(r.json().error.message).toMatch(/not implemented/i);
    }
    for (const field of ['returnQuantity', 'debitNoteId', 'supplierCreditId']) {
      const r = await matchedBill(b, [{
        accountId: b.expense, quantity: '1', unitPrice: '1.000', [field]: 'x',
      }]);
      expect(r.statusCode, `${field}: ${r.body}`).toBe(400);
    }
  });

  it('has no matching, variance, return or credit endpoint of its own', async () => {
    const b = await books('NoAP3Routes');
    for (const path of [
      '/api/purchasing/returns', '/api/purchasing/debit-notes',
      '/api/purchasing/supplier-credits', '/api/purchasing/price-variance',
      '/api/purchasing/tolerances',
    ]) {
      const r = await call('GET', path, b.user);
      expect(r.statusCode, path).toBe(404);
    }
  });
});

/* ══ Dependencies and reversal ═════════════════════════════════════════════ */

describe('reversal and dependencies', () => {
  it('restores GRNI and reopens capacity when a matched bill is reversed', async () => {
    const b = await books('ReverseBill');
    const got = await received(b, [{ quantity: '10', unitPrice: '5.000' }]);
    const vat = await taxCode(b, 'VATIN', 'standard', 'exclusive', '16.000000', b.inputTax);

    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '10',
      quantity: '10', unitPrice: '5.000', taxCodeId: vat,
    }]);
    const posted = await postBill(b, bill.json().bill.id, bill.json().bill.version);
    expect(posted.statusCode, posted.body).toBe(200);

    const reversed = await call('POST', `/api/bills/${bill.json().bill.id}/reverse`, b.user, {
      expectedVersion: posted.json().bill.version, reason: 'Invoice withdrawn by supplier',
    });
    expect(reversed.statusCode, reversed.body).toBe(200);

    /* The accrual is back, the payable and the tax are gone. */
    expect(await glBalance(b, b.grni)).toBe(-50);
    expect(await glBalance(b, b.payable)).toBe(0);
    expect(await glBalance(b, b.inputTax)).toBe(0);
    /* And the stock never moved in either direction. */
    expect(await stockValue(b)).toBe(50);
    expect(await countRows('inventory_movements', b.org)).toBe(1);

    /* The allocation is kept, marked, and no longer counted. */
    const { rows } = await sql<{ status: string }>`
      SELECT status FROM bill_receipt_matches WHERE organization_id = ${b.org}
    `.execute(ctx.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('reversed');

    /* Capacity is available again. */
    const eligible = (await call('GET', '/api/purchasing/matching/eligible', b.user)).json().lines;
    expect(eligible).toHaveLength(1);
    expect(Number(eligible[0].remainingQuantity)).toBe(10);
    expect(Number(eligible[0].remainingValue)).toBe(50);
  });

  it('lets the reopened capacity be billed again', async () => {
    const b = await books('Rebill');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);

    const first = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    const posted = await postBill(b, first.json().bill.id, first.json().bill.version);
    await call('POST', `/api/bills/${first.json().bill.id}/reverse`, b.user, {
      expectedVersion: posted.json().bill.version, reason: 'Wrong invoice number',
    });

    const second = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    const again = await postBill(b, second.json().bill.id, second.json().bill.version);
    expect(again.statusCode, again.body).toBe(200);

    expect(await glBalance(b, b.grni)).toBe(0);
    expect(await glBalance(b, b.payable)).toBe(-20);
    expect(await countRows('bill_receipt_matches', b.org)).toBe(2);
  });

  it('refuses to reverse a receipt a live bill has settled', async () => {
    const b = await books('ReceiptLocked');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);

    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    await postBill(b, bill.json().bill.id, bill.json().bill.version);

    const current = (await call('GET', `/api/purchasing/receipts/${got.receiptId}`, b.user))
      .json().receipt;
    const reversed = await call('POST', `/api/purchasing/receipts/${got.receiptId}/reverse`, b.user, {
      expectedVersion: current.version, reason: 'Trying to withdraw a billed receipt',
    });
    expect(reversed.statusCode, reversed.body).toBe(400);
    expect(reversed.json().error.message).toMatch(/has been billed and cannot be withdrawn/i);

    /* And nothing moved. */
    expect(await stockValue(b)).toBe(20);
    expect(await glBalance(b, b.payable)).toBe(-20);
  });

  it('lets the receipt reverse once the bill is withdrawn', async () => {
    const b = await books('Unlock');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);

    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    const posted = await postBill(b, bill.json().bill.id, bill.json().bill.version);
    await call('POST', `/api/bills/${bill.json().bill.id}/reverse`, b.user, {
      expectedVersion: posted.json().bill.version, reason: 'Invoice withdrawn',
    });

    const current = (await call('GET', `/api/purchasing/receipts/${got.receiptId}`, b.user))
      .json().receipt;
    const reversed = await call('POST', `/api/purchasing/receipts/${got.receiptId}/reverse`, b.user, {
      expectedVersion: current.version, reason: 'Goods returned to the supplier',
    });
    expect(reversed.statusCode, reversed.body).toBe(200);

    expect(await stockValue(b)).toBe(0);
    expect(await glBalance(b, b.grni)).toBe(0);
    expect(await glBalance(b, b.payable)).toBe(0);
  });

  it('still refuses to reverse a bill a payment settles', async () => {
    const b = await books('PaidBill');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);

    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    const posted = await postBill(b, bill.json().bill.id, bill.json().bill.version);

    const payment = await call('POST', '/api/payments', b.user, {
      issuingEntityId: ENTITY, supplierId: b.supplier, paymentDate: '2026-03-15',
      cashAccountId: b.bank, amount: '20.000', method: 'bank_transfer',
    });
    expect(payment.statusCode, payment.body).toBe(201);
    const postedPayment = await call('POST', `/api/payments/${payment.json().payment.id}/post`,
      b.user, {
        expectedVersion: payment.json().payment.version,
        allocations: [{ billId: bill.json().bill.id, amount: '20.000' }],
      });
    expect(postedPayment.statusCode, postedPayment.body).toBe(200);

    const reversed = await call('POST', `/api/bills/${bill.json().bill.id}/reverse`, b.user, {
      expectedVersion: posted.json().bill.version, reason: 'Trying to reverse a paid bill',
    });
    expect(reversed.statusCode, reversed.body).toBe(409);

    /* The clearing stands, because the bill does. */
    expect(await glBalance(b, b.grni)).toBe(0);
    expect(await countRows('bill_receipt_matches', b.org)).toBe(1);
  });
});

/* ══ Concurrency, atomicity and idempotency ════════════════════════════════ */

describe('posting under pressure', () => {
  it('lets only ONE of several simultaneous posts clear a receipt', async () => {
    const b = await books('RacePost');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);
    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    const version = bill.json().bill.version;

    const attempts = await Promise.all(
      Array.from({ length: 4 }, () => postBill(b, bill.json().bill.id, version)),
    );
    expect(attempts.filter((r) => r.statusCode === 200)).toHaveLength(1);

    expect(await countRows('bill_receipt_matches', b.org)).toBe(1);
    expect(await glBalance(b, b.grni)).toBe(0);
    expect(await glBalance(b, b.payable)).toBe(-20);
  });

  it('lets only ONE of two bills take the same receipt capacity', async () => {
    const b = await books('RaceCapacity');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);

    const first = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    const second = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);

    const attempts = await Promise.all([
      postBill(b, first.json().bill.id, first.json().bill.version),
      postBill(b, second.json().bill.id, second.json().bill.version),
    ]);
    expect(attempts.filter((r) => r.statusCode === 200)).toHaveLength(1);

    expect(await countRows('bill_receipt_matches', b.org)).toBe(1);
    expect(await glBalance(b, b.grni)).toBe(0);
    expect(await glBalance(b, b.payable)).toBe(-20);
  });

  it('rolls the bill, the match, the tax and the clearing back together', async () => {
    const b = await books('AtomicPost');
    const got = await received(b, [
      { quantity: '5', unitPrice: '5.000' },
      { itemId: b.itemB, quantity: '5', unitPrice: '2.000' },
    ]);

    /* The second line asks for more than arrived, after the first has been
     * planned. Nothing at all may survive. */
    const bill = await matchedBill(b, [
      {
        receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '5',
        quantity: '5', unitPrice: '5.000',
      },
      {
        receiptLineId: got.lines[1]!.receiptLineId, matchedQuantity: '9',
        quantity: '9', unitPrice: '2.000',
      },
    ]);
    const posted = await postBill(b, bill.json().bill.id, bill.json().bill.version);
    expect(posted.statusCode, posted.body).toBe(400);

    expect(await countRows('bill_receipt_matches', b.org)).toBe(0);
    expect(await glBalance(b, b.payable)).toBe(0);
    expect(await glBalance(b, b.grni)).toBe(-35);
    const still = (await call('GET', `/api/bills/${bill.json().bill.id}`, b.user)).json().bill;
    expect(still.status).toBe('draft');
  });

  it('enforces the posting-period lock on a matched bill', async () => {
    const b = await books('PeriodLock');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);
    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);

    const period = await call('POST', '/api/accounting/periods', b.user, {
      fiscalYear: 2026, periodNumber: 3, startDate: '2026-03-01', endDate: '2026-03-31',
    });
    expect(period.statusCode, period.body).toBe(201);
    await call('PATCH', `/api/accounting/periods/${period.json().period.id}`, b.user, {
      status: 'locked', reason: 'Month closed for reporting',
    });

    const posted = await postBill(b, bill.json().bill.id, bill.json().bill.version);
    expect(posted.statusCode, posted.body).toBe(409);
    expect(await countRows('bill_receipt_matches', b.org)).toBe(0);
  });

  it('refuses posting when the GRNI account has been blocked since the receipt', async () => {
    const b = await books('BlockedGrni');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);
    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);

    const account = (await call('GET', `/api/accounting/accounts/${b.grni}`, b.user)).json().account;
    const blocked = await call('PATCH', `/api/accounting/accounts/${b.grni}`, b.user, {
      expectedVersion: account.version, accountCode: account.accountCode,
      accountName: account.accountName, accountType: account.accountType, blocked: true,
    });
    expect(blocked.statusCode, blocked.body).toBe(200);

    const posted = await postBill(b, bill.json().bill.id, bill.json().bill.version);
    expect(posted.statusCode, posted.body).toBe(400);
    expect(await countRows('bill_receipt_matches', b.org)).toBe(0);
  });
});

/* ══ The database itself ═══════════════════════════════════════════════════ */

describe('what the database refuses', () => {
  it('refuses to edit or delete a posted match', async () => {
    const b = await books('ImmutableMatch');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);
    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    await postBill(b, bill.json().bill.id, bill.json().bill.version);

    await expect(sql`
      UPDATE bill_receipt_matches SET matched_receipt_value = 999 WHERE organization_id = ${b.org}
    `.execute(ctx.db)).rejects.toThrow(/cannot be edited/i);

    await expect(sql`
      DELETE FROM bill_receipt_matches WHERE organization_id = ${b.org}
    `.execute(ctx.db)).rejects.toThrow(/cannot be deleted/i);
  });

  it('refuses a match whose two values disagree', async () => {
    const b = await books('ExactCheck');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);
    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    await postBill(b, bill.json().bill.id, bill.json().bill.version);

    await expect(sql`
      UPDATE bill_receipt_matches SET matched_bill_value = matched_bill_value + 1
       WHERE organization_id = ${b.org}
    `.execute(ctx.db)).rejects.toThrow();
  });

  it('makes a bill line that both receives and settles unrepresentable', async () => {
    const b = await books('DbExclusion');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);
    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    expect(bill.statusCode, bill.body).toBe(201);

    /* The line already settles a receipt; giving it an item as well is the
     * double recognition, and the database refuses the row itself. */
    await expect(sql`
      UPDATE bill_lines SET item_id = ${b.item}, warehouse_id = ${b.main}
       WHERE organization_id = ${b.org} AND receipt_line_id IS NOT NULL
    `.execute(ctx.db)).rejects.toThrow();
  });
});

/* ══ I3 stays exactly as it was ════════════════════════════════════════════ */

describe('the direct stocked bill', () => {
  it('still recognises inventory itself and never touches GRNI', async () => {
    const b = await books('DirectBill');
    const bill = await call('POST', '/api/bills', b.user, {
      issuingEntityId: ENTITY, supplierId: b.supplier, supplierInvoiceNumber: 'SUP-DIRECT',
      billDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{
        description: 'Widgets', accountId: b.expense, itemId: b.item, warehouseId: b.main,
        quantity: '4', unitPrice: '2.500',
      }],
    });
    expect(bill.statusCode, bill.body).toBe(201);
    expect(bill.json().bill.workflow).toBe('stocked-direct');

    const posted = await postBill(b, bill.json().bill.id, bill.json().bill.version);
    expect(posted.statusCode, posted.body).toBe(200);

    expect(await stockValue(b)).toBe(10);
    expect(await glBalance(b, b.stock)).toBe(10);
    expect(await glBalance(b, b.payable)).toBe(-10);
    expect(await glBalance(b, b.grni)).toBe(0);
    expect(await countRows('bill_receipt_matches', b.org)).toBe(0);
  });

  it('classifies a plain expense bill as such', async () => {
    const b = await books('ExpenseBill');
    const bill = await call('POST', '/api/bills', b.user, {
      issuingEntityId: ENTITY, supplierId: b.supplier, supplierInvoiceNumber: 'SUP-EXP',
      billDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{ description: 'Cleaning', accountId: b.expense, quantity: '1', unitPrice: '30.000' }],
    });
    expect(bill.statusCode, bill.body).toBe(201);
    expect(bill.json().bill.workflow).toBe('expense');
  });

  it('still refuses a free-text purchase-order or goods-receipt reference', async () => {
    const b = await books('StillRefused');
    for (const field of ['purchaseOrderId', 'goodsReceiptId']) {
      const r = await matchedBill(b, [{
        accountId: b.expense, quantity: '1', unitPrice: '1.000',
      }], { [field]: 'PO-2026-0001' });
      expect(r.statusCode, `${field}: ${r.body}`).toBe(400);
      expect(r.json().error.message).toMatch(/purchase orders|goods receipts/i);
    }
  });
});

/* ══ Reporting and reconciliation ══════════════════════════════════════════ */

describe('reporting', () => {
  it('lists eligible receipt lines with what each has left', async () => {
    const b = await books('Eligible');
    const got = await received(b, [{ quantity: '10', unitPrice: '5.000' }]);

    let eligible = (await call('GET', '/api/purchasing/matching/eligible', b.user)).json();
    expect(eligible.exactValueRequired).toBe(true);
    expect(eligible.lines).toHaveLength(1);
    expect(Number(eligible.lines[0].remainingQuantity)).toBe(10);
    expect(Number(eligible.lines[0].remainingValue)).toBe(50);

    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    await postBill(b, bill.json().bill.id, bill.json().bill.version);

    eligible = (await call('GET', '/api/purchasing/matching/eligible', b.user)).json();
    expect(Number(eligible.lines[0].remainingQuantity)).toBe(6);
    expect(Number(eligible.lines[0].remainingValue)).toBe(30);
    expect(Number(eligible.lines[0].matchedValue)).toBe(20);
  });

  it('drops a fully settled receipt line from the eligible list', async () => {
    const b = await books('EligibleDone');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);
    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    await postBill(b, bill.json().bill.id, bill.json().bill.version);

    const eligible = (await call('GET', '/api/purchasing/matching/eligible', b.user)).json().lines;
    expect(eligible).toHaveLength(0);

    const awaiting = (await call('GET', '/api/purchasing/receipts?awaitingInvoice=true', b.user))
      .json().receipts;
    expect(awaiting).toHaveLength(0);
  });

  it('reports what each bill settled, with both values and no difference', async () => {
    const b = await books('History');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);
    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    await postBill(b, bill.json().bill.id, bill.json().bill.version);

    const history = (await call('GET', '/api/purchasing/matching/history', b.user)).json().matches;
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe('active');
    expect(history[0].receiptNumber).toBe(got.receiptNumber);
    expect(Number(history[0].matchedReceiptValue)).toBe(20);
    expect(Number(history[0].matchedBillValue)).toBe(20);
    expect(Number(history[0].valueDifference)).toBe(0);
    expect(history[0].supplierName).toBe('Acme Supplies');
  });

  it('ages the open accrual from the receipt posting date', async () => {
    const b = await books('Aging');
    await received(b, [{ quantity: '4', unitPrice: '5.000' }]);

    const aging = (await call('GET', '/api/purchasing/grni/aging?asOfDate=2026-03-20', b.user)).json();
    expect(Number(aging.total)).toBe(20);
    expect(aging.rows).toHaveLength(1);
    expect(aging.rows[0].ageDays).toBe(15);
    expect(aging.rows[0].band).toBe('0-30 days');
    expect(aging.rows[0].receiptPostingDate).toBe('2026-03-05');

    const older = (await call('GET', '/api/purchasing/grni/aging?asOfDate=2026-07-01', b.user)).json();
    expect(older.rows[0].band).toBe('Over 90 days');
  });

  it('keeps historical reporting after a supplier and item are archived', async () => {
    const b = await books('ArchivedMasters');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);
    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    await postBill(b, bill.json().bill.id, bill.json().bill.version);

    const supplier = (await call('GET', `/api/vendors/${b.supplier}`, b.user)).json().supplier;
    await call('POST', `/api/vendors/${b.supplier}/archive`, b.user, {
      expectedVersion: supplier.version, archived: true,
    });
    const item = (await call('GET', `/api/inventory/items/${b.item}`, b.user)).json().item;
    await call('POST', `/api/inventory/items/${b.item}/archive`, b.user, {
      expectedVersion: item.version, archived: true,
    });

    const history = (await call('GET', '/api/purchasing/matching/history', b.user)).json().matches;
    expect(history).toHaveLength(1);
    expect(history[0].supplierName).toBe('Acme Supplies');
    expect(history[0].itemCode).toBe('SKU-1');
  });

  it('reconciles receipts, stock, GRNI, payables and tax after a mixed workload', async () => {
    const b = await books('Reconcile');
    const vat = await taxCode(b, 'VATIN', 'standard', 'exclusive', '16.000000', b.inputTax);

    const one = await received(b, [
      { quantity: '10', unitPrice: '5.000' },
      { itemId: b.itemB, warehouseId: b.spare, quantity: '6', unitPrice: '2.500' },
    ]);
    await received(b, [{ quantity: '7', unitPrice: '3.000' }], { receive: ['3'] });

    /* Bill one line in full, one in part, and leave the second receipt open. */
    const first = await matchedBill(b, [
      {
        receiptLineId: one.lines[0]!.receiptLineId, matchedQuantity: '10',
        quantity: '10', unitPrice: '5.000', taxCodeId: vat,
      },
      {
        receiptLineId: one.lines[1]!.receiptLineId, matchedQuantity: '4',
        quantity: '4', unitPrice: '2.500', taxCodeId: vat,
      },
    ]);
    const postedFirst = await postBill(b, first.json().bill.id, first.json().bill.version);
    expect(postedFirst.statusCode, postedFirst.body).toBe(200);

    /* And an ordinary expense bill beside it, which touches none of this. */
    const expense = await call('POST', '/api/bills', b.user, {
      issuingEntityId: ENTITY, supplierId: b.supplier, supplierInvoiceNumber: 'SUP-EXPENSE',
      billDate: '2026-03-12', dueDate: '2026-04-12',
      lines: [{ accountId: b.expense, quantity: '1', unitPrice: '12.000' }],
    });
    await postBill(b, expense.json().bill.id, expense.json().bill.version);

    /* Received: 50 + 15 + 9 = 74. Cleared: 50 + 10 = 60. Open: 14. */
    const schedule = (await call('GET', '/api/purchasing/grni', b.user)).json();
    expect(Number(schedule.total)).toBe(14);
    expect(Number(schedule.generalLedgerBalance)).toBe(14);
    expect(Number(schedule.difference)).toBe(0);
    expect(schedule.balanced).toBe(true);

    expect(await glBalance(b, b.grni)).toBe(-14);
    expect(await stockValue(b)).toBe(74);
    expect(await glBalance(b, b.stock)).toBe(74);
    /* Payable: 60 net + 9.6 tax on the matched bill, plus 12 of expense. */
    expect(await glBalance(b, b.payable)).toBe(-81.6);
    expect(await glBalance(b, b.inputTax)).toBe(9.6);

    const reconciliation = (await call('GET', '/api/inventory/reconciliation', b.user)).json();
    expect(reconciliation.balanced).toBe(true);

    const aging = (await call('GET', '/api/purchasing/grni/aging?asOfDate=2026-03-20', b.user)).json();
    expect(Number(aging.total)).toBe(14);

    const open = (await call('GET', '/api/purchasing/orders/open-lines', b.user)).json().lines;
    /* Order two still has 4 of 7 outstanding on the order itself. */
    expect(open.reduce(
      (sum: number, l: { remainingQuantity: string }) => sum + Number(l.remainingQuantity), 0,
    )).toBe(4);
  });

  it('reports a manual journal to GRNI as a reconciling difference, never hiding it', async () => {
    const b = await books('ManualJournal');
    await received(b, [{ quantity: '4', unitPrice: '5.000' }]);

    const entry = await call('POST', '/api/accounting/journals', b.user, {
      transactionDate: '2026-03-09', description: 'Manual accrual correction',
      lines: [
        { accountId: b.grni, credit: '7.000', description: 'Manual' },
        { accountId: b.expense, debit: '7.000', description: 'Manual' },
      ],
    });
    expect(entry.statusCode, entry.body).toBe(201);
    const postedEntry = await call('POST', `/api/accounting/journals/${entry.json().journal.id}/post`,
      b.user, { expectedVersion: entry.json().journal.version });
    expect(postedEntry.statusCode, postedEntry.body).toBe(200);

    const schedule = (await call('GET', '/api/purchasing/grni', b.user)).json();
    expect(Number(schedule.total)).toBe(20);
    expect(Number(schedule.generalLedgerBalance)).toBe(27);
    expect(Number(schedule.difference)).toBe(-7);
    expect(schedule.balanced).toBe(false);
  });
});

/* ══ Currency precision ════════════════════════════════════════════════════ */

describe('monetary precision', () => {
  it('clears exactly in JOD, USD and a zero-decimal currency', async () => {
    for (const [currency, country, unitPrice, expected] of [
      ['JOD', 'JO', '1.333', 3.999],
      ['USD', 'US', '1.33', 3.99],
      ['JPY', 'JP', '100', 300],
    ] as const) {
      const b = await books(`Precision${currency}`, { currency, country });
      const got = await received(b, [{ quantity: '3', unitPrice }]);
      expect(await glBalance(b, b.grni)).toBe(-expected);

      const bill = await matchedBill(b, [{
        receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '3',
        quantity: '3', unitPrice,
      }]);
      const posted = await postBill(b, bill.json().bill.id, bill.json().bill.version);
      expect(posted.statusCode, posted.body).toBe(200);

      expect(await glBalance(b, b.grni)).toBe(0);
      expect(await glBalance(b, b.payable)).toBe(-expected);
    }
  });

  it('reads calendar dates correctly east of Greenwich', async () => {
    const b = await books('Dates');
    const got = await received(b, [{ quantity: '2', unitPrice: '5.000' }]);
    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '2',
      quantity: '2', unitPrice: '5.000',
    }], { billDate: '2026-03-11', postingDate: '2026-03-12', dueDate: '2026-04-11' });
    await postBill(b, bill.json().bill.id, bill.json().bill.version);

    const history = (await call('GET', '/api/purchasing/matching/history', b.user)).json().matches;
    expect(history[0].billPostingDate).toBe('2026-03-12');
    expect(history[0].receiptPostingDate).toBe('2026-03-05');
  });
});

/* ══ Permissions and entitlements ══════════════════════════════════════════ */

describe('who may match', () => {
  it('refuses a tenant without the advanced-inventory entitlement', async () => {
    const b = await books('NoEntitlement', { plan: 'manufacturing' });
    await sql`
      UPDATE organization_entitlements
         SET modules = (
           SELECT COALESCE(jsonb_agg(m), '[]'::jsonb)
             FROM jsonb_array_elements(modules::jsonb) AS m
            WHERE m <> '"inventory_advanced"'::jsonb
         )::text::jsonb
       WHERE organization_id = ${b.org}
    `.execute(ctx.db);

    for (const path of [
      '/api/purchasing/matching/eligible',
      '/api/purchasing/matching/history',
      '/api/purchasing/grni/aging',
    ]) {
      const r = await call('GET', path, b.user);
      expect(r.statusCode, path).toBe(403);
    }

    /* Ordinary expense bills are unaffected: they are not an inventory feature. */
    const bills = await call('GET', '/api/bills', b.user);
    expect(bills.statusCode, bills.body).toBe(200);
  });

  it('lets a bill writer without matching authority write but not match', async () => {
    const admin2 = await books('MatchAuthority');
    const got = await received(admin2, [{ quantity: '4', unitPrice: '5.000' }]);

    /* A Standard User may author a bill, and holds no `receipt_matching.create`. */
    const invited = await ctx.app.inject({
      method: 'POST', url: '/api/admin/users', headers: authHeaders(admin),
      payload: {
        fullName: 'Bill Writer', email: 'writer@ap2.test', organizationId: admin2.org,
        role: 'member', onboarding: 'invitation',
      },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    await ctx.app.inject({
      method: 'POST', url: '/api/auth/reset-password',
      payload: { token: invited.json().credential.invitationToken, newPassword: password },
    });
    const writer = await login(ctx, 'writer@ap2.test', password);

    const plain = await ctx.app.inject({
      method: 'POST', url: '/api/bills', headers: authHeaders(writer),
      payload: {
        issuingEntityId: ENTITY, supplierId: admin2.supplier, supplierInvoiceNumber: 'SUP-PLAIN',
        billDate: '2026-03-10', dueDate: '2026-04-10',
        lines: [{ accountId: admin2.expense, quantity: '1', unitPrice: '5.000' }],
      },
    });
    expect(plain.statusCode, plain.body).toBe(201);

    const matched = await ctx.app.inject({
      method: 'POST', url: '/api/bills', headers: authHeaders(writer),
      payload: {
        issuingEntityId: ENTITY, supplierId: admin2.supplier, supplierInvoiceNumber: 'SUP-MATCH',
        billDate: '2026-03-10', dueDate: '2026-04-10',
        lines: [{
          receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
          quantity: '4', unitPrice: '5.000',
        }],
      },
    });
    expect(matched.statusCode, matched.body).toBe(403);
    expect(matched.json().error.message).toMatch(/not match it to goods receipts/i);
  });

  it('never shows one company another company\'s matches', async () => {
    const b = await books('IsolationA');
    const other = await books('IsolationB');
    const got = await received(other, [{ quantity: '4', unitPrice: '5.000' }]);
    const bill = await matchedBill(other, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    await postBill(other, bill.json().bill.id, bill.json().bill.version);

    const history = (await call('GET', '/api/purchasing/matching/history', b.user)).json().matches;
    expect(history).toHaveLength(0);
    const eligible = (await call('GET', '/api/purchasing/matching/eligible', b.user)).json().lines;
    expect(eligible).toHaveLength(0);
  });
});

/* ══ Migration ═════════════════════════════════════════════════════════════ */

describe('migration 043', () => {
  it('rolls back and reapplies when nothing has been matched', async () => {
    const migrator = createMigrator(ctx.db);
    const down = await migrator.migrateDown();
    expect(down.error).toBeUndefined();
    expect(down.results?.[0]?.migrationName).toBe('043_receipt_matching');

    const up = await migrator.migrateToLatest();
    expect(up.error).toBeUndefined();

    const { rows } = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM information_schema.tables
       WHERE table_name = 'bill_receipt_matches'
    `.execute(ctx.db);
    expect(rows[0]!.n).toBe(1);
  });

  it('REFUSES to roll back over a real clearing', async () => {
    const b = await books('RollbackMatch');
    const got = await received(b, [{ quantity: '4', unitPrice: '5.000' }]);
    const bill = await matchedBill(b, [{
      receiptLineId: got.lines[0]!.receiptLineId, matchedQuantity: '4',
      quantity: '4', unitPrice: '5.000',
    }]);
    await postBill(b, bill.json().bill.id, bill.json().bill.version);

    const down = await createMigrator(ctx.db).migrateDown();
    expect(down.error).toBeDefined();
    expect(String((down.error as Error).message)).toMatch(/Refusing to roll back 043/);

    expect(await countRows('bill_receipt_matches', b.org)).toBe(1);
    expect(await glBalance(b, b.payable)).toBe(-20);
  });

  it('classifies existing bills without disturbing them', async () => {
    const b = await books('Backfill');
    /* A stocked bill posted BEFORE this test looks at the column. */
    const bill = await call('POST', '/api/bills', b.user, {
      issuingEntityId: ENTITY, supplierId: b.supplier, supplierInvoiceNumber: 'SUP-BACKFILL',
      billDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{
        accountId: b.expense, itemId: b.item, warehouseId: b.main,
        quantity: '2', unitPrice: '3.000',
      }],
    });
    await postBill(b, bill.json().bill.id, bill.json().bill.version);

    const { rows } = await sql<{ workflow: string }>`
      SELECT workflow FROM bills WHERE organization_id = ${b.org}
    `.execute(ctx.db);
    expect(rows[0]!.workflow).toBe('stocked-direct');
  });
});

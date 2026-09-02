/**
 * Inventory I1 through the real stack.
 *
 * These prove the half a service test walks past: the permission gates, the
 * entitlement gates, the company scope, and that a refusal reaches a client as
 * a refusal rather than as a 500. They also prove the boundary — that creating
 * a catalogue does not create stock, and does not let a stocked line through
 * Sales or Purchasing.
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

/** A tenant on a named plan, with a chart, a unit register and a tax code. */
async function books(name: string, plan = 'enterprise', role = 'admin') {
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
      fullName: `${name} Person`, email: `${name.toLowerCase()}@inv.test`,
      organizationId: org, role, onboarding: 'invitation',
    },
  });
  expect(invited.statusCode, invited.body).toBe(201);
  await ctx.app.inject({
    method: 'POST', url: '/api/auth/reset-password',
    payload: { token: invited.json().credential.invitationToken, newPassword: password },
  });
  const user = await login(ctx, `${name.toLowerCase()}@inv.test`, password);

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
  const cogs = await account('5500', 'Cost of goods sold', 'expense');
  const revenue = await account('4110', 'Product sales', 'income');
  const expense = await account('5100', 'Supplies', 'expense');
  const bank = await account('1100', 'Bank current', 'asset', {
    cashClassification: 'cash_and_cash_equivalents',
  });

  return { org, user, stock, cogs, revenue, expense, bank };
}

/** A second member of an existing organization, at a chosen role. */
async function memberOf(org: string, role: string, email: string): Promise<SessionCookies> {
  const invited = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: authHeaders(admin),
    payload: {
      fullName: `${role} person`, email, organizationId: org, role, onboarding: 'invitation',
    },
  });
  expect(invited.statusCode, invited.body).toBe(201);
  await ctx.app.inject({
    method: 'POST', url: '/api/auth/reset-password',
    payload: { token: invited.json().credential.invitationToken, newPassword: password },
  });
  return login(ctx, email, password);
}

async function baseUnit(user: SessionCookies, code = 'EA'): Promise<string> {
  const r = await call('GET', '/api/inventory/units', user);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().units.find((u: { code: string }) => u.code === code).id;
}

const itemPayload = (unitId: string, over: Record<string, unknown> = {}) => ({
  itemCode: 'SKU-001', name: 'Trading goods', itemType: 'inventory',
  isInventoryTracked: true, baseUnitId: unitId, ...over,
});

/* ══ Units ═════════════════════════════════════════════════════════════════ */

describe('units of measure', () => {
  it('seeds the canonical base units, and says conversions are not supported', async () => {
    const { user } = await books('Units');
    const r = await call('GET', '/api/inventory/units', user);
    expect(r.statusCode, r.body).toBe(200);

    const codes = r.json().units.map((u: { code: string }) => u.code).sort();
    expect(codes).toEqual(['BOX', 'EA', 'G', 'HOUR', 'KG', 'L', 'M', 'M2', 'M3']);
    /* Quantity precision is the unit's own and independent of currency. */
    expect(r.json().units.find((u: { code: string }) => u.code === 'KG').decimalPlaces).toBe(3);
    expect(r.json().units.find((u: { code: string }) => u.code === 'EA').decimalPlaces).toBe(0);

    expect(r.json().conversionsSupported).toBe(false);
    expect(r.json().conversionNote).toMatch(/conversion/i);
  });

  it('seeds once, however many times it is read', async () => {
    const { user } = await books('Once');
    await call('GET', '/api/inventory/units', user);
    await call('GET', '/api/inventory/units', user);
    const r = await call('GET', '/api/inventory/units', user);
    expect(r.json().units).toHaveLength(9);
  });

  it('refuses a duplicate unit code, case-insensitively', async () => {
    const { user } = await books('DupUnit');
    await call('GET', '/api/inventory/units', user);
    const r = await call('POST', '/api/inventory/units', user, {
      code: 'ea', name: 'Each again', category: 'quantity',
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toMatch(/already used/i);
  });

  it('will not archive a unit an active item still measures', async () => {
    const { user } = await books('UnitUse');
    const unit = await baseUnit(user);
    const created = await call('POST', '/api/inventory/items', user, itemPayload(unit));
    expect(created.statusCode, created.body).toBe(201);

    const unitRow = (await call('GET', '/api/inventory/units', user)).json()
      .units.find((u: { id: string }) => u.id === unit);
    const r = await call('POST', `/api/inventory/units/${unit}/archive`, user, {
      expectedVersion: unitRow.version, archived: true,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/still measures 1 active item/i);
  });
});

/* ══ Items ═════════════════════════════════════════════════════════════════ */

describe('the item catalogue', () => {
  it('creates, reads, updates, searches, archives and reactivates', async () => {
    const { user } = await books('Life');
    const unit = await baseUnit(user);

    const created = await call('POST', '/api/inventory/items', user, itemPayload(unit, {
      barcode: '5012345678900', description: 'Goods for resale',
      defaultSellingPrice: '12.500', defaultPurchasePrice: '8.250',
    }));
    expect(created.statusCode, created.body).toBe(201);
    const item = created.json().item;
    expect(item.version).toBe(1);
    /* Money is an exact decimal string on the way out, never a float. */
    expect(item.defaultSellingPrice).toBe('12.5000000000');
    expect(item.baseUnitCode).toBe('EA');

    const fetched = await call('GET', `/api/inventory/items/${item.id}`, user);
    expect(fetched.json().item.itemCode).toBe('SKU-001');

    const updated = await call('PATCH', `/api/inventory/items/${item.id}`, user, {
      ...itemPayload(unit, { name: 'Trading goods (renamed)' }), expectedVersion: 1,
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().item.version).toBe(2);
    expect(updated.json().item.name).toBe('Trading goods (renamed)');

    const found = await call('GET', '/api/inventory/items?search=renamed', user);
    expect(found.json().items).toHaveLength(1);

    const archived = await call('POST', `/api/inventory/items/${item.id}/archive`, user, {
      expectedVersion: 2, archived: true,
    });
    expect(archived.json().item.status).toBe('archived');

    const back = await call('POST', `/api/inventory/items/${item.id}/archive`, user, {
      expectedVersion: 3, archived: false,
    });
    expect(back.json().item.status).toBe('active');

    /* Archiving is never deletion: the identity survives. */
    expect(back.json().item.id).toBe(item.id);
  });

  it('supports every established item type', async () => {
    const { user } = await books('Types');
    const unit = await baseUnit(user);
    const types = [
      'inventory', 'non-inventory', 'service', 'raw-material', 'component',
      'subassembly', 'finished-good', 'packaging', 'consumable', 'spare-part', 'scrap',
    ];

    for (const [index, itemType] of types.entries()) {
      const tracked = !['service', 'non-inventory'].includes(itemType);
      const r = await call('POST', '/api/inventory/items', user, itemPayload(unit, {
        itemCode: `T-${index}`, name: itemType, itemType, isInventoryTracked: tracked,
      }));
      expect(r.statusCode, `${itemType}: ${r.body}`).toBe(201);
      expect(r.json().item.isInventoryTracked).toBe(tracked);
    }
  });

  it('refuses to let a service be inventory tracked', async () => {
    const { user } = await books('Service');
    const unit = await baseUnit(user);
    const r = await call('POST', '/api/inventory/items', user, itemPayload(unit, {
      itemType: 'service', isInventoryTracked: true,
    }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details.fieldErrors.isInventoryTracked).toMatch(/cannot be inventory tracked/i);
  });

  it('refuses an item nobody may buy and nobody may sell', async () => {
    const { user } = await books('Neither');
    const unit = await baseUnit(user);
    const r = await call('POST', '/api/inventory/items', user, itemPayload(unit, {
      isSellable: false, isPurchasable: false,
    }));
    expect(r.statusCode).toBe(400);
  });

  it('refuses duplicate item codes and barcodes, case-insensitively', async () => {
    const { user } = await books('Dup');
    const unit = await baseUnit(user);
    await call('POST', '/api/inventory/items', user, itemPayload(unit, { barcode: 'BC-1' }));

    const dupCode = await call('POST', '/api/inventory/items', user,
      itemPayload(unit, { itemCode: 'sku-001', name: 'Other' }));
    expect(dupCode.statusCode).toBe(409);
    expect(dupCode.json().error.message).toMatch(/item code/i);

    const dupBarcode = await call('POST', '/api/inventory/items', user,
      itemPayload(unit, { itemCode: 'SKU-002', name: 'Other', barcode: 'bc-1' }));
    expect(dupBarcode.statusCode).toBe(409);
    expect(dupBarcode.json().error.message).toMatch(/barcode/i);
  });

  it('lets two items both have no barcode', async () => {
    const { user } = await books('NoBarcode');
    const unit = await baseUnit(user);
    const a = await call('POST', '/api/inventory/items', user, itemPayload(unit, { itemCode: 'A' }));
    const b = await call('POST', '/api/inventory/items', user, itemPayload(unit, { itemCode: 'B' }));
    expect(a.statusCode).toBe(201);
    expect(b.statusCode, b.body).toBe(201);
  });

  it('refuses a stale version rather than overwriting another edit', async () => {
    const { user } = await books('Stale');
    const unit = await baseUnit(user);
    const item = (await call('POST', '/api/inventory/items', user, itemPayload(unit))).json().item;
    await call('PATCH', `/api/inventory/items/${item.id}`, user, {
      ...itemPayload(unit, { name: 'First' }), expectedVersion: 1,
    });
    const second = await call('PATCH', `/api/inventory/items/${item.id}`, user, {
      ...itemPayload(unit, { name: 'Second' }), expectedVersion: 1,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.message).toMatch(/changed by another user/i);
  });

  it('keeps a full audit history', async () => {
    const { user } = await books('Audit');
    const unit = await baseUnit(user);
    const item = (await call('POST', '/api/inventory/items', user, itemPayload(unit))).json().item;
    await call('PATCH', `/api/inventory/items/${item.id}`, user, {
      ...itemPayload(unit, { name: 'Renamed' }), expectedVersion: 1,
    });
    await call('POST', `/api/inventory/items/${item.id}/archive`, user, {
      expectedVersion: 2, archived: true,
    });

    const history = await call('GET', `/api/inventory/items/${item.id}/history`, user);
    const actions = history.json().events.map((e: { action: string }) => e.action);
    expect(actions).toContain('ITEM_CREATED');
    expect(actions).toContain('ITEM_UPDATED');
    expect(actions).toContain('ITEM_ARCHIVED');
  });
});

describe('concurrency', () => {
  it('lets exactly ONE of several simultaneous creates take a code', async () => {
    const { user } = await books('Race');
    const unit = await baseUnit(user);

    /*
     * Read-before-write cannot close this: every one of these finds the code
     * free. The unique index is what actually decides, and the service turns
     * the loser's unique-violation into a sentence instead of a 500.
     */
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        call('POST', '/api/inventory/items', user, itemPayload(unit, { itemCode: 'RACE-1' }))),
    );

    const created = attempts.filter((r) => r.statusCode === 201);
    const refused = attempts.filter((r) => r.statusCode === 409);
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(4);
    for (const r of refused) expect(r.json().error.message).toMatch(/already used/i);

    const list = await call('GET', '/api/inventory/items?search=RACE-1', user);
    expect(list.json().items).toHaveLength(1);
  });

  it('lets exactly ONE simultaneous warehouse create take a code', async () => {
    const { user } = await books('WhRace');
    const attempts = await Promise.all(
      Array.from({ length: 4 }, () =>
        call('POST', '/api/inventory/warehouses', user, { code: 'W-1', name: 'Racer' })),
    );
    expect(attempts.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(attempts.filter((r) => r.statusCode === 409)).toHaveLength(3);
  });
});

/* ══ Account and tax mappings ══════════════════════════════════════════════ */

describe('account mappings the server will not accept', () => {
  it('accepts a correct mapping', async () => {
    const { user, stock, cogs, revenue } = await books('Good');
    const unit = await baseUnit(user);
    const r = await call('POST', '/api/inventory/items', user, itemPayload(unit, {
      inventoryAccountId: stock, cogsAccountId: cogs, salesAccountId: revenue,
    }));
    expect(r.statusCode, r.body).toBe(201);
  });

  it('refuses an inventory account that is not an asset', async () => {
    const { user, cogs } = await books('WrongType');
    const unit = await baseUnit(user);
    const r = await call('POST', '/api/inventory/items', user,
      itemPayload(unit, { inventoryAccountId: cogs }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/must be asset/i);
  });

  it('refuses a bank account as the inventory account', async () => {
    const { user, bank } = await books('Bank');
    const unit = await baseUnit(user);
    const r = await call('POST', '/api/inventory/items', user,
      itemPayload(unit, { inventoryAccountId: bank }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/cash or bank/i);
  });

  it('refuses archived, blocked, inactive, non-postable and parent accounts', async () => {
    const { user } = await books('Ineligible');
    const unit = await baseUnit(user);

    const make = async (code: string, column: string): Promise<string> => {
      const created = await call('POST', '/api/accounting/accounts', user, {
        accountCode: code, accountName: `Stock ${code}`, accountType: 'asset',
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().account.id;
      /* Straight to the column: the account API refuses to archive and activate
       * in one call, and what is under test here is how the ITEM service reacts
       * to an ineligible account rather than how accounts police themselves. */
      await sql`
        UPDATE accounts SET ${sql.raw(column)} WHERE id = ${id}
      `.execute(ctx.db);
      return id;
    };

    for (const [code, column, expected] of [
      ['1301', 'archived = true, active = false', /archived/i],
      ['1302', 'blocked = true', /blocked/i],
      ['1303', 'active = false', /inactive/i],
    ] as const) {
      const id = await make(code, column);
      const r = await call('POST', '/api/inventory/items', user,
        itemPayload(unit, { itemCode: `X-${code}`, inventoryAccountId: id }));
      expect(r.statusCode, `${code}: ${r.body}`).toBe(400);
      expect(r.json().error.message).toMatch(expected);
    }

    /*
     * A real parent is a HEADER account: the chart refuses to give a postable
     * account children at all, so the two ineligible shapes — "not postable"
     * and "has children" — arrive together, which is the case a bookkeeper
     * actually meets when they pick a group from the tree.
     */
    const parent = await call('POST', '/api/accounting/accounts', user, {
      accountCode: '1400', accountName: 'Stock group', accountType: 'asset',
      isPostable: false,
    });
    expect(parent.statusCode, parent.body).toBe(201);
    const parentId = parent.json().account.id;
    const child = await call('POST', '/api/accounting/accounts', user, {
      accountCode: '1401', accountName: 'Stock child', accountType: 'asset',
      parentAccountId: parentId,
    });
    expect(child.statusCode, child.body).toBe(201);

    const r = await call('POST', '/api/inventory/items', user,
      itemPayload(unit, { itemCode: 'X-PARENT', inventoryAccountId: parentId }));
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.message).toMatch(/parent|postable/i);
  });

  it('refuses an account belonging to ANOTHER company', async () => {
    const mine = await books('Mine');
    const theirs = await books('Theirs');
    const unit = await baseUnit(mine.user);

    const r = await call('POST', '/api/inventory/items', mine.user,
      itemPayload(unit, { inventoryAccountId: theirs.stock }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/does not exist in these books/i);
  });
});

describe('tax defaults', () => {
  async function taxCode(
    user: SessionCookies, code: string, direction: string, account: string | null,
  ): Promise<string> {
    const r = await call('POST', '/api/tax-codes', user, {
      code, name: `${code} tax`, category: account ? 'standard' : 'zero-rated',
      calculationMethod: 'exclusive', direction, effectiveFrom: '2020-01-01',
      outputTaxAccountId: account, rate: account ? '16.000000' : '0.000000',
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().taxCode.id;
  }

  it('accepts a sales code as the sales default and a purchase code as the purchase default', async () => {
    const { user } = await books('TaxOk');
    const unit = await baseUnit(user);
    const sales = await taxCode(user, 'VATOUT', 'sales', null);
    const purchase = await taxCode(user, 'VATIN', 'purchase', null);

    const r = await call('POST', '/api/inventory/items', user, itemPayload(unit, {
      salesTaxCodeId: sales, purchaseTaxCodeId: purchase,
    }));
    expect(r.statusCode, r.body).toBe(201);
  });

  it('refuses a PURCHASE code as the sales default — the wrong-direction attack', async () => {
    const { user } = await books('TaxWrong');
    const unit = await baseUnit(user);
    const purchase = await taxCode(user, 'VATIN', 'purchase', null);

    const r = await call('POST', '/api/inventory/items', user,
      itemPayload(unit, { salesTaxCodeId: purchase }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/purchase code/i);
  });

  it('refuses a tax code from another company', async () => {
    const mine = await books('TaxMine');
    const theirs = await books('TaxTheirs');
    const unit = await baseUnit(mine.user);
    const foreign = await taxCode(theirs.user, 'VATOUT', 'sales', null);

    const r = await call('POST', '/api/inventory/items', mine.user,
      itemPayload(unit, { salesTaxCodeId: foreign }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/does not exist/i);
  });
});

/* ══ Warehouses ════════════════════════════════════════════════════════════ */

describe('warehouses', () => {
  it('creates, updates, searches, archives and reactivates', async () => {
    const { user } = await books('Wh');
    const created = await call('POST', '/api/inventory/warehouses', user, {
      code: 'MAIN', name: 'Main store', warehouseType: 'main', location: 'Amman',
    });
    expect(created.statusCode, created.body).toBe(201);
    const wh = created.json().warehouse;
    expect(wh.isDefault).toBe(false);

    const updated = await call('PATCH', `/api/inventory/warehouses/${wh.id}`, user, {
      code: 'MAIN', name: 'Main warehouse', expectedVersion: 1,
    });
    expect(updated.json().warehouse.version).toBe(2);

    const found = await call('GET', '/api/inventory/warehouses?search=main%20warehouse', user);
    expect(found.json().warehouses).toHaveLength(1);

    const archived = await call('POST', `/api/inventory/warehouses/${wh.id}/archive`, user, {
      expectedVersion: 2, archived: true,
    });
    expect(archived.json().warehouse.status).toBe('archived');

    const back = await call('POST', `/api/inventory/warehouses/${wh.id}/archive`, user, {
      expectedVersion: 3, archived: false,
    });
    expect(back.json().warehouse.status).toBe('active');
  });

  it('refuses a duplicate warehouse code, case-insensitively', async () => {
    const { user } = await books('WhDup');
    await call('POST', '/api/inventory/warehouses', user, { code: 'MAIN', name: 'Main' });
    const r = await call('POST', '/api/inventory/warehouses', user, { code: 'main', name: 'Again' });
    expect(r.statusCode).toBe(409);
  });

  it('will not archive the company default, and says why', async () => {
    const { user } = await books('WhDefault');
    const wh = (await call('POST', '/api/inventory/warehouses', user, {
      code: 'MAIN', name: 'Main',
    })).json().warehouse;

    const saved = await call('PATCH', '/api/inventory/settings', user, {
      defaultWarehouseId: wh.id, expectedVersion: 0,
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const r = await call('POST', `/api/inventory/warehouses/${wh.id}/archive`, user, {
      expectedVersion: 1, archived: true,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/default/i);
  });

  it('cannot see or reach another company’s warehouse', async () => {
    const mine = await books('WhMine');
    const theirs = await books('WhTheirs');
    const wh = (await call('POST', '/api/inventory/warehouses', theirs.user, {
      code: 'THEIRS', name: 'Theirs',
    })).json().warehouse;

    const list = await call('GET', '/api/inventory/warehouses', mine.user);
    expect(list.json().warehouses).toHaveLength(0);

    const direct = await call('GET', `/api/inventory/warehouses/${wh.id}`, mine.user);
    expect(direct.statusCode).toBe(404);
  });
});

/* ══ The accounting profile ════════════════════════════════════════════════ */

describe('the inventory accounting profile', () => {
  it('starts empty at version 0 and saves against it', async () => {
    const { user, stock, cogs } = await books('Profile');
    const empty = await call('GET', '/api/inventory/settings', user);
    expect(empty.json().settings.version).toBe(0);
    expect(empty.json().settings.defaultInventoryAccountId).toBeNull();

    const saved = await call('PATCH', '/api/inventory/settings', user, {
      defaultInventoryAccountId: stock, defaultCogsAccountId: cogs, expectedVersion: 0,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().settings.version).toBe(1);

    const stale = await call('PATCH', '/api/inventory/settings', user, {
      defaultInventoryAccountId: stock, expectedVersion: 0,
    });
    expect(stale.statusCode).toBe(409);
  });

  it('refuses an unsuitable mapping and creates no journal', async () => {
    const { user, org, bank } = await books('ProfileBad');
    const r = await call('PATCH', '/api/inventory/settings', user, {
      defaultInventoryAccountId: bank, expectedVersion: 0,
    });
    expect(r.statusCode).toBe(400);

    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM journal_entries WHERE organization_id = ${org}
    `.execute(ctx.db);
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

/* ══ Permissions and entitlements ══════════════════════════════════════════ */

describe('permissions and entitlements', () => {
  it('lets a CORE subscriber keep a catalogue — items are shared master data', async () => {
    const { user } = await books('Core', 'core');
    const unit = await baseUnit(user);
    const r = await call('POST', '/api/inventory/items', user, itemPayload(unit));
    expect(r.statusCode, r.body).toBe(201);
  });

  it('but refuses a CORE subscriber a warehouse — stock is an Inventory feature', async () => {
    const { user } = await books('CoreWh', 'core');
    const r = await call('POST', '/api/inventory/warehouses', user, { code: 'MAIN', name: 'Main' });
    expect(r.statusCode).toBe(403);
  });

  it('refuses a viewer the right to create an item, but not to read one', async () => {
    const { org, user } = await books('Viewer');
    const unit = await baseUnit(user);
    const viewer = await memberOf(org, 'viewer', 'read.only@inv.test');

    const r = await call('POST', '/api/inventory/items', viewer, itemPayload(unit));
    expect(r.statusCode).toBe(403);

    /* …but reading is exactly what a viewer is for. */
    const list = await call('GET', '/api/inventory/items', viewer);
    expect(list.statusCode, list.body).toBe(200);
  });
});

/* ══ The boundary: no stock, and none implied ══════════════════════════════ */

describe('the I1 boundary', () => {
  it('creates no journal, and no table that could hold a quantity', async () => {
    const { user, org } = await books('Boundary');
    const unit = await baseUnit(user);
    await call('POST', '/api/inventory/items', user, itemPayload(unit));
    await call('POST', '/api/inventory/warehouses', user, { code: 'MAIN', name: 'Main' });

    const { rows: entries } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM journal_entries WHERE organization_id = ${org}
    `.execute(ctx.db);
    expect(Number(entries[0]!.n)).toBe(0);

    /* No movement, layer or balance table exists at all. */
    const { rows: tables } = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND (table_name LIKE '%stock%movement%' OR table_name LIKE '%valuation%'
              OR table_name LIKE '%inventory_balance%' OR table_name LIKE '%stock_layer%')
    `.execute(ctx.db);
    expect(tables.map((t) => t.table_name)).toEqual([]);

    /* And the item register has no quantity or value column to write into. */
    const { rows: columns } = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'inventory_items'
         AND (column_name LIKE '%quantity%' OR column_name LIKE '%on_hand%'
              OR column_name LIKE '%average_cost%' OR column_name LIKE '%inventory_value%')
    `.execute(ctx.db);
    expect(columns.map((c) => c.column_name)).toEqual([]);
  });

  it('still refuses a stocked INVOICE line, item or no item', async () => {
    const { user, revenue } = await books('SalesGuard');
    const unit = await baseUnit(user);
    const item = (await call('POST', '/api/inventory/items', user, itemPayload(unit))).json().item;

    const customer = await call('POST', '/api/customers', user, {
      partyCode: 'CUST', legalName: 'A customer',
    });
    expect(customer.statusCode, customer.body).toBe(201);

    const r = await call('POST', '/api/invoices', user, {
      issuingEntityId: ENTITY, customerId: customer.json().customer.id,
      issueDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{
        accountId: revenue, description: 'Goods', quantity: '1', unitPrice: '10.000',
        itemId: item.id,
      }],
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/stock|inventory/i);
  });

  it('still refuses a stocked BILL line, item or no item', async () => {
    const { user, expense } = await books('PurchGuard');
    const unit = await baseUnit(user);
    const item = (await call('POST', '/api/inventory/items', user, itemPayload(unit))).json().item;

    const supplier = await call('POST', '/api/vendors', user, {
      partyCode: 'SUPP', legalName: 'A supplier',
    });
    expect(supplier.statusCode, supplier.body).toBe(201);

    const r = await call('POST', '/api/bills', user, {
      issuingEntityId: ENTITY, supplierId: supplier.json().supplier.id,
      supplierInvoiceNumber: 'S-1', billDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{
        accountId: expense, description: 'Goods', quantity: '1', unitPrice: '10.000',
        itemId: item.id,
      }],
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/stock|inventory/i);
  });
});

/* ══ The migration itself ══════════════════════════════════════════════════ */

describe('migration 037', () => {
  it('rolls back cleanly when the registers are empty, and replays', async () => {
    const migrator = createMigrator(ctx.db);

    /* 038 sits on top of 037 now, so it comes off first. Asserting the name
     * rather than a count is what makes a later migration fail here loudly
     * instead of silently rolling back something else. */
    const movements = await migrator.migrateDown();
    expect(movements.error).toBeUndefined();
    expect(movements.results?.[0]?.migrationName).toBe('038_inventory_movements');

    const down = await migrator.migrateDown();
    expect(down.error).toBeUndefined();
    expect(down.results?.[0]?.migrationName).toBe('037_inventory_master_data');

    const { rows: gone } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_name IN ('inventory_items','warehouses','units_of_measure',
                            'inventory_settings','inventory_audit_events')
    `.execute(ctx.db);
    expect(gone[0]!.n).toBe(0);

    /* Reapplication must be safe: the same migration, run again, rebuilds it. */
    const up = await migrator.migrateToLatest();
    expect(up.error).toBeUndefined();

    const { rows: back } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_name IN ('inventory_items','warehouses','units_of_measure',
                            'inventory_settings','inventory_audit_events')
    `.execute(ctx.db);
    expect(back[0]!.n).toBe(5);
  });

  it('REFUSES to roll back over real master data', async () => {
    const { user } = await books('Rollback');
    const unit = await baseUnit(user);
    const created = await call('POST', '/api/inventory/items', user, itemPayload(unit));
    expect(created.statusCode, created.body).toBe(201);

    const migrator = createMigrator(ctx.db);
    /* The movement ledger is empty, so 038 comes off without complaint; 037 is
     * the one holding the catalogue this test is about. */
    const movements = await migrator.migrateDown();
    expect(movements.error).toBeUndefined();

    const down = await migrator.migrateDown();
    expect(down.error).toBeDefined();
    expect(String((down.error as Error).message)).toMatch(/Refusing to roll back 037/);

    /* And the catalogue is untouched — a refused rollback destroys nothing. */
    const still = await call('GET', '/api/inventory/items', user);
    expect(still.json().items).toHaveLength(1);
  });

  it('does not count SEEDED units as data worth refusing over', async () => {
    const { user } = await books('SeedOnly');
    /* Reading the register seeds it; nothing else is created. */
    await call('GET', '/api/inventory/units', user);

    const migrator = createMigrator(ctx.db);
    const movements = await migrator.migrateDown();
    expect(movements.error).toBeUndefined();
    expect(movements.results?.[0]?.migrationName).toBe('038_inventory_movements');

    const down = await migrator.migrateDown();
    expect(down.error).toBeUndefined();
    expect(down.results?.[0]?.migrationName).toBe('037_inventory_master_data');
  });
});

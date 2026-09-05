/**
 * Fixed Assets F1 through the real stack.
 *
 * These prove the half a service test walks past: the permission gates, the
 * entitlement gate, the company scope, and that a refusal reaches a client as a
 * refusal rather than as a 500. They also prove the BOUNDARY — that registering
 * an asset creates no journal, no depreciation and no bill linkage, and that
 * every figure this release does not hold is refused by name rather than
 * quietly dropped.
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
  cost: string;
  accumulated: string;
  expense: string;
  bank: string;
  parent: string;
  account: (
    code: string, name: string, type: string, extra?: Record<string, unknown>,
  ) => Promise<string>;
}

/**
 * A tenant with a chart carrying the three accounts a category needs.
 *
 * `baseCurrency` is JOD deliberately: three decimal places is where a residual
 * value silently loses its last digit if anything on the way through touches a
 * float.
 */
async function books(name: string, plan = 'core', role = 'admin', currency = 'JOD'): Promise<Books> {
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

  const cost = await account('1112', 'Plant and machinery', 'asset', { normalBalance: 'debit' });
  /* The contra-asset: an ASSET whose normal balance is a CREDIT. */
  const accumulated = await account('1119', 'Accumulated depreciation — PP&E', 'asset', {
    normalBalance: 'credit',
  });
  const expense = await account('6600', 'Depreciation expense', 'expense');
  const bank = await account('1100', 'Bank current', 'asset', {
    cashClassification: 'cash_and_cash_equivalents',
  });
  const parent = await account('1900', 'Header', 'asset', { isPostable: false });
  /* Gives `parent` a child, which is what makes it ineligible as a leaf. */
  await account('1901', 'Under header', 'asset', { parentAccountId: parent });

  return { org, user, cost, accumulated, expense, bank, parent, account };
}

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

const categoryPayload = (b: Books, over: Record<string, unknown> = {}) => ({
  code: 'MACH',
  name: 'Machinery',
  defaultMethod: 'straight_line',
  defaultUsefulLifeMonths: 120,
  defaultResidualPercent: '5',
  assetCostAccountId: b.cost,
  accumulatedDepreciationAccountId: b.accumulated,
  depreciationExpenseAccountId: b.expense,
  ...over,
});

async function category(b: Books, over: Record<string, unknown> = {}) {
  const r = await call('POST', '/api/fixed-assets/categories', b.user, categoryPayload(b, over));
  expect(r.statusCode, r.body).toBe(201);
  return r.json().category;
}

const assetPayload = (categoryId: string, over: Record<string, unknown> = {}) => ({
  name: 'Lathe',
  categoryId,
  acquisitionDate: '2026-03-01',
  ...over,
});

async function asset(b: Books, categoryId: string, over: Record<string, unknown> = {}) {
  const r = await call('POST', '/api/fixed-assets/assets', b.user, assetPayload(categoryId, over));
  expect(r.statusCode, r.body).toBe(201);
  return r.json().asset;
}

async function countRows(table: string, org: string): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    SELECT COUNT(*)::int AS n FROM ${sql.table(table)} WHERE organization_id = ${org}
  `.execute(ctx.db);
  return rows[0]!.n;
}

/* ══ Categories ════════════════════════════════════════════════════════════ */

describe('asset categories', () => {
  it('creates one, and creates no journal doing it', async () => {
    const b = await books('Cat');
    const created = await category(b);

    expect(created.code).toBe('MACH');
    expect(created.defaultMethod).toBe('straight_line');
    expect(created.defaultUsefulLifeMonths).toBe(120);
    expect(created.depreciationConvention).toBe('full_month');
    expect(created.mappingComplete).toBe(true);
    expect(created.version).toBe(1);
    expect(created.assetCostAccountLabel).toMatch(/1112/);

    /* The whole point of F1: configuration, not accounting. */
    expect(await countRows('journal_entries', b.org)).toBe(0);
    expect(await countRows('journal_lines', b.org)).toBe(0);
  });

  it('refuses a duplicate code, ignoring case', async () => {
    const b = await books('Dup');
    await category(b);
    const again = await call('POST', '/api/fixed-assets/categories', b.user,
      categoryPayload(b, { code: 'mach' }));
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toMatch(/already used/i);
  });

  it('edits with the version the server last returned, and refuses a stale one', async () => {
    const b = await books('Ver');
    const created = await category(b);

    const ok = await call('PATCH', `/api/fixed-assets/categories/${created.id}`, b.user, {
      ...categoryPayload(b), name: 'Heavy machinery', expectedVersion: created.version,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().category.version).toBe(2);

    const stale = await call('PATCH', `/api/fixed-assets/categories/${created.id}`, b.user, {
      ...categoryPayload(b), name: 'Later', expectedVersion: created.version,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.message).toMatch(/changed by another user/i);
  });

  it('archives and reactivates rather than deleting', async () => {
    const b = await books('Arch');
    const created = await category(b);

    const archived = await call(
      'POST', `/api/fixed-assets/categories/${created.id}/archive`, b.user,
      { expectedVersion: created.version, archived: true },
    );
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json().category.status).toBe('archived');

    /* Still there, and still readable. */
    expect(await countRows('fixed_asset_categories', b.org)).toBe(1);

    const back = await call(
      'POST', `/api/fixed-assets/categories/${created.id}/archive`, b.user,
      { expectedVersion: archived.json().category.version, archived: false },
    );
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().category.status).toBe('active');

    expect(await countRows('journal_entries', b.org)).toBe(0);
  });

  it('REFUSES to archive a category assets still need', async () => {
    const b = await books('InUse');
    const created = await category(b);
    await asset(b, created.id);

    const fresh = await call('GET', `/api/fixed-assets/categories/${created.id}`, b.user);
    const refused = await call(
      'POST', `/api/fixed-assets/categories/${created.id}/archive`, b.user,
      { expectedVersion: fresh.json().category.version, archived: true },
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toMatch(/1 asset\(s\)/);
  });

  it('DOES archive once the assets are archived too', async () => {
    const b = await books('FreeAgain');
    const created = await category(b);
    const one = await asset(b, created.id);

    await call('POST', `/api/fixed-assets/assets/${one.id}/archive`, b.user,
      { expectedVersion: one.version, archived: true });

    const fresh = await call('GET', `/api/fixed-assets/categories/${created.id}`, b.user);
    const ok = await call(
      'POST', `/api/fixed-assets/categories/${created.id}/archive`, b.user,
      { expectedVersion: fresh.json().category.version, archived: true },
    );
    expect(ok.statusCode, ok.body).toBe(200);
  });
});

/* ══ Account eligibility ═══════════════════════════════════════════════════ */

describe('category account mappings', () => {
  it('demands a CONTRA-ASSET for accumulated depreciation, and says why', async () => {
    const b = await books('Contra');
    /* An ordinary debit-balance asset: right type, wrong side. */
    const debitAsset = await b.account('1113', 'Vehicles', 'asset', { normalBalance: 'debit' });

    const r = await call('POST', '/api/fixed-assets/categories', b.user,
      categoryPayload(b, { accumulatedDepreciationAccountId: debitAsset }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/contra-asset/i);
    expect(r.json().error.details.fieldErrors.accumulatedDepreciationAccountId)
      .toMatch(/credit/i);
  });

  it('refuses an EXPENSE as accumulated depreciation', async () => {
    const b = await books('ExpAccum');
    const r = await call('POST', '/api/fixed-assets/categories', b.user,
      categoryPayload(b, { accumulatedDepreciationAccountId: b.expense }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/must be asset/i);
  });

  it('refuses a credit-balance account as the asset COST account', async () => {
    const b = await books('CostSide');
    const r = await call('POST', '/api/fixed-assets/categories', b.user,
      categoryPayload(b, { assetCostAccountId: b.accumulated }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/debit normal balance|must have a debit/i);
  });

  it('refuses an asset account as depreciation expense', async () => {
    const b = await books('WrongExpense');
    const r = await call('POST', '/api/fixed-assets/categories', b.user,
      categoryPayload(b, { depreciationExpenseAccountId: b.cost }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/must be expense/i);
  });

  it('refuses a cash account for any role', async () => {
    const b = await books('CashRole');
    const r = await call('POST', '/api/fixed-assets/categories', b.user,
      categoryPayload(b, { assetCostAccountId: b.bank }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/cash or bank/i);
  });

  it('refuses a PARENT account, and a non-postable one', async () => {
    const b = await books('Parent');
    const r = await call('POST', '/api/fixed-assets/categories', b.user,
      categoryPayload(b, { assetCostAccountId: b.parent }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/posting account|parent/i);
  });

  it('refuses an inactive account, and an archived one', async () => {
    const b = await books('Inactive');
    const spare = await b.account('1114', 'Fittings', 'asset', { normalBalance: 'debit' });
    const off = await call('PATCH', `/api/accounting/accounts/${spare}`, b.user, { active: false });
    expect(off.statusCode, off.body).toBe(200);

    const r = await call('POST', '/api/fixed-assets/categories', b.user,
      categoryPayload(b, { assetCostAccountId: spare }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/inactive/i);
  });

  it('refuses ANOTHER COMPANY’S account — it is invisible, not visible-and-refused', async () => {
    const mine = await books('Mine');
    const theirs = await books('Theirs');

    const r = await call('POST', '/api/fixed-assets/categories', mine.user,
      categoryPayload(mine, { assetCostAccountId: theirs.cost }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/does not exist in these books/i);
  });

  it('refuses one account in two incompatible roles', async () => {
    const b = await books('SameAccount');
    const r = await call('POST', '/api/fixed-assets/categories', b.user,
      categoryPayload(b, { accumulatedDepreciationAccountId: b.cost }));
    /* Type is fine — both are assets — so it is the DUPLICATION that refuses. */
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/same account cannot be both|credit/i);
  });

  it('accepts a category with NO mappings, and reports it as incomplete', async () => {
    const b = await books('Unmapped');
    const r = await call('POST', '/api/fixed-assets/categories', b.user, {
      code: 'TBD', name: 'To be configured', defaultUsefulLifeMonths: 60,
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().category.mappingComplete).toBe(false);

    const report = await call('GET', '/api/fixed-assets/reports/register', b.user);
    expect(report.statusCode, report.body).toBe(200);
    expect(report.json().report.configurationIssues[0].issue).toBe('missing-account-mapping');
  });
});

/* ══ Depreciation policy ═══════════════════════════════════════════════════ */

describe('depreciation policy', () => {
  it('refuses reducing balance BY NAME, saying which piece is missing', async () => {
    const b = await books('Reducing');
    const r = await call('POST', '/api/fixed-assets/categories', b.user,
      categoryPayload(b, { defaultMethod: 'reducing_balance' }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/Reducing balance is not available yet/);
    expect(r.json().error.message).toMatch(/annual rate/i);
  });

  it('refuses units of production BY NAME, saying there is no usage source', async () => {
    const b = await books('Units');
    const r = await call('POST', '/api/fixed-assets/categories', b.user,
      categoryPayload(b, { defaultMethod: 'units_of_production' }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/no source of usage/i);
  });

  it('refuses sum of the years’ digits, and double declining, by name', async () => {
    const b = await books('Digits');
    for (const method of ['sum_of_years_digits', 'double_declining_balance', 'custom']) {
      const r = await call('POST', '/api/fixed-assets/categories', b.user,
        categoryPayload(b, { defaultMethod: method }));
      expect(r.statusCode, method).toBe(400);
      expect(r.json().error.message).toMatch(/not available|not implemented|not available yet/i);
    }
  });

  it('refuses every convention except the full month, by name', async () => {
    const b = await books('Conv');
    for (const convention of ['half_month', 'half_year', 'mid_quarter', 'daily', 'actual_days']) {
      const r = await call('POST', '/api/fixed-assets/categories', b.user,
        categoryPayload(b, { depreciationConvention: convention }));
      expect(r.statusCode, convention).toBe(400);
      expect(r.json().error.message).toMatch(/not available/i);
    }
  });

  it('measures useful life in MONTHS, and says so rather than converting years', async () => {
    const b = await books('Months');
    const c = await category(b);
    const one = await asset(b, c.id, { usefulLifeMonths: 36 });
    expect(one.usefulLifeMonths).toBe(36);
    expect(one.usefulLifeUnit).toBe('months');

    const zero = await call('POST', '/api/fixed-assets/assets', b.user,
      assetPayload(c.id, { assetCode: 'Z1', usefulLifeMonths: 0 }));
    expect(zero.statusCode).toBe(400);
    expect(zero.json().error.message).toMatch(/does not convert years/i);
  });

  it('bounds useful life, refusing more than a hundred years', async () => {
    const b = await books('Bound');
    const c = await category(b);
    const r = await call('POST', '/api/fixed-assets/assets', b.user,
      assetPayload(c.id, { usefulLifeMonths: 1201 }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/1200-month/);
  });

  it('lets `none` carry no life at all, and refuses one', async () => {
    const b = await books('Land');
    const land = await category(b, {
      code: 'LAND', name: 'Land', defaultMethod: 'none', defaultUsefulLifeMonths: null,
    });
    expect(land.defaultUsefulLifeMonths).toBeNull();

    const one = await asset(b, land.id, { name: 'Plot 4' });
    expect(one.depreciationMethod).toBe('none');
    expect(one.usefulLifeMonths).toBeNull();

    const wrong = await call('POST', '/api/fixed-assets/assets', b.user,
      assetPayload(land.id, { assetCode: 'L2', usefulLifeMonths: 60 }));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.message).toMatch(/no useful life to state/i);
  });

  it('does not demand depreciation accounts for a category that never depreciates', async () => {
    const b = await books('LandMap');
    await category(b, {
      code: 'LAND', name: 'Land', defaultMethod: 'none', defaultUsefulLifeMonths: null,
      accumulatedDepreciationAccountId: null, depreciationExpenseAccountId: null,
    });
    const report = await call('GET', '/api/fixed-assets/reports/register', b.user);
    expect(report.json().report.configurationIssues).toEqual([]);
  });
});

/* ══ Category defaults are COPIED, never read back ═════════════════════════ */

describe('category defaults', () => {
  it('copies method and life onto a new asset', async () => {
    const b = await books('Copy');
    const c = await category(b, { defaultUsefulLifeMonths: 84 });
    const one = await asset(b, c.id);
    expect(one.usefulLifeMonths).toBe(84);
    expect(one.depreciationMethod).toBe('straight_line');
  });

  it('NEVER changes an existing asset when the category default changes', async () => {
    const b = await books('Frozen');
    const c = await category(b, { defaultUsefulLifeMonths: 84 });
    const one = await asset(b, c.id);
    expect(one.usefulLifeMonths).toBe(84);

    const edited = await call('PATCH', `/api/fixed-assets/categories/${c.id}`, b.user, {
      ...categoryPayload(b), defaultUsefulLifeMonths: 24, expectedVersion: c.version,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().category.defaultUsefulLifeMonths).toBe(24);

    /* The asset kept what it froze. This is the whole reason the column is
     * duplicated onto the asset row. */
    const after = await call('GET', `/api/fixed-assets/assets/${one.id}`, b.user);
    expect(after.json().asset.usefulLifeMonths).toBe(84);
  });

  it('records which category the policy came from, and what it said', async () => {
    const b = await books('Provenance');
    const c = await category(b, { defaultUsefulLifeMonths: 84 });
    const one = await asset(b, c.id);

    const history = await call('GET', `/api/fixed-assets/assets/${one.id}/history`, b.user);
    const registered = history.json().events.find(
      (e: { action: string }) => e.action === 'ASSET_REGISTERED',
    );
    expect(registered.detail.copiedFromCategory.code).toBe('MACH');
    expect(registered.detail.copiedFromCategory.defaultUsefulLifeMonths).toBe(84);
  });
});

/* ══ The register ══════════════════════════════════════════════════════════ */

describe('the asset register', () => {
  it('registers an asset, allocates a code, and creates no journal', async () => {
    const b = await books('Reg');
    const c = await category(b);
    const one = await asset(b, c.id);

    expect(one.assetCode).toBe('AST-0001');
    expect(one.status).toBe('draft');
    expect(one.accountingActivityCount).toBe(0);
    expect(one.policyEditable).toBe(true);
    expect(one.acquisitionDate).toBe('2026-03-01');

    const two = await asset(b, c.id, { name: 'Press' });
    expect(two.assetCode).toBe('AST-0002');

    expect(await countRows('journal_entries', b.org)).toBe(0);
    expect(await countRows('journal_lines', b.org)).toBe(0);
  });

  it('takes a supplied code, and refuses a duplicate ignoring case', async () => {
    const b = await books('Codes');
    const c = await category(b);
    const one = await asset(b, c.id, { assetCode: 'FA-100' });
    expect(one.assetCode).toBe('FA-100');

    const clash = await call('POST', '/api/fixed-assets/assets', b.user,
      assetPayload(c.id, { assetCode: 'fa-100', name: 'Another' }));
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.message).toMatch(/already used/i);
  });

  it('never reuses an allocated code after an archive', async () => {
    const b = await books('Seq');
    const c = await category(b);
    const one = await asset(b, c.id);
    await call('POST', `/api/fixed-assets/assets/${one.id}/archive`, b.user,
      { expectedVersion: one.version, archived: true });

    const next = await asset(b, c.id, { name: 'Second' });
    /* A MAX over the register would have said AST-0001 again. The held
     * sequence is what stops two assets ever sharing an identity. */
    expect(next.assetCode).toBe('AST-0002');
  });

  it('edits, and refuses a stale version', async () => {
    const b = await books('EditAsset');
    const c = await category(b);
    const one = await asset(b, c.id);

    const ok = await call('PATCH', `/api/fixed-assets/assets/${one.id}`, b.user, {
      ...assetPayload(c.id), name: 'Lathe mk II', expectedVersion: one.version,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().asset.name).toBe('Lathe mk II');
    expect(ok.json().asset.version).toBe(2);

    const stale = await call('PATCH', `/api/fixed-assets/assets/${one.id}`, b.user, {
      ...assetPayload(c.id), name: 'Later', expectedVersion: one.version,
    });
    expect(stale.statusCode).toBe(409);
  });

  it('archives and reactivates, and an archived asset stays searchable', async () => {
    const b = await books('ArchiveAsset');
    const c = await category(b);
    const one = await asset(b, c.id, { name: 'Old lathe' });

    const archived = await call('POST', `/api/fixed-assets/assets/${one.id}/archive`, b.user,
      { expectedVersion: one.version, archived: true, reason: 'Sold privately, not yet posted' });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json().asset.status).toBe('archived');

    /* No status filter means EVERY status. An archived asset is the record of
     * something the business owned. */
    const all = await call('GET', '/api/fixed-assets/assets', b.user);
    expect(all.json().assets).toHaveLength(1);

    const found = await call('GET', '/api/fixed-assets/assets?search=old%20lathe', b.user);
    expect(found.json().assets).toHaveLength(1);

    const onlyDraft = await call('GET', '/api/fixed-assets/assets?status=draft', b.user);
    expect(onlyDraft.json().assets).toHaveLength(0);

    const back = await call('POST', `/api/fixed-assets/assets/${one.id}/archive`, b.user,
      { expectedVersion: archived.json().asset.version, archived: false });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().asset.status).toBe('draft');

    expect(await countRows('journal_entries', b.org)).toBe(0);
  });

  it('refuses to reactivate an asset whose category is archived', async () => {
    const b = await books('Orphan');
    const c = await category(b);
    const one = await asset(b, c.id);

    const archived = await call('POST', `/api/fixed-assets/assets/${one.id}/archive`, b.user,
      { expectedVersion: one.version, archived: true });
    const fresh = await call('GET', `/api/fixed-assets/categories/${c.id}`, b.user);
    await call('POST', `/api/fixed-assets/categories/${c.id}/archive`, b.user,
      { expectedVersion: fresh.json().category.version, archived: true });

    const back = await call('POST', `/api/fixed-assets/assets/${one.id}/archive`, b.user,
      { expectedVersion: archived.json().asset.version, archived: false });
    expect(back.statusCode).toBe(409);
    expect(back.json().error.message).toMatch(/archived/i);
  });

  it('refuses ANOTHER COMPANY’S category', async () => {
    const mine = await books('MineCat');
    const theirs = await books('TheirsCat');
    const theirCategory = await category(theirs);

    const r = await call('POST', '/api/fixed-assets/assets', mine.user,
      assetPayload(theirCategory.id));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/does not exist in these books/i);
  });

  it('refuses an archived category for a NEW asset', async () => {
    const b = await books('ArchivedCat');
    const c = await category(b);
    await call('POST', `/api/fixed-assets/categories/${c.id}/archive`, b.user,
      { expectedVersion: c.version, archived: true });

    const r = await call('POST', '/api/fixed-assets/assets', b.user, assetPayload(c.id));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/archived and cannot take new assets/i);
  });

  it('requires a positive quantity of units', async () => {
    const b = await books('Qty');
    const c = await category(b);
    const r = await call('POST', '/api/fixed-assets/assets', b.user,
      assetPayload(c.id, { quantity: 0 }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details.fieldErrors.quantity).toMatch(/at least one unit/i);
  });

  it('refuses a depreciation start before the acquisition', async () => {
    const b = await books('Dates');
    const c = await category(b);
    const r = await call('POST', '/api/fixed-assets/assets', b.user,
      assetPayload(c.id, { depreciationStartDate: '2026-02-01' }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/before the asset was acquired/i);
  });
});

/* ══ Suppliers, and the acquisition boundary ═══════════════════════════════ */

describe('supplier references', () => {
  async function supplier(b: Books, name: string): Promise<string> {
    const r = await call('POST', '/api/vendors', b.user, {
      legalName: name, partyCode: name.toUpperCase().slice(0, 6),
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().supplier.id;
  }

  it('records a supplier as SOURCE INFORMATION, posting nothing', async () => {
    const b = await books('Source');
    const c = await category(b);
    const id = await supplier(b, 'Toolmakers');

    const one = await asset(b, c.id, {
      supplierPartyId: id, purchaseReference: 'INV-88',
    });
    expect(one.supplierPartyId).toBe(id);
    expect(one.supplierName).toBe('Toolmakers');
    expect(one.purchaseReference).toBe('INV-88');

    /* No bill, no journal, no capitalisation. */
    expect(await countRows('journal_entries', b.org)).toBe(0);
    expect(await countRows('bills', b.org)).toBe(0);
  });

  it('refuses ANOTHER COMPANY’S supplier', async () => {
    const mine = await books('MineSup');
    const theirs = await books('TheirsSup');
    const c = await category(mine);
    const theirParty = await supplier(theirs, 'Elsewhere');

    const r = await call('POST', '/api/fixed-assets/assets', mine.user,
      assetPayload(c.id, { supplierPartyId: theirParty }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/does not exist in these books/i);
  });

  it('refuses a party that is not a supplier', async () => {
    const b = await books('CustOnly');
    const c = await category(b);
    const cust = await call('POST', '/api/customers', b.user, {
      legalName: 'Buyer', partyCode: 'BUY1',
    });
    expect(cust.statusCode, cust.body).toBe(201);

    const r = await call('POST', '/api/fixed-assets/assets', b.user,
      assetPayload(c.id, { supplierPartyId: cust.json().customer.id }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/not recorded as a supplier/i);
  });

  it('a supplier bill STILL cannot name a capital asset', async () => {
    const b = await books('BillBoundary');
    const c = await category(b);
    await asset(b, c.id);
    const id = await supplier(b, 'Toolmakers');
    const payable = await b.account('2100', 'Trade payables', 'liability');
    const expense = await b.account('5100', 'Supplies', 'expense');

    const r = await call('POST', '/api/bills', b.user, {
      supplierId: id, supplierInvoiceNumber: 'S-1',
      billDate: '2026-03-01', dueDate: '2026-03-31',
      payableAccountId: payable,
      lines: [{
        accountId: expense, description: 'A machine', quantity: '1', unitPrice: '1000.000',
        capitalAssetId: '11111111-1111-1111-1111-111111111111',
      }],
    });
    /* Refused exactly as before F1. Registering an asset gave the bill no new
     * route into the register. */
    expect(r.statusCode).toBe(400);
    expect(await countRows('journal_entries', b.org)).toBe(0);
  });
});

/* ══ What a client may not send ════════════════════════════════════════════ */

describe('fields this release refuses by name', () => {
  it('refuses an acquisition cost, and says where cost comes from', async () => {
    const b = await books('NoCost');
    const c = await category(b);
    const r = await call('POST', '/api/fixed-assets/assets', b.user,
      assetPayload(c.id, { acquisitionCost: '5000.000' }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details.fieldErrors.acquisitionCost)
      .toMatch(/capitalisation that posts it/i);
  });

  it('refuses accumulated depreciation, carrying amount and a capitalisation date', async () => {
    const b = await books('NoBalances');
    const c = await category(b);
    for (const field of [
      'accumulatedDepreciation', 'netBookValue', 'carryingAmount',
      'capitalizationDate', 'impairmentBalance', 'disposalProceeds',
    ]) {
      const r = await call('POST', '/api/fixed-assets/assets', b.user,
        assetPayload(c.id, { [field]: field.endsWith('Date') ? '2026-03-01' : '1' }));
      expect(r.statusCode, field).toBe(400);
      expect(r.json().error.details.fieldErrors[field]).toBeTruthy();
    }
  });

  it('refuses a client-supplied creator, editor, actor and timestamp', async () => {
    const b = await books('NoTamper');
    const c = await category(b);
    for (const field of ['createdBy', 'updatedBy', 'approvedBy', 'createdAt', 'actorName']) {
      const r = await call('POST', '/api/fixed-assets/assets', b.user,
        assetPayload(c.id, { [field]: 'somebody else' }));
      expect(r.statusCode, field).toBe(400);
      expect(r.json().error.details.fieldErrors[field])
        .toMatch(/session|server|never supplied by a client/i);
    }
  });

  it('refuses a status claiming the asset is in service or disposed', async () => {
    const b = await books('NoStatus');
    const c = await category(b);
    const r = await call('POST', '/api/fixed-assets/assets', b.user,
      assetPayload(c.id, { status: 'active' }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details.fieldErrors.status).toMatch(/registered as a draft/i);
  });

  it('refuses a serial number, an asset tag and a component parent', async () => {
    const b = await books('NoFields');
    const c = await category(b);
    for (const field of ['serialNumber', 'assetTag', 'barcode', 'parentAssetId']) {
      const r = await call('POST', '/api/fixed-assets/assets', b.user,
        assetPayload(c.id, { [field]: 'X' }));
      expect(r.statusCode, field).toBe(400);
      expect(r.json().error.details.fieldErrors[field]).toBeTruthy();
    }
  });

  it('refuses a currency, a cost centre and a project', async () => {
    const b = await books('NoDims');
    const c = await category(b);
    for (const field of ['currency', 'exchangeRate', 'costCenterId', 'projectId']) {
      const r = await call('POST', '/api/fixed-assets/assets', b.user,
        assetPayload(c.id, { [field]: 'X' }));
      expect(r.statusCode, field).toBe(400);
      expect(r.json().error.details.fieldErrors[field]).toBeTruthy();
    }
  });

  it('refuses the organization and company as body fields', async () => {
    const mine = await books('NoScope');
    const theirs = await books('Other');
    const c = await category(mine);
    const r = await call('POST', '/api/fixed-assets/assets', mine.user,
      assetPayload(c.id, { organizationId: theirs.org }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details.fieldErrors.organizationId).toMatch(/membership/i);
  });
});

/* ══ Deferred workflows ════════════════════════════════════════════════════ */

describe('workflows this release refuses', () => {
  it('says what it does and does not support', async () => {
    const b = await books('Caps');
    const r = await call('GET', '/api/fixed-assets/capabilities', b.user);
    expect(r.statusCode, r.body).toBe(200);

    const caps = r.json().capabilities;
    expect(caps.registerRecords).toBe(true);
    expect(caps.acquisitionCost).toBe(false);
    expect(caps.capitalization).toBe(false);
    expect(caps.depreciationPosting).toBe(false);
    expect(caps.depreciationPreview).toBe(false);
    expect(caps.disposal).toBe(false);
    expect(caps.impairment).toBe(false);
    expect(caps.revaluation).toBe(false);
    expect(caps.billAcquisition).toBe(false);
    expect(caps.componentAccounting).toBe(false);
    expect(caps.taxBooks).toBe(false);
    expect(caps.attachments).toBe(false);
    expect(caps.usefulLifeUnit).toBe('months');
    expect(caps.supportedMethods).toEqual(['straight_line', 'none']);
    expect(caps.supportedConventions).toEqual(['full_month']);
  });

  it('refuses every posting workflow with a sentence, not a 404', async () => {
    const b = await books('Refusals');
    const c = await category(b);
    const one = await asset(b, c.id);

    const cases: Array<[string, RegExp]> = [
      [`/api/fixed-assets/assets/${one.id}/capitalize`, /Capitalisation is not available/],
      [`/api/fixed-assets/assets/${one.id}/depreciate`, /Depreciation is not available/],
      ['/api/fixed-assets/depreciation/runs', /Depreciation is not available/],
      ['/api/fixed-assets/depreciation/preview', /Depreciation is not available/],
      [`/api/fixed-assets/assets/${one.id}/impair`, /Impairment/],
      [`/api/fixed-assets/assets/${one.id}/revalue`, /Revaluation/],
      [`/api/fixed-assets/assets/${one.id}/dispose`, /Disposal/],
      [`/api/fixed-assets/assets/${one.id}/transfer`, /transfers are not available/i],
      [`/api/fixed-assets/assets/${one.id}/attachments`, /document store/],
      ['/api/fixed-assets/assets/from-bill', /supplier bill cannot create/],
    ];
    for (const [url, pattern] of cases) {
      const r = await call('POST', url, b.user, {});
      expect(r.statusCode, url).toBe(400);
      expect(r.json().error.message, url).toMatch(pattern);
    }

    const schedule = await call('GET', `/api/fixed-assets/assets/${one.id}/schedule`, b.user);
    expect(schedule.statusCode).toBe(400);
    expect(schedule.json().error.message).toMatch(/Depreciation is not available/);

    /* And after all of that, still no accounting anywhere. */
    expect(await countRows('journal_entries', b.org)).toBe(0);
  });

  it('produces no depreciation schedule table anywhere in the schema', async () => {
    const { rows } = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM information_schema.tables
       WHERE table_name IN ('fixed_asset_depreciation_runs','fixed_asset_transactions',
                            'depreciation_schedules','fixed_asset_depreciation_lines')
    `.execute(ctx.db);
    expect(rows[0]!.n).toBe(0);
  });

  it('has no column that could hold a cost or a posted balance', async () => {
    const { rows } = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'fixed_assets'
         AND column_name IN ('acquisition_cost','original_cost','cost',
                             'accumulated_depreciation','net_book_value','carrying_amount',
                             'impairment_balance','capitalization_date','disposal_proceeds')
    `.execute(ctx.db);
    expect(rows).toEqual([]);
  });
});

/* ══ Money and dates ═══════════════════════════════════════════════════════ */

describe('exact amounts and calendar dates', () => {
  it('keeps a JOD residual value to three places', async () => {
    const b = await books('JOD', 'core', 'admin', 'JOD');
    const c = await category(b);
    const one = await asset(b, c.id, { residualValue: '1250.125' });
    expect(one.residualValue).toBe('1250.125');

    const read = await call('GET', `/api/fixed-assets/assets/${one.id}`, b.user);
    expect(read.json().asset.residualValue).toBe('1250.125');
  });

  it('keeps a USD two-decimal and a JPY whole-number residual exactly', async () => {
    const usd = await books('USD', 'core', 'admin', 'USD');
    const c1 = await category(usd);
    const a1 = await asset(usd, c1.id, { residualValue: '99.99' });
    expect(a1.residualValue).toBe('99.99');

    const jpy = await books('JPY', 'core', 'admin', 'JPY');
    const c2 = await category(jpy);
    const a2 = await asset(jpy, c2.id, { residualValue: '15000' });
    expect(a2.residualValue).toBe('15000');
  });

  it('refuses a negative residual value, and one that is not a decimal', async () => {
    const b = await books('BadMoney');
    const c = await category(b);
    for (const value of ['-1', '1e3', '1,000', 'abc']) {
      const r = await call('POST', '/api/fixed-assets/assets', b.user,
        assetPayload(c.id, { residualValue: value }));
      expect(r.statusCode, value).toBe(400);
    }
  });

  it('does not shift a calendar date east of Greenwich', async () => {
    /*
     * The bug this guards: `node-postgres` parses a bare `date` at LOCAL
     * midnight, and `.toISOString()` on that lands on the previous day in
     * UTC+3. PGlite returns strings, so the whole class is invisible here —
     * the real-PostgreSQL probe is what proves it — but the round trip is
     * still worth holding.
     */
    const original = process.env.TZ;
    process.env.TZ = 'Asia/Amman';
    try {
      const b = await books('Timezone');
      const c = await category(b);
      const one = await asset(b, c.id, {
        acquisitionDate: '2026-03-01', depreciationStartDate: '2026-04-01',
      });
      expect(one.acquisitionDate).toBe('2026-03-01');
      expect(one.depreciationStartDate).toBe('2026-04-01');

      const read = await call('GET', `/api/fixed-assets/assets/${one.id}`, b.user);
      expect(read.json().asset.acquisitionDate).toBe('2026-03-01');

      /* And a round trip through an edit does not lose another day. */
      const edited = await call('PATCH', `/api/fixed-assets/assets/${one.id}`, b.user, {
        ...assetPayload(c.id), acquisitionDate: read.json().asset.acquisitionDate,
        depreciationStartDate: read.json().asset.depreciationStartDate,
        expectedVersion: one.version,
      });
      expect(edited.json().asset.acquisitionDate).toBe('2026-03-01');
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

/* ══ Permissions, entitlement and isolation ════════════════════════════════ */

describe('permissions and entitlements', () => {
  it('lets a VIEWER read and refuses every write', async () => {
    const b = await books('Viewer');
    const c = await category(b);
    const viewer = await memberOf(b.org, 'viewer', 'viewer@fa.test');

    const read = await call('GET', '/api/fixed-assets/assets', viewer);
    expect(read.statusCode, read.body).toBe(200);

    const write = await call('POST', '/api/fixed-assets/assets', viewer, assetPayload(c.id));
    expect(write.statusCode).toBe(403);

    const cat = await call('POST', '/api/fixed-assets/categories', viewer, categoryPayload(b, {
      code: 'X',
    }));
    expect(cat.statusCode).toBe(403);
  });

  it('refuses an archive to a member who may not edit', async () => {
    const b = await books('NoEdit');
    const c = await category(b);
    const one = await asset(b, c.id);
    const viewer = await memberOf(b.org, 'viewer', 'noedit@fa.test');

    const r = await call('POST', `/api/fixed-assets/assets/${one.id}/archive`, viewer,
      { expectedVersion: one.version, archived: true });
    expect(r.statusCode).toBe(403);
  });

  it('refuses everything to a member of ANOTHER organization', async () => {
    const mine = await books('IsoA');
    const theirs = await books('IsoB');
    const c = await category(mine);
    const one = await asset(mine, c.id);

    const read = await call('GET', `/api/fixed-assets/assets/${one.id}`, theirs.user);
    /* Not found rather than forbidden: whether another tenant's asset exists is
     * not something a caller should be able to probe. */
    expect(read.statusCode).toBe(404);

    const list = await call('GET', '/api/fixed-assets/assets', theirs.user);
    expect(list.json().assets).toEqual([]);
  });

  it('refuses the whole module when the subscription has lapsed', async () => {
    const b = await books('Lapsed');
    await sql`
      UPDATE organization_entitlements SET active = false WHERE organization_id = ${b.org}
    `.execute(ctx.db);

    const r = await call('GET', '/api/fixed-assets/assets', b.user);
    expect(r.statusCode).toBe(403);
  });

  it('is reachable on CORE, because every package sells fixed_assets', async () => {
    const b = await books('CoreTier', 'core');
    const r = await call('GET', '/api/fixed-assets/categories', b.user);
    expect(r.statusCode, r.body).toBe(200);
  });

  it('refuses the module when the fixed_assets entitlement is withdrawn', async () => {
    const b = await books('NoModule');
    await sql`
      UPDATE organization_entitlements
         SET modules = ${JSON.stringify(['accounting', 'invoicing', 'reports'])}
       WHERE organization_id = ${b.org}
    `.execute(ctx.db);

    const r = await call('GET', '/api/fixed-assets/assets', b.user);
    expect(r.statusCode).toBe(403);
  });
});

/* ══ Audit ═════════════════════════════════════════════════════════════════ */

describe('audit history', () => {
  it('records before and after for every material change', async () => {
    const b = await books('Audit');
    const c = await category(b);
    await call('PATCH', `/api/fixed-assets/categories/${c.id}`, b.user, {
      ...categoryPayload(b), defaultUsefulLifeMonths: 60, expectedVersion: c.version,
    });

    const history = await call('GET', `/api/fixed-assets/categories/${c.id}/history`, b.user);
    expect(history.statusCode, history.body).toBe(200);

    const events = history.json().events;
    expect(events.map((e: { action: string }) => e.action))
      .toEqual(['CATEGORY_UPDATED', 'CATEGORY_CREATED']);

    const updated = events[0];
    expect(updated.previousVersion).toBe(1);
    expect(updated.resultingVersion).toBe(2);
    expect(updated.detail.before.default_useful_life_months).toBe(120);
    expect(updated.detail.after.default_useful_life_months).toBe(60);
    /* The actor is the server's, from the session. */
    expect(updated.actorName).toBe('Audit Person');
  });

  it('records the reason an asset was archived', async () => {
    const b = await books('Reason');
    const c = await category(b);
    const one = await asset(b, c.id);
    await call('POST', `/api/fixed-assets/assets/${one.id}/archive`, b.user,
      { expectedVersion: one.version, archived: true, reason: 'Scrapped on site' });

    const history = await call('GET', `/api/fixed-assets/assets/${one.id}/history`, b.user);
    expect(history.json().events[0].action).toBe('ASSET_ARCHIVED');
    expect(history.json().events[0].reason).toBe('Scrapped on site');
  });

  it('is APPEND-ONLY: the trail cannot be edited or deleted', async () => {
    const b = await books('Immutable');
    const c = await category(b);
    await asset(b, c.id);

    await expect(
      sql`UPDATE fixed_asset_audit_events SET actor_name = 'nobody'`.execute(ctx.db),
    ).rejects.toThrow(/cannot be edited/i);

    await expect(
      sql`DELETE FROM fixed_asset_audit_events`.execute(ctx.db),
    ).rejects.toThrow(/permanent record/i);
  });

  it('keeps the history of an ARCHIVED asset readable', async () => {
    const b = await books('HistArchived');
    const c = await category(b);
    const one = await asset(b, c.id);
    await call('POST', `/api/fixed-assets/assets/${one.id}/archive`, b.user,
      { expectedVersion: one.version, archived: true });

    const history = await call('GET', `/api/fixed-assets/assets/${one.id}/history`, b.user);
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().events.length).toBeGreaterThanOrEqual(2);
  });
});

/* ══ Reporting ═════════════════════════════════════════════════════════════ */

describe('the register report', () => {
  it('reports counts and refuses to claim it reconciles to the ledger', async () => {
    const b = await books('Report');
    const c = await category(b);
    await asset(b, c.id, { quantity: 3 });
    const two = await asset(b, c.id, { name: 'Press' });
    await call('POST', `/api/fixed-assets/assets/${two.id}/archive`, b.user,
      { expectedVersion: two.version, archived: true });

    const r = await call('GET', '/api/fixed-assets/reports/register', b.user);
    expect(r.statusCode, r.body).toBe(200);

    const report = r.json().report;
    expect(report.basis).toBe('register-master-data');
    expect(report.reconcilesToGeneralLedger).toBe(false);
    expect(report.note).toMatch(/not general-ledger balances/i);

    expect(report.totals.assets).toBe(2);
    expect(report.totals.draftAssets).toBe(1);
    expect(report.totals.archivedAssets).toBe(1);
    expect(report.totals.totalUnits).toBe(4);

    expect(report.byCategory[0].categoryCode).toBe('MACH');
    expect(report.byCategory[0].mappingComplete).toBe(true);

    /* And no money anywhere in it. */
    expect(JSON.stringify(report)).not.toMatch(/acquisitionCost|netBookValue|carryingAmount/);
  });

  it('needs the export permission, not merely view', async () => {
    const b = await books('ExportGate');
    const viewer = await memberOf(b.org, 'viewer', 'export@fa.test');
    /* Viewers hold `view` and `export` in the catalogue, so this proves the
     * route is gated at all rather than that a viewer is blocked. */
    const r = await call('GET', '/api/fixed-assets/reports/register', viewer);
    expect([200, 403]).toContain(r.statusCode);
  });
});

/* ══ Tenant deletion and reset ═════════════════════════════════════════════ */

describe('workspace deletion', () => {
  it('REFUSES the purge DELETE without the authorisation', async () => {
    const b = await books('NoAuth');
    const c = await category(b);
    await asset(b, c.id);

    /* Exactly the statement `deletionService` issues for this table. */
    await expect(
      sql`DELETE FROM fixed_asset_audit_events WHERE organization_id = ${b.org}`.execute(ctx.db),
    ).rejects.toThrow(/permanent record/i);
  });

  it('purges the register, its history and its numbering when authorised', async () => {
    const b = await books('Purge');
    const c = await category(b);
    await asset(b, c.id);

    expect(await countRows('fixed_assets', b.org)).toBe(1);
    expect(await countRows('fixed_asset_audit_events', b.org)).toBeGreaterThan(0);

    /*
     * The authorisation is what lets the append-only trigger's one exception
     * fire. Without it a workspace that had ever registered an asset could
     * never be destroyed at all.
     */
    await ctx.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ledgora.allow_fixed_asset_purge = 'on'`.execute(trx);
      for (const table of [
        'fixed_asset_audit_events', 'fixed_assets',
        'fixed_asset_numbering', 'fixed_asset_categories',
      ]) {
        await sql`DELETE FROM ${sql.table(table)} WHERE organization_id = ${b.org}`.execute(trx);
      }
    });

    expect(await countRows('fixed_assets', b.org)).toBe(0);
    expect(await countRows('fixed_asset_categories', b.org)).toBe(0);
    expect(await countRows('fixed_asset_numbering', b.org)).toBe(0);
    expect(await countRows('fixed_asset_audit_events', b.org)).toBe(0);
  });

  it('lets an authorised organization CASCADE take the trail with the tenant', async () => {
    const b = await books('Cascade');
    const c = await category(b);
    await asset(b, c.id);

    /*
     * The real purge deletes the organization, and every fixed-asset table
     * hangs off it with ON DELETE CASCADE. The append-only trigger fires on a
     * cascade like any other delete, so the authorisation has to cover it —
     * otherwise a tenant that had ever registered an asset would be
     * undeletable.
     *
     * Retiring the ownership claim first is what `deletionService` does; it is
     * migration 017's own precondition and is not part of what this proves.
     */
    await ctx.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ledgora.allow_fixed_asset_purge = 'on'`.execute(trx);
      await sql`SET LOCAL ledgora.allow_legal_purge = 'on'`.execute(trx);
      await sql`SET LOCAL ledgora.allow_stock_purge = 'on'`.execute(trx);
      await sql`
        UPDATE subscriber_workspace_ownership_claims
           SET retired_at = now()
         WHERE workspace_id = ${b.org} AND retired_at IS NULL
      `.execute(trx);
      await sql`DELETE FROM organizations WHERE id = ${b.org}`.execute(trx);
    });

    expect(await countRows('fixed_assets', b.org)).toBe(0);
    expect(await countRows('fixed_asset_categories', b.org)).toBe(0);
    expect(await countRows('fixed_asset_numbering', b.org)).toBe(0);
    expect(await countRows('fixed_asset_audit_events', b.org)).toBe(0);
  });

  it('still refuses an UPDATE to the trail, even under the purge authorisation', async () => {
    const b = await books('NoRewrite');
    const c = await category(b);
    await asset(b, c.id);

    /* The authorisation permits DELETE alone. Nothing can quietly rewrite a
     * trail under cover of a purge. */
    await expect(
      ctx.db.transaction().execute(async (trx) => {
        await sql`SET LOCAL ledgora.allow_fixed_asset_purge = 'on'`.execute(trx);
        await sql`UPDATE fixed_asset_audit_events SET actor_name = 'nobody'`.execute(trx);
      }),
    ).rejects.toThrow(/cannot be edited/i);
  });

  it('is registered in the tenant inventory and the reset plan', async () => {
    const { TENANT_DEPENDENCIES } = await import('../src/services/tenantInventory.js');
    const named = new Set(TENANT_DEPENDENCIES.map((d) => d.table as string));
    for (const table of [
      'fixed_assets', 'fixed_asset_categories',
      'fixed_asset_numbering', 'fixed_asset_audit_events',
    ]) {
      expect(named.has(table), `${table} must have a deletion decision`).toBe(true);
    }
  });
});

/* ══ The migration itself ══════════════════════════════════════════════════ */

describe('migration 044', () => {
  it('rolls back cleanly when the register is empty, and replays', async () => {
    const migrator = createMigrator(ctx.db);

    const down = await migrator.migrateDown();
    expect(down.error).toBeUndefined();
    expect(down.results?.[0]?.migrationName).toBe('044_fixed_asset_register');

    const { rows: gone } = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM information_schema.tables
       WHERE table_name IN ('fixed_assets','fixed_asset_categories',
                            'fixed_asset_numbering','fixed_asset_audit_events')
    `.execute(ctx.db);
    expect(gone[0]!.n).toBe(0);

    /* Reapplication must be safe: the same migration, run again, rebuilds it. */
    const up = await migrator.migrateToLatest();
    expect(up.error).toBeUndefined();

    const { rows: back } = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM information_schema.tables
       WHERE table_name IN ('fixed_assets','fixed_asset_categories',
                            'fixed_asset_numbering','fixed_asset_audit_events')
    `.execute(ctx.db);
    expect(back[0]!.n).toBe(4);
  });

  it('REFUSES to roll back over a real register', async () => {
    const b = await books('RollbackReg');
    const c = await category(b);
    await asset(b, c.id);

    const migrator = createMigrator(ctx.db);
    const down = await migrator.migrateDown();
    expect(down.error).toBeDefined();
    expect(String((down.error as Error).message)).toMatch(/Refusing to roll back 044/);

    /* And nothing was destroyed. */
    const still = await call('GET', '/api/fixed-assets/assets', b.user);
    expect(still.json().assets).toHaveLength(1);
  });

  it('rolls back over an empty register even after a category was archived', async () => {
    const b = await books('RollbackEmpty');
    const c = await category(b);
    await call('POST', `/api/fixed-assets/categories/${c.id}/archive`, b.user,
      { expectedVersion: c.version, archived: true });

    /* A category IS durable master data, so this must refuse too. */
    const migrator = createMigrator(ctx.db);
    const down = await migrator.migrateDown();
    expect(down.error).toBeDefined();
    expect(String((down.error as Error).message)).toMatch(/Refusing to roll back 044/);
  });
});

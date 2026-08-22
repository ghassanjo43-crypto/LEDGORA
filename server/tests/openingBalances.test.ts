import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeaders, createTestContext, login, seedUser, type SessionCookies, type TestContext } from './helpers/testApp.js';

let ctx: TestContext;
let admin: SessionCookies;
const password = 'Copper-Lantern-64-Wm';

beforeEach(async () => {
  ctx = await createTestContext();
  await seedUser(ctx, { email: 'super@ledgora.test', platformRoles: ['super_admin'] });
  admin = await login(ctx, 'super@ledgora.test');
});
afterEach(async () => ctx.close());

async function planId(): Promise<string> {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
  return response.json().plans.find((plan: { code: string }) => plan.code === 'core').id;
}

async function tenant(name: string): Promise<string> {
  const response = await ctx.app.inject({ method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(admin), payload: {
    fullName: `${name} Owner`, email: `owner@${name.toLowerCase()}.test`, organizationLegalName: `${name} LLC`, country: 'JO',
    baseCurrency: 'JOD', planId: await planId(), onboarding: 'temporary', paymentConfirmed: true,
  } });
  expect(response.statusCode).toBe(201);
  return response.json().subscriber.organizationId;
}

async function member(organizationId: string, role: string, email: string): Promise<SessionCookies> {
  const response = await ctx.app.inject({ method: 'POST', url: '/api/admin/users', headers: authHeaders(admin), payload: {
    fullName: email, email, organizationId, role, onboarding: 'invitation',
  } });
  expect(response.statusCode).toBe(201);
  await ctx.app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token: response.json().credential.invitationToken, newPassword: password } });
  return login(ctx, email, password);
}

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, user: SessionCookies, payload?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, headers: authHeaders(user), payload });

async function account(user: SessionCookies, code: string, name: string, type: string, extra: Record<string, unknown> = {}): Promise<string> {
  const response = await call('POST', '/api/accounting/accounts', user, { accountCode: code, accountName: name, accountType: type, ...extra });
  expect(response.statusCode).toBe(201);
  return response.json().account.id;
}

const input = (asset: string, liability: string, equity: string, amount = '100.001') => ({
  bookkeepingStartDate: '2027-01-01', reference: 'MIG-2027', description: 'Initial migration',
  lines: [{ accountId: asset, debit: amount }, { accountId: liability, credit: '40.000' }, { accountId: equity, credit: amount === '100.001' ? '60.001' : '60.00' }],
});

describe('opening balance workflow', () => {
  it('posts one precise balanced journal idempotently and keeps income accounts out', async () => {
    const org = await tenant('Opening');
    const owner = await member(org, 'admin', 'bookkeeper@opening.test');
    const asset = await account(owner, '1000', 'Migration cash', 'asset');
    const liability = await account(owner, '2000', 'Migration loan', 'liability');
    const equity = await account(owner, '3000', 'Opening balance equity', 'equity');
    await account(owner, '4000', 'Migration revenue forbidden', 'income');

    const created = await call('POST', '/api/accounting/opening-balances', owner, input(asset, liability, equity));
    expect(created.statusCode).toBe(201);
    expect(created.json().openingBalance.openingBalanceDate).toBe('2026-12-31');
    const id = created.json().openingBalance.id;
    const submitted = await call('POST', `/api/accounting/opening-balances/${id}/submit`, owner, { expectedVersion: 1 });
    const approved = await call('POST', `/api/accounting/opening-balances/${id}/approve`, owner, { expectedVersion: 2 });
    const posted = await call('POST', `/api/accounting/opening-balances/${id}/post`, owner, { expectedVersion: 3 });
    expect([submitted.statusCode, approved.statusCode, posted.statusCode]).toEqual([200, 200, 200]);
    expect(posted.json().openingBalance.journal.status).toBe('posted');
    expect(posted.json().openingBalance.journal.sourceType).toBe('opening_balance');

    const retried = await call('POST', '/api/accounting/opening-balances', owner, input(asset, liability, equity));
    expect(retried.json().openingBalance.id).toBe(id);
    expect(await ctx.db.selectFrom('journal_entries').select('id').where('organization_id', '=', org).where('source_type', '=', 'opening_balance').execute()).toHaveLength(1);
    const eligible = await call('GET', '/api/accounting/opening-balances/accounts', owner);
    expect(eligible.json().accounts.map((item: { code: string }) => item.code)).not.toContain('4000');
  });

  it('rejects imbalance, stale edits, control accounts, and cross-tenant access', async () => {
    const first = await tenant('First'); const second = await tenant('Second');
    const owner = await member(first, 'admin', 'staff@first.test'); const outsider = await member(second, 'admin', 'staff@second.test');
    const asset = await account(owner, '1000', 'Cash', 'asset');
    const liability = await account(owner, '2000', 'Loan', 'liability');
    const equity = await account(owner, '3000', 'Equity', 'equity');
    const receivable = await account(owner, '1100', 'Accounts Receivable', 'asset');
    const created = await call('POST', '/api/accounting/opening-balances', owner, { ...input(asset, liability, equity), lines: [{ accountId: asset, debit: '10.000' }, { accountId: equity, credit: '9.999' }] });
    const id = created.json().openingBalance.id;
    expect((await call('POST', `/api/accounting/opening-balances/${id}/submit`, owner, { expectedVersion: 1 })).statusCode).toBe(400);
    expect((await call('PATCH', `/api/accounting/opening-balances/${id}`, owner, { ...input(receivable, liability, equity), expectedVersion: 0 })).statusCode).toBe(409);
    const updated = await call('PATCH', `/api/accounting/opening-balances/${id}`, owner, { ...input(receivable, liability, equity), expectedVersion: 1 });
    expect(updated.statusCode).toBe(200);
    expect((await call('POST', `/api/accounting/opening-balances/${id}/submit`, owner, { expectedVersion: 2 })).statusCode).toBe(400);
    expect((await call('GET', `/api/accounting/opening-balances/${id}`, outsider)).statusCode).toBe(404);
  });

  it('enforces role authority and locked accounting periods', async () => {
    const org = await tenant('Locked');
    const owner = await member(org, 'admin', 'staff@locked.test');
    const viewer = await member(org, 'viewer', 'viewer@locked.test');
    expect((await call('POST', '/api/accounting/opening-balances', viewer, { bookkeepingStartDate: '2027-01-01', lines: [] })).statusCode).toBe(403);
    const asset = await account(owner, '1000', 'Cash', 'asset'); const liability = await account(owner, '2000', 'Loan', 'liability'); const equity = await account(owner, '3000', 'Equity', 'equity');
    const created = await call('POST', '/api/accounting/opening-balances', owner, input(asset, liability, equity)); const id = created.json().openingBalance.id;
    await call('POST', `/api/accounting/opening-balances/${id}/submit`, owner, { expectedVersion: 1 });
    await call('POST', `/api/accounting/opening-balances/${id}/approve`, owner, { expectedVersion: 2 });
    const period = await call('POST', '/api/accounting/periods', owner, { fiscalYear: 2026, periodNumber: 12, startDate: '2026-12-01', endDate: '2026-12-31' });
    expect(period.statusCode).toBe(201);
    expect((await call('PATCH', `/api/accounting/periods/${period.json().period.id}`, owner, { status: 'locked' })).statusCode).toBe(200);
    expect((await call('POST', `/api/accounting/opening-balances/${id}/post`, owner, { expectedVersion: 3 })).statusCode).toBe(409);
  });

  it('reverses exactly once and creates a linked replacement draft', async () => {
    const org = await tenant('Corrected'); const owner = await member(org, 'admin', 'staff@corrected.test');
    const asset = await account(owner, '1000', 'Cash', 'asset'); const liability = await account(owner, '2000', 'Loan', 'liability'); const equity = await account(owner, '3000', 'Equity', 'equity');
    const created = await call('POST', '/api/accounting/opening-balances', owner, input(asset, liability, equity)); const id = created.json().openingBalance.id;
    await call('POST', `/api/accounting/opening-balances/${id}/submit`, owner, { expectedVersion: 1 }); await call('POST', `/api/accounting/opening-balances/${id}/approve`, owner, { expectedVersion: 2 }); await call('POST', `/api/accounting/opening-balances/${id}/post`, owner, { expectedVersion: 3 });
    const reversed = await call('POST', `/api/accounting/opening-balances/${id}/reverse`, owner, { expectedVersion: 4, reason: 'Correct migration evidence' });
    expect(reversed.statusCode).toBe(200); expect(reversed.json().openingBalance.status).toBe('reversed');
    expect((await call('POST', `/api/accounting/opening-balances/${id}/reverse`, owner, { expectedVersion: 5, reason: 'retry' })).statusCode).toBe(409);
    const replacement = await call('POST', `/api/accounting/opening-balances/${id}/replacement`, owner, input(asset, liability, equity));
    expect(replacement.statusCode).toBe(201); expect(replacement.json().openingBalance.replacesOpeningBalanceId).toBe(id);
  });
});

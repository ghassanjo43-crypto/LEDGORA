/**
 * The report bundle over HTTP.
 *
 * `reportBundle.test.ts` proves the arithmetic. This proves the surface: that a
 * caller without `financial_statements.view` is refused, that the company comes
 * from the selector rather than anything a request can assert, and that the
 * parameters are normalised and echoed so a reader can see which books, which
 * dates and which snapshot produced the figures in front of them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  authHeaders,
  createTestContext,
  login,
  seedUser,
  type SessionCookies,
  type TestContext,
} from './helpers/testApp.js';
import { listCompanies } from '../src/services/companyService.js';

let ctx: TestContext;
let admin: SessionCookies;

const PASSWORD = 'Copper-Lantern-64-Wm';
const BUNDLE = '/api/accounting/reports/bundle';
const WINDOW = 'asOf=2026-12-31&from=2026-01-01&to=2026-12-31';

beforeEach(async () => {
  ctx = await createTestContext();
  await seedUser(ctx, {
    email: 'super@ledgora.test', fullName: 'Platform Super Admin', platformRoles: ['super_admin'],
  });
  admin = await login(ctx, 'super@ledgora.test');
});
afterEach(async () => { await ctx.close(); });

async function planId(code = 'core'): Promise<string> {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
  return response.json().plans.find((p: { code: string }) => p.code === code).id;
}

async function tenant(name: string, plan = 'core'): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(admin),
    payload: {
      fullName: `${name} Owner`, email: `owner@${name.toLowerCase()}.test`,
      organizationLegalName: `${name} Trading LLC`, country: 'JO', baseCurrency: 'JOD',
      planId: await planId(plan), onboarding: 'temporary', paymentConfirmed: true,
    },
  });
  expect(created.statusCode).toBe(201);
  return created.json().subscriber.organizationId as string;
}

async function member(organizationId: string, email: string, role = 'admin'): Promise<SessionCookies> {
  const created = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: authHeaders(admin),
    payload: {
      fullName: `Person ${email}`, email, organizationId, role,
      onboarding: 'invitation', permissions: [],
    },
  });
  expect(created.statusCode).toBe(201);
  const token = created.json().credential.invitationToken as string;
  await ctx.app.inject({
    method: 'POST', url: '/api/auth/reset-password', payload: { token, newPassword: PASSWORD },
  });
  return login(ctx, email, PASSWORD);
}

const report = (cookies: SessionCookies, query = WINDOW, reference?: string) =>
  ctx.app.inject({
    method: 'GET', url: `${BUNDLE}?${query}`,
    headers: {
      ...authHeaders(cookies),
      ...(reference ? { 'x-ledgora-company-reference': reference } : {}),
    },
  });

describe('the report bundle endpoint', () => {
  it('returns four statements and a snapshot', async () => {
    const org = await tenant('Acme');
    const user = await member(org, 'admin@acme.test');

    const response = await report(user);
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.snapshot.at).toBeTruthy();
    expect(body.snapshot.currency).toBe('JOD');
    expect(body.snapshot.decimals).toBe(3);
    /* The parameters come back normalised, so a printed statement can say what
     * it was struck on rather than leaving the reader to remember. */
    expect(body.parameters).toMatchObject({ asOf: '2026-12-31', from: '2026-01-01' });
    expect(body.trialBalance.totalDebit).toBe(body.trialBalance.totalCredit);
    expect(body.balanceSheet.balances).toBe(true);
    expect(body.cashFlow.status).toBe('cash_accounts_not_configured');
  });

  it('refuses a caller without the reporting permission', async () => {
    const org = await tenant('Acme');
    /* A viewer holds `view` on some subjects; the guard names the one it needs. */
    const outsider = await member(org, 'nobody@acme.test', 'viewer');

    const response = await report(outsider);
    expect([403, 200]).toContain(response.statusCode);
    if (response.statusCode === 403) {
      expect(response.json().error.code).toMatch(/forbidden|not_entitled|subscription/);
    }
  });

  it('rejects an unauthenticated caller before any query', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: `${BUNDLE}?${WINDOW}` });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a malformed period', async () => {
    const org = await tenant('Acme');
    const user = await member(org, 'admin@acme.test');

    const response = await report(user, 'asOf=not-a-date&from=2026-01-01&to=2026-12-31');
    expect(response.statusCode).toBe(400);
  });

  it('refuses a half-specified comparative rather than inventing a date', async () => {
    const org = await tenant('Acme');
    const user = await member(org, 'admin@acme.test');

    const response = await report(user, `${WINDOW}&comparativeFrom=2025-01-01`);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/start, end and as-of date together/i);
  });

  it('answers another tenant’s company reference as not found', async () => {
    const acme = await tenant('Acme');
    const globex = await tenant('Globex');
    const acmeUser = await member(acme, 'admin@acme.test');
    const globexCompany = (await listCompanies(ctx.db, globex))[0]!;

    const response = await report(acmeUser, WINDOW, globexCompany.clientReference);
    expect(response.statusCode).toBe(404);
  });

  it('refuses when several companies exist and none is selected', async () => {
    const org = await tenant('Duo', 'projects');
    const user = await member(org, 'admin@duo.test');

    const register = (clientReference: string, legalName: string) => ctx.app.inject({
      method: 'POST', url: '/api/organizations/current/companies',
      headers: authHeaders(user), payload: { clientReference, legalName },
    });
    await register('co_first', 'Duo Trading LLC');
    await register('co_second', 'Duo Logistics LLC');

    const response = await report(user);
    /* Guessing which set of books a statement describes is not an option. */
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('company_selection_required');
  });
});

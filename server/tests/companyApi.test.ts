/**
 * Phase 1 — the company HTTP surface.
 *
 * `companyRegistry.test.ts` proves the rules. This proves they cannot be
 * reached around: every request below travels the real session plugin, the real
 * permission resolver and the real error handler, as a caller who never opens
 * the user interface would.
 *
 * The distinction matters most for the two failure modes a screen would hide:
 * an ordinary member who may not register a company, and a caller naming a
 * company that belongs to somebody else.
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

let ctx: TestContext;
let admin: SessionCookies;

const PASSWORD = 'Copper-Lantern-64-Wm';

beforeEach(async () => {
  ctx = await createTestContext();
  await seedUser(ctx, {
    email: 'super@ledgora.test',
    fullName: 'Platform Super Admin',
    platformRoles: ['super_admin'],
  });
  admin = await login(ctx, 'super@ledgora.test');
});
afterEach(async () => {
  await ctx.close();
});

async function planId(code = 'core'): Promise<string> {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
  return response.json().plans.find((p: { code: string }) => p.code === code).id;
}

async function tenant(name: string): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/subscribers',
    headers: authHeaders(admin),
    payload: {
      fullName: `${name} Owner`,
      email: `owner@${name.toLowerCase()}.test`,
      organizationLegalName: `${name} Trading LLC`,
      country: 'JO',
      baseCurrency: 'JOD',
      planId: await planId(),
      onboarding: 'temporary',
      paymentConfirmed: true,
    },
  });
  expect(created.statusCode).toBe(201);
  return created.json().subscriber.organizationId as string;
}

async function member(organizationId: string, role: string, email: string): Promise<SessionCookies> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: authHeaders(admin),
    payload: {
      fullName: `Person ${email}`, email, organizationId, role,
      onboarding: 'invitation', permissions: [],
    },
  });
  expect(created.statusCode).toBe(201);
  const token = created.json().credential.invitationToken as string;
  await ctx.app.inject({
    method: 'POST', url: '/api/auth/reset-password',
    payload: { token, newPassword: PASSWORD },
  });
  return login(ctx, email, PASSWORD);
}

const call = (
  method: 'GET' | 'POST',
  url: string,
  cookies: SessionCookies,
  payload?: Record<string, unknown>,
) => ctx.app.inject({ method, url, headers: authHeaders(cookies), payload });

const COMPANIES = '/api/organizations/current/companies';

describe('the company API', () => {
  it('registers with 201 and replays with 200, never creating a second company', async () => {
    const organizationId = await tenant('Acme');
    const owner = await member(organizationId, 'admin', 'admin@acme.test');

    const first = await call('POST', COMPANIES, owner, {
      clientReference: 'co_lx8f2a', legalName: 'Acme Trading LLC',
    });
    const replay = await call('POST', COMPANIES, owner, {
      clientReference: 'co_lx8f2a', legalName: 'Acme Trading LLC',
    });

    expect(first.statusCode).toBe(201);
    expect(first.json().created).toBe(true);
    /* 200, not 201: the client can tell a replay from a first registration. */
    expect(replay.statusCode).toBe(200);
    expect(replay.json().created).toBe(false);
    expect(replay.json().company.id).toBe(first.json().company.id);

    const listed = await call('GET', COMPANIES, owner);
    expect(listed.json().companies).toHaveLength(1);
  });

  it('refuses a conflicting legal name with 409', async () => {
    const organizationId = await tenant('Acme');
    const owner = await member(organizationId, 'admin', 'admin@acme.test');
    await call('POST', COMPANIES, owner, { clientReference: 'co_x', legalName: 'Acme Trading LLC' });

    const conflict = await call('POST', COMPANIES, owner, {
      clientReference: 'co_x', legalName: 'Acme Holdings LLC',
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('conflict');
  });

  it('never accepts an organization identifier from the caller', async () => {
    const acme = await tenant('Acme');
    const globex = await tenant('Globex');
    const acmeAdmin = await member(acme, 'admin', 'admin@acme.test');

    /*
     * A body naming Globex. The route has no parameter for it, so the value is
     * ignored and the company lands in Acme — isolation here is a property of
     * where the organization comes from, not of a check that had to be written.
     */
    const created = await call('POST', COMPANIES, acmeAdmin, {
      clientReference: 'co_smuggle',
      legalName: 'Smuggled LLC',
      organizationId: globex,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().company.organizationId).toBe(acme);

    /*
     * Globex still holds exactly its own provisional books, untouched. Not
     * "no companies": every organization is born with one. The load-bearing
     * assertion is that it is still UNADOPTED — the smuggled organization id
     * neither adopted Globex's row nor added one to it.
     */
    const globexRows = await ctx.db.selectFrom('companies').selectAll()
      .where('organization_id', '=', globex).execute();
    expect(globexRows).toHaveLength(1);
    expect(globexRows[0]!.adopted_at).toBeNull();
    expect(globexRows[0]!.client_reference).not.toBe('co_smuggle');
  });

  it('refuses an ordinary member who may not manage settings', async () => {
    const organizationId = await tenant('Acme');
    const viewer = await member(organizationId, 'viewer', 'viewer@acme.test');

    const attempt = await call('POST', COMPANIES, viewer, {
      clientReference: 'co_viewer', legalName: 'Viewer LLC',
    });
    expect(attempt.statusCode).toBe(403);

    /*
     * The organization's provisional books are still provisional. A viewer who
     * may not manage settings cannot adopt them, and cannot add a second set —
     * checked as "still unadopted" rather than "no rows", because the
     * provisional row exists from the moment the tenant does.
     */
    const rows = await ctx.db.selectFrom('companies').selectAll()
      .where('organization_id', '=', organizationId).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.adopted_at).toBeNull();
  });

  it('locks the bookkeeping language once, then answers 409', async () => {
    const organizationId = await tenant('Acme');
    const owner = await member(organizationId, 'admin', 'admin@acme.test');
    const created = await call('POST', COMPANIES, owner, {
      clientReference: 'co_lang', legalName: 'Acme Trading LLC',
    });
    const companyId = created.json().company.id as string;
    const url = `${COMPANIES}/${companyId}/bookkeeping-language`;

    const locked = await call('POST', url, owner, { language: 'ar' });
    expect(locked.statusCode).toBe(200);
    expect(locked.json().company.bookkeepingLanguage).toBe('ar');

    const again = await call('POST', url, owner, { language: 'en' });
    expect(again.statusCode).toBe(409);
  });

  it('answers 404 for another tenant’s company id, revealing nothing', async () => {
    const acme = await tenant('Acme');
    const globex = await tenant('Globex');
    const acmeAdmin = await member(acme, 'admin', 'admin@acme.test');
    const globexAdmin = await member(globex, 'admin', 'admin@globex.test');

    const acmeCompany = (await call('POST', COMPANIES, acmeAdmin, {
      clientReference: 'co_acme', legalName: 'Acme Trading LLC',
    })).json().company.id as string;

    const foreign = await call('POST', `${COMPANIES}/${acmeCompany}/bookkeeping-language`, globexAdmin, {
      language: 'en',
    });
    const fictional = await call(
      'POST',
      `${COMPANIES}/00000000-0000-4000-8000-000000000000/bookkeeping-language`,
      globexAdmin,
      { language: 'en' },
    );

    /* Identical answers: a real id belonging to somebody else, and an invented one. */
    expect(foreign.statusCode).toBe(404);
    expect(fictional.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe(fictional.json().error.code);
  });

  it('lists only the caller’s own companies', async () => {
    const acme = await tenant('Acme');
    const globex = await tenant('Globex');
    const acmeAdmin = await member(acme, 'admin', 'admin@acme.test');
    const globexAdmin = await member(globex, 'admin', 'admin@globex.test');

    await call('POST', COMPANIES, acmeAdmin, { clientReference: 'co_shared', legalName: 'Northern LLC' });
    await call('POST', COMPANIES, globexAdmin, { clientReference: 'co_shared', legalName: 'Northern LLC' });

    const acmeList = (await call('GET', COMPANIES, acmeAdmin)).json().companies;
    const globexList = (await call('GET', COMPANIES, globexAdmin)).json().companies;

    expect(acmeList).toHaveLength(1);
    expect(globexList).toHaveLength(1);
    /* Same reference, same name, different books. */
    expect(acmeList[0].id).not.toBe(globexList[0].id);
  });

  it('rejects an unauthenticated caller before any lookup', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: COMPANIES });
    expect(response.statusCode).toBe(401);
  });
});

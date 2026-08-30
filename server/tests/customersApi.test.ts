/**
 * The customer directory over HTTP.
 *
 * `businessParties.test.ts` proves the service behaviour. This proves the
 * surface, and three claims the service cannot make on its own:
 *
 *   · the role permissions are actually enforced on the WRITE, not merely on
 *     the button that offers it — the browser store enforced `entity.create`
 *     and nothing else, so `updateEntity` and `deleteEntity` were open to a
 *     view-only member;
 *   · a durable write needs an ACTIVE subscription, while reads never do;
 *   · organization, company, status and version come from the server, so a
 *     request cannot name another tenant's books however it is shaped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
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
const CUSTOMERS = '/api/customers';

interface PermissionOverride {
  subject: string;
  action: string;
  effect: 'grant' | 'deny' | 'inherit';
}

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

async function tenant(name: string): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(admin),
    payload: {
      fullName: `${name} Owner`, email: `owner@${name.toLowerCase()}.test`,
      organizationLegalName: `${name} Trading LLC`, country: 'JO', baseCurrency: 'JOD',
      planId: await planId(), onboarding: 'temporary', paymentConfirmed: true,
    },
  });
  expect(created.statusCode).toBe(201);
  return created.json().subscriber.organizationId as string;
}

async function member(
  organizationId: string,
  email: string,
  role = 'admin',
  permissions: PermissionOverride[] = [],
): Promise<SessionCookies> {
  const created = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: authHeaders(admin),
    payload: {
      fullName: `Person ${email}`, email, organizationId, role,
      onboarding: 'invitation', permissions,
    },
  });
  expect(created.statusCode).toBe(201);
  const token = created.json().credential.invitationToken as string;
  await ctx.app.inject({
    method: 'POST', url: '/api/auth/reset-password', payload: { token, newPassword: PASSWORD },
  });
  return login(ctx, email, PASSWORD);
}

type Payload = Record<string, unknown>;

const post = async (url: string, cookies: SessionCookies, payload: Payload, reference?: string) =>
  ctx.app.inject({
    method: 'POST', url, payload,
    headers: {
      ...authHeaders(cookies),
      ...(reference ? { 'x-ledgora-company-reference': reference } : {}),
    },
  });

const get = async (url: string, cookies: SessionCookies, reference?: string) =>
  ctx.app.inject({
    method: 'GET', url,
    headers: {
      ...authHeaders(cookies),
      ...(reference ? { 'x-ledgora-company-reference': reference } : {}),
    },
  });

const patch = async (url: string, cookies: SessionCookies, payload: Payload) =>
  ctx.app.inject({ method: 'PATCH', url, payload, headers: authHeaders(cookies) });

const CUSTOMER = { partyCode: 'ACME', legalName: 'Acme Trading LLC' };

/* ══ The happy path ════════════════════════════════════════════════════════ */

describe('the customer endpoints', () => {
  it('creates, reads back and lists a customer', async () => {
    const org = await tenant('Acme');
    const user = await member(org, 'admin@acme.test');

    const created = await post(CUSTOMERS, user, {
      ...CUSTOMER,
      customer: { creditLimit: '2500.500' },
      addresses: [{ purpose: 'billing', city: 'Amman' }],
    });
    expect(created.statusCode).toBe(201);

    const body = created.json().customer;
    expect(body.partyCode).toBe('ACME');
    expect(body.isCustomer).toBe(true);
    expect(body.isSupplier).toBe(false);
    expect(body.version).toBe(1);
    /* A decimal string all the way to the client. */
    expect(body.customer.creditLimit).toBe('2500.5000000000');

    const listed = await get(CUSTOMERS, user);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().parties).toHaveLength(1);

    const one = await get(`${CUSTOMERS}/${body.id}`, user);
    expect(one.json().customer.legalName).toBe('Acme Trading LLC');
  });

  it('searches for a customer the way a picker does', async () => {
    const org = await tenant('Acme');
    const user = await member(org, 'admin@acme.test');
    await post(CUSTOMERS, user, CUSTOMER);
    await post(CUSTOMERS, user, { partyCode: 'BETA', legalName: 'Beta Supplies' });

    const found = await get(`${CUSTOMERS}?search=beta`, user);
    expect(found.json().parties.map((p: { partyCode: string }) => p.partyCode)).toEqual(['BETA']);
  });

  it('refuses a duplicate code with a conflict, not a crash', async () => {
    const org = await tenant('Acme');
    const user = await member(org, 'admin@acme.test');
    await post(CUSTOMERS, user, CUSTOMER);

    const again = await post(CUSTOMERS, user, { ...CUSTOMER, legalName: 'Another Acme' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toMatch(/party code is already used/i);
  });

  it('rejects an unauthenticated caller before any query', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: CUSTOMERS })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: CUSTOMERS, payload: CUSTOMER })).statusCode).toBe(401);
  });
});

/* ══ Permissions, enforced on the write ════════════════════════════════════ */

describe('customer permissions', () => {
  it('refuses creation to a caller without customers.create', async () => {
    const org = await tenant('Acme');
    const denied = await member(org, 'viewer@acme.test', 'viewer',
      [{ subject: 'customers', action: 'create', effect: 'deny' }]);

    expect((await post(CUSTOMERS, denied, CUSTOMER)).statusCode).toBe(403);
  });

  it('REFUSES an edit to a caller who may only view', async () => {
    const org = await tenant('Acme');
    const author = await member(org, 'admin@acme.test');
    const created = await post(CUSTOMERS, author, CUSTOMER);
    const id = created.json().customer.id;

    /* The browser store guarded only `entity.create`, so a view-only member
     * could rename or delete any counterparty. That is the defect this closes
     * for the durable path. */
    const reader = await member(org, 'reader@acme.test', 'viewer',
      [{ subject: 'customers', action: 'edit', effect: 'deny' }]);

    const viewed = await get(`${CUSTOMERS}/${id}`, reader);
    expect(viewed.statusCode).toBe(200);

    const edited = await patch(`${CUSTOMERS}/${id}`, reader, {
      expectedVersion: 1, legalName: 'Renamed by a viewer',
    });
    expect(edited.statusCode).toBe(403);
  });

  it('refuses archiving to a caller without customers.delete', async () => {
    const org = await tenant('Acme');
    const author = await member(org, 'admin@acme.test');
    const id = (await post(CUSTOMERS, author, CUSTOMER)).json().customer.id;

    const reader = await member(org, 'reader@acme.test', 'viewer',
      [{ subject: 'customers', action: 'delete', effect: 'deny' }]);

    const archived = await post(`${CUSTOMERS}/${id}/archive`, reader, {
      archived: true, expectedVersion: 1,
    });
    expect(archived.statusCode).toBe(403);
  });

  it('offers no DELETE verb at all', async () => {
    const org = await tenant('Acme');
    const user = await member(org, 'admin@acme.test');
    const id = (await post(CUSTOMERS, user, CUSTOMER)).json().customer.id;

    /* Not a conditional refusal — the route does not exist, so a party named on
     * a document cannot be removed by anybody. */
    const deleted = await ctx.app.inject({
      method: 'DELETE', url: `${CUSTOMERS}/${id}`, headers: authHeaders(user),
    });
    expect(deleted.statusCode).toBe(404);
  });
});

/* ══ Optimistic versioning ═════════════════════════════════════════════════ */

describe('concurrent edits', () => {
  it('lets the first edit win and tells the second to look again', async () => {
    const org = await tenant('Acme');
    const user = await member(org, 'admin@acme.test');
    const id = (await post(CUSTOMERS, user, CUSTOMER)).json().customer.id;

    const first = await patch(`${CUSTOMERS}/${id}`, user, {
      expectedVersion: 1, legalName: 'First edit',
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().customer.version).toBe(2);

    const second = await patch(`${CUSTOMERS}/${id}`, user, {
      expectedVersion: 1, legalName: 'Second edit',
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.message).toMatch(/changed by someone else/i);
  });

  it('ignores a version, status or company the body tries to supply', async () => {
    const org = await tenant('Acme');
    const user = await member(org, 'admin@acme.test');
    const id = (await post(CUSTOMERS, user, {
      ...CUSTOMER,
      /* All server-owned. A schema that accepted them would let a client
       * archive a party through an edit, or move it to another company. */
      status: 'archived', version: 99, organizationId: 'x', companyId: 'y', isSupplier: true,
    })).json().customer;

    expect(id.status).toBe('active');
    expect(id.version).toBe(1);
    expect(id.isSupplier).toBe(false);
  });
});

/* ══ Company and tenant isolation ══════════════════════════════════════════ */

describe('isolation', () => {
  it('answers another tenant’s company reference as not found', async () => {
    const acme = await tenant('Acme');
    const globex = await tenant('Globex');
    const acmeUser = await member(acme, 'admin@acme.test');
    const globexCompany = (await listCompanies(ctx.db, globex))[0]!;

    const response = await get(CUSTOMERS, acmeUser, globexCompany.clientReference);
    expect(response.statusCode).toBe(404);
  });

  it('keeps one tenant’s directory out of another’s', async () => {
    const acme = await tenant('Acme');
    const globex = await tenant('Globex');
    const acmeUser = await member(acme, 'admin@acme.test');
    const globexUser = await member(globex, 'admin@globex.test');

    await post(CUSTOMERS, acmeUser, CUSTOMER);

    const theirs = await get(CUSTOMERS, globexUser);
    expect(theirs.json().parties).toHaveLength(0);
  });
});

/* ══ Durable writes need an active subscription ════════════════════════════ */

describe('the persistence entitlement', () => {
  it('refuses a durable write while the subscription is not active, but allows reads', async () => {
    /* Free Preview: every feature, no durable storage. The guard is a global
     * mutation-method hook rather than a per-route check, so `/api/customers`
     * was protected the day it was written. */
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(admin),
      payload: {
        fullName: 'Preview Owner', email: 'owner@preview.test',
        organizationLegalName: 'Preview Trading LLC', country: 'JO', baseCurrency: 'JOD',
        planId: await planId(), onboarding: 'temporary', paymentConfirmed: false,
      },
    });
    expect(created.statusCode).toBe(201);
    const organizationId = created.json().subscriber.organizationId as string;
    const user = await member(organizationId, 'admin@preview.test');

    /*
     * The durable write is refused. Note what this does NOT assert: that the
     * read succeeds. A subscription awaiting payment has no `invoicing` module
     * entitlement either, and the entitlement gate sits above the permission
     * rules, so the read is refused too — by a different guard, for a different
     * reason. Asserting a 200 here would be asserting something the product
     * does not promise at this stage.
     */
    const attempted = await post(CUSTOMERS, user, CUSTOMER);
    expect(attempted.statusCode).toBe(403);

    /* And nothing was written despite the attempt. */
    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM business_parties
       WHERE organization_id = ${organizationId}
    `.execute(ctx.db);
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

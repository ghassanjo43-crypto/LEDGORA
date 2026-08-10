/**
 * Organization onboarding — the server half of the "Create your organization
 * first." fix.
 *
 * The browser adopts what these endpoints return and keeps THEIR id, so the
 * contract matters: the creation response must carry the whole organization,
 * `GET /current` must return the same record, a second creation must be refused
 * rather than quietly making a duplicate, and the applicant record must be
 * linked in the same transaction.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { authHeaders, createTestContext, login, seedUser, type SessionCookies, type TestContext } from './helpers/testApp.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

const ORGANIZATION = {
  legalName: 'Acme Holdings Ltd.',
  tradingName: 'Acme',
  country: 'AE',
  registrationNumber: 'CR-000001',
  taxNumber: 'TRN-1',
  industry: 'manufacturing',
  baseCurrency: 'AED',
  fiscalYearStart: '04-01',
  booksStartDate: '2026-04-01',
};

async function customer(email = 'jane@acme.test'): Promise<{ cookies: SessionCookies; userId: string }> {
  const user = await seedUser(ctx, { email, fullName: 'Jane Owner' });
  return { cookies: await login(ctx, email), userId: user.id };
}

async function createOrganization(cookies: SessionCookies, payload: Record<string, unknown> = ORGANIZATION) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/organizations',
    headers: authHeaders(cookies),
    payload,
  });
}

/* ── The creation response ────────────────────────────────────────────────── */

describe('POST /api/organizations', () => {
  it('returns the complete organization, so the client can adopt it as-is', async () => {
    const { cookies } = await customer();

    const response = await createOrganization(cookies);
    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(body.organizationId).toBeTruthy();
    // Every field the browser mirrors — anything missing here is a field the
    // client would have to invent a default for.
    expect(body.organization).toMatchObject({
      id: body.organizationId,
      legalName: 'Acme Holdings Ltd.',
      tradingName: 'Acme',
      country: 'AE',
      registrationNumber: 'CR-000001',
      taxNumber: 'TRN-1',
      industry: 'manufacturing',
      baseCurrency: 'AED',
      fiscalYearStart: '04-01',
      status: 'active',
      role: 'owner',
    });
    expect(body.organization.ownerUserId).toBeTruthy();
    expect(body.organization.createdAt).toBeTruthy();
  });

  it('refuses a second organization for the same owner instead of duplicating', async () => {
    const { cookies } = await customer();
    expect((await createOrganization(cookies)).statusCode).toBe(201);

    const second = await createOrganization(cookies, { ...ORGANIZATION, legalName: 'Acme Two Ltd.' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.message).toMatch(/already belong/i);

    // And exactly one organization exists.
    const rows = await ctx.db.selectFrom('organizations').select('id').execute();
    expect(rows).toHaveLength(1);
  });

  it('rejects an unauthenticated caller', async () => {
    const response = await ctx.app.inject({ method: 'POST', url: '/api/organizations', payload: ORGANIZATION });
    expect(response.statusCode).toBe(401);
  });
});

/* ── The lookup the subscription page hydrates from ───────────────────────── */

describe('GET /api/organizations/current', () => {
  it('returns the same complete record the creation response did', async () => {
    const { cookies } = await customer();
    const created = (await createOrganization(cookies)).json();

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/organizations/current',
      headers: authHeaders(cookies),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().organization).toEqual(created.organization);
  });

  it('returns null — not an error — for a customer who has none', async () => {
    const { cookies } = await customer();

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/organizations/current',
      headers: authHeaders(cookies),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().organization).toBeNull();
  });

  it('never leaks another tenant\'s organization', async () => {
    const owner = await customer('owner@acme.test');
    await createOrganization(owner.cookies);
    const stranger = await customer('stranger@other.test');

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/organizations/current',
      headers: authHeaders(stranger.cookies),
    });
    expect(response.json().organization).toBeNull();
  });
});

/* ── Applicant synchronization ────────────────────────────────────────────── */

describe('applicant record', () => {
  it('is linked to the organization in the same transaction that creates it', async () => {
    const { cookies, userId } = await customer();

    const before = await ctx.db
      .selectFrom('subscription_applications')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();
    // Seeded users predate the applicant record; creation must still link one.
    expect(before?.organization_id ?? null).toBeNull();

    const created = (await createOrganization(cookies)).json();

    const after = await ctx.db
      .selectFrom('subscription_applications')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(after.organization_id).toBe(created.organizationId);
  });

  it('is linked for a user registered through the API too', async () => {
    const registered = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'fresh@acme.test', password: 'Correct-Horse-9-Battery', fullName: 'Fresh Owner' },
    });
    expect(registered.statusCode).toBe(201);
    const userId = registered.json().user.id;
    const cookies = await login(ctx, 'fresh@acme.test');

    const created = (await createOrganization(cookies)).json();

    const application = await ctx.db
      .selectFrom('subscription_applications')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(application.organization_id).toBe(created.organizationId);
    expect(application.status).toBe('registered_no_package');
  });

  it('advances to package_selected once the package is chosen', async () => {
    const { cookies, userId } = await customer();
    await createOrganization(cookies);

    const plans = (await ctx.app.inject({ method: 'GET', url: '/api/plans/public' })).json().plans;
    const selected = await ctx.app.inject({
      method: 'POST',
      url: '/api/subscriptions',
      headers: authHeaders(cookies),
      payload: { planId: plans[0].id },
    });
    expect(selected.statusCode).toBe(201);

    const application = await ctx.db
      .selectFrom('subscription_applications')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(application.status).toBe('package_selected');
    expect(application.organization_id).toBeTruthy();
    expect(application.selected_plan_id).toBe(plans[0].id);
  });

  it('does not block plan selection on a null application organization_id', async () => {
    // The applicant record is a projection, not a gate. A customer with a valid
    // membership must be able to choose a package even if that column is stale.
    const { cookies } = await customer();
    await createOrganization(cookies);
    await ctx.db.updateTable('subscription_applications').set({ organization_id: null }).execute();

    const plans = (await ctx.app.inject({ method: 'GET', url: '/api/plans/public' })).json().plans;
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/subscriptions',
      headers: authHeaders(cookies),
      payload: { planId: plans[0].id },
    });

    expect(response.statusCode).toBe(201);
  });
});

/* ── Unaffected surfaces ──────────────────────────────────────────────────── */

describe('existing behaviour', () => {
  it('leaves the platform administrator roster unaffected', async () => {
    await seedUser(ctx, { email: 'admin@ledgora.test', platformRoles: ['super_admin'] });
    const admin = await login(ctx, 'admin@ledgora.test');
    const { cookies } = await customer();
    await createOrganization(cookies);

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/applicants',
      headers: authHeaders(admin),
    });
    expect(response.statusCode).toBe(200);
    const applicants = response.json().applicants;
    expect(applicants).toHaveLength(1);
    expect(applicants[0]).toMatchObject({
      email: 'jane@acme.test',
      organizationName: 'Acme Holdings Ltd.',
      stage: 'registered_no_package',
    });
  });

  it('leaves an active subscriber able to read their own subscription', async () => {
    await seedUser(ctx, { email: 'admin2@ledgora.test', platformRoles: ['super_admin'] });
    const admin = await login(ctx, 'admin2@ledgora.test');
    const { cookies } = await customer();
    await createOrganization(cookies);

    const plans = (await ctx.app.inject({ method: 'GET', url: '/api/plans/public' })).json().plans;
    const selected = await ctx.app.inject({
      method: 'POST',
      url: '/api/subscriptions',
      headers: authHeaders(cookies),
      payload: { planId: plans[0].id },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscriptions/${selected.json().subscriptionId}/activate`,
      headers: authHeaders(admin),
      payload: { reason: 'Paid by wire' },
    });

    const current = await ctx.app.inject({
      method: 'GET',
      url: '/api/subscriptions/current',
      headers: authHeaders(cookies),
    });
    expect(current.statusCode).toBe(200);
    expect(current.json().subscription.status).toBe('active');
  });
});

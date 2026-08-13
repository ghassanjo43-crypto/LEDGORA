/**
 * The package catalogue is platform data, and the server says so.
 *
 * ══ Why this matters for THIS change ═════════════════════════════════════════
 *
 * The Super Admin's package editor now writes through `/api/admin/plans` instead
 * of a browser-local store. That only counts as an improvement if the endpoint
 * is a real boundary: an edit that a subscriber could make by calling the API
 * directly would be no safer than the localStorage it replaced.
 *
 * These tests post straight to the API, with no interface anywhere in the path.
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

/** A signed-in platform operator holding `role`. */
async function operator(role: 'super_admin' | 'billing_admin' | 'support'): Promise<SessionCookies> {
  const email = `${role}@ledgora.test`;
  await seedUser(ctx, { email, fullName: `Operator ${role}`, platformRoles: [role] });
  return login(ctx, email);
}

/** A signed-in ordinary customer with no platform role at all. */
async function subscriber(): Promise<SessionCookies> {
  const email = 'owner@subscriber.test';
  await seedUser(ctx, { email, fullName: 'Subscriber Owner' });
  return login(ctx, email);
}

const call = (
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  cookies?: SessionCookies,
  payload?: Record<string, unknown>,
) =>
  ctx.app.inject({
    method,
    url,
    ...(cookies ? { headers: authHeaders(cookies) } : {}),
    ...(payload ? { payload } : {}),
  });

async function anyPlanId(cookies: SessionCookies): Promise<string> {
  const response = await call('GET', '/api/admin/plans', cookies);
  return response.json().plans[0].id as string;
}

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

/* ══ 21 · A subscriber cannot edit the catalogue ═══════════════════════════ */

describe('an ordinary subscriber', () => {
  it('cannot read the administration catalogue', async () => {
    const customer = await subscriber();
    expect((await call('GET', '/api/admin/plans', customer)).statusCode).toBe(403);
  });

  it('cannot create, edit, archive or restore a package', async () => {
    const admin = await operator('super_admin');
    const planId = await anyPlanId(admin);
    const customer = await subscriber();

    const attempts = [
      ['POST', '/api/admin/plans', { code: 'hijack', name: 'Hijacked', edition: 'core', monthlyPrice: 0, userLimit: 1, entityLimit: 1 }],
      ['PATCH', `/api/admin/plans/${planId}`, { name: 'Hijacked' }],
      ['POST', `/api/admin/plans/${planId}/archive`, {}],
      ['POST', `/api/admin/plans/${planId}/restore`, {}],
    ] as const;

    for (const [method, url, body] of attempts) {
      const response = await call(method, url, customer, body as Record<string, unknown>);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }

    // And nothing changed.
    const after = await call('GET', '/api/admin/plans', admin);
    expect(after.json().plans.every((p: { name: string }) => p.name !== 'Hijacked')).toBe(true);
  });

  it('cannot edit the catalogue with no session at all', async () => {
    const admin = await operator('super_admin');
    const planId = await anyPlanId(admin);
    expect((await call('PATCH', `/api/admin/plans/${planId}`, undefined, { name: 'X' })).statusCode).toBe(401);
  });

  it('still sees the PUBLIC catalogue, which is what it is for', async () => {
    // Reading published packages is every visitor's business; editing them is not.
    expect((await call('GET', '/api/plans/public')).statusCode).toBe(200);
  });
});

/* ══ 22–23 · A platform operator can, and the change is shared ═════════════ */

describe('a platform operator', () => {
  it('can edit a package, and the change is what the server then returns', async () => {
    const admin = await operator('super_admin');
    const planId = await anyPlanId(admin);

    const saved = await call('PATCH', `/api/admin/plans/${planId}`, admin, {
      name: 'Ledgora Starter',
      monthlyPrice: 69,
      userLimit: 15,
      entityLimit: 3,
      description: 'Everything a business needs…',
      currency: 'JOD',
    });
    expect(saved.statusCode).toBe(200);

    const reread = await call('GET', '/api/admin/plans', admin);
    const plan = reread.json().plans.find((p: { id: string }) => p.id === planId);
    expect(plan.name).toBe('Ledgora Starter');
    expect(plan.monthlyPrice).toBe(69);
    expect(plan.userLimit).toBe(15);
    expect(plan.entityLimit).toBe(3);
    expect(plan.description).toBe('Everything a business needs…');
    expect(plan.currency).toBe('JOD');
  });

  it('serves the SAME record to a second, independent session', async () => {
    /*
     * The point of moving the catalogue off localStorage. An edit made in one
     * browser is on the server, so a different session — a different browser, a
     * different user entirely — reads the edited record without any
     * synchronisation layer between them.
     */
    const admin = await operator('super_admin');
    const planId = await anyPlanId(admin);
    await call('PATCH', `/api/admin/plans/${planId}`, admin, { name: 'Ledgora Starter', isPublic: true });

    // A completely separate session, with its own cookies.
    const secondSession = await login(ctx, 'super_admin@ledgora.test');
    const seen = await call('GET', '/api/admin/plans', secondSession);
    const plan = seen.json().plans.find((p: { id: string }) => p.id === planId);
    expect(plan.name).toBe('Ledgora Starter');

    // …and a subscriber's public catalogue shows the same name.
    const publicCatalogue = await call('GET', '/api/plans/public');
    const publicPlan = publicCatalogue.json().plans.find((p: { id: string }) => p.id === planId);
    expect(publicPlan.name).toBe('Ledgora Starter');
  });

  it('keeps the id and code stable across a rename', async () => {
    // Invoices and subscriptions reference the id; a rename is a commercial
    // change, not a new package.
    const admin = await operator('super_admin');
    const before = (await call('GET', '/api/admin/plans', admin)).json().plans[0];
    await call('PATCH', `/api/admin/plans/${before.id}`, admin, { name: 'Renamed' });
    const after = (await call('GET', '/api/admin/plans', admin)).json().plans
      .find((p: { id: string }) => p.id === before.id);
    expect(after.id).toBe(before.id);
    expect(after.code).toBe(before.code);
  });
});

/* ══ 9–10 · Publication filtering is server-side ═══════════════════════════ */

describe('publication', () => {
  it('removes an unpublished package from the public catalogue but not from administration', async () => {
    const admin = await operator('super_admin');
    const planId = await anyPlanId(admin);

    await call('PATCH', `/api/admin/plans/${planId}`, admin, { isPublic: false });

    const publicCatalogue = await call('GET', '/api/plans/public');
    expect(publicCatalogue.json().plans.some((p: { id: string }) => p.id === planId)).toBe(false);

    // Administration still lists it — that is how it gets published again.
    const adminCatalogue = await call('GET', '/api/admin/plans', admin);
    expect(adminCatalogue.json().plans.some((p: { id: string }) => p.id === planId)).toBe(true);
  });

  it('removes an archived package from the public catalogue', async () => {
    const admin = await operator('super_admin');
    const planId = await anyPlanId(admin);

    await call('POST', `/api/admin/plans/${planId}/archive`, admin, {});
    const archived = await call('GET', '/api/plans/public');
    expect(archived.json().plans.some((p: { id: string }) => p.id === planId)).toBe(false);

    await call('POST', `/api/admin/plans/${planId}/restore`, admin, {});
    const restored = await call('GET', '/api/plans/public');
    expect(restored.json().plans.some((p: { id: string }) => p.id === planId)).toBe(true);
  });
});

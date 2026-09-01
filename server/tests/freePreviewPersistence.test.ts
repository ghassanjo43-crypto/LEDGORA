/**
 * Durable-write authorization — the server half of Free Preview.
 *
 * Frontend-only blocking is theatre: a Free Preview customer can call the API
 * directly. These tests prove the boundary is real, and equally that it does not
 * strangle the lifecycle — a customer who cannot select a package, retrieve an
 * invoice or upload payment proof could never leave the preview at all.
 *
 * Ledgora's accounting data lives in the browser workspace today, so there is no
 * durable business endpoint in the product yet. Rather than only unit-testing the
 * classifier, these tests register a REAL route through `buildApp`'s
 * `extraRoutes` seam and drive the guard end to end — which is also a standing
 * check that the first genuine accounting endpoint is protected the day it lands.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  isDurableBusinessWrite,
  isLifecycleWrite,
  organizationMayPersist,
} from '../src/guards/persistence.js';
import { requireAuthenticatedUser } from '../src/guards/platform.js';
import {
  authHeaders,
  createTestContext,
  login,
  seedUser,
  type SessionCookies,
  type TestContext,
} from './helpers/testApp.js';

/**
 * Stand-ins for the durable business endpoints the lifecycle rule names. Each
 * one simply reports success, so a 403 can only have come from the guard.
 */
/*
 * Deliberately paths the application does NOT serve.
 *
 * The point of these is that an UNKNOWN mutating path is classified as a
 * durable business write — fail-closed — so a path that has since become real
 * would test the route instead of the classifier, and would collide with it
 * when registered here. `/api/customers` was such a placeholder until the
 * business-party directory shipped; `/api/counterparties` replaces it. `/api/bills`
 * was another until Purchasing P2 shipped the supplier-bill routes;
 * `/api/bills-business` replaces it, and the real path is covered by its own
 * classification test below.
 */
const BUSINESS_PATHS = [
  '/api/journal-entries',
  '/api/counterparties',
  '/api/suppliers',
  '/api/bills-business',
  '/api/payments',
  '/api/receipts',
  '/api/documents',
  '/api/reminders',
  '/api/integrations',
  '/api/settings/accounting',
] as const;

function businessRoutes(app: FastifyInstance): void {
  for (const path of BUSINESS_PATHS) {
    app.post(path, { preHandler: requireAuthenticatedUser }, async (_request, reply) =>
      reply.code(201).send({ saved: true }),
    );
    app.get(path, { preHandler: requireAuthenticatedUser }, async (_request, reply) =>
      reply.send({ records: [] }),
    );
  }
  app.patch('/api/counterparties/:id', { preHandler: requireAuthenticatedUser }, async (_request, reply) =>
    reply.send({ saved: true }),
  );
  app.delete('/api/invoices-business/:id', { preHandler: requireAuthenticatedUser }, async (_request, reply) =>
    reply.send({ deleted: true }),
  );
}

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext({}, { extraRoutes: businessRoutes });
});
afterEach(async () => {
  await ctx.close();
});

const ORGANIZATION = { legalName: 'Acme Holdings Ltd.', country: 'AE', baseCurrency: 'USD' };

async function customer(email = 'sam@acme.test'): Promise<{ cookies: SessionCookies; userId: string }> {
  const user = await seedUser(ctx, { email, fullName: 'Sam Subscriber' });
  return { cookies: await login(ctx, email), userId: user.id };
}

async function firstPlanId(): Promise<string> {
  const plans = (await ctx.app.inject({ method: 'GET', url: '/api/plans/public' })).json().plans;
  return plans[0].id;
}

/** Register → organization → package selected. The Free Preview state. */
async function previewCustomer(email = 'sam@acme.test'): Promise<{
  cookies: SessionCookies;
  userId: string;
  subscriptionId: string;
}> {
  const { cookies, userId } = await customer(email);
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/organizations',
    headers: authHeaders(cookies),
    payload: ORGANIZATION,
  });
  expect(created.statusCode).toBe(201);

  const selected = await ctx.app.inject({
    method: 'POST',
    url: '/api/subscriptions',
    headers: authHeaders(cookies),
    payload: { planId: await firstPlanId() },
  });
  expect(selected.statusCode).toBe(201);
  return { cookies, userId, subscriptionId: selected.json().subscriptionId };
}

/** Approve the payment, exactly as a platform super-admin would. */
async function activate(subscriptionId: string): Promise<void> {
  await seedUser(ctx, { email: 'admin@ledgora.test', platformRoles: ['super_admin'] });
  const admin = await login(ctx, 'admin@ledgora.test');
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/admin/subscriptions/${subscriptionId}/activate`,
    headers: authHeaders(admin),
    payload: { reason: 'Paid by wire' },
  });
  expect(response.statusCode).toBeLessThan(300);
}

/* ── The classifier ──────────────────────────────────────────────────────── */

describe('write classification', () => {
  it('treats an unknown mutating path as a durable business write (fail-closed)', () => {
    // The property that matters: a business endpoint written next year is
    // protected without anyone remembering to register it here.
    expect(isDurableBusinessWrite('POST', '/api/journal-entries')).toBe(true);
    expect(isDurableBusinessWrite('PATCH', '/api/counterparties/abc')).toBe(true);
    expect(isDurableBusinessWrite('DELETE', '/api/anything-new')).toBe(true);
    expect(isDurableBusinessWrite('PUT', '/api/some/deep/path')).toBe(true);
  });

  it('never blocks a read', () => {
    expect(isDurableBusinessWrite('GET', '/api/journal-entries')).toBe(false);
    expect(isDurableBusinessWrite('HEAD', '/api/journal-entries')).toBe(false);
  });

  it('exempts the subscription lifecycle', () => {
    for (const path of [
      '/api/auth/login',
      '/api/auth/register',
      '/api/account/password',
      '/api/organizations',
      '/api/subscriptions',
      '/api/invoices/abc/payment-proof',
      '/api/plans/public',
      '/api/admin/subscriptions/abc/activate',
    ]) {
      expect(isLifecycleWrite(path)).toBe(true);
      expect(isDurableBusinessWrite('POST', path)).toBe(false);
    }
  });

  it('is not fooled by a query string or a prefix collision', () => {
    expect(isLifecycleWrite('/api/subscriptions?x=1')).toBe(true);
    // `/api/subscriptions-business` is NOT the lifecycle prefix.
    expect(isLifecycleWrite('/api/subscriptions-business')).toBe(false);
    expect(isDurableBusinessWrite('POST', '/api/subscriptions-business')).toBe(true);
  });
});

/* ── 11: durable business writes are refused ─────────────────────────────── */

describe('a Free Preview customer', () => {
  it('is refused every durable business write, with the documented body', async () => {
    const { cookies } = await previewCustomer();

    for (const path of BUSINESS_PATHS) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: path,
        headers: authHeaders(cookies),
        payload: { anything: true },
      });
      expect(response.statusCode, `POST ${path}`).toBe(403);
      expect(response.json()).toEqual({
        error: {
          code: 'subscription_required_for_persistence',
          message: 'Activate your subscription to save records permanently.',
        },
      });
    }
  });

  it('is refused updates and deletes too, not only creations', async () => {
    const { cookies } = await previewCustomer();

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/counterparties/abc',
      headers: authHeaders(cookies),
      payload: { name: 'x' },
    });
    expect(patched.statusCode).toBe(403);
    expect(patched.json().error.code).toBe('subscription_required_for_persistence');

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/invoices-business/abc',
      headers: authHeaders(cookies),
    });
    expect(deleted.statusCode).toBe(403);
  });

  it('may still READ business data', async () => {
    const { cookies } = await previewCustomer();
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/journal-entries',
      headers: authHeaders(cookies),
    });
    expect(response.statusCode).toBe(200);
  });

  it('is refused while awaiting verification as well as awaiting payment', async () => {
    const { cookies, subscriptionId } = await previewCustomer();

    const confirmed = await ctx.app.inject({
      method: 'POST',
      url: `/api/subscriptions/${subscriptionId}/confirm`,
      headers: authHeaders(cookies),
    });
    expect(confirmed.statusCode).toBe(201);

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/journal-entries',
      headers: authHeaders(cookies),
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('subscription_required_for_persistence');
  });
});

/* ── 12: the lifecycle keeps working ─────────────────────────────────────── */

describe('the lifecycle stays durable in Free Preview', () => {
  it('allows package selection and subscription confirmation', async () => {
    // `previewCustomer` itself performs organization creation and package
    // selection and asserts both succeeded — if the guard over-reached, the
    // customer could never choose a package at all.
    const { cookies, subscriptionId } = await previewCustomer();

    const confirmed = await ctx.app.inject({
      method: 'POST',
      url: `/api/subscriptions/${subscriptionId}/confirm`,
      headers: authHeaders(cookies),
    });
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.json().paymentReference).toBeTruthy();
  });

  it('allows the payment-proof upload', async () => {
    const { cookies, subscriptionId } = await previewCustomer();
    const confirmed = await ctx.app.inject({
      method: 'POST',
      url: `/api/subscriptions/${subscriptionId}/confirm`,
      headers: authHeaders(cookies),
    });
    const { invoiceId, paymentReference } = confirmed.json();

    const boundary = '----ledgoratest';
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="ledgoraPaymentReference"\r\n\r\n${paymentReference}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="amount"\r\n\r\n49\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="paidAt"\r\n\r\n2026-07-01\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="receipt.pdf"\r\n` +
      `Content-Type: application/pdf\r\n\r\n%PDF-1.4 receipt\r\n` +
      `--${boundary}--\r\n`;

    const uploaded = await ctx.app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payment-proof`,
      headers: { ...authHeaders(cookies), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(uploaded.statusCode).toBe(201);
  });

  it('allows subscription-status reads and authentication', async () => {
    const { cookies } = await previewCustomer();

    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/subscriptions/current', headers: authHeaders(cookies) }))
        .statusCode,
    ).toBe(200);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/organizations/current', headers: authHeaders(cookies) }))
        .statusCode,
    ).toBe(200);
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: authHeaders(cookies) })).statusCode,
    ).toBe(200);
  });
});

/* ── 13: activation opens durable writes ─────────────────────────────────── */

describe('once the payment is approved', () => {
  it('durable business writes are accepted', async () => {
    const { cookies, subscriptionId } = await previewCustomer();

    // Refused before …
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/api/journal-entries', headers: authHeaders(cookies), payload: {} }))
        .statusCode,
    ).toBe(403);

    await activate(subscriptionId);

    // … accepted after. Nothing about the customer changed but the subscription.
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/journal-entries',
      headers: authHeaders(cookies),
      payload: {},
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ saved: true });
  });

  it('the organization is recorded as permitted to persist', async () => {
    const { cookies, subscriptionId } = await previewCustomer();
    const organizationId = (
      await ctx.app.inject({ method: 'GET', url: '/api/organizations/current', headers: authHeaders(cookies) })
    ).json().organization.id;

    expect(await organizationMayPersist(ctx.db, organizationId)).toBe(false);
    await activate(subscriptionId);
    expect(await organizationMayPersist(ctx.db, organizationId)).toBe(true);
  });
});

/* ── 16–17: who the guard does not apply to ──────────────────────────────── */

describe('supplier bills are business writes', () => {
  /*
   * `/api/bills` became a REAL route with Purchasing P2. It records what a
   * company owes and posts to the ledger, so every one of its mutating paths is
   * a durable business write — and unlike `/api/invoices` it carries no
   * lifecycle resource, so nothing under it is exempt.
   */
  it('classifies every bill write as durable', () => {
    expect(isDurableBusinessWrite('POST', '/api/bills')).toBe(true);
    expect(isDurableBusinessWrite('PATCH', '/api/bills/abc')).toBe(true);
    expect(isDurableBusinessWrite('DELETE', '/api/bills/abc')).toBe(true);
    expect(isDurableBusinessWrite('POST', '/api/bills/abc/post')).toBe(true);
    expect(isDurableBusinessWrite('POST', '/api/bills/abc/reverse')).toBe(true);

    /* Reading what is owed is never blocked. */
    expect(isDurableBusinessWrite('GET', '/api/bills')).toBe(false);
  });

  it('refuses a Free Preview customer a supplier bill', async () => {
    const preview = await previewCustomer();

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/bills',
      headers: authHeaders(preview.cookies),
      payload: {
        issuingEntityId: 'entity-main', supplierId: '11111111-1111-1111-1111-111111111111',
        billDate: '2026-06-01', dueDate: '2026-07-01',
        lines: [{ accountId: '22222222-2222-2222-2222-222222222222', quantity: '1', unitPrice: '10' }],
      },
    });
    /* Refused for the SUBSCRIPTION, before any supplier or account is looked
     * at — a preview customer cannot put a permanent liability in their books. */
    expect(created.statusCode).toBe(403);
  });
});

describe('sales invoices are business writes, not lifecycle', () => {
  /*
   * `/api/invoices` carries two unrelated resources: the PLATFORM subscription
   * invoice a customer pays to leave Free Preview, and the tenant's own SALES
   * invoices. The prefix once exempted both, so a preview customer could issue
   * permanent invoices into their books. These pin both halves: the payment
   * path stays open, the sales path is closed.
   */
  it('classifies a sales-invoice write as durable, and payment-proof as lifecycle', () => {
    expect(isDurableBusinessWrite('POST', '/api/invoices')).toBe(true);
    expect(isDurableBusinessWrite('POST', '/api/invoices/abc/issue')).toBe(true);
    expect(isDurableBusinessWrite('POST', '/api/invoices/abc/void')).toBe(true);
    expect(isDurableBusinessWrite('DELETE', '/api/invoices/abc')).toBe(true);

    /* The one operation that must survive: paying to leave the preview. */
    expect(isDurableBusinessWrite('POST', '/api/invoices/abc/payment-proof')).toBe(false);
  });

  it('refuses a Free Preview customer a sales invoice, while still taking their payment proof', async () => {
    const preview = await previewCustomer();

    const issued = await ctx.app.inject({
      method: 'POST',
      url: '/api/invoices',
      headers: authHeaders(preview.cookies),
      payload: { customerId: 'whoever', issueDate: '2026-06-01', dueDate: '2026-07-01' },
    });
    expect(issued.statusCode).toBe(403);

    /* And the way out of the preview is still open — otherwise a customer could
     * never pay, and the preview would become permanent. */
    const proof = await ctx.app.inject({
      method: 'POST',
      url: `/api/invoices/${preview.subscriptionId}/payment-proof`,
      headers: authHeaders(preview.cookies),
      payload: {},
    });
    expect(proof.statusCode).not.toBe(403);
  });
});

describe('the guard leaves other callers alone', () => {
  it('answers 401 — not a subscription message — to an unauthenticated caller', async () => {
    const response = await ctx.app.inject({ method: 'POST', url: '/api/journal-entries', payload: {} });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('unauthenticated');
  });

  it('does not restrict a platform operator', async () => {
    await seedUser(ctx, { email: 'ops@ledgora.test', platformRoles: ['super_admin'] });
    const operator = await login(ctx, 'ops@ledgora.test');

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/journal-entries',
      headers: authHeaders(operator),
      payload: {},
    });
    expect(response.statusCode).toBe(201);
  });

  it('leaves the admin surface and its own capability guards untouched', async () => {
    await seedUser(ctx, { email: 'ops2@ledgora.test', platformRoles: ['super_admin'] });
    const operator = await login(ctx, 'ops2@ledgora.test');
    const { cookies } = await previewCustomer();
    void cookies;

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/applicants',
      headers: authHeaders(operator),
    });
    expect(response.statusCode).toBe(200);
  });

  it('does not answer "activate your subscription" to a user with no organization', async () => {
    // A clearer failure belongs to the route's own validation here.
    const { cookies } = await customer('lonely@acme.test');
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/journal-entries',
      headers: authHeaders(cookies),
      payload: {},
    });
    expect(response.json()?.error?.code).not.toBe('subscription_required_for_persistence');
  });
});

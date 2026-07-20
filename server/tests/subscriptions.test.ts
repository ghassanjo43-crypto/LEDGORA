/**
 * Phase 2: plans, organizations, subscriptions, backend payment references and
 * payment-proof upload.
 *
 * Central claim: a customer can request and pay for a subscription, but nothing
 * a customer does — including uploading a proof — activates it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { authHeaders, createTestContext, login, seedUser, type SessionCookies, type TestContext } from './helpers/testApp.js';
import { PAYMENT_REFERENCE_PATTERN } from '../src/lib/tokens.js';
import { countAuditLogs } from '../src/lib/audit.js';
import { CSRF_HEADER, CSRF_COOKIE, SESSION_COOKIE } from '../src/plugins/session.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

/* A 1x1 PNG — real magic bytes, so it passes content validation. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function customerWithOrg(email = 'casey@acme.test'): Promise<SessionCookies> {
  await seedUser(ctx, { email, fullName: 'Casey Jones' });
  const cookies = await login(ctx, email);
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/organizations',
    headers: authHeaders(cookies),
    payload: { legalName: 'Acme Holdings Ltd.', country: 'AE', baseCurrency: 'USD' },
  });
  expect(response.statusCode).toBe(201);
  return cookies;
}

async function firstPlanId(): Promise<string> {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
  return response.json().plans[0].id;
}

/** Select a plan and confirm it, returning the issued invoice. */
async function confirmedInvoice(cookies: SessionCookies) {
  const selected = await ctx.app.inject({
    method: 'POST',
    url: '/api/subscriptions',
    headers: authHeaders(cookies),
    payload: { planId: await firstPlanId() },
  });
  expect(selected.statusCode).toBe(201);
  const confirm = await ctx.app.inject({
    method: 'POST',
    url: `/api/subscriptions/${selected.json().subscriptionId}/confirm`,
    headers: authHeaders(cookies),
  });
  expect(confirm.statusCode).toBe(201);
  return confirm.json();
}

function proofForm(fields: Record<string, string>, file: Buffer = PNG, filename = 'receipt.png', contentType = 'image/png') {
  const boundary = '----ledgoratest';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/* ── Plans ───────────────────────────────────────────────────────────────── */

describe('public plan catalogue', () => {
  it('serves seeded public plans without authentication', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
    expect(response.statusCode).toBe(200);
    const plans = response.json().plans;
    expect(plans.length).toBeGreaterThanOrEqual(4);
    expect(plans[0]).toMatchObject({ code: 'core', currency: 'USD' });
    expect(Array.isArray(plans[0].modules)).toBe(true);
  });

  it('hides non-public and inactive plans', async () => {
    await ctx.db.updateTable('subscription_plans').set({ is_public: false }).where('code', '=', 'core').execute();
    await ctx.db.updateTable('subscription_plans').set({ is_active: false }).where('code', '=', 'business').execute();

    const codes = (await ctx.app.inject({ method: 'GET', url: '/api/plans/public' })).json().plans.map((p: { code: string }) => p.code);
    expect(codes).not.toContain('core');
    expect(codes).not.toContain('business');
  });

  it('refuses to select a non-public plan directly by id', async () => {
    const cookies = await customerWithOrg();
    const planId = await firstPlanId();
    await ctx.db.updateTable('subscription_plans').set({ is_public: false }).where('id', '=', planId).execute();

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/subscriptions',
      headers: authHeaders(cookies),
      payload: { planId },
    });
    expect(response.statusCode).toBe(403);
  });
});

/* ── Organizations ───────────────────────────────────────────────────────── */

describe('organizations', () => {
  it('creates an organization with the caller as owner', async () => {
    const cookies = await customerWithOrg();
    const response = await ctx.app.inject({ method: 'GET', url: '/api/organizations/current', headers: authHeaders(cookies) });
    expect(response.json().organization).toMatchObject({ legalName: 'Acme Holdings Ltd.', role: 'owner' });
    expect(await countAuditLogs(ctx.db, 'organization.created')).toBe(1);
  });

  it('requires authentication', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/organizations',
      payload: { legalName: 'Anon Ltd', country: 'AE' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a second organization for the same user', async () => {
    const cookies = await customerWithOrg();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: authHeaders(cookies),
      payload: { legalName: 'Another Ltd', country: 'AE' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('will not let a user choose a package before creating an organization', async () => {
    await seedUser(ctx, { email: 'noorg@acme.test' });
    const cookies = await login(ctx, 'noorg@acme.test');
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/subscriptions',
      headers: authHeaders(cookies),
      payload: { planId: await firstPlanId() },
    });
    expect(response.statusCode).toBe(400);
  });
});

/* ── Subscription + invoice + payment reference ──────────────────────────── */

describe('subscription confirmation', () => {
  it('creates a draft that is not active and has no invoice', async () => {
    const cookies = await customerWithOrg();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/subscriptions',
      headers: authHeaders(cookies),
      payload: { planId: await firstPlanId() },
    });
    expect(response.json().status).toBe('draft');
    expect(await ctx.db.selectFrom('subscription_invoices').selectAll().execute()).toHaveLength(0);
  });

  it('issues an invoice and a backend-generated payment reference on confirm', async () => {
    const cookies = await customerWithOrg();
    const result = await confirmedInvoice(cookies);

    expect(result.paymentReference).toMatch(PAYMENT_REFERENCE_PATTERN);
    expect(result.invoiceNumber).toMatch(/^SUB-\d{4}-\d{5}$/);
    expect(result.total).toBeGreaterThan(0);

    // Stored on BOTH the invoice and the subscription.
    const invoice = await ctx.db.selectFrom('subscription_invoices').selectAll().executeTakeFirstOrThrow();
    const subscription = await ctx.db.selectFrom('subscriptions').selectAll().executeTakeFirstOrThrow();
    expect(invoice.payment_reference).toBe(result.paymentReference);
    expect(subscription.payment_reference).toBe(result.paymentReference);
    // Awaiting payment — never active on confirmation.
    expect(subscription.status).toBe('pending_payment');
    expect(invoice.status).toBe('issued');
  });

  it('issues a distinct reference per invoice and enforces uniqueness in the database', async () => {
    const references = new Set<string>();
    for (const email of ['a@acme.test', 'b@acme.test', 'c@acme.test']) {
      const cookies = await customerWithOrg(email);
      references.add((await confirmedInvoice(cookies)).paymentReference);
    }
    expect(references.size).toBe(3);

    // The constraint — not application code — is the real guarantee.
    const [existing] = [...references];
    await expect(
      ctx.db
        .insertInto('subscription_invoices')
        .values({
          invoice_number: 'SUB-9999-00001',
          organization_id: (await ctx.db.selectFrom('organizations').select('id').executeTakeFirstOrThrow()).id,
          subscription_id: (await ctx.db.selectFrom('subscriptions').select('id').executeTakeFirstOrThrow()).id,
          currency: 'USD',
          subtotal: '1',
          total: '1',
          payment_reference: existing!,
          due_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('exposes the invoice and bank instructions to the customer', async () => {
    const cookies = await customerWithOrg();
    await confirmedInvoice(cookies);

    const response = await ctx.app.inject({ method: 'GET', url: '/api/subscriptions/current', headers: authHeaders(cookies) });
    const body = response.json();
    expect(body.subscription.status).toBe('pending_payment');
    expect(body.invoice.paymentReference).toMatch(PAYMENT_REFERENCE_PATTERN);
    // Placeholder bank details are flagged so the UI can warn.
    expect(body.bank.isPlaceholder).toBe(true);
    expect(body.bank.instructions).toContain('LEDGORA payment reference');
  });

  it('cannot confirm another organization\'s subscription', async () => {
    const victim = await customerWithOrg('victim@acme.test');
    const selected = await ctx.app.inject({
      method: 'POST',
      url: '/api/subscriptions',
      headers: authHeaders(victim),
      payload: { planId: await firstPlanId() },
    });
    const attacker = await customerWithOrg('attacker@acme.test');

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/subscriptions/${selected.json().subscriptionId}/confirm`,
      headers: authHeaders(attacker),
    });
    expect(response.statusCode).toBe(404);
  });
});

/* ── Payment proof ───────────────────────────────────────────────────────── */

describe('payment proof submission', () => {
  it('accepts a valid receipt and moves to pending verification WITHOUT activating', async () => {
    const cookies = await customerWithOrg();
    const invoice = await confirmedInvoice(cookies);

    const form = proofForm({
      ledgoraPaymentReference: invoice.paymentReference,
      bankTransactionReference: 'TT-2026-00184',
      amount: String(invoice.total),
      paidAt: '2026-07-19',
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/invoices/${invoice.invoiceId}/payment-proof`,
      headers: { ...authHeaders(cookies), 'content-type': form.contentType },
      payload: form.body,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().matchesInvoiceReference).toBe(true);

    const subscription = await ctx.db.selectFrom('subscriptions').selectAll().executeTakeFirstOrThrow();
    const stored = await ctx.db.selectFrom('subscription_invoices').selectAll().executeTakeFirstOrThrow();
    // THE critical assertion: uploading a proof never activates anything.
    expect(subscription.status).toBe('pending_verification');
    expect(subscription.starts_at).toBeNull();
    expect(stored.status).toBe('proof_submitted');
    expect(stored.paid_at).toBeNull();
  });

  it('stores the file outside PostgreSQL, keeping only an opaque key', async () => {
    const cookies = await customerWithOrg();
    const invoice = await confirmedInvoice(cookies);
    const form = proofForm({
      ledgoraPaymentReference: invoice.paymentReference,
      amount: String(invoice.total),
      paidAt: '2026-07-19',
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/invoices/${invoice.invoiceId}/payment-proof`,
      headers: { ...authHeaders(cookies), 'content-type': form.contentType },
      payload: form.body,
    });

    const proof = await ctx.db.selectFrom('payment_proofs').selectAll().executeTakeFirstOrThrow();
    expect(ctx.storage.size).toBe(1);
    expect(proof.storage_key).toMatch(/^[a-f0-9]{32}\.png$/);
    // No base64 blob anywhere in the row.
    expect(JSON.stringify(proof)).not.toContain('iVBORw0KGgo');
  });

  it('flags a reference that does not match the invoice, without refusing it', async () => {
    const cookies = await customerWithOrg();
    const invoice = await confirmedInvoice(cookies);
    const form = proofForm({
      ledgoraPaymentReference: 'LG-XXXX-YYYY',
      amount: String(invoice.total),
      paidAt: '2026-07-19',
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/invoices/${invoice.invoiceId}/payment-proof`,
      headers: { ...authHeaders(cookies), 'content-type': form.contentType },
      payload: form.body,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().matchesInvoiceReference).toBe(false);
  });

  it('rejects a disallowed file type', async () => {
    const cookies = await customerWithOrg();
    const invoice = await confirmedInvoice(cookies);
    const form = proofForm(
      { ledgoraPaymentReference: invoice.paymentReference, amount: '49', paidAt: '2026-07-19' },
      Buffer.from('MZ executable'),
      'payload.exe',
      'application/x-msdownload',
    );

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/invoices/${invoice.invoiceId}/payment-proof`,
      headers: { ...authHeaders(cookies), 'content-type': form.contentType },
      payload: form.body,
    });
    expect(response.statusCode).toBe(400);
    expect(ctx.storage.size).toBe(0);
  });

  it('rejects a file whose bytes contradict its declared type', async () => {
    const cookies = await customerWithOrg();
    const invoice = await confirmedInvoice(cookies);
    // Claims PNG, actually an executable stub.
    const form = proofForm(
      { ledgoraPaymentReference: invoice.paymentReference, amount: '49', paidAt: '2026-07-19' },
      Buffer.from('MZ not really a png'),
      'sneaky.png',
      'image/png',
    );

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/invoices/${invoice.invoiceId}/payment-proof`,
      headers: { ...authHeaders(cookies), 'content-type': form.contentType },
      payload: form.body,
    });
    expect(response.statusCode).toBe(400);
    expect(ctx.storage.size).toBe(0);
  });

  it('rejects a file over the size limit', async () => {
    const small = await createTestContext({ MAX_UPLOAD_BYTES: '2048' });
    try {
      await seedUser(small, { email: 'big@acme.test' });
      const cookies = await login(small, 'big@acme.test');
      await small.app.inject({
        method: 'POST',
        url: '/api/organizations',
        headers: authHeaders(cookies),
        payload: { legalName: 'Big Files Ltd', country: 'AE' },
      });
      const plans = (await small.app.inject({ method: 'GET', url: '/api/plans/public' })).json().plans;
      const selected = await small.app.inject({
        method: 'POST',
        url: '/api/subscriptions',
        headers: authHeaders(cookies),
        payload: { planId: plans[0].id },
      });
      const confirmed = await small.app.inject({
        method: 'POST',
        url: `/api/subscriptions/${selected.json().subscriptionId}/confirm`,
        headers: authHeaders(cookies),
      });
      const invoice = confirmed.json();

      const oversized = Buffer.concat([PNG, Buffer.alloc(8192, 0x41)]);
      const form = proofForm(
        { ledgoraPaymentReference: invoice.paymentReference, amount: '49', paidAt: '2026-07-19' },
        oversized,
      );
      const response = await small.app.inject({
        method: 'POST',
        url: `/api/invoices/${invoice.invoiceId}/payment-proof`,
        headers: { ...authHeaders(cookies), 'content-type': form.contentType },
        payload: form.body,
      });
      expect([400, 413]).toContain(response.statusCode);
      expect(small.storage.size).toBe(0);
    } finally {
      await small.close();
    }
  });

  it('refuses a second proof while one is awaiting review', async () => {
    const cookies = await customerWithOrg();
    const invoice = await confirmedInvoice(cookies);
    const send = async () => {
      const form = proofForm({
        ledgoraPaymentReference: invoice.paymentReference,
        amount: String(invoice.total),
        paidAt: '2026-07-19',
      });
      return ctx.app.inject({
        method: 'POST',
        url: `/api/invoices/${invoice.invoiceId}/payment-proof`,
        headers: { ...authHeaders(cookies), 'content-type': form.contentType },
        payload: form.body,
      });
    };
    expect((await send()).statusCode).toBe(201);
    expect((await send()).statusCode).toBe(409);
  });

  it('cannot attach a proof to another organization\'s invoice', async () => {
    const victim = await customerWithOrg('victim@acme.test');
    const invoice = await confirmedInvoice(victim);
    const attacker = await customerWithOrg('attacker@acme.test');

    const form = proofForm({
      ledgoraPaymentReference: invoice.paymentReference,
      amount: String(invoice.total),
      paidAt: '2026-07-19',
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/invoices/${invoice.invoiceId}/payment-proof`,
      headers: { ...authHeaders(attacker), 'content-type': form.contentType },
      payload: form.body,
    });
    expect(response.statusCode).toBe(404);
  });

  it('requires authentication and CSRF', async () => {
    const cookies = await customerWithOrg();
    const invoice = await confirmedInvoice(cookies);
    const form = proofForm({ ledgoraPaymentReference: invoice.paymentReference, amount: '49', paidAt: '2026-07-19' });

    const anonymous = await ctx.app.inject({
      method: 'POST',
      url: `/api/invoices/${invoice.invoiceId}/payment-proof`,
      headers: { 'content-type': form.contentType },
      payload: form.body,
    });
    expect(anonymous.statusCode).toBe(401);

    const noCsrf = await ctx.app.inject({
      method: 'POST',
      url: `/api/invoices/${invoice.invoiceId}/payment-proof`,
      headers: {
        cookie: `${SESSION_COOKIE}=${cookies.session}; ${CSRF_COOKIE}=${cookies.csrf}`,
        'content-type': form.contentType,
      },
      payload: form.body,
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.headers[CSRF_HEADER]).toBeUndefined();
  });

  it('audits the submission', async () => {
    const cookies = await customerWithOrg();
    const invoice = await confirmedInvoice(cookies);
    const form = proofForm({
      ledgoraPaymentReference: invoice.paymentReference,
      amount: String(invoice.total),
      paidAt: '2026-07-19',
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/invoices/${invoice.invoiceId}/payment-proof`,
      headers: { ...authHeaders(cookies), 'content-type': form.contentType },
      payload: form.body,
    });
    expect(await countAuditLogs(ctx.db, 'payment_proof.submitted')).toBe(1);
    expect(await countAuditLogs(ctx.db, 'subscription.confirmed')).toBe(1);
  });
});

/* ── Free Demo ───────────────────────────────────────────────────────────── */

describe('free demo', () => {
  it('creates no invoice, subscription or payment reference on the backend', async () => {
    // A Free Demo visitor never authenticates and never calls these endpoints.
    // Every write path is proven closed to an anonymous caller.
    for (const [method, url] of [
      ['POST', '/api/organizations'],
      ['POST', '/api/subscriptions'],
      ['POST', '/api/subscriptions/00000000-0000-0000-0000-000000000000/confirm'],
      ['POST', '/api/invoices/00000000-0000-0000-0000-000000000000/payment-proof'],
    ] as const) {
      const response = await ctx.app.inject({ method, url, payload: {} });
      expect(response.statusCode, url).toBe(401);
    }

    expect(await ctx.db.selectFrom('subscriptions').selectAll().execute()).toHaveLength(0);
    expect(await ctx.db.selectFrom('subscription_invoices').selectAll().execute()).toHaveLength(0);
    expect(await ctx.db.selectFrom('payment_proofs').selectAll().execute()).toHaveLength(0);
  });

  it('serves the public catalogue to an anonymous demo visitor', async () => {
    // The demo still needs pricing — reading plans is the only open endpoint.
    const response = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
    expect(response.statusCode).toBe(200);
  });
});

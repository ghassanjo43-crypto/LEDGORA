/**
 * Phase 3: administrator payment review, activation and platform configuration.
 *
 * Central claims: only an authorised reviewer can approve; approval activates
 * exactly once; rejection never grants entitlements; every decision is audited.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { authHeaders, createTestContext, login, seedUser, type SessionCookies, type TestContext } from './helpers/testApp.js';
import { countAuditLogs } from '../src/lib/audit.js';

let ctx: TestContext;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

/** A customer with an organization, a confirmed invoice and a submitted proof. */
async function customerAwaitingReview(email = 'casey@acme.test') {
  await seedUser(ctx, { email, fullName: 'Casey Jones' });
  const cookies = await login(ctx, email);

  await ctx.app.inject({
    method: 'POST',
    url: '/api/organizations',
    headers: authHeaders(cookies),
    payload: { legalName: 'Acme Holdings Ltd.', country: 'AE' },
  });
  const plans = (await ctx.app.inject({ method: 'GET', url: '/api/plans/public' })).json().plans;
  const selected = await ctx.app.inject({
    method: 'POST',
    url: '/api/subscriptions',
    headers: authHeaders(cookies),
    payload: { planId: plans[1].id },
  });
  const invoice = (
    await ctx.app.inject({
      method: 'POST',
      url: `/api/subscriptions/${selected.json().subscriptionId}/confirm`,
      headers: authHeaders(cookies),
    })
  ).json();

  const boundary = '----review';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries({
    ledgoraPaymentReference: invoice.paymentReference,
    amount: String(invoice.total),
    paidAt: '2026-07-19',
  })) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="receipt.png"\r\nContent-Type: image/png\r\n\r\n`),
    PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  const upload = await ctx.app.inject({
    method: 'POST',
    url: `/api/invoices/${invoice.invoiceId}/payment-proof`,
    headers: { ...authHeaders(cookies), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(parts),
  });
  expect(upload.statusCode).toBe(201);

  const proof = await ctx.db.selectFrom('payment_proofs').selectAll().executeTakeFirstOrThrow();
  return { cookies, invoice, proofId: proof.id, planCode: plans[1].code };
}

async function adminCookies(role: 'super_admin' | 'billing_admin' | 'support' = 'super_admin'): Promise<SessionCookies> {
  const email = `${role}@ledgora.test`;
  await seedUser(ctx, { email, platformRoles: [role] });
  return login(ctx, email);
}

/* ── Review queue ────────────────────────────────────────────────────────── */

describe('review queue', () => {
  it('shows the pending proof with both references and a match flag', async () => {
    const { invoice } = await customerAwaitingReview();
    const admin = await adminCookies('billing_admin');

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/payment-proofs?status=submitted',
      headers: authHeaders(admin),
    });
    expect(response.statusCode).toBe(200);
    const [proof] = response.json().proofs;
    expect(proof).toMatchObject({
      status: 'submitted',
      organizationName: 'Acme Holdings Ltd.',
      invoicePaymentReference: invoice.paymentReference,
      quotedReference: invoice.paymentReference,
      matchesInvoiceReference: true,
    });
  });

  it('serves the receipt as a non-renderable attachment', async () => {
    const { proofId } = await customerAwaitingReview();
    const admin = await adminCookies('support');

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/payment-proofs/${proofId}/file`,
      headers: authHeaders(admin),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.rawPayload.equals(PNG)).toBe(true);
  });

  it('is closed to customers', async () => {
    const { cookies } = await customerAwaitingReview();
    const response = await ctx.app.inject({ method: 'GET', url: '/api/admin/payment-proofs', headers: authHeaders(cookies) });
    expect(response.statusCode).toBe(403);
  });
});

/* ── Approval ────────────────────────────────────────────────────────────── */

describe('approval', () => {
  it('activates the subscription exactly once and applies the plan entitlements', async () => {
    const { proofId, planCode } = await customerAwaitingReview();
    const admin = await adminCookies('billing_admin');

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/payment-proofs/${proofId}/approve`,
      headers: authHeaders(admin),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('active');
    expect(body.appliedModules).toContain('inventory_basic');

    const subscription = await ctx.db.selectFrom('subscriptions').selectAll().executeTakeFirstOrThrow();
    const invoice = await ctx.db.selectFrom('subscription_invoices').selectAll().executeTakeFirstOrThrow();
    const proof = await ctx.db.selectFrom('payment_proofs').selectAll().executeTakeFirstOrThrow();
    const plan = await ctx.db.selectFrom('subscription_plans').selectAll().where('code', '=', planCode).executeTakeFirstOrThrow();

    expect(subscription.status).toBe('active');
    expect(subscription.starts_at).not.toBeNull();
    expect(subscription.expires_at).not.toBeNull();
    // Limits come from the plan, not from anything the customer supplied.
    expect(subscription.user_limit).toBe(plan.user_limit);
    expect(subscription.entity_limit).toBe(plan.entity_limit);
    expect(invoice.status).toBe('paid');
    expect(invoice.paid_at).not.toBeNull();
    expect(proof.status).toBe('approved');
    expect(proof.reviewed_by_user_id).not.toBeNull();
    expect(proof.reviewed_at).not.toBeNull();
  });

  it('refuses a duplicate approval', async () => {
    const { proofId } = await customerAwaitingReview();
    const admin = await adminCookies('billing_admin');

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/payment-proofs/${proofId}/approve`,
      headers: authHeaders(admin),
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/payment-proofs/${proofId}/approve`,
      headers: authHeaders(admin),
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    // Exactly one activation, no matter how many times approve is called.
    expect(await countAuditLogs(ctx.db, 'subscription.activated')).toBe(1);
  });

  it('is refused for a support user', async () => {
    const { proofId } = await customerAwaitingReview();
    const support = await adminCookies('support');

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/payment-proofs/${proofId}/approve`,
      headers: authHeaders(support),
    });
    expect(response.statusCode).toBe(403);
    expect((await ctx.db.selectFrom('subscriptions').selectAll().executeTakeFirstOrThrow()).status).toBe('pending_verification');
  });

  it('cannot be performed by the customer who submitted it', async () => {
    const { cookies, proofId } = await customerAwaitingReview();
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/payment-proofs/${proofId}/approve`,
      headers: authHeaders(cookies),
    });
    expect(response.statusCode).toBe(403);
    expect((await ctx.db.selectFrom('subscriptions').selectAll().executeTakeFirstOrThrow()).status).toBe('pending_verification');
  });

  it('records who approved it in the audit trail', async () => {
    const { proofId } = await customerAwaitingReview();
    const admin = await adminCookies('billing_admin');
    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/payment-proofs/${proofId}/approve`,
      headers: authHeaders(admin),
    });

    const entry = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'payment_proof.approved')
      .executeTakeFirstOrThrow();
    expect(entry.actor_platform_role).toBe('billing_admin');
    expect(entry.actor_user_id).not.toBeNull();
  });
});

/* ── Rejection & information requests ────────────────────────────────────── */

describe('rejection', () => {
  it('never activates and returns the customer to payment', async () => {
    const { proofId } = await customerAwaitingReview();
    const admin = await adminCookies('billing_admin');

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/payment-proofs/${proofId}/reject`,
      headers: authHeaders(admin),
      payload: { reason: 'The transfer amount does not match the invoice.' },
    });
    expect(response.statusCode).toBe(200);

    const subscription = await ctx.db.selectFrom('subscriptions').selectAll().executeTakeFirstOrThrow();
    const invoice = await ctx.db.selectFrom('subscription_invoices').selectAll().executeTakeFirstOrThrow();
    expect(subscription.status).toBe('rejected');
    expect(subscription.starts_at).toBeNull();
    expect(invoice.status).toBe('rejected');
    expect(invoice.paid_at).toBeNull();
    expect(await countAuditLogs(ctx.db, 'subscription.activated')).toBe(0);
  });

  it('requires a reason', async () => {
    const { proofId } = await customerAwaitingReview();
    const admin = await adminCookies('billing_admin');
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/payment-proofs/${proofId}/reject`,
      headers: authHeaders(admin),
      payload: { reason: '   ' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('cannot reject an already-approved proof', async () => {
    const { proofId } = await customerAwaitingReview();
    const admin = await adminCookies('billing_admin');
    await ctx.app.inject({ method: 'POST', url: `/api/admin/payment-proofs/${proofId}/approve`, headers: authHeaders(admin) });

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/payment-proofs/${proofId}/reject`,
      headers: authHeaders(admin),
      payload: { reason: 'changed my mind' },
    });
    expect(response.statusCode).toBe(409);
    expect((await ctx.db.selectFrom('subscriptions').selectAll().executeTakeFirstOrThrow()).status).toBe('active');
  });

  it('records an information request without deciding the outcome', async () => {
    const { proofId } = await customerAwaitingReview();
    const admin = await adminCookies('billing_admin');

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/payment-proofs/${proofId}/request-information`,
      headers: authHeaders(admin),
      payload: { note: 'Please send the full bank statement page.' },
    });
    expect(response.statusCode).toBe(200);

    const proof = await ctx.db.selectFrom('payment_proofs').selectAll().executeTakeFirstOrThrow();
    // Still open for review; nothing activated or rejected.
    expect(proof.status).toBe('submitted');
    expect(proof.information_request).toContain('bank statement');
    expect(await countAuditLogs(ctx.db, 'payment_proof.information_requested')).toBe(1);
  });
});

/* ── Subscription lifecycle ──────────────────────────────────────────────── */

describe('manual subscription lifecycle', () => {
  it('lets only a super_admin activate manually, and demands a reason', async () => {
    const { proofId } = await customerAwaitingReview();
    void proofId;
    const subscription = await ctx.db.selectFrom('subscriptions').selectAll().executeTakeFirstOrThrow();

    const billing = await adminCookies('billing_admin');
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscriptions/${subscription.id}/activate`,
      headers: authHeaders(billing),
      payload: { reason: 'goodwill' },
    });
    expect(denied.statusCode).toBe(403);

    const root = await adminCookies('super_admin');
    const noReason = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscriptions/${subscription.id}/activate`,
      headers: authHeaders(root),
      payload: { reason: '' },
    });
    expect(noReason.statusCode).toBe(400);

    const allowed = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscriptions/${subscription.id}/activate`,
      headers: authHeaders(root),
      payload: { reason: 'Paid by cheque, verified manually.' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().status).toBe('active');

    const entry = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'subscription.activated')
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(entry.metadata)).toContain('cheque');
  });

  it('suspends and cancels without deleting history', async () => {
    await customerAwaitingReview();
    const subscription = await ctx.db.selectFrom('subscriptions').selectAll().executeTakeFirstOrThrow();
    const admin = await adminCookies('super_admin');

    for (const [action, expected] of [['suspend', 'suspended'], ['cancel', 'cancelled']] as const) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/admin/subscriptions/${subscription.id}/${action}`,
        headers: authHeaders(admin),
        payload: { reason: `administrative ${action}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe(expected);
    }
    // The invoice and proof records survive a lifecycle change.
    expect(await ctx.db.selectFrom('subscription_invoices').selectAll().execute()).toHaveLength(1);
    expect(await ctx.db.selectFrom('payment_proofs').selectAll().execute()).toHaveLength(1);
  });
});

/* ── Platform configuration ──────────────────────────────────────────────── */

describe('bank details', () => {
  it('clears the placeholder flag when real details are saved, and audits it', async () => {
    const admin = await adminCookies('billing_admin');

    const before = await ctx.app.inject({ method: 'GET', url: '/api/admin/bank-details', headers: authHeaders(admin) });
    expect(before.json().bankDetails.isPlaceholder).toBe(true);

    const response = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/admin/bank-details',
      headers: authHeaders(admin),
      payload: { bankName: 'Emirates NBD', accountNumber: '9988776655', iban: 'AE070331234567890123456' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().bankDetails.isPlaceholder).toBe(false);
    expect(await countAuditLogs(ctx.db, 'bank_details.updated')).toBe(1);
  });

  it('never writes account numbers into the audit metadata', async () => {
    const admin = await adminCookies('billing_admin');
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/admin/bank-details',
      headers: authHeaders(admin),
      payload: { accountNumber: '9988776655' },
    });
    const entry = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'bank_details.updated')
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(entry.metadata)).not.toContain('9988776655');
  });

  it('is refused for support and for customers', async () => {
    const support = await adminCookies('support');
    const supportAttempt = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/admin/bank-details',
      headers: authHeaders(support),
      payload: { bankName: 'Attacker Bank' },
    });
    expect(supportAttempt.statusCode).toBe(403);

    await seedUser(ctx, { email: 'plain@acme.test' });
    const customer = await login(ctx, 'plain@acme.test');
    const customerAttempt = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/admin/bank-details',
      headers: authHeaders(customer),
      payload: { bankName: 'Attacker Bank' },
    });
    expect(customerAttempt.statusCode).toBe(403);

    expect((await ctx.db.selectFrom('bank_details').selectAll().executeTakeFirstOrThrow()).bank_name).not.toContain('Attacker');
  });
});

describe('package administration', () => {
  it('creates, updates and archives a package, auditing each change', async () => {
    const admin = await adminCookies('billing_admin');

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/plans',
      headers: authHeaders(admin),
      payload: {
        code: 'starter', name: 'Starter', edition: 'core', monthlyPrice: 19,
        userLimit: 1, entityLimit: 1, modules: ['accounting'],
      },
    });
    expect(created.statusCode).toBe(201);
    const planId = created.json().id;

    expect(
      (await ctx.app.inject({
        method: 'PATCH',
        url: `/api/admin/plans/${planId}`,
        headers: authHeaders(admin),
        payload: { monthlyPrice: 25 },
      })).statusCode,
    ).toBe(200);

    expect(
      (await ctx.app.inject({ method: 'POST', url: `/api/admin/plans/${planId}/archive`, headers: authHeaders(admin) })).statusCode,
    ).toBe(200);

    // An archived package leaves the public catalogue.
    const publicCodes = (await ctx.app.inject({ method: 'GET', url: '/api/plans/public' })).json().plans.map((p: { code: string }) => p.code);
    expect(publicCodes).not.toContain('starter');

    expect(await countAuditLogs(ctx.db, 'plan.created')).toBe(1);
    expect(await countAuditLogs(ctx.db, 'plan.updated')).toBe(1);
    expect(await countAuditLogs(ctx.db, 'plan.archived')).toBe(1);
  });

  it('rejects a duplicate package code', async () => {
    const admin = await adminCookies('billing_admin');
    const payload = { code: 'core', name: 'Clash', edition: 'core', monthlyPrice: 10, userLimit: 1, entityLimit: 1 };
    const response = await ctx.app.inject({ method: 'POST', url: '/api/admin/plans', headers: authHeaders(admin), payload });
    expect(response.statusCode).toBe(409);
  });

  it('is refused for support', async () => {
    const support = await adminCookies('support');
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/plans',
      headers: authHeaders(support),
      payload: { code: 'x', name: 'X', edition: 'core', monthlyPrice: 1, userLimit: 1, entityLimit: 1 },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('billing settings', () => {
  it('updates and audits, and is refused for support', async () => {
    const admin = await adminCookies('billing_admin');
    const response = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/admin/billing-settings',
      headers: authHeaders(admin),
      payload: { paymentDueDays: 14, graceDays: 10 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().billingSettings.paymentDueDays).toBe(14);
    expect(await countAuditLogs(ctx.db, 'billing_settings.updated')).toBe(1);

    const support = await adminCookies('support');
    const denied = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/admin/billing-settings',
      headers: authHeaders(support),
      payload: { graceDays: 90 },
    });
    expect(denied.statusCode).toBe(403);
  });
});

/**
 * Applicant visibility — the registration gap.
 *
 * The defect: a customer could create an account and then be invisible to the
 * platform administrator until they happened to choose a package, because the
 * roster was built from `subscriptions` and there was nothing to join to.
 *
 * Central claim of this suite: a registered customer is visible to the
 * administrator from the instant the account exists, at every stage of the
 * funnel, and stays visible when the organization, the plan, the subscription,
 * the invoice or the proof is absent. Platform operators never appear.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { authHeaders, createTestContext, login, seedUser, TEST_PASSWORD, type SessionCookies, type TestContext } from './helpers/testApp.js';
import { reconcileApplications, type ApplicantView } from '../src/services/applicantService.js';

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

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** Register through the real HTTP route — the path the defect appeared on. */
async function register(
  email: string,
  fullName = 'New Prospect',
): Promise<{ cookies: SessionCookies; userId: string }> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: TEST_PASSWORD, fullName },
  });
  expect(response.statusCode).toBe(201);
  const raw = response.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const find = (name: string): string => {
    const match = list.find((c) => c.startsWith(`${name}=`));
    return match ? (match.split(';')[0]?.split('=').slice(1).join('=') ?? '') : '';
  };
  return {
    cookies: { session: find('ledgora_session'), csrf: find('ledgora_csrf') },
    userId: response.json().user.id,
  };
}

async function adminCookies(role: 'super_admin' | 'billing_admin' | 'support' = 'super_admin'): Promise<SessionCookies> {
  const email = `${role}@ledgora.test`;
  await seedUser(ctx, { email, fullName: `Operator ${role}`, platformRoles: [role] });
  return login(ctx, email);
}

interface RosterResponse {
  applicants: ApplicantView[];
  pagination: { limit: number; offset: number; count: number; total: number };
  stageCounts: Record<string, number>;
  dormantDays: number;
}

async function fetchApplicants(cookies: SessionCookies, query = ''): Promise<RosterResponse> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/admin/applicants${query}`,
    headers: authHeaders(cookies),
  });
  expect(response.statusCode).toBe(200);
  return response.json() as RosterResponse;
}

const findByEmail = (body: RosterResponse, email: string): ApplicantView | undefined =>
  body.applicants.find((a) => a.email === email);

async function createOrganization(cookies: SessionCookies, legalName = 'Acme Holdings Ltd.') {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/organizations',
    headers: authHeaders(cookies),
    payload: { legalName, country: 'AE', baseCurrency: 'USD' },
  });
  expect(response.statusCode).toBe(201);
}

async function selectPlan(cookies: SessionCookies, index = 0): Promise<string> {
  const plans = (await ctx.app.inject({ method: 'GET', url: '/api/plans/public' })).json().plans;
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/subscriptions',
    headers: authHeaders(cookies),
    payload: { planId: plans[index].id },
  });
  expect(response.statusCode).toBe(201);
  return response.json().subscriptionId;
}

async function confirm(cookies: SessionCookies, subscriptionId: string) {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/subscriptions/${subscriptionId}/confirm`,
    headers: authHeaders(cookies),
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function uploadProof(cookies: SessionCookies, invoice: { invoiceId: string; paymentReference: string; total: number }) {
  const boundary = '----applicants';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries({
    ledgoraPaymentReference: invoice.paymentReference,
    amount: String(invoice.total),
    paidAt: '2026-07-20',
  })) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="receipt.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/invoices/${invoice.invoiceId}/payment-proof`,
    headers: { ...authHeaders(cookies), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(parts),
  });
  expect(response.statusCode).toBe(201);
}

/* ── 1 & 2: registration alone makes an applicant ────────────────────────── */

describe('a newly registered customer', () => {
  it('appears in the applicant roster immediately, with no package chosen', async () => {
    const admin = await adminCookies();
    await register('prospect@new.test', 'Priya Prospect');

    const body = await fetchApplicants(admin);
    const applicant = findByEmail(body, 'prospect@new.test');

    expect(applicant).toBeDefined();
    expect(applicant!.fullName).toBe('Priya Prospect');
    expect(applicant!.stage).toBe('registered_no_package');
    expect(applicant!.planName).toBeNull();
    expect(applicant!.organizationName).toBeNull();
    expect(applicant!.subscriptionId).toBeNull();
  });

  it('gets an onboarding record written in the same transaction as the account', async () => {
    const { userId } = await register('atomic@new.test');
    const record = await ctx.db
      .selectFrom('subscription_applications')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();

    expect(record).toBeDefined();
    expect(record!.status).toBe('registered_no_package');
    expect(record!.source).toBe('self_registration');
    expect(record!.organization_id).toBeNull();
    expect(record!.selected_plan_id).toBeNull();
  });

  it('leaves no account behind when the registration transaction fails', async () => {
    // A duplicate email fails inside the transaction; neither the user nor an
    // orphaned application row may survive it.
    await register('dupe@new.test');
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'dupe@new.test', password: TEST_PASSWORD, fullName: 'Second Attempt' },
    });
    expect(second.statusCode).toBe(409);

    const users = await ctx.db.selectFrom('users').select('id').where('normalized_email', '=', 'dupe@new.test').execute();
    const applications = await ctx.db.selectFrom('subscription_applications').select('id').execute();
    expect(users).toHaveLength(1);
    expect(applications).toHaveLength(1);
  });
});

/* ── 3, 4, 5: the funnel moves the applicant along ───────────────────────── */

describe('applicant lifecycle', () => {
  it('moves to package_selected when a package is chosen', async () => {
    const admin = await adminCookies();
    const { cookies } = await register('stage2@new.test');
    await createOrganization(cookies);
    await selectPlan(cookies);

    const applicant = findByEmail(await fetchApplicants(admin), 'stage2@new.test')!;
    expect(applicant.stage).toBe('package_selected');
    expect(applicant.planCode).toBe('core');
    expect(applicant.organizationName).toBe('Acme Holdings Ltd.');
    expect(applicant.packageSelectedAt).not.toBeNull();
  });

  it('moves to awaiting_payment when the invoice and payment reference are issued', async () => {
    const admin = await adminCookies();
    const { cookies } = await register('stage3@new.test');
    await createOrganization(cookies);
    await confirm(cookies, await selectPlan(cookies));

    const applicant = findByEmail(await fetchApplicants(admin), 'stage3@new.test')!;
    expect(applicant.stage).toBe('awaiting_payment');
    expect(applicant.paymentReference).toBeTruthy();
    expect(applicant.paymentStartedAt).not.toBeNull();
  });

  it('moves to pending_verification when the payment proof is uploaded', async () => {
    const admin = await adminCookies();
    const { cookies } = await register('stage4@new.test');
    await createOrganization(cookies);
    const invoice = await confirm(cookies, await selectPlan(cookies));
    await uploadProof(cookies, invoice);

    const applicant = findByEmail(await fetchApplicants(admin), 'stage4@new.test')!;
    expect(applicant.stage).toBe('pending_verification');
    expect(applicant.proofId).not.toBeNull();
    expect(applicant.proofStatus).toBe('submitted');
    expect(applicant.proofUploadedAt).not.toBeNull();
  });

  it('moves to active_subscriber when the payment is approved', async () => {
    const admin = await adminCookies();
    const { cookies } = await register('stage5@new.test');
    await createOrganization(cookies);
    const invoice = await confirm(cookies, await selectPlan(cookies));
    await uploadProof(cookies, invoice);

    const proof = await ctx.db.selectFrom('payment_proofs').select('id').executeTakeFirstOrThrow();
    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/payment-proofs/${proof.id}/approve`,
      headers: authHeaders(admin),
    });
    expect(approve.statusCode).toBe(200);

    const applicant = findByEmail(await fetchApplicants(admin), 'stage5@new.test')!;
    expect(applicant.stage).toBe('active_subscriber');
    expect(applicant.activatedAt).not.toBeNull();
    expect(applicant.subscriptionStatus).toBe('active');

    // The stored record agrees with the derived stage.
    const record = await ctx.db
      .selectFrom('subscription_applications')
      .selectAll()
      .where('organization_id', 'is not', null)
      .executeTakeFirstOrThrow();
    expect(record.status).toBe('active_subscriber');
  });
});

/* ── 6 & 7: missing rows change the stage, never the visibility ──────────── */

describe('missing related records', () => {
  it('does not hide an applicant who has no organization', async () => {
    const admin = await adminCookies();
    await register('noorg@new.test', 'No Org');

    const applicant = findByEmail(await fetchApplicants(admin), 'noorg@new.test')!;
    expect(applicant.organizationId).toBeNull();
    expect(applicant.organizationName).toBeNull();
    expect(applicant.stage).toBe('registered_no_package');
  });

  it('does not hide an applicant who has an organization but no subscription', async () => {
    const admin = await adminCookies();
    const { cookies } = await register('nosub@new.test', 'No Sub');
    await createOrganization(cookies, 'Orphan Trading LLC');

    const applicant = findByEmail(await fetchApplicants(admin), 'nosub@new.test')!;
    expect(applicant.organizationName).toBe('Orphan Trading LLC');
    expect(applicant.subscriptionId).toBeNull();
    expect(applicant.stage).toBe('registered_no_package');
  });

  it('reports registered_no_package even when the application record itself is gone', async () => {
    // The roster is based on `users`, so it survives the loss of the very
    // record it normally reads — the failure mode the old query could not.
    const admin = await adminCookies();
    const { userId } = await register('recordless@new.test', 'Record Less');
    await ctx.db.deleteFrom('subscription_applications').where('user_id', '=', userId).execute();

    const applicant = findByEmail(await fetchApplicants(admin), 'recordless@new.test')!;
    expect(applicant.applicationId).toBeNull();
    expect(applicant.stage).toBe('registered_no_package');
  });
});

/* ── 8: operators are staff, not prospects ───────────────────────────────── */

describe('platform operators', () => {
  it('never appear as applicants, in any role', async () => {
    const admin = await adminCookies('super_admin');
    await seedUser(ctx, { email: 'billing@ledgora.test', platformRoles: ['billing_admin'] });
    await seedUser(ctx, { email: 'support@ledgora.test', platformRoles: ['support'] });
    await register('realcustomer@new.test');

    const body = await fetchApplicants(admin, '?limit=100');
    const emails = body.applicants.map((a: { email: string }) => a.email);

    expect(emails).toContain('realcustomer@new.test');
    expect(emails).not.toContain('super_admin@ledgora.test');
    expect(emails).not.toContain('billing@ledgora.test');
    expect(emails).not.toContain('support@ledgora.test');
    expect(body.pagination.total).toBe(1);
  });

  it('are given no applicant record at registration', async () => {
    const operator = await seedUser(ctx, { email: 'op@ledgora.test', platformRoles: ['super_admin'] });
    const record = await ctx.db
      .selectFrom('subscription_applications')
      .select('id')
      .where('user_id', '=', operator.id)
      .executeTakeFirst();
    expect(record).toBeUndefined();
  });

  it('cannot be suspended as an applicant', async () => {
    const admin = await adminCookies();
    const operator = await seedUser(ctx, { email: 'other-op@ledgora.test', platformRoles: ['billing_admin'] });

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/applicants/${operator.id}/suspend`,
      headers: authHeaders(admin),
      payload: { reason: 'testing' },
    });
    expect(response.statusCode).toBe(400);
  });
});

/* ── 9: existing accounts are backfilled ─────────────────────────────────── */

describe('backfill', () => {
  it('creates records for registered users that have none, at the right stage', async () => {
    const admin = await adminCookies();

    // Two customers created the way the pre-fix code did: a `users` row only.
    const orphan = await seedUser(ctx, { email: 'legacy@old.test', fullName: 'Legacy Larry' });
    const { cookies } = await register('legacy-paid@old.test', 'Legacy Paula');
    await createOrganization(cookies, 'Legacy Industries');
    await confirm(cookies, await selectPlan(cookies));
    await ctx.db.deleteFrom('subscription_applications').execute();

    const { created } = await reconcileApplications(ctx.db);
    expect(created).toBe(2);

    const orphanRecord = await ctx.db
      .selectFrom('subscription_applications')
      .selectAll()
      .where('user_id', '=', orphan.id)
      .executeTakeFirstOrThrow();
    expect(orphanRecord.status).toBe('registered_no_package');
    expect(orphanRecord.source).toBe('backfill');

    // The stage is derived from the data that already existed.
    const paula = findByEmail(await fetchApplicants(admin, '?limit=100'), 'legacy-paid@old.test')!;
    expect(paula.stage).toBe('awaiting_payment');
    expect(paula.organizationName).toBe('Legacy Industries');
  });

  it('is idempotent and never touches platform operators', async () => {
    await adminCookies();
    await seedUser(ctx, { email: 'legacy2@old.test' });

    const first = await reconcileApplications(ctx.db);
    const second = await reconcileApplications(ctx.db);
    const third = await reconcileApplications(ctx.db);

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(third.created).toBe(0);

    const rows = await ctx.db.selectFrom('subscription_applications').selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  it('is exposed to a platform administrator as a repair endpoint', async () => {
    const admin = await adminCookies();
    await seedUser(ctx, { email: 'legacy3@old.test' });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/applicants/reconcile',
      headers: authHeaders(admin),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().created).toBe(1);
  });
});

/* ── 10: the roster is administrator-only ────────────────────────────────── */

describe('authorization', () => {
  it('refuses an unauthenticated caller', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/admin/applicants' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses an ordinary subscriber, even one with an active subscription', async () => {
    const admin = await adminCookies();
    const { cookies } = await register('customer@new.test');
    await createOrganization(cookies);
    const invoice = await confirm(cookies, await selectPlan(cookies));
    await uploadProof(cookies, invoice);
    const proof = await ctx.db.selectFrom('payment_proofs').select('id').executeTakeFirstOrThrow();
    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/payment-proofs/${proof.id}/approve`,
      headers: authHeaders(admin),
    });

    for (const url of ['/api/admin/applicants', '/api/admin/applicants/anything']) {
      const response = await ctx.app.inject({ method: 'GET', url, headers: authHeaders(cookies) });
      expect(response.statusCode).toBe(403);
    }
  });

  it('lets support read the roster but not act on it', async () => {
    const support = await adminCookies('support');
    const { userId } = await register('viewable@new.test');

    expect((await ctx.app.inject({ method: 'GET', url: '/api/admin/applicants', headers: authHeaders(support) })).statusCode).toBe(200);

    const suspend = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/applicants/${userId}/suspend`,
      headers: authHeaders(support),
      payload: { reason: 'not allowed' },
    });
    expect(suspend.statusCode).toBe(403);
  });

  it('never exposes password hashes or session material', async () => {
    const admin = await adminCookies();
    await register('secrets@new.test');

    const raw = (
      await ctx.app.inject({ method: 'GET', url: '/api/admin/applicants', headers: authHeaders(admin) })
    ).body;

    for (const marker of ['password', 'hash', 'token', 'normalized_email', 'argon2', 'session']) {
      expect(raw.toLowerCase()).not.toContain(marker);
    }
  });
});

/* ── 11: filtering, searching, sorting, pagination ───────────────────────── */

describe('roster query', () => {
  /** Three applicants at three different stages, plus one active subscriber. */
  async function seedFunnel(): Promise<SessionCookies> {
    const admin = await adminCookies();
    await register('anna@funnel.test', 'Anna Applicant');

    const bob = await register('bob@funnel.test', 'Bob Builder');
    await createOrganization(bob.cookies, 'Builder Bros');
    await selectPlan(bob.cookies);

    const cara = await register('cara@funnel.test', 'Cara Customer');
    await createOrganization(cara.cookies, 'Cara Consulting');
    const invoice = await confirm(cara.cookies, await selectPlan(cara.cookies, 1));
    await uploadProof(cara.cookies, invoice);

    return admin;
  }

  it('filters by stage', async () => {
    const admin = await seedFunnel();

    const noPackage = await fetchApplicants(admin, '?stage=registered_no_package');
    expect(noPackage.applicants.map((a: { email: string }) => a.email)).toEqual(['anna@funnel.test']);

    const selected = await fetchApplicants(admin, '?stage=package_selected');
    expect(selected.applicants.map((a: { email: string }) => a.email)).toEqual(['bob@funnel.test']);

    const verifying = await fetchApplicants(admin, '?stage=pending_verification');
    expect(verifying.applicants.map((a: { email: string }) => a.email)).toEqual(['cara@funnel.test']);
  });

  it('reports a count per stage for the tab badges', async () => {
    const admin = await seedFunnel();
    const body = await fetchApplicants(admin);

    expect(body.stageCounts.all).toBe(3);
    expect(body.stageCounts.registered_no_package).toBe(1);
    expect(body.stageCounts.package_selected).toBe(1);
    expect(body.stageCounts.pending_verification).toBe(1);
    expect(body.stageCounts.active_subscriber).toBe(0);
  });

  it('searches name, email and organization name', async () => {
    const admin = await seedFunnel();

    expect((await fetchApplicants(admin, '?search=Anna')).applicants).toHaveLength(1);
    expect((await fetchApplicants(admin, '?search=bob@funnel')).applicants).toHaveLength(1);
    expect((await fetchApplicants(admin, '?search=Consulting')).applicants[0]?.email).toBe('cara@funnel.test');
    expect((await fetchApplicants(admin, '?search=nobody-here')).applicants).toHaveLength(0);
  });

  it('treats a wildcard in the search term as a literal, not a pattern', async () => {
    const admin = await seedFunnel();
    // A bare `%` would otherwise match every applicant.
    expect((await fetchApplicants(admin, '?search=%25')).applicants).toHaveLength(0);
  });

  it('sorts by the requested field and direction', async () => {
    const admin = await seedFunnel();

    const ascending = await fetchApplicants(admin, '?sort=full_name&direction=asc');
    expect(ascending.applicants.map((a: { fullName: string }) => a.fullName)).toEqual([
      'Anna Applicant',
      'Bob Builder',
      'Cara Customer',
    ]);

    const descending = await fetchApplicants(admin, '?sort=full_name&direction=desc');
    expect(descending.applicants.map((a: { fullName: string }) => a.fullName)).toEqual([
      'Cara Customer',
      'Bob Builder',
      'Anna Applicant',
    ]);
  });

  it('paginates with a stable total', async () => {
    const admin = await seedFunnel();

    const first = await fetchApplicants(admin, '?limit=2&offset=0&sort=full_name&direction=asc');
    const second = await fetchApplicants(admin, '?limit=2&offset=2&sort=full_name&direction=asc');

    expect(first.applicants).toHaveLength(2);
    expect(second.applicants).toHaveLength(1);
    expect(first.pagination.total).toBe(3);
    expect(second.pagination.total).toBe(3);
    expect(first.applicants.map((a) => a.email)).not.toContain(second.applicants[0]?.email);
  });

  it('rejects a sort field that is not on the whitelist', async () => {
    const admin = await adminCookies();
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/applicants?sort=password_hash',
      headers: authHeaders(admin),
    });
    expect(response.statusCode).toBe(400);
  });
});

/* ── Dormancy: shown, never deleted ──────────────────────────────────────── */

describe('dormancy', () => {
  it('shows a long-quiet prospect as dormant without losing their stage', async () => {
    const admin = await adminCookies();
    const { userId } = await register('quiet@new.test', 'Quiet Quentin');

    const longAgo = new Date(Date.now() - 400 * 86_400_000);
    await ctx.db.updateTable('subscription_applications').set({ last_activity_at: longAgo }).where('user_id', '=', userId).execute();
    await ctx.db.updateTable('users').set({ created_at: longAgo, last_login_at: null }).where('id', '=', userId).execute();

    const dormant = await fetchApplicants(admin, '?stage=dormant_applicant');
    expect(dormant.applicants).toHaveLength(1);
    expect(dormant.applicants[0]?.dormant).toBe(true);
    // The stage they actually reached is still reported.
    expect(dormant.applicants[0]?.funnelStage).toBe('registered_no_package');

    // And the account still exists, untouched.
    expect(await ctx.db.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst()).toBeDefined();
  });

  it('lifts dormancy as soon as the customer signs in again', async () => {
    const admin = await adminCookies();
    const { userId } = await register('returning@new.test');

    const longAgo = new Date(Date.now() - 400 * 86_400_000);
    await ctx.db.updateTable('subscription_applications').set({ last_activity_at: longAgo }).where('user_id', '=', userId).execute();
    await ctx.db.updateTable('users').set({ created_at: longAgo, last_login_at: null }).where('id', '=', userId).execute();
    expect((await fetchApplicants(admin, '?stage=dormant_applicant')).applicants).toHaveLength(1);

    await login(ctx, 'returning@new.test');
    expect((await fetchApplicants(admin, '?stage=dormant_applicant')).applicants).toHaveLength(0);
  });

  it('never marks an active subscriber dormant', async () => {
    const admin = await adminCookies();
    const { cookies, userId } = await register('paid-quiet@new.test');
    await createOrganization(cookies);
    const invoice = await confirm(cookies, await selectPlan(cookies));
    await uploadProof(cookies, invoice);
    const proof = await ctx.db.selectFrom('payment_proofs').select('id').executeTakeFirstOrThrow();
    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/payment-proofs/${proof.id}/approve`,
      headers: authHeaders(admin),
    });

    const longAgo = new Date(Date.now() - 400 * 86_400_000);
    await ctx.db.updateTable('subscription_applications').set({ last_activity_at: longAgo }).where('user_id', '=', userId).execute();
    await ctx.db.updateTable('users').set({ created_at: longAgo, last_login_at: null }).where('id', '=', userId).execute();

    const applicant = findByEmail(await fetchApplicants(admin), 'paid-quiet@new.test')!;
    expect(applicant.stage).toBe('active_subscriber');
    expect(applicant.dormant).toBe(false);
  });
});

/* ── Administrator actions ───────────────────────────────────────────────── */

describe('administrator actions', () => {
  it('opens a single applicant by user id', async () => {
    const admin = await adminCookies();
    const { userId } = await register('detail@new.test', 'Detail Dana');

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/applicants/${userId}`,
      headers: authHeaders(admin),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().applicant).toMatchObject({
      userId,
      fullName: 'Detail Dana',
      stage: 'registered_no_package',
    });
  });

  it('records a package-selection reminder and says plainly that nothing was sent', async () => {
    const admin = await adminCookies();
    const { userId } = await register('remind@new.test');

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/applicants/${userId}/remind`,
      headers: authHeaders(admin),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().delivered).toBe(false);

    const audit = await ctx.db
      .selectFrom('audit_logs')
      .select('action')
      .where('action', '=', 'applicant.reminder_requested')
      .execute();
    expect(audit).toHaveLength(1);
  });

  it('suspends and restores an applicant without deleting the account', async () => {
    const admin = await adminCookies();
    const { userId } = await register('suspendme@new.test');

    const suspend = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/applicants/${userId}/suspend`,
      headers: authHeaders(admin),
      payload: { reason: 'Fraud review' },
    });
    expect(suspend.statusCode).toBe(200);
    expect(suspend.json().applicant.stage).toBe('suspended');

    const restore = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/applicants/${userId}/restore`,
      headers: authHeaders(admin),
      payload: { reason: 'Cleared' },
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json().applicant.stage).toBe('registered_no_package');

    expect(await ctx.db.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst()).toBeDefined();
  });

  it('requires a reason, which is written to the audit trail', async () => {
    const admin = await adminCookies();
    const { userId } = await register('reasoned@new.test');

    const missing = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/applicants/${userId}/archive`,
      headers: authHeaders(admin),
      payload: {},
    });
    expect(missing.statusCode).toBe(400);

    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/applicants/${userId}/archive`,
      headers: authHeaders(admin),
      payload: { reason: 'Duplicate sign-up' },
    });
    const entry = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'applicant.archived')
      .executeTakeFirstOrThrow();
    expect(entry.target_id).toBe(userId);
  });
});

/* ── 12: the existing subscriber surface is unchanged ────────────────────── */

describe('existing subscription surface', () => {
  it('still lists active subscriptions exactly as before', async () => {
    const admin = await adminCookies();
    const { cookies } = await register('unchanged@new.test');
    await createOrganization(cookies, 'Unchanged Ltd');
    const invoice = await confirm(cookies, await selectPlan(cookies));
    await uploadProof(cookies, invoice);
    const proof = await ctx.db.selectFrom('payment_proofs').select('id').executeTakeFirstOrThrow();
    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/payment-proofs/${proof.id}/approve`,
      headers: authHeaders(admin),
    });

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/subscriptions?status=active',
      headers: authHeaders(admin),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().subscriptions).toHaveLength(1);
    expect(response.json().subscriptions[0]).toMatchObject({
      status: 'active',
      organizationName: 'Unchanged Ltd',
      planCode: 'core',
    });
  });

  it('keeps the customer subscription view working end to end', async () => {
    const { cookies } = await register('customer-view@new.test');
    await createOrganization(cookies);
    await confirm(cookies, await selectPlan(cookies));

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/subscriptions/current',
      headers: authHeaders(cookies),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().subscription.status).toBe('pending_payment');
    expect(response.json().invoice.status).toBe('issued');
  });

  it('keeps a manual activation in step with the applicant roster', async () => {
    const admin = await adminCookies();
    const { cookies } = await register('manual@new.test');
    await createOrganization(cookies);
    const subscriptionId = await selectPlan(cookies);

    const activate = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscriptions/${subscriptionId}/activate`,
      headers: authHeaders(admin),
      payload: { reason: 'Paid by wire outside the portal' },
    });
    expect(activate.statusCode).toBe(200);

    const applicant = findByEmail(await fetchApplicants(admin), 'manual@new.test')!;
    expect(applicant.stage).toBe('active_subscriber');
  });
});

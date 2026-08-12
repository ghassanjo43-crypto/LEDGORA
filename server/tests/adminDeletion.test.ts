/**
 * Removal, archival and permanent deletion.
 *
 * ══ The claim this suite exists to protect ════════════════════════════════════
 *
 * Ledgora's accounting data lives in the customer's BROWSER, not in this database.
 * So no count in this service can prove "there is no ledger" — and the eligibility
 * rule is built instead on an invariant the server can verify: durable business
 * writes require an ACTIVE subscription (`guards/persistence`), therefore a tenant
 * that was never activated cannot hold accounting records.
 *
 * The tests below pin both halves of that:
 *   · a tenant that was ever activated can NEVER be purged, only archived — even
 *     when every server-side table happens to be empty;
 *   · a genuinely never-activated tenant can be purged, and doing so leaves no
 *     orphan rows and no audit gaps.
 *
 * Plus the ordinary safeguards: last owner, last super administrator, self-
 * deletion, pending review, session revocation, idempotence, and the fact that a
 * client cannot talk its way past any of them.
 */
import { sql } from 'kysely';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  authHeaders,
  createTestContext,
  login,
  seedUser,
  TEST_PASSWORD,
  type SessionCookies,
  type TestContext,
} from './helpers/testApp.js';
import { assessSubscriberDeletion } from '../src/services/deletionService.js';

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

async function operator(
  role: 'super_admin' | 'billing_admin' | 'support' = 'super_admin',
  email = `${role}@ledgora.test`,
): Promise<{ cookies: SessionCookies; userId: string }> {
  const user = await seedUser(ctx, { email, fullName: `Operator ${role}`, platformRoles: [role] });
  return { cookies: await login(ctx, email), userId: user.id };
}

async function plan(code: 'core' | 'enterprise' = 'core'): Promise<string> {
  const plans = (await ctx.app.inject({ method: 'GET', url: '/api/plans/public' })).json().plans;
  const found = plans.find((p: { code: string }) => p.code === code);
  return found.id;
}

/**
 * Create a subscriber. `activate: false` leaves it never-activated — the only
 * state in which a purge is permitted.
 */
async function createSubscriber(
  admin: SessionCookies,
  options: { email?: string; legalName?: string; activate?: boolean ; classification?: 'production' | 'test' | 'demo' } = {},
): Promise<{ organizationId: string; userId: string; email: string; legalName: string }> {
  const email = options.email ?? `owner${Math.random().toString(36).slice(2, 9)}@newco.test`;
  const legalName = options.legalName ?? 'NewCo Trading LLC';
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/subscribers',
    headers: authHeaders(admin),
    payload: {
      fullName: 'Owner Person',
      email,
      organizationLegalName: legalName,
      country: 'AE',
      baseCurrency: 'AED',
      planId: await plan(),
      onboarding: 'invite',
      // Confirming payment is what activates — and what makes a purge impossible
      // for a PRODUCTION tenant.
      paymentConfirmed: options.activate ?? false,
      subscriptionStatus: (options.activate ?? false) ? 'active' : 'draft',
      /*
       * This suite exercises deletion MECHANICS, and only test/demo data may be
       * permanently deleted — so the fixture is `test` by default. The retention
       * tests below pass `production` explicitly, which is the whole point of
       * the distinction.
       */
      dataClassification: options.classification ?? 'test',
    },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return { organizationId: body.subscriber.organizationId, userId: body.subscriber.userId, email, legalName };
}

async function invite(
  admin: SessionCookies,
  organizationId: string,
  email: string,
  role: 'accountant' | 'member' | 'viewer' = 'member',
): Promise<string> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/admin/organizations/${organizationId}/members/invite`,
    headers: authHeaders(admin),
    payload: { email, fullName: 'Invited Person', role },
  });
  expect(response.statusCode).toBe(201);
  return response.json().member.userId;
}

/** Register a self-service customer through the real route. */
async function register(email: string, fullName = 'Self Signup'): Promise<{ cookies: SessionCookies; userId: string }> {
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

async function impact(admin: SessionCookies, organizationId: string) {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/admin/subscribers/${organizationId}/deletion-impact`,
    headers: authHeaders(admin),
  });
  expect(response.statusCode).toBe(200);
  return response.json().impact;
}

/**
 * Classify an onboarding-created organization as test data.
 *
 * A customer creating their own organization gets `production` — the safe
 * default — so a test exercising DELETION mechanics on such a shell has to say
 * explicitly that it is disposable. That is the classification model working:
 * eligibility is never inferred from the fact that a row looks like a fixture.
 */
async function classifyAsTest(organizationId: string): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    // The same transaction-scoped escape hatch the development bootstrap uses.
    // A plain UPDATE is refused by the database trigger, which is the point.
    await sql`SET LOCAL ledgora.legacy_classification = 'on'`.execute(trx);
    await trx
      .updateTable('organizations')
      .set({ data_classification: 'test' })
      .where('id', '=', organizationId)
      .execute();
  });
}

/** Every foreign key that could dangle after a purge. */
async function findOrphans(): Promise<Record<string, number>> {
  const organizationIds = new Set((await ctx.db.selectFrom('organizations').select('id').execute()).map((r) => r.id));
  const userIds = new Set((await ctx.db.selectFrom('users').select('id').execute()).map((r) => r.id));
  const invoiceIds = new Set(
    (await ctx.db.selectFrom('subscription_invoices').select('id').execute()).map((r) => r.id),
  );
  const subscriptionIds = new Set((await ctx.db.selectFrom('subscriptions').select('id').execute()).map((r) => r.id));

  const orphans: Record<string, number> = {};
  const memberships = await ctx.db.selectFrom('organization_memberships').selectAll().execute();
  orphans.memberships = memberships.filter(
    (m) => !organizationIds.has(m.organization_id) || !userIds.has(m.user_id),
  ).length;

  const subscriptions = await ctx.db.selectFrom('subscriptions').selectAll().execute();
  orphans.subscriptions = subscriptions.filter((s) => !organizationIds.has(s.organization_id)).length;

  const invoices = await ctx.db.selectFrom('subscription_invoices').selectAll().execute();
  orphans.invoices = invoices.filter(
    (i) => !organizationIds.has(i.organization_id) || !subscriptionIds.has(i.subscription_id),
  ).length;

  const proofs = await ctx.db.selectFrom('payment_proofs').selectAll().execute();
  orphans.proofs = proofs.filter((p) => !invoiceIds.has(p.invoice_id) || !userIds.has(p.uploaded_by_user_id)).length;

  const entitlements = await ctx.db.selectFrom('organization_entitlements').selectAll().execute();
  orphans.entitlements = entitlements.filter((e) => !organizationIds.has(e.organization_id)).length;

  const changes = await ctx.db.selectFrom('subscription_package_changes').selectAll().execute();
  orphans.packageChanges = changes.filter((c) => !organizationIds.has(c.organization_id)).length;

  const applications = await ctx.db.selectFrom('subscription_applications').selectAll().execute();
  orphans.applications = applications.filter(
    (a) => !userIds.has(a.user_id) || (a.organization_id !== null && !organizationIds.has(a.organization_id)),
  ).length;

  const sessions = await ctx.db.selectFrom('auth_sessions').selectAll().execute();
  orphans.sessions = sessions.filter((s) => !userIds.has(s.user_id)).length;

  const tokens = await ctx.db.selectFrom('password_reset_tokens').selectAll().execute();
  orphans.tokens = tokens.filter((t) => !userIds.has(t.user_id)).length;

  // An audit actor that no longer resolves is the failure this design exists to
  // avoid: "who did this?" must never become unanswerable.
  const audits = await ctx.db.selectFrom('audit_logs').selectAll().execute();
  orphans.auditActors = audits.filter((a) => a.actor_user_id !== null && !userIds.has(a.actor_user_id)).length;

  return orphans;
}

/* ══ 1–5: remove member ════════════════════════════════════════════════════ */

describe('removing a member from an organization', () => {
  it('removes the membership and leaves the account and its history intact', async () => {
    const admin = await operator();
    const { organizationId } = await createSubscriber(admin.cookies);
    const memberId = await invite(admin.cookies, organizationId, 'colleague@newco.test', 'accountant');

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${memberId}/remove`,
      headers: authHeaders(admin.cookies),
      payload: { organizationId, reason: 'Left the company.' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ removed: true, accountRetained: true });

    // The membership is gone…
    expect(
      await ctx.db
        .selectFrom('organization_memberships')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('user_id', '=', memberId)
        .executeTakeFirst(),
    ).toBeUndefined();
    // …and the user account is not.
    const user = await ctx.db.selectFrom('users').selectAll().where('id', '=', memberId).executeTakeFirstOrThrow();
    expect(user.status).toBe('active');
    expect(user.deleted_at).toBeNull();
    expect(user.anonymized_at).toBeNull();
    // Nothing was anonymised, so attribution still names them.
    expect(user.full_name).toBe('Invited Person');
    expect(user.email).toBe('colleague@newco.test');
  });

  it('stops the removed member reaching the organization', async () => {
    const admin = await operator();
    const { organizationId } = await createSubscriber(admin.cookies);
    const memberId = await invite(admin.cookies, organizationId, 'gone@newco.test');

    // Give them a working password and a live session.
    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${memberId}/reset-password`,
      headers: authHeaders(admin.cookies),
      payload: { mode: 'temporary', reason: 'Set up for the test.' },
    });
    const temporary = reset.json().credential.temporaryPassword;
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'gone@newco.test', password: temporary },
    });
    const raw = first.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : [String(raw)];
    const find = (name: string): string => {
      const match = list.find((c) => c.startsWith(`${name}=`));
      return match ? (match.split(';')[0]?.split('=').slice(1).join('=') ?? '') : '';
    };
    const memberCookies = { session: find('ledgora_session'), csrf: find('ledgora_csrf') };
    await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: authHeaders(memberCookies),
      payload: { currentPassword: temporary, newPassword: 'Bright-Harbour-58-Zq' },
    });
    const live = await login(ctx, 'gone@newco.test', 'Bright-Harbour-58-Zq');
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/organizations/current/members', headers: authHeaders(live) }))
        .json().members.length,
    ).toBeGreaterThan(0);

    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${memberId}/remove`,
      headers: authHeaders(admin.cookies),
      payload: { organizationId, reason: 'Removed.' },
    });

    // The session was revoked as part of removal.
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/auth/session', headers: authHeaders(live) })).json()
        .authenticated,
    ).toBe(false);

    // And signing in again yields no organization at all.
    const after = await login(ctx, 'gone@newco.test', 'Bright-Harbour-58-Zq');
    const roster = await ctx.app.inject({
      method: 'GET',
      url: '/api/organizations/current/members',
      headers: authHeaders(after),
    });
    expect(roster.json().organizationId).toBeNull();
    expect(roster.json().members).toEqual([]);
  });

  it('keeps every audit entry that names the removed member', async () => {
    const admin = await operator();
    const { organizationId } = await createSubscriber(admin.cookies);
    const memberId = await invite(admin.cookies, organizationId, 'attributed@newco.test');

    const before = await ctx.db
      .selectFrom('audit_logs')
      .select('id')
      .where((eb) => eb.or([eb('actor_user_id', '=', memberId), eb('target_id', '=', memberId)]))
      .execute();
    expect(before.length).toBeGreaterThan(0);

    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${memberId}/remove`,
      headers: authHeaders(admin.cookies),
      payload: { organizationId, reason: 'Attribution check.' },
    });

    const after = await ctx.db
      .selectFrom('audit_logs')
      .select('id')
      .where((eb) => eb.or([eb('actor_user_id', '=', memberId), eb('target_id', '=', memberId)]))
      .execute();
    // Strictly MORE: the removal itself is audited on top of the earlier entries.
    expect(after.length).toBeGreaterThan(before.length);
  });

  it('does not delete an account that belongs to another organization', async () => {
    const admin = await operator();
    const first = await createSubscriber(admin.cookies, { email: 'a@one.test', legalName: 'One Ltd' });
    const second = await createSubscriber(admin.cookies, { email: 'b@two.test', legalName: 'Two Ltd' });

    const shared = await invite(admin.cookies, first.organizationId, 'shared@both.test');
    await ctx.db
      .insertInto('organization_memberships')
      .values({ organization_id: second.organizationId, user_id: shared, role: 'member', status: 'active' })
      .execute();

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${shared}/remove`,
      headers: authHeaders(admin.cookies),
      payload: { organizationId: first.organizationId, reason: 'Moved teams.' },
    });
    expect(response.json()).toMatchObject({ removed: true, hasOtherMemberships: true, followUp: 'none' });

    // Still an account, still a member of the second organization.
    expect(await ctx.db.selectFrom('users').select('id').where('id', '=', shared).executeTakeFirst()).toBeDefined();
    const remaining = await ctx.db
      .selectFrom('organization_memberships')
      .selectAll()
      .where('user_id', '=', shared)
      .execute();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.organization_id).toBe(second.organizationId);
  });

  it('refuses to remove the last active owner', async () => {
    const admin = await operator();
    const { organizationId, userId } = await createSubscriber(admin.cookies);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${userId}/remove`,
      headers: authHeaders(admin.cookies),
      payload: { organizationId, reason: 'Should be refused.' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/last active owner/i);

    // Untouched.
    const membership = await ctx.db
      .selectFrom('organization_memberships')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(membership.role).toBe('owner');
  });

  it('is idempotent when the member is already gone', async () => {
    const admin = await operator();
    const { organizationId } = await createSubscriber(admin.cookies);
    const memberId = await invite(admin.cookies, organizationId, 'twice@newco.test');
    const payload = { organizationId, reason: 'Removed once.' };

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${memberId}/remove`,
      headers: authHeaders(admin.cookies),
      payload,
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${memberId}/remove`,
      headers: authHeaders(admin.cookies),
      payload,
    });

    expect(first.json().removed).toBe(true);
    expect(second.statusCode).toBe(200);
    expect(second.json().removed).toBe(false);
  });

  it('offers disable-or-delete when it was the account’s last membership', async () => {
    const admin = await operator();
    const { organizationId } = await createSubscriber(admin.cookies);
    const memberId = await invite(admin.cookies, organizationId, 'orphaned@newco.test');

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${memberId}/remove`,
      headers: authHeaders(admin.cookies),
      payload: { organizationId, reason: 'Last membership.' },
    });
    expect(response.json()).toMatchObject({ hasOtherMemberships: false, followUp: 'disable_or_delete' });
  });
});

/* ══ 6 & 7: applicant deletion ═════════════════════════════════════════════ */

describe('deleting an unused applicant', () => {
  it('permanently deletes an account that has nothing attached', async () => {
    const admin = await operator();
    const applicant = await register('unused@prospect.test', 'Unused Prospect');

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/applicants/${applicant.userId}`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Test account cleanup.', expectedEmail: 'unused@prospect.test' },
    });
    expect(response.statusCode).toBe(200);

    const outcome = response.json();
    // Registration writes an audit entry naming them, so the honest outcome is
    // anonymisation: the id must survive for the trail to keep resolving.
    expect(['deleted', 'anonymized']).toContain(outcome.outcome);

    if (outcome.outcome === 'anonymized') {
      const user = await ctx.db
        .selectFrom('users')
        .selectAll()
        .where('id', '=', applicant.userId)
        .executeTakeFirstOrThrow();
      expect(user.full_name).toBe('Former user');
      expect(user.email).not.toBe('unused@prospect.test');
      expect(user.email).toContain('@anonymized.invalid');
      expect(user.anonymized_at).not.toBeNull();
      expect(user.status).toBe('disabled');
    } else {
      expect(
        await ctx.db.selectFrom('users').select('id').where('id', '=', applicant.userId).executeTakeFirst(),
      ).toBeUndefined();
    }

    // Onboarding artefacts are gone either way.
    expect(
      await ctx.db.selectFrom('subscription_applications').select('id').where('user_id', '=', applicant.userId).execute(),
    ).toHaveLength(0);
    expect(
      await ctx.db.selectFrom('auth_sessions').select('id').where('user_id', '=', applicant.userId).execute(),
    ).toHaveLength(0);
    // The account can no longer sign in.
    const attempt = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'unused@prospect.test', password: TEST_PASSWORD },
    });
    expect(attempt.statusCode).toBe(401);
    expect(await findOrphans()).toMatchObject({ auditActors: 0, sessions: 0, applications: 0 });
  });

  it('deletes the empty organization shell an applicant created', async () => {
    const admin = await operator();
    const applicant = await register('withshell@prospect.test');
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: authHeaders(applicant.cookies),
      payload: { legalName: 'Empty Shell Ltd', country: 'AE' },
    });
    expect(created.statusCode).toBe(201);
    const organizationId = created.json().organizationId;
    await classifyAsTest(organizationId);

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/applicants/${applicant.userId}`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Abandoned sign-up.' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().purgedOrganizations).toHaveLength(1);

    expect(
      await ctx.db.selectFrom('organizations').select('id').where('id', '=', organizationId).executeTakeFirst(),
    ).toBeUndefined();
    expect(await findOrphans()).toMatchObject({ memberships: 0, subscriptions: 0, entitlements: 0, auditActors: 0 });
  });

  it('refuses when the applicant has protected records', async () => {
    const admin = await operator();
    // An ACTIVATED subscriber: accounting records may exist in their workspace.
    const activated = await createSubscriber(admin.cookies, {
      email: 'paid@prospect.test',
      activate: true,
      // PRODUCTION: this blocker is waived for test/demo by design.
      classification: 'production',
    });

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/applicants/${activated.userId}`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Should be refused.' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/cannot be permanently deleted|Archive the subscriber instead/i);

    // Nothing was touched.
    expect(
      await ctx.db.selectFrom('users').select('id').where('id', '=', activated.userId).executeTakeFirst(),
    ).toBeDefined();
    expect(
      await ctx.db.selectFrom('organizations').select('id').where('id', '=', activated.organizationId).executeTakeFirst(),
    ).toBeDefined();
  });

  it('refuses to delete a platform operator as an applicant', async () => {
    const admin = await operator();
    const staff = await seedUser(ctx, { email: 'staff@ledgora.test', platformRoles: ['support'] });

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/applicants/${staff.id}`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Should be refused.' },
    });
    expect(response.statusCode).toBe(400);
    expect(await ctx.db.selectFrom('users').select('id').where('id', '=', staff.id).executeTakeFirst()).toBeDefined();
  });

  it('checks the typed email confirmation server-side', async () => {
    const admin = await operator();
    const applicant = await register('typed@prospect.test');

    const wrong = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/applicants/${applicant.userId}`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Cleanup.', expectedEmail: 'not-their-address@prospect.test' },
    });
    expect(wrong.statusCode).toBe(400);
    expect(
      await ctx.db.selectFrom('users').select('id').where('id', '=', applicant.userId).executeTakeFirst(),
    ).toBeDefined();
  });
});

/* ══ 8–11: archive and restore ═════════════════════════════════════════════ */

describe('archiving a subscriber', () => {
  it('archives an active subscriber, retaining every record', async () => {
    const admin = await operator();
    const { organizationId } = await createSubscriber(admin.cookies, { activate: true });
    const invoicesBefore = await ctx.db
      .selectFrom('subscription_invoices')
      .select('id')
      .where('organization_id', '=', organizationId)
      .execute();

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/archive`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Customer left.' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ organizationStatus: 'archived', entitlementActive: false });

    const organization = await ctx.db
      .selectFrom('organizations')
      .selectAll()
      .where('id', '=', organizationId)
      .executeTakeFirstOrThrow();
    expect(organization.status).toBe('archived');
    expect(organization.archived_at).not.toBeNull();
    expect(organization.archived_by).toBe(admin.userId);
    expect(organization.archive_reason).toBe('Customer left.');

    // Retained: subscription record, invoices, memberships, package history.
    expect(
      await ctx.db.selectFrom('subscriptions').select('id').where('organization_id', '=', organizationId).execute(),
    ).not.toHaveLength(0);
    expect(
      await ctx.db
        .selectFrom('subscription_invoices')
        .select('id')
        .where('organization_id', '=', organizationId)
        .execute(),
    ).toHaveLength(invoicesBefore.length);
    expect(
      await ctx.db
        .selectFrom('organization_memberships')
        .select('id')
        .where('organization_id', '=', organizationId)
        .execute(),
    ).not.toHaveLength(0);
    expect(
      await ctx.db
        .selectFrom('subscription_package_changes')
        .select('id')
        .where('organization_id', '=', organizationId)
        .execute(),
    ).not.toHaveLength(0);
  });

  it('revokes member sessions so nobody keeps access to an archived tenant', async () => {
    const admin = await operator();
    const { organizationId, userId } = await createSubscriber(admin.cookies, { activate: true });

    // Give the owner a live session.
    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${userId}/reset-password`,
      headers: authHeaders(admin.cookies),
      payload: { mode: 'temporary', reason: 'Set up for the test.' },
    });
    const temporary = reset.json().credential.temporaryPassword;
    const owner = await ctx.db.selectFrom('users').select('email').where('id', '=', userId).executeTakeFirstOrThrow();
    const signIn = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: owner.email, password: temporary },
    });
    expect(signIn.statusCode).toBe(200);

    const before = await ctx.db
      .selectFrom('auth_sessions')
      .select('id')
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
    expect(before.length).toBeGreaterThan(0);

    const archive = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/archive`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Access must stop.' },
    });
    expect(archive.json().revokedSessions).toBeGreaterThan(0);

    expect(
      await ctx.db
        .selectFrom('auth_sessions')
        .select('id')
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .execute(),
    ).toHaveLength(0);
  });

  it('keeps an archived subscriber readable by an authorised administrator', async () => {
    const admin = await operator();
    const { organizationId, legalName } = await createSubscriber(admin.cookies, {
      legalName: 'Archived Holdings Ltd',
      activate: true,
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/archive`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Retired.' },
    });

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/subscribers/${organizationId}`,
      headers: authHeaders(admin.cookies),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().subscriber.legalName).toBe(legalName);
    expect(detail.json().subscriber.organizationStatus).toBe('archived');
    expect(detail.json().members.length).toBeGreaterThan(0);
    expect(detail.json().packageHistory.length).toBeGreaterThan(0);
  });

  it('hides archived subscribers from the active list and shows them under the archived filter', async () => {
    const admin = await operator();
    await createSubscriber(admin.cookies, { email: 'live@newco.test', legalName: 'Live Ltd', activate: true });
    const retired = await createSubscriber(admin.cookies, {
      email: 'retired@newco.test',
      legalName: 'Retired Ltd',
      activate: true,
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${retired.organizationId}/archive`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Retired.' },
    });

    const active = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/subscribers?status=active',
      headers: authHeaders(admin.cookies),
    });
    const activeNames = active.json().subscribers.map((s: { legalName: string }) => s.legalName);
    expect(activeNames).toContain('Live Ltd');
    expect(activeNames).not.toContain('Retired Ltd');

    const archived = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/subscribers?status=archived',
      headers: authHeaders(admin.cookies),
    });
    expect(archived.json().subscribers.map((s: { legalName: string }) => s.legalName)).toEqual(['Retired Ltd']);
  });

  it('restores an archived subscriber without inventing an entitlement', async () => {
    const admin = await operator();
    const paid = await createSubscriber(admin.cookies, { email: 'paidback@newco.test', activate: true });
    const unpaid = await createSubscriber(admin.cookies, { email: 'unpaidback@newco.test', activate: false });

    for (const organizationId of [paid.organizationId, unpaid.organizationId]) {
      await ctx.app.inject({
        method: 'POST',
        url: `/api/admin/subscribers/${organizationId}/archive`,
        headers: authHeaders(admin.cookies),
        payload: { reason: 'Temporary.' },
      });
    }

    const restorePaid = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${paid.organizationId}/restore`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Came back.' },
    });
    expect(restorePaid.statusCode).toBe(200);
    // It had genuinely started, so it returns to active.
    expect(restorePaid.json()).toMatchObject({ organizationStatus: 'active', subscriptionStatus: 'active' });
    expect(restorePaid.json().entitlementActive).toBe(true);

    const restoreUnpaid = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${unpaid.organizationId}/restore`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Came back.' },
    });
    // It never paid, so no entitlement is conjured out of the restore.
    expect(restoreUnpaid.json().subscriptionStatus).toBe('pending_payment');
    expect(restoreUnpaid.json().entitlementActive).toBe(false);
  });

  it('is idempotent, and refuses while a payment review is pending', async () => {
    const admin = await operator();
    const { organizationId } = await createSubscriber(admin.cookies, { activate: true });
    const payload = { reason: 'Archive twice.' };

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/archive`,
      headers: authHeaders(admin.cookies),
      payload,
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/archive`,
      headers: authHeaders(admin.cookies),
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // The archive timestamp is not moved by the repeat.
    expect(second.json().archivedAt).toBe(first.json().archivedAt);

    /* A subscriber with a proof awaiting review must not be archived. */
    const pending = await register('pendingproof@newco.test');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: authHeaders(pending.cookies),
      payload: { legalName: 'Pending Proof Ltd', country: 'AE' },
    });
    const selected = await ctx.app.inject({
      method: 'POST',
      url: '/api/subscriptions',
      headers: authHeaders(pending.cookies),
      payload: { planId: await plan() },
    });
    const confirmed = await ctx.app.inject({
      method: 'POST',
      url: `/api/subscriptions/${selected.json().subscriptionId}/confirm`,
      headers: authHeaders(pending.cookies),
    });
    const invoice = confirmed.json();

    const boundary = '----deletion';
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
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="r.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      PNG,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    );
    await ctx.app.inject({
      method: 'POST',
      url: `/api/invoices/${invoice.invoiceId}/payment-proof`,
      headers: { ...authHeaders(pending.cookies), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat(parts),
    });

    const organization = await ctx.db
      .selectFrom('organizations')
      .select('id')
      .where('legal_name', '=', 'Pending Proof Ltd')
      .executeTakeFirstOrThrow();
    const blocked = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organization.id}/archive`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Should be refused.' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toMatch(/awaiting review/i);
  });
});

/* ══ 12–15: permanent purge ════════════════════════════════════════════════ */

describe('permanently deleting a subscriber', () => {
  it('refuses a subscriber that was ever activated, even with empty billing tables', async () => {
    const admin = await operator();
    // PRODUCTION: the accounting-records rule protects real data, and is
    // deliberately waived for test/demo (see the classification suite).
    const { organizationId, legalName } = await createSubscriber(admin.cookies, {
      activate: true,
      classification: 'production',
    });

    // Strip every server-side record a naive count would look at, so the ONLY
    // thing left blocking the purge is "this tenant was once activated".
    await ctx.db.deleteFrom('payment_proofs').execute();
    await ctx.db.deleteFrom('subscription_invoices').where('organization_id', '=', organizationId).execute();

    const report = await impact(admin.cookies, organizationId);
    expect(report.deletionPermitted).toBe(false);
    expect(report.blockingReasons.map((b: { code: string }) => b.code)).toContain('accounting_records_possible');
    expect(report.recommendation).toBe(
      'This subscriber contains accounting or legally retained records and cannot be permanently deleted. Archive the subscriber instead.',
    );

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/subscribers/${organizationId}`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Should be refused.', confirmationName: legalName },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/Archive the subscriber instead/);

    // Still there, untouched.
    expect(
      await ctx.db.selectFrom('organizations').select('id').where('id', '=', organizationId).executeTakeFirst(),
    ).toBeDefined();
    // And the refusal itself is on the record.
    expect(
      await ctx.db.selectFrom('audit_logs').select('id').where('action', '=', 'subscriber.purge_blocked').execute(),
    ).not.toHaveLength(0);
  });

  /**
   * The refusal audit and the rollback are the same event.
   *
   * A blocked purge rolls its transaction back, so anything written on that
   * transaction is undone with it. This asserts the entry survives ANYWAY, that
   * it carries what an auditor needs, and that nothing was deleted on the way.
   */
  it('records the refusal outside the rolled-back transaction, with full attribution', async () => {
    const admin = await operator();
    const { organizationId, legalName } = await createSubscriber(admin.cookies, {
      activate: true,
      classification: 'production',
    });

    const before = await ctx.db.selectFrom('organizations').selectAll().execute();

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/subscribers/${organizationId}`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Customer asked, but the books are retained.', confirmationName: legalName },
    });
    expect(response.statusCode).toBe(409);

    const entries = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'subscriber.purge_blocked')
      .where('target_id', '=', organizationId)
      .execute();
    // Exactly one entry per attempt — not zero (rolled back) and not two
    // (written both inside and outside).
    expect(entries).toHaveLength(1);

    const entry = entries[0]!;
    expect(entry.actor_user_id).toBe(admin.userId);
    expect(entry.target_type).toBe('organization');
    expect(entry.organization_id).toBe(organizationId);
    expect(entry.created_at).toBeTruthy();

    const metadata = typeof entry.metadata === 'string' ? JSON.parse(entry.metadata) : entry.metadata;
    expect(metadata.reason).toBe('Customer asked, but the books are retained.');
    expect(metadata.blockedBy).toContain('accounting_records_possible');
    expect(metadata.legalName).toBe(legalName);
    // Correlation id, so the entry ties back to the request in the server log.
    expect(typeof metadata.requestId).toBe('string');
    // No secret ever reaches an audit row.
    expect(JSON.stringify(entry)).not.toMatch(/password|token_hash|secret/i);

    // Nothing was partially deleted by the attempt.
    expect(await ctx.db.selectFrom('organizations').selectAll().execute()).toEqual(before);
    expect(await findOrphans()).toEqual({
      memberships: 0,
      subscriptions: 0,
      invoices: 0,
      proofs: 0,
      applications: 0,
      entitlements: 0,
      packageChanges: 0,
      sessions: 0,
      tokens: 0,
      auditActors: 0,
    });
  });

  /** A second attempt is a separate act, and gets its own entry. */
  it('records one refusal per attempt, distinguishable by correlation id', async () => {
    const admin = await operator();
    const { organizationId, legalName } = await createSubscriber(admin.cookies, {
      activate: true,
      classification: 'production',
    });

    const attempt = () =>
      ctx.app.inject({
        method: 'DELETE',
        url: `/api/admin/subscribers/${organizationId}`,
        headers: authHeaders(admin.cookies),
        payload: { reason: 'Retried.', confirmationName: legalName },
      });

    expect((await attempt()).statusCode).toBe(409);
    expect((await attempt()).statusCode).toBe(409);

    const entries = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'subscriber.purge_blocked')
      .where('target_id', '=', organizationId)
      .execute();
    expect(entries).toHaveLength(2);

    const requestIds = entries.map((e) => {
      const metadata = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata;
      return metadata.requestId;
    });
    expect(new Set(requestIds).size).toBe(2);
  });

  it('reports browser-resident categories as unverifiable, never as zero', async () => {
    const admin = await operator();
    const { organizationId } = await createSubscriber(admin.cookies);
    const report = await impact(admin.cookies, organizationId);

    const byKey = Object.fromEntries(
      report.counts.map((c: { key: string; count: number | null; serverVerifiable: boolean }) => [c.key, c]),
    );
    // These live in the customer workspace. Claiming 0 would be a lie that could
    // authorise deleting a tenant with a full ledger.
    for (const key of ['journal_entries', 'business_documents', 'locked_periods']) {
      expect(byKey[key].serverVerifiable).toBe(false);
      expect(byKey[key].count).toBeNull();
    }
    // What the server genuinely knows is reported as a number.
    expect(byKey.members.serverVerifiable).toBe(true);
    expect(typeof byKey.members.count).toBe('number');
  });

  it('purges an eligible never-activated subscriber, leaving no orphans', async () => {
    const admin = await operator();
    const { organizationId, legalName, userId } = await createSubscriber(admin.cookies, {
      email: 'purgeable@test.test',
      legalName: 'Purgeable Test Ltd',
    });

    const report = await impact(admin.cookies, organizationId);
    expect(report.deletionPermitted).toBe(true);
    expect(report.blockingReasons).toEqual([]);
    expect(report.willBePermanentlyDeleted.length).toBeGreaterThan(0);

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/subscribers/${organizationId}`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Test tenant cleanup.', confirmationName: legalName },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().purged).toBe(true);

    // Gone.
    for (const check of [
      ctx.db.selectFrom('organizations').select('id').where('id', '=', organizationId).executeTakeFirst(),
      ctx.db
        .selectFrom('organization_memberships')
        .select('id')
        .where('organization_id', '=', organizationId)
        .executeTakeFirst(),
      ctx.db.selectFrom('subscriptions').select('id').where('organization_id', '=', organizationId).executeTakeFirst(),
      ctx.db
        .selectFrom('organization_entitlements')
        .select('id')
        .where('organization_id', '=', organizationId)
        .executeTakeFirst(),
    ]) {
      expect(await check).toBeUndefined();
    }

    // The owner belonged nowhere else, so their account went too — or was
    // anonymised, if audit named them. Either way they cannot sign in.
    const owner = await ctx.db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirst();
    if (owner) {
      expect(owner.anonymized_at).not.toBeNull();
      expect(owner.full_name).toBe('Former user');
      expect(owner.status).toBe('disabled');
    }

    // No dangling references anywhere — including audit actors.
    expect(await findOrphans()).toEqual({
      memberships: 0,
      subscriptions: 0,
      invoices: 0,
      proofs: 0,
      entitlements: 0,
      packageChanges: 0,
      applications: 0,
      sessions: 0,
      tokens: 0,
      auditActors: 0,
    });

    // The purge is audited, with the legal name carried in so the trail is still
    // readable now that the organization row is gone.
    const entry = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'subscriber.purged')
      .executeTakeFirstOrThrow();
    expect(entry.target_id).toBe(organizationId);
    expect(entry.actor_user_id).toBe(admin.userId);
    expect(JSON.stringify(entry.metadata)).toContain('Purgeable Test Ltd');
  });

  it('recomputes eligibility at confirmation time, not from the client', async () => {
    const admin = await operator();
    const { organizationId, legalName } = await createSubscriber(admin.cookies, {
      email: 'racing@test.test',
      legalName: 'Racing Ltd',
    });

    // The administrator sees a green light…
    expect((await impact(admin.cookies, organizationId)).deletionPermitted).toBe(true);

    // …and the world changes underneath them before they confirm.
    await ctx.db
      .updateTable('organizations')
      .set({ legal_hold: true, legal_hold_reason: 'Dispute opened after the assessment.' })
      .where('id', '=', organizationId)
      .execute();

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/subscribers/${organizationId}`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Stale assessment.', confirmationName: legalName },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/legally retained|Archive the subscriber/i);
    expect(
      await ctx.db.selectFrom('organizations').select('id').where('id', '=', organizationId).executeTakeFirst(),
    ).toBeDefined();
  });

  it('ignores an eligibility verdict supplied by the browser', async () => {
    const admin = await operator();
    const { organizationId, legalName } = await createSubscriber(admin.cookies, {
      activate: true,
      classification: 'production',
    });

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/subscribers/${organizationId}`,
      headers: authHeaders(admin.cookies),
      payload: {
        reason: 'Forged eligibility.',
        confirmationName: legalName,
        // Every shape a client might try.
        deletionPermitted: true,
        blockingReasons: [],
        impact: { deletionPermitted: true, blockingReasons: [] },
        force: true,
        skipConfirmation: true,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(
      await ctx.db.selectFrom('organizations').select('id').where('id', '=', organizationId).executeTakeFirst(),
    ).toBeDefined();
  });

  it('requires the organization name to be typed correctly', async () => {
    const admin = await operator();
    const { organizationId } = await createSubscriber(admin.cookies, {
      email: 'typed@test.test',
      legalName: 'Exact Name Ltd',
    });

    const wrong = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/subscribers/${organizationId}`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Cleanup.', confirmationName: 'Exact Name Limited' },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.details.fieldErrors.confirmationName).toMatch(/Exact Name Ltd/);
    expect(
      await ctx.db.selectFrom('organizations').select('id').where('id', '=', organizationId).executeTakeFirst(),
    ).toBeDefined();

    const missing = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/subscribers/${organizationId}`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Cleanup.' },
    });
    expect(missing.statusCode).toBe(400);
  });

  it('refuses while a legal hold is in force, and allows it once lifted', async () => {
    const admin = await operator();
    const { organizationId, legalName } = await createSubscriber(admin.cookies, {
      email: 'held@test.test',
      legalName: 'Held Ltd',
    });

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/subscribers/${organizationId}/legal-hold`,
      headers: authHeaders(admin.cookies),
      payload: { hold: true, reason: 'Regulatory query.' },
    });
    expect((await impact(admin.cookies, organizationId)).blockingReasons.map((b: { code: string }) => b.code)).toContain(
      'legal_hold',
    );

    const held = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/subscribers/${organizationId}`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Blocked.', confirmationName: legalName },
    });
    expect(held.statusCode).toBe(409);

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/subscribers/${organizationId}/legal-hold`,
      headers: authHeaders(admin.cookies),
      payload: { hold: false, reason: 'Query closed.' },
    });
    const allowed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/subscribers/${organizationId}`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Cleared.', confirmationName: legalName },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('revokes member sessions before completing the purge', async () => {
    const admin = await operator();
    const { organizationId, legalName, userId } = await createSubscriber(admin.cookies, {
      email: 'sessionpurge@test.test',
      legalName: 'Session Purge Ltd',
    });

    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${userId}/reset-password`,
      headers: authHeaders(admin.cookies),
      payload: { mode: 'temporary', reason: 'Set up for the test.' },
    });
    const owner = await ctx.db.selectFrom('users').select('email').where('id', '=', userId).executeTakeFirstOrThrow();
    await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: owner.email, password: reset.json().credential.temporaryPassword },
    });

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/subscribers/${organizationId}`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Cleanup.', confirmationName: legalName },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().revokedSessions).toBeGreaterThan(0);
    // No session row survives pointing at a user who no longer exists.
    expect((await findOrphans()).sessions).toBe(0);
  });

  it('blocks a purge while a payment proof is awaiting review', async () => {
    const admin = await operator();
    const { organizationId } = await createSubscriber(admin.cookies, { classification: 'production', email: 'reviewing@test.test' });

    // Give the tenant an invoice with a submitted proof.
    const subscription = await ctx.db
      .selectFrom('subscriptions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .executeTakeFirstOrThrow();
    const invoice = await ctx.db
      .insertInto('subscription_invoices')
      .values({
        invoice_number: 'SUB-2026-09999',
        organization_id: organizationId,
        subscription_id: subscription.id,
        currency: 'USD',
        subtotal: '49.00',
        total: '49.00',
        status: 'issued',
        payment_reference: 'LG-TEST-9999',
        due_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await ctx.db
      .insertInto('payment_proofs')
      .values({
        invoice_id: invoice.id,
        uploaded_by_user_id: (
          await ctx.db
            .selectFrom('organization_memberships')
            .select('user_id')
            .where('organization_id', '=', organizationId)
            .executeTakeFirstOrThrow()
        ).user_id,
        file_name: 'r.png',
        storage_key: 'k',
        mime_type: 'image/png',
        file_size: 10,
        ledgora_payment_reference: 'LG-TEST-9999',
        amount: '49.00',
        paid_at: new Date(),
        status: 'submitted',
      })
      .execute();

    const report = await impact(admin.cookies, organizationId);
    expect(report.deletionPermitted).toBe(false);
    expect(report.blockingReasons.map((b: { code: string }) => b.code)).toContain('pending_review');
  });
});

/* ══ 16–18: safeguards ═════════════════════════════════════════════════════ */

describe('safeguards', () => {
  it('refuses to delete or disable the last active super administrator', async () => {
    const admin = await operator();
    const second = await operator('super_admin', 'second-super@ledgora.test');

    // With two present, one may be disabled.
    const allowed = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${second.userId}/disable`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Handover.' },
    });
    expect(allowed.statusCode).toBe(200);

    // Now the acting administrator is the last one; the other is inactive.
    const remaining = await operator('super_admin', 'third-super@ledgora.test');
    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${remaining.userId}/disable`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Also leaving.' },
    });

    // Disabling the final active super administrator is refused, whoever asks.
    const blocked = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${admin.userId}/disable`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Should be refused.' },
    });
    // Self-protection fires first; either refusal is correct and both are 4xx.
    expect(blocked.statusCode).toBeGreaterThanOrEqual(400);
    expect(blocked.statusCode).toBeLessThan(500);
    const stillActive = await ctx.db
      .selectFrom('users')
      .select('status')
      .where('id', '=', admin.userId)
      .executeTakeFirstOrThrow();
    expect(stillActive.status).toBe('active');
  });

  it('blocks self-deletion and self-disabling', async () => {
    const admin = await operator();
    await operator('super_admin', 'backup-super@ledgora.test');

    for (const [method, url] of [
      ['POST', `/api/admin/members/${admin.userId}/disable`],
      ['DELETE', `/api/admin/members/${admin.userId}`],
      ['DELETE', `/api/admin/applicants/${admin.userId}`],
    ] as const) {
      const response = await ctx.app.inject({
        method,
        url,
        headers: authHeaders(admin.cookies),
        payload: { reason: 'Should be refused.' },
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
    }

    const self = await ctx.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', admin.userId)
      .executeTakeFirstOrThrow();
    expect(self.status).toBe('active');
    expect(self.deleted_at).toBeNull();
  });

  it('refuses to delete an account that still holds a platform role', async () => {
    const admin = await operator();
    const staff = await seedUser(ctx, { email: 'billing@ledgora.test', platformRoles: ['billing_admin'] });

    const assessed = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/members/${staff.id}/deletion-impact`,
      headers: authHeaders(admin.cookies),
    });
    expect(assessed.json().impact.deletionPermitted).toBe(false);
    expect(assessed.json().impact.blockingReasons.map((b: { code: string }) => b.code)).toContain('platform_role');

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/members/${staff.id}`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Should be refused.' },
    });
    expect(response.statusCode).toBe(409);
    expect(await ctx.db.selectFrom('users').select('id').where('id', '=', staff.id).executeTakeFirst()).toBeDefined();
  });

  it('refuses to delete an account that is still a member somewhere', async () => {
    const admin = await operator();
    const { organizationId } = await createSubscriber(admin.cookies, { classification: 'production' });
    const memberId = await invite(admin.cookies, organizationId, 'stillhere@newco.test');

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/members/${memberId}`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Should be refused.' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/Disable the account instead|belongs to/i);
  });
});

/* ══ 19 & 21: audit and authorization ══════════════════════════════════════ */

describe('audit and authorization', () => {
  it('audits every action with actor, target, reason and timestamp', async () => {
    const admin = await operator();
    const { organizationId } = await createSubscriber(admin.cookies, { email: 'audited@test.test' });
    const memberId = await invite(admin.cookies, organizationId, 'auditedmember@test.test');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${memberId}/remove`,
      headers: authHeaders(admin.cookies),
      payload: { organizationId, reason: 'Removal reason.' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${memberId}/disable`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Disable reason.' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/archive`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Archive reason.' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/restore`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Restore reason.' },
    });

    for (const [action, reason] of [
      ['member.removed_from_organization', 'Removal reason.'],
      ['member.account_disabled', 'Disable reason.'],
      ['subscriber.archived', 'Archive reason.'],
      ['subscriber.restored', 'Restore reason.'],
    ] as const) {
      const entry = await ctx.db
        .selectFrom('audit_logs')
        .selectAll()
        .where('action', '=', action)
        .executeTakeFirstOrThrow();
      expect(entry.actor_user_id).toBe(admin.userId);
      expect(entry.target_id).toBeTruthy();
      expect(entry.created_at).toBeTruthy();
      expect(JSON.stringify(entry.metadata)).toContain(reason);
    }
  });

  it('never records a credential in a deletion audit entry', async () => {
    const admin = await operator();
    const { userId } = await createSubscriber(admin.cookies, { email: 'nocreds@test.test' });

    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${userId}/reset-password`,
      headers: authHeaders(admin.cookies),
      payload: { mode: 'temporary', reason: 'Before deletion.' },
    });
    const password = reset.json().credential.temporaryPassword;

    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${userId}/disable`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Disabled after reset.' },
    });

    const everything = JSON.stringify(await ctx.db.selectFrom('audit_logs').selectAll().execute());
    expect(everything).not.toContain(password);
    for (const marker of ['token_hash', 'password_hash', '$argon2']) {
      expect(everything).not.toContain(marker);
    }
  });

  it('refuses every deletion endpoint to an ordinary subscriber', async () => {
    const admin = await operator();
    const { organizationId, userId } = await createSubscriber(admin.cookies, { email: 'customer@test.test' });
    const customer = await register('plaincustomer@test.test');

    const attempts = [
      { method: 'POST' as const, url: `/api/admin/members/${userId}/remove`, payload: { organizationId, reason: 'x' } },
      { method: 'POST' as const, url: `/api/admin/members/${userId}/disable`, payload: { reason: 'x' } },
      { method: 'DELETE' as const, url: `/api/admin/members/${userId}`, payload: { reason: 'x' } },
      { method: 'DELETE' as const, url: `/api/admin/applicants/${userId}`, payload: { reason: 'x' } },
      { method: 'POST' as const, url: `/api/admin/subscribers/${organizationId}/archive`, payload: { reason: 'x' } },
      { method: 'POST' as const, url: `/api/admin/subscribers/${organizationId}/restore`, payload: { reason: 'x' } },
      {
        method: 'DELETE' as const,
        url: `/api/admin/subscribers/${organizationId}`,
        payload: { reason: 'x', confirmationName: 'anything' },
      },
      { method: 'GET' as const, url: `/api/admin/subscribers/${organizationId}/deletion-impact` },
      { method: 'GET' as const, url: `/api/admin/members/${userId}/deletion-impact` },
    ];

    for (const attempt of attempts) {
      const response = await ctx.app.inject({
        ...attempt,
        headers: authHeaders(customer.cookies),
      });
      expect(response.statusCode).toBe(403);
    }
    // Nothing happened.
    expect(
      await ctx.db.selectFrom('organizations').select('id').where('id', '=', organizationId).executeTakeFirst(),
    ).toBeDefined();
  });

  it('lets support read impact reports but perform no removal', async () => {
    const admin = await operator();
    const support = await operator('support');
    const { organizationId, userId } = await createSubscriber(admin.cookies, { email: 'supportcase@test.test' });

    // Reading is support work.
    for (const url of [
      `/api/admin/subscribers/${organizationId}/deletion-impact`,
      `/api/admin/members/${userId}/deletion-impact`,
    ]) {
      expect((await ctx.app.inject({ method: 'GET', url, headers: authHeaders(support.cookies) })).statusCode).toBe(200);
    }

    // Acting is not.
    for (const attempt of [
      { method: 'POST' as const, url: `/api/admin/members/${userId}/remove`, payload: { organizationId, reason: 'x' } },
      { method: 'POST' as const, url: `/api/admin/subscribers/${organizationId}/archive`, payload: { reason: 'x' } },
      { method: 'DELETE' as const, url: `/api/admin/members/${userId}`, payload: { reason: 'x' } },
    ]) {
      expect((await ctx.app.inject({ ...attempt, headers: authHeaders(support.cookies) })).statusCode).toBe(403);
    }
  });

  it('lets a billing administrator archive and remove, but never purge', async () => {
    const superAdmin = await operator();
    const billing = await operator('billing_admin');
    const { organizationId, legalName } = await createSubscriber(superAdmin.cookies, { email: 'billingcase@test.test' });
    const memberId = await invite(superAdmin.cookies, organizationId, 'removable@test.test');

    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/api/admin/members/${memberId}/remove`,
          headers: authHeaders(billing.cookies),
          payload: { organizationId, reason: 'Routine removal.' },
        })
      ).statusCode,
    ).toBe(200);

    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/api/admin/subscribers/${organizationId}/archive`,
          headers: authHeaders(billing.cookies),
          payload: { reason: 'Routine archive.' },
        })
      ).statusCode,
    ).toBe(200);

    // Permanent destruction stays with super_admin.
    for (const attempt of [
      {
        method: 'DELETE' as const,
        url: `/api/admin/subscribers/${organizationId}`,
        payload: { reason: 'x', confirmationName: legalName },
      },
      { method: 'DELETE' as const, url: `/api/admin/members/${memberId}`, payload: { reason: 'x' } },
      { method: 'DELETE' as const, url: `/api/admin/applicants/${memberId}`, payload: { reason: 'x' } },
    ]) {
      expect((await ctx.app.inject({ ...attempt, headers: authHeaders(billing.cookies) })).statusCode).toBe(403);
    }
  });

  it('exposes the new capabilities per role', async () => {
    const superAdmin = await operator();
    const billing = await operator('billing_admin');
    const support = await operator('support');

    const capabilitiesOf = async (cookies: SessionCookies): Promise<string[]> =>
      (await ctx.app.inject({ method: 'GET', url: '/api/admin/me', headers: authHeaders(cookies) })).json()
        .capabilities;

    const asSuper = await capabilitiesOf(superAdmin.cookies);
    for (const capability of [
      'members.remove',
      'members.delete',
      'applicants.delete',
      'subscribers.archive',
      'subscribers.delete',
    ]) {
      expect(asSuper).toContain(capability);
    }

    const asBilling = await capabilitiesOf(billing.cookies);
    expect(asBilling).toContain('members.remove');
    expect(asBilling).toContain('subscribers.archive');
    expect(asBilling).not.toContain('subscribers.delete');
    expect(asBilling).not.toContain('members.delete');
    expect(asBilling).not.toContain('applicants.delete');

    const asSupport = await capabilitiesOf(support.cookies);
    for (const capability of [
      'members.remove',
      'members.delete',
      'applicants.delete',
      'subscribers.archive',
      'subscribers.delete',
    ]) {
      expect(asSupport).not.toContain(capability);
    }
  });
});

/* ══ 22: existing workflows still work ═════════════════════════════════════ */

describe('existing workflows', () => {
  it('leaves registration, onboarding, the applicant roster and package assignment intact', async () => {
    const admin = await operator();
    const customer = await register('unaffected@flow.test', 'Unaffected Flow');

    // Applicant roster still sees a fresh registration.
    const applicants = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/applicants',
      headers: authHeaders(admin.cookies),
    });
    expect(
      applicants.json().applicants.find((a: { email: string }) => a.email === 'unaffected@flow.test'),
    ).toMatchObject({ stage: 'registered_no_package' });

    // Onboarding still works end to end.
    const organization = await ctx.app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: authHeaders(customer.cookies),
      payload: { legalName: 'Unaffected Ltd', country: 'AE' },
    });
    expect(organization.statusCode).toBe(201);
    const selected = await ctx.app.inject({
      method: 'POST',
      url: '/api/subscriptions',
      headers: authHeaders(customer.cookies),
      payload: { planId: await plan() },
    });
    expect(selected.statusCode).toBe(201);

    // Package assignment still works, on the organization.
    const organizationId = organization.json().organizationId;
    const assigned = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/assign-package`,
      headers: authHeaders(admin.cookies),
      payload: { planId: await plan('enterprise'), status: 'active', reason: 'Still working.' },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().entitlements.active).toBe(true);

    // The operator member context is unchanged.
    const roster = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/organizations/${organizationId}/members`,
      headers: authHeaders(admin.cookies),
    });
    expect(roster.statusCode).toBe(200);
    expect(roster.json().members).toHaveLength(1);

    // And the administrator never became a member of the tenant.
    expect(
      await ctx.db.selectFrom('organization_memberships').select('id').where('user_id', '=', admin.userId).execute(),
    ).toHaveLength(0);
  });

  it('keeps the generic lifecycle archive action working alongside the new one', async () => {
    const admin = await operator();
    const { organizationId } = await createSubscriber(admin.cookies, { email: 'lifecycle@flow.test', activate: true });

    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/subscribers/${organizationId}/status`,
      headers: authHeaders(admin.cookies),
      payload: { action: 'archive', reason: 'Via the lifecycle control.' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().organizationStatus).toBe('archived');

    // Restorable through either path.
    const restored = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/restore`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Back again.' },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().organizationStatus).toBe('active');
  });

  it('assesses deletion for a subscriber that has no subscription at all', async () => {
    // A defensive case: the roster shows applicants who created an organization
    // and stopped. The assessment must not throw on the missing rows.
    const admin = await operator();
    const applicant = await register('orgonly@flow.test');
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: authHeaders(applicant.cookies),
      payload: { legalName: 'Org Only Ltd', country: 'AE' },
    });
    const organizationId = created.json().organizationId;
    await classifyAsTest(organizationId);

    const report = await assessSubscriberDeletion(ctx.db, organizationId);
    expect(report.deletionPermitted).toBe(true);
    expect(report.counts.find((c) => c.key === 'subscriptions')?.count).toBe(0);

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/subscribers/${organizationId}`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Abandoned shell.', confirmationName: 'Org Only Ltd' },
    });
    expect(response.statusCode).toBe(200);
    expect(await findOrphans()).toMatchObject({ memberships: 0, auditActors: 0 });
  });
});

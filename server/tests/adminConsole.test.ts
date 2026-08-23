/**
 * Super Admin console — subscriber creation, member administration, credential
 * reset and package assignment.
 *
 * The claims this suite exists to prove, in the order the requirements state
 * them:
 *
 *   creation      a subscriber is created as ONE transaction, and a failure at
 *                 any step leaves nothing behind;
 *   credentials   a generated password is shown once, never stored or logged in
 *                 recoverable form, forces a change at first sign-in, revokes
 *                 every session and clears the lock that prompted the reset;
 *   disclosure    no administrator surface returns a hash, a token or a secret,
 *                 and no surface can retrieve an EXISTING password;
 *   packages      assignment is organization-wide, recomputes entitlements,
 *                 preserves history, and reports downgrade consequences BEFORE
 *                 confirmation;
 *   authorization a customer is refused, a forged browser role is ignored,
 *                 cross-tenant reads are blocked, and the last owner / last
 *                 super administrator cannot be removed.
 */
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
import { createSubscriber } from '../src/services/subscriberService.js';
import { setMemberAccountStatus } from '../src/services/memberAdminService.js';
import { getEntitlements } from '../src/services/entitlementService.js';

let ctx: TestContext;

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

interface CataloguePlan {
  id: string;
  code: string;
  name: string;
  userLimit: number;
  modules: string[];
}

async function plans(): Promise<CataloguePlan[]> {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
  return response.json().plans;
}

/**
 * A plan by CODE, never by catalogue position. The seeded catalogue runs cheapest
 * to richest, so an index-based lookup silently inverts "upgrade" and "downgrade"
 * the moment a plan is inserted.
 */
async function plan(code: 'core' | 'professional' | 'business' | 'enterprise'): Promise<CataloguePlan> {
  const found = (await plans()).find((p) => p.code === code);
  if (!found) throw new Error(`seeded catalogue is missing the "${code}" plan`);
  return found;
}

/** Register a customer through the real HTTP route. */
async function register(email: string, fullName = 'Customer Person'): Promise<{ cookies: SessionCookies; userId: string }> {
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

interface CreateOverrides {
  email?: string;
  fullName?: string;
  organizationLegalName?: string;
  planId?: string;
  onboarding?: 'invite' | 'temporary';
  paymentConfirmed?: boolean;
  seatAllowance?: number;
  modules?: string[];
  internalNotes?: string;
}

/**
 * Create a subscriber through the HTTP route, as the console does.
 *
 * `body` flattens `{ subscriber, credential, entitlements }` into one object for
 * the assertions below; `raw` is the untouched response body, for the tests that
 * are specifically about the wire contract.
 */
async function createSubscriberViaApi(
  admin: SessionCookies,
  overrides: CreateOverrides = {},
): Promise<{ status: number; body: Record<string, unknown>; raw: Record<string, unknown> }> {
  const catalogue = await plans();
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/subscribers',
    headers: authHeaders(admin),
    payload: {
      fullName: overrides.fullName ?? 'Nadia Owner',
      email: overrides.email ?? 'nadia@newco.test',
      organizationLegalName: overrides.organizationLegalName ?? 'NewCo Trading LLC',
      country: 'AE',
      baseCurrency: 'AED',
      planId: overrides.planId ?? catalogue[0]!.id,
      onboarding: overrides.onboarding ?? 'temporary',
      paymentConfirmed: overrides.paymentConfirmed ?? true,
      ...(overrides.seatAllowance !== undefined ? { seatAllowance: overrides.seatAllowance } : {}),
      ...(overrides.modules ? { modules: overrides.modules } : {}),
      ...(overrides.internalNotes ? { internalNotes: overrides.internalNotes } : {}),
    },
  });
  const raw = response.json() as Record<string, unknown>;
  const subscriber = (raw.subscriber ?? {}) as Record<string, unknown>;
  return {
    status: response.statusCode,
    raw,
    body: { ...subscriber, credential: raw.credential, entitlements: raw.entitlements },
  };
}

/** Every row of every table, as one JSON blob — for "is this value anywhere?". */
async function dumpDatabase(): Promise<string> {
  const tables = [
    'users',
    'platform_user_roles',
    'organizations',
    'organization_memberships',
    'subscriptions',
    'subscription_plans',
    'subscription_invoices',
    'subscription_applications',
    'password_reset_tokens',
    'organization_entitlements',
    'subscription_package_changes',
    'auth_sessions',
    'audit_logs',
  ] as const;
  const dump: Record<string, unknown> = {};
  for (const table of tables) {
    dump[table] = await ctx.db.selectFrom(table).selectAll().execute();
  }
  return JSON.stringify(dump);
}

/* ══ 1 & 3: transactional creation ════════════════════════════════════════ */

describe('creating a subscriber', () => {
  it('creates the user, organization, owner membership, application, subscription and entitlement together', async () => {
    const admin = await operator();
    const { status, body } = await createSubscriberViaApi(admin.cookies, { internalNotes: 'Signed at the trade show.' });

    expect(status).toBe(201);
    const organizationId = body.organizationId as string;
    const userId = body.userId as string;

    // 1 — the person
    const user = await ctx.db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirstOrThrow();
    expect(user.email).toBe('nadia@newco.test');
    expect(user.must_change_password).toBe(true);

    // 2 — the tenant
    const organization = await ctx.db
      .selectFrom('organizations')
      .selectAll()
      .where('id', '=', organizationId)
      .executeTakeFirstOrThrow();
    expect(organization.legal_name).toBe('NewCo Trading LLC');
    expect(organization.internal_notes).toBe('Signed at the trade show.');

    // 3 — the owner membership. This is what makes them the owner.
    const membership = await ctx.db
      .selectFrom('organization_memberships')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .executeTakeFirstOrThrow();
    expect(membership.user_id).toBe(userId);
    expect(membership.role).toBe('owner');
    expect(membership.status).toBe('active');

    // 4 — the applicant record, at the stage the administrator implied
    const application = await ctx.db
      .selectFrom('subscription_applications')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(application.status).toBe('active_subscriber');
    expect(application.source).toBe('admin_created');
    expect(application.organization_id).toBe(organizationId);

    // 5 — the subscription, with the selected package
    const subscription = await ctx.db
      .selectFrom('subscriptions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .executeTakeFirstOrThrow();
    expect(subscription.status).toBe('active');
    expect(subscription.plan_id).not.toBeNull();

    // 6 — the entitlement record
    const entitlement = await ctx.db
      .selectFrom('organization_entitlements')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .executeTakeFirstOrThrow();
    expect(entitlement.active).toBe(true);
    expect(entitlement.plan_id).toBe(subscription.plan_id);

    // 7 — the audit entry
    const audit = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'subscriber.created')
      .executeTakeFirstOrThrow();
    expect(audit.target_id).toBe(organizationId);
    expect(audit.actor_user_id).toBe(admin.userId);
  });

  it('makes the new owner an owner and nothing else', async () => {
    const admin = await operator();
    const { body } = await createSubscriberViaApi(admin.cookies, { email: 'owner-role@newco.test' });

    const memberships = await ctx.db
      .selectFrom('organization_memberships')
      .selectAll()
      .where('user_id', '=', body.userId as string)
      .execute();
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.role).toBe('owner');

    // Creating a subscriber must never grant a PLATFORM role.
    const platformRoles = await ctx.db
      .selectFrom('platform_user_roles')
      .select('role')
      .where('user_id', '=', body.userId as string)
      .execute();
    expect(platformRoles).toHaveLength(0);
  });

  it('leaves no partial subscriber when a later step fails', async () => {
    const admin = await operator();
    const catalogue = await plans();

    const before = {
      users: (await ctx.db.selectFrom('users').select('id').execute()).length,
      organizations: (await ctx.db.selectFrom('organizations').select('id').execute()).length,
    };

    /*
     * The entity allowance is rejected by PostgreSQL when the SUBSCRIPTION is
     * inserted — step 4, after the user, the organization and the membership have
     * all been written. Exactly the shape of failure that would otherwise leave an
     * orphaned tenant with no subscription and an account nobody can bill.
     */
    await expect(
      createSubscriber(
        ctx.db,
        {
          fullName: 'Rollback Rita',
          email: 'rollback@newco.test',
          organizationLegalName: 'Rollback Holdings',
          country: 'AE',
          baseCurrency: 'AED',
          planId: catalogue[0]!.id,
          entityAllowance: 2 ** 40, // out of range for an int4 column
          onboarding: 'temporary',
          paymentConfirmed: true,
        },
        { actorUserId: admin.userId, actorPlatformRole: 'super_admin' },
      ),
    ).rejects.toThrow();

    // Nothing survived: no account, no tenant, no membership, no application.
    expect(
      await ctx.db.selectFrom('users').select('id').where('normalized_email', '=', 'rollback@newco.test').execute(),
    ).toHaveLength(0);
    expect(
      await ctx.db.selectFrom('organizations').select('id').where('legal_name', '=', 'Rollback Holdings').execute(),
    ).toHaveLength(0);
    expect((await ctx.db.selectFrom('users').select('id').execute()).length).toBe(before.users);
    expect((await ctx.db.selectFrom('organizations').select('id').execute()).length).toBe(before.organizations);
    expect(
      await ctx.db.selectFrom('audit_logs').select('id').where('action', '=', 'subscriber.created').execute(),
    ).toHaveLength(0);
  });

  it('refuses a duplicate email before creating anything', async () => {
    const admin = await operator();
    await register('taken@newco.test');
    const organizationsBefore = (await ctx.db.selectFrom('organizations').select('id').execute()).length;

    const { status } = await createSubscriberViaApi(admin.cookies, { email: 'taken@newco.test' });
    expect(status).toBe(409);
    expect((await ctx.db.selectFrom('organizations').select('id').execute()).length).toBe(organizationsBefore);
  });
});

/* ══ 4, 5, 6, 7, 8: credentials ═══════════════════════════════════════════ */

describe('the temporary password issued at creation', () => {
  it('is returned exactly once and never stored or logged in recoverable form', async () => {
    const admin = await operator();
    const { body } = await createSubscriberViaApi(admin.cookies, { onboarding: 'temporary' });

    const password = (body.credential as { temporaryPassword?: string }).temporaryPassword!;
    expect(password).toBeTruthy();
    expect(password.length).toBeGreaterThanOrEqual(16);

    // Nowhere in the database — not in the user row, not in the audit metadata.
    expect(await dumpDatabase()).not.toContain(password);

    // Only an Argon2id hash is kept, and it verifies the password we were shown.
    const user = await ctx.db
      .selectFrom('users')
      .select(['password_hash', 'password_expires_at'])
      .where('id', '=', body.userId as string)
      .executeTakeFirstOrThrow();
    expect(user.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(user.password_expires_at).not.toBeNull();

    // Reading the subscriber back never re-supplies it.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/subscribers/${body.organizationId}`,
      headers: authHeaders(admin.cookies),
    });
    expect(detail.body).not.toContain(password);
  });

  it('forces a password change at the first successful login', async () => {
    const admin = await operator();
    const { body } = await createSubscriberViaApi(admin.cookies, { email: 'firstlogin@newco.test' });
    const password = (body.credential as { temporaryPassword: string }).temporaryPassword;

    const signIn = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'firstlogin@newco.test', password },
    });
    expect(signIn.statusCode).toBe(200);
    expect(signIn.json().mustChangePassword).toBe(true);

    const raw = signIn.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : [String(raw)];
    const find = (name: string): string => {
      const match = list.find((c) => c.startsWith(`${name}=`));
      return match ? (match.split(';')[0]?.split('=').slice(1).join('=') ?? '') : '';
    };
    const cookies = { session: find('ledgora_session'), csrf: find('ledgora_csrf') };

    // The forced change is ENFORCED, not merely advertised: the session can do
    // nothing else until the password is replaced.
    const blocked = await ctx.app.inject({
      method: 'GET',
      url: '/api/subscriptions/current',
      headers: authHeaders(cookies),
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('password_change_required');

    const blockedWrite = await ctx.app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: authHeaders(cookies),
      payload: { legalName: 'Sneaky Ltd', country: 'AE' },
    });
    expect(blockedWrite.json().error.code).toBe('password_change_required');

    // Changing it is permitted, and clears the gate.
    const change = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: authHeaders(cookies),
      payload: { currentPassword: password, newPassword: 'Chosen-By-Me-77-Ledger' },
    });
    expect(change.statusCode).toBe(200);

    const after = await login(ctx, 'firstlogin@newco.test', 'Chosen-By-Me-77-Ledger');
    const allowed = await ctx.app.inject({
      method: 'GET',
      url: '/api/subscriptions/current',
      headers: authHeaders(after),
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('stops working once it expires', async () => {
    const admin = await operator();
    const { body } = await createSubscriberViaApi(admin.cookies, { email: 'expiring@newco.test' });
    const password = (body.credential as { temporaryPassword: string }).temporaryPassword;

    await ctx.db
      .updateTable('users')
      .set({ password_expires_at: new Date(Date.now() - 60_000) })
      .where('id', '=', body.userId as string)
      .execute();

    const signIn = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'expiring@newco.test', password },
    });
    expect(signIn.statusCode).toBe(401);
    expect(signIn.json().error.code).toBe('password_expired');
  });

  it('offers an invitation link instead, and is honest that nothing was emailed', async () => {
    const admin = await operator();
    const { body } = await createSubscriberViaApi(admin.cookies, {
      email: 'invited@newco.test',
      onboarding: 'invite',
    });

    const credential = body.credential as {
      type: string;
      invitationToken: string;
      deliveryStatus: string;
      message: string;
    };
    expect(credential.type).toBe('invitation');
    expect(credential.deliveryStatus).toBe('unavailable');
    expect(credential.message).toMatch(/not configured/i);
    // No temporary password was issued down this route.
    expect(body.credential).not.toHaveProperty('temporaryPassword');

    // Only the token's hash is stored.
    const stored = await ctx.db
      .selectFrom('password_reset_tokens')
      .selectAll()
      .where('user_id', '=', body.userId as string)
      .executeTakeFirstOrThrow();
    expect(stored.token_hash).not.toBe(credential.invitationToken);
    expect(stored.token_hash).toHaveLength(64);
    expect(await dumpDatabase()).not.toContain(credential.invitationToken);
  });
});

/* ══ 12 & 13: the wire contract for a one-time credential ════════════════ */

describe('the one-time credential contract', () => {
  it('returns subscriber and credential as a discriminated envelope on create', async () => {
    const admin = await operator();
    const { status, raw } = await createSubscriberViaApi(admin.cookies, {
      email: 'envelope@newco.test',
      fullName: 'Envelope Ella',
      onboarding: 'temporary',
    });

    expect(status).toBe(201);
    // The client can answer "was a credential returned?" from the shape alone.
    expect(raw).toHaveProperty('subscriber');
    expect(raw).toHaveProperty('credential');
    expect(raw.subscriber).toMatchObject({
      email: 'envelope@newco.test',
      fullName: 'Envelope Ella',
      subscriptionStatus: 'active',
    });
    expect(raw.credential).toMatchObject({
      type: 'temporary_password',
      deliveryStatus: 'unavailable',
      mustChangePassword: true,
    });
    expect((raw.credential as { temporaryPassword: string }).temporaryPassword).toBeTruthy();
    expect((raw.credential as { expiresAt: string }).expiresAt).toBeTruthy();
  });

  it('reports an invitation with an honest delivery status and no password', async () => {
    const admin = await operator();
    const { raw } = await createSubscriberViaApi(admin.cookies, {
      email: 'invite-envelope@newco.test',
      onboarding: 'invite',
    });

    expect(raw.credential).toMatchObject({ type: 'invitation', deliveryStatus: 'unavailable' });
    expect(raw.credential).not.toHaveProperty('temporaryPassword');
    // `unavailable` is not `failed`: nothing was attempted, so the operator is
    // the delivery channel.
    expect((raw.credential as { deliveryStatus: string }).deliveryStatus).not.toBe('sent');
  });

  it('uses the SAME envelope for a password reset', async () => {
    const admin = await operator();
    const customer = await register('same-envelope@acme.test', 'Same Envelope');

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${customer.userId}/reset-password`,
      headers: authHeaders(admin.cookies),
      payload: { mode: 'temporary', reason: 'Support call.' },
    });
    const body = response.json();

    expect(body).toHaveProperty('member');
    expect(body).toHaveProperty('credential');
    expect(body.member).toMatchObject({ userId: customer.userId, email: 'same-envelope@acme.test' });
    expect(body.credential).toMatchObject({
      type: 'temporary_password',
      deliveryStatus: 'unavailable',
      mustChangePassword: true,
    });
    expect(body.credential.temporaryPassword).toBeTruthy();
  });

  it('returns the password ONLY from create and reset — never from any read', async () => {
    const admin = await operator();
    const { body } = await createSubscriberViaApi(admin.cookies, { email: 'readback@newco.test' });
    const password = (body.credential as { temporaryPassword: string }).temporaryPassword;
    const userId = body.userId as string;
    const organizationId = body.organizationId as string;

    // Every read surface that could plausibly echo it.
    for (const url of [
      '/api/admin/members',
      `/api/admin/members/${userId}`,
      '/api/admin/subscribers',
      `/api/admin/subscribers/${organizationId}`,
      `/api/admin/subscribers/${organizationId}/entitlements`,
      `/api/admin/subscribers/${organizationId}/package-history`,
      '/api/admin/applicants',
      `/api/admin/applicants/${userId}`,
      '/api/admin/audit-logs?limit=200',
      `/api/admin/users/${userId}`,
      `/api/admin/organizations/${organizationId}/members`,
    ]) {
      const response = await ctx.app.inject({ method: 'GET', url, headers: authHeaders(admin.cookies) });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(password);
    }
  });

  it('marks the credential response uncacheable', async () => {
    const admin = await operator();
    const catalogue = await plans();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/subscribers',
      headers: authHeaders(admin.cookies),
      payload: {
        fullName: 'Nocache Nina',
        email: 'nocache@newco.test',
        organizationLegalName: 'Nocache Ltd',
        country: 'AE',
        baseCurrency: 'AED',
        planId: catalogue[0]!.id,
        onboarding: 'temporary',
      },
    });
    expect(response.statusCode).toBe(201);
    // A shared cache or proxy must not retain a body containing a credential.
    expect(String(response.headers['cache-control'])).toContain('no-store');
  });

  it('keeps the raw password out of the audit trail and every stored row', async () => {
    const admin = await operator();
    const { body } = await createSubscriberViaApi(admin.cookies, { email: 'auditsafe@newco.test' });
    const created = (body.credential as { temporaryPassword: string }).temporaryPassword;

    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${body.userId}/reset-password`,
      headers: authHeaders(admin.cookies),
      payload: { mode: 'temporary', reason: 'Second issue.' },
    });
    const replaced = reset.json().credential.temporaryPassword;

    // Neither credential appears anywhere in the database — audit_logs included.
    const dump = await dumpDatabase();
    for (const secret of [created, replaced]) {
      expect(secret).toBeTruthy();
      expect(dump).not.toContain(secret);
    }

    // And specifically in the audit rows for the two credential actions.
    const entries = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', 'in', ['subscriber.created', 'member.password_reset_temporary'])
      .execute();
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const entry of entries) {
      const serialised = JSON.stringify(entry);
      expect(serialised).not.toContain(created);
      expect(serialised).not.toContain(replaced);
    }
  });
});

describe('resetting a member password', () => {
  /** A customer with a lock, failed attempts and two live sessions. */
  async function troubledCustomer(): Promise<{ userId: string; sessions: SessionCookies[] }> {
    const first = await register('locked-out@acme.test', 'Locked Out Larry');
    const second = await login(ctx, 'locked-out@acme.test');
    await ctx.db
      .updateTable('users')
      .set({ failed_login_count: 7, locked_until: new Date(Date.now() + 3_600_000), status: 'locked' })
      .where('id', '=', first.userId)
      .execute();
    return { userId: first.userId, sessions: [first.cookies, second] };
  }

  it('issues a fresh password, revokes every session, and clears the lock', async () => {
    const admin = await operator();
    const { userId, sessions } = await troubledCustomer();

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${userId}/reset-password`,
      headers: authHeaders(admin.cookies),
      payload: { mode: 'temporary', reason: 'Customer called the support line.' },
    });
    expect(response.statusCode).toBe(200);
    const result = response.json();

    // Shown once…
    expect(result.credential.type).toBe('temporary_password');
    expect(result.credential.temporaryPassword).toBeTruthy();
    expect(result.credential.mustChangePassword).toBe(true);
    expect(result.credential.deliveryStatus).toBe('unavailable');
    // …and never persisted.
    expect(await dumpDatabase()).not.toContain(result.credential.temporaryPassword);

    // Lock and failure counter cleared, account returned to service.
    const user = await ctx.db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirstOrThrow();
    expect(user.failed_login_count).toBe(0);
    expect(user.locked_until).toBeNull();
    expect(user.status).toBe('active');
    expect(user.must_change_password).toBe(true);

    // Every session the OLD password created is dead.
    expect(result.credential.revokedSessions).toBeGreaterThanOrEqual(2);
    const live = await ctx.db
      .selectFrom('auth_sessions')
      .select('id')
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
    expect(live).toHaveLength(0);
    for (const cookies of sessions) {
      const probe = await ctx.app.inject({ method: 'GET', url: '/api/auth/session', headers: authHeaders(cookies) });
      expect(probe.json().authenticated).toBe(false);
    }

    // The new password works and the old one does not.
    const oldAttempt = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'locked-out@acme.test', password: TEST_PASSWORD },
    });
    expect(oldAttempt.statusCode).toBe(401);

    const newAttempt = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'locked-out@acme.test', password: result.credential.temporaryPassword },
    });
    expect(newAttempt.statusCode).toBe(200);
    expect(newAttempt.json().mustChangePassword).toBe(true);
  });

  it('records the reset in the audit trail without the credential', async () => {
    const admin = await operator();
    const customer = await register('audited-reset@acme.test');

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${customer.userId}/reset-password`,
      headers: authHeaders(admin.cookies),
      payload: { mode: 'temporary', reason: 'Lost device.' },
    });
    const password = response.json().credential.temporaryPassword;

    const entry = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'member.password_reset_temporary')
      .executeTakeFirstOrThrow();
    expect(entry.target_id).toBe(customer.userId);
    expect(entry.actor_user_id).toBe(admin.userId);
    expect(JSON.stringify(entry.metadata)).not.toContain(password);
    expect(JSON.stringify(entry.metadata)).toContain('Lost device.');
  });

  it('issues a single-use link that reports its delivery status honestly', async () => {
    const admin = await operator();
    const customer = await register('link-reset@acme.test');

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${customer.userId}/reset-password`,
      headers: authHeaders(admin.cookies),
      payload: { mode: 'link', reason: 'Prefers email.' },
    });
    expect(response.statusCode).toBe(200);
    const result = response.json();

    expect(result.credential.type).toBe('invitation');
    expect(result.credential.deliveryStatus).toBe('unavailable');
    expect(result.credential.message).toBe(
      'Password reset link could not be sent because email delivery is not configured. Copy the link and give it to the account holder through a channel you trust.',
    );
    expect(result.credential.message).not.toMatch(/email sent/i);
    // A link does not change the password, so existing sessions survive.
    expect(result.credential.revokedSessions).toBe(0);

    // Issuing a second link supersedes the first, so only one is ever live.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${customer.userId}/reset-password`,
      headers: authHeaders(admin.cookies),
      payload: { mode: 'link' },
    });
    const live = await ctx.db
      .selectFrom('password_reset_tokens')
      .select('id')
      .where('user_id', '=', customer.userId)
      .where('used_at', 'is', null)
      .execute();
    expect(live).toHaveLength(1);
  });

  it('never exposes or verifies the existing password', async () => {
    const admin = await operator();
    const customer = await register('secretive@acme.test');

    // No administrator surface returns password material for the account…
    for (const url of [
      `/api/admin/members/${customer.userId}`,
      '/api/admin/members',
      `/api/admin/users/${customer.userId}`,
    ]) {
      const response = await ctx.app.inject({ method: 'GET', url, headers: authHeaders(admin.cookies) });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(TEST_PASSWORD);
      expect(response.body.toLowerCase()).not.toContain('$argon2');
      expect(response.body).not.toContain('password_hash');
    }

    // …and the reset response carries only the NEW credential, never the old.
    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${customer.userId}/reset-password`,
      headers: authHeaders(admin.cookies),
      payload: { mode: 'temporary' },
    });
    expect(reset.body).not.toContain(TEST_PASSWORD);
  });

  it('refuses to let an administrator reset their own password here', async () => {
    const admin = await operator();
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${admin.userId}/reset-password`,
      headers: authHeaders(admin.cookies),
      payload: { mode: 'temporary' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/change password/i);
  });

  it('is refused to a support operator, who may read but not issue credentials', async () => {
    await operator('super_admin');
    const support = await operator('support');
    const customer = await register('support-cannot@acme.test');

    // Reading is allowed…
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/members/${customer.userId}`,
      headers: authHeaders(support.cookies),
    });
    expect(read.statusCode).toBe(200);

    // …issuing a credential is not.
    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${customer.userId}/reset-password`,
      headers: authHeaders(support.cookies),
      payload: { mode: 'temporary' },
    });
    expect(reset.statusCode).toBe(403);
  });
});

/* ══ 9: the member drawer discloses nothing sensitive ═════════════════════ */

describe('member detail', () => {
  it('shows identity, organization, subscription and security facts', async () => {
    const admin = await operator();
    const { body } = await createSubscriberViaApi(admin.cookies, { email: 'detailed@newco.test' });

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/members/${body.userId}`,
      headers: authHeaders(admin.cookies),
    });
    expect(response.statusCode).toBe(200);
    const member = response.json().member;

    expect(member.identity).toMatchObject({
      userId: body.userId,
      email: 'detailed@newco.test',
      emailVerified: false,
      accountStatus: 'active',
      failedLoginCount: 0,
      locked: false,
      platformRoles: [],
    });
    expect(member.organizations).toHaveLength(1);
    expect(member.organizations[0]).toMatchObject({ role: 'owner', isOwner: true, primary: true });

    // The SUBSCRIPTION belongs to the organization, and says so.
    expect(member.subscription.organizationId).toBe(body.organizationId);
    expect(member.subscription.status).toBe('active');
    expect(member.subscription.entitlementActive).toBe(true);
    expect(Array.isArray(member.subscription.modules)).toBe(true);

    expect(member.security).toMatchObject({ activeSessionCount: 0, mustChangePassword: true });
    expect(member.security.hasPendingResetToken).toBe(true);
    expect(Array.isArray(member.administration.auditHistory)).toBe(true);
  });

  it('excludes hashes, tokens and every other secret', async () => {
    const admin = await operator();
    const customer = await register('nosecrets@acme.test');
    await login(ctx, 'nosecrets@acme.test');
    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${customer.userId}/reset-password`,
      headers: authHeaders(admin.cookies),
      payload: { mode: 'link' },
    });

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/members/${customer.userId}`,
      headers: authHeaders(admin.cookies),
    });
    const raw = response.body.toLowerCase();

    for (const marker of [
      'password_hash',
      'passwordhash',
      '$argon2',
      'token_hash',
      'tokenhash',
      'csrf',
      'normalized_email',
      'database_url',
      'session_secret',
    ]) {
      expect(raw).not.toContain(marker);
    }

    // Session presence is reported as a COUNT, with no session identifier.
    const member = response.json().member;
    expect(typeof member.security.activeSessionCount).toBe('number');
    expect(member.security.activeSessionCount).toBeGreaterThan(0);
    const sessionIds = await ctx.db.selectFrom('auth_sessions').select('id').execute();
    for (const row of sessionIds) expect(response.body).not.toContain(row.id);
  });
});

/* ══ 10, 11, 12, 13: package assignment ══════════════════════════════════ */

describe('assigning a package', () => {
  /** A subscriber on the CHEAPEST plan, with a second member. */
  async function tenantOnBasePlan(): Promise<{
    admin: { cookies: SessionCookies; userId: string };
    organizationId: string;
    ownerUserId: string;
    colleagueUserId: string;
  }> {
    const admin = await operator();
    const { body } = await createSubscriberViaApi(admin.cookies, {
      email: 'plan-owner@growco.test',
      organizationLegalName: 'GrowCo LLC',
      planId: (await plan('core')).id,
      seatAllowance: 5,
    });
    const organizationId = body.organizationId as string;

    const invite = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/organizations/${organizationId}/members/invite`,
      headers: authHeaders(admin.cookies),
      payload: { email: 'colleague@growco.test', fullName: 'Colleague Chris', role: 'accountant' },
    });
    expect(invite.statusCode).toBe(201);

    return {
      admin,
      organizationId,
      ownerUserId: body.userId as string,
      colleagueUserId: invite.json().member.userId,
    };
  }

  it('recalculates the organization entitlement, not a user entitlement', async () => {
    const { admin, organizationId } = await tenantOnBasePlan();
    const target = await plan('enterprise');

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/assign-package`,
      headers: authHeaders(admin.cookies),
      payload: {
        planId: target.id,
        modules: ['manufacturing'],
        status: 'active',
        reason: 'Negotiated upgrade at renewal.',
      },
    });
    expect(response.statusCode).toBe(200);
    const result = response.json();

    expect(result.newPlanCode).toBe(target.code);
    expect(result.entitlements.active).toBe(true);
    expect(result.entitlements.planCode).toBe(target.code);
    // Optional modules are added ON TOP of the plan's own.
    expect(result.entitlements.modules).toContain('manufacturing');
    for (const module of target.modules) expect(result.entitlements.modules).toContain(module);

    // The stored entitlement agrees, and is keyed by ORGANIZATION.
    const stored = await getEntitlements(ctx.db, organizationId);
    expect(stored.planCode).toBe(target.code);
    expect(stored.modules).toContain('manufacturing');
    const rows = await ctx.db
      .selectFrom('organization_entitlements')
      .select('organization_id')
      .where('organization_id', '=', organizationId)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('changes the package for every member of the organization, not just one', async () => {
    const { admin, organizationId, ownerUserId, colleagueUserId } = await tenantOnBasePlan();
    const target = await plan('enterprise');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/assign-package`,
      headers: authHeaders(admin.cookies),
      payload: { planId: target.id, status: 'active', reason: 'Tenant-wide upgrade.' },
    });

    // Both members report the SAME organization package — because there is only
    // one, and it hangs off the organization.
    for (const userId of [ownerUserId, colleagueUserId]) {
      const detail = await ctx.app.inject({
        method: 'GET',
        url: `/api/admin/members/${userId}`,
        headers: authHeaders(admin.cookies),
      });
      expect(detail.json().member.subscription).toMatchObject({
        organizationId,
        planCode: target.code,
      });
    }

    // And there is exactly one subscription for the tenant, not one per member.
    const subscriptions = await ctx.db
      .selectFrom('subscriptions')
      .select('id')
      .where('organization_id', '=', organizationId)
      .execute();
    expect(subscriptions).toHaveLength(1);

    // The audit entry names the ORGANIZATION as the target and says so explicitly.
    const entry = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'subscription.package_assigned')
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(entry.target_type).toBe('organization');
    expect(entry.target_id).toBe(organizationId);
    expect(JSON.stringify(entry.metadata)).toContain('"scope":"organization"');
  });

  it('preserves the package history and the audit record of every change', async () => {
    const { admin, organizationId } = await tenantOnBasePlan();
    // core → enterprise → core, so the history holds one of each direction.
    const first = await plan('enterprise');
    const second = await plan('core');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/assign-package`,
      headers: authHeaders(admin.cookies),
      payload: { planId: first.id, status: 'active', reason: 'Upgrade for the new financial year.' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/assign-package`,
      headers: authHeaders(admin.cookies),
      payload: { planId: second.id, status: 'active', reason: 'Customer scaled back.' },
    });

    const history = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/admin/subscribers/${organizationId}/package-history`,
        headers: authHeaders(admin.cookies),
      })
    ).json().history;

    // Creation, upgrade and downgrade — nothing overwritten.
    expect(history.length).toBe(3);
    expect(history[0]).toMatchObject({
      previousPlanCode: first.code,
      newPlanCode: second.code,
      reason: 'Customer scaled back.',
      direction: 'downgrade',
    });
    expect(history[1]).toMatchObject({ newPlanCode: first.code, reason: 'Upgrade for the new financial year.' });
    expect(history[2]).toMatchObject({ direction: 'initial', previousPlanCode: null });
    expect(history[0].changedByUserId).toBe(admin.userId);

    const audits = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'subscription.package_assigned')
      .execute();
    expect(audits).toHaveLength(2);
    for (const entry of audits) {
      expect(entry.actor_user_id).toBe(admin.userId);
      expect(JSON.stringify(entry.metadata)).toMatch(/reason/);
    }
  });

  it('reports downgrade consequences before anything is confirmed', async () => {
    const { admin, organizationId } = await tenantOnBasePlan();
    const rich = await plan('enterprise');

    // Put the tenant on the richest package first, with room for members.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/assign-package`,
      headers: authHeaders(admin.cookies),
      payload: { planId: rich.id, status: 'active', seatOverride: 10, reason: 'Baseline.' },
    });

    const poor = await plan('core');
    const preview = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/subscribers/${organizationId}/package-impact?planId=${poor.id}&seatOverride=1`,
      headers: authHeaders(admin.cookies),
    });
    expect(preview.statusCode).toBe(200);
    const assessment = preview.json().assessment;

    expect(assessment.isDowngrade).toBe(true);
    expect(assessment.direction).toBe('downgrade');
    // The members that would be over the new allowance are NAMED, not counted.
    expect(assessment.membersOverLimit.length).toBeGreaterThan(0);
    expect(assessment.membersOverLimit[0]).toHaveProperty('email');
    expect(assessment.consequences.map((c: { code: string }) => c.code)).toContain('seats_over_limit');
    expect(assessment.modulesRemoved.length).toBeGreaterThan(0);
    expect(assessment.consequences.map((c: { code: string }) => c.code)).toContain('modules_removed');
    // Every message promises that nothing is deleted.
    const messages = assessment.consequences.map((c: { message: string }) => c.message).join(' ');
    expect(messages).toMatch(/nothing is deleted|not removed automatically|retained/i);

    // The PREVIEW changed nothing.
    const unchanged = await getEntitlements(ctx.db, organizationId);
    expect(unchanged.planCode).toBe(rich.code);
  });

  it('downgrades without deleting a single accounting or member record', async () => {
    const { admin, organizationId, colleagueUserId } = await tenantOnBasePlan();
    const rich = await plan('enterprise');
    const poor = await plan('core');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/assign-package`,
      headers: authHeaders(admin.cookies),
      payload: { planId: rich.id, status: 'active', seatOverride: 10, reason: 'Baseline.' },
    });

    const membersBefore = await ctx.db
      .selectFrom('organization_memberships')
      .select('id')
      .where('organization_id', '=', organizationId)
      .execute();

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/assign-package`,
      headers: authHeaders(admin.cookies),
      payload: {
        planId: poor.id,
        seatOverride: 1,
        status: 'active',
        reason: 'Customer requested a smaller package.',
        acknowledgedConsequences: ['seats_over_limit', 'modules_removed'],
      },
    });
    expect(response.statusCode).toBe(200);
    // The server re-ran the assessment and returned it with the result.
    expect(response.json().direction).toBe('downgrade');
    expect(response.json().consequences.length).toBeGreaterThan(0);

    // Everyone is still a member, including the one over the new limit.
    const membersAfter = await ctx.db
      .selectFrom('organization_memberships')
      .select('id')
      .where('organization_id', '=', organizationId)
      .execute();
    expect(membersAfter).toHaveLength(membersBefore.length);
    expect(
      await ctx.db
        .selectFrom('organization_memberships')
        .select('id')
        .where('user_id', '=', colleagueUserId)
        .executeTakeFirst(),
    ).toBeDefined();

    // The acknowledgement is on the record.
    const entry = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'subscription.package_assigned')
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(entry.metadata)).toContain('seats_over_limit');
  });

  it('requires a reason', async () => {
    const { admin, organizationId } = await tenantOnBasePlan();
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/assign-package`,
      headers: authHeaders(admin.cookies),
      payload: { planId: (await plan('enterprise')).id },
    });
    expect(response.statusCode).toBe(400);
  });
});

/* ══ Subscriber lifecycle ═════════════════════════════════════════════════ */

describe('subscriber lifecycle', () => {
  async function subscriber(): Promise<{ admin: { cookies: SessionCookies; userId: string }; organizationId: string; ownerUserId: string }> {
    const admin = await operator();
    const { body } = await createSubscriberViaApi(admin.cookies, { email: 'lifecycle@newco.test' });
    return { admin, organizationId: body.organizationId as string, ownerUserId: body.userId as string };
  }

  it('suspends, then restores, without deleting anything', async () => {
    const { admin, organizationId } = await subscriber();

    const suspend = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/subscribers/${organizationId}/status`,
      headers: authHeaders(admin.cookies),
      payload: { action: 'suspend', reason: 'Payment dispute.' },
    });
    expect(suspend.statusCode).toBe(200);
    expect(suspend.json().organizationStatus).toBe('suspended');
    expect(suspend.json().entitlements.active).toBe(false);

    const restore = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/subscribers/${organizationId}/status`,
      headers: authHeaders(admin.cookies),
      payload: { action: 'restore', reason: 'Dispute resolved.' },
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json().organizationStatus).toBe('active');
    expect(restore.json().entitlements.active).toBe(true);

    // Archiving is not deletion either.
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/subscribers/${organizationId}/status`,
      headers: authHeaders(admin.cookies),
      payload: { action: 'archive', reason: 'Customer left.' },
    });
    const organization = await ctx.db
      .selectFrom('organizations')
      .selectAll()
      .where('id', '=', organizationId)
      .executeTakeFirstOrThrow();
    // `archived`, not `closed`: a dedicated, restorable state that retains
    // everything, rather than the older "this customer left" terminal status.
    expect(organization.status).toBe('archived');
  });

  it('refuses to transfer ownership to an existing member', async () => {
    const { admin, organizationId, ownerUserId } = await subscriber();

    const invite = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/organizations/${organizationId}/members/invite`,
      headers: authHeaders(admin.cookies),
      payload: { email: 'successor@newco.test', fullName: 'Successor Sam', role: 'accountant' },
    });
    const successorId = invite.json().member.userId;

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/change-owner`,
      headers: authHeaders(admin.cookies),
      payload: { newOwnerUserId: successorId, reason: 'Founder stepped down.' },
    });
    expect(response.statusCode).toBe(409);

    const memberships = await ctx.db
      .selectFrom('organization_memberships')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .execute();
    const byUser = new Map(memberships.map((m) => [m.user_id, m]));
    expect(byUser.get(successorId)!.role).toBe('accountant');
    expect(byUser.get(ownerUserId)!.role).toBe('owner');
    expect(memberships.filter((m) => m.role === 'owner' && m.status === 'active')).toHaveLength(1);
  });

  it('refuses to hand a tenant to someone who is not a member, or to an operator', async () => {
    const { admin, organizationId } = await subscriber();
    const outsider = await register('outsider@elsewhere.test');

    const notAMember = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/change-owner`,
      headers: authHeaders(admin.cookies),
      payload: { newOwnerUserId: outsider.userId, reason: 'Wrong person.' },
    });
    expect(notAMember.statusCode).toBe(409);

    // An operator must never become a tenant owner.
    await ctx.db
      .insertInto('organization_memberships')
      .values({ organization_id: organizationId, user_id: admin.userId, role: 'viewer', status: 'active' })
      .execute();
    const operatorAttempt = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/change-owner`,
      headers: authHeaders(admin.cookies),
      payload: { newOwnerUserId: admin.userId, reason: 'Should be refused.' },
    });
    expect(operatorAttempt.statusCode).toBe(409);
  });
});

/* ══ 14, 15, 16: authorization ════════════════════════════════════════════ */

describe('authorization', () => {
  const ADMIN_MEMBER_ROUTES = [
    { method: 'GET' as const, url: '/api/admin/members' },
    { method: 'GET' as const, url: '/api/admin/subscribers' },
  ];

  it('refuses an unauthenticated caller', async () => {
    for (const route of ADMIN_MEMBER_ROUTES) {
      const response = await ctx.app.inject(route);
      expect(response.statusCode).toBe(401);
    }
  });

  it('refuses an ordinary subscriber, including an organization owner', async () => {
    const admin = await operator();
    const { body } = await createSubscriberViaApi(admin.cookies, { email: 'justacustomer@acme.test' });
    // Sign the owner in with their temporary password and get past the gate.
    const password = (body.credential as { temporaryPassword: string }).temporaryPassword;
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'justacustomer@acme.test', password },
    });
    const raw = first.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : [String(raw)];
    const find = (name: string): string => {
      const match = list.find((c) => c.startsWith(`${name}=`));
      return match ? (match.split(';')[0]?.split('=').slice(1).join('=') ?? '') : '';
    };
    // The chosen password must not contain the account holder's name, so it is
    // deliberately unrelated to "Nadia Owner".
    const chosen = 'Bright-Ledger-58-Sky';
    const change = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: authHeaders({ session: find('ledgora_session'), csrf: find('ledgora_csrf') }),
      payload: { currentPassword: password, newPassword: chosen },
    });
    expect(change.statusCode).toBe(200);
    const owner = await login(ctx, 'justacustomer@acme.test', chosen);

    for (const route of [
      ...ADMIN_MEMBER_ROUTES,
      { method: 'GET' as const, url: `/api/admin/members/${body.userId}` },
      { method: 'GET' as const, url: `/api/admin/subscribers/${body.organizationId}` },
    ]) {
      const response = await ctx.app.inject({ ...route, headers: authHeaders(owner) });
      expect(response.statusCode).toBe(403);
    }

    const write = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${body.userId}/reset-password`,
      headers: authHeaders(owner),
      payload: { mode: 'temporary' },
    });
    expect(write.statusCode).toBe(403);
  });

  it('ignores a platform role claimed by the browser', async () => {
    const customer = await register('forger@acme.test');

    // Every channel a client could try: body, query string and headers.
    const forgedHeaders = {
      ...authHeaders(customer.cookies),
      'x-platform-role': 'super_admin',
      'x-ledgora-role': 'super_admin',
      'x-admin': 'true',
    };

    const read = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/members?platformRole=super_admin&isAdmin=true',
      headers: forgedHeaders,
    });
    expect(read.statusCode).toBe(403);

    const write = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/subscribers',
      headers: forgedHeaders,
      payload: {
        platformRole: 'super_admin',
        platformRoles: ['super_admin'],
        fullName: 'Forged Frank',
        email: 'forged@acme.test',
        organizationLegalName: 'Forged Ltd',
        country: 'AE',
        baseCurrency: 'AED',
        planId: (await plans())[0]!.id,
      },
    });
    expect(write.statusCode).toBe(403);
    // And nothing was created.
    expect(
      await ctx.db.selectFrom('organizations').select('id').where('legal_name', '=', 'Forged Ltd').execute(),
    ).toHaveLength(0);
  });

  it('blocks a subscriber from reading another tenant’s members', async () => {
    const admin = await operator();
    const acme = await createSubscriberViaApi(admin.cookies, {
      email: 'acme-owner@acme.test',
      organizationLegalName: 'Acme Holdings',
    });
    const globex = await createSubscriberViaApi(admin.cookies, {
      email: 'globex-owner@globex.test',
      organizationLegalName: 'Globex Industries',
    });

    // A plain registered customer with their own organization.
    const intruder = await register('intruder@own.test');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: authHeaders(intruder.cookies),
      payload: { legalName: 'Intruder Ltd', country: 'AE' },
    });

    // Naming someone else's organization buys nothing — the capability guard
    // refuses before the id is even looked at.
    for (const organizationId of [acme.body.organizationId, globex.body.organizationId]) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/admin/organizations/${organizationId}/members`,
        headers: authHeaders(intruder.cookies),
      });
      expect(response.statusCode).toBe(403);
    }

    // Their own roster is derived from their membership and contains only them.
    const own = await ctx.app.inject({
      method: 'GET',
      url: '/api/organizations/current/members',
      headers: authHeaders(intruder.cookies),
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().members).toHaveLength(1);
    expect(own.json().members[0].email).toBe('intruder@own.test');
    expect(own.body).not.toContain('acme-owner@acme.test');
    expect(own.body).not.toContain('globex-owner@globex.test');
  });

  it('scopes an operator directory query to the organization asked for', async () => {
    const admin = await operator();
    const acme = await createSubscriberViaApi(admin.cookies, {
      email: 'a-owner@acme.test',
      organizationLegalName: 'Acme Holdings',
    });
    await createSubscriberViaApi(admin.cookies, {
      email: 'g-owner@globex.test',
      organizationLegalName: 'Globex Industries',
    });

    const scoped = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/members?organizationId=${acme.body.organizationId}`,
      headers: authHeaders(admin.cookies),
    });
    expect(scoped.statusCode).toBe(200);
    const emails = scoped.json().members.map((m: { email: string }) => m.email);
    expect(emails).toEqual(['a-owner@acme.test']);
    expect(scoped.body).not.toContain('g-owner@globex.test');
  });
});

/* ══ 17: safeguards ══════════════════════════════════════════════════════ */

describe('safeguards', () => {
  it('refuses to remove an organization’s last active owner', async () => {
    const admin = await operator();
    const { body } = await createSubscriberViaApi(admin.cookies, { email: 'sole-owner@newco.test' });
    const organizationId = body.organizationId as string;
    const ownerUserId = body.userId as string;

    // Demotion is refused…
    const demote = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/members/${ownerUserId}/membership`,
      headers: authHeaders(admin.cookies),
      payload: { organizationId, role: 'viewer' },
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.message).toMatch(/subscriber owner is permanent/i);

    // …suspension of the membership too…
    const suspend = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/members/${ownerUserId}/membership`,
      headers: authHeaders(admin.cookies),
      payload: { organizationId, status: 'suspended' },
    });
    expect(suspend.statusCode).toBe(409);

    // …and removal from the organization.
    const remove = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/organizations/${organizationId}/members/${ownerUserId}`,
      headers: authHeaders(admin.cookies),
    });
    expect(remove.statusCode).toBe(409);

    // The owner is untouched.
    const membership = await ctx.db
      .selectFrom('organization_memberships')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('user_id', '=', ownerUserId)
      .executeTakeFirstOrThrow();
    expect(membership.role).toBe('owner');
    expect(membership.status).toBe('active');
  });

  it('never creates a second owner or demotes the immutable subscriber', async () => {
    const admin = await operator();
    const { body } = await createSubscriberViaApi(admin.cookies, { email: 'first-owner@newco.test' });
    const organizationId = body.organizationId as string;

    const invite = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/organizations/${organizationId}/members/invite`,
      headers: authHeaders(admin.cookies),
      payload: { email: 'second@newco.test', fullName: 'Second Owner', role: 'accountant' },
    });
    const secondId = invite.json().member.userId;

    const promote = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/members/${secondId}/membership`,
      headers: authHeaders(admin.cookies),
      payload: { organizationId, role: 'owner', status: 'active' },
    });
    expect(promote.statusCode).toBe(409);

    const demote = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/members/${body.userId}/membership`,
      headers: authHeaders(admin.cookies),
      payload: { organizationId, role: 'accountant' },
    });
    expect(demote.statusCode).toBe(409);
  });

  it('refuses to let an administrator disable their own account', async () => {
    const admin = await operator();
    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/members/${admin.userId}/status`,
      headers: authHeaders(admin.cookies),
      payload: { status: 'disabled', reason: 'Testing self-lockout.' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/your own account/i);

    const user = await ctx.db.selectFrom('users').selectAll().where('id', '=', admin.userId).executeTakeFirstOrThrow();
    expect(user.status).toBe('active');
  });

  it('refuses to disable the last active platform super administrator', async () => {
    const admin = await operator();

    /*
     * Reached through the SERVICE rather than the route, because the HTTP guard
     * requires the caller to be a super_admin — so over HTTP the caller is
     * always the surviving one. The invariant must hold for every caller,
     * including a future CLI or automation path, which is why it lives in the
     * service and is asserted there.
     */
    await expect(
      setMemberAccountStatus(ctx.db, admin.userId, 'disabled', 'Automated cleanup.', {
        actorUserId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        actorPlatformRole: 'super_admin',
      }),
    ).rejects.toThrow(/last active platform super administrator/i);

    const user = await ctx.db.selectFrom('users').selectAll().where('id', '=', admin.userId).executeTakeFirstOrThrow();
    expect(user.status).toBe('active');

    // With a second super administrator in place, the change is permitted.
    const second = await seedUser(ctx, { email: 'second-admin@ledgora.test', platformRoles: ['super_admin'] });
    const result = await setMemberAccountStatus(ctx.db, admin.userId, 'disabled', 'Handover complete.', {
      actorUserId: second.id,
      actorPlatformRole: 'super_admin',
    });
    expect(result.accountStatus).toBe('disabled');
  });

  it('disables a customer account, revoking their sessions immediately', async () => {
    const admin = await operator();
    const customer = await register('tobedisabled@acme.test');

    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/members/${customer.userId}/status`,
      headers: authHeaders(admin.cookies),
      payload: { status: 'disabled', reason: 'Fraud investigation.' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().revokedSessions).toBeGreaterThan(0);

    const probe = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: authHeaders(customer.cookies),
    });
    expect(probe.json().authenticated).toBe(false);
  });
});

/* ══ Account maintenance ═════════════════════════════════════════════════ */

describe('account maintenance', () => {
  it('unlocks an account without touching the password', async () => {
    const admin = await operator();
    const customer = await register('unlockme@acme.test');
    await ctx.db
      .updateTable('users')
      .set({ failed_login_count: 9, locked_until: new Date(Date.now() + 3_600_000), status: 'locked' })
      .where('id', '=', customer.userId)
      .execute();
    const hashBefore = (
      await ctx.db.selectFrom('users').select('password_hash').where('id', '=', customer.userId).executeTakeFirstOrThrow()
    ).password_hash;

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${customer.userId}/unlock`,
      headers: authHeaders(admin.cookies),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accountStatus: 'active', failedLoginCount: 0 });

    const after = await ctx.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', customer.userId)
      .executeTakeFirstOrThrow();
    expect(after.locked_until).toBeNull();
    // The credential is untouched — the original password still works.
    expect(after.password_hash).toBe(hashBefore);
    expect((await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'unlockme@acme.test', password: TEST_PASSWORD },
    })).statusCode).toBe(200);
  });

  it('revokes sessions on request, and refuses to do it to the caller', async () => {
    const admin = await operator();
    const customer = await register('signmeout@acme.test');
    await login(ctx, 'signmeout@acme.test');

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${customer.userId}/revoke-sessions`,
      headers: authHeaders(admin.cookies),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().revokedSessions).toBeGreaterThanOrEqual(2);

    const self = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${admin.userId}/revoke-sessions`,
      headers: authHeaders(admin.cookies),
    });
    expect(self.statusCode).toBe(400);
  });

  it('verifies an email administratively, with a reason and an audit entry', async () => {
    const admin = await operator();
    const customer = await register('verifyme@acme.test');

    const missingReason = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${customer.userId}/verify-email`,
      headers: authHeaders(admin.cookies),
      payload: {},
    });
    expect(missingReason.statusCode).toBe(400);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${customer.userId}/verify-email`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Identity confirmed by video call.' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().emailVerified).toBe(true);

    const entry = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'member.email_verified_by_admin')
      .executeTakeFirstOrThrow();
    expect(entry.target_id).toBe(customer.userId);
    expect(JSON.stringify(entry.metadata)).toContain('byAdministrator');

    // Verifying twice is refused rather than silently repeated.
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${customer.userId}/verify-email`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Again.' },
    });
    expect(again.statusCode).toBe(409);
  });
});

/* ══ 18 (server half): search, filters, sorting, pagination ══════════════ */

describe('directory and roster queries', () => {
  async function seedPeople(): Promise<SessionCookies> {
    const admin = await operator();
    await createSubscriberViaApi(admin.cookies, {
      fullName: 'Alice Anderson',
      email: 'alice@alpha.test',
      organizationLegalName: 'Alpha Holdings',
    });
    await createSubscriberViaApi(admin.cookies, {
      fullName: 'Bob Brown',
      email: 'bob@beta.test',
      organizationLegalName: 'Beta Trading',
      paymentConfirmed: false,
    });
    await register('carol@gamma.test', 'Carol Clark');
    return admin.cookies;
  }

  it('searches name, email and organization', async () => {
    const admin = await seedPeople();
    const search = async (term: string) =>
      (
        await ctx.app.inject({
          method: 'GET',
          url: `/api/admin/members?search=${encodeURIComponent(term)}`,
          headers: authHeaders(admin),
        })
      ).json();

    expect((await search('Alice')).members).toHaveLength(1);
    expect((await search('bob@beta')).members).toHaveLength(1);
    expect((await search('Beta Trading')).members[0].email).toBe('bob@beta.test');
    expect((await search('nobody')).members).toHaveLength(0);
    // A wildcard is a literal, not a pattern that matches everyone.
    expect((await search('%')).members).toHaveLength(0);
  });

  it('filters by organization, role, account status, verification and audience', async () => {
    const admin = await seedPeople();
    const query = async (qs: string) =>
      (await ctx.app.inject({ method: 'GET', url: `/api/admin/members?${qs}`, headers: authHeaders(admin) })).json();

    expect((await query('role=owner')).members.map((m: { email: string }) => m.email).sort()).toEqual([
      'alice@alpha.test',
      'bob@beta.test',
    ]);
    // Carol registered but never onboarded — no membership, so no role.
    expect((await query('verification=unverified')).members.length).toBeGreaterThan(0);
    expect((await query('audience=platform')).members.map((m: { email: string }) => m.email)).toEqual([
      'super_admin@ledgora.test',
    ]);
    const customers = (await query('audience=customer')).members.map((m: { email: string }) => m.email);
    expect(customers).toContain('carol@gamma.test');
    expect(customers).not.toContain('super_admin@ledgora.test');
    expect((await query('accountStatus=active')).members.length).toBeGreaterThan(0);
  });

  it('sorts and paginates with a stable total', async () => {
    const admin = await seedPeople();
    const ascending = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/admin/members?sort=full_name&direction=asc&audience=customer',
        headers: authHeaders(admin),
      })
    ).json();
    expect(ascending.members.map((m: { fullName: string }) => m.fullName)).toEqual([
      'Alice Anderson',
      'Bob Brown',
      'Carol Clark',
    ]);

    const first = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/admin/members?sort=full_name&direction=asc&audience=customer&limit=2&offset=0',
        headers: authHeaders(admin),
      })
    ).json();
    const second = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/admin/members?sort=full_name&direction=asc&audience=customer&limit=2&offset=2',
        headers: authHeaders(admin),
      })
    ).json();

    expect(first.members).toHaveLength(2);
    expect(second.members).toHaveLength(1);
    expect(first.pagination.total).toBe(3);
    expect(second.pagination.total).toBe(3);
    expect(first.members.map((m: { userId: string }) => m.userId)).not.toContain(second.members[0].userId);
  });

  it('rejects a sort field that is not on the whitelist', async () => {
    const admin = await operator();
    for (const url of ['/api/admin/members?sort=password_hash', '/api/admin/subscribers?sort=password_hash']) {
      const response = await ctx.app.inject({ method: 'GET', url, headers: authHeaders(admin.cookies) });
      expect(response.statusCode).toBe(400);
    }
  });

  it('lists subscribers with plan, status, seats, owner and renewal date', async () => {
    const admin = await seedPeople();
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/subscribers?sort=legal_name&direction=asc',
      headers: authHeaders(admin),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.subscribers.map((s: { legalName: string }) => s.legalName)).toEqual([
      'Alpha Holdings',
      'Beta Trading',
    ]);
    expect(body.subscribers[0]).toMatchObject({
      organizationStatus: 'active',
      subscriptionStatus: 'active',
      ownerEmail: 'alice@alpha.test',
      seatsUsed: 1,
      entitlementActive: true,
    });
    expect(body.subscribers[0].planCode).toBeTruthy();
    expect(body.subscribers[0].renewsAt).toBeTruthy();
    // Beta's payment was not confirmed, so it is not entitled.
    expect(body.subscribers[1]).toMatchObject({ subscriptionStatus: 'pending_payment', entitlementActive: false });

    expect(body.statusCounts.all).toBe(2);
    expect(body.pagination.total).toBe(2);
  });

  it('filters subscribers by status and search', async () => {
    const admin = await seedPeople();
    const query = async (qs: string) =>
      (await ctx.app.inject({ method: 'GET', url: `/api/admin/subscribers?${qs}`, headers: authHeaders(admin) })).json();

    expect((await query('subscriptionStatus=active')).subscribers).toHaveLength(1);
    expect((await query('search=Beta')).subscribers[0].legalName).toBe('Beta Trading');
    expect((await query('search=alice@alpha')).subscribers[0].legalName).toBe('Alpha Holdings');
    expect((await query('status=suspended')).subscribers).toHaveLength(0);
  });

  it('never leaks internal notes into the roster', async () => {
    const admin = await operator();
    await createSubscriberViaApi(admin.cookies, {
      email: 'noted@newco.test',
      internalNotes: 'Do not discuss pricing with this contact.',
    });

    const roster = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/subscribers',
      headers: authHeaders(admin.cookies),
    });
    expect(roster.body).not.toContain('Do not discuss pricing');

    // The detail view an operator opens deliberately does show them.
    const organizationId = roster.json().subscribers[0].organizationId;
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/subscribers/${organizationId}`,
      headers: authHeaders(admin.cookies),
    });
    expect(detail.json().internalNotes).toBe('Do not discuss pricing with this contact.');
  });
});

/* ══ 20: existing behaviour is untouched ═════════════════════════════════ */

describe('existing behaviour', () => {
  it('leaves self-registration, the applicant roster and Free Preview intact', async () => {
    const admin = await operator();
    const customer = await register('still-works@acme.test', 'Still Works');

    // The applicant roster still sees a brand-new registration.
    const applicants = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/applicants',
      headers: authHeaders(admin.cookies),
    });
    expect(applicants.statusCode).toBe(200);
    expect(
      applicants.json().applicants.find((a: { email: string }) => a.email === 'still-works@acme.test'),
    ).toMatchObject({ stage: 'registered_no_package' });

    // Onboarding still works for the customer themselves.
    const organization = await ctx.app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: authHeaders(customer.cookies),
      payload: { legalName: 'Still Works Ltd', country: 'AE' },
    });
    expect(organization.statusCode).toBe(201);

    const catalogue = await plans();
    const select = await ctx.app.inject({
      method: 'POST',
      url: '/api/subscriptions',
      headers: authHeaders(customer.cookies),
      payload: { planId: catalogue[0]!.id },
    });
    expect(select.statusCode).toBe(201);

    // Free Preview: every feature, no durable business write.
    const write = await ctx.app.inject({
      method: 'POST',
      url: '/api/ledger-entries',
      headers: authHeaders(customer.cookies),
      payload: { amount: 100 },
    });
    expect([403, 404]).toContain(write.statusCode);
    if (write.statusCode === 403) {
      expect(write.json().error.code).toBe('subscription_required_for_persistence');
    }
  });

  it('keeps the operator member context working for a viewed subscriber', async () => {
    const admin = await operator();
    const { body } = await createSubscriberViaApi(admin.cookies, {
      email: 'viewed@newco.test',
      organizationLegalName: 'Viewed Ltd',
    });

    const roster = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/organizations/${body.organizationId}/members`,
      headers: authHeaders(admin.cookies),
    });
    expect(roster.statusCode).toBe(200);
    expect(roster.json().organization.legalName).toBe('Viewed Ltd');
    expect(roster.json().members).toHaveLength(1);

    // The administrator still never becomes a member of the tenant.
    const memberships = await ctx.db
      .selectFrom('organization_memberships')
      .select('id')
      .where('user_id', '=', admin.userId)
      .execute();
    expect(memberships).toHaveLength(0);
  });

  it('reports the capabilities the operator actually holds', async () => {
    const superAdmin = await operator('super_admin');
    const support = await operator('support');

    const asSuper = (
      await ctx.app.inject({ method: 'GET', url: '/api/admin/me', headers: authHeaders(superAdmin.cookies) })
    ).json();
    expect(asSuper.capabilities).toContain('members.reset_password');
    expect(asSuper.capabilities).toContain('subscriptions.assign');
    expect(asSuper.capabilities).toContain('subscribers.create');

    const asSupport = (
      await ctx.app.inject({ method: 'GET', url: '/api/admin/me', headers: authHeaders(support.cookies) })
    ).json();
    expect(asSupport.capabilities).toContain('members.read');
    expect(asSupport.capabilities).toContain('subscribers.read');
    expect(asSupport.capabilities).not.toContain('members.reset_password');
    expect(asSupport.capabilities).not.toContain('subscriptions.assign');
    expect(asSupport.capabilities).not.toContain('subscribers.create');
  });
});

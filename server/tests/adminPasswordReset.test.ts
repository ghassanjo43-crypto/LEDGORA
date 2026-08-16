/**
 * Super-administrator password reset — the whole recovery, end to end.
 *
 * `adminConsole.test.ts` already covers the endpoint's envelope, its audit entry
 * and its capability boundary. What is proven HERE is the thing none of those
 * assert as one chain: that a reset actually recovers a locked-out customer, and
 * that the credential it issues is a dead end until it has been replaced.
 *
 *   reset → the old password stops working
 *         → the temporary one signs in
 *         → and can do NOTHING except change itself
 *         → the new permanent password opens the application
 *         → the temporary one is dead.
 *
 * Alongside that, the claims that make the operation safe to hand to an operator:
 *
 *   authority    only `members.reset_password` (super_admin) reaches it — not a
 *                billing admin, not a support operator, not an organization
 *                owner or admin, and not an unauthenticated caller;
 *   containment  it changes CREDENTIALS only. Membership, organization role,
 *                organization status, subscription and email are byte-identical
 *                afterwards;
 *   sessions     every session the TARGET holds dies; the operator's own does not;
 *   disclosure   the response carries the new password and nothing else — no
 *                hash, no old password — and the audit row carries neither.
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
import { SESSION_COOKIE } from '../src/plugins/session.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

const CHOSEN_PASSWORD = 'Harbour-Lantern-44-Zx';

/* ── Helpers ──────────────────────────────────────────────────────────────── */

async function operator(
  role: 'super_admin' | 'billing_admin' | 'support' = 'super_admin',
  email = `${role}@ledgora.test`,
): Promise<{ cookies: SessionCookies; userId: string; email: string }> {
  const user = await seedUser(ctx, { email, fullName: 'Platform Person', platformRoles: [role] });
  return { cookies: await login(ctx, email), userId: user.id, email };
}

async function planId(code = 'enterprise'): Promise<string> {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
  return response.json().plans.find((plan: { code: string }) => plan.code === code).id;
}

/** A real subscriber: organization, owner membership, active subscription. */
async function subscriber(
  admin: SessionCookies,
  email = 'owner@newco.test',
): Promise<{ email: string; userId: string; organizationId: string; temporaryPassword: string }> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/subscribers',
    headers: authHeaders(admin),
    payload: {
      fullName: 'Owner Person',
      email,
      organizationLegalName: 'NewCo Trading LLC',
      country: 'AE',
      baseCurrency: 'AED',
      planId: await planId(),
      onboarding: 'temporary',
      paymentConfirmed: true,
    },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return {
    email,
    userId: body.subscriber.userId,
    organizationId: body.subscriber.organizationId,
    temporaryPassword: body.credential.temporaryPassword,
  };
}

/** A member of an existing organization with a working password of their own. */
async function member(
  organizationId: string,
  options: { email?: string; role?: 'member' | 'admin' } = {},
): Promise<{ email: string; userId: string; cookies: SessionCookies }> {
  const email = options.email ?? 'staff@newco.test';
  const user = await seedUser(ctx, { email, fullName: 'Staff Person' });
  await ctx.db
    .insertInto('organization_memberships')
    .values({
      organization_id: organizationId,
      user_id: user.id,
      role: options.role ?? 'member',
      status: 'active',
    })
    .execute();
  return { email, userId: user.id, cookies: await login(ctx, email) };
}

const resetPassword = (
  admin: SessionCookies,
  userId: string,
  payload: Record<string, unknown> = { mode: 'temporary', reason: 'Customer lost their password.' },
) =>
  ctx.app.inject({
    method: 'POST',
    url: `/api/admin/members/${userId}/reset-password`,
    headers: authHeaders(admin),
    payload,
  });

async function attemptLogin(email: string, password: string): Promise<number> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  return response.statusCode;
}

/** The stored credential material, read straight from the table. */
async function userRow(userId: string) {
  return ctx.db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirstOrThrow();
}

/* ── The full recovery, for each persona ──────────────────────────────────── */

describe('the complete reset → forced change → normal access lifecycle', () => {
  /**
   * The whole point of the feature, as one uninterrupted sequence. Written once
   * and run for both personas, because a subscriber owner and an ordinary member
   * are the same act on the same endpoint — if they ever diverge, that is the
   * bug this shape is here to catch.
   */
  const lifecycle = async (target: { email: string; userId: string }, admin: SessionCookies) => {
    /* 1. The operator resets it. */
    const reset = await resetPassword(admin, target.userId);
    expect(reset.statusCode).toBe(200);
    const temporaryPassword: string = reset.json().credential.temporaryPassword;
    expect(temporaryPassword).toBeTruthy();
    expect(reset.json().credential.mustChangePassword).toBe(true);

    /* 2. The old password is dead the moment the reset returns. */
    expect(await attemptLogin(target.email, TEST_PASSWORD)).toBe(401);

    /* 3. The temporary one signs in, and the server SAYS a change is required. */
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: target.email, password: temporaryPassword },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().mustChangePassword).toBe(true);
    const session = await login(ctx, target.email, temporaryPassword);

    /* 4. …and that session can do NOTHING else. Not the application, not the
          member roster, not the organization it belongs to. */
    for (const url of ['/api/organizations/current', '/api/subscriptions/current', '/api/admin/me']) {
      const blocked = await ctx.app.inject({ method: 'GET', url, headers: authHeaders(session) });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().error.code).toBe('password_change_required');
    }

    /* 5. The one thing it CAN do is replace itself. */
    const change = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: authHeaders(session),
      payload: { currentPassword: temporaryPassword, newPassword: CHOSEN_PASSWORD },
    });
    expect(change.statusCode).toBe(200);

    /* 6. The flag is cleared, by the server, in the database. */
    const after = await userRow(target.userId);
    expect(after.must_change_password).toBe(false);
    // The temporary credential's deadline no longer applies to a chosen password.
    expect(after.password_expires_at).toBeNull();

    /* 7. The application opens. */
    const allowed = await ctx.app.inject({
      method: 'GET',
      url: '/api/organizations/current',
      headers: authHeaders(session),
    });
    expect(allowed.statusCode).toBe(200);

    /* 8. New password in, temporary password out. */
    expect(await attemptLogin(target.email, CHOSEN_PASSWORD)).toBe(200);
    expect(await attemptLogin(target.email, temporaryPassword)).toBe(401);

    return { temporaryPassword };
  };

  it('recovers a subscriber OWNER end to end', async () => {
    const admin = await operator();
    const owner = await subscriber(admin.cookies);

    // Put the owner past onboarding first, so the reset under test is a genuine
    // recovery of a working account rather than a re-issue of an unused one.
    const onboarding = await login(ctx, owner.email, owner.temporaryPassword);
    await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: authHeaders(onboarding),
      payload: { currentPassword: owner.temporaryPassword, newPassword: TEST_PASSWORD },
    });
    expect(await attemptLogin(owner.email, TEST_PASSWORD)).toBe(200);

    await lifecycle({ email: owner.email, userId: owner.userId }, admin.cookies);
  });

  it('recovers an ordinary MEMBER end to end', async () => {
    const admin = await operator();
    const owner = await subscriber(admin.cookies);
    const staff = await member(owner.organizationId);

    await lifecycle({ email: staff.email, userId: staff.userId }, admin.cookies);
  });

  it('leaves the application shut for a direct route attempt, not just the dashboard', async () => {
    const admin = await operator();
    const owner = await subscriber(admin.cookies);
    const staff = await member(owner.organizationId);

    const reset = await resetPassword(admin.cookies, staff.userId);
    const session = await login(ctx, staff.email, reset.json().credential.temporaryPassword);

    /*
     * The forced-change gate is DEFAULT DENY with a three-entry allow list, so
     * "type the URL of another module" is not a way past it. A route the gate's
     * author never saw is covered on the day it is written.
     */
    const probes = [
      { method: 'GET' as const, url: '/api/organizations/current/members' },
      { method: 'GET' as const, url: '/api/organizations/current/users' },
      { method: 'GET' as const, url: '/api/subscriptions/current' },
      { method: 'POST' as const, url: '/api/organizations' },
    ];
    for (const probe of probes) {
      const response = await ctx.app.inject({ ...probe, headers: authHeaders(session), payload: {} });
      expect(response.json().error.code).toBe('password_change_required');
    }

    // The three that must stay open, or the user is trapped in a session they
    // cannot use: read who you are, change the password, sign out.
    const whoami = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: authHeaders(session),
    });
    expect(whoami.json().authenticated).toBe(true);
    expect(whoami.json().user.mustChangePassword).toBe(true);
  });
});

/* ── What a reset stores ──────────────────────────────────────────────────── */

describe('what lands in the database', () => {
  it('stores an Argon2id hash and never the temporary password itself', async () => {
    const admin = await operator();
    const owner = await subscriber(admin.cookies);
    const staff = await member(owner.organizationId);
    const before = await userRow(staff.userId);

    const reset = await resetPassword(admin.cookies, staff.userId);
    const temporaryPassword: string = reset.json().credential.temporaryPassword;

    const after = await userRow(staff.userId);
    expect(after.password_hash).toMatch(/^\$argon2id\$/);
    expect(after.password_hash).not.toBe(before.password_hash);
    expect(after.password_hash).not.toContain(temporaryPassword);

    // Nowhere else either: scan every column of the row, not just the hash.
    expect(JSON.stringify(after)).not.toContain(temporaryPassword);

    // And no second credential store was invented to hold it.
    const tokens = await ctx.db
      .selectFrom('password_reset_tokens')
      .selectAll()
      .where('user_id', '=', staff.userId)
      .execute();
    for (const token of tokens) expect(JSON.stringify(token)).not.toContain(temporaryPassword);
  });

  it('sets the forced-change flag and a temporary-password deadline', async () => {
    const admin = await operator();
    const owner = await subscriber(admin.cookies);
    const staff = await member(owner.organizationId);

    const before = await userRow(staff.userId);
    expect(before.must_change_password).toBe(false);
    expect(before.password_expires_at).toBeNull();

    await resetPassword(admin.cookies, staff.userId);

    const after = await userRow(staff.userId);
    expect(after.must_change_password).toBe(true);
    expect(after.password_expires_at).not.toBeNull();
    expect(new Date(after.password_expires_at!).getTime()).toBeGreaterThan(Date.now());
  });

  it('generates a different password every time, over a policy-satisfying alphabet', async () => {
    const admin = await operator();
    const owner = await subscriber(admin.cookies);
    const staff = await member(owner.organizationId);

    const issued = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const reset = await resetPassword(admin.cookies, staff.userId);
      const password: string = reset.json().credential.temporaryPassword;
      issued.add(password);
      // The policy the account itself enforces — so the credential it issues can
      // never be one the change-password endpoint would refuse.
      expect(password.length).toBeGreaterThanOrEqual(12);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/\d/);
      // Visually ambiguous characters are excluded so it survives being read out.
      expect(password).not.toMatch(/[Il1O0]/);
    }
    expect(issued.size).toBe(5);
  });
});

/* ── Containment: credentials only ────────────────────────────────────────── */

describe('a reset changes authentication and nothing else', () => {
  it('leaves membership, role, organization, subscription and email untouched', async () => {
    const admin = await operator();
    const owner = await subscriber(admin.cookies);
    const staff = await member(owner.organizationId, { role: 'admin' });

    const snapshot = async () => ({
      membership: await ctx.db
        .selectFrom('organization_memberships')
        .selectAll()
        .where('user_id', '=', staff.userId)
        .executeTakeFirstOrThrow(),
      organization: await ctx.db
        .selectFrom('organizations')
        .selectAll()
        .where('id', '=', owner.organizationId)
        .executeTakeFirstOrThrow(),
      subscription: await ctx.db
        .selectFrom('subscriptions')
        .selectAll()
        .where('organization_id', '=', owner.organizationId)
        .executeTakeFirst(),
      platformRoles: await ctx.db
        .selectFrom('platform_user_roles')
        .select('role')
        .where('user_id', '=', staff.userId)
        .execute(),
    });

    const before = await snapshot();
    await resetPassword(admin.cookies, staff.userId);
    const after = await snapshot();

    expect(after.membership.organization_id).toBe(before.membership.organization_id);
    expect(after.membership.role).toBe('admin');
    expect(after.membership.role).toBe(before.membership.role);
    expect(after.membership.status).toBe(before.membership.status);
    expect(after.organization.status).toBe(before.organization.status);
    expect(after.organization.legal_name).toBe(before.organization.legal_name);
    expect(after.subscription?.status).toBe(before.subscription?.status);
    expect(after.platformRoles).toEqual(before.platformRoles);

    // The email is the account's identity — a credential reset must not move it.
    const user = await userRow(staff.userId);
    expect(user.email).toBe(staff.email);
  });

  it('does not resurrect a deliberately disabled account when asked to keep it disabled', async () => {
    const admin = await operator();
    const owner = await subscriber(admin.cookies);
    const staff = await member(owner.organizationId);

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/members/${staff.userId}/status`,
      headers: authHeaders(admin.cookies),
      payload: { status: 'disabled', reason: 'Left the company.' },
    });

    await resetPassword(admin.cookies, staff.userId, { mode: 'temporary', keepDisabled: true });

    const after = await userRow(staff.userId);
    expect(after.status).toBe('disabled');
  });
});

/* ── Sessions ─────────────────────────────────────────────────────────────── */

describe('session handling', () => {
  it('kills every session the target holds and none of the operator’s', async () => {
    const admin = await operator();
    const owner = await subscriber(admin.cookies);
    const staff = await member(owner.organizationId);

    // The target is signed in on two devices; so is the operator.
    const laptop = staff.cookies;
    const phone = await login(ctx, staff.email);
    const adminSecondDevice = await login(ctx, admin.email);

    const reset = await resetPassword(admin.cookies, staff.userId);
    expect(reset.json().credential.revokedSessions).toBeGreaterThanOrEqual(2);

    for (const dead of [laptop, phone]) {
      const check = await ctx.app.inject({
        method: 'GET',
        url: '/api/auth/session',
        headers: authHeaders(dead),
      });
      expect(check.json()).toEqual({ authenticated: false, user: null });
    }

    // The operator is untouched — on the session that did the work AND on the
    // other one. Resetting a customer must never sign the operator out.
    for (const live of [admin.cookies, adminSecondDevice]) {
      const check = await ctx.app.inject({
        method: 'GET',
        url: '/api/auth/session',
        headers: authHeaders(live),
      });
      expect(check.json().authenticated).toBe(true);
      expect(check.json().user.email).toBe(admin.email);
    }
  });

  it('clears a failed-attempt lock, so the reset actually recovers the account', async () => {
    const admin = await operator();
    const owner = await subscriber(admin.cookies);
    const staff = await member(owner.organizationId);

    // Lock the account the way a forgetful customer would.
    for (let i = 0; i < 6; i += 1) await attemptLogin(staff.email, 'Wrong-Guess-000');
    const locked = await userRow(staff.userId);
    expect(locked.failed_login_count > 0 || locked.locked_until !== null).toBe(true);

    const reset = await resetPassword(admin.cookies, staff.userId);
    const after = await userRow(staff.userId);
    expect(after.failed_login_count).toBe(0);
    expect(after.locked_until).toBeNull();

    // …and the issued credential genuinely works, which is the whole point.
    expect(await attemptLogin(staff.email, reset.json().credential.temporaryPassword)).toBe(200);
  });
});

/* ── Authority ────────────────────────────────────────────────────────────── */

describe('who may reset a password', () => {
  it('refuses an unauthenticated caller', async () => {
    const admin = await operator();
    const owner = await subscriber(admin.cookies);
    const staff = await member(owner.organizationId);
    const before = await userRow(staff.userId);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${staff.userId}/reset-password`,
      payload: { mode: 'temporary' },
    });

    expect(response.statusCode).toBe(401);
    expect((await userRow(staff.userId)).password_hash).toBe(before.password_hash);
    expect(await attemptLogin(staff.email, TEST_PASSWORD)).toBe(200);
  });

  it('refuses an ordinary subscriber and an organization ADMIN alike', async () => {
    const admin = await operator();
    const owner = await subscriber(admin.cookies);
    const victim = await member(owner.organizationId, { email: 'victim@newco.test' });
    // An Organization Admin: full authority inside the tenant, and no platform
    // role whatsoever. Tenant governance must not become cross-tenant authority.
    const orgAdmin = await member(owner.organizationId, {
      email: 'orgadmin@newco.test',
      role: 'admin',
    });
    const before = await userRow(victim.userId);

    for (const caller of [orgAdmin.cookies, victim.cookies]) {
      const response = await resetPassword(caller, victim.userId);
      expect(response.statusCode).toBe(403);
    }

    expect((await userRow(victim.userId)).password_hash).toBe(before.password_hash);
    expect(await attemptLogin(victim.email, TEST_PASSWORD)).toBe(200);
  });

  it('refuses billing and support operators — reading a roster is not issuing a credential', async () => {
    const admin = await operator('super_admin');
    const owner = await subscriber(admin.cookies);
    const staff = await member(owner.organizationId);
    const before = await userRow(staff.userId);

    for (const role of ['billing_admin', 'support'] as const) {
      const weaker = await operator(role);

      // They CAN read the member — that is their job.
      const read = await ctx.app.inject({
        method: 'GET',
        url: `/api/admin/members/${staff.userId}`,
        headers: authHeaders(weaker.cookies),
      });
      expect(read.statusCode).toBe(200);

      // They cannot issue a credential for them.
      const reset = await resetPassword(weaker.cookies, staff.userId);
      expect(reset.statusCode).toBe(403);
    }

    expect((await userRow(staff.userId)).password_hash).toBe(before.password_hash);
  });

  it('rejects a forged or nonexistent target rather than resetting something else', async () => {
    const admin = await operator();
    const owner = await subscriber(admin.cookies);
    const staff = await member(owner.organizationId);
    const before = await userRow(staff.userId);

    // A well-formed id nobody owns.
    const missing = await resetPassword(admin.cookies, '00000000-0000-4000-8000-000000000000');
    expect(missing.statusCode).toBe(404);

    // A malformed id.
    const malformed = await resetPassword(admin.cookies, 'not-a-user-id');
    expect([400, 404]).toContain(malformed.statusCode);

    /*
     * The target comes from the URL PATH, which the guard and the service both
     * read. A body that names somebody else changes nothing — there is no
     * `userId` field in the schema for it to bind to.
     */
    const forgedBody = await resetPassword(admin.cookies, staff.userId, {
      mode: 'temporary',
      userId: owner.userId,
      targetUserId: owner.userId,
      reason: 'Attempting to redirect the target.',
    });
    expect(forgedBody.statusCode).toBe(200);
    // The OWNER was not touched; the path's user was.
    expect(await attemptLogin(owner.email, owner.temporaryPassword)).toBe(200);
    expect((await userRow(staff.userId)).password_hash).not.toBe(before.password_hash);
  });

  it('refuses an operator resetting their OWN password here', async () => {
    const admin = await operator();
    const response = await resetPassword(admin.cookies, admin.userId);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/change password/i);
    // Their own session is intact and their own password still works.
    expect(await attemptLogin(admin.email, TEST_PASSWORD)).toBe(200);
  });

  it('requires the CSRF header, even with a valid session cookie', async () => {
    const admin = await operator();
    const owner = await subscriber(admin.cookies);
    const staff = await member(owner.organizationId);
    const before = await userRow(staff.userId);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${staff.userId}/reset-password`,
      headers: { cookie: `${SESSION_COOKIE}=${admin.cookies.session}` }, // no X-CSRF-Token
      payload: { mode: 'temporary' },
    });

    expect(response.statusCode).toBe(403);
    expect((await userRow(staff.userId)).password_hash).toBe(before.password_hash);
  });
});

/* ── Disclosure and audit ─────────────────────────────────────────────────── */

describe('nothing sensitive escapes', () => {
  it('returns the new credential and no hash, and never the old password', async () => {
    const admin = await operator();
    const owner = await subscriber(admin.cookies);
    const staff = await member(owner.organizationId);

    const reset = await resetPassword(admin.cookies, staff.userId);

    expect(reset.body).not.toContain('password_hash');
    expect(reset.body).not.toContain('passwordHash');
    expect(reset.body).not.toContain('$argon2');
    // The password the account had a moment ago is not in the response either.
    expect(reset.body).not.toContain(TEST_PASSWORD);

    // A credential-bearing response must not sit in any cache on the way back.
    expect(reset.headers['cache-control']).toMatch(/no-store/);
  });

  it('writes an audit event naming the actor and the target, carrying no credential', async () => {
    const admin = await operator();
    const owner = await subscriber(admin.cookies);
    const staff = await member(owner.organizationId);

    const reset = await resetPassword(admin.cookies, staff.userId, {
      mode: 'temporary',
      reason: 'Customer called the support line.',
    });
    const temporaryPassword: string = reset.json().credential.temporaryPassword;

    const entry = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'member.password_reset_temporary')
      .where('target_id', '=', staff.userId)
      .executeTakeFirstOrThrow();

    expect(entry.actor_user_id).toBe(admin.userId);
    expect(entry.target_type).toBe('user');

    // Everything an auditor needs…
    const metadata = JSON.stringify(entry.metadata);
    expect(metadata).toContain('Customer called the support line.');
    expect(metadata).toContain('mustChangePassword');

    // …and nothing they must never have. Scanned across the WHOLE row, not just
    // the metadata, so a future column cannot quietly become a leak.
    const whole = JSON.stringify(entry);
    expect(whole).not.toContain(temporaryPassword);
    expect(whole).not.toContain(TEST_PASSWORD);
    expect(whole).not.toContain('$argon2');
  });

  it('reveals the temporary password in exactly one response and never again', async () => {
    const admin = await operator();
    const owner = await subscriber(admin.cookies);
    const staff = await member(owner.organizationId);

    const reset = await resetPassword(admin.cookies, staff.userId);
    const temporaryPassword: string = reset.json().credential.temporaryPassword;

    // Every read surface that could plausibly echo it back.
    for (const url of [
      `/api/admin/members/${staff.userId}`,
      '/api/admin/members',
      `/api/admin/users/${staff.userId}`,
      '/api/admin/audit-logs?limit=50',
    ]) {
      const response = await ctx.app.inject({ method: 'GET', url, headers: authHeaders(admin.cookies) });
      expect(response.body).not.toContain(temporaryPassword);
    }
  });
});

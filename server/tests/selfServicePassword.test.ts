/**
 * Self-service password change — one endpoint, every persona.
 *
 * The claims this suite proves:
 *
 *   identity     the user whose password changes comes from the SESSION and
 *                from nothing else; a `userId` in the body is inert;
 *   personas     a platform super administrator, a subscriber owner and an
 *                ordinary member all use the same endpoint with the same rules,
 *                and none of them can reach another account through it;
 *   verification the current password must be right, and a wrong one is refused
 *                without saying how wrong;
 *   policy       the new password goes through the SAME policy as registration,
 *                and may not equal the current one;
 *   storage      what lands in the database is an Argon2id hash — never the
 *                password, never a second credential store;
 *   sessions     the changing session survives; every OTHER session for that
 *                user is revoked;
 *   containment  the change touches the password and nothing else — membership,
 *                role and organization are exactly as they were;
 *   disclosure   no response carries a hash, and no log path carries a password.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  authHeaders,
  createTestContext,
  login,
  readCookies,
  seedUser,
  TEST_PASSWORD,
  type SessionCookies,
  type TestContext,
} from './helpers/testApp.js';
import { LOG_REDACT_PATHS } from '../src/app.js';
import { SESSION_COOKIE } from '../src/plugins/session.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

/** A password that satisfies the policy and is nobody's name or address. */
const NEW_PASSWORD = 'Rotated-Secret-42-Ok';
const OTHER_PASSWORD = 'Second-Rotation-77-Ok';

/** Post a change-password request as the given session. */
const changePassword = (cookies: SessionCookies, payload: Record<string, unknown>) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: authHeaders(cookies),
    payload,
  });

/** The stored credential material for an account, read straight from the table. */
async function storedHash(email: string): Promise<string> {
  const row = await ctx.db
    .selectFrom('users')
    .select('password_hash')
    .where('email', '=', email.toLowerCase())
    .executeTakeFirstOrThrow();
  return row.password_hash;
}

async function attemptLogin(email: string, password: string): Promise<number> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  return response.statusCode;
}

/* ── Persona builders ─────────────────────────────────────────────────────── */

/** A LEDGORA platform operator. Holds a platform role, owns no organization. */
async function superAdmin(): Promise<{ cookies: SessionCookies; userId: string; email: string }> {
  const email = 'super@ledgora.test';
  const user = await seedUser(ctx, {
    email,
    fullName: 'Platform Operator',
    platformRoles: ['super_admin'],
  });
  return { cookies: await login(ctx, email), userId: user.id, email };
}

async function planId(code = 'enterprise'): Promise<string> {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
  return response.json().plans.find((plan: { code: string }) => plan.code === code).id;
}

/**
 * A real subscriber, created the way the console creates one: an organization,
 * an owner membership and a temporary credential handed over exactly once.
 */
async function subscriberOwner(
  admin: SessionCookies,
): Promise<{ email: string; userId: string; organizationId: string; temporaryPassword: string }> {
  const email = 'owner@newco.test';
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

/**
 * An ordinary member of an existing organization, with a working password of
 * their own — i.e. somebody past onboarding, which is the state in which a
 * VOLUNTARY password change happens.
 */
async function activeMember(
  organizationId: string,
  email = 'member@newco.test',
): Promise<{ email: string; userId: string; cookies: SessionCookies }> {
  const user = await seedUser(ctx, { email, fullName: 'Ordinary Member' });
  await ctx.db
    .insertInto('organization_memberships')
    .values({ organization_id: organizationId, user_id: user.id, role: 'member', status: 'active' })
    .execute();
  return { email, userId: user.id, cookies: await login(ctx, email) };
}

/* ── The happy path, and what it actually did ─────────────────────────────── */

describe('changing your own password', () => {
  it('accepts the change, stores an Argon2id hash and never keeps the plaintext', async () => {
    await seedUser(ctx, { email: 'jane@acme.test' });
    const before = await storedHash('jane@acme.test');
    const cookies = await login(ctx, 'jane@acme.test');

    const response = await changePassword(cookies, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(response.statusCode).toBe(200);

    const after = await storedHash('jane@acme.test');
    // A real, freshly-salted Argon2id hash — not the password, not the old hash,
    // and not some second credential format invented for this feature.
    expect(after).toMatch(/^\$argon2id\$/);
    expect(after).not.toBe(before);
    expect(after).not.toContain(NEW_PASSWORD);
    expect(after).not.toContain(TEST_PASSWORD);
  });

  it('makes the new password work and the old one stop working', async () => {
    await seedUser(ctx, { email: 'jane@acme.test' });
    const cookies = await login(ctx, 'jane@acme.test');

    await changePassword(cookies, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

    expect(await attemptLogin('jane@acme.test', NEW_PASSWORD)).toBe(200);
    expect(await attemptLogin('jane@acme.test', TEST_PASSWORD)).toBe(401);
  });

  it('writes a security audit event that records no credential material', async () => {
    await seedUser(ctx, { email: 'jane@acme.test' });
    const cookies = await login(ctx, 'jane@acme.test');
    await changePassword(cookies, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

    const entries = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'auth.password_changed')
      .execute();

    expect(entries).toHaveLength(1);
    // Whatever the row holds, it must not hold either password.
    const serialised = JSON.stringify(entries[0]);
    expect(serialised).not.toContain(NEW_PASSWORD);
    expect(serialised).not.toContain(TEST_PASSWORD);
    expect(serialised).not.toContain('$argon2id$');
  });
});

/* ── Rejections ───────────────────────────────────────────────────────────── */

describe('refusals', () => {
  beforeEach(async () => {
    await seedUser(ctx, { email: 'jane@acme.test' });
  });

  it('rejects an incorrect current password without leaking how close it was', async () => {
    const cookies = await login(ctx, 'jane@acme.test');
    const stored = await storedHash('jane@acme.test');

    const response = await changePassword(cookies, {
      // One character short of the real password: the response must be the same
      // as for a wholly unrelated guess.
      currentPassword: TEST_PASSWORD.slice(0, -1),
      newPassword: NEW_PASSWORD,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('invalid_credentials');
    expect(response.body).not.toContain('argon2');
    // Nothing changed.
    expect(await storedHash('jane@acme.test')).toBe(stored);
    expect(await attemptLogin('jane@acme.test', TEST_PASSWORD)).toBe(200);
  });

  it('rejects a new password that breaks the policy, listing the reasons', async () => {
    const cookies = await login(ctx, 'jane@acme.test');

    const response = await changePassword(cookies, {
      currentPassword: TEST_PASSWORD,
      newPassword: 'short',
    });

    // Zod refuses it below the minimum length before the policy check does; both
    // are 400 client errors and neither is a server fault.
    expect(response.statusCode).toBe(400);
    expect(await attemptLogin('jane@acme.test', TEST_PASSWORD)).toBe(200);
  });

  it('applies the SAME policy as registration — no digit, no upper case, refused', async () => {
    const cookies = await login(ctx, 'jane@acme.test');

    const response = await changePassword(cookies, {
      currentPassword: TEST_PASSWORD,
      newPassword: 'alllowercasenodigits',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('password_policy');
    const problems = response.json().error.details.problems as string[];
    expect(problems).toContain('Password must contain both upper and lower case letters.');
    expect(problems).toContain('Password must contain at least one digit.');
  });

  it('refuses a new password identical to the current one', async () => {
    const cookies = await login(ctx, 'jane@acme.test');

    const response = await changePassword(cookies, {
      currentPassword: TEST_PASSWORD,
      newPassword: TEST_PASSWORD,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/different from the current one/i);
  });

  it('rejects an unauthenticated request', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      payload: { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('unauthenticated');
    expect(await attemptLogin('jane@acme.test', TEST_PASSWORD)).toBe(200);
  });

  it('rejects a cookie-authenticated request with no CSRF token', async () => {
    const cookies = await login(ctx, 'jane@acme.test');
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie: `${SESSION_COOKIE}=${cookies.session}` },
      payload: { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
    });

    expect(response.statusCode).toBe(403);
    expect(await attemptLogin('jane@acme.test', TEST_PASSWORD)).toBe(200);
  });
});

/* ── The authority question ───────────────────────────────────────────────── */

describe('whose password changes', () => {
  /**
   * The core security property. The request body is attacker-controlled, so the
   * only acceptable answer to "whose password is this?" is the session — and a
   * `userId` alongside it must change nothing at all, not even by accident.
   */
  it('ignores a userId in the body and changes only the session owner', async () => {
    await seedUser(ctx, { email: 'attacker@acme.test' });
    const victim = await seedUser(ctx, { email: 'victim@acme.test' });
    const victimHash = await storedHash('victim@acme.test');

    const cookies = await login(ctx, 'attacker@acme.test');
    const response = await changePassword(cookies, {
      userId: victim.id,
      user_id: victim.id,
      email: 'victim@acme.test',
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    // The call SUCCEEDS — it is a perfectly valid change of the caller's own
    // password. The forged fields simply have no effect.
    expect(response.statusCode).toBe(200);

    expect(await storedHash('victim@acme.test')).toBe(victimHash);
    expect(await attemptLogin('victim@acme.test', TEST_PASSWORD)).toBe(200);
    expect(await attemptLogin('victim@acme.test', NEW_PASSWORD)).toBe(401);
    // …and the caller's own password did change.
    expect(await attemptLogin('attacker@acme.test', NEW_PASSWORD)).toBe(200);
  });

  it('gives a member no route to the owner or to a platform operator', async () => {
    const admin = await superAdmin();
    const owner = await subscriberOwner(admin.cookies);
    const member = await activeMember(owner.organizationId);

    const ownerHash = await storedHash(owner.email);
    const operatorHash = await storedHash(admin.email);

    // Every shape a client could try, with the member's own valid session.
    for (const forged of [
      { userId: owner.userId },
      { userId: admin.userId },
      { targetUserId: admin.userId },
      { email: admin.email },
    ]) {
      const response = await changePassword(member.cookies, {
        ...forged,
        currentPassword: TEST_PASSWORD,
        newPassword: `${NEW_PASSWORD}-${Object.keys(forged)[0]}`,
      });
      // Either it changed the member's own password (200) or it was refused —
      // what it must never do is touch somebody else's row.
      expect([200, 400, 401]).toContain(response.statusCode);
    }

    expect(await storedHash(owner.email)).toBe(ownerHash);
    expect(await storedHash(admin.email)).toBe(operatorHash);
  });

  it('carries no confirmation field — matching is the client\'s job and cannot be spoofed', async () => {
    await seedUser(ctx, { email: 'jane@acme.test' });
    const cookies = await login(ctx, 'jane@acme.test');

    /*
     * The API deliberately takes `currentPassword` + `newPassword` only. A
     * client that sends a mismatched confirmation has a UI bug; the server has
     * no third value to compare and simply sets `newPassword`. This test pins
     * that contract so nobody later "helpfully" trusts a client-supplied
     * `confirmPassword` as though it were authoritative.
     */
    const response = await changePassword(cookies, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
      confirmPassword: 'something-else-entirely',
    });

    expect(response.statusCode).toBe(200);
    expect(await attemptLogin('jane@acme.test', NEW_PASSWORD)).toBe(200);
    expect(await attemptLogin('jane@acme.test', 'something-else-entirely')).toBe(401);
  });
});

/* ── Sessions ─────────────────────────────────────────────────────────────── */

describe('session handling', () => {
  it('revokes every OTHER session and keeps the one that made the change', async () => {
    await seedUser(ctx, { email: 'jane@acme.test' });
    const laptop = await login(ctx, 'jane@acme.test');
    const phone = await login(ctx, 'jane@acme.test');
    const current = await login(ctx, 'jane@acme.test');

    expect((await changePassword(current, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    })).statusCode).toBe(200);

    for (const stale of [laptop, phone]) {
      const check = await ctx.app.inject({
        method: 'GET',
        url: '/api/auth/session',
        headers: authHeaders(stale),
      });
      expect(check.json()).toEqual({ authenticated: false, user: null });
    }

    // The session that did the work is still usable — no re-login demanded.
    const survivor = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: authHeaders(current),
    });
    expect(survivor.json().authenticated).toBe(true);
    expect(survivor.json().user.email).toBe('jane@acme.test');

    // And it can still perform an authenticated write.
    expect((await changePassword(current, {
      currentPassword: NEW_PASSWORD,
      newPassword: OTHER_PASSWORD,
    })).statusCode).toBe(200);
  });

  it('leaves login and logout working exactly as before', async () => {
    await seedUser(ctx, { email: 'jane@acme.test' });
    const cookies = await login(ctx, 'jane@acme.test');
    await changePassword(cookies, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: authHeaders(cookies),
    });
    expect(logout.statusCode).toBe(200);

    const afterLogout = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: authHeaders(cookies),
    });
    expect(afterLogout.json()).toEqual({ authenticated: false, user: null });

    // A fresh login with the new password issues a fresh, working session.
    const relogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'jane@acme.test', password: NEW_PASSWORD },
    });
    expect(relogin.statusCode).toBe(200);
    const fresh = readCookies(relogin.headers as Record<string, unknown>);
    const session = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: authHeaders(fresh),
    });
    expect(session.json().authenticated).toBe(true);
  });
});

/* ── Every persona, one mechanism ─────────────────────────────────────────── */

describe('all three personas use the one endpoint', () => {
  it('lets a platform super administrator change their own password', async () => {
    const admin = await superAdmin();

    const response = await changePassword(admin.cookies, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(response.statusCode).toBe(200);

    expect(await attemptLogin(admin.email, NEW_PASSWORD)).toBe(200);
    expect(await attemptLogin(admin.email, TEST_PASSWORD)).toBe(401);

    // Still an operator afterwards — the change touched the credential only.
    const roles = await ctx.db
      .selectFrom('platform_user_roles')
      .select('role')
      .where('user_id', '=', admin.userId)
      .execute();
    expect(roles.map((r) => r.role)).toEqual(['super_admin']);
  });

  it('lets a subscriber owner exchange their temporary credential and keep their organization', async () => {
    const admin = await superAdmin();
    const owner = await subscriberOwner(admin.cookies);

    const membershipBefore = await ctx.db
      .selectFrom('organization_memberships')
      .selectAll()
      .where('user_id', '=', owner.userId)
      .executeTakeFirstOrThrow();

    const cookies = await login(ctx, owner.email, owner.temporaryPassword);
    const response = await changePassword(cookies, {
      currentPassword: owner.temporaryPassword,
      newPassword: NEW_PASSWORD,
    });
    expect(response.statusCode).toBe(200);

    expect(await attemptLogin(owner.email, NEW_PASSWORD)).toBe(200);
    expect(await attemptLogin(owner.email, owner.temporaryPassword)).toBe(401);

    const membershipAfter = await ctx.db
      .selectFrom('organization_memberships')
      .selectAll()
      .where('user_id', '=', owner.userId)
      .executeTakeFirstOrThrow();

    expect(membershipAfter.organization_id).toBe(membershipBefore.organization_id);
    expect(membershipAfter.role).toBe('owner');
    expect(membershipAfter.role).toBe(membershipBefore.role);
    // Exactly one membership before and after — nothing was created or dropped.
    const memberships = await ctx.db
      .selectFrom('organization_memberships')
      .select('id')
      .where('user_id', '=', owner.userId)
      .execute();
    expect(memberships).toHaveLength(1);
  });

  it('lets an ordinary member change their own password without touching their membership', async () => {
    const admin = await superAdmin();
    const owner = await subscriberOwner(admin.cookies);
    const member = await activeMember(owner.organizationId);

    const before = await ctx.db
      .selectFrom('organization_memberships')
      .selectAll()
      .where('user_id', '=', member.userId)
      .executeTakeFirstOrThrow();

    const response = await changePassword(member.cookies, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(response.statusCode).toBe(200);

    expect(await attemptLogin(member.email, NEW_PASSWORD)).toBe(200);
    expect(await attemptLogin(member.email, TEST_PASSWORD)).toBe(401);

    const after = await ctx.db
      .selectFrom('organization_memberships')
      .selectAll()
      .where('user_id', '=', member.userId)
      .executeTakeFirstOrThrow();

    expect(after.organization_id).toBe(before.organization_id);
    expect(after.role).toBe('member');
    expect(after.status).toBe(before.status);

    // The owner is entirely unaffected by a member rotating their password.
    expect(await attemptLogin(owner.email, owner.temporaryPassword)).toBe(200);
  });

  it('grants a super administrator no shortcut — they still need their own current password', async () => {
    const admin = await superAdmin();

    const response = await changePassword(admin.cookies, {
      currentPassword: 'Not-My-Password-11',
      newPassword: NEW_PASSWORD,
    });

    expect(response.statusCode).toBe(401);
    expect(await attemptLogin(admin.email, TEST_PASSWORD)).toBe(200);
  });
});

/* ── Disclosure ───────────────────────────────────────────────────────────── */

describe('nothing sensitive escapes', () => {
  it('returns no password hash from any endpoint the flow touches', async () => {
    await seedUser(ctx, { email: 'jane@acme.test' });

    const loginResponse = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'jane@acme.test', password: TEST_PASSWORD },
    });
    const cookies = readCookies(loginResponse.headers as Record<string, unknown>);

    const change = await changePassword(cookies, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    const session = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: authHeaders(cookies),
    });

    for (const body of [loginResponse.body, change.body, session.body]) {
      expect(body).not.toContain('password_hash');
      expect(body).not.toContain('passwordHash');
      expect(body).not.toContain('$argon2');
      expect(body).not.toContain(TEST_PASSWORD);
      expect(body).not.toContain(NEW_PASSWORD);
    }

    // The success body says only that it worked (plus the caller's own roles).
    expect(change.json()).toEqual({ ok: true, platformRoles: [] });
  });

  it('names both change-password body fields in the logger redaction policy', async () => {
    /*
     * The logger is disabled under test, so this asserts the POLICY rather than
     * a captured line: in any environment where request logging IS on, these
     * paths are what stop the two secrets in this endpoint's body from being
     * written to disk. A field added to the request body without a matching
     * entry here would be a silent credential leak.
     */
    expect(LOG_REDACT_PATHS).toContain('req.body.currentPassword');
    expect(LOG_REDACT_PATHS).toContain('req.body.newPassword');
    expect(LOG_REDACT_PATHS).toContain('req.headers.cookie');
  });
});

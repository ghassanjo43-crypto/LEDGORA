/**
 * A revoked session cookie must not block the login that replaces it.
 *
 * ── The production bug this suite pins down ──────────────────────────────────
 * CSRF protection exists to defend an AUTHENTICATED cookie session. The hook
 * that enforced it asked the wrong question: it checked whether a
 * `ledgora_session` cookie EXISTED, not whether that cookie still resolved to
 * anybody.
 *
 * Those two questions diverge in exactly one situation, and it is the situation
 * an administrator creates deliberately: a password reset revokes every session
 * row for the target user, but the server cannot reach into a remote browser to
 * delete the cookie it handed out earlier. So the user's browser keeps sending a
 * cookie that now authenticates nobody. `POST /api/auth/login` — an
 * unauthenticated, credential-establishing endpoint — was then treated as a
 * cookie-authenticated state change and refused with
 * "Missing or invalid CSRF token."
 *
 * The result: an administrator resets a locked-out customer's password, hands
 * over a perfectly valid temporary credential, and the customer cannot sign in
 * with it. The recovery path was broken by the recovery action itself.
 *
 * ── What must NOT change ─────────────────────────────────────────────────────
 * A cookie that DOES resolve to a live session still requires CSRF on every
 * unsafe method. The fix narrows the condition from "a cookie exists" to "a
 * cookie authenticates somebody"; it does not exempt any route, least of all
 * the auth routes, where change-password and logout live.
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
import { CSRF_COOKIE, SESSION_COOKIE } from '../src/plugins/session.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

const CHOSEN_PASSWORD = 'Harbour-Lantern-44-Zx';

/* ── Helpers ──────────────────────────────────────────────────────────────── */

async function operator(): Promise<{ cookies: SessionCookies; userId: string; email: string }> {
  const email = 'super@ledgora.test';
  const user = await seedUser(ctx, {
    email,
    fullName: 'Platform Operator',
    platformRoles: ['super_admin'],
  });
  return { cookies: await login(ctx, email), userId: user.id, email };
}

/**
 * Exactly what a browser sends after a reset: the session and CSRF cookies it
 * was given earlier, and NO `X-CSRF-Token` header — because the page was
 * reloaded, or is a fresh tab, and the in-memory token is gone.
 */
function staleCookieHeader(cookies: SessionCookies): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${cookies.session}; ${CSRF_COOKIE}=${cookies.csrf}` };
}

const attemptLogin = (email: string, password: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { email, password } });

/* ── The real sequence, end to end ────────────────────────────────────────── */

describe('reset → stale cookie → temporary-password login', () => {
  it('lets the user sign in with the temporary password while still holding the revoked cookie', async () => {
    const admin = await operator();
    const target = await seedUser(ctx, { email: 'customer@acme.test', fullName: 'Customer Person' });

    /* 1–2. The user is signed in; their browser holds the cookie. */
    const browser = await login(ctx, 'customer@acme.test');
    const before = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: authHeaders(browser),
    });
    expect(before.json().authenticated).toBe(true);

    /* 3–4. The operator resets the password, which revokes every session row. */
    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${target.id}/reset-password`,
      headers: authHeaders(admin.cookies),
      payload: { mode: 'temporary', reason: 'Customer lost their password.' },
    });
    expect(reset.statusCode).toBe(200);
    const temporaryPassword: string = reset.json().credential.temporaryPassword;

    // The cookie the browser still holds now authenticates nobody.
    const dead = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: authHeaders(browser),
    });
    expect(dead.json().authenticated).toBe(false);

    /* 5–6. The browser posts the login WITH the stale cookie and NO CSRF header. */
    const signIn = await attemptLogin('customer@acme.test', temporaryPassword, staleCookieHeader(browser));

    /*
     * THE REGRESSION. This returned 403 "Missing or invalid CSRF token."
     * A revoked cookie is not an authenticated session, so it must not turn an
     * unauthenticated login into a cookie-authenticated state change.
     */
    expect(signIn.statusCode).toBe(200);
    expect(signIn.json().mustChangePassword).toBe(true);

    // A NEW session and a NEW CSRF token are issued.
    const fresh = readCookies(signIn.headers as Record<string, unknown>);
    expect(fresh.session).toBeTruthy();
    expect(fresh.session).not.toBe(browser.session);
    expect(signIn.json().csrfToken).toBeTruthy();
    expect(signIn.json().csrfToken).toBe(fresh.csrf);

    /* 7. The new session reaches the forced password-change flow — and nothing else. */
    const blocked = await ctx.app.inject({
      method: 'GET',
      url: '/api/organizations/current',
      headers: authHeaders(fresh),
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('password_change_required');

    /* 8. That new, VALID session still requires CSRF on an unsafe method. */
    const withoutCsrf = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie: `${SESSION_COOKIE}=${fresh.session}; ${CSRF_COOKIE}=${fresh.csrf}` },
      payload: { currentPassword: temporaryPassword, newPassword: CHOSEN_PASSWORD },
    });
    expect(withoutCsrf.statusCode).toBe(403);
    expect(withoutCsrf.json().error.message).toMatch(/csrf/i);

    /* 9. With the token the login handed back, it succeeds. */
    const withCsrf = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: authHeaders(fresh),
      payload: { currentPassword: temporaryPassword, newPassword: CHOSEN_PASSWORD },
    });
    expect(withCsrf.statusCode).toBe(200);

    /* 10. The temporary credential is spent; the chosen one works. */
    expect((await attemptLogin('customer@acme.test', temporaryPassword)).statusCode).toBe(401);
    expect((await attemptLogin('customer@acme.test', CHOSEN_PASSWORD)).statusCode).toBe(200);

    // And the application is open again.
    const open = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: authHeaders(fresh),
    });
    expect(open.json().authenticated).toBe(true);
    expect(open.json().user.mustChangePassword).toBe(false);
  });
});

/* ── The narrowed condition, stated directly ──────────────────────────────── */

describe('when CSRF is required', () => {
  it('does not require it for a login carrying a REVOKED session cookie', async () => {
    await seedUser(ctx, { email: 'revoked@acme.test' });
    const browser = await login(ctx, 'revoked@acme.test');

    // Revoke through the ordinary route, not by reaching into the database.
    await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/logout-all',
      headers: authHeaders(browser),
    });

    const response = await attemptLogin('revoked@acme.test', TEST_PASSWORD, staleCookieHeader(browser));
    expect(response.statusCode).toBe(200);
  });

  it('does not require it for a login carrying an EXPIRED session cookie', async () => {
    await seedUser(ctx, { email: 'expired@acme.test' });
    const browser = await login(ctx, 'expired@acme.test');

    // Age the session past its expiry, leaving the cookie itself intact.
    await ctx.db
      .updateTable('auth_sessions')
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .execute();

    const response = await attemptLogin('expired@acme.test', TEST_PASSWORD, staleCookieHeader(browser));
    expect(response.statusCode).toBe(200);
  });

  it('does not require it for a login carrying an entirely UNKNOWN session cookie', async () => {
    await seedUser(ctx, { email: 'unknown@acme.test' });

    const response = await attemptLogin('unknown@acme.test', TEST_PASSWORD, {
      cookie: `${SESSION_COOKIE}=not-a-real-session-token-at-all`,
    });
    expect(response.statusCode).toBe(200);
  });

  it('does not require it for a login carrying a cookie for a DISABLED account', async () => {
    const admin = await operator();
    const target = await seedUser(ctx, { email: 'disabled@acme.test' });
    const browser = await login(ctx, 'disabled@acme.test');

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/members/${target.id}/status`,
      headers: authHeaders(admin.cookies),
      payload: { status: 'disabled', reason: 'Temporarily suspended.' },
    });

    /*
     * The cookie no longer resolves (a disabled user is not a principal), so it
     * cannot make this a CSRF-protected request. The login is then refused on
     * its own merits — for being a disabled account, NOT for a missing token.
     */
    const response = await attemptLogin('disabled@acme.test', TEST_PASSWORD, staleCookieHeader(browser));
    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).not.toMatch(/csrf/i);
  });

  it('still works with no cookie at all, exactly as before', async () => {
    await seedUser(ctx, { email: 'cookieless@acme.test' });
    const response = await attemptLogin('cookieless@acme.test', TEST_PASSWORD);
    expect(response.statusCode).toBe(200);
  });

  it('REQUIRES it for every unsafe method on a live authenticated session', async () => {
    const admin = await operator();
    const target = await seedUser(ctx, { email: 'live@acme.test' });
    const live = await login(ctx, 'live@acme.test');

    // The cookie without the header — the shape a cross-site forgery takes.
    const cookieOnly = { cookie: `${SESSION_COOKIE}=${live.session}; ${CSRF_COOKIE}=${live.csrf}` };

    const unsafe: Array<{ method: 'POST' | 'PATCH' | 'DELETE'; url: string; payload?: unknown }> = [
      { method: 'POST', url: '/api/auth/change-password', payload: { currentPassword: TEST_PASSWORD, newPassword: CHOSEN_PASSWORD } },
      { method: 'POST', url: '/api/auth/logout' },
      { method: 'POST', url: '/api/auth/logout-all' },
      { method: 'POST', url: '/api/organizations', payload: { legalName: 'X', country: 'AE' } },
    ];

    for (const probe of unsafe) {
      const response = await ctx.app.inject({
        method: probe.method,
        url: probe.url,
        headers: cookieOnly,
        payload: probe.payload ?? {},
      });
      expect(response.statusCode, `${probe.method} ${probe.url}`).toBe(403);
      expect(response.json().error.message, `${probe.method} ${probe.url}`).toMatch(/csrf/i);
    }

    // The operator's authenticated admin write is protected too — this is the
    // one that would matter most if the fix had been written as a route
    // allow-list over `/api/auth/*`.
    const adminWrite = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${target.id}/reset-password`,
      headers: { cookie: `${SESSION_COOKIE}=${admin.cookies.session}` },
      payload: { mode: 'temporary' },
    });
    expect(adminWrite.statusCode).toBe(403);
    expect(adminWrite.json().error.message).toMatch(/csrf/i);

    // Nothing above took effect: the password is untouched.
    expect((await attemptLogin('live@acme.test', TEST_PASSWORD)).statusCode).toBe(200);
  });

  it('rejects a WRONG CSRF token on a live session, not merely a missing one', async () => {
    await seedUser(ctx, { email: 'wrongtoken@acme.test' });
    const live = await login(ctx, 'wrongtoken@acme.test');

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/logout-all',
      headers: {
        cookie: `${SESSION_COOKIE}=${live.session}`,
        'x-csrf-token': 'a-token-that-is-not-derived-from-this-session',
      },
    });
    expect(response.statusCode).toBe(403);
  });
});

/* ── A stale cookie is not a credential ───────────────────────────────────── */

describe('a stale cookie grants nothing', () => {
  it('cannot reach an authenticated route, with or without a CSRF header', async () => {
    const admin = await operator();
    const target = await seedUser(ctx, { email: 'stale@acme.test' });
    const browser = await login(ctx, 'stale@acme.test');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${target.id}/reset-password`,
      headers: authHeaders(admin.cookies),
      payload: { mode: 'temporary', reason: 'Reset.' },
    });

    /*
     * Relaxing CSRF for an unresolvable cookie must not relax AUTHENTICATION.
     * The request now sails past the CSRF hook and is stopped by the route's own
     * guard instead — which is the correct layer for "who are you?".
     */
    const write = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: staleCookieHeader(browser),
      payload: { currentPassword: TEST_PASSWORD, newPassword: CHOSEN_PASSWORD },
    });
    expect(write.statusCode).toBe(401);
    expect(write.json().error.code).toBe('unauthenticated');

    const read = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/members',
      headers: authHeaders(browser),
    });
    expect([401, 403]).toContain(read.statusCode);
  });
});

/* ── Housekeeping: the browser is told to drop the dead cookie ────────────── */

describe('stale cookie cleanup', () => {
  it('clears the dead cookies on GET /api/auth/session so the browser tidies up', async () => {
    const admin = await operator();
    const target = await seedUser(ctx, { email: 'cleanup@acme.test' });
    const browser = await login(ctx, 'cleanup@acme.test');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${target.id}/reset-password`,
      headers: authHeaders(admin.cookies),
      payload: { mode: 'temporary', reason: 'Reset.' },
    });

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: authHeaders(browser),
    });

    expect(response.json()).toEqual({ authenticated: false, user: null });

    // Both cookies are expired, with the attributes they were set with, so the
    // browser can actually match and evict them.
    const raw = response.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    expect(list.some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
    expect(list.some((c) => c.startsWith(`${CSRF_COOKIE}=`))).toBe(true);
    for (const cookie of list) expect(cookie).toMatch(/Expires=|Max-Age=/i);
  });

  it('does not clear anything when there was no cookie to begin with', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/auth/session' });

    expect(response.json()).toEqual({ authenticated: false, user: null });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('does not clear a LIVE session', async () => {
    await seedUser(ctx, { email: 'live-session@acme.test' });
    const live = await login(ctx, 'live-session@acme.test');

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: authHeaders(live),
    });

    expect(response.json().authenticated).toBe(true);
    const raw = response.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    // Nothing here may expire the session cookie the caller is still using.
    expect(list.some((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(false);
    // The session still works immediately afterwards.
    const again = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: authHeaders(live),
    });
    expect(again.json().authenticated).toBe(true);
  });
});

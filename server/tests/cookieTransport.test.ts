/**
 * Cookie and CSRF transport across the two supported deployment topologies.
 *
 * The production defect: with `SameSite=Lax` cookies and the browser talking to
 * a *different* API hostname, `credentials: include` does not make the cookie
 * travel, so the session that login just created is invisible to the very next
 * `GET /api/auth/session`. These tests pin the attributes each topology needs
 * and the CSRF-token-in-body channel that removes the `document.cookie`
 * dependency entirely.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createTestContext, seedUser, TEST_PASSWORD, type TestContext } from './helpers/testApp.js';
import { SESSION_COOKIE, CSRF_COOKIE, CSRF_HEADER, deriveCsrfToken } from '../src/plugins/session.js';

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
});

/** All Set-Cookie header lines for a given cookie name. */
function cookieLines(headers: Record<string, unknown>, name: string): string[] {
  const raw = headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  return list.filter((c) => c.startsWith(`${name}=`));
}

describe('same-origin deployment (SameSite=Lax, the default)', () => {
  it('issues an HttpOnly Lax session cookie and returns the CSRF token in the body', async () => {
    ctx = await createTestContext();
    await seedUser(ctx, { email: 'jane@acme.test' });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'jane@acme.test', password: TEST_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const [session] = cookieLines(response.headers as Record<string, unknown>, SESSION_COOKIE);
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Lax');
    expect(session).not.toContain('SameSite=None');

    // The CSRF token is delivered in the response body (and header), so the
    // frontend never has to read a cookie it cannot see cross-origin.
    const body = response.json();
    expect(typeof body.csrfToken).toBe('string');
    expect(body.csrfToken.length).toBeGreaterThan(0);
    expect(response.headers[CSRF_HEADER.toLowerCase()]).toBe(body.csrfToken);
  });
});

describe('cross-site deployment (SameSite=None; Secure)', () => {
  it('issues Secure, SameSite=None, Partitioned cookies so they travel cross-site', async () => {
    ctx = await createTestContext({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ignored-by-pglite-test',
      SESSION_SECRET: 'a-strong-production-session-secret-value',
      TRUST_PROXY: 'true',
      COOKIE_SAMESITE: 'none',
      COOKIE_PARTITIONED: 'true',
    });
    await seedUser(ctx, { email: 'ops@acme.test' });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ops@acme.test', password: TEST_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const [session] = cookieLines(response.headers as Record<string, unknown>, SESSION_COOKIE);
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=None');
    expect(session).toContain('Secure');
    expect(session).toContain('Partitioned');

    // The companion CSRF cookie is not HttpOnly but carries the same cross-site
    // attributes so the browser keeps it alongside the session.
    const [csrf] = cookieLines(response.headers as Record<string, unknown>, CSRF_COOKIE);
    expect(csrf).toContain('SameSite=None');
    expect(csrf).toContain('Secure');
    expect(csrf).not.toContain('HttpOnly');
  });

  it('refuses to boot with SameSite=None but no trusted proxy', async () => {
    await expect(
      createTestContext({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://x',
        SESSION_SECRET: 'a-strong-production-session-secret-value',
        TRUST_PROXY: 'false',
        COOKIE_SAMESITE: 'none',
      }),
    ).rejects.toThrow(/TRUST_PROXY/);
  });
});

describe('session verification with the cookie present', () => {
  it('login then session preserves the operator role (the cookie travelled)', async () => {
    ctx = await createTestContext();
    await seedUser(ctx, { email: 'root@ledgora.test', platformRoles: ['super_admin'] });

    const loginRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'root@ledgora.test', password: TEST_PASSWORD },
    });
    const rawCookie = String(loginRes.headers['set-cookie']);
    const sessionValue = rawCookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1] ?? '';
    expect(sessionValue).not.toBe('');

    // The next request carries the cookie, exactly as a browser would when the
    // request is same-origin (or SameSite=None cross-site).
    const sessionRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: `${SESSION_COOKIE}=${sessionValue}` },
    });
    const body = sessionRes.json();
    expect(body.authenticated).toBe(true);
    expect(body.user.platformRoles).toEqual(['super_admin']);
    // The CSRF token is re-supplied so a reloaded page can act again.
    expect(body.csrfToken).toBe(deriveCsrfToken(sessionValue, ctx.config.SESSION_SECRET));
  });

  it('reports authenticated:false when no cookie is sent', async () => {
    ctx = await createTestContext();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/session' });
    expect(res.json()).toEqual({ authenticated: false, user: null });
  });
});

describe('logout clears cookies with matching attributes', () => {
  it('expires both cookies using the same SameSite/Secure they were set with', async () => {
    ctx = await createTestContext({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://x',
      SESSION_SECRET: 'a-strong-production-session-secret-value',
      TRUST_PROXY: 'true',
      COOKIE_SAMESITE: 'none',
      COOKIE_PARTITIONED: 'true',
    });
    await seedUser(ctx, { email: 'ops@acme.test' });
    const loginRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ops@acme.test', password: TEST_PASSWORD },
    });
    const rawCookie = String(loginRes.headers['set-cookie']);
    const sessionValue = rawCookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1] ?? '';
    const csrf = deriveCsrfToken(sessionValue, ctx.config.SESSION_SECRET);

    const logoutRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        cookie: `${SESSION_COOKIE}=${sessionValue}; ${CSRF_COOKIE}=${csrf}`,
        [CSRF_HEADER]: csrf,
      },
    });

    expect(logoutRes.statusCode).toBe(200);
    const [cleared = ''] = cookieLines(logoutRes.headers as Record<string, unknown>, SESSION_COOKIE);
    // A browser only evicts a cookie when the clearing attributes match.
    expect(cleared).toContain('SameSite=None');
    expect(cleared).toContain('Secure');
    // Expired: Max-Age=0 (or a past Expires).
    expect(cleared.toLowerCase()).toMatch(/max-age=0|expires=/);
  });
});

/**
 * Authentication, session and lockout behaviour, exercised end-to-end through
 * the HTTP surface against a real PostgreSQL engine.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { authHeaders, createTestContext, login, readCookies, seedUser, TEST_PASSWORD, type TestContext } from './helpers/testApp.js';
import { SESSION_COOKIE } from '../src/plugins/session.js';
import { countAuditLogs } from '../src/lib/audit.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

describe('password storage', () => {
  it('hashes with Argon2id and never returns or stores the raw password', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'jane@acme.test', password: TEST_PASSWORD, fullName: 'Jane Owner' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain(TEST_PASSWORD);
    expect(response.body).not.toContain('password_hash');

    const row = await ctx.db.selectFrom('users').selectAll().where('normalized_email', '=', 'jane@acme.test').executeTakeFirstOrThrow();
    expect(row.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(row.password_hash).not.toContain(TEST_PASSWORD);
  });

  it('rejects a password that fails the policy', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'weak@acme.test', password: 'short', fullName: 'Weak' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('login', () => {
  beforeEach(async () => {
    await seedUser(ctx, { email: 'jane@acme.test', fullName: 'Jane Owner' });
  });

  it('succeeds with valid credentials and issues an HttpOnly session cookie', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'jane@acme.test', password: TEST_PASSWORD },
    });
    expect(response.statusCode).toBe(200);

    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    // Only a hash of the token is persisted.
    const cookies = readCookies(response.headers as Record<string, unknown>);
    const stored = await ctx.db.selectFrom('auth_sessions').selectAll().executeTakeFirstOrThrow();
    expect(stored.token_hash).not.toBe(cookies.session);
    expect(stored.token_hash).toHaveLength(64);
  });

  it('is case-insensitive on the email', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'JANE@ACME.TEST', password: TEST_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
  });

  it('fails generically, without revealing whether the account exists', async () => {
    const wrongPassword = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'jane@acme.test', password: 'Wrong-Password-12345' },
    });
    const unknownAccount = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@acme.test', password: 'Wrong-Password-12345' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownAccount.statusCode).toBe(401);
    // Identical bodies — the response cannot be used to enumerate accounts.
    expect(wrongPassword.json()).toEqual(unknownAccount.json());
  });

  it('locks the account after repeated failures', async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'jane@acme.test', password: 'Wrong-Password-12345' },
      });
    }
    // Correct password now — still refused because the account is locked.
    const locked = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'jane@acme.test', password: TEST_PASSWORD },
    });
    expect(locked.statusCode).toBe(423);
    expect(await countAuditLogs(ctx.db, 'auth.account_locked')).toBeGreaterThan(0);
  });

  it('refuses a disabled account', async () => {
    await seedUser(ctx, { email: 'gone@acme.test', status: 'disabled' });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'gone@acme.test', password: TEST_PASSWORD },
    });
    expect(response.statusCode).toBe(401);
  });

  it('records successful and failed logins in the audit trail', async () => {
    await login(ctx, 'jane@acme.test');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'jane@acme.test', password: 'Wrong-Password-12345' },
    });
    expect(await countAuditLogs(ctx.db, 'auth.login')).toBe(1);
    expect(await countAuditLogs(ctx.db, 'auth.login_failed')).toBe(1);
  });
});

describe('sessions', () => {
  beforeEach(async () => {
    await seedUser(ctx, { email: 'jane@acme.test' });
  });

  it('resolves the current user from the cookie', async () => {
    const cookies = await login(ctx, 'jane@acme.test');
    const response = await ctx.app.inject({ method: 'GET', url: '/api/auth/session', headers: authHeaders(cookies) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ authenticated: true, user: { email: 'jane@acme.test', platformRoles: [] } });
  });

  it('reports an anonymous visitor as unauthenticated', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/auth/session' });
    expect(response.json()).toEqual({ authenticated: false, user: null });
  });

  it('rejects the session after logout', async () => {
    const cookies = await login(ctx, 'jane@acme.test');
    const logout = await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: authHeaders(cookies) });
    expect(logout.statusCode).toBe(200);

    const after = await ctx.app.inject({ method: 'GET', url: '/api/auth/session', headers: authHeaders(cookies) });
    expect(after.json()).toEqual({ authenticated: false, user: null });
  });

  it('rejects an expired session', async () => {
    const cookies = await login(ctx, 'jane@acme.test');
    await ctx.db.updateTable('auth_sessions').set({ expires_at: new Date(Date.now() - 1000) }).execute();
    const response = await ctx.app.inject({ method: 'GET', url: '/api/auth/session', headers: authHeaders(cookies) });
    expect(response.json()).toEqual({ authenticated: false, user: null });
  });

  it('rejects a forged session token', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: `${SESSION_COOKIE}=totally-made-up-token` },
    });
    expect(response.json()).toEqual({ authenticated: false, user: null });
  });

  it('stops accepting a session once the user is disabled', async () => {
    const cookies = await login(ctx, 'jane@acme.test');
    await ctx.db.updateTable('users').set({ status: 'disabled' }).where('normalized_email', '=', 'jane@acme.test').execute();
    const response = await ctx.app.inject({ method: 'GET', url: '/api/auth/session', headers: authHeaders(cookies) });
    expect(response.json()).toEqual({ authenticated: false, user: null });
  });

  it('revokes every session on logout-all', async () => {
    const first = await login(ctx, 'jane@acme.test');
    const second = await login(ctx, 'jane@acme.test');

    const response = await ctx.app.inject({ method: 'POST', url: '/api/auth/logout-all', headers: authHeaders(second) });
    expect(response.statusCode).toBe(200);

    for (const cookies of [first, second]) {
      const check = await ctx.app.inject({ method: 'GET', url: '/api/auth/session', headers: authHeaders(cookies) });
      expect(check.json()).toEqual({ authenticated: false, user: null });
    }
  });
});

describe('CSRF protection', () => {
  it('rejects a cookie-authenticated state change without the CSRF header', async () => {
    await seedUser(ctx, { email: 'jane@acme.test' });
    const cookies = await login(ctx, 'jane@acme.test');

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/logout-all',
      headers: { cookie: `${SESSION_COOKIE}=${cookies.session}` }, // no X-CSRF-Token
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('change password', () => {
  const NEW_PASSWORD = 'Another-Strong-77-Pass';

  beforeEach(async () => {
    await seedUser(ctx, { email: 'jane@acme.test' });
  });

  it('changes the password and revokes other sessions', async () => {
    const oldSession = await login(ctx, 'jane@acme.test');
    const current = await login(ctx, 'jane@acme.test');

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: authHeaders(current),
      payload: { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(response.statusCode).toBe(200);

    const stale = await ctx.app.inject({ method: 'GET', url: '/api/auth/session', headers: authHeaders(oldSession) });
    expect(stale.json()).toEqual({ authenticated: false, user: null });

    await expect(login(ctx, 'jane@acme.test', NEW_PASSWORD)).resolves.toBeTruthy();
  });

  it('refuses when the current password is wrong', async () => {
    const cookies = await login(ctx, 'jane@acme.test');
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: authHeaders(cookies),
      payload: { currentPassword: 'Not-The-Password-1', newPassword: NEW_PASSWORD },
    });
    expect(response.statusCode).toBe(401);
  });

  it('requires authentication', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      payload: { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('request parsing', () => {
  it('accepts a bodyless POST that still declares application/json', async () => {
    // Browser clients commonly send a default JSON content-type with no body.
    await seedUser(ctx, { email: 'jane@acme.test' });
    const cookies = await login(ctx, 'jane@acme.test');
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...authHeaders(cookies), 'content-type': 'application/json' },
      payload: '',
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects malformed JSON with a safe message', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('SyntaxError');
  });
});

describe('health', () => {
  it('reports status without leaking configuration', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(Object.keys(body).sort()).toEqual(['database', 'status', 'timestamp']);
  });
});

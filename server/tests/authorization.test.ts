/**
 * Platform authorization.
 *
 * The central claim under test: authorization is decided by the database-backed
 * session, so nothing a browser can set — a role field, a localStorage value, a
 * forged cookie — grants administrator access.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { authHeaders, createTestContext, login, seedUser, type TestContext } from './helpers/testApp.js';
import { hasCapability, roleHasCapability } from '../src/guards/platform.js';
import { countAuditLogs } from '../src/lib/audit.js';
import { SESSION_COOKIE, CSRF_COOKIE, CSRF_HEADER, deriveCsrfToken } from '../src/plugins/session.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

const ADMIN_ROUTES = ['/api/admin/me', '/api/admin/users', '/api/admin/organizations', '/api/admin/audit-logs'];

describe('normal customers hold no platform role', () => {
  it('gives a newly registered user an empty platform role list', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'new@acme.test', password: 'Correct-Horse-9-Battery', fullName: 'New Customer' },
    });
    expect(response.json().user.platformRoles).toEqual([]);

    const roles = await ctx.db.selectFrom('platform_user_roles').selectAll().execute();
    expect(roles).toHaveLength(0);
  });

  it('refuses every administrator route for a plain customer', async () => {
    await seedUser(ctx, { email: 'customer@acme.test' });
    const cookies = await login(ctx, 'customer@acme.test');

    for (const url of ADMIN_ROUTES) {
      const response = await ctx.app.inject({ method: 'GET', url, headers: authHeaders(cookies) });
      expect(response.statusCode, url).toBe(403);
    }
  });

  it('refuses every administrator route for an anonymous visitor', async () => {
    for (const url of ADMIN_ROUTES) {
      const response = await ctx.app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it('does not make an organization owner a platform administrator', async () => {
    const owner = await seedUser(ctx, { email: 'owner@acme.test' });
    const org = await ctx.db
      .insertInto('organizations')
      .values({ legal_name: 'Acme Holdings', country: 'AE', base_currency: 'USD', fiscal_year_start: '01-01' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await ctx.db
      .insertInto('organization_memberships')
      .values({ organization_id: org.id, user_id: owner.id, role: 'owner' })
      .execute();

    const cookies = await login(ctx, 'owner@acme.test');
    const response = await ctx.app.inject({ method: 'GET', url: '/api/admin/me', headers: authHeaders(cookies) });
    expect(response.statusCode).toBe(403);
  });
});

describe('browser-controlled values grant nothing', () => {
  it('ignores a client-supplied platform role in the request body or headers', async () => {
    await seedUser(ctx, { email: 'customer@acme.test' });
    const cookies = await login(ctx, 'customer@acme.test');

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: {
        ...authHeaders(cookies),
        'x-platform-role': 'super_admin',
        'x-ledgora-admin': 'true',
      },
      query: { role: 'super_admin' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('ignores a hand-crafted cookie claiming a role', async () => {
    // Exactly the shape an attacker would forge in devtools.
    const forged = 'super_admin';
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/me',
      headers: {
        cookie: `${SESSION_COOKIE}=${forged}; ${CSRF_COOKIE}=${forged}; ledgora_platform_role=super_admin`,
        [CSRF_HEADER]: deriveCsrfToken(forged, ctx.config.SESSION_SECRET),
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it('only honours a role that exists as a database row', async () => {
    const user = await seedUser(ctx, { email: 'promoted@acme.test' });
    const before = await login(ctx, 'promoted@acme.test');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/admin/me', headers: authHeaders(before) })).statusCode).toBe(403);

    await ctx.db.insertInto('platform_user_roles').values({ user_id: user.id, role: 'super_admin' }).execute();

    const after = await ctx.app.inject({ method: 'GET', url: '/api/admin/me', headers: authHeaders(before) });
    expect(after.statusCode).toBe(200);
    expect(after.json().user.platformRoles).toEqual(['super_admin']);
  });
});

describe('platform roles are scoped by capability', () => {
  it('lets a super_admin reach the administrator surface', async () => {
    await seedUser(ctx, { email: 'root@ledgora.test', platformRoles: ['super_admin'] });
    const cookies = await login(ctx, 'root@ledgora.test');

    for (const url of ADMIN_ROUTES) {
      const response = await ctx.app.inject({ method: 'GET', url, headers: authHeaders(cookies) });
      expect(response.statusCode, url).toBe(200);
    }
  });

  it('lets support read but not manage users', async () => {
    await seedUser(ctx, { email: 'support@ledgora.test', platformRoles: ['support'] });
    const target = await seedUser(ctx, { email: 'victim@acme.test' });
    const cookies = await login(ctx, 'support@ledgora.test');

    expect((await ctx.app.inject({ method: 'GET', url: '/api/admin/users', headers: authHeaders(cookies) })).statusCode).toBe(200);

    const disable = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${target.id}/status`,
      headers: authHeaders(cookies),
      payload: { status: 'disabled' },
    });
    expect(disable.statusCode).toBe(403);
  });

  it('lets billing_admin read but not manage users', async () => {
    await seedUser(ctx, { email: 'billing@ledgora.test', platformRoles: ['billing_admin'] });
    const target = await seedUser(ctx, { email: 'victim@acme.test' });
    const cookies = await login(ctx, 'billing@ledgora.test');

    expect((await ctx.app.inject({ method: 'GET', url: '/api/admin/users', headers: authHeaders(cookies) })).statusCode).toBe(200);
    const disable = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${target.id}/status`,
      headers: authHeaders(cookies),
      payload: { status: 'disabled' },
    });
    expect(disable.statusCode).toBe(403);
  });

  it('maps capabilities to roles as documented', () => {
    expect(roleHasCapability('super_admin', 'activate-subscription')).toBe(true);
    expect(roleHasCapability('billing_admin', 'activate-subscription')).toBe(false);
    expect(roleHasCapability('billing_admin', 'verify-payments')).toBe(true);
    expect(roleHasCapability('support', 'verify-payments')).toBe(false);
    expect(roleHasCapability('support', 'manage-bank-details')).toBe(false);
    expect(hasCapability([], 'view-admin')).toBe(false);
  });
});

describe('user administration', () => {
  it('lets a super_admin disable a user, audits it, and blocks that user immediately', async () => {
    await seedUser(ctx, { email: 'root@ledgora.test', platformRoles: ['super_admin'] });
    const victim = await seedUser(ctx, { email: 'victim@acme.test' });
    const victimCookies = await login(ctx, 'victim@acme.test');
    const adminCookies = await login(ctx, 'root@ledgora.test');

    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${victim.id}/status`,
      headers: authHeaders(adminCookies),
      payload: { status: 'disabled' },
    });
    expect(response.statusCode).toBe(200);
    expect(await countAuditLogs(ctx.db, 'user.status_changed')).toBe(1);

    // The live session stops working at once, not at expiry.
    const session = await ctx.app.inject({ method: 'GET', url: '/api/auth/session', headers: authHeaders(victimCookies) });
    expect(session.json()).toEqual({ authenticated: false, user: null });

    const loginAgain = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'victim@acme.test', password: 'Correct-Horse-9-Battery' },
    });
    expect(loginAgain.statusCode).toBe(401);
  });

  it('refuses to let an administrator disable themselves', async () => {
    const admin = await seedUser(ctx, { email: 'root@ledgora.test', platformRoles: ['super_admin'] });
    const cookies = await login(ctx, 'root@ledgora.test');
    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${admin.id}/status`,
      headers: authHeaders(cookies),
      payload: { status: 'disabled' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('never exposes a password hash through the admin API', async () => {
    await seedUser(ctx, { email: 'root@ledgora.test', platformRoles: ['super_admin'] });
    const cookies = await login(ctx, 'root@ledgora.test');
    const response = await ctx.app.inject({ method: 'GET', url: '/api/admin/users', headers: authHeaders(cookies) });
    expect(response.body).not.toContain('argon2');
    expect(response.body).not.toContain('password');
  });
});

describe('CORS', () => {
  it('rejects an origin that is not configured', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows the configured frontend origin with credentials', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });
});

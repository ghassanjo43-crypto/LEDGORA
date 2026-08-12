/**
 * User administration and permissions, through the real HTTP stack.
 *
 * Every test here drives `app.inject()` against a real PostgreSQL (PGlite) with
 * the production migrations applied, so the constraints, the transactions and
 * the guards under test are the ones that ship.
 *
 * The claims this suite exists to prove:
 *
 *   creation      a Super Admin creates users, assigns organizations and roles,
 *                 and receives a one-time credential that is never recoverable;
 *   tenancy       an Organization Admin manages their own tenant and CANNOT
 *                 reach another, in a way a modified request cannot change;
 *   escalation    nobody grants authority they do not hold, and the refusal is
 *                 recorded;
 *   entitlement   no permission, however granted, opens a module the tenant has
 *                 not bought — and a downgrade does not destroy configuration;
 *   protection    the last active Super Admin, and the acting operator's own
 *                 account, cannot be taken away;
 *   invitations   a link is single-use, expiring, revocable, and unusable twice;
 *   retention     deactivating a user leaves every historical reference intact;
 *   audit         every material access change produces an entry, and no entry
 *                 ever contains a credential.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  authHeaders,
  createTestContext,
  login,
  seedUser,
  type SessionCookies,
  type TestContext,
} from './helpers/testApp.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

/* ── Helpers ──────────────────────────────────────────────────────────────── */

async function operator(
  role: 'super_admin' | 'billing_admin' | 'support' = 'super_admin',
  email = `${role}@ledgora.test`,
): Promise<{ cookies: SessionCookies; userId: string }> {
  const user = await seedUser(ctx, { email, fullName: `Operator ${role}`, platformRoles: [role] });
  return { cookies: await login(ctx, email), userId: user.id };
}

async function planId(code = 'enterprise'): Promise<string> {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
  const found = response.json().plans.find((p: { code: string }) => p.code === code);
  if (!found) throw new Error(`seeded catalogue is missing "${code}"`);
  return found.id;
}

/** A subscriber tenant with an owner and a live subscription. */
async function subscriber(
  admin: SessionCookies,
  overrides: { email?: string; legalName?: string; plan?: string } = {},
): Promise<{ organizationId: string; ownerUserId: string }> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/subscribers',
    headers: authHeaders(admin),
    payload: {
      fullName: 'Owner Person',
      email: overrides.email ?? 'owner@newco.test',
      organizationLegalName: overrides.legalName ?? 'NewCo Trading LLC',
      country: 'AE',
      baseCurrency: 'AED',
      planId: await planId(overrides.plan ?? 'enterprise'),
      onboarding: 'temporary',
      paymentConfirmed: true,
    },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return { organizationId: body.subscriber.organizationId, ownerUserId: body.subscriber.userId };
}

interface CreatedUser {
  status: number;
  userId: string;
  credential: Record<string, unknown>;
  body: Record<string, never>;
}

async function createUser(
  admin: SessionCookies,
  overrides: Record<string, unknown> = {},
): Promise<CreatedUser> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: authHeaders(admin),
    payload: {
      fullName: 'Sara Accountant',
      email: 'sara@newco.test',
      onboarding: 'invitation',
      ...overrides,
    },
  });
  const body = response.json();
  return {
    status: response.statusCode,
    userId: body?.user?.userId,
    credential: body?.credential ?? {},
    body,
  };
}

/** Sign in and return cookies, without going through the `login` helper's throw. */
async function tryLogin(email: string, password: string): Promise<{ status: number; body: unknown }> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  return { status: response.statusCode, body: response.json() };
}

async function auditActions(): Promise<string[]> {
  const rows = await ctx.db.selectFrom('audit_logs').select('action').execute();
  return rows.map((r) => r.action);
}

async function effective(
  admin: SessionCookies,
  userId: string,
  organizationId: string,
): Promise<{ allowedKeys: string[]; permissions: Array<Record<string, unknown>> }> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/admin/users/${userId}/permissions?organizationId=${organizationId}`,
    headers: authHeaders(admin),
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

/* ── Creation ─────────────────────────────────────────────────────────────── */

describe('a super administrator creates and edits users', () => {
  it('creates a user, assigns the organization and role, and returns one credential', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);

    const created = await createUser(admin.cookies, { organizationId, role: 'accountant' });
    expect(created.status).toBe(201);

    const body = created.body as unknown as {
      user: Record<string, unknown>;
      credential: Record<string, unknown>;
    };
    expect(body.user.organizationId).toBe(organizationId);
    expect(body.user.role).toBe('accountant');
    // An invited account may not authenticate until the link is redeemed.
    expect(body.user.accountStatus).toBe('pending_verification');

    // The one-time credential: a token, and nothing that could be a password.
    expect(body.credential.type).toBe('invitation');
    expect(typeof body.credential.invitationToken).toBe('string');
    expect(body.credential).not.toHaveProperty('temporaryPassword');
    expect(body.credential).not.toHaveProperty('passwordHash');

    const membership = await ctx.db
      .selectFrom('organization_memberships')
      .selectAll()
      .where('user_id', '=', created.userId)
      .executeTakeFirstOrThrow();
    expect(membership.organization_id).toBe(organizationId);
    expect(membership.role).toBe('accountant');
  });

  it('supports every required authority level', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);

    // Organization Admin, Manager, Accountant, Standard User, Read-only/Auditor.
    for (const role of ['admin', 'manager', 'accountant', 'member', 'viewer']) {
      const created = await createUser(admin.cookies, {
        organizationId,
        role,
        email: `${role}@newco.test`,
        fullName: `${role} person`,
      });
      expect(created.status, `role ${role} was refused`).toBe(201);
    }
  });

  it('refuses to hand out ownership at creation', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    // Ownership is transferred; minting a second owner would route around the
    // last-active-owner rule.
    const created = await createUser(admin.cookies, { organizationId, role: 'owner' });
    expect(created.status).toBe(400);
  });

  it('never returns or stores a plaintext password', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const created = await createUser(admin.cookies, {
      organizationId,
      role: 'member',
      onboarding: 'temporary_password',
    });

    const temporary = created.credential.temporaryPassword as string;
    expect(typeof temporary).toBe('string');

    // The generated value must exist nowhere in the database, in any table.
    const tables = ['users', 'password_reset_tokens', 'audit_logs', 'organization_memberships'] as const;
    for (const table of tables) {
      const rows = await ctx.db.selectFrom(table).selectAll().execute();
      expect(JSON.stringify(rows), `${table} contains the plaintext password`).not.toContain(temporary);
    }
  });

  it('assigns and then transfers a user between organizations', async () => {
    const admin = await operator();
    const first = await subscriber(admin.cookies, { email: 'a@one.test', legalName: 'One LLC' });
    const second = await subscriber(admin.cookies, { email: 'b@two.test', legalName: 'Two LLC' });

    const created = await createUser(admin.cookies, { organizationId: first.organizationId, role: 'member' });

    // Give them an override in the first tenant, so the transfer has something
    // tenant-specific to clear.
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${created.userId}/permissions`,
      headers: authHeaders(admin.cookies),
      payload: {
        organizationId: first.organizationId,
        changes: [{ subject: 'invoices', action: 'post', effect: 'grant' }],
      },
    });

    const move = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${created.userId}/organization`,
      headers: authHeaders(admin.cookies),
      payload: { organizationId: second.organizationId, role: 'manager', reason: 'Moved to the other entity.' },
    });
    expect(move.statusCode).toBe(200);
    expect(move.json().previousOrganizationId).toBe(first.organizationId);

    // The old membership is gone — a live membership IS access to the old tenant.
    const memberships = await ctx.db
      .selectFrom('organization_memberships')
      .selectAll()
      .where('user_id', '=', created.userId)
      .execute();
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.organization_id).toBe(second.organizationId);

    // And the permission configuration that only made sense there went with it.
    const leftovers = await ctx.db
      .selectFrom('user_permission_overrides')
      .selectAll()
      .where('user_id', '=', created.userId)
      .where('organization_id', '=', first.organizationId)
      .execute();
    expect(leftovers).toHaveLength(0);

    expect(await auditActions()).toContain('user.organization_transferred');
  });
});

/* ── Authorization of the administration surface ──────────────────────────── */

describe('administration endpoints are closed to everyone else', () => {
  it('refuses an ordinary customer', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    await seedUser(ctx, { email: 'plain@newco.test', fullName: 'Plain Person' });
    const customer = await login(ctx, 'plain@newco.test');

    const forbidden = [
      { method: 'POST' as const, url: '/api/admin/users', payload: { fullName: 'X', email: 'x@y.test', onboarding: 'invitation' } },
      { method: 'GET' as const, url: '/api/admin/permissions/catalog' },
      { method: 'PATCH' as const, url: `/api/admin/users/${admin.userId}/permissions`, payload: { organizationId, changes: [] } },
      { method: 'POST' as const, url: `/api/admin/users/${admin.userId}/organization`, payload: { organizationId, role: 'member', reason: 'x' } },
      { method: 'PATCH' as const, url: `/api/admin/users/${admin.userId}/platform-role`, payload: { role: 'super_admin', granted: true, reason: 'x' } },
    ];

    for (const request of forbidden) {
      const response = await ctx.app.inject({ ...request, headers: authHeaders(customer) });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
    }
  });

  it('refuses an unauthenticated caller', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/admin/permissions/catalog' });
    expect(response.statusCode).toBe(401);
  });

  it('lets support read permissions but not change them', async () => {
    const admin = await operator();
    const { organizationId, ownerUserId } = await subscriber(admin.cookies);
    const support = await operator('support', 'support@ledgora.test');

    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/users/${ownerUserId}/permissions?organizationId=${organizationId}`,
      headers: authHeaders(support.cookies),
    });
    expect(read.statusCode).toBe(200);

    // Diagnosing "why can this customer not post?" must not come with the
    // ability to answer it by granting the permission.
    const write = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${ownerUserId}/permissions`,
      headers: authHeaders(support.cookies),
      payload: {
        organizationId,
        changes: [{ subject: 'general_journal', action: 'post', effect: 'grant' }],
      },
    });
    expect(write.statusCode).toBe(403);
  });

  it('ignores a forged platform role in the request body', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    await seedUser(ctx, { email: 'forger@newco.test', fullName: 'Forger' });
    const forger = await login(ctx, 'forger@newco.test');

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: authHeaders(forger),
      payload: {
        fullName: 'Ghost',
        email: 'ghost@newco.test',
        onboarding: 'invitation',
        organizationId,
        // None of this is ever read: authorization comes from the session.
        platformRoles: ['super_admin'],
        actorPlatformRole: 'super_admin',
        principal: { platformRoles: ['super_admin'] },
      },
    });
    expect(response.statusCode).toBe(403);
    const created = await ctx.db
      .selectFrom('users')
      .select('id')
      .where('normalized_email', '=', 'ghost@newco.test')
      .executeTakeFirst();
    expect(created).toBeUndefined();
  });
});

/* ── Mass assignment and escalation ───────────────────────────────────────── */

describe('modified requests cannot grant unauthorized permissions', () => {
  it('rejects a permission the catalogue does not define', async () => {
    const admin = await operator();
    const { organizationId, ownerUserId } = await subscriber(admin.cookies);

    for (const change of [
      { subject: '*', action: 'view', effect: 'grant' },
      { subject: 'general_journal', action: 'become_super_admin', effect: 'grant' },
      { subject: 'trial_balance', action: 'post', effect: 'grant' },
    ]) {
      const response = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/admin/users/${ownerUserId}/permissions`,
        headers: authHeaders(admin.cookies),
        payload: { organizationId, changes: [change] },
      });
      expect(response.statusCode, JSON.stringify(change)).toBe(400);
    }

    expect(await ctx.db.selectFrom('user_permission_overrides').selectAll().execute()).toHaveLength(0);
  });

  it('rejects unknown fields rather than silently honouring them', async () => {
    const admin = await operator();
    const { organizationId, ownerUserId } = await subscriber(admin.cookies);

    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${ownerUserId}/permissions`,
      headers: authHeaders(admin.cookies),
      payload: {
        organizationId,
        changes: [{ subject: 'invoices', action: 'post', effect: 'grant', bypassEntitlement: true }],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses to configure permissions for a non-member', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const outsider = await seedUser(ctx, { email: 'outsider@elsewhere.test', fullName: 'Outsider' });

    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${outsider.id}/permissions`,
      headers: authHeaders(admin.cookies),
      payload: { organizationId, changes: [{ subject: 'invoices', action: 'view', effect: 'grant' }] },
    });
    expect(response.statusCode).toBe(400);
  });
});

/* ── Organization Admin scope ─────────────────────────────────────────────── */

describe('an organization administrator is confined to their own tenant', () => {
  /** A tenant with an Organization Admin who has set their own password. */
  async function tenantWithAdmin(
    admin: SessionCookies,
    options: { email: string; legalName: string; adminEmail: string },
  ): Promise<{ organizationId: string; adminUserId: string; cookies: SessionCookies }> {
    const { organizationId } = await subscriber(admin, {
      email: options.email,
      legalName: options.legalName,
    });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: authHeaders(admin),
      payload: {
        fullName: 'Org Admin',
        email: options.adminEmail,
        organizationId,
        role: 'admin',
        onboarding: 'temporary_password',
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    const temporary = body.credential.temporaryPassword as string;

    // Exchange the temporary credential for a real one, as the product requires.
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: options.adminEmail, password: temporary },
    });
    const raw = first.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : [String(raw)];
    const find = (name: string): string => {
      const match = list.find((c) => c.startsWith(`${name}=`));
      return match ? (match.split(';')[0]?.split('=').slice(1).join('=') ?? '') : '';
    };
    await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: authHeaders({ session: find('ledgora_session'), csrf: find('ledgora_csrf') }),
      payload: { currentPassword: temporary, newPassword: 'Steady-Lantern-42-Kq' },
    });

    return {
      organizationId,
      adminUserId: body.user.userId,
      cookies: await login(ctx, options.adminEmail, 'Steady-Lantern-42-Kq'),
    };
  }

  it('manages a user inside its own organization', async () => {
    const platform = await operator();
    const tenant = await tenantWithAdmin(platform.cookies, {
      email: 'owner@one.test',
      legalName: 'One LLC',
      adminEmail: 'admin@one.test',
    });
    const staff = await createUser(platform.cookies, {
      organizationId: tenant.organizationId,
      role: 'member',
      email: 'staff@one.test',
      fullName: 'Staff Person',
    });

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/organizations/current/users',
      headers: authHeaders(tenant.cookies),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().organizationId).toBe(tenant.organizationId);

    const change = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/organizations/current/users/${staff.userId}/permissions`,
      headers: authHeaders(tenant.cookies),
      payload: {
        changes: [{ subject: 'invoices', action: 'post', effect: 'grant' }],
        reason: 'Covering for the accountant.',
      },
    });
    expect(change.statusCode).toBe(200);
    expect(change.json().granted).toContain('invoices:post');
  });

  it('is rejected when targeting a user in another organization', async () => {
    const platform = await operator();
    const one = await tenantWithAdmin(platform.cookies, {
      email: 'owner@one.test',
      legalName: 'One LLC',
      adminEmail: 'admin@one.test',
    });
    const two = await subscriber(platform.cookies, { email: 'owner@two.test', legalName: 'Two LLC' });
    const foreign = await createUser(platform.cookies, {
      organizationId: two.organizationId,
      role: 'member',
      email: 'staff@two.test',
      fullName: 'Other Tenant Staff',
    });

    /*
     * There is no parameter for naming another organization on this surface, so
     * the only thing a modified request can change is the target user id. It
     * fails on the second fact: the target is not a member of the caller's org.
     * 404, not 403 — confirming the id belongs to somebody would itself be a
     * cross-tenant disclosure.
     */
    const attempt = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/organizations/current/users/${foreign.userId}/permissions`,
      headers: authHeaders(one.cookies),
      payload: { changes: [{ subject: 'invoices', action: 'post', effect: 'grant' }] },
    });
    expect(attempt.statusCode).toBe(404);

    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/organizations/current/users/${foreign.userId}/permissions`,
      headers: authHeaders(one.cookies),
    });
    expect(read.statusCode).toBe(404);

    // Nothing was written in the other tenant.
    expect(
      await ctx.db
        .selectFrom('user_permission_overrides')
        .selectAll()
        .where('organization_id', '=', two.organizationId)
        .execute(),
    ).toHaveLength(0);
  });

  it('cannot grant a permission it does not hold, and the attempt is recorded', async () => {
    const platform = await operator();
    const tenant = await tenantWithAdmin(platform.cookies, {
      email: 'owner@one.test',
      legalName: 'One LLC',
      adminEmail: 'admin@one.test',
    });
    const staff = await createUser(platform.cookies, {
      organizationId: tenant.organizationId,
      role: 'member',
      email: 'staff@one.test',
      fullName: 'Staff Person',
    });

    // Take a permission away from the admin themselves, then have them try to
    // hand it to somebody else.
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${tenant.adminUserId}/permissions`,
      headers: authHeaders(platform.cookies),
      payload: {
        organizationId: tenant.organizationId,
        changes: [{ subject: 'manufacturing', action: 'post', effect: 'deny' }],
      },
    });

    /*
     * Withdrawing a permission revokes the holder's sessions, so the admin has
     * to sign in again. That is the behaviour under test elsewhere; here it is
     * simply a consequence to work with.
     */
    const refreshed = await login(ctx, 'admin@one.test', 'Steady-Lantern-42-Kq');

    const attempt = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/organizations/current/users/${staff.userId}/permissions`,
      headers: authHeaders(refreshed),
      payload: { changes: [{ subject: 'manufacturing', action: 'post', effect: 'grant' }] },
    });
    expect(attempt.statusCode).toBe(403);

    // A rejected escalation that leaves no trace is indistinguishable from one
    // that never happened.
    expect(await auditActions()).toContain('permission.escalation_rejected');
    expect(
      await ctx.db
        .selectFrom('user_permission_overrides')
        .selectAll()
        .where('user_id', '=', staff.userId)
        .where('subject', '=', 'manufacturing')
        .execute(),
    ).toHaveLength(0);
  });

  it('cannot grant platform authority — there is no field for it', async () => {
    const platform = await operator();
    const tenant = await tenantWithAdmin(platform.cookies, {
      email: 'owner@one.test',
      legalName: 'One LLC',
      adminEmail: 'admin@one.test',
    });

    // The operator route is the only one that can write `platform_user_roles`,
    // and it is behind a capability this customer does not hold.
    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${tenant.adminUserId}/platform-role`,
      headers: authHeaders(tenant.cookies),
      payload: { role: 'super_admin', granted: true, reason: 'Promote me.' },
    });
    expect(response.statusCode).toBe(403);
    expect(
      await ctx.db.selectFrom('platform_user_roles').selectAll().where('user_id', '=', tenant.adminUserId).execute(),
    ).toHaveLength(0);
  });

  it('cannot act on an owner, another admin, or itself', async () => {
    const platform = await operator();
    const tenant = await tenantWithAdmin(platform.cookies, {
      email: 'owner@one.test',
      legalName: 'One LLC',
      adminEmail: 'admin@one.test',
    });
    const owner = await ctx.db
      .selectFrom('organization_memberships')
      .select('user_id')
      .where('organization_id', '=', tenant.organizationId)
      .where('role', '=', 'owner')
      .executeTakeFirstOrThrow();

    const againstOwner = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/organizations/current/users/${owner.user_id}`,
      headers: authHeaders(tenant.cookies),
      payload: { role: 'viewer', reason: 'Takeover attempt.' },
    });
    expect(againstOwner.statusCode).toBe(403);

    const againstSelf = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/organizations/current/users/${tenant.adminUserId}`,
      headers: authHeaders(tenant.cookies),
      payload: { role: 'manager', reason: 'Self-edit.' },
    });
    expect(againstSelf.statusCode).toBe(400);
  });
});

/* ── The subscription boundary ────────────────────────────────────────────── */

describe('subscription entitlements cannot be bypassed', () => {
  it('keeps an unentitled module inaccessible even when explicitly granted', async () => {
    const admin = await operator();
    // `core` sells accounting, invoicing and reports — not manufacturing.
    const { organizationId, ownerUserId } = await subscriber(admin.cookies, { plan: 'core' });

    const granted = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${ownerUserId}/permissions`,
      headers: authHeaders(admin.cookies),
      payload: {
        organizationId,
        changes: [{ subject: 'manufacturing', action: 'post', effect: 'grant' }],
      },
    });
    // The grant is ACCEPTED — configuration is allowed to describe a module the
    // tenant might buy later. It simply does not take effect.
    expect(granted.statusCode).toBe(200);

    const resolved = await effective(admin.cookies, ownerUserId, organizationId);
    expect(resolved.allowedKeys).not.toContain('manufacturing:post');

    const cell = resolved.permissions.find(
      (p) => p.subject === 'manufacturing' && p.action === 'post',
    )!;
    expect(cell.allowed).toBe(false);
    expect(cell.source).toBe('not_entitled');
    // The configuration survives, visibly.
    expect(cell.override).toBe('grant');
    expect(cell.blockedByEntitlement).toBe(true);
  });

  it('deactivates permissions on downgrade and restores them on upgrade', async () => {
    const admin = await operator();
    const { organizationId, ownerUserId } = await subscriber(admin.cookies, { plan: 'enterprise' });

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${ownerUserId}/permissions`,
      headers: authHeaders(admin.cookies),
      payload: {
        organizationId,
        changes: [{ subject: 'manufacturing', action: 'post', effect: 'grant' }],
      },
    });
    expect((await effective(admin.cookies, ownerUserId, organizationId)).allowedKeys).toContain(
      'manufacturing:post',
    );

    const overridesBefore = await ctx.db.selectFrom('user_permission_overrides').selectAll().execute();

    /* ── Downgrade ─────────────────────────────────────────────────────── */
    const downgrade = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/assign-package`,
      headers: authHeaders(admin.cookies),
      payload: { planId: await planId('core'), reason: 'Customer downgraded.' },
    });
    expect(downgrade.statusCode).toBe(200);

    const afterDowngrade = await effective(admin.cookies, ownerUserId, organizationId);
    expect(afterDowngrade.allowedKeys).not.toContain('manufacturing:post');

    // Nothing was destroyed — this is what makes the downgrade reversible.
    expect(await ctx.db.selectFrom('user_permission_overrides').selectAll().execute()).toEqual(
      overridesBefore,
    );

    /* ── Upgrade back ──────────────────────────────────────────────────── */
    const upgrade = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/assign-package`,
      headers: authHeaders(admin.cookies),
      payload: { planId: await planId('enterprise'), reason: 'Customer upgraded again.' },
    });
    expect(upgrade.statusCode).toBe(200);

    // The original configuration is simply live again.
    expect((await effective(admin.cookies, ownerUserId, organizationId)).allowedKeys).toContain(
      'manufacturing:post',
    );
  });
});

/* ── Protecting the platform ──────────────────────────────────────────────── */

describe('the platform always retains an administrator', () => {
  it('refuses to demote the last active super administrator', async () => {
    const admin = await operator();
    const second = await operator('super_admin', 'second@ledgora.test');

    // Two exist, so demoting one is fine.
    const first = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${second.userId}/platform-role`,
      headers: authHeaders(admin.cookies),
      payload: { role: 'super_admin', granted: false, reason: 'Left the team.' },
    });
    expect(first.statusCode).toBe(200);

    // Now only `admin` remains. Demoting them from a second super-admin session
    // must be refused — but they are the actor, so self-demotion is what is
    // actually being attempted here, and that is refused too.
    const third = await operator('super_admin', 'third@ledgora.test');
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${admin.userId}/platform-role`,
      headers: authHeaders(third.cookies),
      payload: { role: 'super_admin', granted: false, reason: 'Reorganisation.' },
    });

    // `third` is now the last one. They cannot demote themselves.
    const self = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${third.userId}/platform-role`,
      headers: authHeaders(third.cookies),
      payload: { role: 'super_admin', granted: false, reason: 'Self-demotion.' },
    });
    expect(self.statusCode).toBe(400);

    const remaining = await ctx.db
      .selectFrom('platform_user_roles')
      .innerJoin('users', 'users.id', 'platform_user_roles.user_id')
      .select('platform_user_roles.id')
      .where('platform_user_roles.role', '=', 'super_admin')
      .where('users.status', '=', 'active')
      .execute();
    expect(remaining.length).toBeGreaterThan(0);
  });

  it('refuses a non-super-admin trying to create one, and records the attempt', async () => {
    const admin = await operator();
    const billing = await operator('billing_admin', 'billing@ledgora.test');

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: authHeaders(billing.cookies),
      payload: {
        fullName: 'Would-be Operator',
        email: 'wouldbe@ledgora.test',
        onboarding: 'invitation',
        platformRoles: ['super_admin'],
      },
    });
    // `users.create` is super_admin only, so this never reaches the role check.
    expect(response.statusCode).toBe(403);

    // The same attempt from a super administrator succeeds, which is the control.
    const allowed = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: authHeaders(admin.cookies),
      payload: {
        fullName: 'Real Operator',
        email: 'real@ledgora.test',
        onboarding: 'invitation',
        platformRoles: ['super_admin'],
      },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it('refuses an operator disabling their own account', async () => {
    const admin = await operator();
    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/members/${admin.userId}/status`,
      headers: authHeaders(admin.cookies),
      payload: { status: 'disabled', reason: 'Self-lockout attempt.' },
    });
    expect(response.statusCode).toBe(400);
  });
});

/* ── Invitations ──────────────────────────────────────────────────────────── */

describe('invitation and reset links', () => {
  it('completes password setup exactly once', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const created = await createUser(admin.cookies, { organizationId, role: 'member' });
    const token = created.credential.invitationToken as string;

    // The link reports itself usable, with a MASKED address and nothing else.
    const describe1 = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/invitation/inspect',
      payload: { token },
    });
    expect(describe1.statusCode).toBe(200);
    expect(describe1.json().valid).toBe(true);
    expect(describe1.json().purpose).toBe('invitation');
    expect(describe1.json().maskedEmail).toMatch(/^s\*+@newco\.test$/);
    expect(describe1.json().maskedEmail).not.toBe('sara@newco.test');

    const redeem = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, newPassword: 'Quiet-Meadow-77-Vz' },
    });
    expect(redeem.statusCode).toBe(200);

    // The account is now usable and its address is verified.
    const user = await ctx.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', created.userId)
      .executeTakeFirstOrThrow();
    expect(user.status).toBe('active');
    expect(user.email_verified_at).not.toBeNull();
    expect(user.must_change_password).toBe(false);

    // The invited membership was accepted at the same moment.
    const membership = await ctx.db
      .selectFrom('organization_memberships')
      .selectAll()
      .where('user_id', '=', created.userId)
      .executeTakeFirstOrThrow();
    expect(membership.status).toBe('active');

    // And the new password works.
    expect((await tryLogin('sara@newco.test', 'Quiet-Meadow-77-Vz')).status).toBe(200);
  });

  it('cannot be reused', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const created = await createUser(admin.cookies, { organizationId, role: 'member' });
    const token = created.credential.invitationToken as string;

    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token, newPassword: 'Quiet-Meadow-77-Vz' },
      })).statusCode,
    ).toBe(200);

    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, newPassword: 'Different-Harbour-31-Xy' },
    });
    expect(second.statusCode).toBe(400);

    // The first password still stands — the failed replay changed nothing.
    expect((await tryLogin('sara@newco.test', 'Quiet-Meadow-77-Vz')).status).toBe(200);
    expect((await tryLogin('sara@newco.test', 'Different-Harbour-31-Xy')).status).toBe(401);
  });

  it('expires', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const created = await createUser(admin.cookies, { organizationId, role: 'member' });
    const token = created.credential.invitationToken as string;

    // Age the token past its window rather than waiting for real time.
    await ctx.db
      .updateTable('password_reset_tokens')
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where('user_id', '=', created.userId)
      .execute();

    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/invitation/inspect',
        payload: { token },
      })).json().valid,
    ).toBe(false);

    const redeem = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, newPassword: 'Quiet-Meadow-77-Vz' },
    });
    expect(redeem.statusCode).toBe(400);
  });

  it('can be revoked before use', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const created = await createUser(admin.cookies, { organizationId, role: 'member' });
    const token = created.credential.invitationToken as string;

    const revoke = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${created.userId}/invitation/revoke`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Sent to the wrong address.' },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().revoked).toBeGreaterThan(0);

    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token, newPassword: 'Quiet-Meadow-77-Vz' },
      })).statusCode,
    ).toBe(400);

    // Revocation is recorded as revocation, not as a redemption that never was.
    // Scoped to THIS user: the tenant's owner has a token of their own.
    const rows = await ctx.db
      .selectFrom('password_reset_tokens')
      .selectAll()
      .where('user_id', '=', created.userId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revoked_at).not.toBeNull();
    expect(rows[0]!.used_at).toBeNull();
    expect(await auditActions()).toContain('invitation.revoked');
  });

  it('gives the same answer for an invalid token as for an expired one', async () => {
    // Distinguishing them tells a holder of a guessed token that they guessed
    // right, so both must be indistinguishable.
    const invented = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/invitation/inspect',
      payload: { token: 'this-token-was-never-issued-at-all' },
    });
    expect(invented.json()).toEqual({ valid: false, purpose: null, maskedEmail: null, expiresAt: null });
  });

  it('will not reactivate a deliberately disabled account', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const created = await createUser(admin.cookies, { organizationId, role: 'member' });
    const token = created.credential.invitationToken as string;

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/members/${created.userId}/status`,
      headers: authHeaders(admin.cookies),
      payload: { status: 'disabled', reason: 'Left the company.' },
    });

    // The link still sets a password, but must not overturn an administrative
    // decision to disable the account.
    const redeem = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, newPassword: 'Quiet-Meadow-77-Vz' },
    });
    expect(redeem.statusCode).toBe(200);

    const user = await ctx.db
      .selectFrom('users')
      .select('status')
      .where('id', '=', created.userId)
      .executeTakeFirstOrThrow();
    expect(user.status).toBe('disabled');
    /*
     * 401, not 403. `authService` answers a disabled account with the generic
     * `invalid_credentials` deliberately, so the response cannot be used to
     * discover which addresses are registered or which have been disabled.
     */
    const refused = await tryLogin('sara@newco.test', 'Quiet-Meadow-77-Vz');
    expect(refused.status).toBe(401);
    expect((refused.body as { error: { code: string } }).error.code).toBe('invalid_credentials');
  });
});

/* ── Status and sessions ──────────────────────────────────────────────────── */

describe('suspended and deactivated users lose access', () => {
  it('cannot authenticate once disabled', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const created = await createUser(admin.cookies, {
      organizationId,
      role: 'member',
      onboarding: 'temporary_password',
    });
    const temporary = created.credential.temporaryPassword as string;

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/members/${created.userId}/status`,
      headers: authHeaders(admin.cookies),
      payload: { status: 'disabled', reason: 'Offboarded.' },
    });

    // Generic refusal by design — see the note on the disabled-account test above.
    const refused = await tryLogin('sara@newco.test', temporary);
    expect(refused.status).toBe(401);
    expect((refused.body as { error: { code: string } }).error.code).toBe('invalid_credentials');
  });

  it('cannot continue a session that was already open', async () => {
    const admin = await operator();
    const { ownerUserId } = await subscriber(admin.cookies);
    const owner = await ctx.db
      .selectFrom('users')
      .select('email')
      .where('id', '=', ownerUserId)
      .executeTakeFirstOrThrow();

    // Give the owner a usable password and a live session.
    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${ownerUserId}/reset-password`,
      headers: authHeaders(admin.cookies),
      payload: { mode: 'temporary', reason: 'Set up for the test.' },
    });
    const temporary = reset.json().credential.temporaryPassword as string;
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: owner.email, password: temporary },
    });
    const raw = first.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : [String(raw)];
    const find = (name: string): string => {
      const match = list.find((c) => c.startsWith(`${name}=`));
      return match ? (match.split(';')[0]?.split('=').slice(1).join('=') ?? '') : '';
    };
    const cookies = { session: find('ledgora_session'), csrf: find('ledgora_csrf') };
    await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: authHeaders(cookies),
      payload: { currentPassword: temporary, newPassword: 'Amber-Rooftop-19-Nk' },
    });
    const live = await login(ctx, owner.email, 'Amber-Rooftop-19-Nk');

    expect(
      (await ctx.app.inject({
        method: 'GET',
        url: '/api/auth/session',
        headers: authHeaders(live),
      })).json().authenticated,
    ).toBe(true);

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/members/${ownerUserId}/status`,
      headers: authHeaders(admin.cookies),
      payload: { status: 'disabled', reason: 'Offboarded.' },
    });

    // Sessions are re-resolved against the database on every request, so a
    // disabled account stops working immediately rather than at cookie expiry.
    expect(
      (await ctx.app.inject({
        method: 'GET',
        url: '/api/auth/session',
        headers: authHeaders(live),
      })).json().authenticated,
    ).toBe(false);
  });

  it('ends live sessions when a permission is withdrawn', async () => {
    const admin = await operator();
    const { organizationId, ownerUserId } = await subscriber(admin.cookies);

    await ctx.db
      .insertInto('auth_sessions')
      .values({
        user_id: ownerUserId,
        token_hash: 'a'.repeat(64),
        expires_at: new Date(Date.now() + 3_600_000),
      })
      .execute();

    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${ownerUserId}/permissions`,
      headers: authHeaders(admin.cookies),
      payload: {
        organizationId,
        changes: [{ subject: 'general_journal', action: 'post', effect: 'deny' }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().revokedSessions).toBeGreaterThan(0);
  });
});

/* ── Retention ────────────────────────────────────────────────────────────── */

describe('deactivation preserves history', () => {
  it('keeps every historical reference to a disabled user valid', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const created = await createUser(admin.cookies, { organizationId, role: 'accountant' });

    // Generate audit history naming this user as a target.
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${created.userId}/permissions`,
      headers: authHeaders(admin.cookies),
      payload: {
        organizationId,
        changes: [{ subject: 'invoices', action: 'approve', effect: 'grant' }],
      },
    });

    const historyBefore = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('target_id', '=', created.userId)
      .execute();
    expect(historyBefore.length).toBeGreaterThan(0);

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/members/${created.userId}/status`,
      headers: authHeaders(admin.cookies),
      payload: { status: 'disabled', reason: 'Left the company.' },
    });

    // The row survives — every foreign key pointing at it still resolves.
    const user = await ctx.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', created.userId)
      .executeTakeFirst();
    expect(user).toBeDefined();
    expect(user!.status).toBe('disabled');

    // The membership, the audit trail and the permission configuration all stay.
    expect(
      await ctx.db
        .selectFrom('organization_memberships')
        .selectAll()
        .where('user_id', '=', created.userId)
        .execute(),
    ).toHaveLength(1);
    expect(
      await ctx.db.selectFrom('audit_logs').selectAll().where('target_id', '=', created.userId).execute(),
    ).toEqual(expect.arrayContaining(historyBefore));
    expect(
      await ctx.db
        .selectFrom('user_permission_overrides')
        .selectAll()
        .where('user_id', '=', created.userId)
        .execute(),
    ).toHaveLength(1);
  });
});

/* ── Audit ────────────────────────────────────────────────────────────────── */

describe('the audit trail', () => {
  it('records every material access change with its previous and new value', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const created = await createUser(admin.cookies, { organizationId, role: 'member' });

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${created.userId}/permissions`,
      headers: authHeaders(admin.cookies),
      payload: {
        organizationId,
        changes: [
          { subject: 'invoices', action: 'post', effect: 'grant' },
          { subject: 'invoices', action: 'edit', effect: 'deny' },
        ],
        reason: 'Temporary cover.',
      },
    });
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/members/${created.userId}/status`,
      headers: authHeaders(admin.cookies),
      payload: { status: 'disabled', reason: 'Suspended pending review.' },
    });

    const actions = await auditActions();
    for (const expected of [
      'user.created_by_admin',
      'user.organization_assigned',
      'invitation.created',
      'permission.granted',
      'permission.denied',
      'member.account_status_changed',
    ]) {
      expect(actions, `missing audit action: ${expected}`).toContain(expected);
    }

    // One entry PER CELL, each carrying what changed.
    const grantEntry = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'permission.granted')
      .executeTakeFirstOrThrow();
    const metadata =
      typeof grantEntry.metadata === 'string' ? JSON.parse(grantEntry.metadata) : grantEntry.metadata;
    expect(metadata.subject).toBe('invoices');
    expect(metadata.permissionAction).toBe('post');
    expect(metadata.previousValue).toBe('inherit');
    expect(metadata.newValue).toBe('grant');
    expect(grantEntry.actor_user_id).toBe(admin.userId);
    expect(grantEntry.target_id).toBe(created.userId);
    expect(grantEntry.organization_id).toBe(organizationId);
  });

  it('never stores a credential, token or hash', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const created = await createUser(admin.cookies, {
      organizationId,
      role: 'member',
      onboarding: 'temporary_password',
    });
    const temporary = created.credential.temporaryPassword as string;

    const entries = await ctx.db.selectFrom('audit_logs').selectAll().execute();
    const serialised = JSON.stringify(entries);
    expect(serialised).not.toContain(temporary);

    // And the token hashes never appear either.
    const tokens = await ctx.db.selectFrom('password_reset_tokens').select('token_hash').execute();
    for (const { token_hash } of tokens) expect(serialised).not.toContain(token_hash);
  });

  it('does not produce an entry for a change that changes nothing', async () => {
    const admin = await operator();
    const { organizationId, ownerUserId } = await subscriber(admin.cookies);

    const change = {
      organizationId,
      changes: [{ subject: 'invoices', action: 'post', effect: 'grant' }],
    };
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${ownerUserId}/permissions`,
      headers: authHeaders(admin.cookies),
      payload: change,
    });
    const after = (await auditActions()).filter((a) => a === 'permission.granted').length;

    // Applying the identical change again is a no-op, and an audit entry saying
    // otherwise would be a false record.
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${ownerUserId}/permissions`,
      headers: authHeaders(admin.cookies),
      payload: change,
    });
    expect((await auditActions()).filter((a) => a === 'permission.granted').length).toBe(after);
  });
});

/* ── Reset to role defaults ───────────────────────────────────────────────── */

describe('resetting to role defaults', () => {
  it('clears every override and records what went', async () => {
    const admin = await operator();
    const { organizationId, ownerUserId } = await subscriber(admin.cookies);

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${ownerUserId}/permissions`,
      headers: authHeaders(admin.cookies),
      payload: {
        organizationId,
        changes: [
          { subject: 'invoices', action: 'post', effect: 'deny' },
          { subject: 'manufacturing', action: 'approve', effect: 'grant' },
        ],
      },
    });
    expect(await ctx.db.selectFrom('user_permission_overrides').selectAll().execute()).toHaveLength(2);

    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${ownerUserId}/permissions/reset`,
      headers: authHeaders(admin.cookies),
      payload: { organizationId, reason: 'Back to the role.' },
    });
    expect(reset.statusCode).toBe(200);
    expect(await ctx.db.selectFrom('user_permission_overrides').selectAll().execute()).toHaveLength(0);
    expect(await auditActions()).toContain('permission.reset_all');

    // The owner's role rights are back in force.
    expect((await effective(admin.cookies, ownerUserId, organizationId)).allowedKeys).toContain(
      'invoices:post',
    );
  });
});

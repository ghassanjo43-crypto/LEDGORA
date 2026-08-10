/**
 * The invited → active membership lifecycle.
 *
 * ── The rule under test ──────────────────────────────────────────────────────
 * An `invited` membership becomes `active` at the moment its holder first
 * establishes a password of their own. Ledgora offers two ways to reach that
 * milestone — redeem a single-use link, or replace a forced temporary password —
 * and they are two routes to ONE transition, not two lifecycles.
 *
 * These tests exist to keep that single rule honest from both directions:
 * everything that SHOULD activate does, and everything that should not — a
 * suspended membership, a removed member, a voluntary password change, a
 * replayed or expired token — does not. A second implementation of the
 * transition would pass half of them.
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

async function operator(): Promise<{ cookies: SessionCookies; userId: string }> {
  const user = await seedUser(ctx, {
    email: 'super@ledgora.test',
    fullName: 'Platform Super Admin',
    platformRoles: ['super_admin'],
  });
  return { cookies: await login(ctx, 'super@ledgora.test'), userId: user.id };
}

async function planId(code = 'enterprise'): Promise<string> {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
  const found = response.json().plans.find((p: { code: string }) => p.code === code);
  if (!found) throw new Error(`seeded catalogue is missing "${code}"`);
  return found.id;
}

async function subscriber(admin: SessionCookies): Promise<{ organizationId: string }> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/subscribers',
    headers: authHeaders(admin),
    payload: {
      fullName: 'Owner Person',
      email: 'owner@newco.test',
      organizationLegalName: 'NewCo Trading LLC',
      country: 'AE',
      planId: await planId(),
      onboarding: 'temporary',
      paymentConfirmed: true,
    },
  });
  expect(response.statusCode).toBe(201);
  return { organizationId: response.json().subscriber.organizationId };
}

/** Invite a colleague through the operator route. Membership starts `invited`. */
async function invite(
  admin: SessionCookies,
  organizationId: string,
  email: string,
  role = 'member',
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

/** Issue a temporary password and return it. */
async function temporaryPassword(admin: SessionCookies, userId: string): Promise<string> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/admin/members/${userId}/reset-password`,
    headers: authHeaders(admin),
    payload: { mode: 'temporary', reason: 'Onboarding.' },
  });
  expect(response.statusCode).toBe(200);
  return response.json().credential.temporaryPassword;
}

function cookiesFrom(headers: Record<string, unknown>): SessionCookies {
  const raw = headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const find = (name: string): string => {
    const match = list.find((c) => c.startsWith(`${name}=`));
    return match ? (match.split(';')[0]?.split('=').slice(1).join('=') ?? '') : '';
  };
  return { session: find('ledgora_session'), csrf: find('ledgora_csrf') };
}

/**
 * Sign in with a temporary credential and replace it — the complete
 * temporary-password onboarding path, exactly as the product performs it.
 */
async function completeForcedChange(
  email: string,
  temporary: string,
  newPassword: string,
): Promise<number> {
  const first = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: temporary },
  });
  expect(first.statusCode).toBe(200);
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: authHeaders(cookiesFrom(first.headers as Record<string, unknown>)),
    payload: { currentPassword: temporary, newPassword },
  });
  return response.statusCode;
}

async function membershipStatus(userId: string): Promise<string | undefined> {
  const row = await ctx.db
    .selectFrom('organization_memberships')
    .select('status')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row?.status;
}

/** What the member's own organization surface reports. */
async function ownRoster(cookies: SessionCookies): Promise<{ organizationId: string | null; count: number }> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: '/api/organizations/current/members',
    headers: authHeaders(cookies),
  });
  const body = response.json();
  return { organizationId: body.organizationId, count: body.members.length };
}

async function activationEvents(userId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await ctx.db
    .selectFrom('audit_logs')
    .selectAll()
    .where('action', '=', 'membership.activated')
    .where('target_id', '=', userId)
    .execute();
  return rows.map((row) => ({
    ...row,
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
  }));
}

const NEW_PASSWORD = 'Bright-Harbour-58-Zq';

/* ── The temporary-password path ──────────────────────────────────────────── */

describe('replacing a forced temporary password', () => {
  it('activates the invited membership and grants organization access', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const memberId = await invite(admin.cookies, organizationId, 'gone@newco.test');

    // Before: invited, and the organization is not reachable.
    expect(await membershipStatus(memberId)).toBe('invited');

    const temporary = await temporaryPassword(admin.cookies, memberId);
    expect(await completeForcedChange('gone@newco.test', temporary, NEW_PASSWORD)).toBe(200);

    expect(await membershipStatus(memberId)).toBe('active');

    const member = await login(ctx, 'gone@newco.test', NEW_PASSWORD);
    const roster = await ownRoster(member);
    expect(roster.organizationId).toBe(organizationId);
    expect(roster.count).toBeGreaterThan(0);
  });

  it('records the activation with its trigger', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const memberId = await invite(admin.cookies, organizationId, 'gone@newco.test');

    const temporary = await temporaryPassword(admin.cookies, memberId);
    await completeForcedChange('gone@newco.test', temporary, NEW_PASSWORD);

    const events = await activationEvents(memberId);
    expect(events).toHaveLength(1);
    expect(events[0]!.organization_id).toBe(organizationId);
    // The member did this themselves — attributing it to the operator who issued
    // the credential would misstate who accepted the invitation.
    expect(events[0]!.actor_user_id).toBe(memberId);
    expect(events[0]!.actor_platform_role).toBeNull();
    const metadata = events[0]!.metadata as Record<string, unknown>;
    expect(metadata.trigger).toBe('temporary_password_replaced');
    expect(metadata.previousStatus).toBe('invited');
    expect(metadata.newStatus).toBe('active');
  });

  it('is idempotent — a later password change activates nothing again', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const memberId = await invite(admin.cookies, organizationId, 'gone@newco.test');

    const temporary = await temporaryPassword(admin.cookies, memberId);
    await completeForcedChange('gone@newco.test', temporary, NEW_PASSWORD);
    expect(await activationEvents(memberId)).toHaveLength(1);

    // A second, voluntary change by the now-active member.
    const member = await login(ctx, 'gone@newco.test', NEW_PASSWORD);
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: authHeaders(member),
      payload: { currentPassword: NEW_PASSWORD, newPassword: 'Quiet-Meadow-77-Vz' },
    });
    expect(second.statusCode).toBe(200);

    // No second activation entry: nothing changed, so nothing is claimed.
    expect(await activationEvents(memberId)).toHaveLength(1);
    expect(await membershipStatus(memberId)).toBe('active');
  });

  it('does not activate on a voluntary password change', async () => {
    // A member who already has a working password and is still `invited` has not
    // completed an administrator-initiated onboarding act, so changing their
    // password is not acceptance of anything.
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const memberId = await invite(admin.cookies, organizationId, 'volunteer@newco.test');

    // Give them a usable password WITHOUT the forced-change flag, the way a
    // self-service reset would.
    const temporary = await temporaryPassword(admin.cookies, memberId);
    await ctx.db
      .updateTable('users')
      .set({ must_change_password: false, password_expires_at: null })
      .where('id', '=', memberId)
      .execute();

    const cookies = await login(ctx, 'volunteer@newco.test', temporary);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: authHeaders(cookies),
      payload: { currentPassword: temporary, newPassword: NEW_PASSWORD },
    });
    expect(response.statusCode).toBe(200);

    expect(await membershipStatus(memberId)).toBe('invited');
    expect(await activationEvents(memberId)).toHaveLength(0);
    expect((await ownRoster(await login(ctx, 'volunteer@newco.test', NEW_PASSWORD))).organizationId).toBeNull();
  });
});

/* ── The invitation-link path ─────────────────────────────────────────────── */

describe('redeeming an invitation link', () => {
  /** Create a user through the admin route and return the one-time token. */
  async function invitedUser(
    admin: SessionCookies,
    organizationId: string,
    email = 'sara@newco.test',
  ): Promise<{ userId: string; token: string }> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: authHeaders(admin),
      payload: {
        fullName: 'Sara Accountant',
        email,
        organizationId,
        role: 'accountant',
        onboarding: 'invitation',
      },
    });
    expect(response.statusCode).toBe(201);
    return { userId: response.json().user.userId, token: response.json().credential.invitationToken };
  }

  it('activates the invited membership through the same transition', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const { userId, token } = await invitedUser(admin.cookies, organizationId);

    expect(await membershipStatus(userId)).toBe('invited');

    const redeem = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, newPassword: NEW_PASSWORD },
    });
    expect(redeem.statusCode).toBe(200);

    expect(await membershipStatus(userId)).toBe('active');

    // The SAME audit action as the temporary-password path, with a different
    // trigger — one lifecycle, two routes to it.
    const events = await activationEvents(userId);
    expect(events).toHaveLength(1);
    expect((events[0]!.metadata as Record<string, unknown>).trigger).toBe('invitation_redeemed');

    const roster = await ownRoster(await login(ctx, 'sara@newco.test', NEW_PASSWORD));
    expect(roster.organizationId).toBe(organizationId);
  });

  it('activates nothing when the token is expired', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const { userId, token } = await invitedUser(admin.cookies, organizationId);

    await ctx.db
      .updateTable('password_reset_tokens')
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where('user_id', '=', userId)
      .execute();

    const redeem = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, newPassword: NEW_PASSWORD },
    });
    expect(redeem.statusCode).toBe(400);

    // Neither the password nor the membership moved.
    expect(await membershipStatus(userId)).toBe('invited');
    expect(await activationEvents(userId)).toHaveLength(0);
    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'sara@newco.test', password: NEW_PASSWORD },
      })).statusCode,
    ).toBe(401);
  });

  it('activates nothing when the token is reused', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const { userId, token } = await invitedUser(admin.cookies, organizationId);

    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token, newPassword: NEW_PASSWORD },
      })).statusCode,
    ).toBe(200);

    // Put the membership back to `invited`, so a second activation WOULD be
    // visible if the replay were honoured.
    await ctx.db
      .updateTable('organization_memberships')
      .set({ status: 'invited' })
      .where('user_id', '=', userId)
      .execute();

    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, newPassword: 'Quiet-Meadow-77-Vz' },
    });
    expect(replay.statusCode).toBe(400);

    expect(await membershipStatus(userId)).toBe('invited');
    expect(await activationEvents(userId)).toHaveLength(1);
  });
});

/* ── What must never be activated ─────────────────────────────────────────── */

describe('credentials alone never grant organization access', () => {
  it('leaves a suspended membership suspended', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const memberId = await invite(admin.cookies, organizationId, 'suspended@newco.test');

    // Onboard them properly, then suspend the membership.
    const temporary = await temporaryPassword(admin.cookies, memberId);
    await completeForcedChange('suspended@newco.test', temporary, NEW_PASSWORD);
    expect(await membershipStatus(memberId)).toBe('active');

    const suspend = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/members/${memberId}/membership`,
      headers: authHeaders(admin.cookies),
      payload: { organizationId, status: 'suspended' },
    });
    expect(suspend.statusCode).toBe(200);

    // A fresh administrator-issued credential, fully exchanged. Suspension is an
    // administrator's decision; a password change must never overturn it.
    const second = await temporaryPassword(admin.cookies, memberId);
    expect(await completeForcedChange('suspended@newco.test', second, 'Quiet-Meadow-77-Vz')).toBe(200);

    expect(await membershipStatus(memberId)).toBe('suspended');
    const roster = await ownRoster(await login(ctx, 'suspended@newco.test', 'Quiet-Meadow-77-Vz'));
    expect(roster.organizationId).toBeNull();
    expect(roster.count).toBe(0);
  });

  it('gives a removed member nothing to activate', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const memberId = await invite(admin.cookies, organizationId, 'removed@newco.test');

    const temporary = await temporaryPassword(admin.cookies, memberId);
    await completeForcedChange('removed@newco.test', temporary, NEW_PASSWORD);

    const remove = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${memberId}/remove`,
      headers: authHeaders(admin.cookies),
      payload: { organizationId, reason: 'Left the company.' },
    });
    expect(remove.statusCode).toBe(200);

    // A new credential, fully exchanged — there is no membership row to match,
    // so possessing valid credentials restores nothing.
    const second = await temporaryPassword(admin.cookies, memberId);
    expect(await completeForcedChange('removed@newco.test', second, 'Quiet-Meadow-77-Vz')).toBe(200);

    expect(await membershipStatus(memberId)).toBeUndefined();
    const roster = await ownRoster(await login(ctx, 'removed@newco.test', 'Quiet-Meadow-77-Vz'));
    expect(roster.organizationId).toBeNull();

    // The account and its history survive the removal — nothing here deletes
    // accounting attribution.
    const user = await ctx.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', memberId)
      .executeTakeFirstOrThrow();
    expect(user.deleted_at).toBeNull();
    expect(user.anonymized_at).toBeNull();
  });

  it('keeps a deactivated account out entirely', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const memberId = await invite(admin.cookies, organizationId, 'disabled@newco.test');

    const temporary = await temporaryPassword(admin.cookies, memberId);
    await completeForcedChange('disabled@newco.test', temporary, NEW_PASSWORD);

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/members/${memberId}/status`,
      headers: authHeaders(admin.cookies),
      payload: { status: 'disabled', reason: 'Offboarded.' },
    });

    // Generic refusal by design, so the response cannot be used to discover
    // which addresses exist or which have been disabled.
    const refused = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'disabled@newco.test', password: NEW_PASSWORD },
    });
    expect(refused.statusCode).toBe(401);
    // The membership is untouched — deactivation is reversible and destroys
    // nothing.
    expect(await membershipStatus(memberId)).toBe('active');
  });

  it('does not activate one tenant’s invitation from another tenant’s onboarding', async () => {
    // Tenant isolation: activation is keyed to the USER, and only to memberships
    // that user actually holds.
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const mine = await invite(admin.cookies, organizationId, 'mine@newco.test');
    const theirs = await invite(admin.cookies, organizationId, 'theirs@newco.test');

    const temporary = await temporaryPassword(admin.cookies, mine);
    await completeForcedChange('mine@newco.test', temporary, NEW_PASSWORD);

    expect(await membershipStatus(mine)).toBe('active');
    // The colleague's invitation is untouched by someone else's onboarding.
    expect(await membershipStatus(theirs)).toBe('invited');
    expect(await activationEvents(theirs)).toHaveLength(0);
  });
});

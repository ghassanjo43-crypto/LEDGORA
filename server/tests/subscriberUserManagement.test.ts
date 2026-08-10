/**
 * Subscriber-level user and role management.
 *
 * The claims this suite proves:
 *
 *   identity    inviting somebody adds a MEMBERSHIP — never a subscriber, an
 *               organization, a subscription, or a duplicate identity;
 *   seats       the limit is enforced transactionally, under a row lock, so
 *               concurrent invitations cannot exceed it;
 *   lifecycle   an archived or pending-deletion subscriber takes on nobody;
 *   invitations single-use, expiring, resendable, cancellable — and the token
 *               exists in exactly one response;
 *   isolation   an Organization Admin reaches only their own tenant, and
 *               removing a membership in A leaves B untouched;
 *   retention   removal revokes access and destroys no accounting attribution.
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
import { inviteMember } from '../src/services/memberService.js';
import { assignPlatformRole, createUser } from '../src/services/userService.js';

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
  return response.json().plans.find((p: { code: string }) => p.code === code).id;
}

async function subscriber(
  admin: SessionCookies,
  options: { email?: string; legalName?: string; seats?: number } = {},
): Promise<{ organizationId: string; ownerUserId: string }> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/subscribers',
    headers: authHeaders(admin),
    payload: {
      fullName: 'Owner Person',
      email: options.email ?? 'owner@newco.test',
      organizationLegalName: options.legalName ?? 'NewCo Trading LLC',
      country: 'AE',
      planId: await planId(),
      onboarding: 'temporary',
      paymentConfirmed: true,
      ...(options.seats !== undefined ? { seatAllowance: options.seats } : {}),
    },
  });
  expect(response.statusCode).toBe(201);
  return {
    organizationId: response.json().subscriber.organizationId,
    ownerUserId: response.json().subscriber.userId,
  };
}

/** Invite through the operator route. */
const inviteViaApi = (
  admin: SessionCookies,
  organizationId: string,
  email: string,
  role = 'member',
  fullName = 'Invited Person',
) =>
  ctx.app.inject({
    method: 'POST',
    url: `/api/admin/organizations/${organizationId}/members/invite`,
    headers: authHeaders(admin),
    payload: { email, fullName, role },
  });

async function auditActions(): Promise<string[]> {
  return (await ctx.db.selectFrom('audit_logs').select('action').execute()).map((r) => r.action);
}

const countRows = async (table: 'organizations' | 'subscriptions' | 'users'): Promise<number> =>
  (await ctx.db.selectFrom(table).select('id').execute()).length;

/* ══ Adding a user is not adding a subscriber ════════════════════════════ */

describe('inviting a user', () => {
  it('creates a membership, not a subscriber or a subscription', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);

    const before = {
      organizations: await countRows('organizations'),
      subscriptions: await countRows('subscriptions'),
    };

    const response = await inviteViaApi(admin.cookies, organizationId, 'new@newco.test');
    expect(response.statusCode).toBe(201);

    // Exactly one new membership; no new tenant, no new subscription.
    expect(await countRows('organizations')).toBe(before.organizations);
    expect(await countRows('subscriptions')).toBe(before.subscriptions);

    const memberships = await ctx.db
      .selectFrom('organization_memberships')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .execute();
    expect(memberships).toHaveLength(2); // owner + invitee
    expect(memberships.find((m) => m.status === 'invited')).toBeTruthy();
  });

  it('returns a single-use invitation token exactly once', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);

    const response = await inviteViaApi(admin.cookies, organizationId, 'new@newco.test');
    const token = response.json().invitationToken as string;
    expect(typeof token).toBe('string');
    // Not cached on the way back.
    expect(String(response.headers['cache-control'])).toContain('no-store');

    // Only the digest is stored — the raw token is nowhere in the database.
    const rows = await ctx.db.selectFrom('password_reset_tokens').selectAll().execute();
    expect(JSON.stringify(rows)).not.toContain(token);
    // Nor in any audit entry.
    const audits = await ctx.db.selectFrom('audit_logs').selectAll().execute();
    expect(JSON.stringify(audits)).not.toContain(token);
  });

  it('lets the invitee set a password, which activates the membership', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const invited = await inviteViaApi(admin.cookies, organizationId, 'new@newco.test');
    const token = invited.json().invitationToken as string;
    const userId = invited.json().member.userId as string;

    const redeem = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, newPassword: 'Bright-Harbour-58-Zq' },
    });
    expect(redeem.statusCode).toBe(200);

    const membership = await ctx.db
      .selectFrom('organization_memberships')
      .select('status')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(membership.status).toBe('active');

    // And they can now reach their own organization's roster.
    const cookies = await login(ctx, 'new@newco.test', 'Bright-Harbour-58-Zq');
    const roster = await ctx.app.inject({
      method: 'GET',
      url: '/api/organizations/current/members',
      headers: authHeaders(cookies),
    });
    expect(roster.json().organizationId).toBe(organizationId);
  });

  it('cannot be redeemed twice', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const token = (await inviteViaApi(admin.cookies, organizationId, 'new@newco.test')).json()
      .invitationToken as string;

    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token, newPassword: 'Bright-Harbour-58-Zq' },
      })).statusCode,
    ).toBe(200);
    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token, newPassword: 'Different-Meadow-31-Xy' },
      })).statusCode,
    ).toBe(400);
  });

  it('expires', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const invited = await inviteViaApi(admin.cookies, organizationId, 'new@newco.test');
    const token = invited.json().invitationToken as string;

    await ctx.db
      .updateTable('password_reset_tokens')
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where('user_id', '=', invited.json().member.userId)
      .execute();

    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token, newPassword: 'Bright-Harbour-58-Zq' },
      })).statusCode,
    ).toBe(400);
  });
});

/* ══ One identity, many memberships ══════════════════════════════════════ */

describe('an existing identity', () => {
  it('joins a second organization through a separate membership', async () => {
    const admin = await operator();
    const one = await subscriber(admin.cookies, { email: 'a@one.test', legalName: 'One LLC' });
    const two = await subscriber(admin.cookies, { email: 'b@two.test', legalName: 'Two LLC' });

    const first = await inviteViaApi(admin.cookies, one.organizationId, 'shared@person.test');
    expect(first.statusCode).toBe(201);
    const usersAfterFirst = await countRows('users');

    const second = await inviteViaApi(admin.cookies, two.organizationId, 'shared@person.test');
    expect(second.statusCode).toBe(201);
    expect(second.json().reusedExistingIdentity).toBe(true);

    // No duplicate identity for the same email.
    expect(await countRows('users')).toBe(usersAfterFirst);
    expect(first.json().member.userId).toBe(second.json().member.userId);

    // Two memberships, each scoped to exactly one organization.
    const memberships = await ctx.db
      .selectFrom('organization_memberships')
      .select(['organization_id'])
      .where('user_id', '=', first.json().member.userId)
      .execute();
    expect(memberships.map((m) => m.organization_id).sort()).toEqual(
      [one.organizationId, two.organizationId].sort(),
    );
  });

  it('is refused a duplicate membership in the same organization', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    expect((await inviteViaApi(admin.cookies, organizationId, 'dup@newco.test')).statusCode).toBe(201);

    const again = await inviteViaApi(admin.cookies, organizationId, 'dup@newco.test');
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toMatch(/already has a pending invitation/i);
  });

  it('keeps its other memberships when removed from one organization', async () => {
    const admin = await operator();
    const one = await subscriber(admin.cookies, { email: 'a@one.test', legalName: 'One LLC' });
    const two = await subscriber(admin.cookies, { email: 'b@two.test', legalName: 'Two LLC' });

    const invited = await inviteViaApi(admin.cookies, one.organizationId, 'shared@person.test');
    const userId = invited.json().member.userId as string;
    await inviteViaApi(admin.cookies, two.organizationId, 'shared@person.test');

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/organizations/${one.organizationId}/members/${userId}`,
      headers: authHeaders(admin.cookies),
    });
    expect(removed.statusCode).toBe(200);

    // Gone from One, untouched in Two, and the identity survives.
    const memberships = await ctx.db
      .selectFrom('organization_memberships')
      .select('organization_id')
      .where('user_id', '=', userId)
      .execute();
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.organization_id).toBe(two.organizationId);
    expect(
      await ctx.db.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst(),
    ).toBeDefined();
  });
});

/* ══ Seats ═══════════════════════════════════════════════════════════════ */

describe('seat limits', () => {
  it('refuses an invitation once the plan is full, and audits the refusal', async () => {
    const admin = await operator();
    // Two seats: the owner takes one, one invitation takes the other.
    const { organizationId } = await subscriber(admin.cookies, { seats: 2 });

    expect((await inviteViaApi(admin.cookies, organizationId, 'first@newco.test')).statusCode).toBe(201);

    const overflow = await inviteViaApi(admin.cookies, organizationId, 'second@newco.test');
    expect(overflow.statusCode).toBe(409);
    expect(overflow.json().error.message).toMatch(/allows 2 users/);

    expect(await auditActions()).toContain('member.seat_limit_reached');
    // Nothing was created for the refused invitation.
    expect(
      await ctx.db
        .selectFrom('users')
        .select('id')
        .where('normalized_email', '=', 'second@newco.test')
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  it('counts a pending invitation as a consumed seat', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies, { seats: 3 });
    await inviteViaApi(admin.cookies, organizationId, 'pending@newco.test');

    const roster = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/organizations/${organizationId}/members`,
      headers: authHeaders(admin.cookies),
    });
    // Owner (active) + invitee (invited) = 2 of 3.
    expect(roster.json().seatsUsed).toBe(2);
    expect(roster.json().seatLimit).toBe(3);
  });

  it('cannot be exceeded by concurrent invitations', async () => {
    const admin = await operator();
    // Owner + exactly one free seat.
    const { organizationId } = await subscriber(admin.cookies, { seats: 2 });

    /*
     * Both invitations are issued at once against the service, bypassing HTTP so
     * they genuinely race. The row lock in `inviteMember` must serialise them:
     * one succeeds, the other is refused. Before that lock existed, both read
     * "1 of 2 used" and both inserted.
     */
    const context = { actorUserId: admin.userId, actorPlatformRole: 'super_admin' };
    const results = await Promise.allSettled([
      inviteMember(ctx.db, { organizationId, email: 'race1@newco.test', fullName: 'Race One', role: 'member' }, context),
      inviteMember(ctx.db, { organizationId, email: 'race2@newco.test', fullName: 'Race Two', role: 'member' }, context),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    // And the tenant is at its limit, not over it.
    const memberships = await ctx.db
      .selectFrom('organization_memberships')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('status', '!=', 'suspended')
      .execute();
    expect(memberships).toHaveLength(2);
  });

  it('releases a seat when an invitation is cancelled', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies, { seats: 2 });
    const invited = await inviteViaApi(admin.cookies, organizationId, 'temp@newco.test');
    expect((await inviteViaApi(admin.cookies, organizationId, 'blocked@newco.test')).statusCode).toBe(409);

    const { cancelInvitation } = await import('../src/services/memberService.js');
    await cancelInvitation(
      ctx.db,
      { organizationId, userId: invited.json().member.userId },
      { actorUserId: admin.userId, actorPlatformRole: 'super_admin' },
    );

    // The freed seat is usable again.
    expect((await inviteViaApi(admin.cookies, organizationId, 'blocked@newco.test')).statusCode).toBe(201);
    expect(await auditActions()).toContain('member.invitation_cancelled');
  });
});

/* ══ Subscriber lifecycle ════════════════════════════════════════════════ */

describe('a closed subscriber', () => {
  it('cannot take on new members once archived', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);

    const archived = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/archive`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Customer closed the account.' },
    });
    expect(archived.statusCode).toBe(200);

    const response = await inviteViaApi(admin.cookies, organizationId, 'late@newco.test');
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/cannot take on new members/i);
  });
});

/* ══ Invitation lifecycle ════════════════════════════════════════════════ */

describe('resending and cancelling', () => {
  it('supersedes the previous link when resent', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const invited = await inviteViaApi(admin.cookies, organizationId, 'resend@newco.test');
    const firstToken = invited.json().invitationToken as string;
    const userId = invited.json().member.userId as string;

    const { resendInvitation } = await import('../src/services/memberService.js');
    const resent = await resendInvitation(
      ctx.db,
      { organizationId, userId },
      { actorUserId: admin.userId, actorPlatformRole: 'super_admin' },
    );

    // The old link is dead; only the new one works.
    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token: firstToken, newPassword: 'Bright-Harbour-58-Zq' },
      })).statusCode,
    ).toBe(400);
    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token: resent.invitationToken, newPassword: 'Bright-Harbour-58-Zq' },
      })).statusCode,
    ).toBe(200);

    expect(await auditActions()).toContain('member.invitation_resent');
  });
});

/* ══ Tenant isolation and authority ══════════════════════════════════════ */

describe('authority and isolation', () => {
  it('refuses an ordinary customer the operator invite route', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    await seedUser(ctx, { email: 'plain@newco.test', fullName: 'Plain' });
    const customer = await login(ctx, 'plain@newco.test');

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/organizations/${organizationId}/members/invite`,
      headers: authHeaders(customer),
      payload: { email: 'x@y.test', fullName: 'X', role: 'member' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('scopes the subscriber roster to the caller’s own organization', async () => {
    const admin = await operator();
    const one = await subscriber(admin.cookies, { email: 'a@one.test', legalName: 'One LLC' });
    await subscriber(admin.cookies, { email: 'b@two.test', legalName: 'Two LLC' });

    // Onboard the owner of One so they can sign in.
    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${one.ownerUserId}/reset-password`,
      headers: authHeaders(admin.cookies),
      payload: { mode: 'temporary', reason: 'Test setup.' },
    });
    const temporary = reset.json().credential.temporaryPassword as string;
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'a@one.test', password: temporary },
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
    const owner = await login(ctx, 'a@one.test', 'Steady-Lantern-42-Kq');

    const roster = await ctx.app.inject({
      method: 'GET',
      url: '/api/organizations/current/members',
      headers: authHeaders(owner),
    });
    // Their own tenant only — there is no parameter to name another.
    expect(roster.json().organizationId).toBe(one.organizationId);
    expect(JSON.stringify(roster.json())).not.toContain('b@two.test');
  });

  it('preserves accounting attribution when a member is removed', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const invited = await inviteViaApi(admin.cookies, organizationId, 'author@newco.test');
    const userId = invited.json().member.userId as string;

    const historyBefore = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('target_id', '=', userId)
      .execute();
    expect(historyBefore.length).toBeGreaterThan(0);

    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/organizations/${organizationId}/members/${userId}`,
      headers: authHeaders(admin.cookies),
    });

    // The account row and every entry naming it survive — nothing here deletes
    // accounting attribution.
    expect(
      await ctx.db.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst(),
    ).toBeDefined();
    expect(
      await ctx.db.selectFrom('audit_logs').selectAll().where('target_id', '=', userId).execute(),
    ).toEqual(expect.arrayContaining(historyBefore));
  });
});

/* ══ Raw invitation tokens never leave production ════════════════════════ */

describe('invitation token exposure', () => {
  it('is refused outright when a production config asks for it', async () => {
    /*
     * Refused at BOOT, not silently ignored. A flag that hands out a live
     * credential for somebody else's account must fail loudly rather than
     * leaving an operator believing links are being surfaced somewhere.
     */
    const { loadConfig } = await import('../src/config/env.js');
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
        SESSION_SECRET: 'a-strong-production-session-secret',
        FRONTEND_URL: 'https://app.example.test',
        EXPOSE_INVITATION_TOKENS: 'true',
      } as NodeJS.ProcessEnv),
    ).toThrow(/cannot be enabled in production/i);
  });

  it('withholds the token when the development flag is off', async () => {
    const plain = await createTestContext({ EXPOSE_INVITATION_TOKENS: 'false' });
    try {
      const user = await createUser(plain.db, {
        email: 'super@ledgora.test',
        password: 'Correct-Horse-9-Battery',
        fullName: 'Platform Super Admin',
        status: 'active',
        emailVerified: true,
      });
      await assignPlatformRole(plain.db, user.id, 'super_admin');
      const cookies = await login(plain, 'super@ledgora.test', 'Correct-Horse-9-Battery');

      const plans = await plain.app.inject({ method: 'GET', url: '/api/plans/public' });
      const created = await plain.app.inject({
        method: 'POST',
        url: '/api/admin/subscribers',
        headers: authHeaders(cookies),
        payload: {
          fullName: 'Owner Person',
          email: 'owner@newco.test',
          organizationLegalName: 'NewCo Trading LLC',
          country: 'AE',
          planId: plans.json().plans[0].id,
          onboarding: 'temporary',
          paymentConfirmed: true,
        },
      });
      const organizationId = created.json().subscriber.organizationId;

      const invited = await plain.app.inject({
        method: 'POST',
        url: `/api/admin/organizations/${organizationId}/members/invite`,
        headers: authHeaders(cookies),
        payload: { email: 'new@newco.test', fullName: 'New Person', role: 'member' },
      });
      expect(invited.statusCode).toBe(201);

      const body = invited.json();
      // The membership is created; the credential is not handed out.
      expect(body.member.userId).toBeTruthy();
      expect(body.invitationToken).toBeUndefined();
      expect(body.developmentOnlyLink).toBe(false);
      // And delivery is reported honestly — never as "email sent".
      expect(body.delivery).toBe('unavailable');
      expect(invited.body).not.toMatch(/"invitationToken"/);
    } finally {
      await plain.close();
    }
  });

  it('flags the link as development-only when it is exposed', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const invited = await inviteViaApi(admin.cookies, organizationId, 'new@newco.test');

    expect(invited.json().developmentOnlyLink).toBe(true);
    expect(typeof invited.json().invitationToken).toBe('string');
    // The UI is obliged to label it; the flag is what obliges it.
    expect(invited.json().delivery).toBe('unavailable');
  });

  it('binds a token to its purpose, set at mint time and never by the client', async () => {
    const admin = await operator();
    const { organizationId, ownerUserId } = await subscriber(admin.cookies);
    await inviteViaApi(admin.cookies, organizationId, 'invitee@newco.test');

    // An administrator-issued RESET link for the owner.
    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${ownerUserId}/reset-password`,
      headers: authHeaders(admin.cookies),
      payload: { mode: 'link', reason: 'Owner asked for a reset.' },
    });
    const resetToken = reset.json().credential.invitationToken as string;

    const rows = await ctx.db
      .selectFrom('password_reset_tokens')
      .select(['user_id', 'purpose'])
      .execute();
    // Two distinct purposes, stored on the row rather than supplied per request.
    expect(rows.some((r) => r.purpose === 'invitation')).toBe(true);
    expect(rows.some((r) => r.purpose === 'reset')).toBe(true);

    /*
     * Redeeming the RESET token must not perform an invitation activation: the
     * owner's membership is already active, and no membership anywhere may be
     * activated by a token whose stored purpose is `reset`.
     */
    const before = await ctx.db
      .selectFrom('organization_memberships')
      .select(['user_id', 'status'])
      .where('organization_id', '=', organizationId)
      .execute();

    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token: resetToken, newPassword: 'Bright-Harbour-58-Zq' },
      })).statusCode,
    ).toBe(200);

    const after = await ctx.db
      .selectFrom('organization_memberships')
      .select(['user_id', 'status'])
      .where('organization_id', '=', organizationId)
      .execute();
    // The invitee is still pending — a reset did not accept anybody's invitation.
    expect(after.find((m) => m.user_id !== ownerUserId)!.status).toBe('invited');
    expect(after).toEqual(expect.arrayContaining(before));
  });
});


/* ══ Organization-targeted operator invitation actions ═══════════════════ */

describe('operator invitation actions for a named subscriber', () => {
  it('resends, invalidating the earlier token, without a second seat', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const invited = await inviteViaApi(admin.cookies, organizationId, 'pending@newco.test');
    const userId = invited.json().member.userId as string;
    const firstToken = invited.json().invitationToken as string;

    const before = await ctx.db
      .selectFrom('organization_memberships')
      .select('id')
      .where('organization_id', '=', organizationId)
      .execute();

    const resent = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/organizations/${organizationId}/members/${userId}/resend-invitation`,
      headers: authHeaders(admin.cookies),
      payload: {},
    });
    expect(resent.statusCode).toBe(200);

    // Same membership, same seat.
    expect(
      await ctx.db
        .selectFrom('organization_memberships')
        .select('id')
        .where('organization_id', '=', organizationId)
        .execute(),
    ).toEqual(before);

    // The earlier link is dead; the new one works.
    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token: firstToken, newPassword: 'Bright-Harbour-58-Zq' },
      })).statusCode,
    ).toBe(400);
    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token: resent.json().invitationToken, newPassword: 'Bright-Harbour-58-Zq' },
      })).statusCode,
    ).toBe(200);

    expect(await auditActions()).toContain('member.invitation_resent');
  });

  it('cancels, releasing the seat and keeping the identity', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies, { seats: 2 });
    const invited = await inviteViaApi(admin.cookies, organizationId, 'temp@newco.test');
    const userId = invited.json().member.userId as string;

    // The plan is full while the invitation stands.
    expect((await inviteViaApi(admin.cookies, organizationId, 'blocked@newco.test')).statusCode).toBe(409);

    const cancelled = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/organizations/${organizationId}/members/${userId}/cancel-invitation`,
      headers: authHeaders(admin.cookies),
      payload: {},
    });
    expect(cancelled.statusCode).toBe(200);

    // The freed seat is usable, and the identity survives.
    expect((await inviteViaApi(admin.cookies, organizationId, 'blocked@newco.test')).statusCode).toBe(201);
    expect(
      await ctx.db.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst(),
    ).toBeDefined();
    expect(await auditActions()).toContain('member.invitation_cancelled');
  });

  it('reports authoritative seat usage for the named subscriber', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies, { seats: 4 });
    await inviteViaApi(admin.cookies, organizationId, 'pending@newco.test');

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/organizations/${organizationId}/seats`,
      headers: authHeaders(admin.cookies),
    });
    expect(response.statusCode).toBe(200);
    const usage = response.json().seats;
    expect(usage.seatLimit).toBe(4);
    // Owner (active) + invitee (invited) both reserve a seat.
    expect(usage.seatsUsed).toBe(2);
    expect(usage.pendingInvitations).toBe(1);
    expect(usage.seatsRemaining).toBe(2);
  });

  it('rejects a membership id belonging to another subscriber', async () => {
    const admin = await operator();
    const one = await subscriber(admin.cookies, { email: 'a@one.test', legalName: 'One LLC' });
    const two = await subscriber(admin.cookies, { email: 'b@two.test', legalName: 'Two LLC' });
    const theirs = await inviteViaApi(admin.cookies, two.organizationId, 'theirs@two.test');
    const foreignUserId = theirs.json().member.userId as string;

    // A real user and a real organization — but not each other's.
    for (const action of ['resend-invitation', 'cancel-invitation']) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/admin/organizations/${one.organizationId}/members/${foreignUserId}/${action}`,
        headers: authHeaders(admin.cookies),
        payload: {},
      });
      /*
       * 404, not 403: a member of another tenant must be indistinguishable from
       * one that does not exist, or the response confirms the id belongs to
       * somebody.
       */
      expect(response.statusCode, action).toBe(404);
    }

    // The other tenant's invitation is untouched.
    const membership = await ctx.db
      .selectFrom('organization_memberships')
      .select('status')
      .where('organization_id', '=', two.organizationId)
      .where('user_id', '=', foreignUserId)
      .executeTakeFirstOrThrow();
    expect(membership.status).toBe('invited');
  });

  it('refuses a caller without the platform capability', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const invited = await inviteViaApi(admin.cookies, organizationId, 'pending@newco.test');
    const userId = invited.json().member.userId as string;

    await seedUser(ctx, { email: 'plain@newco.test', fullName: 'Plain' });
    const customer = await login(ctx, 'plain@newco.test');

    for (const action of ['resend-invitation', 'cancel-invitation']) {
      expect(
        (await ctx.app.inject({
          method: 'POST',
          url: `/api/admin/organizations/${organizationId}/members/${userId}/${action}`,
          headers: authHeaders(customer),
          payload: {},
        })).statusCode,
        action,
      ).toBe(403);
    }
  });

  it('withholds the resent token when the development flag is off', async () => {
    const plain = await createTestContext({ EXPOSE_INVITATION_TOKENS: 'false' });
    try {
      const user = await createUser(plain.db, {
        email: 'super@ledgora.test',
        password: 'Correct-Horse-9-Battery',
        fullName: 'Admin',
        status: 'active',
        emailVerified: true,
      });
      await assignPlatformRole(plain.db, user.id, 'super_admin');
      const cookies = await login(plain, 'super@ledgora.test', 'Correct-Horse-9-Battery');
      const plans = await plain.app.inject({ method: 'GET', url: '/api/plans/public' });
      const created = await plain.app.inject({
        method: 'POST',
        url: '/api/admin/subscribers',
        headers: authHeaders(cookies),
        payload: {
          fullName: 'Owner',
          email: 'owner@newco.test',
          organizationLegalName: 'NewCo Trading LLC',
          country: 'AE',
          planId: plans.json().plans[0].id,
          onboarding: 'temporary',
          paymentConfirmed: true,
        },
      });
      const organizationId = created.json().subscriber.organizationId;
      const invited = await plain.app.inject({
        method: 'POST',
        url: `/api/admin/organizations/${organizationId}/members/invite`,
        headers: authHeaders(cookies),
        payload: { email: 'new@newco.test', fullName: 'New Person', role: 'member' },
      });

      const resent = await plain.app.inject({
        method: 'POST',
        url: `/api/admin/organizations/${organizationId}/members/${invited.json().member.userId}/resend-invitation`,
        headers: authHeaders(cookies),
        payload: {},
      });
      expect(resent.statusCode).toBe(200);
      expect(resent.json().invitationToken).toBeUndefined();
      expect(resent.json().developmentOnlyLink).toBe(false);
      expect(resent.body).not.toMatch(/set-password\?token=/);
    } finally {
      await plain.close();
    }
  });
});

/* ══ Organization lifecycle: member vs organization ══════════════════════ */

describe('the lifecycle distinction', () => {
  it('reactivates a suspended MEMBER inside an active organization', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const invited = await inviteViaApi(admin.cookies, organizationId, 'member@newco.test');
    const userId = invited.json().member.userId as string;

    // Accept, then suspend the MEMBER — the organization stays active.
    await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token: invited.json().invitationToken, newPassword: 'Bright-Harbour-58-Zq' },
    });
    const suspend = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/organizations/${organizationId}/members/${userId}`,
      headers: authHeaders(admin.cookies),
      payload: { status: 'suspended' },
    });
    expect(suspend.statusCode).toBe(200);

    // Reactivation is permitted: the ORGANIZATION is not what was suspended.
    const reactivate = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/organizations/${organizationId}/members/${userId}`,
      headers: authHeaders(admin.cookies),
      payload: { status: 'active' },
    });
    expect(reactivate.statusCode).toBe(200);
    expect(reactivate.json().member.status).toBe('active');
  });

  it('refuses invitations into an archived organization', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/archive`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Customer closed the account.' },
    });

    const response = await inviteViaApi(admin.cookies, organizationId, 'late@newco.test');
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/cannot take on new members/i);
  });

  it('permits invitations into a SUSPENDED organization, per canonical policy', async () => {
    /*
     * A suspended ORGANIZATION is a live customer with a billing problem, not a
     * closed account, so the canonical policy lets it keep managing its team.
     * Asserted here so the frontend mapping has something authoritative to
     * mirror rather than guess at.
     */
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    await ctx.db
      .updateTable('organizations')
      .set({ status: 'suspended' })
      .where('id', '=', organizationId)
      .execute();

    expect((await inviteViaApi(admin.cookies, organizationId, 'ok@newco.test')).statusCode).toBe(201);
  });
});


/* ══ Temporary-password onboarding ═══════════════════════════════════════ */

describe('creating a member with a temporary password', () => {
  const TEMP = 'Copper-Lantern-64-Wm';
  const NEW_PASSWORD = 'Quiet-Meadow-77-Vz';

  /** An owner who can actually sign in, for the subscriber-scoped routes. */
  async function onboardedOwner(
    admin: SessionCookies,
    organizationId: string,
    ownerUserId: string,
    email: string,
  ): Promise<SessionCookies> {
    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/members/${ownerUserId}/reset-password`,
      headers: authHeaders(admin),
      payload: { mode: 'temporary', reason: 'Test setup.' },
    });
    const temporary = reset.json().credential.temporaryPassword as string;
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: temporary },
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
    void organizationId;
    return login(ctx, email, 'Steady-Lantern-42-Kq');
  }

  const addWithPassword = (
    owner: SessionCookies,
    overrides: Record<string, unknown> = {},
  ) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/organizations/current/users/invite',
      headers: authHeaders(owner),
      payload: {
        fullName: 'Rami Bookkeeper',
        email: 'rami@newco.test',
        role: 'accountant',
        onboarding: 'temporary_password',
        temporaryPassword: TEMP,
        ...overrides,
      },
    });

  it('creates the account, hashes the password and forces a change', async () => {
    const admin = await operator();
    const { organizationId, ownerUserId } = await subscriber(admin.cookies);
    const owner = await onboardedOwner(admin.cookies, organizationId, ownerUserId, 'owner@newco.test');

    const response = await addWithPassword(owner);
    expect(response.statusCode).toBe(201);
    expect(response.json().onboarding).toBe('temporary_password');
    expect(response.json().mustChangePassword).toBe(true);
    // No token was minted for this path, and no password is echoed back.
    expect(response.json().invitationToken).toBeUndefined();
    expect(response.body).not.toContain(TEMP);

    const user = await ctx.db
      .selectFrom('users')
      .selectAll()
      .where('normalized_email', '=', 'rami@newco.test')
      .executeTakeFirstOrThrow();
    expect(user.must_change_password).toBe(true);
    // Hashed with the application's own KDF — never the plaintext.
    expect(user.password_hash).not.toBe(TEMP);
    expect(user.password_hash.startsWith('$argon2')).toBe(true);

    // Active membership, in THIS organization only.
    const memberships = await ctx.db
      .selectFrom('organization_memberships')
      .selectAll()
      .where('user_id', '=', user.id)
      .execute();
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.organization_id).toBe(organizationId);
    expect(memberships[0]!.status).toBe('active');
  });

  it('never writes the plaintext anywhere', async () => {
    const admin = await operator();
    const { organizationId, ownerUserId } = await subscriber(admin.cookies);
    const owner = await onboardedOwner(admin.cookies, organizationId, ownerUserId, 'owner@newco.test');
    await addWithPassword(owner);

    for (const table of ['users', 'organization_memberships', 'audit_logs', 'password_reset_tokens'] as const) {
      const rows = await ctx.db.selectFrom(table).selectAll().execute();
      expect(JSON.stringify(rows), `${table} contains the plaintext`).not.toContain(TEMP);
    }
  });

  it('forces the change before anything else, and cannot be bypassed', async () => {
    const admin = await operator();
    const { organizationId, ownerUserId } = await subscriber(admin.cookies);
    const owner = await onboardedOwner(admin.cookies, organizationId, ownerUserId, 'owner@newco.test');
    await addWithPassword(owner);

    // The temporary credential logs in.
    const cookies = await login(ctx, 'rami@newco.test', TEMP);

    // …and buys exactly one thing. Direct API calls are refused too, so this is
    // not a client-side redirect dressed up as a control.
    for (const url of [
      '/api/organizations/current/members',
      '/api/organizations/current/seats',
      '/api/admin/subscribers',
    ]) {
      const blocked = await ctx.app.inject({ method: 'GET', url, headers: authHeaders(cookies) });
      expect(blocked.statusCode, url).toBe(403);
      expect(blocked.json().error.code).toBe('password_change_required');
    }

    // Reading the session is permitted — the client must discover WHY it is blocked.
    const session = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: authHeaders(cookies),
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().user.mustChangePassword).toBe(true);
  });

  it('clears the flag on a successful change, and retires the temporary password', async () => {
    const admin = await operator();
    const { organizationId, ownerUserId } = await subscriber(admin.cookies);
    const owner = await onboardedOwner(admin.cookies, organizationId, ownerUserId, 'owner@newco.test');
    await addWithPassword(owner);

    const cookies = await login(ctx, 'rami@newco.test', TEMP);
    const changed = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: authHeaders(cookies),
      payload: { currentPassword: TEMP, newPassword: NEW_PASSWORD },
    });
    expect(changed.statusCode).toBe(200);

    const user = await ctx.db
      .selectFrom('users')
      .select('must_change_password')
      .where('normalized_email', '=', 'rami@newco.test')
      .executeTakeFirstOrThrow();
    expect(user.must_change_password).toBe(false);

    // The old credential is dead; the new one works and reaches the workspace.
    const retired = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'rami@newco.test', password: TEMP },
    });
    expect(retired.statusCode).toBe(401);
    const working = await login(ctx, 'rami@newco.test', NEW_PASSWORD);
    const roster = await ctx.app.inject({
      method: 'GET',
      url: '/api/organizations/current/members',
      headers: authHeaders(working),
    });
    expect(roster.statusCode).toBe(200);
    expect(roster.json().organizationId).toBe(organizationId);
  });

  it('keeps the flag set when the change fails', async () => {
    const admin = await operator();
    const { organizationId, ownerUserId } = await subscriber(admin.cookies);
    const owner = await onboardedOwner(admin.cookies, organizationId, ownerUserId, 'owner@newco.test');
    await addWithPassword(owner);
    const cookies = await login(ctx, 'rami@newco.test', TEMP);

    // Too weak for the canonical policy.
    const rejected = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: authHeaders(cookies),
      payload: { currentPassword: TEMP, newPassword: 'short' },
    });
    expect(rejected.statusCode).toBeGreaterThanOrEqual(400);

    const user = await ctx.db
      .selectFrom('users')
      .select('must_change_password')
      .where('normalized_email', '=', 'rami@newco.test')
      .executeTakeFirstOrThrow();
    expect(user.must_change_password).toBe(true);
  });

  it('enforces the canonical password policy on the temporary password', async () => {
    const admin = await operator();
    const { organizationId, ownerUserId } = await subscriber(admin.cookies);
    const owner = await onboardedOwner(admin.cookies, organizationId, ownerUserId, 'owner@newco.test');

    const weak = await addWithPassword(owner, { temporaryPassword: 'short' });
    expect(weak.statusCode).toBe(400);
    // Nothing was created by the refusal.
    expect(
      await ctx.db
        .selectFrom('users')
        .select('id')
        .where('normalized_email', '=', 'rami@newco.test')
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  it('REFUSES to set a password for an email that already has an identity', async () => {
    const admin = await operator();
    const one = await subscriber(admin.cookies, { email: 'a@one.test', legalName: 'One LLC' });
    const two = await subscriber(admin.cookies, { email: 'b@two.test', legalName: 'Two LLC' });
    const owner = await onboardedOwner(admin.cookies, two.organizationId, two.ownerUserId, 'b@two.test');

    const existingHash = await ctx.db
      .selectFrom('users')
      .select('password_hash')
      .where('normalized_email', '=', 'a@one.test')
      .executeTakeFirstOrThrow();

    /*
     * The whole point: credentials belong to the global identity. Another
     * subscriber must never be able to set them.
     */
    const refused = await addWithPassword(owner, { email: 'a@one.test' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toMatch(/already has a Ledgora account/i);
    expect(refused.json().error.message).toMatch(/invitation/i);

    // Their password is untouched, and no membership was created in Two.
    expect(
      (await ctx.db
        .selectFrom('users')
        .select('password_hash')
        .where('normalized_email', '=', 'a@one.test')
        .executeTakeFirstOrThrow()).password_hash,
    ).toBe(existingHash.password_hash);
    const memberships = await ctx.db
      .selectFrom('organization_memberships')
      .innerJoin('users', 'users.id', 'organization_memberships.user_id')
      .select('organization_memberships.organization_id')
      .where('users.normalized_email', '=', 'a@one.test')
      .execute();
    expect(memberships.map((m) => m.organization_id)).toEqual([one.organizationId]);
  });

  it('still lets an existing identity join through the invitation path', async () => {
    const admin = await operator();
    const one = await subscriber(admin.cookies, { email: 'a@one.test', legalName: 'One LLC' });
    const two = await subscriber(admin.cookies, { email: 'b@two.test', legalName: 'Two LLC' });
    const owner = await onboardedOwner(admin.cookies, two.organizationId, two.ownerUserId, 'b@two.test');

    const invited = await ctx.app.inject({
      method: 'POST',
      url: '/api/organizations/current/users/invite',
      headers: authHeaders(owner),
      payload: { fullName: 'One Owner', email: 'a@one.test', role: 'member' },
    });
    expect(invited.statusCode).toBe(201);
    expect(invited.json().reusedExistingIdentity).toBe(true);

    const memberships = await ctx.db
      .selectFrom('organization_memberships')
      .innerJoin('users', 'users.id', 'organization_memberships.user_id')
      .select('organization_memberships.organization_id')
      .where('users.normalized_email', '=', 'a@one.test')
      .execute();
    expect(memberships.map((m) => m.organization_id).sort()).toEqual(
      [one.organizationId, two.organizationId].sort(),
    );
  });

  it('honours the seat limit', async () => {
    const admin = await operator();
    const { organizationId, ownerUserId } = await subscriber(admin.cookies, { seats: 1 });
    const owner = await onboardedOwner(admin.cookies, organizationId, ownerUserId, 'owner@newco.test');

    // The owner already fills the single seat.
    const refused = await addWithPassword(owner);
    expect(refused.statusCode).toBe(409);
    expect(await auditActions()).toContain('member.seat_limit_reached');
  });

  it('audits the decision without recording any credential', async () => {
    const admin = await operator();
    const { organizationId, ownerUserId } = await subscriber(admin.cookies);
    const owner = await onboardedOwner(admin.cookies, organizationId, ownerUserId, 'owner@newco.test');
    await addWithPassword(owner);

    const entry = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'member.invited')
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    const metadata =
      typeof entry.metadata === 'string' ? JSON.parse(entry.metadata) : entry.metadata;

    expect(metadata.onboarding).toBe('temporary_password');
    expect(metadata.firstLoginChangeRequired).toBe(true);
    // The redactor stays aggressive: nothing password-shaped survives it.
    expect(JSON.stringify(metadata)).not.toMatch(/Copper-Lantern/);
    expect(metadata.role).toBe('accountant');
    expect(entry.organization_id).toBe(organizationId);
    expect(JSON.stringify(entry)).not.toContain(TEMP);
  });

  it('refuses an ordinary member', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const invited = await inviteViaApi(admin.cookies, organizationId, 'plain@newco.test', 'member');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token: invited.json().invitationToken, newPassword: 'Bright-Harbour-58-Zq' },
    });
    const plain = await login(ctx, 'plain@newco.test', 'Bright-Harbour-58-Zq');

    const refused = await addWithPassword(plain);
    expect(refused.statusCode).toBe(403);
  });

  it('refuses inside an archived organization', async () => {
    const admin = await operator();
    const { organizationId, ownerUserId } = await subscriber(admin.cookies);
    // Onboard the owner so they have a real password to sign back in with
    // after archiving revokes every session.
    await onboardedOwner(admin.cookies, organizationId, ownerUserId, 'owner@newco.test');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/archive`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Closed.' },
    });

    // Archiving revokes every member session, so the owner signs in again.
    const again = await login(ctx, 'owner@newco.test', 'Steady-Lantern-42-Kq');
    const refused = await addWithPassword(again);
    /*
     * 403, not 409: archiving withdraws the entitlement, so the permission
     * resolver refuses `user_administration.manage_users` before the lifecycle
     * check in the service is ever reached. Two independent gates, and the
     * outer one fires first — which is the correct order.
     */
    expect(refused.statusCode).toBe(403);

    // Nothing was created by the refusal.
    expect(
      await ctx.db
        .selectFrom('users')
        .select('id')
        .where('normalized_email', '=', 'rami@newco.test')
        .executeTakeFirst(),
    ).toBeUndefined();
  });
});

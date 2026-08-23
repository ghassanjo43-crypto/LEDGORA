import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeaders, createTestContext, login, seedUser, type SessionCookies, type TestContext } from './helpers/testApp.js';

let ctx: TestContext;
let platformAdmin: SessionCookies;
const password = 'Test-Ownership-64-Wm';

beforeEach(async () => {
  ctx = await createTestContext();
  await seedUser(ctx, { email: 'platform@ledgora.test', platformRoles: ['super_admin'] });
  platformAdmin = await login(ctx, 'platform@ledgora.test');
});
afterEach(async () => ctx.close());

async function planId(): Promise<string> {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
  return response.json().plans.find((plan: { code: string }) => plan.code === 'core').id;
}

async function subscriber(name: string): Promise<{ organizationId: string; ownerUserId: string; owner: SessionCookies }> {
  const email = `owner@${name.toLowerCase()}.test`;
  const response = await ctx.app.inject({ method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(platformAdmin), payload: {
    fullName: `${name} Subscriber`, email, organizationLegalName: `${name} Company`, country: 'JO', baseCurrency: 'JOD',
    planId: await planId(), onboarding: 'temporary', paymentConfirmed: true,
  } });
  expect(response.statusCode, response.body).toBe(201);
  return { organizationId: response.json().subscriber.organizationId, ownerUserId: response.json().subscriber.userId,
    owner: await login(ctx, email, response.json().credential.temporaryPassword) };
}

async function member(organizationId: string, email: string): Promise<{ userId: string; cookies: SessionCookies }> {
  const response = await ctx.app.inject({ method: 'POST', url: '/api/admin/users', headers: authHeaders(platformAdmin), payload: {
    fullName: 'Workspace Member', email, organizationId, role: 'member', onboarding: 'invitation',
  } });
  expect(response.statusCode).toBe(201);
  await ctx.app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token: response.json().credential.invitationToken, newPassword: password } });
  const user = await ctx.db.selectFrom('users').select('id').where('normalized_email', '=', email.toLowerCase()).executeTakeFirstOrThrow();
  return { userId: user.id, cookies: await login(ctx, email, password) };
}

describe('immutable subscriber workspace ownership', () => {
  it('rejects duplicate ownership and reassignment in both service and database paths', async () => {
    const first = await subscriber('Alpha');
    const colleague = await member(first.organizationId, 'member@alpha.test');
    const transfer = await ctx.app.inject({ method: 'POST', url: `/api/admin/subscribers/${first.organizationId}/change-owner`, headers: authHeaders(platformAdmin), payload: { newOwnerUserId: colleague.userId, reason: 'attempted transfer' } });
    expect(transfer.statusCode).toBe(409);
    await expect(ctx.db.updateTable('organizations').set({ subscriber_owner_user_id: colleague.userId }).where('id', '=', first.organizationId).execute()).rejects.toThrow(/immutable/i);
    await expect(ctx.db.updateTable('organization_memberships').set({ role: 'owner' }).where('organization_id', '=', first.organizationId).where('user_id', '=', colleague.userId).execute()).rejects.toThrow(/designated|unique/i);
    const owner = await ctx.db.selectFrom('organizations').select('subscriber_owner_user_id').where('id', '=', first.organizationId).executeTakeFirstOrThrow();
    expect(owner.subscriber_owner_user_id).toBe(first.ownerUserId);
  });

  it('does not release ownership when a subscriber is suspended or archived', async () => {
    const account = await subscriber('Lifecycle');
    for (const action of ['suspend', 'archive'] as const) {
      const response = await ctx.app.inject({ method: 'PATCH', url: `/api/admin/subscribers/${account.organizationId}/status`, headers: authHeaders(platformAdmin), payload: { action, reason: `${action} account` } });
      expect(response.statusCode).toBe(200);
    }
    const workspace = await ctx.db.selectFrom('organizations').select('subscriber_owner_user_id').where('id', '=', account.organizationId).executeTakeFirstOrThrow();
    expect(workspace.subscriber_owner_user_id).toBe(account.ownerUserId);
    const ownership = await ctx.db.selectFrom('organization_memberships').select(['role', 'status']).where('organization_id', '=', account.organizationId).where('user_id', '=', account.ownerUserId).executeTakeFirstOrThrow();
    expect(ownership).toMatchObject({ role: 'owner', status: 'active' });
  });

  it('resolves administrator preview read-only from the subscriber existing workspace', async () => {
    const account = await subscriber('Preview');
    const before = await ctx.db.selectFrom('organizations').select(({ fn }) => fn.countAll<number>().as('count')).executeTakeFirstOrThrow();
    const response = await ctx.app.inject({ method: 'GET', url: `/api/admin/subscribers/${account.organizationId}/workspace`, headers: authHeaders(platformAdmin) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ organizationId: account.organizationId, workspaceName: 'Preview Company', ownerUserId: account.ownerUserId });
    const after = await ctx.db.selectFrom('organizations').select(({ fn }) => fn.countAll<number>().as('count')).executeTakeFirstOrThrow();
    expect(after.count).toBe(before.count);
  });

  it('keeps member access membership-scoped and blocks cross-subscriber preview', async () => {
    const first = await subscriber('First'); const second = await subscriber('Second');
    const colleague = await member(first.organizationId, 'member@first.test');
    const preview = await ctx.app.inject({ method: 'GET', url: `/api/admin/subscribers/${second.organizationId}/workspace`, headers: authHeaders(colleague.cookies) });
    expect(preview.statusCode).toBe(403);
    const own = await ctx.app.inject({ method: 'GET', url: '/api/organizations/current/members', headers: authHeaders(colleague.cookies) });
    expect(own.statusCode).toBe(200);
    expect(own.json().organizationId).toBe(first.organizationId);
    expect(own.json().members.some((item: { userId: string }) => item.userId === second.ownerUserId)).toBe(false);
  });
});

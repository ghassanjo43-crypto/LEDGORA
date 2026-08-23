/**
 * Which workspace a sign-in resolves to, and what that workspace's package
 * actually entitles.
 *
 * The bug these cover: resolution read the caller's memberships with no
 * ordering, so a subscriber who had also been invited into somebody else's
 * books could resolve to the guest workspace — or, when nothing came back in
 * the order the caller expected, look like a user with no workspace at all and
 * be sent to onboarding to create a second one. Ownership is now the first key
 * of that ordering, which is what makes these assertions deterministic rather
 * than lucky.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeaders, createTestContext, login, seedUser, type SessionCookies, type TestContext } from './helpers/testApp.js';
import { resolvePermissions } from '../src/services/permissionService.js';
import { permissionKey } from '../src/config/permissionCatalog.js';

let ctx: TestContext;
let platformAdmin: SessionCookies;
/* Deliberately shares no word with any fixture's name or email: the password
   policy refuses a password containing either, which fails as a login error
   several steps later and looks nothing like the cause. */
const password = 'Bright-Harbour-58-Zq';

beforeEach(async () => {
  ctx = await createTestContext();
  await seedUser(ctx, { email: 'platform@ledgora.test', platformRoles: ['super_admin'] });
  platformAdmin = await login(ctx, 'platform@ledgora.test');
});
afterEach(async () => ctx.close());

async function planId(code = 'core'): Promise<string> {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
  return response.json().plans.find((plan: { code: string }) => plan.code === code).id;
}

interface Subscriber { organizationId: string; ownerUserId: string; owner: SessionCookies }

async function subscriber(name: string, planCode = 'core'): Promise<Subscriber> {
  const email = `owner@${name.toLowerCase()}.test`;
  const response = await ctx.app.inject({ method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(platformAdmin), payload: {
    fullName: `${name} Subscriber`, email, organizationLegalName: `${name} Company`, country: 'JO', baseCurrency: 'JOD',
    planId: await planId(planCode), onboarding: 'temporary', paymentConfirmed: true,
  } });
  expect(response.statusCode, response.body).toBe(201);
  const temporary = response.json().credential.temporaryPassword as string;

  // An administrator-issued credential buys exactly one action: replacing
  // itself. Retire it here so these tests exercise a normal working session
  // rather than the forced-password-change gate.
  const first = await login(ctx, email, temporary);
  const changed = await ctx.app.inject({ method: 'POST', url: '/api/auth/change-password', headers: authHeaders(first),
    payload: { currentPassword: temporary, newPassword: password } });
  expect(changed.statusCode, changed.body).toBe(200);

  return {
    organizationId: response.json().subscriber.organizationId,
    ownerUserId: response.json().subscriber.userId,
    owner: await login(ctx, email, password),
  };
}

async function member(organizationId: string, email: string, role = 'member'): Promise<{ userId: string; cookies: SessionCookies }> {
  const response = await ctx.app.inject({ method: 'POST', url: '/api/admin/users', headers: authHeaders(platformAdmin), payload: {
    fullName: 'Workspace Member', email, organizationId, role, onboarding: 'invitation',
  } });
  expect(response.statusCode, response.body).toBe(201);
  await ctx.app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token: response.json().credential.invitationToken, newPassword: password } });
  const user = await ctx.db.selectFrom('users').select('id').where('normalized_email', '=', email.toLowerCase()).executeTakeFirstOrThrow();
  return { userId: user.id, cookies: await login(ctx, email, password) };
}

const currentWorkspace = (user: SessionCookies) =>
  ctx.app.inject({ method: 'GET', url: '/api/organizations/current', headers: authHeaders(user) });

describe('subscriber workspace resolution', () => {
  it('resolves the workspace a subscriber owns, even when it is a guest elsewhere', async () => {
    const alpha = await subscriber('Alpha');
    const beta = await subscriber('Beta');

    // Alpha's owner is also invited into Beta's books. That guest membership
    // must never displace the workspace Alpha actually owns.
    await ctx.db.insertInto('organization_memberships')
      .values({ organization_id: beta.organizationId, user_id: alpha.ownerUserId, role: 'member', status: 'active' })
      .execute();

    const response = await currentWorkspace(alpha.owner);
    expect(response.statusCode).toBe(200);
    expect(response.json().organization).toMatchObject({
      id: alpha.organizationId,
      role: 'owner',
      ownerUserId: alpha.ownerUserId,
      legalName: 'Alpha Company',
    });
    // No second workspace was invented for a subscriber that already had one.
    const owned = await ctx.db.selectFrom('organizations').select('id')
      .where('subscriber_owner_user_id', '=', alpha.ownerUserId).execute();
    expect(owned.map((row) => row.id)).toEqual([alpha.organizationId]);
  });

  it('resolves the subscriber workspace for a member through their membership', async () => {
    const alpha = await subscriber('Gamma');
    const colleague = await member(alpha.organizationId, 'member@gamma.test');

    const response = await currentWorkspace(colleague.cookies);
    expect(response.statusCode).toBe(200);
    expect(response.json().organization).toMatchObject({
      id: alpha.organizationId,
      role: 'member',
      // The member sees who owns the workspace, and is not that person.
      ownerUserId: alpha.ownerUserId,
    });
    expect(response.json().organization.ownerUserId).not.toBe(colleague.userId);
  });

  it('loads the active package entitlements, including opening balances', async () => {
    const account = await subscriber('Delta');
    const colleague = await member(account.organizationId, 'member@delta.test', 'manager');

    const owner = await resolvePermissions(ctx.db, account.ownerUserId, account.organizationId);
    expect(owner.subscription.active).toBe(true);
    expect(owner.subscription.planCode).toBe('core');
    // The coarse module the opening-balance subject is gated on. If this were
    // missing the matrix would render every accounting subject "not in package".
    expect(owner.subscription.modules).toContain('accounting');

    const everyAction = ['view', 'create', 'edit', 'submit', 'approve', 'post', 'void', 'export'];
    for (const action of everyAction) {
      expect(owner.allowedKeys, `owner must hold opening_balances.${action}`)
        .toContain(permissionKey('opening_balances', action));
    }

    // Package entitlement is the ceiling; the role decides how much of it a
    // member actually gets. A manager approves but is still inside the package.
    const manager = await resolvePermissions(ctx.db, colleague.userId, account.organizationId);
    expect(manager.subscription.modules).toEqual(owner.subscription.modules);
    for (const action of ['view', 'create', 'edit', 'submit', 'approve', 'post', 'export']) {
      expect(manager.allowedKeys, `manager must hold opening_balances.${action}`)
        .toContain(permissionKey('opening_balances', action));
    }
  });

  it('gives a read-only member sight of opening balances but no authority over them', async () => {
    const account = await subscriber('Epsilon');
    const auditor = await member(account.organizationId, 'auditor@epsilon.test', 'viewer');

    const resolved = await resolvePermissions(ctx.db, auditor.userId, account.organizationId);
    expect(resolved.subscription.modules).toContain('accounting');
    expect(resolved.allowedKeys).toContain(permissionKey('opening_balances', 'view'));
    for (const action of ['create', 'edit', 'submit', 'approve', 'post', 'void']) {
      expect(resolved.allowedKeys, `a viewer must not hold opening_balances.${action}`)
        .not.toContain(permissionKey('opening_balances', action));
    }
  });
});

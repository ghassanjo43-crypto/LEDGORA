/**
 * The complete user-administration workflow, end to end.
 *
 * ── Why this is an HTTP workflow test and not a browser test ─────────────────
 * The repository has no browser-driving harness (no Playwright, no Cypress), and
 * inventing one for this feature would add a second, unmaintained way to prove
 * the same claims. What actually needs proving is that the SERVER enforces the
 * rules — "do not rely only on disabled or hidden interface controls for
 * security" cuts both ways, and a test that drove the UI would be proving the
 * weaker half. So this walks the real workflow through the real API, in order,
 * with each step depending on the last.
 *
 * ── Why a route is registered here ───────────────────────────────────────────
 * Ledgora's accounting data still lives in the browser workspace, so there is no
 * durable business endpoint to check a permission against yet. `buildApp` has an
 * `extraRoutes` seam for exactly this — the persistence guard is already tested
 * through it — so the journal endpoint below is registered under the REAL hooks,
 * the REAL error handler and the REAL guard. What is under test is the guard;
 * the handler behind it is a stand-in for the accounting route that will use it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  authHeaders,
  createTestContext,
  login,
  seedUser,
  type SessionCookies,
  type TestContext,
} from './helpers/testApp.js';
import { requireOwnOrganizationPermission } from '../src/guards/permissions.js';

let ctx: TestContext;

/**
 * A protected accounting surface, guarded exactly as a real one would be.
 *
 * Three permissions on the same subject, so the tests can show that authority is
 * granular rather than all-or-nothing: viewing, posting and approving a journal
 * entry are separate rights and are separately enforced.
 */
async function accountingRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/journal-entries',
    { preHandler: requireOwnOrganizationPermission('general_journal', 'view') },
    async (_request, reply) => reply.send({ entries: [] }),
  );
  app.post(
    '/api/journal-entries/post',
    { preHandler: requireOwnOrganizationPermission('general_journal', 'post') },
    async (_request, reply) => reply.send({ posted: true }),
  );
  app.post(
    '/api/journal-entries/approve',
    { preHandler: requireOwnOrganizationPermission('general_journal', 'approve') },
    async (_request, reply) => reply.send({ approved: true }),
  );
  app.get(
    '/api/manufacturing/work-orders',
    { preHandler: requireOwnOrganizationPermission('manufacturing', 'view') },
    async (_request, reply) => reply.send({ workOrders: [] }),
  );
}

beforeEach(async () => {
  ctx = await createTestContext({}, { extraRoutes: accountingRoutes });
});
afterEach(async () => {
  await ctx.close();
});

/* ── Helpers ──────────────────────────────────────────────────────────────── */

async function planId(code: string): Promise<string> {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
  const found = response.json().plans.find((p: { code: string }) => p.code === code);
  if (!found) throw new Error(`seeded catalogue is missing "${code}"`);
  return found.id;
}

const NEW_PASSWORD = 'Copper-Lantern-64-Wm';

describe('the complete user administration workflow', () => {
  it('runs from account creation to a working, permission-limited session', async () => {
    /* ── 0. A platform super administrator and a subscriber tenant ───────── */
    await seedUser(ctx, {
      email: 'super@ledgora.test',
      fullName: 'Platform Super Admin',
      platformRoles: ['super_admin'],
    });
    const admin = await login(ctx, 'super@ledgora.test');

    const tenant = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/subscribers',
      headers: authHeaders(admin),
      payload: {
        fullName: 'Owner Person',
        email: 'owner@newco.test',
        organizationLegalName: 'NewCo Trading LLC',
        country: 'AE',
        // `core` sells accounting, invoicing and reports — deliberately NOT
        // manufacturing, so the entitlement boundary has something to refuse.
        planId: await planId('core'),
        onboarding: 'temporary',
        paymentConfirmed: true,
      },
    });
    expect(tenant.statusCode).toBe(201);
    const organizationId = tenant.json().subscriber.organizationId as string;

    /* ── 1. Create a user ─────────────────────────────────────────────────── */
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: authHeaders(admin),
      payload: {
        fullName: 'Rami Bookkeeper',
        email: 'rami@newco.test',
        /* ── 2. …assigned to an organization, with a role ─────────────────── */
        organizationId,
        role: 'member', // Standard User: authors records, cannot post them.
        onboarding: 'invitation',
        /* ── 3. …with a customised permission ─────────────────────────────── */
        permissions: [{ subject: 'general_journal', action: 'post', effect: 'grant' }],
      },
    });
    expect(created.statusCode).toBe(201);
    const userId = created.json().user.userId as string;

    /* ── 4. Obtain the secure setup invitation ────────────────────────────── */
    const invitationToken = created.json().credential.invitationToken as string;
    expect(typeof invitationToken).toBe('string');
    // It is returned exactly once. Nothing in the database can give it back.
    const stored = await ctx.db.selectFrom('password_reset_tokens').selectAll().execute();
    expect(JSON.stringify(stored)).not.toContain(invitationToken);

    const describe = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/invitation/inspect',
      payload: { token: invitationToken },
    });
    expect(describe.json().valid).toBe(true);
    expect(describe.json().purpose).toBe('invitation');

    // Until it is redeemed the account cannot authenticate at all.
    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'rami@newco.test', password: NEW_PASSWORD },
      })).statusCode,
    ).toBe(401);

    /* ── 5. Complete password setup ───────────────────────────────────────── */
    // The policy applies to a chosen password exactly as it does anywhere else.
    const weak = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token: invitationToken, newPassword: 'short' },
    });
    expect(weak.statusCode).toBe(400);

    const setup = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token: invitationToken, newPassword: NEW_PASSWORD },
    });
    expect(setup.statusCode).toBe(200);
    // Setting a password does not sign anyone in — the link alone must not be
    // sufficient to hold a session.
    expect(setup.headers['set-cookie']).toBeUndefined();

    /* ── 6. Log in as the new user ────────────────────────────────────────── */
    const rami: SessionCookies = await login(ctx, 'rami@newco.test', NEW_PASSWORD);
    const session = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: authHeaders(rami),
    });
    expect(session.json().authenticated).toBe(true);
    expect(session.json().user.platformRoles).toEqual([]);

    /* ── 7. Confirm allowed actions work ──────────────────────────────────── */
    // From the role: a Standard User views the journal.
    expect(
      (await ctx.app.inject({
        method: 'GET',
        url: '/api/journal-entries',
        headers: authHeaders(rami),
      })).statusCode,
    ).toBe(200);

    // From the explicit grant made at creation: posting, which the role lacks.
    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/journal-entries/post',
        headers: authHeaders(rami),
      })).statusCode,
    ).toBe(200);

    /* ── 8. Confirm prohibited actions are rejected by the backend ────────── */
    // Not in the role, not granted: approval.
    const approve = await ctx.app.inject({
      method: 'POST',
      url: '/api/journal-entries/approve',
      headers: authHeaders(rami),
    });
    expect(approve.statusCode).toBe(403);

    // Not in the PACKAGE: manufacturing. A different refusal, worded so the
    // customer is told the useful thing rather than sent to their administrator.
    const manufacturing = await ctx.app.inject({
      method: 'GET',
      url: '/api/manufacturing/work-orders',
      headers: authHeaders(rami),
    });
    expect(manufacturing.statusCode).toBe(403);
    expect(manufacturing.json().error.message).toMatch(/plan does not include/i);

    // And the administration surface is closed to them entirely.
    expect(
      (await ctx.app.inject({
        method: 'GET',
        url: '/api/admin/permissions/catalog',
        headers: authHeaders(rami),
      })).statusCode,
    ).toBe(403);

    /* ── 9. Change permissions; the new access takes effect ───────────────── */
    const promote = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${userId}/permissions`,
      headers: authHeaders(admin),
      payload: {
        organizationId,
        changes: [
          { subject: 'general_journal', action: 'approve', effect: 'grant' },
          // And withdraw the posting right granted at creation.
          { subject: 'general_journal', action: 'post', effect: 'deny' },
        ],
        reason: 'Moved to a reviewing role.',
      },
    });
    expect(promote.statusCode).toBe(200);
    // The withdrawal ended their sessions, so the old cookies are dead.
    expect(promote.json().revokedSessions).toBeGreaterThan(0);
    expect(
      (await ctx.app.inject({
        method: 'GET',
        url: '/api/journal-entries',
        headers: authHeaders(rami),
      })).statusCode,
    ).toBe(401);

    const ramiAgain = await login(ctx, 'rami@newco.test', NEW_PASSWORD);
    // Newly allowed.
    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/journal-entries/approve',
        headers: authHeaders(ramiAgain),
      })).statusCode,
    ).toBe(200);
    // Newly refused.
    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/journal-entries/post',
        headers: authHeaders(ramiAgain),
      })).statusCode,
    ).toBe(403);

    /* ── 10. Suspend, then reactivate ─────────────────────────────────────── */
    const suspend = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/members/${userId}/status`,
      headers: authHeaders(admin),
      payload: { status: 'disabled', reason: 'Suspended pending an investigation.' },
    });
    expect(suspend.statusCode).toBe(200);

    // The open session stops working immediately, not at cookie expiry.
    expect(
      (await ctx.app.inject({
        method: 'GET',
        url: '/api/journal-entries',
        headers: authHeaders(ramiAgain),
      })).statusCode,
    ).toBe(401);
    // And they cannot sign in again.
    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'rami@newco.test', password: NEW_PASSWORD },
      })).statusCode,
    ).toBe(401);

    const reactivate = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/members/${userId}/status`,
      headers: authHeaders(admin),
      payload: { status: 'active', reason: 'Investigation closed, no findings.' },
    });
    expect(reactivate.statusCode).toBe(200);

    // Back in service, with the SAME password and the SAME configured permissions
    // — suspension is reversible and destroys nothing.
    const restored = await login(ctx, 'rami@newco.test', NEW_PASSWORD);
    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/journal-entries/approve',
        headers: authHeaders(restored),
      })).statusCode,
    ).toBe(200);
    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: '/api/journal-entries/post',
        headers: authHeaders(restored),
      })).statusCode,
    ).toBe(403);

    /* ── The trail the whole workflow left ────────────────────────────────── */
    const actions = (await ctx.db.selectFrom('audit_logs').select('action').execute()).map((r) => r.action);
    for (const expected of [
      'user.created_by_admin',
      'user.organization_assigned',
      'invitation.created',
      'invitation.redeemed',
      'permission.granted',
      'permission.denied',
      'member.account_status_changed',
      'auth.login',
    ]) {
      expect(actions, `missing audit action: ${expected}`).toContain(expected);
    }

    // Nothing anywhere in the trail is a credential.
    const entries = await ctx.db.selectFrom('audit_logs').selectAll().execute();
    expect(JSON.stringify(entries)).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(entries)).not.toContain(invitationToken);
  });

  it('refuses a permission-guarded route to a caller with no organization', async () => {
    // A platform operator has no tenant. `requireOwnOrganizationPermission`
    // derives the organization from the caller's own membership, so there is
    // nothing to derive — and the refusal must not be a 500.
    await seedUser(ctx, {
      email: 'super@ledgora.test',
      fullName: 'Platform Super Admin',
      platformRoles: ['super_admin'],
    });
    const admin = await login(ctx, 'super@ledgora.test');

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/journal-entries',
      headers: authHeaders(admin),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toMatch(/do not belong to an organization/i);
  });

  it('refuses a permission-guarded route to an unauthenticated caller', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/journal-entries' });
    expect(response.statusCode).toBe(401);
  });
});

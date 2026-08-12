/**
 * Subscriber closure: the recoverable pending-deletion period, and data export.
 *
 * The claims this suite proves:
 *
 *   authority    only an active Super Admin may request, cancel, purge or export;
 *   step-up      a destructive request needs the operator's password, verified
 *                server-side, and a wrong one changes nothing;
 *   eligibility  a blocked subscriber cannot be scheduled, and the refusal is
 *                audited outside the rolled-back transaction;
 *   recovery     a request archives and schedules but destroys nothing, is
 *                cancellable, and is re-assessed when the window elapses;
 *   isolation    a request, a purge and an export all touch exactly one tenant;
 *   secrets      no export or audit record ever carries a credential.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  authHeaders,
  createTestContext,
  login,
  seedUser,
  TEST_PASSWORD,
  type SessionCookies,
  type TestContext,
} from './helpers/testApp.js';
import { processDueDeletions } from '../src/services/subscriberClosureService.js';

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

async function planId(code = 'core'): Promise<string> {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
  return response.json().plans.find((p: { code: string }) => p.code === code).id;
}

/**
 * A subscriber. `activate: true` makes it PERMANENTLY unpurgeable — an activated
 * tenant was permitted durable accounting writes.
 */
async function subscriber(
  admin: SessionCookies,
  options: {
    activate?: boolean;
    email?: string;
    legalName?: string;
    classification?: 'production' | 'test' | 'demo';
  } = {},
): Promise<{ organizationId: string; legalName: string; userId: string }> {
  const legalName = options.legalName ?? 'NewCo Trading LLC';
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/subscribers',
    headers: authHeaders(admin),
    payload: {
      fullName: 'Owner Person',
      email: options.email ?? 'owner@newco.test',
      organizationLegalName: legalName,
      country: 'AE',
      baseCurrency: 'AED',
      planId: await planId(),
      /*
       * This suite is about the closure WORKFLOW, and only test/demo data can
       * reach permanent deletion at all. The retention rule itself is asserted
       * in `dataClassification.test.ts`, with production fixtures.
       */
      dataClassification: options.classification ?? 'test',
      onboarding: 'temporary',
      paymentConfirmed: options.activate ?? false,
      subscriptionStatus: options.activate ? 'active' : 'draft',
    },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return { organizationId: body.subscriber.organizationId, legalName, userId: body.subscriber.userId };
}

const requestDeletion = (
  admin: SessionCookies,
  organizationId: string,
  overrides: Record<string, unknown> = {},
) =>
  ctx.app.inject({
    method: 'POST',
    url: `/api/admin/subscribers/${organizationId}/request-deletion`,
    headers: authHeaders(admin),
    payload: {
      reason: 'Customer asked us to close the account.',
      confirmation: 'NewCo Trading LLC',
      password: TEST_PASSWORD,
      ...overrides,
    },
  });

async function auditActions(): Promise<string[]> {
  return (await ctx.db.selectFrom('audit_logs').select('action').execute()).map((r) => r.action);
}

async function organizationRow(organizationId: string) {
  return ctx.db
    .selectFrom('organizations')
    .selectAll()
    .where('id', '=', organizationId)
    .executeTakeFirstOrThrow();
}

/* ══ Authority ═══════════════════════════════════════════════════════════ */

describe('only a super administrator may close a subscriber', () => {
  it('refuses a billing admin, a support operator and a customer', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);

    const billing = await operator('billing_admin', 'billing@ledgora.test');
    const support = await operator('support', 'support@ledgora.test');
    await seedUser(ctx, { email: 'plain@newco.test', fullName: 'Plain' });
    const customer = await login(ctx, 'plain@newco.test');

    for (const [label, cookies] of [
      ['billing_admin', billing.cookies],
      ['support', support.cookies],
      ['customer', customer],
    ] as const) {
      expect((await requestDeletion(cookies, organizationId)).statusCode, label).toBe(403);
      expect(
        (await ctx.app.inject({
          method: 'POST',
          url: `/api/admin/subscribers/${organizationId}/export`,
          headers: authHeaders(cookies),
          payload: {},
        })).statusCode,
        label,
      ).toBe(403);
    }

    // Nothing was scheduled by any of them.
    expect((await organizationRow(organizationId)).deletion_requested_at).toBeNull();
  });

  it('refuses an unauthenticated caller', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/request-deletion`,
      payload: { reason: 'x', confirmation: 'y', password: 'z' },
    });
    expect(response.statusCode).toBe(401);
  });
});

/* ══ Step-up re-authentication ═══════════════════════════════════════════ */

describe('re-authentication', () => {
  it('refuses a wrong password and changes nothing', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);

    const response = await requestDeletion(admin.cookies, organizationId, {
      password: 'not-the-right-password',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('reauthentication_failed');

    const organization = await organizationRow(organizationId);
    expect(organization.deletion_requested_at).toBeNull();
    expect(organization.status).not.toBe('pending_deletion');
    expect(await auditActions()).toContain('auth.reauthentication_failed');
  });

  it('never stores or echoes the password', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const response = await requestDeletion(admin.cookies, organizationId);
    expect(response.statusCode).toBe(200);

    expect(response.body).not.toContain(TEST_PASSWORD);
    const audits = await ctx.db.selectFrom('audit_logs').selectAll().execute();
    expect(JSON.stringify(audits)).not.toContain(TEST_PASSWORD);
  });

  it('requires the confirmation to match the real organization name', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);

    const wrong = await requestDeletion(admin.cookies, organizationId, { confirmation: 'Some Other Co' });
    expect(wrong.statusCode).toBe(400);
    expect((await organizationRow(organizationId)).deletion_requested_at).toBeNull();

    // The owner's email is accepted too — an operator may have only that.
    const byEmail = await requestDeletion(admin.cookies, organizationId, {
      confirmation: 'owner@newco.test',
    });
    expect(byEmail.statusCode).toBe(200);
  });
});

/* ══ Eligibility ═════════════════════════════════════════════════════════ */

describe('eligibility is enforced at request time', () => {
  it('refuses a subscriber that has ever been activated, and audits the refusal', async () => {
    const admin = await operator();
    // PRODUCTION: the accounting-records blocker protects real data and is
    // deliberately waived for test/demo.
    const { organizationId } = await subscriber(admin.cookies, {
      activate: true,
      classification: 'production',
    });

    const response = await requestDeletion(admin.cookies, organizationId);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/Archive the subscriber instead/);

    // Nothing scheduled, nothing archived, nothing destroyed.
    const organization = await organizationRow(organizationId);
    expect(organization.deletion_requested_at).toBeNull();
    expect(organization.status).toBe('active');

    // The refusal survives — it is written outside any rolled-back transaction.
    const blocked = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'subscriber.purge_blocked')
      .where('target_id', '=', organizationId)
      .execute();
    expect(blocked).toHaveLength(1);
    const metadata =
      typeof blocked[0]!.metadata === 'string' ? JSON.parse(blocked[0]!.metadata) : blocked[0]!.metadata;
    expect(metadata.stage).toBe('request');
    expect(metadata.blockedBy).toContain('accounting_records_possible');
    expect(typeof metadata.requestId).toBe('string');
    expect(blocked[0]!.actor_user_id).toBe(admin.userId);
  });

  it('refuses a subscriber under legal hold, whoever asks', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);

    const hold = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/subscribers/${organizationId}/legal-hold`,
      headers: authHeaders(admin.cookies),
      payload: { hold: true, reason: 'Ongoing dispute.' },
    });
    expect(hold.statusCode).toBe(200);

    // A Super Admin initiating it does not lift a retention rule.
    const response = await requestDeletion(admin.cookies, organizationId);
    expect(response.statusCode).toBe(409);
    expect((await organizationRow(organizationId)).deletion_requested_at).toBeNull();
  });
});

/* ══ The recovery period ═════════════════════════════════════════════════ */

describe('the pending-deletion period', () => {
  it('archives and schedules without destroying anything', async () => {
    const admin = await operator();
    /*
     * ACTIVATED, so a recovery window genuinely applies. A clean, never-activated
     * disposable tenant is now purgeable immediately — it has nothing for a
     * window to protect — and this test is about the window itself.
     */
    const { organizationId } = await subscriber(admin.cookies, { activate: true });

    const before = {
      members: await ctx.db.selectFrom('organization_memberships').selectAll().execute(),
      subscriptions: await ctx.db.selectFrom('subscriptions').selectAll().execute(),
      users: await ctx.db.selectFrom('users').select(['id', 'email']).execute(),
    };

    const response = await requestDeletion(admin.cookies, organizationId);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.organizationStatus).toBe('pending_deletion');
    expect(new Date(body.scheduledPurgeAfter).getTime()).toBeGreaterThan(Date.now());

    const organization = await organizationRow(organizationId);
    expect(organization.status).toBe('pending_deletion');
    expect(organization.deletion_requested_at).not.toBeNull();
    expect(organization.deletion_requested_by).toBe(admin.userId);
    expect(organization.deletion_reason).toBe('Customer asked us to close the account.');

    // Records intact. A request destroys nothing.
    expect(await ctx.db.selectFrom('organization_memberships').selectAll().execute()).toHaveLength(
      before.members.length,
    );
    expect(await ctx.db.selectFrom('subscriptions').selectAll().execute()).toHaveLength(
      before.subscriptions.length,
    );
    expect(await ctx.db.selectFrom('users').select(['id', 'email']).execute()).toEqual(before.users);

    expect(await auditActions()).toContain('subscriber.deletion_requested');
  });

  it('revokes every member session immediately', async () => {
    const admin = await operator();
    const { organizationId, userId } = await subscriber(admin.cookies);

    await ctx.db
      .insertInto('auth_sessions')
      .values({
        user_id: userId,
        token_hash: 'b'.repeat(64),
        expires_at: new Date(Date.now() + 3_600_000),
      })
      .execute();

    expect((await requestDeletion(admin.cookies, organizationId)).statusCode).toBe(200);

    const live = await ctx.db
      .selectFrom('auth_sessions')
      .select('id')
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
    expect(live).toHaveLength(0);
  });

  it('is idempotent — a repeated request does not reset the schedule', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);

    const first = await requestDeletion(admin.cookies, organizationId);
    expect(first.statusCode).toBe(200);
    const scheduled = (await organizationRow(organizationId)).deletion_eligible_after;

    const second = await requestDeletion(admin.cookies, organizationId);
    expect(second.statusCode).toBe(409);
    // The window was not extended by the second attempt.
    expect((await organizationRow(organizationId)).deletion_eligible_after).toEqual(scheduled);
  });

  it('can be cancelled, returning the subscriber to archived', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    expect((await requestDeletion(admin.cookies, organizationId)).statusCode).toBe(200);

    const cancel = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/cancel-deletion`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Customer changed their mind.' },
    });
    expect(cancel.statusCode).toBe(200);

    const organization = await organizationRow(organizationId);
    expect(organization.status).toBe('archived');
    expect(organization.deletion_requested_at).toBeNull();
    expect(organization.deletion_eligible_after).toBeNull();

    // Both halves of the history survive.
    const actions = await auditActions();
    expect(actions).toContain('subscriber.deletion_requested');
    expect(actions).toContain('subscriber.deletion_cancelled');
  });

  it('refuses to restore a subscriber while a deletion is pending', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    expect((await requestDeletion(admin.cookies, organizationId)).statusCode).toBe(200);

    const restore = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/reactivate`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Bringing them back.' },
    });
    // Cancelling a purge is a deliberate act, not a side effect of "restore".
    expect(restore.statusCode).toBe(409);
    expect((await organizationRow(organizationId)).status).toBe('pending_deletion');
  });

  it('reports the closure status the action menu needs', async () => {
    const admin = await operator();
    /*
     * ACTIVATED, so a recovery window genuinely applies. A clean, never-activated
     * disposable tenant is now purgeable immediately — it has nothing for a
     * window to protect — and this test is about the window itself.
     */
    const { organizationId } = await subscriber(admin.cookies, { activate: true });
    await requestDeletion(admin.cookies, organizationId);

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/subscribers/${organizationId}/closure`,
      headers: authHeaders(admin.cookies),
    });
    expect(response.statusCode).toBe(200);
    const closure = response.json().closure;
    expect(closure.organizationStatus).toBe('pending_deletion');
    expect(closure.canCancelDeletion).toBe(true);
    expect(closure.canRestore).toBe(false);
    expect(closure.recoveryDaysRemaining).toBeGreaterThan(0);
    expect(closure.scheduledPurgeAfter).toBeTruthy();
  });
});

/* ══ The scheduled run ═══════════════════════════════════════════════════ */

describe('processing due deletions', () => {
  const adminContext = (userId: string) => ({
    actorUserId: userId,
    actorPlatformRole: 'super_admin',
    requestId: 'test-run',
  });

  /** Age the schedule rather than waiting 30 days. */
  async function makeDue(organizationId: string): Promise<void> {
    await ctx.db
      .updateTable('organizations')
      .set({ deletion_eligible_after: new Date(Date.now() - 60_000) })
      .where('id', '=', organizationId)
      .execute();
  }

  it('does nothing before the recovery window elapses', async () => {
    const admin = await operator();
    /*
     * ACTIVATED, so a recovery window genuinely applies. A clean, never-activated
     * disposable tenant is now purgeable immediately — it has nothing for a
     * window to protect — and this test is about the window itself.
     */
    const { organizationId } = await subscriber(admin.cookies, { activate: true });
    await requestDeletion(admin.cookies, organizationId);

    const result = await processDueDeletions(ctx.db, adminContext(admin.userId));
    expect(result.considered).toBe(0);
    expect(await organizationRow(organizationId)).toBeTruthy();
  });

  it('purges a still-eligible subscriber once due', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    await requestDeletion(admin.cookies, organizationId);
    await makeDue(organizationId);

    const result = await processDueDeletions(ctx.db, adminContext(admin.userId));
    expect(result.considered).toBe(1);
    expect(result.purged).toBe(1);

    expect(
      await ctx.db.selectFrom('organizations').select('id').where('id', '=', organizationId).executeTakeFirst(),
    ).toBeUndefined();

    const actions = await auditActions();
    expect(actions).toContain('subscriber.deletion_due');
    expect(actions).toContain('subscriber.purged');
  });

  it('re-assesses at run time and refuses a subscriber that became ineligible', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    await requestDeletion(admin.cookies, organizationId);
    await makeDue(organizationId);

    // A legal hold applied during the recovery window.
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/subscribers/${organizationId}/legal-hold`,
      headers: authHeaders(admin.cookies),
      payload: { hold: true, reason: 'Investigation opened.' },
    });

    const result = await processDueDeletions(ctx.db, adminContext(admin.userId));
    expect(result.blocked).toBe(1);
    expect(result.purged).toBe(0);
    expect(result.results[0]!.blockedBy).toContain('legal_hold');

    // Still there, and STILL scheduled — a temporary block does not discard the
    // request, it defers it.
    const organization = await organizationRow(organizationId);
    expect(organization.deletion_requested_at).not.toBeNull();
  });

  it('processes each subscriber independently', async () => {
    const admin = await operator();
    const one = await subscriber(admin.cookies, { email: 'a@one.test', legalName: 'One LLC' });
    const two = await subscriber(admin.cookies, { email: 'b@two.test', legalName: 'Two LLC' });

    await requestDeletion(admin.cookies, one.organizationId, { confirmation: 'One LLC' });
    await requestDeletion(admin.cookies, two.organizationId, { confirmation: 'Two LLC' });
    await makeDue(one.organizationId);
    await makeDue(two.organizationId);

    // Block only the first.
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/subscribers/${one.organizationId}/legal-hold`,
      headers: authHeaders(admin.cookies),
      payload: { hold: true, reason: 'Hold.' },
    });

    const result = await processDueDeletions(ctx.db, adminContext(admin.userId));
    expect(result.considered).toBe(2);
    expect(result.blocked).toBe(1);
    expect(result.purged).toBe(1);

    // One survives, two is gone — a blocked tenant does not stop the batch.
    expect(await organizationRow(one.organizationId)).toBeTruthy();
    expect(
      await ctx.db
        .selectFrom('organizations')
        .select('id')
        .where('id', '=', two.organizationId)
        .executeTakeFirst(),
    ).toBeUndefined();
  });
});

/* ══ Data export ═════════════════════════════════════════════════════════ */

describe('subscriber data export', () => {
  async function createExport(admin: SessionCookies, organizationId: string) {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/export`,
      headers: authHeaders(admin),
      payload: {},
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  it('generates a scoped export and records it', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);

    const created = await createExport(admin.cookies, organizationId);
    expect(created.status).toBe('ready');
    expect(typeof created.downloadToken).toBe('string');
    expect(created.sectionCounts.members).toBeGreaterThan(0);
    // Honest about what it cannot contain.
    expect(created.unavailableSections).toContain('journals_and_ledger');

    expect(await auditActions()).toContain('subscriber.export_created');
  });

  it('never contains a credential, and never another tenant’s data', async () => {
    const admin = await operator();
    const mine = await subscriber(admin.cookies, { email: 'mine@one.test', legalName: 'One LLC' });
    await subscriber(admin.cookies, { email: 'theirs@two.test', legalName: 'Two LLC' });

    const created = await createExport(admin.cookies, mine.organizationId);
    const download = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${mine.organizationId}/exports/${created.exportId}/download`,
      headers: authHeaders(admin.cookies),
      payload: { token: created.downloadToken },
    });
    expect(download.statusCode).toBe(200);
    const serialised = download.body;

    // No secrets of any kind.
    const hashes = await ctx.db.selectFrom('users').select('password_hash').execute();
    for (const { password_hash } of hashes) expect(serialised).not.toContain(password_hash);
    const tokens = await ctx.db.selectFrom('password_reset_tokens').select('token_hash').execute();
    for (const { token_hash } of tokens) expect(serialised).not.toContain(token_hash);
    expect(serialised).not.toContain(created.downloadToken);

    // Nothing belonging to the other tenant.
    expect(serialised).not.toContain('Two LLC');
    expect(serialised).not.toContain('theirs@two.test');
    expect(serialised).toContain('One LLC');
  });

  it('refuses a token used against the wrong organization', async () => {
    const admin = await operator();
    const mine = await subscriber(admin.cookies, { email: 'mine@one.test', legalName: 'One LLC' });
    const other = await subscriber(admin.cookies, { email: 'theirs@two.test', legalName: 'Two LLC' });

    const created = await createExport(admin.cookies, mine.organizationId);
    // A valid token, presented through the OTHER tenant's path.
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${other.organizationId}/exports/${created.exportId}/download`,
      headers: authHeaders(admin.cookies),
      payload: { token: created.downloadToken },
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a wrong, expired or revoked token identically', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const created = await createExport(admin.cookies, organizationId);
    const url = `/api/admin/subscribers/${organizationId}/exports/${created.exportId}/download`;

    const wrong = await ctx.app.inject({
      method: 'POST',
      url,
      headers: authHeaders(admin.cookies),
      payload: { token: 'not-the-token-at-all' },
    });
    expect(wrong.statusCode).toBe(400);

    await ctx.db
      .updateTable('subscriber_data_exports')
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where('id', '=', created.exportId)
      .execute();
    const expired = await ctx.app.inject({
      method: 'POST',
      url,
      headers: authHeaders(admin.cookies),
      payload: { token: created.downloadToken },
    });
    expect(expired.statusCode).toBe(400);
    expect(expired.json().error.message).toBe(wrong.json().error.message);
  });

  it('destroys the stored copy when an export is revoked', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const created = await createExport(admin.cookies, organizationId);

    const revoke = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/exports/${created.exportId}/revoke`,
      headers: authHeaders(admin.cookies),
      payload: { reason: 'Sent to the wrong recipient.' },
    });
    expect(revoke.statusCode).toBe(200);

    const row = await ctx.db
      .selectFrom('subscriber_data_exports')
      .select(['status', 'payload'])
      .where('id', '=', created.exportId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('revoked');
    // A revocation that left the data behind would be a revocation in name only.
    expect(row.payload).toBeNull();

    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: `/api/admin/subscribers/${organizationId}/exports/${created.exportId}/download`,
        headers: authHeaders(admin.cookies),
        payload: { token: created.downloadToken },
      })).statusCode,
    ).toBe(400);
  });

  it('lists exports without ever returning a token or a payload', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies);
    const created = await createExport(admin.cookies, organizationId);

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/subscribers/${organizationId}/exports`,
      headers: authHeaders(admin.cookies),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(created.downloadToken);
    expect(response.json().exports[0].exportId).toBe(created.exportId);
    expect(response.json().exports[0]).not.toHaveProperty('payload');
  });
});

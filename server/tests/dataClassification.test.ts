/**
 * The retention invariant, and the one narrow exception to it.
 *
 * Two things are proved here, and they are the reason the whole feature exists:
 *   1. Production data cannot become test/demo data through ANY ordinary path —
 *      not the API, not a forged field, not a direct UPDATE, not Super Admin
 *      authority. The database refuses it.
 *   2. The development bootstrap that CAN do it refuses to run in production,
 *      refuses without its flag, refuses without explicit ids, and refuses to
 *      launder a protected tenant.
 */
import { sql } from 'kysely';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  authHeaders,
  createTestContext,
  login,
  seedUser,
  TEST_PASSWORD,
  type SessionCookies,
  type TestContext,
} from './helpers/testApp.js';
import {
  applyLegacyClassification,
  previewLegacyClassification,
  BOOTSTRAP_CONFIRMATION,
} from '../src/services/classificationService.js';
import { assessSubscriberDeletion, PRODUCTION_RETENTION_MESSAGE } from '../src/services/deletionService.js';
import * as envModule from '../src/config/env.js';
import { loadConfig } from '../src/config/env.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await ctx.close();
});

/** Override only the two fields the bootstrap consults, leaving the rest real. */
function configureBootstrap(options: { isProduction: boolean; allowed: boolean }): void {
  const actual = envModule.getConfig();
  vi.spyOn(envModule, 'getConfig').mockReturnValue({
    ...actual,
    isProduction: options.isProduction,
    ALLOW_LEGACY_DATA_CLASSIFICATION: options.allowed,
  } as ReturnType<typeof envModule.getConfig>);
}

async function operator(email = 'super_admin@ledgora.test'): Promise<{ cookies: SessionCookies; userId: string }> {
  const user = await seedUser(ctx, { email, fullName: 'Operator', platformRoles: ['super_admin'] });
  return { cookies: await login(ctx, email), userId: user.id };
}

/** A customer registering and creating their own organization: production by default. */
async function anOrganization(legalName = 'Legacy Dev Ltd'): Promise<string> {
  const email = `${legalName.replace(/\W/g, '').toLowerCase()}@dev.test`;
  const registered = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: TEST_PASSWORD, fullName: 'Self Signup' },
  });
  const raw = registered.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const find = (name: string): string => {
    const match = list.find((c) => c.startsWith(`${name}=`));
    return match ? (match.split(';')[0]?.split('=').slice(1).join('=') ?? '') : '';
  };
  const customer = { cookies: { session: find('ledgora_session'), csrf: find('ledgora_csrf') } };
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/organizations',
    headers: authHeaders(customer.cookies),
    payload: { legalName, country: 'AE' },
  });
  return created.json().organizationId as string;
}

function classificationOf(organizationId: string) {
  return ctx.db
    .selectFrom('organizations')
    .select(['data_classification', 'classification_reason'])
    .where('id', '=', organizationId)
    .executeTakeFirstOrThrow();
}

describe('the one-way rule', () => {
  it('refuses a direct database downgrade from production', async () => {
    const organizationId = await anOrganization();

    /*
     * Not through a service — a raw UPDATE, the most privileged thing any code
     * path in this application could do. If the guarantee held only in a
     * service, this would succeed.
     */
    await expect(
      ctx.db
        .updateTable('organizations')
        .set({ data_classification: 'test' })
        .where('id', '=', organizationId)
        .execute(),
    ).rejects.toThrow(/cannot be reclassified as test or demo/i);

    expect((await classificationOf(organizationId)).data_classification).toBe('production');
  });

  it('permits promotion to production and stamps when it happened', async () => {
    const organizationId = await anOrganization('Pilot Ltd');

    await ctx.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ledgora.legacy_classification = 'on'`.execute(trx);
      await trx
        .updateTable('organizations')
        .set({ data_classification: 'test' })
        .where('id', '=', organizationId)
        .execute();
    });

    // A pilot that became a real customer. This direction is legitimate.
    await ctx.db
      .updateTable('organizations')
      .set({ data_classification: 'production' })
      .where('id', '=', organizationId)
      .execute();

    expect((await classificationOf(organizationId)).data_classification).toBe('production');

    // …and is now irreversible again.
    await expect(
      ctx.db
        .updateTable('organizations')
        .set({ data_classification: 'demo' })
        .where('id', '=', organizationId)
        .execute(),
    ).rejects.toThrow(/cannot be reclassified/i);
  });

  it('leaves the escape hatch off once the transaction that set it ends', async () => {
    const first = await anOrganization('First Ltd');
    const second = await anOrganization('Second Ltd');

    await ctx.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ledgora.legacy_classification = 'on'`.execute(trx);
      await trx
        .updateTable('organizations')
        .set({ data_classification: 'test' })
        .where('id', '=', first)
        .execute();
    });

    /*
     * SET LOCAL, not SET: the setting must not survive its transaction, or the
     * bootstrap would silently disarm the trigger for everything that followed
     * on the same connection.
     */
    await expect(
      ctx.db
        .updateTable('organizations')
        .set({ data_classification: 'test' })
        .where('id', '=', second)
        .execute(),
    ).rejects.toThrow(/cannot be reclassified/i);
  });
});

describe('production subscribers cannot be permanently deleted', () => {
  it('refuses the purge and says what to do instead', async () => {
    const organizationId = await anOrganization('Real Customer Ltd');

    const report = await assessSubscriberDeletion(ctx.db, organizationId);

    expect(report.classification).toBe('production');
    expect(report.disposable).toBe(false);
    expect(report.deletionPermitted).toBe(false);
    expect(report.blockingReasons.some((r) => r.code === 'production_subscriber')).toBe(true);
    expect(report.recommendation).toBe(PRODUCTION_RETENTION_MESSAGE);
  });

  it('ignores a classification supplied by the caller', async () => {
    const admin = await operator('retention@ledgora.test');
    const organizationId = await anOrganization('Forged Ltd');

    /*
     * The eligibility answer is read from the row, never from the request. A
     * client claiming its target is test data changes nothing.
     */
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/subscribers/${organizationId}`,
      headers: authHeaders(admin.cookies),
      payload: {
        reason: 'Claiming this is throwaway data.',
        confirmationName: 'Forged Ltd',
        // Smuggled: the request asserts its own eligibility. It is read from
        // the database row instead, so none of this has any effect.
        dataClassification: 'test',
        classification: 'demo',
        disposable: true,
      },
    });

    expect(response.statusCode).toBe(409);
    expect((await classificationOf(organizationId)).data_classification).toBe('production');
  });
});

/* ══ Console reclassification ══════════════════════════════════════════════ */

describe('changing a classification through the console', () => {
  /** Create a subscriber at a chosen classification via the admin route. */
  async function subscriberAt(
    cookies: SessionCookies,
    classification: 'production' | 'test' | 'demo',
    legalName: string,
  ): Promise<string> {
    const plans = (await ctx.app.inject({ method: 'GET', url: '/api/plans/public' })).json().plans;
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/subscribers',
      headers: authHeaders(cookies),
      payload: {
        fullName: 'Owner',
        email: `${legalName.replace(/\W/g, '').toLowerCase()}@dev.test`,
        organizationLegalName: legalName,
        country: 'AE',
        planId: plans[0].id,
        onboarding: 'invite',
        dataClassification: classification,
      },
    });
    expect(response.statusCode, JSON.stringify(response.json())).toBe(201);
    return response.json().subscriber.organizationId as string;
  }

  function patch(cookies: SessionCookies, organizationId: string, payload: unknown) {
    return ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/subscribers/${organizationId}/classification`,
      headers: authHeaders(cookies),
      payload: payload as Record<string, unknown>,
    });
  }

  it('persists the classification chosen at creation', async () => {
    const admin = await operator();

    for (const classification of ['production', 'test', 'demo'] as const) {
      const id = await subscriberAt(admin.cookies, classification, `Created ${classification} Ltd`);
      expect((await classificationOf(id)).data_classification).toBe(classification);
    }
  });

  it('allows demo <-> test and promotion to production, recording who and why', async () => {
    const admin = await operator();
    const id = await subscriberAt(admin.cookies, 'demo', 'Flexible Ltd');

    const toTest = await patch(admin.cookies, id, {
      classification: 'test',
      reason: 'Repurposed from sales demos to the QA rotation.',
    });
    expect(toTest.statusCode).toBe(200);
    expect((await classificationOf(id)).data_classification).toBe('test');

    const backToDemo = await patch(admin.cookies, id, {
      classification: 'demo',
      reason: 'Needed again for the customer demonstration next week.',
    });
    expect(backToDemo.statusCode).toBe(200);

    const promoted = await patch(admin.cookies, id, {
      classification: 'production',
      reason: 'The prospect signed; this is now a real customer account.',
    });
    expect(promoted.statusCode).toBe(200);

    const row = await classificationOf(id);
    expect(row.data_classification).toBe('production');
    expect(row.classification_reason).toMatch(/prospect signed/i);

    // Promotion is stamped, so "since when has this been real?" is answerable.
    const stamped = await ctx.db
      .selectFrom('organizations')
      .select(['classified_production_at', 'classified_by'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(stamped.classified_production_at).toBeTruthy();
    expect(stamped.classified_by).toBe(admin.userId);
  });

  it('refuses to downgrade production to demo or test, over the API', async () => {
    const admin = await operator();
    const id = await subscriberAt(admin.cookies, 'production', 'Real Customer Two Ltd');

    for (const target of ['demo', 'test'] as const) {
      const response = await patch(admin.cookies, id, {
        classification: target,
        reason: 'Attempting to make a real customer disposable.',
      });
      expect(response.statusCode, `downgrade to ${target} must be refused`).toBe(409);
      expect(response.json().error.message).toMatch(/permanent/i);
      expect((await classificationOf(id)).data_classification).toBe('production');
    }
  });

  it('is refused by the database even when the service check is bypassed', async () => {
    const id = await anOrganization('Trigger Guard Ltd');

    /*
     * Straight at the table, with no service in the way. If the one-way rule
     * lived only in TypeScript, this would succeed — which is the entire reason
     * it is a trigger.
     */
    await expect(
      ctx.db
        .updateTable('organizations')
        .set({ data_classification: 'test' })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow();

    expect((await classificationOf(id)).data_classification).toBe('production');
  });

  it('requires a reason and rejects an unchanged classification', async () => {
    const admin = await operator();
    const id = await subscriberAt(admin.cookies, 'test', 'Reasoned Ltd');

    // 400: the body is malformed. Contrast the 409 below, which is a statement
    // about the account rather than about the request.
    const noReason = await patch(admin.cookies, id, { classification: 'demo', reason: 'too short' });
    expect(noReason.statusCode).toBe(400);

    const unchanged = await patch(admin.cookies, id, {
      classification: 'test',
      reason: 'Setting it to the value it already has.',
    });
    expect(unchanged.statusCode).toBe(409);
  });

  it('refuses an operator without subscribers.manage', async () => {
    const admin = await operator();
    const id = await subscriberAt(admin.cookies, 'demo', 'Guarded Ltd');

    await seedUser(ctx, {
      email: 'billing@ledgora.test',
      fullName: 'Billing Admin',
      platformRoles: ['billing_admin'],
    });
    const billing = await login(ctx, 'billing@ledgora.test');

    const response = await patch(billing, id, {
      classification: 'production',
      reason: 'A role without subscriber management attempting a change.',
    });
    expect(response.statusCode).toBe(403);
    expect((await classificationOf(id)).data_classification).toBe('demo');
  });

  it('audits the change with both classifications and no credentials', async () => {
    const admin = await operator();
    const id = await subscriberAt(admin.cookies, 'demo', 'Audited Ltd');

    await patch(admin.cookies, id, {
      classification: 'production',
      reason: 'Converted to a paying customer after the pilot.',
    });

    const entry = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'organization.classification_changed')
      .where('target_id', '=', id)
      .executeTakeFirstOrThrow();

    const metadata = entry.metadata as Record<string, unknown>;
    expect(entry.actor_user_id).toBe(admin.userId);
    expect(metadata.previousClassification).toBe('demo');
    expect(metadata.newClassification).toBe('production');
    expect(metadata.reason).toMatch(/paying customer/i);
    expect(metadata.irreversible).toBe(true);

    // An audit row is read by more people than the action it records.
    const serialised = JSON.stringify(metadata).toLowerCase();
    for (const forbidden of ['password', 'token', 'secret', 'cookie', 'session']) {
      expect(serialised, `metadata must not carry a ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('does not make a disposable subscriber deletable on classification alone', async () => {
    const admin = await operator();
    const id = await subscriberAt(admin.cookies, 'test', 'Blocked Anyway Ltd');

    // Classified test, but under a legal hold.
    await ctx.db
      .updateTable('organizations')
      .set({ legal_hold: true, legal_hold_reason: 'Pending dispute' })
      .where('id', '=', id)
      .execute();

    const report = await assessSubscriberDeletion(ctx.db, id);
    expect(report.disposable, 'it IS disposable by classification').toBe(true);
    expect(report.deletionPermitted, 'and still not deletable').toBe(false);
    expect(report.blockingReasons.some((r) => r.code === 'legal_hold')).toBe(true);
  });

  it('filters the roster by classification in SQL, not per page', async () => {
    const admin = await operator();
    await subscriberAt(admin.cookies, 'production', 'Roster Production Ltd');
    await subscriberAt(admin.cookies, 'demo', 'Roster Demo Ltd');
    await subscriberAt(admin.cookies, 'test', 'Roster Test Ltd');

    const query = async (classification: string) => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/admin/subscribers?classification=${classification}`,
        headers: authHeaders(admin.cookies),
      });
      expect(response.statusCode).toBe(200);
      return response.json().subscribers as { legalName: string; dataClassification: string }[];
    };

    expect((await query('demo')).map((s) => s.legalName)).toEqual(['Roster Demo Ltd']);
    expect((await query('test')).map((s) => s.legalName)).toEqual(['Roster Test Ltd']);
    expect((await query('production')).every((s) => s.dataClassification === 'production')).toBe(true);
    expect((await query('all')).length).toBeGreaterThanOrEqual(3);
  });
});

/* ══ Reconciling the migration's blanket default ═══════════════════════════ */

/**
 * No organization is unclassified — `data_classification` is NOT NULL DEFAULT
 * 'production' — so what needs reconciling is the migration's GUESS, not an
 * absent value. These tests pin down that the console can confirm that guess and
 * can never invert it.
 */
describe('classifying an unreviewed subscriber', () => {
  function classify(cookies: SessionCookies, organizationId: string, payload: unknown) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/admin/subscribers/${organizationId}/classify`,
      headers: authHeaders(cookies),
      payload: payload as Record<string, unknown>,
    });
  }

  function reviewStateOf(organizationId: string) {
    return ctx.db
      .selectFrom('organizations')
      .select(['classification_reviewed_at', 'classification_reviewed_by', 'data_classification'])
      .where('id', '=', organizationId)
      .executeTakeFirstOrThrow();
  }

  it('treats a self-registered organization as unreviewed, and a console-created one as reviewed', async () => {
    const admin = await operator();
    const selfRegistered = await anOrganization('Self Signup Ltd');

    // Nobody looked at this one: the 008 default is all that ever set it.
    expect((await reviewStateOf(selfRegistered)).classification_reviewed_at).toBeNull();

    const plans = (await ctx.app.inject({ method: 'GET', url: '/api/plans/public' })).json().plans;
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/subscribers',
      headers: authHeaders(admin.cookies),
      payload: {
        fullName: 'Owner',
        email: 'console-made@dev.test',
        organizationLegalName: 'Console Made Ltd',
        country: 'AE',
        planId: plans[0].id,
        onboarding: 'invite',
        dataClassification: 'production',
      },
    });
    // An operator picked the type on the form, so it is reviewed from birth and
    // must not appear in the reconciliation queue.
    expect((await reviewStateOf(created.json().subscriber.organizationId)).classification_reviewed_at)
      .not.toBeNull();
  });

  it('confirms production, stamps the reviewer, and is one-time', async () => {
    const admin = await operator();
    const organizationId = await anOrganization('Unreviewed Ltd');

    const first = await classify(admin.cookies, organizationId, {
      classification: 'production',
      reason: 'Checked the billing history; this is a genuine customer account.',
    });
    expect(first.statusCode, JSON.stringify(first.json())).toBe(200);

    const state = await reviewStateOf(organizationId);
    expect(state.classification_reviewed_at).not.toBeNull();
    expect(state.classification_reviewed_by).toBe(admin.userId);
    // The classification itself is untouched — this records a review, not a move.
    expect(state.data_classification).toBe('production');

    // One-time: a second operator cannot overwrite the first one's decision.
    const second = await classify(admin.cookies, organizationId, {
      classification: 'production',
      reason: 'Attempting to reconcile an account that was already reconciled.',
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.message).toMatch(/already been classified/i);
  });

  it('refuses demo and test even when the record looks entirely clean', async () => {
    const admin = await operator();
    const organizationId = await anOrganization('Pristine Ltd');

    for (const target of ['demo', 'test'] as const) {
      const response = await classify(admin.cookies, organizationId, {
        classification: target,
        reason: 'This looks like leftover development data to me.',
      });

      /*
       * Ambiguity resolves to production, and so does non-ambiguity: this
       * endpoint has no path to a disposable outcome at any evidence level.
       * That is what makes it safe to expose over HTTP at all.
       */
      expect(response.statusCode, `${target} must be refused`).toBe(409);
      expect(response.json().error.message).toMatch(/development CLI/i);
      expect((await reviewStateOf(organizationId)).data_classification).toBe('production');
      // A refusal must not half-apply: the account stays unreviewed.
      expect((await reviewStateOf(organizationId)).classification_reviewed_at).toBeNull();
    }
  });

  it('names the evidence when a tenant has real billing history', async () => {
    const admin = await operator();
    const organizationId = await anOrganization('Paying Customer Ltd');

    await ctx.db
      .updateTable('organizations')
      .set({ legal_hold: true, legal_hold_reason: 'Ongoing dispute' })
      .where('id', '=', organizationId)
      .execute();

    const response = await classify(admin.cookies, organizationId, {
      classification: 'demo',
      reason: 'Trying to mark a legally-held tenant as throwaway.',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/legal hold/i);
    expect(response.json().error.message).toMatch(/must be classified Production/i);
  });

  it('requires a reason', async () => {
    const admin = await operator();
    const organizationId = await anOrganization('Unreasoned Ltd');

    const response = await classify(admin.cookies, organizationId, {
      classification: 'production',
      reason: 'short',
    });
    expect(response.statusCode).toBe(400);
    expect((await reviewStateOf(organizationId)).classification_reviewed_at).toBeNull();
  });

  it('refuses an operator without subscribers.manage, and an ordinary customer', async () => {
    const organizationId = await anOrganization('Guarded Legacy Ltd');

    await seedUser(ctx, {
      email: 'support-only@ledgora.test',
      fullName: 'Support',
      platformRoles: ['support'],
    });
    const support = await login(ctx, 'support-only@ledgora.test');
    const asSupport = await classify(support, organizationId, {
      classification: 'production',
      reason: 'A support operator attempting a retention decision.',
    });
    expect(asSupport.statusCode).toBe(403);

    // A customer with no platform role at all.
    await seedUser(ctx, { email: 'customer@dev.test', fullName: 'Customer' });
    const customer = await login(ctx, 'customer@dev.test');
    const asCustomer = await classify(customer, organizationId, {
      classification: 'production',
      reason: 'An ordinary subscriber attempting a retention decision.',
    });
    expect(asCustomer.statusCode).toBe(403);

    expect((await reviewStateOf(organizationId)).classification_reviewed_at).toBeNull();
  });

  it('audits the decision with its evidence and no credentials', async () => {
    const admin = await operator();
    const organizationId = await anOrganization('Audited Legacy Ltd');

    await classify(admin.cookies, organizationId, {
      classification: 'production',
      reason: 'Confirmed against the signed order form.',
    });

    const entry = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'organization.classification_reviewed')
      .where('target_id', '=', organizationId)
      .executeTakeFirstOrThrow();

    const metadata = entry.metadata as Record<string, unknown>;
    expect(entry.actor_user_id).toBe(admin.userId);
    expect(metadata.classification).toBe('production');
    expect(metadata.reason).toMatch(/signed order form/i);
    expect(metadata.evidence).toBeTruthy();

    const serialised = JSON.stringify(metadata).toLowerCase();
    for (const forbidden of ['password', 'token', 'secret', 'cookie', 'session']) {
      expect(serialised, `metadata must not carry a ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('exposes the evidence summary the dialog renders', async () => {
    const admin = await operator();
    const organizationId = await anOrganization('Evidence Ltd');

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/subscribers/${organizationId}/classification-evidence`,
      headers: authHeaders(admin.cookies),
    });

    expect(response.statusCode).toBe(200);
    const evidence = response.json().evidence;
    expect(evidence.currentClassification).toBe('production');
    expect(evidence.reviewedAt).toBeNull();
    expect(evidence.paidInvoiceCount).toBe(0);
    expect(evidence.everActivated).toBe(false);
    expect(Array.isArray(evidence.findings)).toBe(true);
  });

  it('still cannot downgrade production through the reclassification route', async () => {
    const admin = await operator();
    const organizationId = await anOrganization('Still Guarded Ltd');

    // Reconcile it first, so it is a reviewed production account.
    await classify(admin.cookies, organizationId, {
      classification: 'production',
      reason: 'Confirmed as a real customer during reconciliation.',
    });

    const downgrade = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/subscribers/${organizationId}/classification`,
      headers: authHeaders(admin.cookies),
      payload: { classification: 'demo', reason: 'Attempting to undo the reconciliation.' },
    });

    expect(downgrade.statusCode).toBe(409);
    expect((await reviewStateOf(organizationId)).data_classification).toBe('production');
  });
});

describe('the development bootstrap', () => {
  it('refuses to run in a production deployment even with the flag enabled', async () => {
    // The flag is ON and the environment is production: the environment wins.
    configureBootstrap({ isProduction: true, allowed: true });
    const organizationId = await anOrganization('Prod Ltd');

    await expect(
      previewLegacyClassification(ctx.db, {
        organizationIds: [organizationId],
        targetClassification: 'test',
      }),
    ).rejects.toMatchObject({ code: 'production_environment' });

    await expect(
      applyLegacyClassification(ctx.db, {
        organizationIds: [organizationId],
        targetClassification: 'test',
        actorUserId: null,
        reason: 'cleaning up development data',
        confirmation: BOOTSTRAP_CONFIRMATION,
      }),
    ).rejects.toMatchObject({ code: 'production_environment' });

    expect((await classificationOf(organizationId)).data_classification).toBe('production');
  });

  it('is disabled unless the dedicated flag is set', async () => {
    configureBootstrap({ isProduction: false, allowed: false });
    const organizationId = await anOrganization('Flagless Ltd');

    await expect(
      previewLegacyClassification(ctx.db, {
        organizationIds: [organizationId],
        targetClassification: 'test',
      }),
    ).rejects.toMatchObject({ code: 'bootstrap_disabled' });
  });

  it('has no "all organizations" mode', async () => {
    configureBootstrap({ isProduction: false, allowed: true });

    await expect(
      previewLegacyClassification(ctx.db, { organizationIds: [], targetClassification: 'test' }),
    ).rejects.toMatchObject({ code: 'no_targets' });
  });

  it('previews without mutating anything', async () => {
    configureBootstrap({ isProduction: false, allowed: true });
    const organizationId = await anOrganization('Preview Ltd');

    const preview = await previewLegacyClassification(ctx.db, {
      organizationIds: [organizationId],
      targetClassification: 'test',
    });

    expect(preview.eligibleCount).toBe(1);
    expect(preview.candidates[0]?.currentClassification).toBe('production');
    expect((await classificationOf(organizationId)).data_classification).toBe('production');
  });

  it('requires the typed confirmation and a reason', async () => {
    configureBootstrap({ isProduction: false, allowed: true });
    const organizationId = await anOrganization('Careless Ltd');

    await expect(
      applyLegacyClassification(ctx.db, {
        organizationIds: [organizationId],
        targetClassification: 'test',
        actorUserId: null,
        reason: 'cleaning up development data',
        confirmation: 'yes',
      }),
    ).rejects.toMatchObject({ code: 'confirmation_mismatch' });

    await expect(
      applyLegacyClassification(ctx.db, {
        organizationIds: [organizationId],
        targetClassification: 'test',
        actorUserId: null,
        reason: 'x',
        confirmation: BOOTSTRAP_CONFIRMATION,
      }),
    ).rejects.toMatchObject({ code: 'reason_required' });

    expect((await classificationOf(organizationId)).data_classification).toBe('production');
  });

  it('reclassifies named organizations and records who, why and under which operation', async () => {
    configureBootstrap({ isProduction: false, allowed: true });
    const admin = await operator('bootstrap@ledgora.test');
    const organizationId = await anOrganization('Leftover Ltd');

    const result = await applyLegacyClassification(ctx.db, {
      organizationIds: [organizationId],
      targetClassification: 'test',
      actorUserId: admin.userId,
      reason: 'Seeded during development before classification existed.',
      confirmation: BOOTSTRAP_CONFIRMATION,
    });

    expect(result.refused).toHaveLength(0);

    const row = await classificationOf(organizationId);
    expect(row.data_classification).toBe('test');
    expect(row.classification_reason).toMatch(/Seeded during development/);

    const entry = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'organization.classification_bootstrapped')
      .where('target_id', '=', organizationId)
      .executeTakeFirstOrThrow();

    expect(entry.actor_user_id).toBe(admin.userId);
    const metadata = entry.metadata as Record<string, unknown>;
    expect(metadata.previousClassification).toBe('production');
    expect(metadata.newClassification).toBe('test');
    expect(metadata.operationId).toBe(result.operationId);

    // The reclassified tenant is now genuinely disposable.
    const report = await assessSubscriberDeletion(ctx.db, organizationId);
    expect(report.disposable).toBe(true);
    expect(report.deletionPermitted).toBe(true);
  });

  it('refuses to launder a legally-held organization, and changes nothing at all', async () => {
    configureBootstrap({ isProduction: false, allowed: true });
    const held = await anOrganization('Held Ltd');
    const ordinary = await anOrganization('Ordinary Ltd');

    await ctx.db.updateTable('organizations').set({ legal_hold: true }).where('id', '=', held).execute();

    const result = await applyLegacyClassification(ctx.db, {
      organizationIds: [held, ordinary],
      targetClassification: 'test',
      actorUserId: null,
      reason: 'Attempting to clear development leftovers.',
      confirmation: BOOTSTRAP_CONFIRMATION,
    });

    expect(result.reclassified).toHaveLength(0);
    expect(result.refused.map((r) => r.organizationId)).toContain(held);

    /*
     * All-or-nothing: the unblocked organization in the same batch is untouched
     * too, so the operator is never left guessing which half applied.
     */
    expect((await classificationOf(held)).data_classification).toBe('production');
    expect((await classificationOf(ordinary)).data_classification).toBe('production');
  });

  it('cannot be used to promote data to production', async () => {
    configureBootstrap({ isProduction: false, allowed: true });
    const organizationId = await anOrganization('Promote Ltd');

    await expect(
      previewLegacyClassification(ctx.db, {
        organizationIds: [organizationId],
        targetClassification: 'production',
      }),
    ).rejects.toMatchObject({ code: 'wrong_direction' });
  });
});

describe('the bootstrap flag cannot be armed in production', () => {
  /**
   * The service refuses production on its own, but the flag must also be
   * unable to EXIST there. A deployment that boots with it set is already a
   * mistake, and failing at startup makes that mistake loud instead of latent.
   */
  const productionEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://user:pw@localhost:5432/ledgora',
    SESSION_SECRET: 'a'.repeat(48),
    APP_ORIGIN: 'https://app.ledgora.test',
  } as unknown as NodeJS.ProcessEnv;

  it('refuses to start when the flag is set in production', () => {
    expect(() =>
      loadConfig({ ...productionEnv, ALLOW_LEGACY_DATA_CLASSIFICATION: 'true' }),
    ).toThrow(/cannot be enabled in production/i);
  });

  it('starts normally when the flag is absent', () => {
    const config = loadConfig(productionEnv);
    expect(config.ALLOW_LEGACY_DATA_CLASSIFICATION).toBe(false);
  });
});

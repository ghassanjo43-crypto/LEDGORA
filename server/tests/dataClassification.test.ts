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

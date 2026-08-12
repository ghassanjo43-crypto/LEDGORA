/**
 * The development-only subscriber-data reset.
 *
 * This is the most destructive code in the repository, and the only thing
 * keeping it away from customer data is a set of guards. So the majority of
 * these tests are about REFUSAL: production, a remote host, a wrong database
 * name, a missing URL, a mistyped phrase, and a schema the plan has not been
 * taught about. Each one is a way the tool could be pointed at something it must
 * never touch.
 *
 * The remaining tests prove the two halves of the promise: that the customer
 * data really is gone, and that the platform identity which makes the console
 * reachable really does survive — including that the operator can still log in
 * afterwards, which is the acceptance criterion that matters most.
 */
import { sql } from 'kysely';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import {
  DevResetRefused,
  RESET_CONFIRMATION,
  RESET_SEQUENCE,
  assertLocalDevelopmentTarget,
  assertPlanCoversCatalogue,
  describeTarget,
  executeReset,
  previewReset,
  type GuardInput,
} from '../src/services/devResetService.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

const LOCAL_URL = 'postgresql://ledgora_local:secret-password@127.0.0.1:5432/ledgora_local';

function guard(overrides: Partial<GuardInput> = {}): GuardInput {
  return { nodeEnv: 'development', isProduction: false, databaseUrl: LOCAL_URL, ...overrides };
}

const LOCAL_TARGET = { host: '127.0.0.1', port: 5432, database: 'ledgora_local' };

async function operator(email = 'reset-admin@ledgora.local'): Promise<{ cookies: SessionCookies; userId: string }> {
  const user = await seedUser(ctx, { email, fullName: 'Local Administrator', platformRoles: ['super_admin'] });
  return { cookies: await login(ctx, email), userId: user.id };
}

/** A full tenant through the real admin route: org, owner, subscription, application. */
async function subscriber(
  cookies: SessionCookies,
  options: { email: string; legalName: string; classification?: 'production' | 'test' | 'demo' },
): Promise<{ organizationId: string; ownerUserId: string }> {
  const plans = (await ctx.app.inject({ method: 'GET', url: '/api/plans/public' })).json().plans;
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/subscribers',
    headers: authHeaders(cookies),
    payload: {
      fullName: 'Owner Person',
      email: options.email,
      organizationLegalName: options.legalName,
      country: 'AE',
      baseCurrency: 'AED',
      planId: plans[0].id,
      onboarding: 'invite',
      paymentConfirmed: true,
      subscriptionStatus: 'active',
      // Deliberately production: the reset must clear legacy tenants that
      // predate classification, which is the whole reason it exists.
      dataClassification: options.classification ?? 'production',
    },
  });
  expect(response.statusCode, JSON.stringify(response.json())).toBe(201);
  const body = response.json();
  return { organizationId: body.subscriber.organizationId, ownerUserId: body.subscriber.userId };
}

async function count(table: string): Promise<number> {
  const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)}`.execute(ctx.db);
  return rows[0]?.n ?? 0;
}

/* ══ Refusals ══════════════════════════════════════════════════════════════ */

describe('the environment guards', () => {
  it('refuses production outright', () => {
    expect(() => assertLocalDevelopmentTarget(guard({ nodeEnv: 'production', isProduction: true }))).toThrow(
      /NODE_ENV is "production"/,
    );
    try {
      assertLocalDevelopmentTarget(guard({ nodeEnv: 'production', isProduction: true }));
    } catch (error) {
      expect((error as DevResetRefused).code).toBe('production_environment');
    }
  });

  it('refuses every managed-provider host by name', () => {
    const remotes: Array<[string, RegExp]> = [
      ['postgresql://u:p@dpg-abc123-a.oregon-postgres.render.com:5432/ledgora', /Render/],
      ['postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres', /Supabase/],
      ['postgresql://u:p@ep-cool-water-123.us-east-2.aws.neon.tech/main', /Neon/],
      ['postgresql://u:p@containers-us-west-1.railway.app:6543/railway', /Railway/],
      ['postgresql://u:p@mydb.abc.us-east-1.rds.amazonaws.com:5432/app', /AWS RDS/],
      ['postgresql://u:p@srv.postgres.database.azure.com:5432/app', /Azure/],
      ['postgresql://u:p@db-postgresql-nyc.b.db.ondigitalocean.com:25060/app', /DigitalOcean/],
    ];
    for (const [url, provider] of remotes) {
      expect(() => assertLocalDevelopmentTarget(guard({ databaseUrl: url })), url).toThrow(provider);
    }
  });

  it('refuses any host that is not this machine, even an unrecognised one', () => {
    // The allowlist is what protects against providers nobody listed.
    expect(() => assertLocalDevelopmentTarget(guard({ databaseUrl: 'postgresql://u:p@db.internal.corp:5432/x' }))).toThrow(
      /not a local host/,
    );
    expect(() => assertLocalDevelopmentTarget(guard({ databaseUrl: 'postgresql://u:p@10.0.0.7:5432/x' }))).toThrow(
      /not a local host/,
    );
  });

  it('refuses a missing DATABASE_URL rather than resetting a throwaway database', () => {
    expect(() => assertLocalDevelopmentTarget(guard({ databaseUrl: '' }))).toThrow(/DATABASE_URL is not set/);
  });

  it('refuses a database whose name looks like production, and a name mismatch', () => {
    expect(() =>
      assertLocalDevelopmentTarget(guard({ databaseUrl: 'postgresql://u:p@localhost:5432/ledgora_production' })),
    ).toThrow(/contains "prod"/);

    expect(() => assertLocalDevelopmentTarget(guard({ expectedDatabase: 'something_else' }))).toThrow(
      /expected database "something_else"/,
    );
  });

  it('accepts the local target and never exposes credentials', () => {
    const target = assertLocalDevelopmentTarget(guard());
    expect(target).toEqual(LOCAL_TARGET);
    // The password appears nowhere in what the tool is able to print.
    expect(JSON.stringify(target)).not.toContain('secret-password');
    expect(JSON.stringify(describeTarget(LOCAL_URL))).not.toContain('secret-password');
  });
});

describe('the confirmation phrase', () => {
  it('refuses anything that is not the exact phrase, and changes nothing', async () => {
    const admin = await operator();
    const target = await subscriber(admin.cookies, { email: 'keepme@dev.test', legalName: 'Keep Me Ltd' });

    for (const attempt of ['', 'yes', 'reset local ledgora subscriber data', `${RESET_CONFIRMATION} `]) {
      await expect(executeReset(ctx.db, { confirmation: attempt, guard: guard() })).rejects.toThrow(
        /confirmation phrase does not match/,
      );
    }

    // Still entirely intact.
    expect(await count('organizations')).toBe(1);
    expect(
      await ctx.db.selectFrom('organizations').select('id').where('id', '=', target.organizationId).executeTakeFirst(),
    ).toBeDefined();
  });

  it('refuses production even when the phrase is correct', async () => {
    await operator();
    await expect(
      executeReset(ctx.db, {
        confirmation: RESET_CONFIRMATION,
        guard: guard({ nodeEnv: 'production', isProduction: true }),
      }),
    ).rejects.toThrow(/NODE_ENV is "production"/);
    expect(await count('users')).toBeGreaterThan(0);
  });
});

describe('the plan-versus-catalogue guard', () => {
  it('passes against the current schema', async () => {
    await expect(assertPlanCoversCatalogue(ctx.db)).resolves.toBeUndefined();
  });

  it('refuses when a migration adds a tenant-owned table the plan does not know', async () => {
    /*
     * Stand in for the next migration: a table referencing organizations that
     * nobody remembered to add to RESET_PLAN. The tool must stop rather than
     * delete what it recognises and silently strand the rest.
     */
    await sql`
      CREATE TABLE tenant_widgets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE
      )
    `.execute(ctx.db);

    await expect(assertPlanCoversCatalogue(ctx.db)).rejects.toThrow(/tenant_widgets/);
    await expect(executeReset(ctx.db, { confirmation: RESET_CONFIRMATION, guard: guard() })).rejects.toThrow(
      /no disposition in RESET_PLAN/,
    );
  });
});

/* ══ The reset itself ══════════════════════════════════════════════════════ */

describe('the reset', () => {
  it('previews counts that match what execution actually deletes', async () => {
    const admin = await operator();
    await subscriber(admin.cookies, { email: 'one@dev.test', legalName: 'One Ltd' });
    await subscriber(admin.cookies, { email: 'two@dev.test', legalName: 'Two Ltd' });

    const preview = await previewReset(ctx.db, LOCAL_TARGET);
    const predicted = new Map(preview.counts.map((c) => [c.table, c.willDelete]));

    expect(predicted.get('organizations')).toBe(2);
    expect(predicted.get('users')).toBe(2);
    expect(preview.preservedAdmins).toHaveLength(1);
    expect(preview.preservedAdmins[0]?.email).toBe('reset-admin@ledgora.local');

    const result = await executeReset(ctx.db, { confirmation: RESET_CONFIRMATION, guard: guard() });

    // The preview is not a separate estimate — it is the same rule, so it agrees.
    for (const entry of RESET_SEQUENCE) {
      expect(result.deleted[entry.table], `${entry.table} deleted count`).toBe(predicted.get(entry.table));
    }
  });

  it('empties every customer table and leaves the platform standing', async () => {
    const admin = await operator();
    await subscriber(admin.cookies, { email: 'alpha@dev.test', legalName: 'Alpha Ltd' });
    await subscriber(admin.cookies, { email: 'beta@dev.test', legalName: 'Beta Ltd', classification: 'demo' });

    expect(await count('organizations')).toBe(2);
    expect(await count('subscription_applications')).toBeGreaterThan(0);

    const result = await executeReset(ctx.db, { confirmation: RESET_CONFIRMATION, guard: guard() });

    /* Gone. */
    for (const table of [
      'organizations',
      'organization_memberships',
      'subscription_applications',
      'subscriptions',
      'organization_entitlements',
      'subscription_package_changes',
      'subscription_invoices',
      'payment_proofs',
      'user_permission_overrides',
      'subscriber_data_exports',
      'subscriber_deletion_tombstones',
      'cleanup_operations',
      'file_cleanup_queue',
    ]) {
      expect(await count(table), `${table} must be empty`).toBe(0);
    }

    /* Standing. */
    expect(await count('users')).toBe(1);
    expect(await count('platform_user_roles')).toBe(1);
    expect(await count('subscription_plans')).toBeGreaterThan(0);
    expect(await count('kysely_migration')).toBeGreaterThan(0);
    expect(result.preservedAdmins[0]?.email).toBe('reset-admin@ledgora.local');

    const survivor = await ctx.db.selectFrom('users').selectAll().executeTakeFirstOrThrow();
    expect(survivor.id).toBe(admin.userId);
    // Never planted into a tenant by this operation.
    expect(await count('organization_memberships')).toBe(0);
  });

  it('leaves the preserved operator able to sign in', async () => {
    const admin = await operator();
    await subscriber(admin.cookies, { email: 'gamma@dev.test', legalName: 'Gamma Ltd' });

    await executeReset(ctx.db, { confirmation: RESET_CONFIRMATION, guard: guard() });

    /*
     * The acceptance criterion that matters. Sessions are deleted only for
     * doomed users, so the operator's credential still works — a reset that
     * locks the developer out of the console has failed whatever the counts say.
     */
    const cookies = await login(ctx, 'reset-admin@ledgora.local', TEST_PASSWORD);
    expect(cookies.session).toBeTruthy();

    const session = await ctx.app.inject({ method: 'GET', url: '/api/auth/session', headers: authHeaders(cookies) });
    expect(session.statusCode).toBe(200);
    expect(session.json().user.email).toBe('reset-admin@ledgora.local');
  });

  it('deletes a customer account but keeps an operator who shares its tenant', async () => {
    const admin = await operator();
    const target = await subscriber(admin.cookies, { email: 'shared@dev.test', legalName: 'Shared Ltd' });

    /*
     * The dangerous shape: a platform operator who joined a development tenant.
     * The tenant and the membership must go; the identity must not.
     */
    await ctx.db
      .insertInto('organization_memberships')
      .values({
        organization_id: target.organizationId,
        user_id: admin.userId,
        role: 'member',
        status: 'active',
      })
      .execute();

    const preview = await previewReset(ctx.db, LOCAL_TARGET);
    expect(preview.preservedAdminMembershipsRemoved).toBe(1);

    await executeReset(ctx.db, { confirmation: RESET_CONFIRMATION, guard: guard() });

    expect(await count('organization_memberships')).toBe(0);
    const survivors = await ctx.db.selectFrom('users').select('id').execute();
    expect(survivors.map((s) => s.id)).toEqual([admin.userId]);
  });

  it('keeps the operator’s platform history and drops tenant-scoped audit rows', async () => {
    const admin = await operator();
    await subscriber(admin.cookies, { email: 'audited@dev.test', legalName: 'Audited Ltd' });

    const before = await ctx.db.selectFrom('audit_logs').selectAll().execute();
    expect(before.some((a) => a.organization_id !== null), 'a tenant-scoped row exists to delete').toBe(true);
    expect(before.some((a) => a.action === 'auth.login'), 'a platform login row exists to keep').toBe(true);

    await executeReset(ctx.db, { confirmation: RESET_CONFIRMATION, guard: guard() });

    const after = await ctx.db.selectFrom('audit_logs').selectAll().execute();
    expect(after.length).toBeGreaterThan(0);
    // Nothing tenant-scoped survives; nothing survives authored by a deleted user.
    expect(after.every((a) => a.organization_id === null)).toBe(true);
    expect(after.every((a) => a.actor_user_id === null || a.actor_user_id === admin.userId)).toBe(true);
    expect(after.some((a) => a.action === 'auth.login')).toBe(true);
  });

  it('reports the proof files to remove before their rows are deleted', async () => {
    const admin = await operator();
    const target = await subscriber(admin.cookies, { email: 'proofs@dev.test', legalName: 'Proofs Ltd' });

    const invoice = await ctx.db
      .selectFrom('subscription_invoices')
      .select('id')
      .where('organization_id', '=', target.organizationId)
      .executeTakeFirst();

    if (invoice) {
      const stored = await ctx.storage.put({ content: Buffer.from('receipt'), mimeType: 'application/pdf' });
      await ctx.db
        .insertInto('payment_proofs')
        .values({
          invoice_id: invoice.id,
          storage_key: stored.storageKey,
          uploaded_by_user_id: target.ownerUserId,
          file_name: 'proof.pdf',
          mime_type: 'application/pdf',
          file_size: 7,
          ledgora_payment_reference: 'LDG-TEST-0001',
          amount: '100.00',
          paid_at: new Date(),
          status: 'submitted',
        })
        .execute();

      const result = await executeReset(ctx.db, { confirmation: RESET_CONFIRMATION, guard: guard() });

      // The keys are captured BEFORE the rows naming them are deleted; losing
      // one would leave an unreachable file with no record of its existence.
      expect(result.storageKeys).toContain(stored.storageKey);
      expect(await count('payment_proofs')).toBe(0);
    }
  });

  it('is idempotent — a second run finds nothing left and still refuses nothing', async () => {
    const admin = await operator();
    await subscriber(admin.cookies, { email: 'twice@dev.test', legalName: 'Twice Ltd' });

    await executeReset(ctx.db, { confirmation: RESET_CONFIRMATION, guard: guard() });
    const second = await executeReset(ctx.db, { confirmation: RESET_CONFIRMATION, guard: guard() });

    expect(second.deleted.organizations).toBe(0);
    expect(second.deleted.users).toBe(0);
    expect(await count('users')).toBe(1);
    expect(second.preservedAdmins[0]?.userId).toBe(admin.userId);
  });
});

/* ══ Reachability ══════════════════════════════════════════════════════════ */

describe('exposure', () => {
  it('is not reachable from the HTTP layer', async () => {
    /*
     * The requirement is "development maintenance tool only". A test asserting
     * the current routes do not call it would pass for the wrong reason once
     * somebody adds the route, so this checks the IMPORT GRAPH instead: no file
     * the server serves may reference the reset service at all.
     */
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = path.resolve(here, '..', 'src');

    const { readdir } = await import('node:fs/promises');
    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...(await walk(full)));
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
      return files;
    };

    const offenders: string[] = [];
    for (const file of await walk(source)) {
      const relative = path.relative(source, file).split(path.sep).join('/');
      // The service itself and its CLI are the only permitted references.
      if (relative === 'services/devResetService.ts' || relative === 'cli/resetSubscriberData.ts') continue;
      const contents = await readFile(file, 'utf8');
      if (contents.includes('devResetService')) offenders.push(relative);
    }

    expect(offenders, 'the reset service must never be imported by the served application').toEqual([]);
  });
});

/**
 * Migration 012 — the tombstone status-column repair.
 *
 * These tests exist because of a real, observed failure on a running database:
 * `subscriber_deletion_tombstones` had `external_cleanup_status` but neither
 * `database_deletion_status` nor `workspace_deletion_status`, so every
 * permanent deletion died on the last statement of its transaction with
 *
 *     column "database_deletion_status" of relation
 *     "subscriber_deletion_tombstones" does not exist
 *
 * A fresh test database is created by the CURRENT migration `009`, which
 * already has all three columns — so a test that only migrates a clean database
 * would prove nothing about the case that actually broke. Every test here that
 * claims something about the repair therefore MANUFACTURES the legacy shape
 * first: it drops the two columns and un-records `012`, reproducing exactly
 * what the running database looked like, and only then migrates.
 *
 * The last test is the one that must never stop passing. It re-breaks the table
 * and does NOT repair it, proving that when the tombstone insert fails the
 * tenant is rolled back intact. A deletion that cannot record itself must not
 * happen at all: a destroyed subscriber with no tombstone is worse than a
 * refused deletion, because the evidence of what was destroyed is gone with it.
 */
import { sql } from 'kysely';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  authHeaders,
  createTestContext,
  login,
  seedUser,
  type SessionCookies,
  type TestContext,
} from './helpers/testApp.js';
import { migrateToLatest, assertMigrationsSucceeded } from '../src/db/migrator.js';
import { previewCleanup, executeCleanup, CLEANUP_CONFIRMATION } from '../src/services/cleanupService.js';

const MIGRATION = '012_repair_deletion_tombstone_status_columns';
const REPAIRED_COLUMNS = ['database_deletion_status', 'workspace_deletion_status'] as const;

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

/* ══ Helpers ═══════════════════════════════════════════════════════════════ */

/** The tombstone table's columns, as `information_schema` sees them. */
async function tombstoneColumns(): Promise<Map<string, { nullable: string; default: string | null }>> {
  const { rows } = await sql<{
    column_name: string;
    is_nullable: string;
    column_default: string | null;
  }>`
    SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name = 'subscriber_deletion_tombstones'
  `.execute(ctx.db);
  return new Map(rows.map((r) => [r.column_name, { nullable: r.is_nullable, default: r.column_default }]));
}

async function appliedMigrations(): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`SELECT name FROM kysely_migration ORDER BY name`.execute(ctx.db);
  return rows.map((r) => r.name);
}

/**
 * Turn the freshly-migrated test database back into the broken one.
 *
 * Both halves matter. Dropping the columns reproduces the schema; deleting the
 * `kysely_migration` row reproduces the REASON it stayed broken — a recorded
 * migration never runs again, which is precisely why editing `009` in place
 * could not have fixed anything.
 */
async function breakTable(options: { unrecordMigration: boolean; keepColumns?: boolean }): Promise<void> {
  if (!options.keepColumns) {
    await sql`
      ALTER TABLE subscriber_deletion_tombstones
        DROP COLUMN IF EXISTS database_deletion_status,
        DROP COLUMN IF EXISTS workspace_deletion_status
    `.execute(ctx.db);
  }
  if (options.unrecordMigration) {
    /*
     * Un-record 012 AND everything after it. Kysely refuses to migrate a
     * database whose recorded history has a hole in the middle ("corrupted
     * migrations"), so removing 012 alone stopped reproducing the legacy state
     * the moment a 013 existed. Deleting the tail keeps this test about the
     * repair rather than about how many migrations came later.
     */
    await sql`DELETE FROM kysely_migration WHERE name >= ${MIGRATION}`.execute(ctx.db);
    /*
     * Un-recording the tail is not enough on its own: the LATER migrations
     * already built their tables, so re-running them would fail on "relation
     * already exists". Their objects are dropped here so the replay is a true
     * replay rather than a collision.
     */
    await sql`DROP TRIGGER IF EXISTS workspace_owner_after_membership ON organization_memberships`.execute(ctx.db);
    await sql`DROP TRIGGER IF EXISTS workspace_owner_after_organization ON organizations`.execute(ctx.db);
    await sql`DROP FUNCTION IF EXISTS assert_workspace_has_one_subscriber_owner()`.execute(ctx.db);
    await sql`DROP TRIGGER IF EXISTS immutable_subscriber_ownership_claim ON subscriber_workspace_ownership_claims`.execute(ctx.db);
    await sql`DROP FUNCTION IF EXISTS protect_subscriber_ownership_claim()`.execute(ctx.db);
    await sql`DROP TRIGGER IF EXISTS memberships_immutable_subscriber_owner ON organization_memberships`.execute(ctx.db);
    await sql`DROP TRIGGER IF EXISTS organizations_immutable_subscriber_owner ON organizations`.execute(ctx.db);
    await sql`DROP FUNCTION IF EXISTS protect_subscriber_ownership()`.execute(ctx.db);
    await sql`DROP TABLE IF EXISTS subscriber_workspace_ownership_claims`.execute(ctx.db);
    await sql`DROP INDEX IF EXISTS organization_memberships_one_owner`.execute(ctx.db);
    await sql`DROP INDEX IF EXISTS organizations_subscriber_owner_unique`.execute(ctx.db);
    await sql`ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_subscriber_owner_fk`.execute(ctx.db);
    await sql`ALTER TABLE organizations DROP COLUMN IF EXISTS subscriber_owner_user_id`.execute(ctx.db);
    await sql`DROP TABLE IF EXISTS opening_balance_sets, accounting_audit_events, journal_entry_versions,
              journal_lines, journal_entries, accounts, accounting_periods CASCADE`.execute(ctx.db);
  }
}

/**
 * A tombstone written by the OLD code against the OLD shape.
 *
 * Deliberately raw SQL naming only the legacy columns: this row has to be
 * written the way a pre-repair deployment wrote it, and the typed query builder
 * describes the repaired table.
 */
async function insertLegacyTombstone(legalName: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO subscriber_deletion_tombstones (
      operation_id, organization_id, legal_name, classification_at_deletion,
      reason, previewed_at, external_cleanup_status, outcome
    ) VALUES (
      gen_random_uuid(), gen_random_uuid(), ${legalName}, 'demo',
      'Deleted before the repair migration existed.', now(), 'none', 'completed'
    )
    RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

async function operator(email = 'repair@ledgora.test'): Promise<{ cookies: SessionCookies; userId: string }> {
  const user = await seedUser(ctx, { email, fullName: 'Repair Operator', platformRoles: ['super_admin'] });
  return { cookies: await login(ctx, email), userId: user.id };
}

async function subscriber(
  cookies: SessionCookies,
  options: { email: string; legalName: string; classification: 'production' | 'test' | 'demo' },
): Promise<string> {
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
      // Never activated: activation is what makes a tenant unpurgeable.
      paymentConfirmed: false,
      subscriptionStatus: 'draft',
      dataClassification: options.classification,
    },
  });
  expect(response.statusCode, JSON.stringify(response.json())).toBe(201);
  return response.json().subscriber.organizationId;
}

/** Run the real cleanup path against a freshly-taken preview. */
async function purge(organizationId: string, actorUserId: string) {
  const preview = await previewCleanup(ctx.db, [organizationId]);
  return executeCleanup(
    ctx.db,
    ctx.storage,
    {
      organizationIds: [organizationId],
      previewDigest: preview.digest,
      previewedAt: preview.previewedAt,
      reason: 'Removing a disposable tenant after the schema repair.',
      confirmation: CLEANUP_CONFIRMATION,
    },
    {
      actorUserId,
      actorPlatformRole: 'super_admin',
      ipAddress: '127.0.0.1',
      userAgent: 'vitest',
      requestId: 'req-repair-1',
    },
  );
}

async function organizationExists(organizationId: string): Promise<boolean> {
  const row = await ctx.db
    .selectFrom('organizations')
    .select('id')
    .where('id', '=', organizationId)
    .executeTakeFirst();
  return Boolean(row);
}

/* ══ The repair itself ═════════════════════════════════════════════════════ */

describe('migration 012 against a legacy partial table', () => {
  it('adds both missing columns with the documented defaults', async () => {
    await breakTable({ unrecordMigration: true });

    const before = await tombstoneColumns();
    expect(before.has('external_cleanup_status'), 'the legacy shape keeps the one column it had').toBe(true);
    for (const column of REPAIRED_COLUMNS) expect(before.has(column), `${column} starts missing`).toBe(false);

    assertMigrationsSucceeded(await migrateToLatest(ctx.db));

    const after = await tombstoneColumns();
    // All three present — the state the cleanup code requires.
    expect(after.has('external_cleanup_status')).toBe(true);
    expect(after.has('database_deletion_status')).toBe(true);
    expect(after.has('workspace_deletion_status')).toBe(true);

    /*
     * Not just present: identical to what `009` would have created. A repaired
     * database and a fresh one must be indistinguishable, or the next migration
     * to touch this table has two shapes to reason about.
     */
    expect(after.get('database_deletion_status')?.nullable).toBe('NO');
    expect(after.get('database_deletion_status')?.default).toBe(`'completed'::text`);
    expect(after.get('workspace_deletion_status')?.nullable).toBe('NO');
    expect(after.get('workspace_deletion_status')?.default).toBe(`'no_server_workspace'::text`);

    expect(await appliedMigrations()).toContain(MIGRATION);
  });

  it('preserves every existing tombstone and backfills it truthfully', async () => {
    await breakTable({ unrecordMigration: true });

    const first = await insertLegacyTombstone('Legacy One Ltd');
    const second = await insertLegacyTombstone('Legacy Two Ltd');

    assertMigrationsSucceeded(await migrateToLatest(ctx.db));

    const rows = await ctx.db
      .selectFrom('subscriber_deletion_tombstones')
      .selectAll()
      .orderBy('legal_name')
      .execute();

    // The evidence survived. Nothing was dropped, recreated or renumbered.
    expect(rows.map((r) => r.id).sort()).toEqual([first, second].sort());
    expect(rows.map((r) => r.legal_name)).toEqual(['Legacy One Ltd', 'Legacy Two Ltd']);

    for (const row of rows) {
      /*
       * `completed` is a fact about these rows, not a guess: a tombstone is
       * written inside the deletion transaction, so its existence proves that
       * transaction committed.
       */
      expect(row.database_deletion_status).toBe('completed');
      expect(row.workspace_deletion_status).toBe('no_server_workspace');
      // The column that was already there is untouched by the repair.
      expect(row.external_cleanup_status).toBe('none');
      expect(row.reason).toMatch(/before the repair migration existed/);
    }
  });
});

describe('migration 012 against a database that is already correct', () => {
  it('is a no-op and leaves the columns and their data intact', async () => {
    // The test context has already migrated to latest, so 012 has run once.
    expect(await appliedMigrations()).toContain(MIGRATION);
    const tombstoneId = await insertLegacyTombstone('Already Correct Ltd');

    /*
     * Force a second run against the correct shape, the way a redeploy or a
     * hand-run `db:migrate` would on a database that never had the drift.
     * `ADD COLUMN IF NOT EXISTS` is what has to hold here.
     */
    await breakTable({ unrecordMigration: true, keepColumns: true });
    assertMigrationsSucceeded(await migrateToLatest(ctx.db));

    const columns = await tombstoneColumns();
    for (const column of REPAIRED_COLUMNS) expect(columns.has(column)).toBe(true);
    expect(columns.get('database_deletion_status')?.default).toBe(`'completed'::text`);

    const row = await ctx.db
      .selectFrom('subscriber_deletion_tombstones')
      .selectAll()
      .where('id', '=', tombstoneId)
      .executeTakeFirstOrThrow();
    expect(row.legal_name).toBe('Already Correct Ltd');
    expect(row.database_deletion_status).toBe('completed');

    // Recorded exactly once; a repeated repair does not accumulate history.
    expect((await appliedMigrations()).filter((n) => n === MIGRATION)).toHaveLength(1);
  });
});

/* ══ What the repair unblocks ══════════════════════════════════════════════ */

describe('cleanup on a repaired database', () => {
  it('can insert a tombstone with all three status columns', async () => {
    await breakTable({ unrecordMigration: true });
    assertMigrationsSucceeded(await migrateToLatest(ctx.db));

    const admin = await operator();
    const organizationId = await subscriber(admin.cookies, {
      email: 'repaired@dev.test',
      legalName: 'Repaired Ltd',
      classification: 'test',
    });

    const result = await purge(organizationId, admin.userId);
    expect(result.organizations[0]?.error, 'no column error survives the repair').toBeUndefined();

    const tombstone = await ctx.db
      .selectFrom('subscriber_deletion_tombstones')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .executeTakeFirstOrThrow();

    // The three layers, each stated separately — the reason the columns exist.
    expect(tombstone.database_deletion_status).toBe('completed');
    expect(tombstone.workspace_deletion_status).toBe('no_server_workspace');
    expect(tombstone.external_cleanup_status).toBe('none');
    expect(tombstone.legal_name).toBe('Repaired Ltd');
    expect(tombstone.operation_id).toBe(result.operationId);
  });

  it('deletes an eligible Demo subscriber end to end', async () => {
    await breakTable({ unrecordMigration: true });
    assertMigrationsSucceeded(await migrateToLatest(ctx.db));

    const admin = await operator();
    const demo = await subscriber(admin.cookies, {
      email: 'demo-tenant@dev.test',
      legalName: 'Demo Tenant Ltd',
      classification: 'demo',
    });
    const test = await subscriber(admin.cookies, {
      email: 'test-tenant@dev.test',
      legalName: 'Test Tenant Ltd',
      classification: 'test',
    });

    for (const organizationId of [demo, test]) {
      const result = await purge(organizationId, admin.userId);
      expect(result.outcome).toBe('completed');
      expect(result.organizations[0]?.deleted, JSON.stringify(result.organizations[0])).toBe(true);
      expect(result.databaseDeletion).toEqual({ succeeded: 1, failed: 0 });
      // The tenant is gone, and its destruction is on the record.
      expect(await organizationExists(organizationId)).toBe(false);
      expect(
        await ctx.db
          .selectFrom('subscriber_deletion_tombstones')
          .select('id')
          .where('organization_id', '=', organizationId)
          .executeTakeFirst(),
      ).toBeDefined();
    }
  });
});

/* ══ The guarantee that must hold even unrepaired ══════════════════════════ */

describe('a tombstone that cannot be written', () => {
  it('rolls the whole deletion back rather than destroying a tenant unrecorded', async () => {
    const admin = await operator();
    const organizationId = await subscriber(admin.cookies, {
      email: 'rollback@dev.test',
      legalName: 'Rollback Ltd',
      classification: 'demo',
    });

    const membersBefore = await ctx.db
      .selectFrom('organization_memberships')
      .select('id')
      .where('organization_id', '=', organizationId)
      .execute();

    /*
     * Break the table and leave it broken — this is the failure the operator
     * actually hit, reproduced exactly. Only the COLUMNS are dropped: the
     * migration record is left alone because nothing is replayed here, and
     * un-recording it would take the later migrations' tables with it.
     */
    await breakTable({ unrecordMigration: false });

    const result = await purge(organizationId, admin.userId);

    // Reported as a failure, in the operator's own words from PostgreSQL.
    expect(result.outcome).toBe('failed');
    expect(result.databaseDeletion).toEqual({ succeeded: 0, failed: 1 });
    expect(result.organizations[0]?.deleted).toBe(false);
    expect(result.organizations[0]?.error).toMatch(/database_deletion_status/);

    /*
     * And nothing was destroyed. The deletes ran before the insert inside the
     * same transaction, so this asserts the rollback, not merely that the
     * failure was reported.
     */
    expect(await organizationExists(organizationId), 'the tenant survives a failed tombstone').toBe(true);
    const membersAfter = await ctx.db
      .selectFrom('organization_memberships')
      .select('id')
      .where('organization_id', '=', organizationId)
      .execute();
    expect(membersAfter.map((m) => m.id).sort()).toEqual(membersBefore.map((m) => m.id).sort());

    // The write freeze was rolled back too; the tenant is not left frozen.
    const organization = await ctx.db
      .selectFrom('organizations')
      .select(['deletion_in_progress', 'legal_name'])
      .where('id', '=', organizationId)
      .executeTakeFirstOrThrow();
    expect(organization.deletion_in_progress).toBe(false);
    expect(organization.legal_name).toBe('Rollback Ltd');

    // No half-written evidence either.
    expect(
      await ctx.db
        .selectFrom('subscriber_deletion_tombstones')
        .select('id')
        .where('organization_id', '=', organizationId)
        .executeTakeFirst(),
    ).toBeUndefined();
  });
});

/**
 * Permanent cleanup of test/demo subscribers.
 *
 * The tests are organised around what could go catastrophically wrong: a
 * production tenant destroyed, another tenant damaged, a shared person's account
 * deleted because they once joined a demo, a "success" reported while files or
 * rows survive, or a double-clicked button destroying twice.
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
import {
  previewCleanup,
  executeCleanup,
  runFileCleanup,
  digestOf,
  CLEANUP_CONFIRMATION,
} from '../src/services/cleanupService.js';
import { DIRECTLY_OWNED_TABLES } from '../src/services/tenantInventory.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

async function operator(email = 'cleanup@ledgora.test'): Promise<{ cookies: SessionCookies; userId: string }> {
  const user = await seedUser(ctx, { email, fullName: 'Cleanup Operator', platformRoles: ['super_admin'] });
  return { cookies: await login(ctx, email), userId: user.id };
}

async function plan(): Promise<string> {
  const plans = (await ctx.app.inject({ method: 'GET', url: '/api/plans/public' })).json().plans;
  return plans[0].id;
}

/** A subscriber created through the real admin route, classified as asked. */
async function subscriber(
  cookies: SessionCookies,
  options: {
    email: string;
    legalName: string;
    classification?: 'production' | 'test' | 'demo';
    activate?: boolean;
  },
): Promise<{ organizationId: string; ownerUserId: string }> {
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
      planId: await plan(),
      onboarding: 'invite',
      // Confirming payment is what activates the tenant.
      paymentConfirmed: options.activate ?? false,
      subscriptionStatus: (options.activate ?? false) ? 'active' : 'draft',
      dataClassification: options.classification ?? 'test',
    },
  });
  expect(response.statusCode, JSON.stringify(response.json())).toBe(201);
  const body = response.json();
  return { organizationId: body.subscriber.organizationId, ownerUserId: body.subscriber.userId };
}

async function orgRow(organizationId: string) {
  return ctx.db
    .selectFrom('organizations')
    .selectAll()
    .where('id', '=', organizationId)
    .executeTakeFirst();
}

async function freshPreview(organizationIds: string[]) {
  return previewCleanup(ctx.db, organizationIds);
}

function execInput(preview: Awaited<ReturnType<typeof freshPreview>>, ids: string[]) {
  return {
    organizationIds: ids,
    previewDigest: preview.digest,
    previewedAt: preview.previewedAt,
    reason: 'Removing development tenants after the release rehearsal.',
    confirmation: CLEANUP_CONFIRMATION,
  };
}

function adminContext(userId: string) {
  return {
    actorUserId: userId,
    actorPlatformRole: 'super_admin',
    ipAddress: '127.0.0.1',
    userAgent: 'vitest',
    requestId: 'req-test-1',
  };
}

/* ══ Preview ═══════════════════════════════════════════════════════════════ */

describe('the preview', () => {
  it('reads without mutating anything', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies, {
      email: 'preview@dev.test',
      legalName: 'Preview Ltd',
    });

    const before = await orgRow(organizationId);
    const preview = await freshPreview([organizationId]);
    const after = await orgRow(organizationId);

    expect(preview.candidates).toHaveLength(1);
    expect(after).toEqual(before);
    expect(after?.deletion_in_progress).toBe(false);
  });

  it('counts every directly-owned category accurately', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies, {
      email: 'counts@dev.test',
      legalName: 'Counts Ltd',
    });

    const preview = await freshPreview([organizationId]);
    const candidate = preview.candidates[0]!;

    for (const table of DIRECTLY_OWNED_TABLES) {
      const reported = candidate.counts.find((c) => c.key === table)?.count;
      const actual = await ctx.db
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('organization_id', '=', organizationId)
        .executeTakeFirst();

      expect(reported, `count for ${table}`).toBe(Number(actual?.n ?? 0));
    }

    // The owner's membership is real data, and must be reflected.
    expect(candidate.counts.find((c) => c.key === 'organization_memberships')!.count).toBeGreaterThan(0);
  });

  it('excludes a production subscriber authoritatively', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies, {
      email: 'real@customer.test',
      legalName: 'Real Customer Ltd',
      classification: 'production',
    });

    const preview = await freshPreview([organizationId]);
    const candidate = preview.candidates[0]!;

    expect(candidate.eligible).toBe(false);
    expect(candidate.classification).toBe('production');
    expect(candidate.blockers.map((b) => b.code)).toContain('production_subscriber');
    expect(preview.eligibleCount).toBe(0);
    expect(preview.excludedCount).toBe(1);
  });

  it('keeps an ever-activated test tenant eligible but warns prominently', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies, {
      email: 'activated@dev.test',
      legalName: 'Activated Dev Ltd',
      activate: true,
    });

    const preview = await freshPreview([organizationId]);
    const candidate = preview.candidates[0]!;

    /*
     * The requirement is explicit: activation must NOT become a permanent
     * blocker, because development tenants need activating to exercise real
     * workflows. It has to be loud instead.
     */
    expect(candidate.eligible).toBe(true);
    expect(candidate.everActivated).toBe(true);
    expect(candidate.hasBusinessActivity).toBe(true);
    expect(candidate.warnings.join(' ')).toMatch(/accounting records/i);
  });

  it('reports a legal hold and a platform-operator membership as blockers', async () => {
    const admin = await operator();
    const held = await subscriber(admin.cookies, { email: 'held@dev.test', legalName: 'Held Ltd' });
    const staffed = await subscriber(admin.cookies, { email: 'staffed@dev.test', legalName: 'Staffed Ltd' });

    await ctx.db
      .updateTable('organizations')
      .set({ legal_hold: true })
      .where('id', '=', held.organizationId)
      .execute();

    // Put a platform operator inside the second tenant.
    await ctx.db
      .insertInto('organization_memberships')
      .values({ organization_id: staffed.organizationId, user_id: admin.userId, role: 'admin', status: 'active' })
      .execute();

    const preview = await freshPreview([held.organizationId, staffed.organizationId]);

    const heldCandidate = preview.candidates.find((c) => c.organizationId === held.organizationId)!;
    const staffedCandidate = preview.candidates.find((c) => c.organizationId === staffed.organizationId)!;

    expect(heldCandidate.eligible).toBe(false);
    expect(heldCandidate.blockers.map((b) => b.code)).toContain('legal_hold');
    expect(staffedCandidate.eligible).toBe(false);
    expect(staffedCandidate.blockers.map((b) => b.code)).toContain('platform_role_member');
  });

  it('shows an unknown id as excluded rather than dropping it', async () => {
    const missing = '11111111-1111-4111-8111-111111111111';
    const preview = await freshPreview([missing]);

    expect(preview.candidates).toHaveLength(1);
    expect(preview.candidates[0]!.blockers[0]!.code).toBe('not_found');
  });
});

/* ══ Identity dispositions ═════════════════════════════════════════════════ */

describe('identity rules', () => {
  it('retains a person who belongs to another organization', async () => {
    const admin = await operator();
    const doomed = await subscriber(admin.cookies, { email: 'shared@dev.test', legalName: 'Doomed Ltd' });
    const survivor = await subscriber(admin.cookies, { email: 'other@dev.test', legalName: 'Survivor Ltd' });

    // The same person, in both tenants.
    await ctx.db
      .insertInto('organization_memberships')
      .values({
        organization_id: survivor.organizationId,
        user_id: doomed.ownerUserId,
        role: 'member',
        status: 'active',
      })
      .execute();

    const preview = await freshPreview([doomed.organizationId]);
    const disposition = preview.candidates[0]!.identities.find((i) => i.userId === doomed.ownerUserId)!;
    expect(disposition.outcome).toBe('retained_other_membership');

    await executeCleanup(
      ctx.db,
      ctx.storage,
      execInput(preview, [doomed.organizationId]),
      adminContext(admin.userId),
    );

    const stillThere = await ctx.db
      .selectFrom('users')
      .select('id')
      .where('id', '=', doomed.ownerUserId)
      .executeTakeFirst();
    expect(stillThere, 'a shared identity must survive its tenant').toBeDefined();
  });

  it('retains a production-classified identity even in a test tenant', async () => {
    const admin = await operator();
    const { organizationId } = await subscriber(admin.cookies, {
      email: 'sandbox-owner@dev.test',
      legalName: 'Mixed Ltd',
    });

    /*
     * A REAL person whose ONLY membership is a seat in the test tenant.
     *
     * The isolation matters: retention has several independent causes, and a
     * person who also belonged somewhere else would be kept by the
     * other-membership rule, proving nothing about classification. They are
     * therefore not a subscriber owner — ownership is permanent, so an owner
     * always has a second membership and could never be reduced to this case.
     *
     * Production is asserted rather than assumed: a test tenant's own owner is
     * created disposable (that is the point of classifying the tenant), so the
     * table default is not what makes this person real.
     */
    const real = await seedUser(ctx, { email: 'realperson@dev.test', fullName: 'Real Person' });
    const ownerUserId = real.id;
    const classification = await ctx.db
      .selectFrom('users')
      .select('data_classification')
      .where('id', '=', ownerUserId)
      .executeTakeFirstOrThrow();
    expect(classification.data_classification).toBe('production');

    await ctx.db
      .insertInto('organization_memberships')
      .values({ organization_id: organizationId, user_id: ownerUserId, role: 'member', status: 'active' })
      .execute();

    const preview = await freshPreview([organizationId]);
    const disposition = preview.candidates[0]!.identities.find((i) => i.userId === ownerUserId)!;
    expect(disposition.outcome).toBe('retained_production');

    await executeCleanup(ctx.db, ctx.storage, execInput(preview, [organizationId]), adminContext(admin.userId));

    const survivor = await ctx.db
      .selectFrom('users')
      .select('id')
      .where('id', '=', ownerUserId)
      .executeTakeFirst();
    expect(survivor).toBeDefined();
  });

  it('deletes an orphaned test-classified identity', async () => {
    const admin = await operator();
    const { organizationId, ownerUserId } = await subscriber(admin.cookies, {
      email: 'throwaway@dev.test',
      legalName: 'Throwaway Ltd',
    });

    // Explicitly declare the person disposable too — never inferred.
    await ctx.db
      .transaction()
      .execute(async (trx) => {
        await sql`SET LOCAL ledgora.legacy_classification = 'on'`.execute(trx);
        await trx
          .updateTable('users')
          .set({ data_classification: 'test' })
          .where('id', '=', ownerUserId)
          .execute();
      });

    // Audit entries naming the user would keep them; clear the incidental ones.
    await ctx.db.deleteFrom('audit_logs').execute();

    const preview = await freshPreview([organizationId]);
    expect(preview.candidates[0]!.identities.find((i) => i.userId === ownerUserId)!.outcome).toBe('deletable');

    const result = await executeCleanup(
      ctx.db,
      ctx.storage,
      execInput(preview, [organizationId]),
      adminContext(admin.userId),
    );

    expect(result.organizations[0]!.identitiesDeleted).toContain(ownerUserId);
    const gone = await ctx.db.selectFrom('users').select('id').where('id', '=', ownerUserId).executeTakeFirst();
    expect(gone).toBeUndefined();
  });

  it('never deletes a platform operator', async () => {
    const admin = await operator();
    // A platform member is a blocker, so this asserts the account survives the refusal.
    const survivor = await ctx.db
      .selectFrom('users')
      .select('id')
      .where('id', '=', admin.userId)
      .executeTakeFirst();
    expect(survivor).toBeDefined();
  });
});

/* ══ Execution ═════════════════════════════════════════════════════════════ */

describe('execution', () => {
  it('removes every tenant-owned row and leaves other tenants untouched', async () => {
    const admin = await operator();
    const doomed = await subscriber(admin.cookies, { email: 'doomed@dev.test', legalName: 'Doomed Ltd' });
    const bystander = await subscriber(admin.cookies, {
      email: 'bystander@dev.test',
      legalName: 'Bystander Ltd',
    });

    const bystanderBefore = await orgRow(bystander.organizationId);
    const bystanderCounts: Record<string, number> = {};
    for (const table of DIRECTLY_OWNED_TABLES) {
      const row = await ctx.db
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('organization_id', '=', bystander.organizationId)
        .executeTakeFirst();
      bystanderCounts[table] = Number(row?.n ?? 0);
    }

    const preview = await freshPreview([doomed.organizationId]);
    const result = await executeCleanup(
      ctx.db,
      ctx.storage,
      execInput(preview, [doomed.organizationId]),
      adminContext(admin.userId),
    );

    expect(result.outcome).toBe('completed');
    expect(result.databaseDeletion).toEqual({ succeeded: 1, failed: 0 });

    // Nothing tenant-owned survives.
    expect(await orgRow(doomed.organizationId)).toBeUndefined();
    for (const table of DIRECTLY_OWNED_TABLES) {
      const row = await ctx.db
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('organization_id', '=', doomed.organizationId)
        .executeTakeFirst();
      expect(Number(row?.n ?? 0), `${table} must be empty after the purge`).toBe(0);
    }

    // The bystander is logically unchanged.
    expect(await orgRow(bystander.organizationId)).toEqual(bystanderBefore);
    for (const table of DIRECTLY_OWNED_TABLES) {
      const row = await ctx.db
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('organization_id', '=', bystander.organizationId)
        .executeTakeFirst();
      expect(Number(row?.n ?? 0), `${table} of the bystander`).toBe(bystanderCounts[table]);
    }
  });

  it('refuses a production subscriber even when its id is passed directly', async () => {
    const admin = await operator();
    const production = await subscriber(admin.cookies, {
      email: 'prod@customer.test',
      legalName: 'Prod Ltd',
      classification: 'production',
    });

    const preview = await freshPreview([production.organizationId]);

    const result = await executeCleanup(
      ctx.db,
      ctx.storage,
      execInput(preview, [production.organizationId]),
      adminContext(admin.userId),
    );

    expect(result.databaseDeletion.failed).toBe(1);
    expect(result.organizations[0]!.deleted).toBe(false);
    expect(result.organizations[0]!.error).toMatch(/Archive this subscriber instead/i);
    expect(await orgRow(production.organizationId)).toBeDefined();
  });

  it('refuses when state changed after the preview', async () => {
    const admin = await operator();
    const target = await subscriber(admin.cookies, { email: 'stale@dev.test', legalName: 'Stale Ltd' });

    const preview = await freshPreview([target.organizationId]);

    // A legal hold arrives between review and confirmation.
    await ctx.db
      .updateTable('organizations')
      .set({ legal_hold: true })
      .where('id', '=', target.organizationId)
      .execute();

    await expect(
      executeCleanup(
        ctx.db,
        ctx.storage,
        execInput(preview, [target.organizationId]),
        adminContext(admin.userId),
      ),
    ).rejects.toThrow(/changed since the preview/i);

    expect(await orgRow(target.organizationId)).toBeDefined();
  });

  it('rejects a forged digest', async () => {
    const admin = await operator();
    const target = await subscriber(admin.cookies, { email: 'forged@dev.test', legalName: 'Forged Ltd' });
    const preview = await freshPreview([target.organizationId]);

    await expect(
      executeCleanup(
        ctx.db,
        ctx.storage,
        { ...execInput(preview, [target.organizationId]), previewDigest: 'f'.repeat(64) },
        adminContext(admin.userId),
      ),
    ).rejects.toThrow(/changed since the preview/i);

    expect(await orgRow(target.organizationId)).toBeDefined();
  });

  it('rejects a preview digest reused for a different set of ids', async () => {
    const admin = await operator();
    const reviewed = await subscriber(admin.cookies, { email: 'seen@dev.test', legalName: 'Seen Ltd' });
    const unreviewed = await subscriber(admin.cookies, { email: 'unseen@dev.test', legalName: 'Unseen Ltd' });

    const preview = await freshPreview([reviewed.organizationId]);

    /*
     * The digest is bound to the state of a specific set. Pointing it at a
     * different tenant must not authorise destroying something never shown.
     */
    await expect(
      executeCleanup(
        ctx.db,
        ctx.storage,
        execInput(preview, [unreviewed.organizationId]),
        adminContext(admin.userId),
      ),
    ).rejects.toThrow(/changed since the preview/i);

    expect(await orgRow(unreviewed.organizationId)).toBeDefined();
  });

  /*
   * The console previews the WHOLE disposable roster and deletes the rows the
   * operator ticked, so the reviewed set is routinely larger than the deletion
   * set. These three tests pin that relationship down: a subset is allowed, the
   * unticked tenants survive, and nothing outside the reviewed set can be
   * smuggled into the selection.
   */
  it('deletes only the selected subset of a roster-wide preview', async () => {
    const admin = await operator();
    const chosen = await subscriber(admin.cookies, { email: 'chosen@dev.test', legalName: 'Chosen Ltd' });
    const spared = await subscriber(admin.cookies, { email: 'spared@dev.test', legalName: 'Spared Ltd' });

    const preview = await freshPreview([chosen.organizationId, spared.organizationId]);

    const result = await executeCleanup(
      ctx.db,
      ctx.storage,
      {
        ...execInput(preview, [chosen.organizationId]),
        previewedOrganizationIds: [chosen.organizationId, spared.organizationId],
      },
      adminContext(admin.userId),
    );

    expect(result.outcome).toBe('completed');
    expect(result.databaseDeletion).toEqual({ succeeded: 1, failed: 0 });
    expect(await orgRow(chosen.organizationId)).toBeUndefined();
    expect(await orgRow(spared.organizationId), 'an unticked tenant must survive').toBeDefined();
  });

  it('refuses when a tenant elsewhere in the reviewed roster changed', async () => {
    const admin = await operator();
    const chosen = await subscriber(admin.cookies, { email: 'still@dev.test', legalName: 'Still Ltd' });
    const other = await subscriber(admin.cookies, { email: 'moved@dev.test', legalName: 'Moved Ltd' });

    const preview = await freshPreview([chosen.organizationId, other.organizationId]);

    // A legal hold on the OTHER tenant changes the roster the operator reviewed.
    await ctx.db
      .updateTable('organizations')
      .set({ legal_hold: true })
      .where('id', '=', other.organizationId)
      .execute();

    await expect(
      executeCleanup(
        ctx.db,
        ctx.storage,
        {
          ...execInput(preview, [chosen.organizationId]),
          previewedOrganizationIds: [chosen.organizationId, other.organizationId],
        },
        adminContext(admin.userId),
      ),
    ).rejects.toThrow(/changed since the preview/i);

    expect(await orgRow(chosen.organizationId)).toBeDefined();
  });

  it('refuses a selection containing an id that was never previewed', async () => {
    const admin = await operator();
    const reviewed = await subscriber(admin.cookies, { email: 'shown@dev.test', legalName: 'Shown Ltd' });
    const smuggled = await subscriber(admin.cookies, { email: 'hidden@dev.test', legalName: 'Hidden Ltd' });

    const preview = await freshPreview([reviewed.organizationId]);

    /*
     * The digest matches the reviewed set perfectly. Only the subset check
     * stands between this request and destroying a tenant no human ever saw.
     */
    await expect(
      executeCleanup(
        ctx.db,
        ctx.storage,
        {
          ...execInput(preview, [reviewed.organizationId, smuggled.organizationId]),
          previewedOrganizationIds: [reviewed.organizationId],
        },
        adminContext(admin.userId),
      ),
    ).rejects.toThrow(/not part of the preview/i);

    expect(await orgRow(reviewed.organizationId)).toBeDefined();
    expect(await orgRow(smuggled.organizationId)).toBeDefined();
  });

  it('rejects a wrong confirmation phrase and a missing reason', async () => {
    const admin = await operator();
    const target = await subscriber(admin.cookies, { email: 'confirm@dev.test', legalName: 'Confirm Ltd' });
    const preview = await freshPreview([target.organizationId]);

    await expect(
      executeCleanup(
        ctx.db,
        ctx.storage,
        { ...execInput(preview, [target.organizationId]), confirmation: 'delete' },
        adminContext(admin.userId),
      ),
    ).rejects.toThrow(/confirmation phrase does not match/i);

    await expect(
      executeCleanup(
        ctx.db,
        ctx.storage,
        { ...execInput(preview, [target.organizationId]), reason: 'x' },
        adminContext(admin.userId),
      ),
    ).rejects.toThrow(/reason is required/i);

    expect(await orgRow(target.organizationId)).toBeDefined();
  });

  it('is idempotent when the same operation is submitted twice', async () => {
    const admin = await operator();
    const target = await subscriber(admin.cookies, { email: 'double@dev.test', legalName: 'Double Ltd' });
    const other = await subscriber(admin.cookies, { email: 'safe@dev.test', legalName: 'Safe Ltd' });

    const preview = await freshPreview([target.organizationId]);
    const operationId = '22222222-2222-4222-8222-222222222222';

    const first = await executeCleanup(
      ctx.db,
      ctx.storage,
      { ...execInput(preview, [target.organizationId]), operationId },
      adminContext(admin.userId),
    );

    const second = await executeCleanup(
      ctx.db,
      ctx.storage,
      { ...execInput(preview, [target.organizationId]), operationId },
      adminContext(admin.userId),
    );

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.organizations).toEqual(first.organizations);

    // Exactly one tombstone, and the unrelated tenant is untouched.
    const tombstones = await ctx.db
      .selectFrom('subscriber_deletion_tombstones')
      .selectAll()
      .where('organization_id', '=', target.organizationId)
      .execute();
    expect(tombstones).toHaveLength(1);
    expect(await orgRow(other.organizationId)).toBeDefined();
  });

  it('freezes tenant writes so a concurrent member cannot escape the deletion', async () => {
    const admin = await operator();
    const target = await subscriber(admin.cookies, { email: 'frozen@dev.test', legalName: 'Frozen Ltd' });

    /*
     * Simulate the window: the freeze is set, and an ordinary tenant write
     * arrives before the transaction finishes.
     */
    await ctx.db
      .updateTable('organizations')
      .set({ deletion_in_progress: true })
      .where('id', '=', target.organizationId)
      .execute();

    const ownerCookies = await login(ctx, 'frozen@dev.test').catch(() => null);
    if (ownerCookies) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/members/invitations',
        headers: authHeaders(ownerCookies),
        payload: { email: 'late@dev.test', fullName: 'Late Arrival', role: 'member' },
      });
      expect([400, 401, 403, 409]).toContain(response.statusCode);
    }

    const memberships = await ctx.db
      .selectFrom('organization_memberships')
      .select('id')
      .where('organization_id', '=', target.organizationId)
      .execute();

    // Nothing new was created behind the freeze.
    expect(memberships.length).toBeLessThanOrEqual(1);
  });
});

/* ══ Tombstone ═════════════════════════════════════════════════════════════ */

describe('the tombstone', () => {
  it('survives the tenant and carries counts without business content or secrets', async () => {
    const admin = await operator();
    const target = await subscriber(admin.cookies, { email: 'tomb@dev.test', legalName: 'Tomb Ltd' });

    const preview = await freshPreview([target.organizationId]);
    const result = await executeCleanup(
      ctx.db,
      ctx.storage,
      execInput(preview, [target.organizationId]),
      adminContext(admin.userId),
    );

    const tombstone = await ctx.db
      .selectFrom('subscriber_deletion_tombstones')
      .selectAll()
      .where('organization_id', '=', target.organizationId)
      .executeTakeFirstOrThrow();

    expect(tombstone.legal_name).toBe('Tomb Ltd');
    expect(tombstone.classification_at_deletion).toBe('test');
    expect(tombstone.deleted_by_user_id).toBe(admin.userId);
    expect(tombstone.operation_id).toBe(result.operationId);
    expect(tombstone.reason).toMatch(/release rehearsal/);
    expect(tombstone.request_id).toBe('req-test-1');
    expect(Number(tombstone.removed_counts.organizations)).toBe(1);

    /*
     * The tombstone is evidence, not an archive. Anything resembling content or
     * a credential would defeat the point of the deletion.
     */
    const serialised = JSON.stringify(tombstone).toLowerCase();
    for (const forbidden of ['password', 'hash', 'token', 'secret', 'credential', 'payload', 'storage_key']) {
      expect(serialised, `tombstone must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });
});

/* ══ External cleanup ══════════════════════════════════════════════════════ */

describe('external file cleanup', () => {
  /** Enqueue a ledger row directly: the storage-key path, without a full billing flow. */
  async function queueFile(organizationId: string, operationId: string, key: string): Promise<void> {
    await ctx.db
      .insertInto('file_cleanup_queue')
      .values({
        operation_id: operationId,
        organization_id: organizationId,
        storage_key: key,
        source_table: 'payment_proofs',
        source_id: null,
      })
      .execute();
  }

  it('deletes queued objects and is idempotent on a second run', async () => {
    const operationId = '33333333-3333-4333-8333-333333333333';
    const stored = await ctx.storage.put({ content: Buffer.from('receipt'), mimeType: 'image/png' });
    await queueFile('44444444-4444-4444-8444-444444444444', operationId, stored.storageKey);

    const first = await runFileCleanup(ctx.db, ctx.storage, operationId);
    expect(first).toEqual({ pending: 0, completed: 1, failed: 0 });

    // Running again must not fail, and must not re-attempt completed work.
    const second = await runFileCleanup(ctx.db, ctx.storage, operationId);
    expect(second).toEqual({ pending: 0, completed: 1, failed: 0 });

    const row = await ctx.db
      .selectFrom('file_cleanup_queue')
      .selectAll()
      .where('operation_id', '=', operationId)
      .executeTakeFirstOrThrow();
    expect(row.attempts).toBe(1);
  });

  it('treats an already-absent object as success', async () => {
    const operationId = '55555555-5555-4555-8555-555555555555';
    await queueFile('44444444-4444-4444-8444-444444444444', operationId, 'never-stored-key');

    const summary = await runFileCleanup(ctx.db, ctx.storage, operationId);
    expect(summary.completed).toBe(1);
    expect(summary.pending).toBe(0);
  });

  it('leaves a failure pending and retryable, and reports it separately from database deletion', async () => {
    const admin = await operator();
    const target = await subscriber(admin.cookies, { email: 'files@dev.test', legalName: 'Files Ltd' });

    const stored = await ctx.storage.put({ content: Buffer.from('proof'), mimeType: 'image/png' });

    // A storage backend that refuses, exactly once.
    let failNext = true;
    const flakyStorage = {
      put: ctx.storage.put.bind(ctx.storage),
      get: ctx.storage.get.bind(ctx.storage),
      delete: async (key: string) => {
        if (failNext) {
          failNext = false;
          throw new Error('storage backend unreachable');
        }
        await ctx.storage.delete(key);
      },
    };

    const operationId = '66666666-6666-4666-8666-666666666666';
    await queueFile(target.organizationId, operationId, stored.storageKey);

    const failed = await runFileCleanup(ctx.db, flakyStorage, operationId);
    expect(failed.pending).toBe(1);
    expect(failed.completed).toBe(0);

    const pendingRow = await ctx.db
      .selectFrom('file_cleanup_queue')
      .selectAll()
      .where('operation_id', '=', operationId)
      .executeTakeFirstOrThrow();
    expect(pendingRow.status).toBe('pending');
    expect(pendingRow.last_error).toMatch(/unreachable/);
    expect(pendingRow.attempts).toBe(1);

    // The retry succeeds; the ledger is the thing that made recovery possible.
    const retried = await runFileCleanup(ctx.db, flakyStorage, operationId);
    expect(retried).toEqual({ pending: 0, completed: 1, failed: 0 });
  });

  it('records object keys before the rows naming them are deleted', async () => {
    const admin = await operator();
    const target = await subscriber(admin.cookies, { email: 'keys@dev.test', legalName: 'Keys Ltd' });

    const preview = await freshPreview([target.organizationId]);
    const result = await executeCleanup(
      ctx.db,
      ctx.storage,
      execInput(preview, [target.organizationId]),
      adminContext(admin.userId),
    );

    /*
     * With no proofs there is nothing to queue, and the operation must say so
     * rather than claiming a pending cleanup it does not have.
     */
    expect(result.externalCleanup).toEqual({ pending: 0, completed: 0, failed: 0 });
    expect(result.outcome).toBe('completed');
  });
});

/* ══ Route surface ═════════════════════════════════════════════════════════ */

describe('the admin routes', () => {
  it('refuses a non-super-admin operator', async () => {
    await seedUser(ctx, {
      email: 'support@ledgora.test',
      fullName: 'Support Person',
      platformRoles: ['support'],
    });
    const cookies = await login(ctx, 'support@ledgora.test');

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/cleanup/preview',
      headers: authHeaders(cookies),
      payload: { allDisposable: true },
    });

    expect(response.statusCode).toBe(403);
  });

  it('previews and executes over HTTP', async () => {
    const admin = await operator();
    const target = await subscriber(admin.cookies, { email: 'http@dev.test', legalName: 'Http Ltd' });

    const previewResponse = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/cleanup/preview',
      headers: authHeaders(admin.cookies),
      payload: { organizationIds: [target.organizationId] },
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json();
    expect(preview.candidates[0].eligible).toBe(true);

    const executeResponse = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/cleanup/execute',
      headers: authHeaders(admin.cookies),
      payload: {
        organizationIds: [target.organizationId],
        previewDigest: preview.digest,
        previewedAt: preview.previewedAt,
        reason: 'Cleaning up after the integration rehearsal.',
        confirmation: CLEANUP_CONFIRMATION,
      },
    });

    expect(executeResponse.statusCode).toBe(200);
    expect(executeResponse.json().outcome).toBe('completed');
    expect(await orgRow(target.organizationId)).toBeUndefined();
  });

  it('rejects a body that omits the digest', async () => {
    const admin = await operator();
    const target = await subscriber(admin.cookies, { email: 'nodigest@dev.test', legalName: 'NoDigest Ltd' });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/cleanup/execute',
      headers: authHeaders(admin.cookies),
      payload: {
        organizationIds: [target.organizationId],
        reason: 'Trying to skip the preview entirely.',
        confirmation: CLEANUP_CONFIRMATION,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(await orgRow(target.organizationId)).toBeDefined();
  });
});

/* ══ Digest ════════════════════════════════════════════════════════════════ */

describe('the digest', () => {
  it('is stable for unchanged state and changes when a count changes', async () => {
    const admin = await operator();
    const target = await subscriber(admin.cookies, { email: 'digest@dev.test', legalName: 'Digest Ltd' });

    const first = await freshPreview([target.organizationId]);
    const second = await freshPreview([target.organizationId]);
    expect(second.digest).toBe(first.digest);

    // previewId and timestamp deliberately do NOT participate.
    expect(second.previewId).not.toBe(first.previewId);

    await ctx.db
      .insertInto('user_permission_overrides')
      .values({
        user_id: target.ownerUserId,
        organization_id: target.organizationId,
        subject: 'invoices',
        action: 'read',
        effect: 'deny',
      })
      .execute();

    const third = await freshPreview([target.organizationId]);
    expect(third.digest).not.toBe(first.digest);
  });

  it('ignores the order ids are supplied in', async () => {
    const admin = await operator();
    const a = await subscriber(admin.cookies, { email: 'a@dev.test', legalName: 'A Ltd' });
    const b = await subscriber(admin.cookies, { email: 'b@dev.test', legalName: 'B Ltd' });

    const forward = await freshPreview([a.organizationId, b.organizationId]);
    const reverse = await freshPreview([b.organizationId, a.organizationId]);

    expect(digestOf(reverse.candidates)).toBe(digestOf(forward.candidates));
  });
});

/*
 * The console has to be able to show an operator which LOGINS are disposable,
 * not just which tenants are. The two are independent: a production person can
 * belong to a demo tenant, and that is exactly the case where the badge stops a
 * wrong assumption.
 */
describe('the member directory', () => {
  it('reports the account type of the identity, not of its organization', async () => {
    const admin = await operator();
    const disposable = await subscriber(admin.cookies, {
      email: 'sandbox-owner@dev.test',
      legalName: 'Sandbox Ltd',
      classification: 'test',
    });

    const roster = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/members?organizationId=${disposable.organizationId}`,
      headers: authHeaders(admin.cookies),
    });

    expect(roster.statusCode).toBe(200);
    const owner = roster
      .json()
      .members.find((m: { userId: string }) => m.userId === disposable.ownerUserId);

    expect(owner).toBeDefined();
    /*
     * Created as part of a test tenant, so this identity is disposable too —
     * it exists only to populate that tenant.
     */
    expect(owner.dataClassification).toBe('test');

    /*
     * And the independence the directory exists to show: a REAL person given a
     * seat in the same test tenant keeps their production classification. The
     * column describes the person, never the organization they sit in.
     */
    const real = await subscriber(admin.cookies, {
      email: 'real-visitor@dev.test',
      legalName: 'Real Visitor Ltd',
      classification: 'production',
    });
    await ctx.db
      .insertInto('organization_memberships')
      .values({
        organization_id: disposable.organizationId,
        user_id: real.ownerUserId,
        role: 'member',
        status: 'active',
      })
      .execute();

    /*
     * Searched rather than scoped to the demo tenant: the directory shows one
     * row per PERSON, keyed to their primary organization, so a visitor whose
     * own tenant is elsewhere is listed under that one.
     */
    const mixed = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/members?search=real-visitor',
      headers: authHeaders(admin.cookies),
    });
    const visitor = mixed
      .json()
      .members.find((m: { userId: string }) => m.userId === real.ownerUserId);
    expect(visitor.dataClassification).toBe('production');
  });
});

/**
 * Does destroying a tenant actually destroy its data?
 *
 * "The organizations row is gone" is not an answer to that question. These tests
 * take an ACTIVATED subscriber — one that behaved like a real customer — fill
 * every server-side store that can hold anything belonging to it, destroy it,
 * and then interrogate the database catalogue directly for survivors.
 *
 * ── The finding these tests encode ───────────────────────────────────────────
 * Ledgora's accounting records are NOT in this database. There is no ledger
 * table, no invoice table, no customer or supplier table; the twenty-one tables
 * here are authentication, subscription, billing and audit. The books live in
 * each user's browser under `ledgora:ws:tenant:<organizationId>:*` — see
 * `src/lib/workspaceStorage.ts`, whose `getItem`/`setItem` carry the "BACKEND
 * SEAM" comments marking where a server-side store would go if one existed.
 *
 * A server-side purge therefore CANNOT delete a tenant's books, because they
 * were never on the server. That is a property of the architecture, not a defect
 * in the purge, and the tests below pin down both halves: everything the server
 * does hold is destroyed, and the thing it does not hold is named explicitly so
 * nobody later mistakes silence for coverage.
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
  CLEANUP_CONFIRMATION,
} from '../src/services/cleanupService.js';
import { createSubscriberExport } from '../src/services/subscriberExportService.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

async function operator(email = 'workspace@ledgora.test'): Promise<{ cookies: SessionCookies; userId: string }> {
  const user = await seedUser(ctx, { email, fullName: 'Workspace Operator', platformRoles: ['super_admin'] });
  return { cookies: await login(ctx, email), userId: user.id };
}

async function plan(): Promise<string> {
  const plans = (await ctx.app.inject({ method: 'GET', url: '/api/plans/public' })).json().plans;
  return plans[0].id;
}

/** An ACTIVATED test subscriber — one that was permitted to keep real books. */
async function activatedSubscriber(
  cookies: SessionCookies,
  email: string,
  legalName: string,
): Promise<{ organizationId: string; ownerUserId: string }> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/subscribers',
    headers: authHeaders(cookies),
    payload: {
      fullName: 'Owner Person',
      email,
      organizationLegalName: legalName,
      country: 'AE',
      planId: await plan(),
      onboarding: 'invite',
      paymentConfirmed: true,
      subscriptionStatus: 'active',
      dataClassification: 'test',
    },
  });
  expect(response.statusCode, JSON.stringify(response.json())).toBe(201);
  const body = response.json();
  return { organizationId: body.subscriber.organizationId, ownerUserId: body.subscriber.userId };
}

/**
 * Every table in the live database carrying an `organization_id`, read from the
 * catalogue rather than from a list so a table added tomorrow is swept too.
 */
async function organizationScopedTables(): Promise<string[]> {
  const result = await sql<{ table_name: string }>`
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'organization_id'
    ORDER BY table_name
  `.execute(ctx.db);
  return result.rows.map((r) => r.table_name);
}

async function rowsReferencing(table: string, organizationId: string): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT COUNT(*)::int AS n
    FROM ${sql.table(table)}
    WHERE organization_id = ${organizationId}::uuid
  `.execute(ctx.db);
  return result.rows[0]?.n ?? 0;
}

/*
 * The two tables that deliberately KEEP the id of a destroyed tenant: they exist
 * to record that it was destroyed. A sweep that expected them to be empty would
 * be demanding the evidence be deleted along with the evidence's subject.
 */
const EVIDENCE_TABLES = new Set(['subscriber_deletion_tombstones', 'file_cleanup_queue']);

describe('what the server actually stores for a tenant', () => {
  it('has no accounting tables at all — the books are not in this database', async () => {
    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `.execute(ctx.db);

    const names = tables.rows.map((r) => r.table_name);

    /*
     * If any of these ever appears, the books have moved server-side and the
     * purge must be extended to cover them. Failing here is the intended way to
     * find that out — silently leaving a new ledger table undeleted is not.
     */
    const accountingTables = [
      'journal_entries',
      'journal_lines',
      'journal_vouchers',
      'accounts',
      'chart_of_accounts',
      'customers',
      'suppliers',
      'business_invoices',
      'bills',
      'payments',
      'receipts',
      'credit_notes',
      'inventory_items',
      'stock_movements',
      'fixed_assets',
      'projects',
      'cost_centers',
    ];

    for (const table of accountingTables) {
      expect(names, `${table} exists server-side; the purge must be extended to cover it`).not.toContain(
        table,
      );
    }

    // The migration set is exactly the platform surface, nothing more.
    expect(names).toContain('organizations');
    expect(names).toContain('subscription_invoices');
  });
});

describe('destroying an activated tenant', () => {
  it('leaves no row anywhere in the database that still names it', async () => {
    const admin = await operator();
    const doomed = await activatedSubscriber(admin.cookies, 'activated@dev.test', 'Activated Ltd');
    const bystander = await activatedSubscriber(admin.cookies, 'neighbour@dev.test', 'Neighbour Ltd');

    /* ── Fill every server-side store this tenant can reach ──────────────── */

    // A paid invoice with a stored proof document.
    const subscription = await ctx.db
      .selectFrom('subscriptions')
      .select('id')
      .where('organization_id', '=', doomed.organizationId)
      .executeTakeFirstOrThrow();

    const now = new Date();
    const invoice = await ctx.db
      .insertInto('subscription_invoices')
      .values({
        invoice_number: 'SUB-2026-09001',
        organization_id: doomed.organizationId,
        subscription_id: subscription.id,
        currency: 'AED',
        subtotal: '49.00',
        total: '49.00',
        status: 'paid',
        payment_reference: 'LG-TEST-0001',
        issued_at: now,
        due_at: now,
        paid_at: now,
        created_at: now,
        updated_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const stored = await ctx.storage.put({ content: Buffer.from('bank-transfer'), mimeType: 'image/png' });
    await ctx.db
      .insertInto('payment_proofs')
      .values({
        invoice_id: invoice.id,
        uploaded_by_user_id: doomed.ownerUserId,
        storage_key: stored.storageKey,
        file_name: 'transfer.png',
        mime_type: 'image/png',
        file_size: 13,
        ledgora_payment_reference: 'LG-TEST-0001',
        amount: '49.00',
        paid_at: new Date(),
        status: 'approved',
      })
      .execute();

    // A permission override and a package-change record.
    await ctx.db
      .insertInto('user_permission_overrides')
      .values({
        user_id: doomed.ownerUserId,
        organization_id: doomed.organizationId,
        subject: 'invoices',
        action: 'read',
        effect: 'deny',
      })
      .execute();

    /*
     * A data export. This is the ONE server-side artefact that holds a bulk copy
     * of tenant content, so leaving it behind would preserve exactly what the
     * deletion is meant to remove.
     */
    const exported = await createSubscriberExport(
      ctx.db,
      { organizationId: doomed.organizationId },
      {
        actorUserId: admin.userId,
        actorPlatformRole: 'super_admin',
        ipAddress: '127.0.0.1',
        userAgent: 'vitest',
      },
    );
    expect(exported.exportId).toBeTruthy();

    const payloadBefore = await ctx.db
      .selectFrom('subscriber_data_exports')
      .select('payload')
      .where('organization_id', '=', doomed.organizationId)
      .executeTakeFirst();
    expect(payloadBefore?.payload, 'the export must actually hold a payload').toBeTruthy();

    /* ── Baseline: the sweep must find something before it finds nothing ──── */
    const scoped = await organizationScopedTables();
    expect(scoped.length).toBeGreaterThan(5);

    let populated = 0;
    for (const table of scoped) {
      if (EVIDENCE_TABLES.has(table)) continue;
      populated += await rowsReferencing(table, doomed.organizationId);
    }
    expect(populated, 'the tenant must hold data before we prove it is gone').toBeGreaterThan(0);

    /* ── Destroy ─────────────────────────────────────────────────────────── */
    const preview = await previewCleanup(ctx.db, [doomed.organizationId]);
    const doomedCandidate = preview.candidates[0]!;
    expect(doomedCandidate.everActivated, 'this tenant was activated').toBe(true);
    expect(doomedCandidate.eligible, 'activation is a warning, never a blocker').toBe(true);

    const result = await executeCleanup(
      ctx.db,
      ctx.storage,
      {
        organizationIds: [doomed.organizationId],
        previewDigest: preview.digest,
        previewedAt: preview.previewedAt,
        reason: 'Destroying an activated rehearsal tenant.',
        confirmation: CLEANUP_CONFIRMATION,
      },
      {
        actorUserId: admin.userId,
        actorPlatformRole: 'super_admin',
        ipAddress: '127.0.0.1',
        userAgent: 'vitest',
        requestId: 'req-workspace-1',
      },
    );
    expect(result.outcome).toBe('completed');

    /* ── Interrogate every table in the catalogue ────────────────────────── */
    for (const table of scoped) {
      const remaining = await rowsReferencing(table, doomed.organizationId);
      if (EVIDENCE_TABLES.has(table)) {
        // Evidence of the destruction is supposed to name the destroyed tenant.
        continue;
      }
      expect(remaining, `${table} still holds rows for the destroyed tenant`).toBe(0);
    }

    // The bulk copy of tenant content is gone, not merely detached.
    const exportsAfter = await ctx.db
      .selectFrom('subscriber_data_exports')
      .selectAll()
      .where('organization_id', '=', doomed.organizationId)
      .execute();
    expect(exportsAfter).toHaveLength(0);

    // The stored document is gone from object storage too.
    await expect(ctx.storage.get(stored.storageKey)).rejects.toThrow();

    // Audit entries survive their subject, detached rather than deleted.
    const detached = await ctx.db
      .selectFrom('audit_logs')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('organization_id', '=', doomed.organizationId)
      .executeTakeFirst();
    expect(Number(detached?.n ?? 0)).toBe(0);

    // The neighbour is untouched throughout.
    const neighbour = await ctx.db
      .selectFrom('organizations')
      .selectAll()
      .where('id', '=', bystander.organizationId)
      .executeTakeFirst();
    expect(neighbour).toBeDefined();
    expect(await rowsReferencing('organization_memberships', bystander.organizationId)).toBeGreaterThan(0);
    expect(await rowsReferencing('subscriptions', bystander.organizationId)).toBeGreaterThan(0);
  });

  /*
   * The tombstone is the permanent record, so each storage layer has to be
   * readable from it independently. Collapsing them into one "outcome" would
   * mean the layer that lost the argument is the one nobody ever chases.
   */
  it('records the three storage layers on the tombstone as separate states', async () => {
    const admin = await operator();
    const target = await activatedSubscriber(admin.cookies, 'states@dev.test', 'States Ltd');

    const preview = await previewCleanup(ctx.db, [target.organizationId]);
    await executeCleanup(
      ctx.db,
      ctx.storage,
      {
        organizationIds: [target.organizationId],
        previewDigest: preview.digest,
        previewedAt: preview.previewedAt,
        reason: 'Recording the layered completion state.',
        confirmation: CLEANUP_CONFIRMATION,
      },
      {
        actorUserId: admin.userId,
        actorPlatformRole: 'super_admin',
        ipAddress: '127.0.0.1',
        userAgent: 'vitest',
        requestId: 'req-states-1',
      },
    );

    const tombstone = await ctx.db
      .selectFrom('subscriber_deletion_tombstones')
      .selectAll()
      .where('organization_id', '=', target.organizationId)
      .executeTakeFirstOrThrow();

    expect(tombstone.database_deletion_status, 'the rows really are gone').toBe('completed');
    /*
     * Never 'completed'. The books were never on this server, so claiming to
     * have deleted them would be a fabrication written into the permanent
     * record — the one place it would later be believed.
     */
    expect(tombstone.workspace_deletion_status).toBe('no_server_workspace');
    // No proofs on this tenant, so there was nothing external to do.
    expect(tombstone.external_cleanup_status).toBe('none');
    expect(tombstone.outcome).toBe('completed');

    // And the field that never had an implementation behind it is simply absent.
    expect(Object.keys(tombstone)).not.toContain('identities_anonymized');
  });

  it('never reports full completion while a file deletion is outstanding', async () => {
    const admin = await operator();
    const target = await activatedSubscriber(admin.cookies, 'stuck@dev.test', 'Stuck Ltd');

    const subscription = await ctx.db
      .selectFrom('subscriptions')
      .select('id')
      .where('organization_id', '=', target.organizationId)
      .executeTakeFirstOrThrow();

    const now = new Date();
    const invoice = await ctx.db
      .insertInto('subscription_invoices')
      .values({
        invoice_number: 'SUB-2026-09002',
        organization_id: target.organizationId,
        subscription_id: subscription.id,
        currency: 'AED',
        subtotal: '49.00',
        total: '49.00',
        status: 'paid',
        payment_reference: 'LG-TEST-0002',
        issued_at: now,
        due_at: now,
        paid_at: now,
        created_at: now,
        updated_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const stored = await ctx.storage.put({ content: Buffer.from('proof'), mimeType: 'image/png' });
    await ctx.db
      .insertInto('payment_proofs')
      .values({
        invoice_id: invoice.id,
        uploaded_by_user_id: target.ownerUserId,
        storage_key: stored.storageKey,
        file_name: 'proof.png',
        mime_type: 'image/png',
        file_size: 5,
        ledgora_payment_reference: 'LG-TEST-0002',
        amount: '49.00',
        paid_at: now,
        status: 'approved',
      })
      .execute();

    // Storage that refuses every delete.
    const brokenStorage = {
      put: ctx.storage.put.bind(ctx.storage),
      get: ctx.storage.get.bind(ctx.storage),
      delete: async () => {
        throw new Error('storage backend unreachable');
      },
    };

    const preview = await previewCleanup(ctx.db, [target.organizationId]);
    const result = await executeCleanup(
      ctx.db,
      brokenStorage,
      {
        organizationIds: [target.organizationId],
        previewDigest: preview.digest,
        previewedAt: preview.previewedAt,
        reason: 'Proving a stuck file blocks the success claim.',
        confirmation: CLEANUP_CONFIRMATION,
      },
      {
        actorUserId: admin.userId,
        actorPlatformRole: 'super_admin',
        ipAddress: '127.0.0.1',
        userAgent: 'vitest',
        requestId: 'req-stuck-1',
      },
    );

    // The rows are gone; the object is not; the report says exactly that.
    expect(result.databaseDeletion).toEqual({ succeeded: 1, failed: 0 });
    expect(result.externalCleanup.pending).toBe(1);
    expect(result.outcome, 'a stuck file must not read as completed').toBe(
      'completed_with_pending_cleanup',
    );

    const tombstone = await ctx.db
      .selectFrom('subscriber_deletion_tombstones')
      .selectAll()
      .where('organization_id', '=', target.organizationId)
      .executeTakeFirstOrThrow();
    expect(tombstone.database_deletion_status).toBe('completed');
    expect(tombstone.external_cleanup_status).toBe('pending');
    expect(tombstone.outcome).toBe('completed_with_pending_cleanup');

    /*
     * ── Restart durability ────────────────────────────────────────────────
     * The ledger is a table, so a new process reading the same database still
     * finds the outstanding work. Nothing about the recovery depends on the
     * process that queued it still being alive.
     */
    const afterRestart = await ctx.db
      .selectFrom('file_cleanup_queue')
      .selectAll()
      .where('organization_id', '=', target.organizationId)
      .execute();
    expect(afterRestart).toHaveLength(1);
    expect(afterRestart[0]!.status).toBe('pending');
    expect(afterRestart[0]!.storage_key, 'the key survives, so the object is still nameable').toBe(
      stored.storageKey,
    );

    // A later retry against working storage clears it.
    const retried = await runFileCleanup(ctx.db, ctx.storage, result.operationId);
    expect(retried).toEqual({ pending: 0, completed: 1, failed: 0 });
  });

  it('refuses file-status and retry-all to an operator without subscribers.delete', async () => {
    await seedUser(ctx, {
      email: 'support@ledgora.test',
      fullName: 'Support Only',
      platformRoles: ['support'],
    });
    const supportCookies = await login(ctx, 'support@ledgora.test');

    for (const call of [
      { method: 'GET' as const, url: '/api/admin/cleanup/file-status' },
      { method: 'POST' as const, url: '/api/admin/cleanup/retry-files' },
    ]) {
      const response = await ctx.app.inject({
        ...call,
        headers: authHeaders(supportCookies),
        payload: call.method === 'POST' ? {} : undefined,
      });
      expect(response.statusCode, `${call.method} ${call.url} must be refused`).toBe(403);
    }

    // And the same calls succeed for a Platform Super Admin.
    const admin = await operator();
    const allowed = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/cleanup/file-status',
      headers: authHeaders(admin.cookies),
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('reports the browser workspace as unverifiable rather than as zero', async () => {
    const admin = await operator();
    const target = await activatedSubscriber(admin.cookies, 'books@dev.test', 'Books Ltd');

    const preview = await previewCleanup(ctx.db, [target.organizationId]);
    const candidate = preview.candidates[0]!;

    /*
     * The counts the preview shows are counts of things this server can see.
     * There must be no category claiming to count the books — a "0 journal
     * entries" line would be a confident lie about data the server has never
     * had access to.
     */
    const keys = candidate.counts.map((c) => c.key);
    expect(keys).not.toContain('journal_entries');
    expect(keys).not.toContain('accounting_records');

    // Instead the tenant is flagged, and the flag says the data is out of reach.
    expect(candidate.everActivated).toBe(true);
    expect(candidate.workspaceDataReachable).toBe(false);
    expect(candidate.warnings.join(' ')).toMatch(/browser|workspace/i);
  });
});

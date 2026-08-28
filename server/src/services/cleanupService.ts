/**
 * Permanent cleanup of test/demo subscribers.
 *
 * ── The shape of the guarantee ───────────────────────────────────────────────
 * Every destructive decision here is made from the database, inside the
 * transaction that acts on it, immediately before acting. Nothing a client sends
 * — ids aside — is trusted: not a classification, not a count, not an
 * eligibility verdict, not a "these were the blockers" list. The preview exists
 * to inform a human, and its identifier exists to prove the human saw the state
 * that is about to be destroyed. Neither grants authority.
 *
 * ── Why a digest and not just an operation id ────────────────────────────────
 * An id proves a preview happened. A digest proves WHICH state it showed. If an
 * invoice is paid, a legal hold applied, or a member added between preview and
 * confirmation, the operator is about to destroy something other than what they
 * reviewed — so the digest changes and execution is refused until they look
 * again. This is the difference between confirming an action and confirming an
 * action's consequences.
 *
 * ── Ever-activated tenants ───────────────────────────────────────────────────
 * Activation is deliberately NOT a blocker. A development tenant has to be
 * activated to exercise real workflows, and making that permanent would leave
 * the most realistic test data permanently undeletable. It is instead surfaced
 * as a prominent warning, because "this tenant behaved like a real customer" is
 * exactly what an operator should look at twice before destroying it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/schema.js';
import type { FileStorage } from '../storage/fileStorage.js';
import { writeAuditLog, type AuditContext } from '../lib/audit.js';
import { errors } from '../lib/errors.js';
import { assessSubscriberDeletion, everActivated, PRODUCTION_RETENTION_MESSAGE } from './deletionService.js';
import { DELETION_SEQUENCE, DIRECTLY_OWNED_TABLES } from './tenantInventory.js';

/** The phrase an operator must type. Long enough that it cannot be typed by reflex. */
export const CLEANUP_CONFIRMATION = 'DELETE TEST DATA PERMANENTLY';

export interface CleanupAdminContext extends AuditContext {
  actorUserId: string;
  requestId?: string | null;
}

export interface CategoryCount {
  key: string;
  label: string;
  count: number;
}

export interface IdentityDisposition {
  userId: string;
  email: string;
  /** Why this identity survives, or that it does not. */
  outcome: 'retained_other_membership' | 'retained_platform_role' | 'retained_production' | 'deletable';
  detail: string;
}

export interface CleanupCandidate {
  organizationId: string;
  legalName: string;
  classification: string;
  status: string;
  eligible: boolean;
  blockers: { code: string; message: string }[];

  /* ── Prominent warnings. Not blockers; things to look at twice. ─────────── */
  everActivated: boolean;
  hasSubscriptionHistory: boolean;
  hasBusinessActivity: boolean;
  storedDocumentCount: number;
  /**
   * Whether this server can reach — and therefore delete — the tenant's
   * accounting workspace.
   *
   * Always `false` today, and that is a fact about the architecture rather than
   * a gap in this service: Ledgora's books live in each user's browser under
   * `ledgora:ws:tenant:<organizationId>:*`, and there is no ledger table in this
   * database to delete (see `workspaceDeletion.test.ts`, which fails if one
   * appears). It is a field rather than a constant so the day a server-side
   * workspace store lands, every consumer already has somewhere to read the
   * answer from instead of assuming it.
   */
  workspaceDataReachable: boolean;
  warnings: string[];

  counts: CategoryCount[];
  identities: IdentityDisposition[];
  externalFileKeys: number;
}

export interface CleanupPreview {
  previewId: string;
  digest: string;
  previewedAt: string;
  candidates: CleanupCandidate[];
  eligibleCount: number;
  excludedCount: number;
}

/* ══ Preview ═══════════════════════════════════════════════════════════════ */

async function countIn(
  db: Kysely<Database> | Transaction<Database>,
  table: (typeof DIRECTLY_OWNED_TABLES)[number],
  organizationId: string,
): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('organization_id', '=', organizationId)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

const CATEGORY_LABELS: Record<string, string> = {
  organization_memberships: 'Memberships',
  subscription_invoices: 'Invoices',
  subscriptions: 'Subscriptions',
  subscription_applications: 'Onboarding applications',
  subscription_package_changes: 'Package changes',
  organization_entitlements: 'Entitlements',
  user_permission_overrides: 'Permission overrides',
  subscriber_data_exports: 'Data exports',
};

/**
 * Build the picture for one organization. Reads only — every statement here is
 * a SELECT, and the function is called from both the preview and the digest
 * recomputation so the two can never disagree about what "current state" means.
 */
async function describeCandidate(
  db: Kysely<Database> | Transaction<Database>,
  organizationId: string,
): Promise<CleanupCandidate | null> {
  const organization = await db
    .selectFrom('organizations')
    .select(['id', 'legal_name', 'status', 'data_classification', 'legal_hold', 'deletion_in_progress'])
    .where('id', '=', organizationId)
    .executeTakeFirst();

  if (!organization) return null;

  /*
   * The SAME assessment the purge uses. Not a parallel reimplementation — a
   * second copy of eligibility logic is a second thing to forget to update, and
   * the divergence would show as a preview promising a deletion that then fails.
   */
  const impact = await assessSubscriberDeletion(db, organizationId);

  const counts: CategoryCount[] = [];
  for (const table of DIRECTLY_OWNED_TABLES) {
    counts.push({
      key: table,
      label: CATEGORY_LABELS[table] ?? table,
      count: await countIn(db, table, organizationId),
    });
  }

  const proofs = await db
    .selectFrom('payment_proofs')
    .innerJoin('subscription_invoices', 'subscription_invoices.id', 'payment_proofs.invoice_id')
    .select(['payment_proofs.storage_key'])
    .where('subscription_invoices.organization_id', '=', organizationId)
    .execute();

  counts.push({ key: 'payment_proofs', label: 'Payment proofs', count: proofs.length });

  const auditCount = await db
    .selectFrom('audit_logs')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('organization_id', '=', organizationId)
    .executeTakeFirst();
  counts.push({
    key: 'audit_logs_retained',
    label: 'Audit entries (retained, detached)',
    count: Number(auditCount?.n ?? 0),
  });

  /* ── Identity dispositions ───────────────────────────────────────────── */
  const members = await db
    .selectFrom('organization_memberships')
    .innerJoin('users', 'users.id', 'organization_memberships.user_id')
    .select(['users.id as user_id', 'users.email', 'users.data_classification'])
    .where('organization_memberships.organization_id', '=', organizationId)
    .execute();

  const identities: IdentityDisposition[] = [];
  for (const member of members) {
    identities.push(await classifyIdentity(db, member, organizationId));
  }

  const subscriptionRows = await db
    .selectFrom('subscriptions')
    .select(['id'])
    .where('organization_id', '=', organizationId)
    .execute();

  /*
   * The SAME signal `deletionService` uses, imported rather than recomputed. A
   * local reimplementation would eventually disagree with the gate that decides
   * eligibility, and the preview would promise something the purge refuses.
   */
  const activated = await everActivated(db, organizationId);
  const hasSubscriptionHistory = subscriptionRows.length > 0;
  const invoiceCount = counts.find((c) => c.key === 'subscription_invoices')?.count ?? 0;
  const hasBusinessActivity = activated || invoiceCount > 0;

  const warnings: string[] = [];
  if (activated) {
    /*
     * Deliberately says NOT DELETED, not merely "not counted".
     *
     * The books are held in each user's browser storage, so this operation
     * cannot reach them: it destroys the account, the memberships and the
     * sessions, which is what makes the workspace unreachable through the
     * application, but the bytes remain on whatever machines they were written
     * to. Saying "cannot be counted" implied the deletion covered them and only
     * the tally was missing. It does not, and an operator deleting a tenant to
     * dispose of its data has to know that.
     */
    warnings.push(
      'This tenant was activated and was permitted to create accounting records. Those records live in each user’s browser workspace, NOT on the server: this deletion removes the account, its memberships and its sessions — which makes the workspace unreachable through Ledgora — but it cannot erase data already written to those browsers. Detailed accounting counts are unavailable for the same reason.',
    );
  }
  if (hasSubscriptionHistory) {
    warnings.push(`It has ${subscriptionRows.length} subscription record(s) in its history.`);
  }
  if (invoiceCount > 0) {
    warnings.push(`It has ${invoiceCount} invoice(s), which will be destroyed.`);
  }
  if (proofs.length > 0) {
    warnings.push(`${proofs.length} stored document(s) will be queued for deletion from file storage.`);
  }

  return {
    organizationId,
    legalName: organization.legal_name,
    classification: organization.data_classification,
    status: organization.status,
    eligible: impact.deletionPermitted,
    blockers: impact.blockingReasons.map((b) => ({ code: b.code, message: b.message })),
    everActivated: activated,
    hasSubscriptionHistory,
    hasBusinessActivity,
    storedDocumentCount: proofs.length,
    // No server-side workspace store exists. See the field's documentation.
    workspaceDataReachable: false,
    warnings,
    counts,
    identities,
    externalFileKeys: proofs.length,
  };
}

/**
 * The identity rules, in one place so the preview and the execution cannot
 * disagree.
 *
 * Default is RETAIN. An identity is deletable only by proving every reason to
 * keep it is absent — never by failing to find a reason to keep it. The
 * difference matters when a new table starts referencing users: the unproven
 * case must fall on the retain side.
 */
async function classifyIdentity(
  db: Kysely<Database> | Transaction<Database>,
  member: { user_id: string; email: string; data_classification: string },
  organizationId: string,
): Promise<IdentityDisposition> {
  const elsewhere = await db
    .selectFrom('organization_memberships')
    .select('id')
    .where('user_id', '=', member.user_id)
    .where('organization_id', '!=', organizationId)
    .executeTakeFirst();

  if (elsewhere) {
    return {
      userId: member.user_id,
      email: member.email,
      outcome: 'retained_other_membership',
      detail: 'Belongs to another organization. Credentials are global, not owned by this subscriber.',
    };
  }

  const platformRole = await db
    .selectFrom('platform_user_roles')
    .select('role')
    .where('user_id', '=', member.user_id)
    .executeTakeFirst();

  if (platformRole) {
    return {
      userId: member.user_id,
      email: member.email,
      outcome: 'retained_platform_role',
      detail: `Holds the platform role ${platformRole.role}.`,
    };
  }

  if (member.data_classification !== 'test' && member.data_classification !== 'demo') {
    return {
      userId: member.user_id,
      email: member.email,
      outcome: 'retained_production',
      detail:
        'The identity is production-classified. Deleting a tenant never decides the fate of a person recorded as real.',
    };
  }

  return {
    userId: member.user_id,
    email: member.email,
    outcome: 'deletable',
    detail: 'Test/demo identity with no other membership and no platform role.',
  };
}

/**
 * The digest.
 *
 * Covers everything that would change the operator's decision: which tenants,
 * whether each is still eligible, its blockers, its classification and status,
 * and every count. Deliberately NOT the preview id or timestamps, which change
 * on every call and would make staleness detection meaningless.
 */
export function digestOf(candidates: CleanupCandidate[]): string {
  const material = candidates
    .map((c) =>
      [
        c.organizationId,
        c.classification,
        c.status,
        c.eligible ? '1' : '0',
        c.blockers.map((b) => b.code).sort().join('|'),
        c.counts.map((n) => `${n.key}=${n.count}`).sort().join('|'),
        c.identities.map((i) => `${i.userId}:${i.outcome}`).sort().join('|'),
      ].join('~'),
    )
    .sort()
    .join('\n');

  return createHash('sha256').update(material).digest('hex');
}

export async function previewCleanup(
  db: Kysely<Database>,
  organizationIds: string[],
): Promise<CleanupPreview> {
  if (organizationIds.length === 0) {
    throw errors.validation('Select at least one subscriber to preview.');
  }

  const candidates: CleanupCandidate[] = [];
  for (const organizationId of [...new Set(organizationIds)]) {
    const described = await describeCandidate(db, organizationId);
    if (described) {
      candidates.push(described);
      continue;
    }
    /*
     * An unknown id is shown as excluded rather than dropped. A silently
     * shorter list is how an operator ends up believing they reviewed something
     * they did not.
     */
    candidates.push({
      organizationId,
      legalName: '(not found)',
      classification: 'unknown',
      status: 'unknown',
      eligible: false,
      blockers: [{ code: 'not_found', message: 'No subscriber exists with this id.' }],
      everActivated: false,
      hasSubscriptionHistory: false,
      hasBusinessActivity: false,
      storedDocumentCount: 0,
      workspaceDataReachable: false,
      warnings: [],
      counts: [],
      identities: [],
      externalFileKeys: 0,
    });
  }

  return {
    previewId: randomUUID(),
    digest: digestOf(candidates),
    previewedAt: new Date().toISOString(),
    candidates,
    eligibleCount: candidates.filter((c) => c.eligible).length,
    excludedCount: candidates.filter((c) => !c.eligible).length,
  };
}

/** Every disposable tenant on the platform, for the "select all eligible" action. */
export async function previewAllDisposable(db: Kysely<Database>): Promise<CleanupPreview> {
  const rows = await db
    .selectFrom('organizations')
    .select('id')
    .where('data_classification', 'in', ['test', 'demo'])
    .execute();

  if (rows.length === 0) {
    return {
      previewId: randomUUID(),
      digest: digestOf([]),
      previewedAt: new Date().toISOString(),
      candidates: [],
      eligibleCount: 0,
      excludedCount: 0,
    };
  }

  return previewCleanup(db, rows.map((r) => r.id));
}

/* ══ Execution ═════════════════════════════════════════════════════════════ */

export interface CleanupExecutionInput {
  /** The subset actually being destroyed. Must be contained in the reviewed set. */
  organizationIds: string[];
  /**
   * Every id the preview covered, which is what `previewDigest` was computed
   * over.
   *
   * The console shows the whole disposable roster and lets an operator tick a
   * few rows, so "what was reviewed" and "what is being deleted" are genuinely
   * different sets. Binding the digest to the reviewed set keeps staleness
   * detection meaningful for a partial selection; binding it to the selection
   * would make every subset look stale, and widening it to "trust the client's
   * selection" would drop the guarantee entirely.
   *
   * Omitted means the two sets coincide.
   */
  previewedOrganizationIds?: string[];
  /** The digest the operator saw. Recomputed and compared before anything is destroyed. */
  previewDigest: string;
  previewedAt: string;
  reason: string;
  confirmation: string;
  /** Supplied by the client so a retried request maps to the same operation. */
  operationId?: string;
}

export interface OrganizationOutcome {
  organizationId: string;
  legalName: string;
  deleted: boolean;
  removed: Record<string, number>;
  identitiesDeleted: string[];
  identitiesRetained: string[];
  filesQueued: number;
  error?: string;
}

export interface CleanupResult {
  operationId: string;
  /** completed | completed_with_pending_cleanup | failed */
  outcome: string;
  organizations: OrganizationOutcome[];
  /** Database deletion and external cleanup are reported separately, always. */
  databaseDeletion: { succeeded: number; failed: number };
  externalCleanup: { pending: number; completed: number; failed: number };
  /**
   * The third layer, reported alongside the other two so a caller never has to
   * infer it. `no_server_workspace` says the books were never on the server and
   * this operation therefore did not delete them — it is not a success claim.
   */
  workspaceDeletion: { status: 'no_server_workspace'; detail: string };
  replayed: boolean;
}

/** The one honest value for this deployment. See `workspaceDataReachable`. */
export const WORKSPACE_DELETION_STATE = {
  status: 'no_server_workspace' as const,
  detail:
    'Accounting records live in each user’s browser workspace, not on the server. Deleting the account makes them unreachable through Ledgora, but it does not erase data already written to those browsers.',
};

export async function executeCleanup(
  db: Kysely<Database>,
  storage: FileStorage,
  input: CleanupExecutionInput,
  context: CleanupAdminContext,
): Promise<CleanupResult> {
  if (input.confirmation !== CLEANUP_CONFIRMATION) {
    throw errors.validation('The confirmation phrase does not match.', {
      fieldErrors: { confirmation: `Type ${CLEANUP_CONFIRMATION} exactly to confirm.` },
    });
  }

  const reason = input.reason?.trim() ?? '';
  if (reason.length < 10) {
    throw errors.validation('A reason is required and is recorded in the tombstone.', {
      fieldErrors: { reason: 'Explain why these subscribers are being permanently deleted.' },
    });
  }

  const organizationIds = [...new Set(input.organizationIds)];
  if (organizationIds.length === 0) {
    throw errors.validation('Select at least one subscriber.');
  }

  const operationId = input.operationId ?? randomUUID();

  /*
   * Idempotency, checked before any work. A double-submitted confirmation — a
   * double-clicked button, a retried request after a timeout — must return what
   * the first attempt did, not destroy a second set of tenants.
   */
  const existing = await db
    .selectFrom('cleanup_operations')
    .selectAll()
    .where('operation_id', '=', operationId)
    .executeTakeFirst();

  if (existing?.status === 'completed' && existing.result) {
    return { ...(existing.result as unknown as CleanupResult), replayed: true };
  }
  if (existing && existing.status === 'pending') {
    throw errors.conflict('This cleanup operation is already running.');
  }

  /*
   * The reviewed set. Defaulting to the selection keeps a caller that previews
   * exactly what it deletes working unchanged.
   */
  const previewedIds = [...new Set(input.previewedOrganizationIds ?? organizationIds)];

  /*
   * Selection ⊆ reviewed, checked explicitly.
   *
   * Without this the digest would be computed over `previewedIds` and would
   * happily match while `organizationIds` named a tenant that was never in the
   * preview at all — a hole that would let a caller append an id to the
   * selection and destroy something no human ever saw.
   */
  const notReviewed = organizationIds.filter((id) => !previewedIds.includes(id));
  if (notReviewed.length > 0) {
    throw errors.conflict(
      'Some selected subscribers were not part of the preview that was reviewed. Review a fresh preview before deleting anything.',
    );
  }

  /* ── Staleness: is the world still what the operator reviewed? ────────── */
  const current: CleanupCandidate[] = [];
  for (const organizationId of previewedIds) {
    const described = await describeCandidate(db, organizationId);
    if (described) current.push(described);
  }

  if (current.length !== previewedIds.length || digestOf(current) !== input.previewDigest) {
    throw errors.conflict(
      'The subscribers changed since the preview was taken. Review a fresh preview before deleting anything.',
    );
  }

  await db
    .insertInto('cleanup_operations')
    .values({
      operation_id: operationId,
      requested_by_user_id: context.actorUserId,
      preview_digest: input.previewDigest,
      organization_ids: organizationIds,
      reason,
      previewed_at: new Date(input.previewedAt),
      status: 'pending',
    })
    .execute();

  const outcomes: OrganizationOutcome[] = [];

  /*
   * One transaction PER organization, not one for the batch. A batch
   * transaction would mean a single failing tenant rolls back destructions that
   * already succeeded — including their tombstones — leaving no record that
   * anything happened. Per-tenant atomicity gives an accurate partial report.
   */
  for (const organizationId of organizationIds) {
    try {
      outcomes.push(await deleteOneOrganization(db, organizationId, operationId, reason, input, context));
    } catch (error) {
      outcomes.push({
        organizationId,
        legalName: current.find((c) => c.organizationId === organizationId)?.legalName ?? organizationId,
        deleted: false,
        removed: {},
        identitiesDeleted: [],
        identitiesRetained: [],
        filesQueued: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /* External cleanup runs AFTER commit — see runFileCleanup. */
  const externalCleanup = await runFileCleanup(db, storage, operationId);

  const succeeded = outcomes.filter((o) => o.deleted).length;
  const failed = outcomes.length - succeeded;

  const outcome =
    failed > 0
      ? 'failed'
      : externalCleanup.pending > 0 || externalCleanup.failed > 0
        ? 'completed_with_pending_cleanup'
        : 'completed';

  const result: CleanupResult = {
    operationId,
    outcome,
    organizations: outcomes,
    databaseDeletion: { succeeded, failed },
    externalCleanup,
    workspaceDeletion: WORKSPACE_DELETION_STATE,
    replayed: false,
  };

  await db
    .updateTable('cleanup_operations')
    .set({
      status: failed > 0 ? 'failed' : 'completed',
      result: JSON.stringify(result),
      completed_at: new Date(),
    })
    .where('operation_id', '=', operationId)
    .execute();

  /*
   * Reflect the true external state onto each tombstone.
   *
   * `outcome` here is per-TOMBSTONE, not the batch aggregate. A tombstone only
   * exists for a tenant whose database deletion committed, so stamping it
   * `failed` because a DIFFERENT tenant in the same batch failed would libel a
   * destruction that actually succeeded. Its own remaining risk is the external
   * layer, so that is what its outcome tracks.
   */
  const externalStatus =
    externalCleanup.failed > 0 ? 'failed' : externalCleanup.pending > 0 ? 'pending' : 'completed';

  await db
    .updateTable('subscriber_deletion_tombstones')
    .set({
      external_cleanup_status: externalStatus,
      outcome: externalStatus === 'completed' ? 'completed' : 'completed_with_pending_cleanup',
    })
    .where('operation_id', '=', operationId)
    // Only rows that had something queued; a tenant with no files stays `none`.
    .where('external_cleanup_status', '!=', 'none')
    .execute();

  return result;
}

/** One tenant, one transaction. Either it is entirely gone, or entirely intact. */
async function deleteOneOrganization(
  db: Kysely<Database>,
  organizationId: string,
  operationId: string,
  reason: string,
  input: CleanupExecutionInput,
  context: CleanupAdminContext,
): Promise<OrganizationOutcome> {
  return db.transaction().execute(async (trx) => {
    /*
     * Erasing an identity cascades into the append-only `legal_acceptances`
     * table. Authorise that removal for this transaction only. DELETE alone —
     * UPDATE stays refused unconditionally, so no record of consent can be
     * quietly rewritten on the way past.
     */
    await sql`SET LOCAL ledgora.allow_legal_purge = 'on'`.execute(trx);
    /*
     * FOR UPDATE. Everything after this point sees a tenant no other
     * transaction can modify, which is what makes the recheck below meaningful
     * rather than a second guess at a moving target.
     */
    const organization = await trx
      .selectFrom('organizations')
      .selectAll()
      .where('id', '=', organizationId)
      .forUpdate()
      .executeTakeFirst();

    if (!organization) throw errors.notFound('Subscriber');

    /* ── The final rechecks, from the locked row ─────────────────────────── */
    const classification = organization.data_classification;
    if (classification !== 'test' && classification !== 'demo') {
      throw errors.conflict(PRODUCTION_RETENTION_MESSAGE);
    }

    const impact = await assessSubscriberDeletion(trx, organizationId);
    if (!impact.deletionPermitted) {
      throw errors.conflict(impact.recommendation);
    }

    /* The write freeze, inside the lock. */
    await trx
      .updateTable('organizations')
      .set({ deletion_in_progress: true })
      .where('id', '=', organizationId)
      .execute();

    const members = await trx
      .selectFrom('organization_memberships')
      .innerJoin('users', 'users.id', 'organization_memberships.user_id')
      .select(['users.id as user_id', 'users.email', 'users.data_classification'])
      .where('organization_memberships.organization_id', '=', organizationId)
      .execute();

    const dispositions: IdentityDisposition[] = [];
    for (const member of members) {
      dispositions.push(await classifyIdentity(trx, member, organizationId));
    }

    /*
     * ── External keys recorded BEFORE the rows naming them are deleted ────
     * Committed in this transaction, so a crash immediately after leaves a
     * pending ledger row rather than an orphaned object nobody can name. Keys
     * are copied from the database, never reconstructed from a path.
     */
    const proofs = await trx
      .selectFrom('payment_proofs')
      .innerJoin('subscription_invoices', 'subscription_invoices.id', 'payment_proofs.invoice_id')
      .select(['payment_proofs.id as proof_id', 'payment_proofs.storage_key'])
      .where('subscription_invoices.organization_id', '=', organizationId)
      .execute();

    for (const proof of proofs) {
      await trx
        .insertInto('file_cleanup_queue')
        .values({
          operation_id: operationId,
          organization_id: organizationId,
          storage_key: proof.storage_key,
          source_table: 'payment_proofs',
          source_id: proof.proof_id,
        })
        .onConflict((oc) => oc.columns(['operation_id', 'storage_key']).doNothing())
        .execute();
    }

    /* ── Revoke access before destroying anything ────────────────────────── */
    let revokedSessions = 0;
    for (const disposition of dispositions) {
      /*
       * Sessions are keyed to a person, not a tenant, and this session model has
       * no per-organization scoping. So access is revoked only for identities
       * losing their LAST membership — revoking for a user who still belongs
       * elsewhere would log them out of an organization this operation has no
       * business touching.
       */
      if (disposition.outcome === 'retained_other_membership') continue;

      const revoked = await trx
        .deleteFrom('auth_sessions')
        .where('user_id', '=', disposition.userId)
        .executeTakeFirst();
      revokedSessions += Number(revoked.numDeletedRows ?? 0);

      await trx.deleteFrom('password_reset_tokens').where('user_id', '=', disposition.userId).execute();
    }

    /* ── Tenant-owned rows, in reviewed order ────────────────────────────── */
    const removed: Record<string, number> = { auth_sessions: revokedSessions };

    // Permanent cleanup retires the live shell but preserves its immutable
    // subscriber/workspace claim. The trigger permits owner-row deletion only
    // after this marker is set in the same all-or-nothing transaction.
    await sql`UPDATE subscriber_workspace_ownership_claims
      SET retired_at = now()
      WHERE workspace_id = ${organizationId} AND retired_at IS NULL`.execute(trx);

    const proofIds = proofs.map((p) => p.proof_id);
    if (proofIds.length > 0) {
      const result = await trx.deleteFrom('payment_proofs').where('id', 'in', proofIds).executeTakeFirst();
      removed.payment_proofs = Number(result.numDeletedRows ?? 0);
    } else {
      removed.payment_proofs = 0;
    }

    for (const dependency of DELETION_SEQUENCE) {
      if (dependency.table === 'payment_proofs' || dependency.table === 'organizations') continue;

      const result = await trx
        .deleteFrom(dependency.table as (typeof DIRECTLY_OWNED_TABLES)[number])
        .where('organization_id', '=', organizationId)
        .executeTakeFirst();
      removed[dependency.table] = Number(result.numDeletedRows ?? 0);
    }

    const organizationResult = await trx
      .deleteFrom('organizations')
      .where('id', '=', organizationId)
      .executeTakeFirst();
    removed.organizations = Number(organizationResult.numDeletedRows ?? 0);

    /* ── Identities, only now that the organization is provably gone ─────── */
    const identitiesDeleted: string[] = [];
    const identitiesRetained: string[] = [];

    for (const disposition of dispositions) {
      if (disposition.outcome !== 'deletable') {
        identitiesRetained.push(disposition.userId);
        continue;
      }

      /*
       * Re-proved after the deletes, not taken from the preview: the membership
       * rows this depends on were still present when `classifyIdentity` ran.
       */
      const stillMember = await trx
        .selectFrom('organization_memberships')
        .select('id')
        .where('user_id', '=', disposition.userId)
        .executeTakeFirst();

      const namedInAudit = await trx
        .selectFrom('audit_logs')
        .select('id')
        .where((eb) =>
          eb.or([eb('actor_user_id', '=', disposition.userId), eb('target_id', '=', disposition.userId)]),
        )
        .executeTakeFirst();

      if (stillMember || namedInAudit) {
        // Audit evidence names this person; the identity stays so the trail reads.
        identitiesRetained.push(disposition.userId);
        continue;
      }

      await trx.deleteFrom('subscription_applications').where('user_id', '=', disposition.userId).execute();
      await trx.deleteFrom('users').where('id', '=', disposition.userId).execute();
      identitiesDeleted.push(disposition.userId);
    }

    /* ── The tombstone, in the same transaction as the destruction ───────── */
    const actor = await trx
      .selectFrom('users')
      .select('email')
      .where('id', '=', context.actorUserId)
      .executeTakeFirst();

    await trx
      .insertInto('subscriber_deletion_tombstones')
      .values({
        operation_id: operationId,
        request_id: context.requestId ?? null,
        organization_id: organizationId,
        deleted_by_user_id: context.actorUserId,
        legal_name: organization.legal_name,
        deleted_by_email: actor?.email ?? null,
        classification_at_deletion: classification,
        reason,
        previewed_at: new Date(input.previewedAt),
        removed_counts: JSON.stringify(removed),
        identities_deleted: identitiesDeleted,
        identities_retained: identitiesRetained,
        /*
         * This transaction is about to commit, so the database layer IS
         * complete. The other two layers are not this transaction's to claim:
         * the files have not been attempted yet, and there is no server-side
         * workspace to delete at all.
         */
        database_deletion_status: 'completed',
        workspace_deletion_status: 'no_server_workspace',
        external_cleanup_status: proofs.length > 0 ? 'pending' : 'none',
        outcome: proofs.length > 0 ? 'completed_with_pending_cleanup' : 'completed',
      })
      .execute();

    await writeAuditLog(trx, {
      ...context,
      organizationId: null,
      action: 'subscriber.purged',
      targetType: 'organization',
      targetId: organizationId,
      metadata: {
        operationId,
        reason,
        legalName: organization.legal_name,
        classification,
        removed,
        identitiesDeleted: identitiesDeleted.length,
        identitiesRetained: identitiesRetained.length,
        filesQueued: proofs.length,
        mechanism: 'disposable_cleanup',
      },
    });

    return {
      organizationId,
      legalName: organization.legal_name,
      deleted: true,
      removed,
      identitiesDeleted,
      identitiesRetained,
      filesQueued: proofs.length,
    };
  });
}

/* ══ External cleanup ══════════════════════════════════════════════════════ */

export interface ExternalCleanupSummary {
  pending: number;
  completed: number;
  failed: number;
}

/**
 * Work the ledger.
 *
 * Idempotent by construction: it reads pending rows, and a completed row is
 * never revisited. "Already absent" counts as success — the goal is that the
 * object does not exist, and a delete of something already gone has achieved
 * exactly that.
 *
 * Runs inline after commit because this repository has no worker process. A
 * failure here leaves the row pending and is reported as such; it never turns
 * into a claim that cleanup finished.
 */
export async function runFileCleanup(
  db: Kysely<Database>,
  storage: FileStorage,
  operationId?: string,
): Promise<ExternalCleanupSummary> {
  let query = db.selectFrom('file_cleanup_queue').selectAll().where('status', '!=', 'completed');
  if (operationId) query = query.where('operation_id', '=', operationId);

  const rows = await query.execute();

  for (const row of rows) {
    try {
      await storage.delete(row.storage_key);
      await db
        .updateTable('file_cleanup_queue')
        .set({
          status: 'completed',
          attempts: row.attempts + 1,
          last_attempted_at: new Date(),
          completed_at: new Date(),
          last_error: null,
        })
        .where('id', '=', row.id)
        .execute();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      /*
       * Already gone is the desired end state, not a failure. Treating it as one
       * would leave rows retrying forever against objects that do not exist.
       */
      if (/not found|ENOENT|NoSuchKey/i.test(message)) {
        await db
          .updateTable('file_cleanup_queue')
          .set({
            status: 'completed',
            attempts: row.attempts + 1,
            last_attempted_at: new Date(),
            completed_at: new Date(),
            last_error: null,
          })
          .where('id', '=', row.id)
          .execute();
        continue;
      }

      await db
        .updateTable('file_cleanup_queue')
        .set({
          status: 'pending',
          attempts: row.attempts + 1,
          last_attempted_at: new Date(),
          last_error: message.slice(0, 500),
        })
        .where('id', '=', row.id)
        .execute();
    }
  }

  return summariseExternalCleanup(db, operationId);
}

export async function summariseExternalCleanup(
  db: Kysely<Database>,
  operationId?: string,
): Promise<ExternalCleanupSummary> {
  let query = db.selectFrom('file_cleanup_queue').select(['status']);
  if (operationId) query = query.where('operation_id', '=', operationId);
  const rows = await query.execute();

  return {
    pending: rows.filter((r) => r.status === 'pending').length,
    completed: rows.filter((r) => r.status === 'completed').length,
    failed: rows.filter((r) => r.status === 'failed').length,
  };
}

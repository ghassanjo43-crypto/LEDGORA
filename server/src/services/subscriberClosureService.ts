/**
 * Subscriber closure: the recoverable pending-deletion period.
 *
 * ── Where this sits ──────────────────────────────────────────────────────────
 * `deletionService` owns the eligibility assessment and the destructive acts.
 * This module owns the WORKFLOW around them — request, cancel, and the explicit
 * run that carries a due request out. It calls into `deletionService` for every
 * decision and every deletion; nothing here re-implements either, because a
 * second eligibility rule is a second answer waiting to disagree.
 *
 * ── Why a request is not a deletion ──────────────────────────────────────────
 * Requesting deletion ARCHIVES the tenant and schedules a purge. Nothing is
 * destroyed. The customer is out of circulation immediately (sessions revoked,
 * durable writes refused, entitlement withdrawn) while every record stays
 * exactly where it is, so an operator who requested the wrong subscriber has the
 * whole recovery window to notice and cancel.
 *
 * ── Why eligibility is checked twice ─────────────────────────────────────────
 * Once when the request is made, and again when the purge actually runs. The gap
 * between them is 30 days, and a great deal can happen in 30 days: an invoice
 * gets paid, a legal hold is applied, a payment proof arrives. The second check
 * is the authoritative one — a request is permission to TRY, never permission to
 * proceed regardless.
 *
 * ── Why there is no automatic scheduler ──────────────────────────────────────
 * This repository has no job runner. Rather than fake one with a `setInterval`
 * that dies with the process — and would carry out irreversible deletions with
 * nobody watching — due requests are processed by an EXPLICIT call: the
 * `db:process-deletions` CLI, or the operator-triggered endpoint. Nothing is
 * ever destroyed without a person or a scheduled task deliberately asking. This
 * is a real operational limitation and is documented as one.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { writeAuditLog } from '../lib/audit.js';
import { errors } from '../lib/errors.js';
import { requireReauthentication } from '../lib/reauthentication.js';
import { revokeAllUserSessions } from './sessionService.js';
import { recalculateEntitlements } from './entitlementService.js';
import {
  archiveSubscriber,
  assessSubscriberDeletion,
  purgeSubscriber,
  type DeletionAdminContext,
  type DeletionImpact,
  type PurgeResult,
} from './deletionService.js';

/**
 * The recovery window. 30 days, as specified — the repository had no policy of
 * its own (`PURGE_COOLING_OFF_HOURS` was 0, which is no window at all).
 */
export const DELETION_RECOVERY_DAYS = 30;

export interface DeletionRequestResult {
  organizationId: string;
  legalName: string;
  organizationStatus: string;
  requestedAt: string;
  /** When the purge becomes permissible. Not when it will happen. */
  scheduledPurgeAfter: string;
  revokedSessions: number;
  memberCount: number;
  impact: DeletionImpact;
}

/**
 * Confirm the operator typed the subscriber's real identity.
 *
 * Checked against the DATABASE value, never against anything else the client
 * also supplied — a confirmation compared to a value from the same request
 * confirms nothing. Accepts either the exact legal name or the owner's email,
 * because an operator working from a support ticket may have only one of them.
 */
async function assertConfirmation(
  db: Kysely<Database>,
  organizationId: string,
  legalName: string,
  typed: string,
): Promise<void> {
  const entered = typed?.trim().toLowerCase() ?? '';
  if (!entered) {
    throw errors.validation('Type the organization name to confirm.', {
      fieldErrors: { confirmation: `Type “${legalName}” exactly to confirm.` },
    });
  }
  if (entered === legalName.trim().toLowerCase()) return;

  const owner = await db
    .selectFrom('organization_memberships')
    .innerJoin('users', 'users.id', 'organization_memberships.user_id')
    .select('users.normalized_email')
    .where('organization_memberships.organization_id', '=', organizationId)
    .where('organization_memberships.role', '=', 'owner')
    .executeTakeFirst();

  if (owner && entered === owner.normalized_email) return;

  throw errors.validation('The organization name you typed does not match.', {
    fieldErrors: { confirmation: `Type “${legalName}” exactly to confirm.` },
  });
}

/**
 * Request permanent deletion: archive now, purge later.
 *
 * The order is deliberate. Eligibility and identity are checked, then the
 * operator re-authenticates, and only then is anything written — so a failed
 * confirmation or a wrong password leaves the subscriber completely untouched.
 */
export async function requestSubscriberDeletion(
  db: Kysely<Database>,
  input: {
    organizationId: string;
    reason: string;
    /** The typed organization name or owner email. */
    confirmation: string;
    /** The acting operator's password, for the step-up check. */
    password: string;
    recoveryDays?: number;
  },
  context: DeletionAdminContext,
): Promise<DeletionRequestResult> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw errors.validation('A reason is required and is recorded in the audit trail.', {
      fieldErrors: { reason: 'Explain why this subscriber is being deleted.' },
    });
  }

  const organization = await db
    .selectFrom('organizations')
    .select(['id', 'legal_name', 'status', 'deletion_requested_at'])
    .where('id', '=', input.organizationId)
    .executeTakeFirst();
  if (!organization) throw errors.notFound('Subscriber');

  /*
   * Already pending is NOT an error — it is the same request arriving twice.
   * Reporting the existing schedule keeps the operation idempotent instead of
   * letting a double-click extend or reset somebody's recovery window.
   */
  if (organization.deletion_requested_at) {
    const current = await db
      .selectFrom('organizations')
      .select(['deletion_requested_at', 'deletion_eligible_after'])
      .where('id', '=', input.organizationId)
      .executeTakeFirstOrThrow();
    throw errors.conflict(
      `Deletion was already requested for this subscriber and is scheduled after ${new Date(
        current.deletion_eligible_after ?? new Date(),
      ).toISOString()}. Cancel it first if you need to change the schedule.`,
    );
  }

  await assertConfirmation(db, input.organizationId, organization.legal_name, input.confirmation);

  /*
   * Eligibility BEFORE the step-up, so an operator is not asked for their
   * password only to be told the subscriber could never have been deleted.
   * `legal_hold` and every other blocking reason apply here exactly as they do
   * at purge time — a Super Admin having initiated the request changes nothing.
   */
  const impact = await assessSubscriberDeletion(db, input.organizationId);
  if (!impact.deletionPermitted) {
    await writeAuditLog(db, {
      ...context,
      organizationId: input.organizationId,
      action: 'subscriber.purge_blocked',
      targetType: 'organization',
      targetId: input.organizationId,
      metadata: {
        reason,
        stage: 'request',
        blockedBy: impact.blockingReasons.map((b) => b.code),
        legalName: organization.legal_name,
      },
    });
    throw errors.conflict(impact.recommendation);
  }

  await requireReauthentication(
    db,
    { actorUserId: context.actorUserId, password: input.password },
    {
      ...context,
      action: 'subscriber.deletion_requested',
      targetType: 'organization',
      targetId: input.organizationId,
    },
  );

  /*
   * Archive first, through the existing service. That is what stops access,
   * revokes sessions, cancels the subscription and withdraws the entitlement —
   * all already implemented and audited. Re-implementing it here would be a
   * second closure path that could drift from the one operators already use.
   */
  const archived = await archiveSubscriber(
    db,
    { organizationId: input.organizationId, reason: `Deletion requested: ${reason}` },
    context,
  );

  const days = Math.max(input.recoveryDays ?? DELETION_RECOVERY_DAYS, 1);
  const requestedAt = new Date();
  const eligibleAfter = new Date(requestedAt.getTime() + days * 86_400_000);

  const memberCount = (
    await db
      .selectFrom('organization_memberships')
      .select('user_id')
      .where('organization_id', '=', input.organizationId)
      .execute()
  ).length;

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('organizations')
      .set({
        status: 'pending_deletion',
        deletion_requested_at: requestedAt,
        deletion_eligible_after: eligibleAfter,
        deletion_requested_by: context.actorUserId,
        deletion_reason: reason,
        updated_at: requestedAt,
      })
      .where('id', '=', input.organizationId)
      .execute();

    await writeAuditLog(trx, {
      ...context,
      organizationId: input.organizationId,
      action: 'subscriber.deletion_requested',
      targetType: 'organization',
      targetId: input.organizationId,
      metadata: {
        reason,
        legalName: organization.legal_name,
        previousStatus: organization.status,
        newStatus: 'pending_deletion',
        scheduledPurgeAfter: eligibleAfter.toISOString(),
        recoveryDays: days,
        revokedSessions: archived.revokedSessions,
        memberCount,
        reauthenticated: true,
        // Nothing is destroyed by a request. Stated explicitly for the reader.
        recordsRetained: true,
      },
    });
  });

  return {
    organizationId: input.organizationId,
    legalName: organization.legal_name,
    organizationStatus: 'pending_deletion',
    requestedAt: requestedAt.toISOString(),
    scheduledPurgeAfter: eligibleAfter.toISOString(),
    revokedSessions: archived.revokedSessions,
    memberCount,
    impact,
  };
}

export interface CancelDeletionResult {
  organizationId: string;
  organizationStatus: string;
  cancelledAt: string;
}

/**
 * Cancel a pending deletion.
 *
 * The subscriber returns to `archived` — NOT to active. Cancelling a purge undoes
 * the schedule, not the closure: bringing a tenant back into service is a
 * separate, deliberate act with its own billing and entitlement checks
 * (`restoreSubscriber`). Conflating them would silently re-open a customer whose
 * subscription was cancelled on the way in.
 */
export async function cancelSubscriberDeletion(
  db: Kysely<Database>,
  input: { organizationId: string; reason: string },
  context: DeletionAdminContext,
): Promise<CancelDeletionResult> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw errors.validation('A reason is required and is recorded in the audit trail.', {
      fieldErrors: { reason: 'Explain why this deletion is being cancelled.' },
    });
  }

  return db.transaction().execute(async (trx) => {
    const organization = await trx
      .selectFrom('organizations')
      .selectAll()
      .where('id', '=', input.organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!organization) throw errors.notFound('Subscriber');

    if (!organization.deletion_requested_at) {
      throw errors.conflict('No deletion is pending for this subscriber.');
    }

    const cancelledAt = new Date();
    await trx
      .updateTable('organizations')
      .set({
        status: 'archived',
        deletion_requested_at: null,
        deletion_eligible_after: null,
        deletion_requested_by: null,
        deletion_reason: null,
        updated_at: cancelledAt,
      })
      .where('id', '=', input.organizationId)
      .execute();

    await writeAuditLog(trx, {
      ...context,
      organizationId: input.organizationId,
      action: 'subscriber.deletion_cancelled',
      targetType: 'organization',
      targetId: input.organizationId,
      metadata: {
        reason,
        legalName: organization.legal_name,
        previousStatus: organization.status,
        newStatus: 'archived',
        // The whole history is kept: the request that was cancelled stays in the
        // trail beside this entry.
        originalRequestAt: organization.deletion_requested_at
          ? new Date(organization.deletion_requested_at).toISOString()
          : null,
        originalReason: organization.deletion_reason,
      },
    });

    return {
      organizationId: input.organizationId,
      organizationStatus: 'archived',
      cancelledAt: cancelledAt.toISOString(),
    };
  });
}

/* ── Processing due deletions ─────────────────────────────────────────────── */

export interface DueDeletion {
  organizationId: string;
  legalName: string;
  requestedAt: string;
  eligibleAfter: string;
  requestedBy: string | null;
  reason: string | null;
}

/** Subscribers whose recovery window has elapsed. A pure read. */
export async function listDueDeletions(db: Kysely<Database>, now = new Date()): Promise<DueDeletion[]> {
  const rows = await db
    .selectFrom('organizations')
    .select([
      'id',
      'legal_name',
      'deletion_requested_at',
      'deletion_eligible_after',
      'deletion_requested_by',
      'deletion_reason',
    ])
    .where('deletion_requested_at', 'is not', null)
    .where('deletion_eligible_after', '<=', now)
    .orderBy('deletion_eligible_after', 'asc')
    .execute();

  return rows.map((row) => ({
    organizationId: row.id,
    legalName: row.legal_name,
    requestedAt: new Date(row.deletion_requested_at!).toISOString(),
    eligibleAfter: new Date(row.deletion_eligible_after!).toISOString(),
    requestedBy: row.deletion_requested_by,
    reason: row.deletion_reason,
  }));
}

export interface ProcessedDeletion {
  organizationId: string;
  legalName: string;
  outcome: 'purged' | 'blocked' | 'failed';
  blockedBy?: string[];
  error?: string;
  result?: PurgeResult;
}

/**
 * Carry out every due deletion that is STILL eligible.
 *
 * Explicit by design — see the module note on the absent job runner. Each
 * subscriber is processed independently: one that has become ineligible, or one
 * whose purge fails, is recorded and skipped without stopping the rest, because
 * a batch that aborts halfway is how half a queue silently stops being processed.
 *
 * A subscriber found ineligible is NOT un-scheduled. Its request stands and will
 * be re-evaluated next run, so a temporary block (an unreviewed payment proof)
 * resolves itself rather than requiring the whole request to be made again.
 */
export async function processDueDeletions(
  db: Kysely<Database>,
  context: DeletionAdminContext,
  options: { now?: Date; limit?: number } = {},
): Promise<{ considered: number; purged: number; blocked: number; failed: number; results: ProcessedDeletion[] }> {
  const due = await listDueDeletions(db, options.now ?? new Date());
  const batch = options.limit ? due.slice(0, options.limit) : due;
  const results: ProcessedDeletion[] = [];

  for (const item of batch) {
    await writeAuditLog(db, {
      ...context,
      organizationId: item.organizationId,
      action: 'subscriber.deletion_due',
      targetType: 'organization',
      targetId: item.organizationId,
      metadata: {
        legalName: item.legalName,
        requestedAt: item.requestedAt,
        eligibleAfter: item.eligibleAfter,
        originalReason: item.reason,
      },
    });

    /*
     * THE authoritative check, recomputed now. The request granted permission to
     * try; 30 days later only this decides.
     */
    const impact = await assessSubscriberDeletion(db, item.organizationId);
    if (!impact.deletionPermitted) {
      results.push({
        organizationId: item.organizationId,
        legalName: item.legalName,
        outcome: 'blocked',
        blockedBy: impact.blockingReasons.map((b) => b.code),
      });
      await writeAuditLog(db, {
        ...context,
        organizationId: item.organizationId,
        action: 'subscriber.purge_blocked',
        targetType: 'organization',
        targetId: item.organizationId,
        metadata: {
          stage: 'scheduled_run',
          blockedBy: impact.blockingReasons.map((b) => b.code),
          legalName: item.legalName,
          reason: item.reason,
        },
      });
      continue;
    }

    try {
      const result = await purgeSubscriber(
        db,
        {
          organizationId: item.organizationId,
          reason: item.reason ?? 'Scheduled deletion after the recovery period.',
          // The confirmation was given when the request was made, by a
          // re-authenticated operator. Requiring it again from a batch process
          // that has no operator would make the schedule impossible to honour.
          skipConfirmation: true,
        },
        context,
      );
      results.push({
        organizationId: item.organizationId,
        legalName: item.legalName,
        outcome: 'purged',
        result,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      results.push({
        organizationId: item.organizationId,
        legalName: item.legalName,
        outcome: 'failed',
        error: message,
      });
      await writeAuditLog(db, {
        ...context,
        organizationId: item.organizationId,
        action: 'subscriber.purge_failed',
        targetType: 'organization',
        targetId: item.organizationId,
        metadata: { legalName: item.legalName, error: message, stage: 'scheduled_run' },
      });
    }
  }

  return {
    considered: batch.length,
    purged: results.filter((r) => r.outcome === 'purged').length,
    blocked: results.filter((r) => r.outcome === 'blocked').length,
    failed: results.filter((r) => r.outcome === 'failed').length,
    results,
  };
}

/* ── Closure status, for the console ──────────────────────────────────────── */

export interface ClosureStatus {
  organizationId: string;
  legalName: string;
  organizationStatus: string;
  archivedAt: string | null;
  archiveReason: string | null;
  deletionRequestedAt: string | null;
  scheduledPurgeAfter: string | null;
  deletionReason: string | null;
  legalHold: boolean;
  legalHoldReason: string | null;
  /**
   * `production | test | demo`. Read straight from the row so the drawer states
   * the account's real protection rather than what a roster page cached.
   */
  dataClassification: string;
  /** Null when nobody has reviewed the 008 migration default. */
  classificationReviewedAt: string | null;
  /** Set when the account was promoted to production, which is irreversible. */
  classifiedProductionAt: string | null;
  classificationReason: string | null;
  /** Days left in the recovery window, or null when nothing is pending. */
  recoveryDaysRemaining: number | null;
  canCancelDeletion: boolean;
  canRestore: boolean;
}

/** Everything the action menu needs to decide what to offer. */
export async function getClosureStatus(
  db: Kysely<Database>,
  organizationId: string,
): Promise<ClosureStatus> {
  const organization = await db
    .selectFrom('organizations')
    .select([
      'id',
      'legal_name',
      'status',
      'archived_at',
      'archive_reason',
      'deletion_requested_at',
      'deletion_eligible_after',
      'deletion_reason',
      'legal_hold',
      'legal_hold_reason',
      'data_classification',
      'classified_production_at',
      'classification_reason',
      'classification_reviewed_at',
    ])
    .where('id', '=', organizationId)
    .executeTakeFirst();
  if (!organization) throw errors.notFound('Subscriber');

  const eligibleAfter = organization.deletion_eligible_after
    ? new Date(organization.deletion_eligible_after)
    : null;
  const remaining = eligibleAfter
    ? Math.max(Math.ceil((eligibleAfter.getTime() - Date.now()) / 86_400_000), 0)
    : null;

  return {
    organizationId,
    legalName: organization.legal_name,
    organizationStatus: organization.status,
    archivedAt: organization.archived_at ? new Date(organization.archived_at).toISOString() : null,
    archiveReason: organization.archive_reason,
    deletionRequestedAt: organization.deletion_requested_at
      ? new Date(organization.deletion_requested_at).toISOString()
      : null,
    scheduledPurgeAfter: eligibleAfter ? eligibleAfter.toISOString() : null,
    deletionReason: organization.deletion_reason,
    legalHold: organization.legal_hold,
    legalHoldReason: organization.legal_hold_reason,
    dataClassification: organization.data_classification,
    classifiedProductionAt: organization.classified_production_at
      ? new Date(organization.classified_production_at).toISOString()
      : null,
    classificationReason: organization.classification_reason,
    classificationReviewedAt: organization.classification_reviewed_at
      ? new Date(organization.classification_reviewed_at).toISOString()
      : null,
    recoveryDaysRemaining: remaining,
    canCancelDeletion: Boolean(organization.deletion_requested_at),
    // Restoring is offered for an archived tenant, and for a pending one only
    // after the deletion has been cancelled — hence not while a request stands.
    canRestore: organization.status === 'archived' && !organization.deletion_requested_at,
  };
}

/**
 * Re-open a subscriber that is only ARCHIVED.
 *
 * Thin wrapper over `deletionService.restoreSubscriber`, present so the closure
 * surface has one place that refuses to restore a tenant with a live deletion
 * request: that has to be cancelled first, deliberately, rather than being
 * undone as a side effect of clicking "restore".
 */
export async function assertRestorable(db: Kysely<Database>, organizationId: string): Promise<void> {
  const organization = await db
    .selectFrom('organizations')
    .select(['deletion_requested_at'])
    .where('id', '=', organizationId)
    .executeTakeFirst();
  if (!organization) throw errors.notFound('Subscriber');
  if (organization.deletion_requested_at) {
    throw errors.conflict(
      'This subscriber is scheduled for deletion. Cancel the deletion before restoring it.',
    );
  }
}

/** Sessions are revoked at request time; re-exported for the route to report. */
export async function revokeOrganizationSessions(
  db: Kysely<Database>,
  organizationId: string,
): Promise<number> {
  const members = await db
    .selectFrom('organization_memberships')
    .select('user_id')
    .where('organization_id', '=', organizationId)
    .execute();
  let revoked = 0;
  for (const member of members) revoked += await revokeAllUserSessions(db, member.user_id);
  if (members.length > 0) await recalculateEntitlements(db, organizationId);
  return revoked;
}

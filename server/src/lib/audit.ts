/**
 * Audit logging.
 *
 * Append-only record of who did what. Written inside the same transaction as
 * the action it describes wherever a transaction exists, so an audited change
 * can never be committed without its audit row.
 *
 * Metadata is caller-supplied and MUST NOT contain credentials, tokens or
 * password hashes; `sanitiseMetadata` strips known-sensitive keys as a backstop.
 */
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/schema.js';

export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.logout_all'
  | 'auth.register'
  | 'auth.password_changed'
  | 'auth.session_revoked'
  | 'auth.account_locked'
  | 'admin.bootstrap'
  | 'admin.created'
  | 'platform_role.assigned'
  | 'platform_role.revoked'
  | 'user.status_changed'
  | 'bank_details.updated'
  | 'billing_settings.updated'
  | 'plan.created'
  | 'plan.updated'
  | 'plan.archived'
  | 'plan.restored'
  | 'organization.created'
  /**
   * Member management. Recorded with `actorUserId` = the caller, so an action a
   * platform administrator performs inside a subscriber workspace is attributed
   * to the ADMINISTRATOR and never to the subscriber's owner.
   */
  | 'member.invited'
  | 'member.role_changed'
  | 'member.status_changed'
  | 'member.removed'
  /**
   * Member administration from the platform console. Every one of these is a
   * write performed on somebody else's account, so none of them is optional:
   * the audit row is written in the same transaction as the change.
   */
  | 'member.password_reset_temporary'
  | 'member.password_reset_link_issued'
  | 'member.account_unlocked'
  | 'member.sessions_revoked'
  | 'member.account_status_changed'
  | 'member.email_verified_by_admin'
  | 'organization.owner_changed'
  | 'organization.status_changed'
  | 'organization.notes_updated'
  /**
   * A development-only reclassification of legacy data (see
   * services/classificationService). Its own action, never reusing an ordinary
   * one, so this can be found in a trail without knowing to look for it.
   */
  | 'organization.classification_bootstrapped'
  /**
   * An ordinary reclassification through the console: promotion to production,
   * or one disposable flavour to the other. Distinct from the bootstrap action
   * above, which is the development-only escape hatch — conflating them would
   * hide the dangerous one inside the traffic of the routine one.
   */
  | 'organization.classification_changed'
  /**
   * A human confirmed the classification the 008 migration defaulted. Records
   * that somebody looked; changes no classification. Distinct from
   * `classification_changed` so "reviewed the default" and "moved between
   * classifications" stay countable apart in the trail.
   */
  | 'organization.classification_reviewed'
  | 'subscriber.created'
  | 'subscription.package_assigned'
  | 'entitlement.recalculated'
  /**
   * Removal, archival and deletion. Each is a DISTINCT action so the trail can
   * never blur "the member left this organization" into "the account was
   * destroyed" — and so a purge is searchable on its own.
   */
  | 'member.removed_from_organization'
  | 'member.account_disabled'
  | 'member.account_deleted'
  | 'member.account_anonymized'
  | 'applicant.deleted'
  | 'subscriber.archived'
  | 'subscriber.restored'
  | 'subscriber.deletion_requested'
  | 'subscriber.purged'
  | 'subscriber.purge_blocked'
  | 'subscriber.legal_hold_changed'
  | 'subscription.plan_selected'
  | 'subscription.confirmed'
  | 'payment_proof.submitted'
  | 'payment_proof.approved'
  | 'payment_proof.rejected'
  | 'payment_proof.information_requested'
  | 'subscription.activated'
  | 'subscription.suspended'
  | 'subscription.cancelled'
  | 'subscription.renewed'
  | 'applicant.suspended'
  | 'applicant.archived'
  | 'applicant.restored'
  | 'applicant.reminder_requested'
  /**
   * User administration and permissions.
   *
   * `permission.granted` / `.denied` / `.reset` are written one per CELL, so the
   * trail answers "who gave this person the right to post journals, and when?"
   * rather than only "somebody edited their permissions". Each carries its
   * previous and new value; none carries a credential.
   */
  | 'user.created_by_admin'
  | 'user.organization_assigned'
  | 'user.organization_transferred'
  | 'permission.granted'
  | 'permission.denied'
  | 'permission.reset'
  | 'permission.reset_all'
  /**
   * A REFUSED attempt to grant authority the actor does not hold, or to reach
   * outside their own tenant. Recorded because a rejected escalation that leaves
   * no trace is indistinguishable from one that never happened.
   */
  | 'permission.escalation_rejected'
  | 'platform_role.escalation_rejected'
  /**
   * The invitation lifecycle. Creation, redemption and revocation are separate
   * events because they are separate facts — a link that was issued and never
   * used is a different situation from one that was used.
   */
  | 'invitation.created'
  | 'invitation.redeemed'
  | 'invitation.revoked'
  | 'auth.password_reset_completed'
  /**
   * An `invited` membership became `active` because its holder established their
   * own password — the single onboarding milestone, reached through either
   * credential path. Distinct from `member.status_changed`, which is an
   * ADMINISTRATOR changing someone's membership: this one the member did
   * themselves, and the trail should not blur the two.
   */
  | 'membership.activated'
  /**
   * Subscriber closure. Cancelling a purge and the scheduled run itself are
   * separate facts from requesting one (`subscriber.deletion_requested`, above)
   * — a cancelled request must never look like one that was carried out.
   */
  | 'subscriber.deletion_cancelled'
  | 'subscriber.deletion_due'
  | 'subscriber.purge_failed'
  /** Step-up authentication refused an irreversible act. */
  | 'auth.reauthentication_failed'
  /**
   * Data export lifecycle. Creation, download, expiry and revocation are
   * recorded because an export is a copy of a tenant's records leaving the
   * system, and "who took it, and when?" must be answerable.
   */
  | 'subscriber.export_created'
  | 'subscriber.export_downloaded'
  | 'subscriber.export_failed'
  | 'subscriber.export_revoked'
  /**
   * Subscriber-level user management. The invitation lifecycle gets distinct
   * actions because "issued", "resent" and "cancelled" are separate facts — a
   * cancelled invitation must never read as one that was merely superseded.
   */
  | 'member.invitation_resent'
  | 'member.invitation_cancelled'
  /**
   * A refusal, not a change: the plan was full. Recorded because "why could we
   * not add anyone?" is a commercial question the trail should answer.
   */
  | 'member.seat_limit_reached';

export interface AuditContext {
  actorUserId?: string | null;
  actorPlatformRole?: string | null;
  organizationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  /**
   * Correlation identifier for the request that caused this entry — Fastify's
   * `request.id`. Optional, because not every audited act comes from an HTTP
   * request (CLI bootstrap, background recalculation).
   *
   * Folded into `metadata.requestId` by `writeAuditLog` rather than given a
   * column of its own: it is diagnostic context, and adding a column would mean
   * a migration for something no query filters on.
   */
  requestId?: string | null;
}

export interface AuditEntryInput extends AuditContext {
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

const SENSITIVE_KEYS = /password|token|secret|hash|authorization|cookie|credential/i;

export function sanitiseMetadata(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_KEYS.test(key)) {
      clean[key] = '[redacted]';
      continue;
    }
    clean[key] = typeof value === 'object' && value !== null ? JSON.parse(JSON.stringify(value)) : value;
  }
  return clean;
}

/** `db` may be a transaction handle — pass one to keep the audit atomic. */
export async function writeAuditLog(db: Kysely<Database>, entry: AuditEntryInput): Promise<void> {
  /*
   * The correlation id is added AFTER sanitisation, not before: it is a
   * generated request identifier rather than caller-supplied metadata, so it
   * neither needs redacting nor should be redactable by a key-name collision.
   */
  const metadata = sanitiseMetadata(entry.metadata);
  if (entry.requestId) metadata.requestId = entry.requestId;

  await db
    .insertInto('audit_logs')
    .values({
      actor_user_id: entry.actorUserId ?? null,
      actor_platform_role: entry.actorPlatformRole ?? null,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      organization_id: entry.organizationId ?? null,
      metadata: JSON.stringify(metadata),
      ip_address: entry.ipAddress ?? null,
      user_agent: entry.userAgent ?? null,
    })
    .execute();
}

/** Most recent audit entries, newest first. Administrator-only surface. */
export async function listAuditLogs(
  db: Kysely<Database>,
  options: { limit?: number; action?: AuditAction } = {},
): Promise<Array<Record<string, unknown>>> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  let query = db.selectFrom('audit_logs').selectAll().orderBy('created_at', 'desc').limit(limit);
  if (options.action) query = query.where('action', '=', options.action);
  const rows = await query.execute();
  return rows as unknown as Array<Record<string, unknown>>;
}

export interface AuditEntryView {
  id: string;
  action: string;
  actorUserId: string | null;
  actorPlatformRole: string | null;
  targetType: string | null;
  targetId: string | null;
  organizationId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * The audit trail for ONE subject, for the detail drawer.
 *
 * Entries where the subject was the target and entries where they were the actor
 * are both included — "this account was suspended" and "this account suspended
 * someone else" are both part of its history.
 *
 * `ip_address` and `user_agent` are deliberately omitted from the projection.
 * They belong in the operator's forensic query, not on a screen that support
 * staff read routinely.
 */
export async function listAuditForSubject(
  db: Kysely<Database>,
  subjectId: string,
  options: { limit?: number; organizationId?: string | null } = {},
): Promise<AuditEntryView[]> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 200);
  const rows = await db
    .selectFrom('audit_logs')
    .select([
      'id',
      'action',
      'actor_user_id',
      'actor_platform_role',
      'target_type',
      'target_id',
      'organization_id',
      'metadata',
      'created_at',
    ])
    .where((eb) =>
      eb.or([
        eb('target_id', '=', subjectId),
        eb('actor_user_id', '=', subjectId),
        ...(options.organizationId ? [eb('organization_id', '=', options.organizationId)] : []),
      ]),
    )
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    actorUserId: row.actor_user_id,
    actorPlatformRole: row.actor_platform_role,
    targetType: row.target_type,
    targetId: row.target_id,
    organizationId: row.organization_id,
    // Written through `sanitiseMetadata`, so this cannot carry a credential.
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {}),
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

/** Count entries for an action — used by tests and administrator dashboards. */
export async function countAuditLogs(db: Kysely<Database>, action: AuditAction): Promise<number> {
  const row = await db
    .selectFrom('audit_logs')
    .select(sql<number>`count(*)::int`.as('count'))
    .where('action', '=', action)
    .executeTakeFirst();
  return row?.count ?? 0;
}

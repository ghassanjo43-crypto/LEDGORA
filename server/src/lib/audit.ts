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
  | 'subscription.plan_selected'
  | 'subscription.confirmed'
  | 'payment_proof.submitted'
  | 'payment_proof.approved'
  | 'payment_proof.rejected'
  | 'payment_proof.information_requested'
  | 'subscription.activated'
  | 'subscription.suspended'
  | 'subscription.cancelled'
  | 'subscription.renewed';

export interface AuditContext {
  actorUserId?: string | null;
  actorPlatformRole?: string | null;
  organizationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
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
  await db
    .insertInto('audit_logs')
    .values({
      actor_user_id: entry.actorUserId ?? null,
      actor_platform_role: entry.actorPlatformRole ?? null,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      organization_id: entry.organizationId ?? null,
      metadata: JSON.stringify(sanitiseMetadata(entry.metadata)),
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

/** Count entries for an action — used by tests and administrator dashboards. */
export async function countAuditLogs(db: Kysely<Database>, action: AuditAction): Promise<number> {
  const row = await db
    .selectFrom('audit_logs')
    .select(sql<number>`count(*)::int`.as('count'))
    .where('action', '=', action)
    .executeTakeFirst();
  return row?.count ?? 0;
}

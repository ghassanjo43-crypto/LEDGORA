/**
 * Authoritative accounting audit events.
 *
 * ══ Why this is separate from `lib/audit` ════════════════════════════════════
 *
 * `audit_logs` records administrative acts on TENANTS — who archived a
 * subscriber, who changed a plan. This records acts on the BOOKS. Keeping them
 * apart means a tenant-administration purge can never take the accounting trail
 * with it, and it lets the accounting trail carry the fields only accounting
 * needs: the version a record moved from and to, and the reason a correction
 * was made.
 *
 * ══ Why every writer passes a transaction ════════════════════════════════════
 *
 * `writeAccountingAudit` takes an executor, and every caller inside a posting
 * hands it the TRANSACTION rather than the pool. That is deliberate and is the
 * whole point: if the audit insert fails, the posting it describes must fail
 * with it. An audit written on a separate connection would survive a rolled-back
 * posting and claim something happened that did not — which is worse than no
 * audit at all, because it is a confident lie.
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../db/schema.js';

export type AccountingExecutor = Kysely<Database> | Transaction<Database>;

/**
 * The vocabulary. A closed union so a typo becomes a compile error rather than
 * an event nobody will ever find because it is spelled differently.
 */
export type AccountingAuditAction =
  | 'ACCOUNT_CREATED'
  | 'ACCOUNT_UPDATED'
  | 'ACCOUNT_DEACTIVATED'
  | 'ACCOUNT_REACTIVATED'
  | 'PERIOD_CREATED'
  | 'PERIOD_UPDATED'
  | 'PERIOD_SOFT_CLOSED'
  | 'PERIOD_LOCKED'
  | 'PERIOD_REOPENED'
  | 'JOURNAL_CREATED'
  | 'JOURNAL_UPDATED'
  | 'JOURNAL_DELETED_DRAFT'
  | 'JOURNAL_POSTED'
  | 'JOURNAL_AMENDED'
  | 'JOURNAL_REVERSED'
  | 'JOURNAL_REPLACED';

/** Who is acting, carried from the route into every service call. */
export interface AccountingActor {
  organizationId: string;
  userId: string;
  /** Display name for the trail; the id is the identity. */
  name: string;
  requestId?: string | null;
}

export interface AccountingAuditInput {
  action: AccountingAuditAction;
  recordType: 'account' | 'accounting_period' | 'journal_entry';
  recordId: string | null;
  reason?: string;
  previousVersion?: number | null;
  resultingVersion?: number | null;
  detail?: Record<string, unknown>;
}

export async function writeAccountingAudit(
  executor: AccountingExecutor,
  actor: AccountingActor,
  input: AccountingAuditInput,
): Promise<void> {
  await executor
    .insertInto('accounting_audit_events')
    .values({
      organization_id: actor.organizationId,
      action: input.action,
      record_type: input.recordType,
      record_id: input.recordId,
      actor_user_id: actor.userId,
      actor_name: actor.name,
      reason: input.reason ?? '',
      previous_version: input.previousVersion ?? null,
      resulting_version: input.resultingVersion ?? null,
      detail: JSON.stringify(input.detail ?? {}),
      request_id: actor.requestId ?? null,
    })
    .execute();
}

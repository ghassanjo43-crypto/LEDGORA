/**
 * Applicant reconciliation — the idempotent backfill.
 *
 * One statement, two callers: migration `003` runs it once to populate the new
 * table, and `reconcileApplications()` (service + CLI + boot) re-runs it so an
 * account that somehow reached `users` without an application record is never
 * left invisible to the administrator.
 *
 * It is written here rather than inside the migration so the two can never
 * drift. The SQL is deliberately schema-agnostic and additive: it only INSERTs
 * rows that are missing, so running it a hundred times has the same effect as
 * running it once.
 *
 * Platform operators (super_admin, billing_admin, support) are excluded — a
 * LEDGORA employee is not an applicant.
 */
import { sql } from 'kysely';

// Migrations run against the schema as it existed at that point in time, so this
// module is intentionally untyped against the current `Database` interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = import('kysely').Kysely<any>;

/**
 * Create the missing application records.
 *
 * The stage of an existing account is derived from the data that already exists
 * (subscription, invoice, proof) so a backfilled applicant lands in the correct
 * bucket rather than all of them appearing as brand-new registrations.
 *
 * @returns how many application records were created.
 */
export async function backfillApplications(db: AnyKysely): Promise<number> {
  const result = await sql<{ user_id: string }>`
    INSERT INTO subscription_applications (
      user_id, organization_id, selected_plan_id, subscription_id, status,
      registered_at, package_selected_at, payment_started_at, proof_uploaded_at, activated_at,
      last_activity_at, source
    )
    SELECT
      u.id,
      m.organization_id,
      sub.plan_id,
      sub.id,
      CASE
        WHEN sub.status = 'active'                                     THEN 'active_subscriber'
        WHEN sub.status = 'pending_verification'                       THEN 'pending_verification'
        WHEN sub.status IN ('pending_payment', 'rejected', 'past_due') THEN 'awaiting_payment'
        WHEN sub.plan_id IS NOT NULL                                   THEN 'package_selected'
        ELSE 'registered_no_package'
      END,
      u.created_at,
      CASE WHEN sub.plan_id IS NOT NULL THEN sub.created_at END,
      inv.issued_at,
      pr.created_at,
      sub.starts_at,
      GREATEST(
        u.created_at,
        COALESCE(u.last_login_at, u.created_at),
        COALESCE(sub.updated_at, u.created_at)
      ),
      'backfill'
    FROM users u
    -- A customer belongs to at most one organization today; take the earliest
    -- active membership so the join can never multiply the user's row.
    LEFT JOIN LATERAL (
      SELECT om.organization_id
      FROM organization_memberships om
      WHERE om.user_id = u.id AND om.status = 'active'
      ORDER BY om.created_at ASC
      LIMIT 1
    ) m ON true
    -- The live subscription wins over historical ones; otherwise the newest.
    LEFT JOIN LATERAL (
      SELECT s.*
      FROM subscriptions s
      WHERE s.organization_id = m.organization_id
      ORDER BY (s.status = 'active') DESC, s.created_at DESC
      LIMIT 1
    ) sub ON true
    LEFT JOIN LATERAL (
      SELECT i.*
      FROM subscription_invoices i
      WHERE i.subscription_id = sub.id AND i.status <> 'cancelled'
      ORDER BY i.created_at DESC
      LIMIT 1
    ) inv ON true
    LEFT JOIN LATERAL (
      SELECT p.created_at
      FROM payment_proofs p
      WHERE p.invoice_id = inv.id
      ORDER BY p.created_at DESC
      LIMIT 1
    ) pr ON true
    WHERE NOT EXISTS (SELECT 1 FROM platform_user_roles r WHERE r.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM subscription_applications a WHERE a.user_id = u.id)
    RETURNING user_id
  `.execute(db);

  return result.rows.length;
}

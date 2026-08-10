/**
 * Retention, archival and deletion bookkeeping.
 *
 * ── Why `archived` is a distinct status ──────────────────────────────────────
 * The schema had `closed`, which the archive action reused. That conflated two
 * different meanings: "this customer left" and "an administrator has taken this
 * tenant out of circulation but every record is retained and it can be restored".
 * Archival is the NORMAL end state for a subscriber, so it gets its own status.
 * `closed` stays valid — existing rows keep their meaning and nothing is rewritten.
 *
 * ── Why the deletion columns exist ──────────────────────────────────────────
 * `deletion_requested_at` / `deletion_eligible_after` make a purge a two-step act
 * with a cooling-off period, rather than a single irreversible click. `legal_hold`
 * is a hard block that no eligibility calculation can talk its way past — set it
 * and the tenant cannot be purged, whatever else is true.
 *
 * ── Why users are anonymised rather than deleted ─────────────────────────────
 * `audit_logs.actor_user_id` references `users(id)` and MUST keep pointing at a
 * real row: the audit trail is evidence, and a dangling actor turns "who did
 * this?" into "nobody knows". So a historical user is anonymised in place —
 * `anonymized_at` set, personal fields replaced, the id preserved — and only a
 * genuinely unused account is deleted outright. `deleted_at` marks the soft-delete
 * case for accounts that must stay referenceable.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  /* ── Organizations: archival + deletion bookkeeping ───────────────────── */
  await sql`
    ALTER TABLE organizations
      DROP CONSTRAINT IF EXISTS organizations_status_check
  `.execute(db);
  await sql`
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_status_check
      CHECK (status IN ('active','suspended','archived','closed'))
  `.execute(db);

  await sql`ALTER TABLE organizations ADD COLUMN archived_at timestamptz`.execute(db);
  await sql`
    ALTER TABLE organizations
      ADD COLUMN archived_by uuid REFERENCES users(id) ON DELETE SET NULL
  `.execute(db);
  await sql`ALTER TABLE organizations ADD COLUMN archive_reason text`.execute(db);
  /* A purge is requested first and carried out afterwards, never in one click. */
  await sql`ALTER TABLE organizations ADD COLUMN deletion_requested_at timestamptz`.execute(db);
  await sql`ALTER TABLE organizations ADD COLUMN deletion_eligible_after timestamptz`.execute(db);
  /*
   * A hard block. No eligibility calculation may override it — a dispute, an
   * investigation or a statutory hold is exactly the case where "the numbers say
   * it is safe" must not win.
   */
  await sql`ALTER TABLE organizations ADD COLUMN legal_hold boolean NOT NULL DEFAULT false`.execute(db);
  await sql`ALTER TABLE organizations ADD COLUMN legal_hold_reason text`.execute(db);

  await sql`
    CREATE INDEX organizations_status_idx ON organizations (status)
  `.execute(db);

  /* ── Users: lifecycle timestamps ──────────────────────────────────────── */
  await sql`ALTER TABLE users ADD COLUMN disabled_at timestamptz`.execute(db);
  /* Soft deletion, for an account that must remain referenceable. */
  await sql`ALTER TABLE users ADD COLUMN deleted_at timestamptz`.execute(db);
  /*
   * Set when personal fields have been replaced. The row and its id survive so
   * every historical foreign key — audit actor, proof uploader, plan editor —
   * keeps resolving.
   */
  await sql`ALTER TABLE users ADD COLUMN anonymized_at timestamptz`.execute(db);

  /* Backfill the obvious case so the new column agrees with existing state. */
  await sql`UPDATE users SET disabled_at = updated_at WHERE status = 'disabled'`.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DROP INDEX IF EXISTS organizations_status_idx`.execute(db);
  for (const column of ['anonymized_at', 'deleted_at', 'disabled_at']) {
    await sql`ALTER TABLE users DROP COLUMN IF EXISTS ${sql.raw(column)}`.execute(db);
  }
  for (const column of [
    'legal_hold_reason',
    'legal_hold',
    'deletion_eligible_after',
    'deletion_requested_at',
    'archive_reason',
    'archived_by',
    'archived_at',
  ]) {
    await sql`ALTER TABLE organizations DROP COLUMN IF EXISTS ${sql.raw(column)}`.execute(db);
  }
  // Archived rows would violate the original constraint; fold them back first.
  await sql`UPDATE organizations SET status = 'closed' WHERE status = 'archived'`.execute(db);
  await sql`ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_status_check`.execute(db);
  await sql`
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_status_check CHECK (status IN ('active','suspended','closed'))
  `.execute(db);
}

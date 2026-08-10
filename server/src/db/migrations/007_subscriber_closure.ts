/**
 * Subscriber closure: the recoverable pending-deletion period, and data export.
 *
 * ── Why `pending_deletion` is a distinct status ──────────────────────────────
 * Migration 005 added `deletion_requested_at` / `deletion_eligible_after`, but
 * an organization carrying them still reported itself as `archived` — so "taken
 * out of circulation, everything retained" and "scheduled to be destroyed on a
 * date" were indistinguishable in the one field every surface reads. They are
 * very different facts for the customer and for the operator, so pending
 * deletion gets its own status. `archived` keeps its exact previous meaning and
 * no existing row is rewritten.
 *
 * ── Why exports are a table and not a response body ──────────────────────────
 * An export is a JOB with a lifecycle — requested, produced, downloaded,
 * expired, revoked — and every one of those transitions has to be auditable
 * before anyone is allowed to delete the thing that was exported. A synchronous
 * download would leave no record that the export was ever taken, which is
 * exactly what "a required data export is incomplete" needs to be able to check.
 *
 * The token is stored as a SHA-256 hash, the same rule `auth_sessions` and
 * `password_reset_tokens` already follow: a download link is a bearer
 * credential, and the database must not hold anything replayable.
 *
 * ── What the payload column is, and is not ───────────────────────────────────
 * `payload` holds the generated JSON export. It is written by a server-side
 * builder that selects field by field from organization-scoped queries — never
 * `SELECT *` — so no password hash, session token, reset token or secret can
 * reach it. See `services/exportService`.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  /* ── The pending-deletion status ───────────────────────────────────────── */
  await sql`
    ALTER TABLE organizations
      DROP CONSTRAINT IF EXISTS organizations_status_check
  `.execute(db);
  await sql`
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_status_check
      CHECK (status IN ('active','suspended','archived','pending_deletion','closed'))
  `.execute(db);

  /* ── Who asked for the deletion, and why ───────────────────────────────── */
  await sql`
    ALTER TABLE organizations
      ADD COLUMN deletion_requested_by uuid REFERENCES users(id) ON DELETE SET NULL
  `.execute(db);
  await sql`ALTER TABLE organizations ADD COLUMN deletion_reason text`.execute(db);

  /* The scheduler's read path: "which tenants are due to be purged?" */
  await sql`
    CREATE INDEX organizations_pending_deletion_idx
      ON organizations (deletion_eligible_after)
      WHERE deletion_requested_at IS NOT NULL
  `.execute(db);

  /* ── Subscriber data exports ───────────────────────────────────────────── */
  await sql`
    CREATE TABLE subscriber_data_exports (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      requested_by       uuid REFERENCES users(id) ON DELETE SET NULL,
      /* pending → ready → downloaded; or failed / revoked / expired. */
      status             text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','ready','downloaded','failed','revoked')),
      /* SHA-256 of the download token. The raw value is returned once. */
      token_hash         text NOT NULL,
      expires_at         timestamptz NOT NULL,
      /* The generated JSON. Built by an allow-list projection — never SELECT *. */
      payload            jsonb,
      byte_size          integer,
      /* What went into it, for the audit trail and the UI. */
      section_counts     jsonb NOT NULL DEFAULT '{}'::jsonb,
      error_message      text,
      first_downloaded_at timestamptz,
      download_count     integer NOT NULL DEFAULT 0,
      revoked_at         timestamptz,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX subscriber_data_exports_token_key
      ON subscriber_data_exports (token_hash)
  `.execute(db);
  await sql`
    CREATE INDEX subscriber_data_exports_org_idx
      ON subscriber_data_exports (organization_id, created_at DESC)
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DROP TABLE IF EXISTS subscriber_data_exports CASCADE`.execute(db);
  await sql`DROP INDEX IF EXISTS organizations_pending_deletion_idx`.execute(db);
  await sql`ALTER TABLE organizations DROP COLUMN IF EXISTS deletion_reason`.execute(db);
  await sql`ALTER TABLE organizations DROP COLUMN IF EXISTS deletion_requested_by`.execute(db);

  /*
   * Restore the previous status set.
   *
   * Any organization still sitting in `pending_deletion` is returned to
   * `archived` first — that IS its meaning under the old vocabulary (out of
   * circulation, everything retained), so nothing is lost and the constraint can
   * be re-applied. The schedule columns from 005 are left alone; they are that
   * migration's to own.
   */
  await sql`
    UPDATE organizations SET status = 'archived' WHERE status = 'pending_deletion'
  `.execute(db);
  await sql`
    ALTER TABLE organizations
      DROP CONSTRAINT IF EXISTS organizations_status_check
  `.execute(db);
  await sql`
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_status_check
      CHECK (status IN ('active','suspended','archived','closed'))
  `.execute(db);
}

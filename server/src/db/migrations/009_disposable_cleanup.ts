/**
 * Permanent cleanup of test/demo subscribers: tombstones, external-file
 * cleanup ledger, and a tenant write freeze.
 *
 * ── Why the tombstone has no foreign key ─────────────────────────────────────
 * A tombstone exists precisely because the organization does not. A reference to
 * `organizations(id)` would be deleted or nulled by the very operation it
 * records, so `organization_id` here is a bare uuid — the id is evidence, not a
 * pointer. Same reasoning for `deleted_by_user_id`: a Super Admin account can
 * itself be closed later, and the record of who authorised a destruction must
 * outlive the account that authorised it.
 *
 * ── Why the file cleanup ledger is a table and not a queue library ───────────
 * Deleting database rows and deleting objects in storage cannot be one atomic
 * act. Something must survive a crash between them, or a failed object delete
 * becomes an invisible orphan holding customer data. The ledger is written in
 * the SAME transaction as the database deletion, so the intent to delete a file
 * is committed before the row naming that file disappears. Losing the object
 * key is unrecoverable; a retryable pending row is not.
 *
 * There is no worker infrastructure in this repository, so cleanup runs inline
 * after commit and leaves failures as `pending` for an explicit retry action.
 * That is a real limitation, and it is recorded honestly in the report the
 * operator sees rather than hidden behind an optimistic success message.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  /**
   * The write freeze.
   *
   * Between "eligibility decided" and "rows deleted", an ordinary tenant request
   * could create a membership or an invoice — a row belonging to an organization
   * that is midway through being destroyed. The flag is set inside the deletion
   * transaction under the organization's row lock, so any concurrent writer
   * either committed before the lock or is refused after it.
   */
  await sql`
    ALTER TABLE organizations
      ADD COLUMN deletion_in_progress boolean NOT NULL DEFAULT false
  `.execute(db);

  await sql`
    CREATE TABLE subscriber_deletion_tombstones (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

      /* Correlates preview → execution → this record. */
      operation_id uuid NOT NULL,
      request_id text,

      /* Bare uuids, deliberately. See the note above. */
      organization_id uuid NOT NULL,
      deleted_by_user_id uuid,

      /* Denormalised so the record reads without the rows it describes. */
      legal_name text NOT NULL,
      deleted_by_email text,
      classification_at_deletion text NOT NULL,
      reason text NOT NULL,

      previewed_at timestamptz NOT NULL,
      executed_at timestamptz NOT NULL DEFAULT now(),

      /* {table: count}. Counts only — never the records themselves. */
      removed_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
      identities_deleted uuid[] NOT NULL DEFAULT '{}',
      identities_retained uuid[] NOT NULL DEFAULT '{}',

      /*
       * ── Three independent states, never collapsed into one ───────────────
       * Each names a different storage layer, and each can succeed while
       * another fails. A single "outcome" column would have to pick one to
       * report, and the layer it dropped would be the one nobody chased.
       *
       *   database  — rows in THIS database.        completed | failed
       *   workspace — the tenant's accounting books. see below
       *   external  — objects in file storage.      none | pending | completed | failed
       *
       * workspace_deletion_status is 'no_server_workspace' on every row this
       * deployment writes, and that value is the honest one rather than a
       * placeholder: Ledgora's books live in each user's browser, so there is
       * no server-side workspace for this operation to delete. The column
       * exists so the claim is recorded explicitly on every tombstone instead
       * of being inferred from its absence — and so a future deployment that
       * does own the books can write completed/pending/failed here without the
       * older rows silently appearing to make that claim.
       */
      database_deletion_status text NOT NULL DEFAULT 'completed',
      workspace_deletion_status text NOT NULL DEFAULT 'no_server_workspace',
      external_cleanup_status text NOT NULL DEFAULT 'none',

      /* The aggregate: completed | completed_with_pending_cleanup | failed. */
      outcome text NOT NULL,
      failure_summary text,

      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE INDEX subscriber_deletion_tombstones_org_idx
      ON subscriber_deletion_tombstones (organization_id)
  `.execute(db);
  await sql`
    CREATE INDEX subscriber_deletion_tombstones_operation_idx
      ON subscriber_deletion_tombstones (operation_id)
  `.execute(db);

  /**
   * The external-object cleanup ledger.
   *
   * `storage_key` is copied from the row being deleted, never assembled from
   * anything a user supplied — a reconstructed path is an instruction to delete
   * an arbitrary object, and the only safe source is the value the system itself
   * wrote when it stored the file.
   */
  await sql`
    CREATE TABLE file_cleanup_queue (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      operation_id uuid NOT NULL,
      organization_id uuid NOT NULL,
      storage_key text NOT NULL,
      /* What the key came from, for forensics. */
      source_table text NOT NULL,
      source_id uuid,

      /* pending | completed | failed */
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','completed','failed')),
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      last_attempted_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),

      /*
       * Idempotency. Re-running cleanup for the same object within the same
       * operation must not enqueue a second row, so a retry storm cannot grow
       * the ledger without bound.
       */
      UNIQUE (operation_id, storage_key)
    )
  `.execute(db);

  await sql`
    CREATE INDEX file_cleanup_queue_pending_idx
      ON file_cleanup_queue (status, created_at)
      WHERE status <> 'completed'
  `.execute(db);

  /**
   * Execution idempotency.
   *
   * A double-submitted confirmation must destroy a tenant once. The digest binds
   * the operation to the exact organization set and the state that was
   * previewed, so a replayed request returns the original result rather than
   * running a second, differently-scoped deletion.
   */
  await sql`
    CREATE TABLE cleanup_operations (
      operation_id uuid PRIMARY KEY,
      requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      /* SHA-256 over the sorted ids and their previewed state. */
      preview_digest text NOT NULL,
      organization_ids uuid[] NOT NULL,
      reason text NOT NULL,
      previewed_at timestamptz NOT NULL,
      /* pending | completed | failed */
      status text NOT NULL DEFAULT 'pending',
      result jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    )
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DROP TABLE IF EXISTS cleanup_operations`.execute(db);
  await sql`DROP TABLE IF EXISTS file_cleanup_queue`.execute(db);
  await sql`DROP TABLE IF EXISTS subscriber_deletion_tombstones`.execute(db);
  await sql`ALTER TABLE organizations DROP COLUMN IF EXISTS deletion_in_progress`.execute(db);
}

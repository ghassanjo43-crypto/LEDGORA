/**
 * Repair: the two missing per-layer status columns on
 * `subscriber_deletion_tombstones`.
 *
 * ── What went wrong ──────────────────────────────────────────────────────────
 * Migration `009` is the sole author of this table, and the version of it that
 * ships today creates all three status columns. But an earlier iteration of
 * `009` was applied to already-running databases before those columns existed,
 * and a migration that has already been recorded in `kysely_migration` never
 * runs again. Editing `009` in place therefore repairs nothing: every database
 * created after the edit is correct, and every database created before it is
 * permanently one migration short.
 *
 * The result is a database whose tombstone table has `external_cleanup_status`
 * and neither of its two siblings, and where every permanent deletion fails at
 * the very last statement of the transaction:
 *
 *     column "database_deletion_status" of relation
 *     "subscriber_deletion_tombstones" does not exist
 *
 * That failure is at least honest — the insert is inside the deletion
 * transaction, so the tenant is rolled back intact rather than half-destroyed
 * with no record. But it makes disposable cleanup unusable on those databases.
 *
 * ── Why a new migration rather than a fix to 009 ─────────────────────────────
 * `009` is applied. It is history, and history is not editable: the only thing
 * that can reach a database which already ran it is a migration it has NOT run.
 * So `009` is left exactly as it is, and the gap is closed forwards.
 *
 * ── Why this is additive and nothing else ────────────────────────────────────
 * The obvious "fix" — drop the table and let `009`'s definition recreate it —
 * would destroy tombstones. A tombstone is the ONLY surviving evidence that a
 * subscriber was permanently deleted, by whom, and on what authority; the rows
 * it describes are already gone, so there is nothing to reconstruct it from.
 * Losing one is losing the deletion record itself. This migration therefore
 * only ever adds columns, and `ADD COLUMN IF NOT EXISTS` makes it a no-op on
 * every database where `009` already did the job — which is how the same
 * migration can be correct for both populations.
 *
 * ── Why these defaults are the truthful ones for existing rows ───────────────
 * PostgreSQL backfills existing rows with the column default, so the defaults
 * are a factual claim about deletions that happened BEFORE this repair:
 *
 *   database_deletion_status = 'completed'
 *     A tombstone is written in the same transaction as the deletion it
 *     records. Its existence is proof that transaction committed, so the rows
 *     really are gone. 'completed' is not an assumption here; it is the only
 *     state a persisted tombstone can have been written in.
 *
 *   workspace_deletion_status = 'no_server_workspace'
 *     Ledgora's accounting books live in each user's browser, so there is no
 *     server-side workspace for any past deletion to have deleted. Backfilling
 *     this states the fact explicitly on the older rows rather than leaving it
 *     to be inferred from a NULL — and it is the same value the running code
 *     writes on every new row.
 *
 * Both match `009`'s own defaults, so a repaired database and a freshly created
 * one are indistinguishable afterwards.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  /*
   * `IF NOT EXISTS` is what makes this safe to run everywhere. On a database
   * created from the current `009` both statements do nothing; on a legacy one
   * they add the missing column and backfill it. No branch on the current
   * schema, and therefore no way for the branch to be wrong.
   *
   * NOT NULL DEFAULT on ADD COLUMN does not rewrite the table (PostgreSQL 11+):
   * the default is stored as the attribute's missing value and materialised
   * lazily, so this holds a brief ACCESS EXCLUSIVE lock and no more.
   */
  await sql`
    ALTER TABLE subscriber_deletion_tombstones
      ADD COLUMN IF NOT EXISTS database_deletion_status text NOT NULL DEFAULT 'completed'
  `.execute(db);

  await sql`
    ALTER TABLE subscriber_deletion_tombstones
      ADD COLUMN IF NOT EXISTS workspace_deletion_status text NOT NULL DEFAULT 'no_server_workspace'
  `.execute(db);
}

/**
 * Deliberately empty.
 *
 * The inverse of "repair the table" is "break the table again", and there is no
 * circumstance in which that is the right thing to do: dropping these columns
 * on a database created from the current `009` would manufacture the exact
 * drift this migration exists to remove, and would discard the per-layer status
 * of every tombstone on the way. `009` already owns the real teardown — its
 * `down` drops the whole table — so nothing is left unreversible by this being
 * a no-op.
 */
export async function down(): Promise<void> {
  /* Intentionally does nothing. See above. */
}

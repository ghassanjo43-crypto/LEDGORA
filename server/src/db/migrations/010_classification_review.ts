/**
 * Whether a human has ever reviewed an organization's classification.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 * Migration `008` gave every existing organization `data_classification =
 * 'production'`. That was the only safe default — a migration cannot tell a real
 * customer from a developer's throwaway tenant — but it means the column records
 * two very different things under one value:
 *
 *   · "a person decided this account is real", and
 *   · "nobody has looked at this account".
 *
 * Both read as `production`, and the difference is exactly what an operator
 * needs when auditing which tenants are genuinely protected. A blanket default
 * that nobody has confirmed is not a decision; it is an absence of one.
 *
 * ── Why a separate column rather than inferring it ───────────────────────────
 * `classified_by` looks like it should answer this, but it does not: it is null
 * both for a migration-defaulted row and for a self-service registration, and
 * `classified_production_at` was stamped `now()` for every row by `008`, so
 * neither distinguishes reviewed from unreviewed. Inferring the answer from a
 * creation date compared against a deployment date would be a guess that
 * silently rots. An explicit column cannot.
 *
 * ── Deliberately NOT a way to un-protect anything ────────────────────────────
 * Reviewing records that somebody looked. It does not change
 * `data_classification` and it does not unlock the production -> test|demo move,
 * which remains refused by the `008` trigger and reachable only through the
 * development CLI. Confirming is forward-only: it turns an unreviewed production
 * account into a reviewed production account, and nothing else.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  /*
   * Nullable, and deliberately NOT backfilled. Every row that exists when this
   * runs was classified by the 008 default, so "unreviewed" is the honest value
   * for all of them — backfilling `now()` would assert a review that never
   * happened, which is the precise error this column exists to prevent.
   */
  await sql`
    ALTER TABLE organizations
      ADD COLUMN classification_reviewed_at timestamptz
  `.execute(db);

  await sql`
    ALTER TABLE organizations
      ADD COLUMN classification_reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL
  `.execute(db);

  /* The console's "what still needs looking at?" query. */
  await sql`
    CREATE INDEX organizations_classification_unreviewed_idx
      ON organizations (created_at)
      WHERE classification_reviewed_at IS NULL
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DROP INDEX IF EXISTS organizations_classification_unreviewed_idx`.execute(db);
  await sql`ALTER TABLE organizations DROP COLUMN IF EXISTS classification_reviewed_by`.execute(db);
  await sql`ALTER TABLE organizations DROP COLUMN IF EXISTS classification_reviewed_at`.execute(db);
}

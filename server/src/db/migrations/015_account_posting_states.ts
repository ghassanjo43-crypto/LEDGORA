/** Add explicit account-level posting holds without changing existing accounts. */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  await sql`
    ALTER TABLE accounts
      ADD COLUMN blocked boolean NOT NULL DEFAULT false,
      ADD COLUMN archived boolean NOT NULL DEFAULT false,
      ADD CONSTRAINT accounts_archived_inactive CHECK (NOT archived OR NOT active)
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`
    ALTER TABLE accounts
      DROP CONSTRAINT accounts_archived_inactive,
      DROP COLUMN archived,
      DROP COLUMN blocked
  `.execute(db);
}

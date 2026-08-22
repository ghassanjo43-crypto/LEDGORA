import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

/** Authoritative lifecycle metadata; monetary values remain journal lines. */
export async function up(db: AnyKysely): Promise<void> {
  await sql`
    CREATE TABLE opening_balance_sets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      journal_entry_id uuid NOT NULL,
      bookkeeping_start_date date NOT NULL,
      opening_balance_date date NOT NULL,
      status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','submitted','approved','posted','reversed')),
      reference text NOT NULL DEFAULT '',
      description text NOT NULL DEFAULT '',
      version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
      prepared_by uuid REFERENCES users(id) ON DELETE SET NULL,
      submitted_by uuid REFERENCES users(id) ON DELETE SET NULL,
      submitted_at timestamptz,
      approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
      approved_at timestamptz,
      posted_by uuid REFERENCES users(id) ON DELETE SET NULL,
      posted_at timestamptz,
      reversed_by uuid REFERENCES users(id) ON DELETE SET NULL,
      reversed_at timestamptz,
      reversal_journal_entry_id uuid,
      replaces_opening_balance_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT opening_balance_sets_dates CHECK (opening_balance_date < bookkeeping_start_date),
      CONSTRAINT opening_balance_sets_org_id_unique UNIQUE (organization_id, id),
      CONSTRAINT opening_balance_sets_journal_unique UNIQUE (organization_id, journal_entry_id)
    )
  `.execute(db);

  for (const [column, target] of [
    ['journal_entry_id', 'journal_entries'],
    ['reversal_journal_entry_id', 'journal_entries'],
    ['replaces_opening_balance_id', 'opening_balance_sets'],
  ] as const) {
    await sql.raw(`ALTER TABLE opening_balance_sets ADD CONSTRAINT opening_balance_sets_${column}_same_org FOREIGN KEY (organization_id, ${column}) REFERENCES ${target} (organization_id, id) ON DELETE RESTRICT`).execute(db);
  }

  await sql`CREATE UNIQUE INDEX opening_balance_sets_one_active ON opening_balance_sets (organization_id) WHERE status IN ('draft','submitted','approved','posted')`.execute(db);
  await sql`CREATE INDEX opening_balance_sets_lookup ON opening_balance_sets (organization_id, opening_balance_date, status)`.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DROP TABLE IF EXISTS opening_balance_sets`.execute(db);
}

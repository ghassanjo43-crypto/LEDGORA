/**
 * Company-scoped accounting — the isolation boundary the books actually need.
 *
 * ══ The defect this repairs ══════════════════════════════════════════════════
 *
 * Every accounting table built so far is scoped by `organization_id` alone, and
 * an organization is a SUBSCRIPTION — a billing and membership boundary. A
 * company is a set of books. Ledgora has always permitted several companies
 * under one subscriber, so organization-only scoping means two legal entities
 * belonging to the same customer would share one chart of accounts, one journal
 * sequence, one invoice sequence and one set of reports.
 *
 * That is not a permissions weakness to be patched in a service. It is the data
 * model asserting something false: that a subscriber keeps one set of books.
 *
 * ══ Why the constraints are composite ════════════════════════════════════════
 *
 * Migration 013 established the pattern and the reasoning: a child row points at
 * its parent through `(organization_id, parent_id)`, so a cross-tenant reference
 * is UNREPRESENTABLE rather than merely rejected by whichever service happened
 * to remember to check. This migration extends every one of those keys to
 * `(organization_id, company_id, parent_id)`.
 *
 * The consequence is worth stating plainly, because it is the point of the
 * whole change: after this migration a journal line CANNOT reference an account
 * from another company. Not "is refused if the service checks" — cannot. The
 * insert fails in PostgreSQL, for any caller, through any route, including a
 * direct `psql` session and including a future bug in code nobody has written
 * yet.
 *
 * ══ Why the backfill refuses to guess ════════════════════════════════════════
 *
 * Existing rows have no company. Assigning them is only safe where there is
 * exactly one candidate:
 *
 *   · one registered company   → assign to it. Unambiguous.
 *   · no registered company    → STOP. There is no set of books to assign to,
 *                                and inventing one would fabricate a company
 *                                the customer never created and silently make
 *                                it the owner of real posted journals.
 *   · several companies        → STOP. This is the case that matters. Guessing
 *                                "the first" or "the oldest" would hand one
 *                                company's ledger to another, and nothing later
 *                                would reveal it: the numbers would simply be
 *                                wrong, in a system whose entire purpose is to
 *                                be right about numbers.
 *
 * A stopped migration is a deployment that fails loudly and changes nothing. A
 * guessed one is a silent, permanent misattribution of somebody's accounts. The
 * asymmetry is not close.
 *
 * ══ The explicit mapping ═════════════════════════════════════════════════════
 *
 * An operator who KNOWS the correct assignment supplies it before running the
 * migration, as JSON in a session setting:
 *
 *   SET ledgora.company_backfill_map = '{"<organization uuid>":"<company uuid>"}';
 *
 * Every mapping is verified to name a company that genuinely belongs to that
 * organization — a mapping is a way to state a fact the database cannot infer,
 * never a way to override one it can.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

/**
 * Every tenant-owned accounting table, and how each one finds its company.
 *
 * `via` names the parent column a row inherits from, where one exists. Deriving
 * a line's company from its ENTRY rather than from its organization is not
 * merely tidier — it is the only derivation that stays correct if an
 * organization's rows ever span companies, which is precisely the state this
 * migration exists to make possible.
 */
const SCOPED_TABLES = [
  { table: 'accounting_periods', via: null },
  { table: 'accounts', via: null },
  { table: 'journal_entries', via: null },
  { table: 'journal_lines', via: { column: 'journal_entry_id', parent: 'journal_entries' } },
  { table: 'journal_entry_versions', via: { column: 'journal_entry_id', parent: 'journal_entries' } },
  { table: 'accounting_audit_events', via: null },
  { table: 'opening_balance_sets', via: { column: 'journal_entry_id', parent: 'journal_entries' } },
  { table: 'invoices', via: null },
  { table: 'invoice_lines', via: { column: 'invoice_id', parent: 'invoices' } },
  { table: 'invoice_payments', via: { column: 'invoice_id', parent: 'invoices' } },
  { table: 'invoice_numbering', via: null },
  { table: 'invoice_audit_events', via: { column: 'invoice_id', parent: 'invoices' } },
] as const;

/**
 * Foreign keys re-pointed from organization scope to company scope.
 *
 * `constraint` is the existing name from migrations 013/016/019/020; `next` is
 * the company-scoped replacement. Each is dropped and recreated rather than
 * altered, because PostgreSQL has no way to widen a foreign key's column list
 * in place.
 */
const SCOPED_KEYS = [
  { table: 'accounts', column: 'parent_account_id', target: 'accounts',
    constraint: 'accounts_parent_same_org', next: 'accounts_parent_same_company', onDelete: 'RESTRICT' },

  { table: 'journal_entries', column: 'original_entry_id', target: 'journal_entries',
    constraint: 'journal_entries_original_entry_id_same_org', next: 'journal_entries_original_same_company', onDelete: 'RESTRICT' },
  { table: 'journal_entries', column: 'reversal_entry_id', target: 'journal_entries',
    constraint: 'journal_entries_reversal_entry_id_same_org', next: 'journal_entries_reversal_same_company', onDelete: 'RESTRICT' },
  { table: 'journal_entries', column: 'replacement_entry_id', target: 'journal_entries',
    constraint: 'journal_entries_replacement_entry_id_same_org', next: 'journal_entries_replacement_same_company', onDelete: 'RESTRICT' },

  { table: 'journal_lines', column: 'journal_entry_id', target: 'journal_entries',
    constraint: 'journal_lines_entry_same_org', next: 'journal_lines_entry_same_company', onDelete: 'CASCADE' },
  { table: 'journal_lines', column: 'account_id', target: 'accounts',
    constraint: 'journal_lines_account_same_org', next: 'journal_lines_account_same_company', onDelete: 'RESTRICT' },

  { table: 'journal_entry_versions', column: 'journal_entry_id', target: 'journal_entries',
    constraint: 'journal_entry_versions_entry_same_org', next: 'journal_entry_versions_entry_same_company', onDelete: 'CASCADE' },

  { table: 'opening_balance_sets', column: 'journal_entry_id', target: 'journal_entries',
    constraint: 'opening_balance_sets_journal_entry_id_same_org', next: 'opening_balance_sets_journal_same_company', onDelete: 'RESTRICT' },
  { table: 'opening_balance_sets', column: 'reversal_journal_entry_id', target: 'journal_entries',
    constraint: 'opening_balance_sets_reversal_journal_entry_id_same_org', next: 'opening_balance_sets_reversal_same_company', onDelete: 'RESTRICT' },
  { table: 'opening_balance_sets', column: 'replaces_opening_balance_id', target: 'opening_balance_sets',
    constraint: 'opening_balance_sets_replaces_opening_balance_id_same_org', next: 'opening_balance_sets_replaces_same_company', onDelete: 'RESTRICT' },

  { table: 'invoice_lines', column: 'invoice_id', target: 'invoices',
    constraint: 'invoice_lines_invoice_same_org', next: 'invoice_lines_invoice_same_company', onDelete: 'CASCADE' },
  { table: 'invoice_lines', column: 'account_id', target: 'accounts',
    constraint: 'invoice_lines_account_same_org', next: 'invoice_lines_account_same_company', onDelete: 'RESTRICT' },

  { table: 'invoice_payments', column: 'invoice_id', target: 'invoices',
    constraint: 'invoice_payments_invoice_same_org', next: 'invoice_payments_invoice_same_company', onDelete: 'CASCADE' },
  { table: 'invoice_payments', column: 'journal_entry_id', target: 'journal_entries',
    constraint: 'invoice_payments_journal_same_org', next: 'invoice_payments_journal_same_company', onDelete: 'RESTRICT' },

  { table: 'invoice_audit_events', column: 'invoice_id', target: 'invoices',
    constraint: 'invoice_audit_invoice_same_org', next: 'invoice_audit_invoice_same_company', onDelete: 'CASCADE' },

  { table: 'invoices', column: 'receivable_account_id', target: 'accounts',
    constraint: 'invoices_receivable_account_fk', next: 'invoices_receivable_account_same_company', onDelete: 'RESTRICT' },
  { table: 'invoices', column: 'tax_account_id', target: 'accounts',
    constraint: 'invoices_tax_account_fk', next: 'invoices_tax_account_same_company', onDelete: 'RESTRICT' },
  { table: 'invoices', column: 'additional_charges_account_id', target: 'accounts',
    constraint: 'invoices_charges_account_fk', next: 'invoices_charges_account_same_company', onDelete: 'RESTRICT' },
] as const;

/** Tables a company-scoped composite key points AT; each needs the matching unique. */
const FK_TARGETS = ['accounts', 'journal_entries', 'invoices', 'opening_balance_sets'] as const;

export async function up(db: AnyKysely): Promise<void> {
  /* ══ 1. The column, nullable for now ═══════════════════════════════════════
   *
   * Nullable during the backfill and made NOT NULL at the end. Adding it as NOT
   * NULL would require a default, and a default company id is exactly the guess
   * this migration refuses to make.
   */
  for (const { table } of SCOPED_TABLES) {
    await sql.raw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS company_id uuid`).execute(db);
  }

  /* ══ 2. Refuse before touching anything ════════════════════════════════════
   *
   * Runs BEFORE the backfill, not during it, so an ambiguous organization stops
   * the migration with every table still untouched. A check interleaved with
   * the writes would leave some tables assigned and others not — a database in
   * a state no migration knows how to resume from.
   */
  await sql`
    DO $$
    DECLARE
      mapping jsonb := COALESCE(
        NULLIF(current_setting('ledgora.company_backfill_map', true), ''), '{}'
      )::jsonb;
      offender record;
      mapped uuid;
    BEGIN
      FOR offender IN
        /*
         * Every organization that owns at least one accounting row. UNION (not
         * UNION ALL) across the parent tables: a duplicate would only make the
         * message longer, and every child row belongs to one of these parents.
         */
        WITH occupied AS (
          SELECT organization_id FROM accounts
          UNION SELECT organization_id FROM journal_entries
          UNION SELECT organization_id FROM accounting_periods
          UNION SELECT organization_id FROM invoices
          UNION SELECT organization_id FROM opening_balance_sets
          UNION SELECT organization_id FROM invoice_numbering
        )
        SELECT o.organization_id,
               (SELECT count(*) FROM companies c WHERE c.organization_id = o.organization_id) AS company_count
        FROM occupied o
      LOOP
        /* An explicit mapping settles it, but only if it names a real company
         * of THIS organization. A mapping states a fact the database cannot
         * infer; it never overrides one it can. */
        mapped := NULLIF(mapping ->> offender.organization_id::text, '')::uuid;

        IF mapped IS NOT NULL THEN
          IF NOT EXISTS (
            SELECT 1 FROM companies
            WHERE id = mapped AND organization_id = offender.organization_id
          ) THEN
            RAISE EXCEPTION
              'Company backfill mapping for organization % names company %, which does not belong to it.',
              offender.organization_id, mapped
              USING ERRCODE = 'data_exception';
          END IF;
          CONTINUE;
        END IF;

        IF offender.company_count = 0 THEN
          RAISE EXCEPTION
            'Organization % has accounting records but no registered company. Register the company these books belong to, then run this migration again.',
            offender.organization_id
            USING ERRCODE = 'data_exception';
        END IF;

        IF offender.company_count > 1 THEN
          RAISE EXCEPTION
            'Organization % has accounting records and % registered companies, so which company these books belong to cannot be determined. Supply an explicit mapping in ledgora.company_backfill_map before migrating.',
            offender.organization_id, offender.company_count
            USING ERRCODE = 'data_exception';
        END IF;
      END LOOP;
    END $$
  `.execute(db);

  /* ══ 3. Backfill ═══════════════════════════════════════════════════════════
   *
   * Parents from the organization's single company (or its explicit mapping);
   * children from their parent row, so a child can never disagree with the
   * record it belongs to.
   */
  const resolved = `
    SELECT c.organization_id,
           COALESCE(
             NULLIF(COALESCE(NULLIF(current_setting('ledgora.company_backfill_map', true), ''), '{}')::jsonb
                      ->> c.organization_id::text, '')::uuid,
             c.id
           ) AS company_id
    FROM companies c
  `;

  for (const { table, via } of SCOPED_TABLES) {
    if (via) {
      await sql.raw(`
        UPDATE ${table} t
           SET company_id = p.company_id
          FROM ${via.parent} p
         WHERE t.${via.column} = p.id
           AND t.organization_id = p.organization_id
           AND t.company_id IS NULL
           AND p.company_id IS NOT NULL
      `).execute(db);
    }

    /*
     * The organization fallback. Needed for parent tables, and for the few
     * child rows whose parent link is nullable — an invoice payment with no
     * journal yet, an opening-balance set awaiting its reversal.
     */
    await sql.raw(`
      UPDATE ${table} t
         SET company_id = r.company_id
        FROM (${resolved}) r
       WHERE t.organization_id = r.organization_id
         AND t.company_id IS NULL
    `).execute(db);
  }

  /* ══ 4. Now it may be required ═════════════════════════════════════════════ */
  for (const { table } of SCOPED_TABLES) {
    await sql.raw(`ALTER TABLE ${table} ALTER COLUMN company_id SET NOT NULL`).execute(db);
  }

  /* ══ 5. Every row's company belongs to its own organization ════════════════
   *
   * The composite target is what makes this true. A plain
   * `REFERENCES companies(id)` would let one tenant's row name another tenant's
   * company — the precise mistake the organization-scoped keys in 013 were
   * written to avoid, repeated one level down.
   */
  for (const { table } of SCOPED_TABLES) {
    await sql.raw(`
      ALTER TABLE ${table}
        ADD CONSTRAINT ${table}_company_same_org
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE RESTRICT
    `).execute(db);
    await sql.raw(
      `CREATE INDEX IF NOT EXISTS ${table}_company_idx ON ${table} (organization_id, company_id)`,
    ).execute(db);
  }

  /* ══ 6. Targets for the company-scoped child keys ══════════════════════════ */
  for (const table of FK_TARGETS) {
    await sql.raw(`
      ALTER TABLE ${table}
        ADD CONSTRAINT ${table}_company_id_unique UNIQUE (organization_id, company_id, id)
    `).execute(db);
  }

  /* ══ 7. Re-point every cross-row key ═══════════════════════════════════════
   *
   * After this loop, a journal line referencing an account from another company
   * is not "rejected by the service" — it is unrepresentable. So is a reversal
   * that crosses companies, an invoice line drawing on another company's
   * revenue account, and an opening-balance set pointing at a foreign journal.
   */
  for (const key of SCOPED_KEYS) {
    await sql.raw(`ALTER TABLE ${key.table} DROP CONSTRAINT IF EXISTS ${key.constraint}`).execute(db);
    await sql.raw(`
      ALTER TABLE ${key.table}
        ADD CONSTRAINT ${key.next}
        FOREIGN KEY (organization_id, company_id, ${key.column})
        REFERENCES ${key.target} (organization_id, company_id, id) ON DELETE ${key.onDelete}
    `).execute(db);
  }

  /* ══ 8. Uniqueness moves down to the company ═══════════════════════════════
   *
   * This is what gives each company its own numbering. Two companies under one
   * subscriber may both keep an account 1000 "Cash", both write a JE-0001, and
   * both issue INV-2026-0001 — because they are different sets of books, and
   * anything else would force one customer's second company to start its
   * invoice numbering wherever the first one happened to stop.
   */
  const UNIQUES = [
    { table: 'accounting_periods', drop: 'accounting_periods_unique',
      add: 'accounting_periods_company_unique', columns: 'organization_id, company_id, fiscal_year, period_number' },
    { table: 'accounts', drop: 'accounts_code_unique',
      add: 'accounts_code_company_unique', columns: 'organization_id, company_id, account_code' },
    { table: 'journal_entries', drop: 'journal_entries_number_unique',
      add: 'journal_entries_number_company_unique', columns: 'organization_id, company_id, journal_number' },
    { table: 'invoices', drop: 'invoices_number_unique',
      add: 'invoices_number_company_unique', columns: 'organization_id, company_id, invoice_number' },
  ] as const;

  for (const u of UNIQUES) {
    await sql.raw(`ALTER TABLE ${u.table} DROP CONSTRAINT IF EXISTS ${u.drop}`).execute(db);
    await sql.raw(
      `ALTER TABLE ${u.table} ADD CONSTRAINT ${u.add} UNIQUE (${u.columns})`,
    ).execute(db);
  }

  /*
   * One active opening-balance set PER COMPANY, not per subscriber. Under the
   * old index, a customer's second company could never record its opening
   * balances at all — the first company's set already occupied the only slot.
   */
  await sql`DROP INDEX IF EXISTS opening_balance_sets_one_active`.execute(db);
  await sql`
    CREATE UNIQUE INDEX opening_balance_sets_one_active
      ON opening_balance_sets (organization_id, company_id)
      WHERE status IN ('draft','submitted','approved','posted')
  `.execute(db);

  /*
   * Independent invoice sequences. The primary key moves rather than gaining a
   * unique alongside it: leaving `(organization_id, issuing_entity_id)` as the
   * key would keep the two companies sharing one counter row, which is the
   * shared-numbering defect itself rather than a constraint about it.
   */
  await sql`ALTER TABLE invoice_numbering DROP CONSTRAINT IF EXISTS invoice_numbering_pkey`.execute(db);
  await sql`
    ALTER TABLE invoice_numbering
      ADD CONSTRAINT invoice_numbering_pkey
      PRIMARY KEY (organization_id, company_id, issuing_entity_id)
  `.execute(db);
}

/**
 * Development only.
 *
 * This reverses the SHAPE — the columns, keys and constraints — and nothing
 * else. It cannot reverse the assignment: once rows have been distributed
 * across companies, dropping `company_id` discards which books each row
 * belonged to, and re-running `up` afterwards would find an organization with
 * several companies and refuse, as it should.
 *
 * It also restores organization-level uniqueness, which will fail outright if
 * two companies have by then each written a JE-0001 — correctly so. That is not
 * a bug in this function; it is the reason a production rollback of this
 * migration does not exist.
 */
export async function down(db: AnyKysely): Promise<void> {
  await sql`ALTER TABLE invoice_numbering DROP CONSTRAINT IF EXISTS invoice_numbering_pkey`.execute(db);
  await sql`
    ALTER TABLE invoice_numbering
      ADD CONSTRAINT invoice_numbering_pkey PRIMARY KEY (organization_id, issuing_entity_id)
  `.execute(db);

  await sql`DROP INDEX IF EXISTS opening_balance_sets_one_active`.execute(db);
  await sql`
    CREATE UNIQUE INDEX opening_balance_sets_one_active
      ON opening_balance_sets (organization_id)
      WHERE status IN ('draft','submitted','approved','posted')
  `.execute(db);

  const RESTORE = [
    { table: 'accounting_periods', drop: 'accounting_periods_company_unique',
      add: 'accounting_periods_unique', columns: 'organization_id, fiscal_year, period_number' },
    { table: 'accounts', drop: 'accounts_code_company_unique',
      add: 'accounts_code_unique', columns: 'organization_id, account_code' },
    { table: 'journal_entries', drop: 'journal_entries_number_company_unique',
      add: 'journal_entries_number_unique', columns: 'organization_id, journal_number' },
    { table: 'invoices', drop: 'invoices_number_company_unique',
      add: 'invoices_number_unique', columns: 'organization_id, invoice_number' },
  ] as const;

  for (const key of SCOPED_KEYS) {
    await sql.raw(`ALTER TABLE ${key.table} DROP CONSTRAINT IF EXISTS ${key.next}`).execute(db);
    await sql.raw(`
      ALTER TABLE ${key.table}
        ADD CONSTRAINT ${key.constraint}
        FOREIGN KEY (organization_id, ${key.column})
        REFERENCES ${key.target} (organization_id, id) ON DELETE ${key.onDelete}
    `).execute(db);
  }

  for (const table of FK_TARGETS) {
    await sql.raw(
      `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_company_id_unique`,
    ).execute(db);
  }

  for (const u of RESTORE) {
    await sql.raw(`ALTER TABLE ${u.table} DROP CONSTRAINT IF EXISTS ${u.drop}`).execute(db);
    await sql.raw(
      `ALTER TABLE ${u.table} ADD CONSTRAINT ${u.add} UNIQUE (${u.columns})`,
    ).execute(db);
  }

  for (const { table } of SCOPED_TABLES) {
    await sql.raw(`DROP INDEX IF EXISTS ${table}_company_idx`).execute(db);
    await sql.raw(
      `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_company_same_org`,
    ).execute(db);
    await sql.raw(`ALTER TABLE ${table} DROP COLUMN IF EXISTS company_id`).execute(db);
  }
}

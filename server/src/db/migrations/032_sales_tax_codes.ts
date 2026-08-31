/**
 * Server-authoritative sales tax: controlled codes, effective-dated rates, and a
 * frozen snapshot on every issued line.
 *
 * ══ What this replaces ═══════════════════════════════════════════════════════
 *
 * The tax model was browser-resident in full — ten categories, seven scopes,
 * effective-dated rates, per-code account mappings — and the server held two
 * facts about tax: whether the company is registered, and a `default_tax_rate`
 * that nothing applies. So a durable invoice could not carry tax at all, and
 * S2b refused one outright rather than issue it at zero and understate output
 * tax on a document a customer receives.
 *
 * This is the table that lets the refusal be lifted for the part the server can
 * now stand behind: percentage sales tax, exclusive or inclusive, on a code the
 * books own.
 *
 * ══ Why the rate lives in its own table ══════════════════════════════════════
 *
 * A rate is not a property of a tax code, it is a property of a code ON A DATE.
 * Storing one number means a rate rise silently rewrites every invoice ever
 * issued under the old one — the documents a tax authority already holds copies
 * of. `tax_rate_versions` is effective-dated and append-mostly, and an issued
 * invoice line keeps the resolved figures frozen on itself besides, so history
 * survives even the version rows being edited.
 *
 * The spec (§5) requires periods not to overlap. That is enforced in the
 * service under a row lock rather than by an EXCLUDE constraint, because
 * `btree_gist` is an extension this deployment cannot assume; the unique index
 * on (code, effective_from) closes the cheap half of it in the database.
 *
 * ══ Why the output account hangs off the CODE, not the company ═══════════════
 *
 * §12 says the tax code must resolve its own output-tax account, and §5 lets a
 * rate version override it. One company-wide default would force two legally
 * distinct taxes into one control account and make a reconciliation that has to
 * separate them impossible. So the account is per code, with a per-version
 * override, and both are real foreign keys into the same company's chart.
 *
 * ══ Existing rows: halt, never invent ════════════════════════════════════════
 *
 * `invoice_lines.tax_code_id` has been a bare uuid since 019. Any value in it
 * came from a browser tax code the server never held, so there is no mapping
 * this migration could apply without inventing which tax an issued invoice
 * charged. It therefore REFUSES rather than guessing, exactly as 031 does for
 * customers.
 */
import { sql, type Kysely } from 'kysely';

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type AnyKysely = Kysely<any>;

const CODE_FK = 'invoice_lines_tax_code_fk';

export async function up(db: AnyKysely): Promise<void> {
  /* ── Precondition: no line may already name a tax code ─────────────────── */

  const { rows: orphans } = await sql<{ n: string; sample: string | null }>`
    SELECT COUNT(*)::text AS n, MIN(i.invoice_number) AS sample
      FROM invoice_lines l
      JOIN invoices i ON i.id = l.invoice_id
     WHERE l.tax_code_id IS NOT NULL
  `.execute(db);

  const count = Number(orphans[0]?.n ?? '0');
  if (count > 0) {
    throw new Error(
      `Refusing to add ${CODE_FK}: ${count} invoice line(s) already name a tax code `
      + `(for example invoice ${orphans[0]?.sample ?? 'unknown'}), and no server tax code exists yet. `
      + 'Those ids came from browser-held tax configuration the server never saw, so there is no '
      + 'mapping this migration could apply without inventing which tax an issued invoice charged. '
      + 'Remedy: create the matching tax codes through /api/tax-codes and repoint the lines, or — '
      + 'if the invoices are disposable development data — delete them, then run this again.',
    );
  }

  /* ── Tax codes ────────────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS tax_codes (
      id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id        uuid NOT NULL,
      company_id             uuid NOT NULL,
      code                   text NOT NULL,
      name                   text NOT NULL,
      description            text NOT NULL DEFAULT '',
      /*
       * The five categories the server can stand behind. Reverse-charge,
       * import, self-assessed, withholding and custom are deliberately absent:
       * each posts to accounts this slice has no controlled mapping for, and a
       * CHECK is a better refusal than a service branch somebody can delete.
       */
      category               text NOT NULL,
      calculation_method     text NOT NULL,
      status                 text NOT NULL DEFAULT 'active',
      /* The account output tax credits. Required before a TAXABLE code issues. */
      output_tax_account_id  uuid,
      effective_from         date NOT NULL,
      effective_to           date,
      version                integer NOT NULL DEFAULT 1,
      created_by             uuid,
      updated_by             uuid,
      created_at             timestamptz NOT NULL DEFAULT now(),
      updated_at             timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT tax_codes_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE,
      CONSTRAINT tax_codes_output_account_fk
        FOREIGN KEY (organization_id, company_id, output_tax_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT tax_codes_category_ck
        CHECK (category IN ('standard','reduced','zero-rated','exempt','out-of-scope')),
      CONSTRAINT tax_codes_method_ck
        CHECK (calculation_method IN ('exclusive','inclusive')),
      CONSTRAINT tax_codes_status_ck
        CHECK (status IN ('active','inactive','archived')),
      CONSTRAINT tax_codes_dates_ck
        CHECK (effective_to IS NULL OR effective_to >= effective_from),
      /*
       * A zero-tax category may not name an output account, and the absence is
       * the point: zero-rated, exempt and out-of-scope report a base and post
       * nothing, so an account here would imply a credit that must never exist.
       */
      CONSTRAINT tax_codes_zero_has_no_account_ck
        CHECK (category IN ('standard','reduced') OR output_tax_account_id IS NULL)
    )
  `.execute(db);

  /* One code string per set of books — the identifier a bookkeeper types. */
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS tax_codes_code_uidx
      ON tax_codes (organization_id, company_id, lower(code))
  `.execute(db);

  /*
   * The composite target the invoice line's snapshot FK points at.
   *
   * ADDED IF ABSENT, never dropped and recreated. A drop is not idempotent
   * here even with IF EXISTS: once `tax_rate_versions` holds a foreign key
   * against this constraint, PostgreSQL refuses to drop it — so a replay of
   * this migration against a database that already ran it would fail on the
   * DROP rather than skipping the ADD.
   */
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tax_codes_scoped_uk'
      ) THEN
        ALTER TABLE tax_codes
          ADD CONSTRAINT tax_codes_scoped_uk UNIQUE (organization_id, company_id, id);
      END IF;
    END $$
  `.execute(db);

  /* ── Effective-dated rates ────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS tax_rate_versions (
      id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id        uuid NOT NULL,
      company_id             uuid NOT NULL,
      tax_code_id            uuid NOT NULL,
      /* A PERCENTAGE, exact. Never a float, and never a money amount. */
      rate                   numeric(9,6) NOT NULL,
      effective_from         date NOT NULL,
      effective_to           date,
      /* Overrides the code's account for documents in this window only. */
      output_tax_account_id  uuid,
      created_by             uuid,
      created_at             timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT tax_rate_versions_code_fk
        FOREIGN KEY (organization_id, company_id, tax_code_id)
        REFERENCES tax_codes (organization_id, company_id, id) ON DELETE CASCADE,
      CONSTRAINT tax_rate_versions_output_account_fk
        FOREIGN KEY (organization_id, company_id, output_tax_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT tax_rate_versions_rate_ck CHECK (rate >= 0 AND rate < 1000),
      CONSTRAINT tax_rate_versions_dates_ck
        CHECK (effective_to IS NULL OR effective_to >= effective_from)
    )
  `.execute(db);

  /*
   * Two versions of one code cannot start on the same day. Full overlap
   * detection needs a range exclusion (and therefore btree_gist); the service
   * does that under a lock, and this index makes the commonest collision
   * impossible even if a caller bypassed it.
   */
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS tax_rate_versions_start_uidx
      ON tax_rate_versions (organization_id, company_id, tax_code_id, effective_from)
  `.execute(db);

  /* Added if absent, for the same reason as the one on `tax_codes`. */
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tax_rate_versions_scoped_uk'
      ) THEN
        ALTER TABLE tax_rate_versions
          ADD CONSTRAINT tax_rate_versions_scoped_uk UNIQUE (organization_id, company_id, id);
      END IF;
    END $$
  `.execute(db);

  /* ── Audit trail ──────────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS tax_code_audit_events (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL,
      company_id        uuid NOT NULL,
      tax_code_id       uuid NOT NULL,
      action            text NOT NULL,
      detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
      previous_version  integer,
      resulting_version integer,
      actor_user_id     uuid,
      actor_name        text NOT NULL DEFAULT '',
      created_at        timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT tax_code_audit_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS tax_code_audit_code_idx
      ON tax_code_audit_events (organization_id, company_id, tax_code_id, created_at DESC)
  `.execute(db);

  /* ── The frozen snapshot, on the line ─────────────────────────────────── */

  /*
   * Denormalised ON PURPOSE. `tax_code_id` alone would make an issued invoice
   * depend on mutable current configuration — archive the code or end-date the
   * rate and the document's own history changes underneath it. These columns
   * are what the invoice actually charged, and nothing but a reversal may
   * rewrite them.
   */
  await sql`
    ALTER TABLE invoice_lines
      ADD COLUMN IF NOT EXISTS tax_rate_version_id       uuid,
      ADD COLUMN IF NOT EXISTS tax_code_code             text,
      ADD COLUMN IF NOT EXISTS tax_code_name             text,
      ADD COLUMN IF NOT EXISTS tax_category              text,
      ADD COLUMN IF NOT EXISTS tax_calculation_method    text,
      ADD COLUMN IF NOT EXISTS tax_rate_effective_from   date,
      ADD COLUMN IF NOT EXISTS tax_rate_effective_to     date,
      ADD COLUMN IF NOT EXISTS taxable_amount            numeric(20,10) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tax_account_id            uuid,
      ADD COLUMN IF NOT EXISTS tax_point_date            date,
      ADD COLUMN IF NOT EXISTS tax_snapshot_at           timestamptz
  `.execute(db);

  await sql`ALTER TABLE invoice_lines DROP CONSTRAINT IF EXISTS ${sql.raw(CODE_FK)}`.execute(db);
  await sql`
    ALTER TABLE invoice_lines
      ADD CONSTRAINT ${sql.raw(CODE_FK)}
      FOREIGN KEY (organization_id, company_id, tax_code_id)
      REFERENCES tax_codes (organization_id, company_id, id)
      ON DELETE RESTRICT
  `.execute(db);

  /*
   * RESTRICT, for the reason 031 gives about customers: a tax code named on an
   * issued invoice must stay identifiable for as long as the invoice does,
   * which is why codes archive rather than delete.
   */

  await sql`
    ALTER TABLE invoice_lines DROP CONSTRAINT IF EXISTS invoice_lines_tax_account_fk
  `.execute(db);
  await sql`
    ALTER TABLE invoice_lines
      ADD CONSTRAINT invoice_lines_tax_account_fk
      FOREIGN KEY (organization_id, company_id, tax_account_id)
      REFERENCES accounts (organization_id, company_id, id)
      ON DELETE RESTRICT
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS invoice_lines_tax_code_idx
      ON invoice_lines (organization_id, company_id, tax_code_id)
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  /*
   * Reversible only as far as it is SAFE to be. The added columns are dropped
   * and the tables removed, which loses the tax history they hold — acceptable
   * only because `up` refuses to run against any database that already had
   * tax-bearing lines, so anything here was written after this migration.
   */
  await sql`ALTER TABLE invoice_lines DROP CONSTRAINT IF EXISTS ${sql.raw(CODE_FK)}`.execute(db);
  await sql`ALTER TABLE invoice_lines DROP CONSTRAINT IF EXISTS invoice_lines_tax_account_fk`.execute(db);
  await sql`DROP INDEX IF EXISTS invoice_lines_tax_code_idx`.execute(db);
  await sql`
    ALTER TABLE invoice_lines
      DROP COLUMN IF EXISTS tax_rate_version_id,
      DROP COLUMN IF EXISTS tax_code_code,
      DROP COLUMN IF EXISTS tax_code_name,
      DROP COLUMN IF EXISTS tax_category,
      DROP COLUMN IF EXISTS tax_calculation_method,
      DROP COLUMN IF EXISTS tax_rate_effective_from,
      DROP COLUMN IF EXISTS tax_rate_effective_to,
      DROP COLUMN IF EXISTS taxable_amount,
      DROP COLUMN IF EXISTS tax_account_id,
      DROP COLUMN IF EXISTS tax_point_date,
      DROP COLUMN IF EXISTS tax_snapshot_at
  `.execute(db);
  await sql`DROP TABLE IF EXISTS tax_code_audit_events`.execute(db);
  await sql`DROP TABLE IF EXISTS tax_rate_versions`.execute(db);
  await sql`DROP TABLE IF EXISTS tax_codes`.execute(db);
}

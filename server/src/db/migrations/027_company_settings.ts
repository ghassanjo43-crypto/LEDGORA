/**
 * Company accounting settings — per set of books, not per subscriber.
 *
 * ══ Why these belong to the COMPANY ══════════════════════════════════════════
 *
 * Fiscal year start, books start date, reporting framework and tax registration
 * decide what the numbers MEAN. A subscriber keeping two companies may run a
 * January year-end for one and an April year-end for the other, register only
 * one of them for tax, and report one under full IFRS and the other under IFRS
 * for SMEs. Holding any of that on the organization would force two legal
 * entities to share an accounting identity they do not have.
 *
 * `organizations` keeps its copies as ONBOARDING DEFAULTS — the value a newly
 * created company inherits. After that the company row is authoritative, and
 * nothing reads the organization for reporting.
 *
 * ══ Why the browser cannot keep them ═════════════════════════════════════════
 *
 * These lived in `useStore.settings` in localStorage, where a fiscal year could
 * be changed from devtools and where clearing site data silently reset the
 * basis on which every statement is prepared. A setting that changes what a
 * financial statement means cannot be editable by the reader of that statement.
 *
 * ══ Accrual only, and why the constraint says so ═════════════════════════════
 *
 * The browser type allows `'cash'`, and nothing implements it. IFRS statements
 * are accrual-based, and cash basis is a different recognition model touching
 * every report — not a toggle. The CHECK permits exactly one value, so the
 * unimplemented option cannot be stored while it is unimplemented; widening it
 * later is a migration, which is the correct amount of ceremony for changing
 * how revenue is recognised.
 *
 * ══ What is NOT here ═════════════════════════════════════════════════════════
 *
 *   · `base_currency` stays on the organization. It is already authoritative
 *     there, journals copy it at posting time, and moving it is a separate
 *     decision with its own risks.
 *   · `presentation_mode` and every view preference stay in the browser. They
 *     change how a statement is laid out, never what it says.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS company_settings (
      organization_id uuid NOT NULL,
      company_id uuid NOT NULL,

      /* ── Accounting meaning ─────────────────────────────────────────────── */
      /** ISO month-day, e.g. '01-01' for a calendar year. */
      fiscal_year_start text NOT NULL DEFAULT '01-01',
      /** When the books open. Null until the customer says. */
      books_start_date date,
      accounting_basis text NOT NULL DEFAULT 'accrual',
      reporting_framework text NOT NULL DEFAULT 'IFRS',

      /* ── Tax ────────────────────────────────────────────────────────────── */
      tax_registered boolean NOT NULL DEFAULT false,
      tax_registration_number text NOT NULL DEFAULT '',
      /** A percentage, held exactly. Never a float. */
      default_tax_rate numeric(9,4) NOT NULL DEFAULT 0,

      /* ── Identity and the document block ────────────────────────────────── */
      organization_type text NOT NULL DEFAULT '',
      industry_type text NOT NULL DEFAULT '',
      logo_url text NOT NULL DEFAULT '',
      email text NOT NULL DEFAULT '',
      phone text NOT NULL DEFAULT '',
      website text NOT NULL DEFAULT '',
      country text NOT NULL DEFAULT '',
      state_province text NOT NULL DEFAULT '',
      city text NOT NULL DEFAULT '',
      address_line1 text NOT NULL DEFAULT '',
      address_line2 text NOT NULL DEFAULT '',
      postal_code text NOT NULL DEFAULT '',

      /** Optimistic concurrency. Every update increments it. */
      version integer NOT NULL DEFAULT 1 CHECK (version >= 1),

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      /*
       * One settings record per set of books, enforced by the key itself
       * rather than by a uniqueness rule somebody has to remember to add.
       */
      CONSTRAINT company_settings_pkey PRIMARY KEY (organization_id, company_id),

      /*
       * Accrual only, until cash basis is specified and tested. See the header.
       */
      CONSTRAINT company_settings_accrual_only CHECK (accounting_basis = 'accrual'),

      CONSTRAINT company_settings_framework CHECK (
        reporting_framework IN ('IFRS', 'IFRS_FOR_SMES', 'US_GAAP', 'OTHER')
      ),
      /* A month-day, not a date: '01-01' through '12-31'. */
      CONSTRAINT company_settings_fiscal_year_start CHECK (
        fiscal_year_start ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
      ),
      CONSTRAINT company_settings_tax_rate CHECK (
        default_tax_rate >= 0 AND default_tax_rate <= 100
      ),
      /* A tax number with nothing registered is a state nobody meant. */
      CONSTRAINT company_settings_tax_number_requires_registration CHECK (
        tax_registration_number = '' OR tax_registered
      )
    )
  `.execute(db);

  /*
   * The company this belongs to, and its organization, in one key — the same
   * composite target every company-scoped table uses (migration 025). A plain
   * `REFERENCES companies(id)` would let one tenant's settings name another
   * tenant's company.
   */
  await sql`
    ALTER TABLE company_settings
      DROP CONSTRAINT IF EXISTS company_settings_company_same_org
  `.execute(db);
  await sql`
    ALTER TABLE company_settings
      ADD CONSTRAINT company_settings_company_same_org
      FOREIGN KEY (organization_id, company_id)
      REFERENCES companies (organization_id, id) ON DELETE CASCADE
  `.execute(db);

  /*
   * ── Backfill ────────────────────────────────────────────────────────────
   *
   * One row per existing company, inheriting the organization's onboarding
   * defaults. Deterministic and derived entirely from the database: the browser
   * is never read, and nothing here depends on when the migration runs — a
   * `now()`-derived books start date would give two deployments two different
   * sets of books.
   *
   * Anything the organization does not hold takes the column default, which is
   * the neutral value rather than a guess.
   */
  await sql`
    INSERT INTO company_settings (
      organization_id, company_id,
      fiscal_year_start, books_start_date,
      tax_registration_number, tax_registered,
      industry_type, country
    )
    SELECT
      c.organization_id,
      c.id,
      COALESCE(NULLIF(o.fiscal_year_start, ''), '01-01'),
      o.books_start_date,
      COALESCE(o.tax_number, ''),
      /* Registered only where a number actually exists — the CHECK above
       * refuses the reverse, and inventing a true here would misstate a
       * customer's tax status. */
      COALESCE(o.tax_number, '') <> '',
      COALESCE(o.industry, ''),
      COALESCE(o.country, '')
    FROM companies c
    JOIN organizations o ON o.id = c.organization_id
    ON CONFLICT (organization_id, company_id) DO NOTHING
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DROP TABLE IF EXISTS company_settings`.execute(db);
}

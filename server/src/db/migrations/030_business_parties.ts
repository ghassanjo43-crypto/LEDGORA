/**
 * The business-party directory: one legal party, one or more roles.
 *
 * ══ Why this is NOT a customers table ════════════════════════════════════════
 *
 * The product already models one party that can be a customer, a supplier, or
 * BOTH — `EntityType = 'customer' | 'supplier' | 'both'`, with fourteen callers
 * branching on it and a form that shows both role sections at once. Splitting
 * that into `customers` and `suppliers` would duplicate every party that trades
 * in both directions, and duplication is not a cosmetic problem here: the party
 * code and the tax registration number are unique across the whole directory,
 * so a duplicated party means the same legal entity existing twice with two
 * codes and a tax number that can only be recorded against one of them.
 *
 * So identity lives once, and roles are flags on it. A party keeps one legal
 * name, one code, one tax number and one address book however many roles it
 * holds, which is what the tax authority believes and therefore what the books
 * must say.
 *
 * ══ Role PROFILES are separate tables ════════════════════════════════════════
 *
 * The customer-only fields live in `business_party_customer_profiles`, keyed by
 * the party. That is what lets the customer route change customer fields and
 * shared fields while being structurally incapable of touching supplier ones —
 * the columns are not in a table it writes. The supplier profile is deliberately
 * NOT created here; it belongs to the Purchasing slice, and creating an empty
 * table now would invite a half-owned write path before anything guards it.
 *
 * ══ Replayable ══════════════════════════════════════════════════════════════
 *
 * Every statement is IF NOT EXISTS. Migration 012 is a repair that can be
 * replayed against a database still holding the objects it creates —
 * `deletionTombstoneRepair` unrecords everything from 012 upward and runs the
 * stack again — so every migration above it has to survive meeting its own
 * work. A bare CREATE TABLE here fails that replay, which is how this was
 * caught.
 *
 * ══ Archive, never delete ════════════════════════════════════════════════════
 *
 * A party named on an issued invoice must stay identifiable forever, so there is
 * no delete path and the foreign keys that will arrive with Sales are RESTRICT.
 * `status` moves between `active` and `archived`; removing a ROLE clears its
 * flag and leaves the party and its other role untouched.
 */
import { sql, type Kysely } from 'kysely';

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS business_parties (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      /*
       * Scoped WITH the organization, never instead of it. The composite key
       * below is what makes one tenant naming another tenant's company
       * unrepresentable rather than merely refused.
       */
      company_id uuid NOT NULL,

      party_code text NOT NULL,
      legal_name text NOT NULL,
      trading_name text NOT NULL DEFAULT '',

      /*
       * The roles this party holds. Flags rather than a single enum, because
       * 'both' is not a third kind of party — it is a party holding two roles,
       * and modelling it as an enum value is what makes "stop being a customer
       * but stay a supplier" an awkward state transition instead of clearing a
       * boolean.
       */
      is_customer boolean NOT NULL DEFAULT false,
      is_supplier boolean NOT NULL DEFAULT false,

      contact_person text NOT NULL DEFAULT '',
      job_title text NOT NULL DEFAULT '',
      email text NOT NULL DEFAULT '',
      phone text NOT NULL DEFAULT '',
      mobile text NOT NULL DEFAULT '',
      website text NOT NULL DEFAULT '',

      tax_registration_number text NOT NULL DEFAULT '',
      commercial_registration_number text NOT NULL DEFAULT '',
      payment_terms text NOT NULL DEFAULT 'NET_30',
      default_currency text NOT NULL DEFAULT '',

      bank_name text NOT NULL DEFAULT '',
      bank_account_name text NOT NULL DEFAULT '',
      iban text NOT NULL DEFAULT '',
      swift_code text NOT NULL DEFAULT '',

      notes text NOT NULL DEFAULT '',

      /** active | archived. There is no deleted state; see the header. */
      status text NOT NULL DEFAULT 'active',
      archived_at timestamptz,

      /* Optimistic concurrency, so two editors cannot silently overwrite. */
      version integer NOT NULL DEFAULT 1,

      created_by uuid,
      updated_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT business_parties_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE RESTRICT,

      /* The composite target the role and address tables point at. */
      CONSTRAINT business_parties_scoped_key UNIQUE (organization_id, company_id, id),

      CONSTRAINT business_parties_status_known
        CHECK (status IN ('active', 'archived')),

      /* A party with no role at all is a record nobody can reach. */
      CONSTRAINT business_parties_has_a_role
        CHECK (is_customer OR is_supplier),

      CONSTRAINT business_parties_legal_name_present
        CHECK (length(btrim(legal_name)) > 0),

      CONSTRAINT business_parties_code_present
        CHECK (length(btrim(party_code)) > 0)
    )
  `.execute(db);

  /*
   * Uniqueness is per COMPANY and case-insensitive, across every role.
   *
   * Case-insensitive because "acme" and "ACME" are the same customer to
   * everyone except a byte comparison, and the browser directory has always
   * compared them folded. Per company rather than per organization because two
   * companies in one group keep separate directories and legitimately both
   * trade with the same supplier.
   */
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS business_parties_code_unique
      ON business_parties (organization_id, company_id, lower(btrim(party_code)))
  `.execute(db);

  /*
   * The tax number is unique only when present. A partial index rather than a
   * plain one: most parties in a small directory have no tax number recorded,
   * and a plain unique index would let exactly one of them be blank.
   */
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS business_parties_tax_number_unique
      ON business_parties (organization_id, company_id, lower(btrim(tax_registration_number)))
      WHERE btrim(tax_registration_number) <> ''
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS business_parties_directory
      ON business_parties (organization_id, company_id, status, party_code)
  `.execute(db);

  /* ── Addresses ────────────────────────────────────────────────────────── */

  /*
   * Several addresses per party, each with a purpose.
   *
   * The browser record carried exactly one flattened address. Keeping that
   * shape server-side would mean a second migration the first time somebody
   * invoices a customer whose delivery address differs from the one on their
   * trade licence, which is most customers. The single browser address becomes
   * one billing row marked primary.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS business_party_addresses (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id uuid NOT NULL,
      party_id uuid NOT NULL,

      /** billing | shipping | registered */
      purpose text NOT NULL DEFAULT 'billing',
      is_primary boolean NOT NULL DEFAULT false,

      address_line1 text NOT NULL DEFAULT '',
      address_line2 text NOT NULL DEFAULT '',
      city text NOT NULL DEFAULT '',
      postal_code text NOT NULL DEFAULT '',
      country text NOT NULL DEFAULT '',

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT business_party_addresses_party_fk
        FOREIGN KEY (organization_id, company_id, party_id)
        REFERENCES business_parties (organization_id, company_id, id) ON DELETE CASCADE,

      CONSTRAINT business_party_addresses_purpose_known
        CHECK (purpose IN ('billing', 'shipping', 'registered'))
    )
  `.execute(db);

  /* At most one primary address per purpose, enforced rather than hoped for. */
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS business_party_addresses_one_primary
      ON business_party_addresses (organization_id, company_id, party_id, purpose)
      WHERE is_primary
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS business_party_addresses_by_party
      ON business_party_addresses (organization_id, company_id, party_id)
  `.execute(db);

  /* ── The customer role's own fields ───────────────────────────────────── */

  /*
   * Keyed by the party, one row per customer. Separate from the party for the
   * reason in the header: the customer route can be given this table and the
   * shared one, and is then STRUCTURALLY unable to write a supplier field,
   * rather than merely careful not to.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS business_party_customer_profiles (
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id uuid NOT NULL,
      party_id uuid NOT NULL,

      customer_category text NOT NULL DEFAULT '',

      /*
       * numeric, not a float. It is a money limit that gets compared against a
       * receivable balance, and the balance is numeric everywhere else; a
       * binary float here would make the comparison wrong for values it can
       * represent only approximately.
       */
      credit_limit numeric(28,10) NOT NULL DEFAULT 0,

      /*
       * Chart-of-accounts ids, scoped to these books.
       *
       * A real foreign key, because accounts exists: this is the first table
       * that can enforce what invoices could only validate, and an account
       * from another company's chart is refused by the database rather than by
       * a service that has to remember to check.
       */
      default_revenue_account_id uuid,
      default_receivable_account_id uuid,

      /* Browser-resident still; see 019_sales_invoices for the same reason. */
      default_invoice_template_id uuid,

      invoice_delivery_method text NOT NULL DEFAULT '',
      customer_payment_terms text NOT NULL DEFAULT '',

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      PRIMARY KEY (organization_id, company_id, party_id),

      CONSTRAINT business_party_customer_profiles_party_fk
        FOREIGN KEY (organization_id, company_id, party_id)
        REFERENCES business_parties (organization_id, company_id, id) ON DELETE CASCADE,

      CONSTRAINT business_party_customer_profiles_revenue_fk
        FOREIGN KEY (organization_id, company_id, default_revenue_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,

      CONSTRAINT business_party_customer_profiles_receivable_fk
        FOREIGN KEY (organization_id, company_id, default_receivable_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,

      CONSTRAINT business_party_customer_profiles_credit_limit_not_negative
        CHECK (credit_limit >= 0)
    )
  `.execute(db);

  /* ── Audit ────────────────────────────────────────────────────────────── */

  /*
   * Its own table rather than accounting_audit_events.
   *
   * That table's action vocabulary is a closed union describing acts on the
   * LEDGER, and widening it with master-data verbs would make "what happened to
   * the books" a question you can no longer answer by reading one column. A
   * party directory is not the ledger; invoice_audit_events is separate for
   * the same reason.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS business_party_audit_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id uuid NOT NULL,
      party_id uuid NOT NULL,

      action text NOT NULL,
      actor_user_id uuid,
      actor_name text NOT NULL DEFAULT '',
      reason text NOT NULL DEFAULT '',
      previous_version integer,
      resulting_version integer,
      /* Which fields actually changed, so a shared-field edit is findable. */
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      request_id text,
      at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT business_party_audit_events_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE RESTRICT
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS business_party_audit_events_by_party
      ON business_party_audit_events (organization_id, company_id, party_id, at DESC)
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DROP TABLE IF EXISTS business_party_audit_events`.execute(db);
  await sql`DROP TABLE IF EXISTS business_party_customer_profiles`.execute(db);
  await sql`DROP TABLE IF EXISTS business_party_addresses`.execute(db);
  await sql`DROP TABLE IF EXISTS business_parties`.execute(db);
}

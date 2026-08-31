/**
 * The supplier role's own fields — the half of the party directory 030 deferred.
 *
 * ══ Why this is a profile and not a `suppliers` table ════════════════════════
 *
 * Migration 030 settled the identity model and gave the reason: the product
 * models ONE party that may be a customer, a supplier, or both, and splitting
 * that in two would duplicate every party that trades in both directions. The
 * party code and the tax registration number are unique across the whole
 * directory, so a duplicated party means one legal entity existing twice with
 * two codes and a tax number recordable against only one of them.
 *
 * 030 also said why this table was not created then: "it belongs to the
 * Purchasing slice, and creating an empty table now would invite a half-owned
 * write path before anything guards it." This is that slice, and the guard
 * arrives with the table.
 *
 * ══ What the separation buys ═════════════════════════════════════════════════
 *
 * The customer route can be handed the shared party columns and the customer
 * profile and is then STRUCTURALLY unable to write a supplier field — the
 * columns are not in a table it writes. This table gives the vendor route the
 * mirror of that arrangement. Neither route can reach across, and that is a
 * property of which tables each service touches rather than of anybody
 * remembering to be careful.
 *
 * ══ The payable account is a real key, and only a key ════════════════════════
 *
 * `default_payable_account_id` is a composite foreign key into the SAME
 * company's chart, so a supplier pointing at another company's payable control
 * is unrepresentable rather than merely refused. What a key cannot express —
 * that the account is a liability, active, unblocked, unarchived, postable and
 * not a parent — the service checks on the way in, and this migration records
 * that division of labour rather than leaving the next reader to wonder why the
 * database is silent about it.
 *
 * ══ What these columns do NOT imply ══════════════════════════════════════════
 *
 * `default_expense_account_id`, `withholding_tax_applicable` and
 * `preferred_payment_method` are master data whose meaning the product already
 * established. Nothing posts them: there are no bills, no payments and no
 * withholding on the server, and P1 does not add any. They are recorded because
 * a supplier record that silently dropped them on the way to the server would
 * lose data the user entered — not because the workflows behind them exist.
 *
 * ══ Replayable ══════════════════════════════════════════════════════════════
 *
 * Every statement is IF NOT EXISTS, and the backfill is an anti-joined INSERT.
 * Migration 012 is a repair that unrecords everything from 012 upward and runs
 * the stack again, so every migration above it has to survive meeting its own
 * work.
 */
import { sql, type Kysely } from 'kysely';

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  /* ── Precondition ─────────────────────────────────────────────────────── */

  /*
   * A supplier-role party whose company no longer exists would break the
   * composite key below. There is no honest automatic remedy — the profile
   * would have to be attached to some other company's books, which is a
   * different supplier — so this REFUSES and says how many and which.
   */
  const { rows: orphans } = await sql<{ n: string; sample: string | null }>`
    SELECT COUNT(*)::text AS n, MIN(p.party_code) AS sample
      FROM business_parties p
      LEFT JOIN companies c
        ON c.id = p.company_id AND c.organization_id = p.organization_id
     WHERE p.is_supplier = true AND c.id IS NULL
  `.execute(db);

  const orphaned = Number(orphans[0]?.n ?? '0');
  if (orphaned > 0) {
    throw new Error(
      `Refusing to add business_party_supplier_profiles: ${orphaned} supplier-role part(y/ies) `
      + `belong to a company that no longer exists (for example ${orphans[0]?.sample ?? 'unknown'}). `
      + 'A profile cannot be attached to books that are not there, and attaching it to a different '
      + "company's would make it a different supplier. "
      + 'Remedy: restore the company, or archive those parties, then run this again.',
    );
  }

  /* ── The supplier role's fields ───────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS business_party_supplier_profiles (
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id uuid NOT NULL,
      party_id uuid NOT NULL,

      supplier_category text NOT NULL DEFAULT '',

      /*
       * Accounts Payable control for this supplier.
       *
       * Per SUPPLIER, mirroring the receivable on the customer profile. There is
       * no company-level default anywhere in this product: company_settings
       * holds none, and sales issuing refuses an invoice whose customer has no
       * receivable rather than falling back to one — so there is no precedence
       * rule here to get wrong.
       */
      default_payable_account_id uuid,

      /*
       * A default expense account for future bills. Master data only: nothing
       * posts it, because P1 creates no bills.
       */
      default_expense_account_id uuid,

      supplier_payment_terms text NOT NULL DEFAULT '',

      /*
       * Recorded, never acted on. Withholding has no server-side accounting
       * treatment — S2c refused the category outright — so this says what the
       * user told us about the supplier and promises nothing about a workflow.
       */
      withholding_tax_applicable boolean NOT NULL DEFAULT false,
      preferred_payment_method text NOT NULL DEFAULT '',

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      PRIMARY KEY (organization_id, company_id, party_id),

      CONSTRAINT business_party_supplier_profiles_party_fk
        FOREIGN KEY (organization_id, company_id, party_id)
        REFERENCES business_parties (organization_id, company_id, id) ON DELETE CASCADE,

      /*
       * RESTRICT, not CASCADE. An account named as a supplier's payable control
       * must stay identifiable for as long as the supplier does, which is the
       * same rule the chart already enforces everywhere else.
       */
      CONSTRAINT business_party_supplier_profiles_payable_fk
        FOREIGN KEY (organization_id, company_id, default_payable_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,

      CONSTRAINT business_party_supplier_profiles_expense_fk
        FOREIGN KEY (organization_id, company_id, default_expense_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS business_party_supplier_profiles_by_party
      ON business_party_supplier_profiles (organization_id, company_id, party_id)
  `.execute(db);

  /* ── Backfill ─────────────────────────────────────────────────────────── */

  /*
   * A profile row for every party that already holds the supplier role, so a
   * read does not have to distinguish "no profile" from "empty profile".
   *
   * Every value is the column default. Nothing is inferred — in particular no
   * payable account is guessed, because guessing which liability account a
   * supplier posts to is exactly the kind of invention that reaches an audit.
   * Anti-joined, so a replay adds nothing a second time.
   */
  await sql`
    INSERT INTO business_party_supplier_profiles (organization_id, company_id, party_id)
    SELECT p.organization_id, p.company_id, p.id
      FROM business_parties p
     WHERE p.is_supplier = true
       AND NOT EXISTS (
         SELECT 1 FROM business_party_supplier_profiles s
          WHERE s.organization_id = p.organization_id
            AND s.company_id = p.company_id
            AND s.party_id = p.id
       )
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  /*
   * Safe to drop ONLY because the table it removes is additive: the shared
   * party rows, their addresses and the customer profiles are untouched, and a
   * party keeps its supplier ROLE flag. What is lost is the supplier-only
   * master data this migration introduced, which nothing before it could hold.
   *
   * No party is deleted and no role is withdrawn. A down migration that removed
   * suppliers themselves would destroy real records to satisfy a rollback,
   * which is never a trade worth making.
   */
  await sql`DROP TABLE IF EXISTS business_party_supplier_profiles`.execute(db);
}

/**
 * Supplier payments and the allocations that settle bills.
 *
 * ══ Allocations are ROWS, and they are never deleted ══════════════════════════
 *
 * A payment's link to a bill is its own record with its own lifetime: `active`
 * while it settles, `superseded` when an atomic reallocation replaced it,
 * `reversed` when the payment was reversed. Nothing removes one.
 *
 * That is what makes a bill's outstanding balance derivable rather than stored.
 * A mutable `balance_due` column is a second source of truth that drifts the
 * first time a write is lost, and the drift is invisible — the number still
 * looks like a number. Here the balance is the bill total less its ACTIVE
 * allocations, computed from rows that cannot be edited in place.
 *
 * ══ Why there is no unapplied-cash column ════════════════════════════════════
 *
 * A posted payment must be fully allocated. The specification models supplier
 * advances and unapplied payments, but the advances account is resolved by a
 * hard-coded browser account CODE with no controlled server mapping, and
 * supplier refunds have no workflow at all — so an unapplied balance here would
 * be money with nowhere defined to sit. It is refused in the service, and there
 * is no column for it, which is the same refusal expressed twice.
 *
 * ══ One date ═════════════════════════════════════════════════════════════════
 *
 * `payment_date` is the payment date AND the posting date: the browser journal
 * uses `entryDate: payment.paymentDate` and there is no second field to
 * reconcile. Period locks are enforced against it.
 */
import { sql, type Kysely } from 'kysely';

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  /* ── Precondition ─────────────────────────────────────────────────────── */

  /*
   * A posted bill whose company has gone would break the composite key an
   * allocation needs. There is no honest remedy — attaching the bill to another
   * company's books makes it a different bill — so this refuses with counts.
   */
  const { rows: orphans } = await sql<{ n: string; sample: string | null }>`
    SELECT COUNT(*)::text AS n, MIN(b.bill_number) AS sample
      FROM bills b
      LEFT JOIN companies c
        ON c.id = b.company_id AND c.organization_id = b.organization_id
     WHERE c.id IS NULL
  `.execute(db);

  const orphaned = Number(orphans[0]?.n ?? '0');
  if (orphaned > 0) {
    throw new Error(
      `Refusing to add supplier payments: ${orphaned} bill(s) belong to a company that no longer `
      + `exists (for example ${orphans[0]?.sample ?? 'unknown'}). An allocation cannot point at a `
      + 'bill whose books are gone. Remedy: restore the company, or remove those bills, then run '
      + 'this again.',
    );
  }

  /* ── Numbering ────────────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS payment_numbering (
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id        uuid NOT NULL,
      issuing_entity_id text NOT NULL,
      prefix            text NOT NULL DEFAULT 'PAY-',
      include_year      boolean NOT NULL DEFAULT true,
      sequence_length   integer NOT NULL DEFAULT 4,
      /* Held, never derived: a counted sequence reuses a number after a delete. */
      next_sequence     integer NOT NULL DEFAULT 1,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),

      PRIMARY KEY (organization_id, company_id, issuing_entity_id),
      CONSTRAINT payment_numbering_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE
    )
  `.execute(db);

  /* ── Payments ─────────────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS supplier_payments (
      id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      /* Direct, as well as the composite company key: the tenant inventory
       * walks what REFERENCES organizations, and a table it cannot see is one a
       * purge silently leaves behind. */
      organization_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id                uuid NOT NULL,
      issuing_entity_id         text NOT NULL,

      supplier_id               uuid NOT NULL,
      payment_number            text NOT NULL,

      /* draft | posted | reversed, and nothing else. The browser lifecycle also
       * has submitted, approved, partially-allocated, fully-allocated and void;
       * each needs a workflow this slice does not bring, and a posted payment is
       * fully allocated by construction so the two allocation states collapse. */
      status                    text NOT NULL DEFAULT 'draft',

      /* The payment date IS the posting date. See the header. */
      payment_date              date NOT NULL,
      currency                  text NOT NULL,
      amount                    numeric(20,10) NOT NULL DEFAULT 0,

      /* Descriptive: it selects which account the user picks, and the server
       * validates that account itself. No method changes the accounting. */
      method                    text NOT NULL DEFAULT 'bank-transfer',
      reference                 text NOT NULL DEFAULT '',
      memo                      text NOT NULL DEFAULT '',

      /* FROZEN at posting, so later master-data changes cannot restate history. */
      cash_account_id           uuid,
      payable_account_id        uuid,

      journal_entry_id          uuid,
      reversal_journal_entry_id uuid,
      reversal_reason           text,

      posted_at                 timestamptz,
      reversed_at               timestamptz,

      version                   integer NOT NULL DEFAULT 1,
      created_by                uuid,
      updated_by                uuid,
      created_at                timestamptz NOT NULL DEFAULT now(),
      updated_at                timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT supplier_payments_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE RESTRICT,

      /* A real P1 supplier in the SAME books. RESTRICT, because a supplier named
       * on a posted payment must stay identifiable for as long as it does. */
      CONSTRAINT supplier_payments_supplier_fk
        FOREIGN KEY (organization_id, company_id, supplier_id)
        REFERENCES business_parties (organization_id, company_id, id) ON DELETE RESTRICT,

      CONSTRAINT supplier_payments_cash_account_fk
        FOREIGN KEY (organization_id, company_id, cash_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT supplier_payments_payable_account_fk
        FOREIGN KEY (organization_id, company_id, payable_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,

      CONSTRAINT supplier_payments_status_known
        CHECK (status IN ('draft', 'posted', 'reversed')),
      CONSTRAINT supplier_payments_amount_positive
        CHECK (amount >= 0),
      /* A posted payment has a journal and both frozen accounts. */
      CONSTRAINT supplier_payments_posted_has_journal
        CHECK (
          status = 'draft'
          OR (journal_entry_id IS NOT NULL
              AND cash_account_id IS NOT NULL
              AND payable_account_id IS NOT NULL)
        ),
      CONSTRAINT supplier_payments_reversed_has_reversal
        CHECK (status <> 'reversed' OR reversal_journal_entry_id IS NOT NULL),

      CONSTRAINT supplier_payments_scoped_key UNIQUE (organization_id, company_id, id)
    )
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS supplier_payments_number_unique
      ON supplier_payments (organization_id, company_id, lower(btrim(payment_number)))
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS supplier_payments_directory
      ON supplier_payments (organization_id, company_id, status, payment_date DESC)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS supplier_payments_by_supplier
      ON supplier_payments (organization_id, company_id, supplier_id)
  `.execute(db);

  /* ── Allocations ──────────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS payment_allocations (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id       uuid NOT NULL,
      payment_id       uuid NOT NULL,
      bill_id          uuid NOT NULL,

      amount           numeric(20,10) NOT NULL,

      /*
       * active     — settling the bill now.
       * superseded — replaced by an atomic reallocation. Kept for audit.
       * reversed   — neutralised because the payment was reversed. Kept.
       *
       * Only ACTIVE rows reduce a bill's outstanding balance, which is why a
       * row is never deleted: the trail of what settled what has to survive
       * every correction.
       */
      status           text NOT NULL DEFAULT 'active',
      superseded_at    timestamptz,
      reversed_at      timestamptz,
      created_at       timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT payment_allocations_payment_fk
        FOREIGN KEY (organization_id, company_id, payment_id)
        REFERENCES supplier_payments (organization_id, company_id, id) ON DELETE RESTRICT,

      CONSTRAINT payment_allocations_bill_fk
        FOREIGN KEY (organization_id, company_id, bill_id)
        REFERENCES bills (organization_id, company_id, id) ON DELETE RESTRICT,

      CONSTRAINT payment_allocations_status_known
        CHECK (status IN ('active', 'superseded', 'reversed')),
      /* A zero allocation settles nothing and would only add noise to a trail. */
      CONSTRAINT payment_allocations_amount_positive
        CHECK (amount > 0)
    )
  `.execute(db);

  /* The index the balance derivation reads: active rows for one bill. */
  await sql`
    CREATE INDEX IF NOT EXISTS payment_allocations_by_bill
      ON payment_allocations (organization_id, company_id, bill_id, status)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS payment_allocations_by_payment
      ON payment_allocations (organization_id, company_id, payment_id, status)
  `.execute(db);

  /* ── Audit ────────────────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS payment_audit_events (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id        uuid NOT NULL,
      payment_id        uuid NOT NULL,
      action            text NOT NULL,
      detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
      previous_version  integer,
      resulting_version integer,
      actor_user_id     uuid,
      actor_name        text NOT NULL DEFAULT '',
      at                timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT payment_audit_events_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS payment_audit_events_by_payment
      ON payment_audit_events (organization_id, company_id, payment_id, at DESC)
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  /*
   * ══ Why this refuses over posted settlement history ════════════════════════
   *
   * Dropping these tables removes every payment and every allocation while
   * their bank journals stay in the ledger — leaving cash movements no document
   * explains, and bills whose outstanding balances silently jump back up
   * because the allocations that settled them are gone.
   *
   * So it rolls back only while no payment has been posted, which is the case a
   * rollback legitimately needs: the migration was applied and is being undone
   * before anything used it.
   */
  const { rows } = await sql<{ n: string }>`
    SELECT COUNT(*)::text AS n FROM supplier_payments WHERE status <> 'draft'
  `.execute(db);
  const posted = Number(rows[0]?.n ?? '0');
  if (posted > 0) {
    throw new Error(
      `Refusing to roll back 036_supplier_payments: ${posted} payment(s) have been posted. `
      + 'Dropping these tables would destroy them and their allocations while the bank journals '
      + 'remain in the ledger, leaving cash entries no document explains and bill balances that '
      + 'silently reopen. Reverse those payments deliberately first if this is really intended.',
    );
  }

  await sql`DROP TABLE IF EXISTS payment_audit_events`.execute(db);
  await sql`DROP TABLE IF EXISTS payment_allocations`.execute(db);
  await sql`DROP TABLE IF EXISTS supplier_payments`.execute(db);
  await sql`DROP TABLE IF EXISTS payment_numbering`.execute(db);
}

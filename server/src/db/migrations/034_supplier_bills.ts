/**
 * Supplier bills: the payable side of a source document, server-authoritative.
 *
 * ══ What P2 holds, and what it deliberately does not ═════════════════════════
 *
 * A bill here is a functional-currency, tax-free record of what the business
 * owes a supplier for services, expenses or a non-inventory asset. It debits
 * accounts the server validated and credits the payable the SUPPLIER's own
 * profile names.
 *
 * There are no payments, no purchase tax, no stock, no charges and no
 * foreign-currency columns — not "nullable and unused", absent. A column the
 * server cannot compute is one a screen will eventually fill in and nothing
 * will honour, so the refusal lives in the shape of the table as well as in the
 * service.
 *
 * ══ Numbers are ALLOCATED; supplier references are NOT unique ════════════════
 *
 * The internal bill number is allocated at draft creation from `bill_numbering`
 * under an advisory lock, exactly as invoice numbers are, and it is unique per
 * company. `supplier_invoice_number` is deliberately NOT given a unique index:
 * the audited behaviour refuses a duplicate at POSTING but lets a user override
 * it explicitly, and an index would make that documented override
 * unrepresentable. A constraint that contradicts a supported workflow is not a
 * stronger guarantee, it is a bug with a schema around it.
 *
 * ══ Money is NUMERIC at the internal scale ═══════════════════════════════════
 *
 * `numeric(20,10)`, matching the invoice tables, so the exact-decimal BigInt
 * engine round-trips without passing through a float. The currency's own
 * precision is applied by the service when it rounds; the column keeps whatever
 * exact value that produced.
 *
 * ══ Existing rows: halt, never invent ════════════════════════════════════════
 *
 * Nothing on the server has ever held a bill, so there are no rows to migrate.
 * The precondition below therefore checks the one thing that could still be
 * wrong — a supplier-role party whose company has gone — rather than pretending
 * to inspect data that cannot exist.
 */
import { sql, type Kysely } from 'kysely';

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  /* ── Precondition ─────────────────────────────────────────────────────── */

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
      `Refusing to add bills: ${orphaned} supplier-role part(y/ies) belong to a company that no `
      + `longer exists (for example ${orphans[0]?.sample ?? 'unknown'}). A bill cannot name a `
      + 'supplier whose books are gone, and attaching one to a different company would make it a '
      + 'different supplier. Remedy: restore the company, or archive those parties, then run this again.',
    );
  }

  /* ── Numbering ────────────────────────────────────────────────────────── */

  /*
   * The next sequence is HELD, never derived. Counting existing bills reuses a
   * number after a deletion, and a reused bill number is two documents with one
   * identity.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS bill_numbering (
      organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id       uuid NOT NULL,
      issuing_entity_id text NOT NULL,
      prefix           text NOT NULL DEFAULT 'BILL-',
      include_year     boolean NOT NULL DEFAULT true,
      sequence_length  integer NOT NULL DEFAULT 4,
      next_sequence    integer NOT NULL DEFAULT 1,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),

      PRIMARY KEY (organization_id, company_id, issuing_entity_id),
      CONSTRAINT bill_numbering_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE
    )
  `.execute(db);

  /* ── Bills ────────────────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS bills (
      id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      /*
       * A direct reference as well as the composite company key.
       *
       * The tenant inventory identifies what a subscriber owns by walking the
       * tables that REFERENCE organizations; a table reachable only through
       * companies is invisible to it, and a table invisible to it is one a
       * purge silently leaves behind.
       */
      organization_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id               uuid NOT NULL,
      issuing_entity_id        text NOT NULL,

      /* A real P1 supplier in THESE books. See the key below. */
      supplier_id              uuid NOT NULL,

      bill_number              text NOT NULL,
      /* The supplier's own document reference. Required before posting. */
      supplier_invoice_number  text NOT NULL DEFAULT '',

      /*
       * draft | posted | reversed, and nothing else.
       *
       * The browser lifecycle also has submitted, approved, partially-paid,
       * paid, void and superseded. Each of those needs a workflow P2 does not
       * bring — an approval chain, a settlement path, an amendment model — and
       * a status the server can set but never reach honestly is worse than one
       * it refuses.
       */
      status                   text NOT NULL DEFAULT 'draft',

      bill_date                date NOT NULL,
      /* What the LEDGER posts on, and what period locks are enforced against. */
      posting_date             date NOT NULL,
      due_date                 date NOT NULL,

      /* Functional currency only. There is no exchange_rate column because a
       * foreign-currency bill is refused rather than converted. */
      currency                 text NOT NULL,

      memo                     text NOT NULL DEFAULT '',

      /* Σ gross, Σ discount, and what is owed. Every one server-computed. */
      subtotal                 numeric(20,10) NOT NULL DEFAULT 0,
      discount_total           numeric(20,10) NOT NULL DEFAULT 0,
      total                    numeric(20,10) NOT NULL DEFAULT 0,

      /* The payable this bill actually credited, recorded AT POSTING so a later
       * change to the supplier's profile cannot restate a posted document. */
      payable_account_id       uuid,

      journal_entry_id         uuid,
      reversal_journal_entry_id uuid,
      reversal_reason          text,

      posted_at                timestamptz,
      reversed_at              timestamptz,

      version                  integer NOT NULL DEFAULT 1,
      created_by               uuid,
      updated_by               uuid,
      created_at               timestamptz NOT NULL DEFAULT now(),
      updated_at               timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT bills_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE RESTRICT,

      /*
       * The supplier must be a party in the SAME books. Composite, so a
       * cross-company supplier is unrepresentable rather than merely refused;
       * RESTRICT, because a supplier named on a posted bill must stay
       * identifiable for as long as the bill does.
       *
       * That the party actually holds the SUPPLIER role, and is not archived,
       * is a mutable flag a key cannot express — the service checks it.
       */
      CONSTRAINT bills_supplier_fk
        FOREIGN KEY (organization_id, company_id, supplier_id)
        REFERENCES business_parties (organization_id, company_id, id) ON DELETE RESTRICT,

      CONSTRAINT bills_payable_account_fk
        FOREIGN KEY (organization_id, company_id, payable_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,

      CONSTRAINT bills_status_known
        CHECK (status IN ('draft', 'posted', 'reversed')),
      CONSTRAINT bills_due_not_before_bill
        CHECK (due_date >= bill_date),
      /* A posted bill has both a journal and the account it credited. */
      CONSTRAINT bills_posted_has_journal
        CHECK (status = 'draft' OR (journal_entry_id IS NOT NULL AND payable_account_id IS NOT NULL)),
      CONSTRAINT bills_reversed_has_reversal
        CHECK (status <> 'reversed' OR reversal_journal_entry_id IS NOT NULL),

      /* The composite target the lines point at. */
      CONSTRAINT bills_scoped_key UNIQUE (organization_id, company_id, id)
    )
  `.execute(db);

  /*
   * One internal bill number per set of books.
   *
   * Note what is NOT here: an index on `supplier_invoice_number`. The audited
   * behaviour refuses a duplicate at posting and allows an explicit override,
   * and an index would make that override impossible.
   */
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS bills_number_unique
      ON bills (organization_id, company_id, lower(btrim(bill_number)))
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS bills_directory
      ON bills (organization_id, company_id, status, bill_date DESC)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS bills_by_supplier
      ON bills (organization_id, company_id, supplier_id)
  `.execute(db);

  /* ── Lines ────────────────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS bill_lines (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id       uuid NOT NULL,
      bill_id          uuid NOT NULL,
      line_number      integer NOT NULL,

      description      text NOT NULL DEFAULT '',
      /* The account DEBITED. Expense or non-inventory asset; the service
       * enforces the type, the key enforces the company. */
      account_id       uuid NOT NULL,

      quantity         numeric(20,10) NOT NULL DEFAULT 0,
      unit             text NOT NULL DEFAULT '',
      unit_price       numeric(20,10) NOT NULL DEFAULT 0,

      discount_type    text,
      discount_value   numeric(20,10),
      discount_amount  numeric(20,10) NOT NULL DEFAULT 0,

      /* quantity × unit_price, BEFORE discount — the audited meaning. */
      line_subtotal    numeric(20,10) NOT NULL DEFAULT 0,
      /* line_subtotal − discount_amount. This is what the account is debited. */
      line_net         numeric(20,10) NOT NULL DEFAULT 0,

      created_at       timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT bill_lines_bill_fk
        FOREIGN KEY (organization_id, company_id, bill_id)
        REFERENCES bills (organization_id, company_id, id) ON DELETE CASCADE,

      CONSTRAINT bill_lines_account_fk
        FOREIGN KEY (organization_id, company_id, account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,

      CONSTRAINT bill_lines_discount_type_known
        CHECK (discount_type IS NULL OR discount_type IN ('percentage', 'amount')),
      CONSTRAINT bill_lines_quantity_not_negative CHECK (quantity >= 0),
      CONSTRAINT bill_lines_price_not_negative CHECK (unit_price >= 0),
      CONSTRAINT bill_lines_discount_not_negative CHECK (discount_amount >= 0),
      /* A discount can reduce a line to nothing but never past it. */
      CONSTRAINT bill_lines_discount_within_line CHECK (discount_amount <= line_subtotal)
    )
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS bill_lines_ordering
      ON bill_lines (organization_id, company_id, bill_id, line_number)
  `.execute(db);

  /* ── Audit ────────────────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS bill_audit_events (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id        uuid NOT NULL,
      bill_id           uuid NOT NULL,
      action            text NOT NULL,
      detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
      previous_version  integer,
      resulting_version integer,
      actor_user_id     uuid,
      actor_name        text NOT NULL DEFAULT '',
      at                timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT bill_audit_events_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS bill_audit_events_by_bill
      ON bill_audit_events (organization_id, company_id, bill_id, at DESC)
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  /*
   * ══ Why this refuses rather than dropping ══════════════════════════════════
   *
   * A down migration that removes these tables destroys every bill they hold —
   * including POSTED ones whose journals stay in the ledger, leaving revenue
   * and expense entries that no document explains.
   *
   * So it drops the tables only while they are EMPTY, which is the case a
   * rollback legitimately needs: the migration was applied and is being undone
   * before anything used it. With real bills present it halts and says so,
   * because "the rollback deleted the purchase ledger" is not a recoverable
   * outcome and no down migration is worth it.
   */
  const { rows } = await sql<{ n: string }>`SELECT COUNT(*)::text AS n FROM bills`.execute(db);
  const held = Number(rows[0]?.n ?? '0');
  if (held > 0) {
    throw new Error(
      `Refusing to roll back 034_supplier_bills: ${held} bill(s) exist. Dropping these tables `
      + 'would destroy them while their posted journals remain in the ledger, leaving entries no '
      + 'document explains. Reverse and remove the bills deliberately first if this is really intended.',
    );
  }

  await sql`DROP TABLE IF EXISTS bill_audit_events`.execute(db);
  await sql`DROP TABLE IF EXISTS bill_lines`.execute(db);
  await sql`DROP TABLE IF EXISTS bills`.execute(db);
  await sql`DROP TABLE IF EXISTS bill_numbering`.execute(db);
}

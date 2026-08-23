/**
 * Sales invoices, server-side.
 *
 * ══ Why they are moving ══════════════════════════════════════════════════════
 *
 * Invoices have lived in the browser (`store/invoiceStore`, persisted to
 * `localStorage`). That was workable while an invoice was only a document its
 * author looked at. It stops being workable the moment a tax authority has to
 * clear one:
 *
 *  · the taxpayer's clearance credential can never reach browser JavaScript,
 *    where devtools and every installed extension can read it;
 *  · "the authority cleared this, here is the UUID" is compliance evidence, and
 *    evidence kept in one browser's localStorage is destroyed by a cache clear;
 *  · real-time submission fails — network, downtime, a rejected document — so
 *    something durable has to hold the queue and retry it;
 *  · a cleared invoice must become immutable, with a record of exactly what was
 *    submitted and exactly what came back.
 *
 * None of those are properties a browser store can have. They are properties
 * this database already gives every other authoritative record.
 *
 * ══ What is deliberately NOT here ════════════════════════════════════════════
 *
 * No clearance columns. Jordan's JoFotara profile has not been read from the
 * authority's own specification yet, and inventing fields for a schema nobody
 * has verified would produce a migration to undo rather than a foundation to
 * build on. Clearance is its own concern and belongs in its own table when the
 * real spec arrives — one exchange per submission attempt, not a column on the
 * invoice that the last attempt overwrites.
 *
 * ══ Conventions followed ═════════════════════════════════════════════════════
 *
 * The same ones migration 013 established for the ledger, for the same reasons:
 * `numeric(28,10)` money so arithmetic stays exact; tenant-scoped document
 * numbers, because two organizations both having INV-0001 is correct and a
 * global sequence would leak how much everyone else invoices; `UNIQUE
 * (organization_id, id)` so children can carry composite foreign keys that make
 * a cross-tenant reference unrepresentable rather than merely unlikely.
 */
import { sql } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = import('kysely').Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  /* ══ Invoices ═════════════════════════════════════════════════════════════ */
  await sql`
    CREATE TABLE invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

      /*
       * The issuing entity and the customer.
       *
       * Plain uuids, not foreign keys — the business-entity directory is still
       * browser-resident, and an FK to a table that does not exist is not a
       * constraint, it is a failed migration. The service validates that a
       * supplied id belongs to this organization; the constraints land with the
       * table, exactly as journal_lines documents for its own dimensions.
       */
      issuing_entity_id uuid NOT NULL,
      customer_id uuid NOT NULL,

      invoice_number text NOT NULL,

      status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','approved','issued','sent','partially-paid','paid','void')),

      issue_date date NOT NULL,
      due_date date NOT NULL,

      /*
       * Both currencies, captured at issue and never re-derived — a company
       * that later changes its functional currency must not silently restate
       * invoices it has already sent to customers.
       */
      transaction_currency text NOT NULL,
      functional_currency text NOT NULL,
      exchange_rate numeric(28,10) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),

      purchase_order_reference text NOT NULL DEFAULT '',
      customer_reference text NOT NULL DEFAULT '',
      salesperson_id uuid,
      project_id uuid,
      cost_center_id uuid,

      /* Presentation, frozen at issue so a reprint matches what was sent. */
      template_id uuid,
      template_version_id uuid,
      template_resolution_source text,
      template_snapshot jsonb,

      /* Totals, all in the transaction currency. */
      subtotal numeric(28,10) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
      discount_total numeric(28,10) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
      tax_total numeric(28,10) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
      additional_charges_total numeric(28,10) NOT NULL DEFAULT 0 CHECK (additional_charges_total >= 0),
      grand_total numeric(28,10) NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
      amount_paid numeric(28,10) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
      /* Credit-note value allocated here. The original total is never altered. */
      credits_applied numeric(28,10) NOT NULL DEFAULT 0 CHECK (credits_applied >= 0),
      balance_due numeric(28,10) NOT NULL DEFAULT 0,

      notes text NOT NULL DEFAULT '',
      terms text NOT NULL DEFAULT '',
      payment_terms text NOT NULL DEFAULT '',

      /* The ledger entries this document produced. */
      journal_entry_id uuid,
      reversal_journal_entry_id uuid,
      void_reason text,

      issued_at timestamptz,
      sent_at timestamptz,
      paid_at timestamptz,
      voided_at timestamptz,

      /** Optimistic concurrency token. Every mutation increments it. */
      version integer NOT NULL DEFAULT 1 CHECK (version >= 1),

      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL,

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT invoices_number_unique UNIQUE (organization_id, invoice_number),
      CONSTRAINT invoices_org_id_unique UNIQUE (organization_id, id),

      /*
       * Anything that reached a customer records WHEN it did.
       *
       * A void row is excluded deliberately: an approved invoice can be cancelled
       * before it is ever issued, and such a document has no issue timestamp to
       * record. Requiring one would force a lie — a date on which nothing was
       * sent — into the row.
       */
      CONSTRAINT invoices_issued_complete CHECK (
        status IN ('draft','approved','void') OR issued_at IS NOT NULL
      ),
      CONSTRAINT invoices_void_complete CHECK (
        status <> 'void' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)
      )
    )
  `.execute(db);

  /*
   * The ledger links are scoped foreign keys, added after the table exists.
   * ON DELETE RESTRICT: the entry an invoice posted is the accounting record of
   * that invoice, and it does not disappear because somebody tidied the ledger.
   */
  for (const column of ['journal_entry_id', 'reversal_journal_entry_id'] as const) {
    await sql.raw(
      `ALTER TABLE invoices
         ADD CONSTRAINT invoices_${column}_same_org
         FOREIGN KEY (organization_id, ${column})
         REFERENCES journal_entries (organization_id, id) ON DELETE RESTRICT`,
    ).execute(db);
  }

  await sql`CREATE INDEX invoices_customer_idx ON invoices (organization_id, customer_id, issue_date)`.execute(db);
  await sql`CREATE INDEX invoices_status_idx ON invoices (organization_id, status, issue_date)`.execute(db);

  /* ══ Invoice lines ════════════════════════════════════════════════════════ */
  await sql`
    CREATE TABLE invoice_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      invoice_id uuid NOT NULL,

      line_number integer NOT NULL CHECK (line_number >= 1),

      /* The revenue account this line credits. Scoped FK — the table exists. */
      account_id uuid NOT NULL,

      item_id uuid,
      description text NOT NULL DEFAULT '',
      quantity numeric(28,10) NOT NULL DEFAULT 0,
      unit text NOT NULL DEFAULT '',
      unit_price numeric(28,10) NOT NULL DEFAULT 0,

      discount_type text CHECK (discount_type IS NULL OR discount_type IN ('percentage','amount')),
      discount_value numeric(28,10),

      /*
       * The tax code AND the rate and amount it produced.
       *
       * Storing all three is deliberate duplication: a tax code's rate is
       * effective-dated and will change, and an invoice must keep reporting the
       * tax it actually charged. Recomputing from the code later would restate
       * a document already in a customer's hands — and, once a tax authority
       * has cleared it, a document the authority holds its own copy of.
       */
      tax_code_id uuid,
      tax_rate numeric(28,10) NOT NULL DEFAULT 0,
      tax_amount numeric(28,10) NOT NULL DEFAULT 0,

      line_subtotal numeric(28,10) NOT NULL DEFAULT 0,
      line_total numeric(28,10) NOT NULL DEFAULT 0,

      /* Dimensions. Plain uuids, for the reason given on the invoices table. */
      entity_id uuid,
      project_id uuid,
      cost_center_id uuid,
      cost_center_assignments jsonb,

      /* Inventory, when the line issues stock as it invoices. */
      inventory_item_id uuid,
      warehouse_id uuid,
      inventory_fulfillment_mode text
        CHECK (inventory_fulfillment_mode IS NULL
               OR inventory_fulfillment_mode IN ('none','issue-on-invoice','delivered-separately')),
      issued_unit_cost numeric(28,10),

      created_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT invoice_lines_number_unique UNIQUE (invoice_id, line_number),
      CONSTRAINT invoice_lines_invoice_same_org
        FOREIGN KEY (organization_id, invoice_id)
        REFERENCES invoices (organization_id, id) ON DELETE CASCADE,
      CONSTRAINT invoice_lines_account_same_org
        FOREIGN KEY (organization_id, account_id)
        REFERENCES accounts (organization_id, id) ON DELETE RESTRICT
    )
  `.execute(db);

  await sql`CREATE INDEX invoice_lines_invoice_idx ON invoice_lines (organization_id, invoice_id, line_number)`.execute(db);

  /* ══ Payments applied to an invoice ═══════════════════════════════════════ */
  await sql`
    CREATE TABLE invoice_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      invoice_id uuid NOT NULL,

      paid_on date NOT NULL,
      amount numeric(28,10) NOT NULL CHECK (amount > 0),
      method text NOT NULL DEFAULT '',
      reference text NOT NULL DEFAULT '',
      bank_account_id uuid,

      journal_entry_id uuid,
      /* Set when this came from a posted receipt allocation. */
      receipt_id uuid,

      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT invoice_payments_invoice_same_org
        FOREIGN KEY (organization_id, invoice_id)
        REFERENCES invoices (organization_id, id) ON DELETE CASCADE,
      CONSTRAINT invoice_payments_journal_same_org
        FOREIGN KEY (organization_id, journal_entry_id)
        REFERENCES journal_entries (organization_id, id) ON DELETE RESTRICT
    )
  `.execute(db);

  await sql`CREATE INDEX invoice_payments_invoice_idx ON invoice_payments (organization_id, invoice_id, paid_on)`.execute(db);

  /* ══ Numbering ════════════════════════════════════════════════════════════ */
  await sql`
    CREATE TABLE invoice_numbering (
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      issuing_entity_id uuid NOT NULL,

      prefix text NOT NULL DEFAULT 'INV-',
      include_year boolean NOT NULL DEFAULT true,
      sequence_length integer NOT NULL DEFAULT 4 CHECK (sequence_length BETWEEN 1 AND 12),
      /*
       * Held here, not derived by counting invoices. A sequence derived from
       * max(number) reuses a number after a deletion, and a tax authority
       * that has already seen the first one will reject the second.
       */
      next_sequence integer NOT NULL DEFAULT 1 CHECK (next_sequence >= 1),

      updated_at timestamptz NOT NULL DEFAULT now(),

      PRIMARY KEY (organization_id, issuing_entity_id)
    )
  `.execute(db);

  /* ══ Audit ════════════════════════════════════════════════════════════════ */
  await sql`
    CREATE TABLE invoice_audit_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      invoice_id uuid NOT NULL,

      action text NOT NULL,
      detail text NOT NULL DEFAULT '',
      actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      occurred_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT invoice_audit_invoice_same_org
        FOREIGN KEY (organization_id, invoice_id)
        REFERENCES invoices (organization_id, id) ON DELETE CASCADE
    )
  `.execute(db);

  await sql`CREATE INDEX invoice_audit_invoice_idx ON invoice_audit_events (organization_id, invoice_id, occurred_at)`.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DROP TABLE IF EXISTS invoice_audit_events`.execute(db);
  await sql`DROP TABLE IF EXISTS invoice_payments`.execute(db);
  await sql`DROP TABLE IF EXISTS invoice_lines`.execute(db);
  await sql`DROP TABLE IF EXISTS invoice_numbering`.execute(db);
  await sql`DROP TABLE IF EXISTS invoices`.execute(db);
}

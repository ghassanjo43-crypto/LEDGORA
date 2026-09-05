/**
 * Advanced Purchasing AP1 — the purchase order, the goods receipt, and the
 * received-not-invoiced liability that sits between them.
 *
 * ══ Why a purchase order posts nothing ═══════════════════════════════════════
 *
 * An order is a COMMITMENT, not a transaction. Nothing has arrived, nobody is
 * owed and no tax point has occurred, so there is no entry to make — which is
 * why this table has no `journal_entry_id`, no idempotency key and no posting
 * date. Giving it any of those would invite a screen to post one.
 *
 * The tax figures on an order line ARE stored, and they are named `estimated_`
 * for the same reason: they are commercial information a buyer quotes to a
 * supplier, not a statutory snapshot. The frozen snapshot columns a filing
 * depends on live on `bill_lines` and are written when the bill posts — in AP2.
 * Naming them apart is what stops the two being confused by a report that reads
 * whichever it finds first.
 *
 * ══ Why the receipt is the recognition point, and what it recognises ═════════
 *
 *   Dr Inventory     (the order's net value attributable to what arrived)
 *     Cr Goods received not invoiced
 *
 * and nothing else. No payable, because no supplier has invoiced anything yet;
 * no input tax, because the tax point is the supplier's invoice and its rate,
 * category and recoverability are frozen from THAT document. Recognising either
 * here would put a liability in the books that no supplier document supports,
 * and would freeze a tax treatment from an order a tax authority never sees.
 *
 * ══ Why there is no received or remaining quantity column ════════════════════
 *
 * There is deliberately no `received_quantity` and no `remaining_quantity` on
 * `purchase_order_lines`. Both are sums over posted, unreversed receipt lines,
 * and a stored copy is a second answer that drifts from the receipts the first
 * time anything fails halfway — after which nobody can say which was right, and
 * the one people act on is the wrong one. Over-receipt is prevented by taking
 * the order line's row lock and re-summing inside the posting transaction,
 * which is a guarantee a stored counter cannot give at all.
 *
 * ══ Why the receipt line points at an ORDER LINE and not at an item ══════════
 *
 * The order line is the authority for the supplier, the item, the unit, the
 * destination warehouse, the permitted quantity and the provisional cost. A
 * receipt line that named its own item could receive something nobody ordered,
 * at a price nobody agreed, into a warehouse the order did not choose — and
 * every one of those would post to the ledger looking exactly like a legitimate
 * receipt. So the line carries a real composite foreign key to the order line
 * and derives the rest.
 *
 * ══ What this migration deliberately does NOT create ═════════════════════════
 *
 * No matching table, no match state, no tolerance, no purchase-price-variance
 * account, no accrual release, no return, no debit note, no landed cost, no
 * alternate unit, no currency, no lot, serial, bin, project or cost centre.
 * Each is AP2 or later, and a column for a decision nobody has made is a column
 * a screen eventually fills in and no journal honours. `bills.purchase_order_id`
 * is likewise NOT introduced: the bill service refuses a purchase-order and a
 * goods-receipt reference by name today, and that refusal is what stops one
 * purchase being recognised twice — once by an I3 direct stocked bill and once
 * by a receipt. AP2 replaces the refusal with authoritative matching; until
 * then it stands, and this migration leaves it exactly as it found it.
 */
import { sql, type Kysely } from 'kysely';

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type AnyKysely = Kysely<any>;

/**
 * The order lifecycle.
 *
 * Seven states, each of which something in the workflow can actually do:
 *
 *   draft              — being written; freely editable under a version.
 *   approved           — authorised internally. Not yet receivable against.
 *   issued             — sent to the supplier. Receipts start here.
 *   partially_received — derived: some, not all, of the ordered quantity is in.
 *   received           — derived: every line is fully received.
 *   closed             — the unreceived balance is abandoned; history untouched.
 *   cancelled          — abandoned before anything arrived.
 *
 * `approved` and `issued` are kept apart because the repository already
 * separates the two authorities: `approve` is its own permission action, held
 * by Manager and above and deliberately NOT by the Accountant who authors, while
 * issuing is the act that exposes the document to a third party. Collapsing
 * them would hand approval to everyone who can send an email.
 *
 * `partially_received` and `received` are STORED but never chosen by a caller:
 * they are derived from the receipt ledger inside the posting transaction and
 * written there. Storing them is what lets a list filter without summing every
 * receipt line for every row; deriving them is what keeps them true.
 */
const ORDER_STATUSES = [
  'draft', 'approved', 'issued', 'partially_received', 'received', 'closed', 'cancelled',
].map((s) => `'${s}'`).join(',');

/** A goods receipt is captured and posted in one call, then possibly reversed. */
const RECEIPT_STATUSES = ['posted', 'reversed'].map((s) => `'${s}'`).join(',');

/** The stock-document kinds, plus the one AP1 adds. */
const DOCUMENT_KINDS = [
  'receipt', 'issue', 'transfer', 'adjustment', 'bill-receipt', 'invoice-issue', 'purchase-receipt',
].map((k) => `'${k}'`).join(',');

export async function up(db: AnyKysely): Promise<void> {
  /* ── Preconditions ──────────────────────────────────────────────────────── */

  /*
   * A supplier-role party whose company has gone would make every order below
   * unattachable, and choosing a company for it would invent whose supplier it
   * was. Counted and refused with the number, never repaired by guessing.
   */
  const { rows: orphans } = await sql<{ n: string }>`
    SELECT COUNT(*)::text AS n
      FROM business_parties p
      LEFT JOIN companies c
        ON c.id = p.company_id AND c.organization_id = p.organization_id
     WHERE p.is_supplier = true AND c.id IS NULL
  `.execute(db);
  const orphaned = Number(orphans[0]?.n ?? '0');
  if (orphaned > 0) {
    throw new Error(
      `Refusing to add purchase orders: ${orphaned} supplier party row(s) name a company that does `
      + 'not exist. An order must belong to one company\'s books, and picking a company for an '
      + 'orphaned supplier would invent whose supplier it was. Remedy: restore or remove those '
      + 'parties, then run this again.',
    );
  }

  /* ── Numbering ──────────────────────────────────────────────────────────── */

  /*
   * Per company and per kind, exactly like `inventory_document_numbering`.
   *
   * Bills and invoices partition their sequence by `issuing_entity_id` because
   * the browser documents they mirror carry one. A purchase order has no such
   * field anywhere in this product, and inventing one would mean choosing a
   * value on every caller's behalf and then living with it inside the number
   * forever. Per-company uniqueness is the guarantee that is actually required,
   * and the advisory lock in the service is what makes allocation safe under
   * concurrency. The sequence is HELD, never derived from a MAX: counting rows
   * reuses a number after a deletion, and a reused order number is two
   * commitments with one identity.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS purchasing_document_numbering (
      organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id       uuid NOT NULL,
      kind             text NOT NULL,
      prefix           text NOT NULL DEFAULT '',
      include_year     boolean NOT NULL DEFAULT true,
      sequence_length  integer NOT NULL DEFAULT 4,
      next_sequence    integer NOT NULL DEFAULT 1,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),

      PRIMARY KEY (organization_id, company_id, kind),
      CONSTRAINT purchasing_document_numbering_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE,
      CONSTRAINT purchasing_document_numbering_kind_ck
        CHECK (kind IN ('purchase-order','goods-receipt')),
      CONSTRAINT purchasing_document_numbering_length_ck
        CHECK (sequence_length BETWEEN 1 AND 12)
    )
  `.execute(db);

  /* ── The order ──────────────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id        uuid NOT NULL,

      order_number      text NOT NULL,
      supplier_id       uuid NOT NULL,
      order_date        date NOT NULL,
      /* When the buyer expects the goods. Commercial; never an accounting date. */
      expected_date     date,

      status            text NOT NULL DEFAULT 'draft',
      currency          text NOT NULL,

      /*
       * The supplier's OWN reference — their quotation or sales-order number.
       * Free text on purpose: it is a string somebody copies off another
       * company's document. It is kept strictly apart from order_number,
       * which is Ledgora's internal identity and the only thing a receipt is
       * ever allowed to be matched on.
       */
      supplier_reference text NOT NULL DEFAULT '',
      memo              text NOT NULL DEFAULT '',

      /* Server-computed from the lines. Never accepted from a client. */
      subtotal          numeric(20,10) NOT NULL DEFAULT 0,
      discount_total    numeric(20,10) NOT NULL DEFAULT 0,
      /* ESTIMATED. Commercial information, not a statutory snapshot. */
      estimated_tax_total numeric(20,10) NOT NULL DEFAULT 0,
      total             numeric(20,10) NOT NULL DEFAULT 0,

      approved_at       timestamptz,
      approved_by       uuid,
      issued_at         timestamptz,
      issued_by         uuid,
      closed_at         timestamptz,
      cancelled_at      timestamptz,
      /* Why a live commitment was abandoned. Required by CHECK once it is. */
      closure_reason    text NOT NULL DEFAULT '',

      version           integer NOT NULL DEFAULT 1,
      created_by        uuid,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT purchase_orders_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE,
      /* The composite key is what makes a cross-company supplier unrepresentable
       * rather than merely refused by a service somebody can edit. */
      CONSTRAINT purchase_orders_supplier_fk
        FOREIGN KEY (organization_id, company_id, supplier_id)
        REFERENCES business_parties (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT purchase_orders_scoped_key UNIQUE (organization_id, company_id, id),
      CONSTRAINT purchase_orders_number_unique
        UNIQUE (organization_id, company_id, order_number),
      CONSTRAINT purchase_orders_status_ck CHECK (status IN (${sql.raw(ORDER_STATUSES)})),
      CONSTRAINT purchase_orders_amounts_ck CHECK (
        subtotal >= 0 AND discount_total >= 0 AND estimated_tax_total >= 0 AND total >= 0
      ),
      /* Abandoning a live commitment is a decision somebody has to defend. */
      CONSTRAINT purchase_orders_closure_reason_ck CHECK (
        status NOT IN ('closed','cancelled') OR length(btrim(closure_reason)) > 0
      ),
      /* A state that records WHEN it happened must actually have happened. */
      CONSTRAINT purchase_orders_approved_stamp_ck CHECK (
        status IN ('draft','cancelled') OR approved_at IS NOT NULL
      ),
      CONSTRAINT purchase_orders_issued_stamp_ck CHECK (
        status NOT IN ('issued','partially_received','received') OR issued_at IS NOT NULL
      )
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS purchase_orders_supplier_idx
      ON purchase_orders (organization_id, company_id, supplier_id, order_date)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS purchase_orders_status_idx
      ON purchase_orders (organization_id, company_id, status, order_date)
  `.execute(db);

  /* ── Order lines ────────────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS purchase_order_lines (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id        uuid NOT NULL,
      order_id          uuid NOT NULL,
      line_number       integer NOT NULL,

      item_id           uuid NOT NULL,
      /*
       * The item's BASE unit, copied at line time and re-checked at receipt.
       * There is no unit conversion anywhere in this product, so a second unit
       * here would be a quantity nothing could cost.
       */
      base_unit_id      uuid NOT NULL,
      warehouse_id      uuid NOT NULL,

      description       text NOT NULL DEFAULT '',
      ordered_quantity  numeric(20,10) NOT NULL,
      unit_price        numeric(20,10) NOT NULL,
      discount_type     text,
      discount_value    numeric(20,10) NOT NULL DEFAULT 0,
      discount_amount   numeric(20,10) NOT NULL DEFAULT 0,

      /* quantity x unit_price, before discount. */
      line_subtotal     numeric(20,10) NOT NULL DEFAULT 0,
      /* The discounted line amount: the base tax is computed on. */
      line_net          numeric(20,10) NOT NULL DEFAULT 0,

      /*
       * The tax the buyer EXPECTS. Named estimated_ throughout, and there is
       * no tax_snapshot_at: an order freezes nothing, because the tax point is
       * the supplier's invoice and the rate in force on ITS date. AP2 writes the
       * real snapshot onto the bill line.
       */
      tax_code_id                 uuid,
      estimated_tax_rate          numeric(20,10) NOT NULL DEFAULT 0,
      estimated_tax_category      text,
      estimated_tax_method        text,
      estimated_tax_amount        numeric(20,10) NOT NULL DEFAULT 0,
      /*
       * What the goods are expected to COST, net of separately recoverable
       * input tax. This is the figure a receipt is valued at, and under an
       * inclusive code it is what is left once the tax has been extracted.
       */
      net_amount        numeric(20,10) NOT NULL DEFAULT 0,
      /* net + estimated tax: what the supplier is expected to charge. */
      gross_amount      numeric(20,10) NOT NULL DEFAULT 0,

      /* Copied so a report reads what the order said at the time. */
      item_code         text NOT NULL DEFAULT '',
      item_name         text NOT NULL DEFAULT '',
      base_unit_code    text NOT NULL DEFAULT '',
      warehouse_code    text NOT NULL DEFAULT '',

      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT purchase_order_lines_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE,
      CONSTRAINT purchase_order_lines_order_fk
        FOREIGN KEY (organization_id, company_id, order_id)
        REFERENCES purchase_orders (organization_id, company_id, id) ON DELETE CASCADE,
      CONSTRAINT purchase_order_lines_item_fk
        FOREIGN KEY (organization_id, company_id, item_id)
        REFERENCES inventory_items (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT purchase_order_lines_unit_fk
        FOREIGN KEY (organization_id, company_id, base_unit_id)
        REFERENCES units_of_measure (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT purchase_order_lines_warehouse_fk
        FOREIGN KEY (organization_id, company_id, warehouse_id)
        REFERENCES warehouses (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT purchase_order_lines_tax_code_fk
        FOREIGN KEY (organization_id, company_id, tax_code_id)
        REFERENCES tax_codes (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT purchase_order_lines_scoped_key UNIQUE (organization_id, company_id, id),
      CONSTRAINT purchase_order_lines_order_line_unique UNIQUE (order_id, line_number),
      CONSTRAINT purchase_order_lines_line_ck CHECK (line_number > 0),
      /* Ordering nothing, or a negative quantity, is not an order. */
      CONSTRAINT purchase_order_lines_quantity_ck CHECK (ordered_quantity > 0),
      CONSTRAINT purchase_order_lines_price_ck CHECK (unit_price >= 0),
      CONSTRAINT purchase_order_lines_discount_type_ck
        CHECK (discount_type IS NULL OR discount_type IN ('percentage','amount')),
      CONSTRAINT purchase_order_lines_amounts_ck CHECK (
        discount_value >= 0 AND discount_amount >= 0 AND line_subtotal >= 0
        AND line_net >= 0 AND estimated_tax_amount >= 0 AND net_amount >= 0 AND gross_amount >= 0
      )
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS purchase_order_lines_item_idx
      ON purchase_order_lines (organization_id, company_id, item_id)
  `.execute(db);

  /* ── The goods receipt ──────────────────────────────────────────────────── */

  await sql`
    CREATE TABLE IF NOT EXISTS goods_receipts (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id        uuid NOT NULL,

      receipt_number    text NOT NULL,
      order_id          uuid NOT NULL,
      /*
       * Denormalised from the order, and constrained to agree with it by the
       * composite key added below. A receipt naming a different supplier from
       * its own order is not a data-entry mistake to be validated — it is a
       * shape the database should not be able to hold.
       */
      supplier_id       uuid NOT NULL,

      /* When the goods arrived, and when the books take it. */
      receipt_date      date NOT NULL,
      posting_date      date NOT NULL,

      /* The supplier's delivery-note number. Theirs, not Ledgora's. */
      delivery_note_reference text NOT NULL DEFAULT '',
      memo              text NOT NULL DEFAULT '',

      status            text NOT NULL DEFAULT 'posted',
      /* The value recognised: the sum of the lines, and the GRNI credit. */
      total_value       numeric(20,10) NOT NULL DEFAULT 0,

      /*
       * The stock document this receipt posted, and through it the movements
       * and the journal. One engine, one costing rule, one set of account
       * checks — the same relationship a stock count has with its adjustment.
       */
      inventory_document_id uuid,
      /* A retry finds what it already made instead of making a second one. */
      idempotency_key   text NOT NULL,

      /*
       * The I2 document that withdrew this receipt's stock and posted the
       * reversing Inventory/GRNI entry. There is no mirror-image "reversal
       * receipt": nothing arrived, so a second arrival document would be a
       * fiction, and the withdrawal already has a document of its own in the
       * stock ledger. Flipping this row to reversed is what restores the
       * order line's remaining quantity, because remaining is summed over
       * POSTED receipts and this one has left that set.
       */
      reversal_document_id uuid,
      reversal_reason   text NOT NULL DEFAULT '',
      reversed_at       timestamptz,
      reversed_by       uuid,

      version           integer NOT NULL DEFAULT 1,
      received_by       uuid,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT goods_receipts_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE,
      CONSTRAINT goods_receipts_order_fk
        FOREIGN KEY (organization_id, company_id, order_id)
        REFERENCES purchase_orders (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT goods_receipts_supplier_fk
        FOREIGN KEY (organization_id, company_id, supplier_id)
        REFERENCES business_parties (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT goods_receipts_document_fk
        FOREIGN KEY (organization_id, company_id, inventory_document_id)
        REFERENCES inventory_documents (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT goods_receipts_reversal_document_fk
        FOREIGN KEY (organization_id, company_id, reversal_document_id)
        REFERENCES inventory_documents (organization_id, company_id, id) ON DELETE RESTRICT,
      /* A withdrawal is only ever recorded on a receipt that says it happened. */
      CONSTRAINT goods_receipts_reversal_shape_ck CHECK (
        (status = 'reversed') = (reversed_at IS NOT NULL)
      ),
      CONSTRAINT goods_receipts_scoped_key UNIQUE (organization_id, company_id, id),
      CONSTRAINT goods_receipts_number_unique
        UNIQUE (organization_id, company_id, receipt_number),
      CONSTRAINT goods_receipts_key_unique
        UNIQUE (organization_id, company_id, idempotency_key),
      CONSTRAINT goods_receipts_status_ck CHECK (status IN (${sql.raw(RECEIPT_STATUSES)})),
      CONSTRAINT goods_receipts_value_ck CHECK (total_value >= 0)
    )
  `.execute(db);

  /*
   * The receipt's supplier IS the order's supplier, enforced by the database.
   *
   * A plain foreign key on `supplier_id` alone would only prove the party
   * exists in this company; this proves it is the party the order names. The
   * target unique index is created first, because a composite reference needs
   * something to point at.
   */
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_supplier_identity_uidx
      ON purchase_orders (organization_id, company_id, id, supplier_id)
  `.execute(db);
  await sql`
    ALTER TABLE goods_receipts DROP CONSTRAINT IF EXISTS goods_receipts_order_supplier_fk
  `.execute(db);
  await sql`
    ALTER TABLE goods_receipts
      ADD CONSTRAINT goods_receipts_order_supplier_fk
      FOREIGN KEY (organization_id, company_id, order_id, supplier_id)
      REFERENCES purchase_orders (organization_id, company_id, id, supplier_id) ON DELETE RESTRICT
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS goods_receipts_order_idx
      ON goods_receipts (organization_id, company_id, order_id, status)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS goods_receipts_posting_idx
      ON goods_receipts (organization_id, company_id, posting_date, created_at)
  `.execute(db);

  /* ── Receipt lines ──────────────────────────────────────────────────────── */

  /*
   * The unique index the receipt line's composite key needs, so a line can only
   * name an order line that belongs to the order its own header names. Without
   * it a receipt against order A could carry a line from order B, and the
   * remaining quantity of both would be wrong in opposite directions.
   */
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS purchase_order_lines_order_identity_uidx
      ON purchase_order_lines (organization_id, company_id, order_id, id)
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS goods_receipt_lines (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id        uuid NOT NULL,
      receipt_id        uuid NOT NULL,
      line_number       integer NOT NULL,

      /* The authority for everything below. Never optional. */
      order_id          uuid NOT NULL,
      order_line_id     uuid NOT NULL,

      item_id           uuid NOT NULL,
      base_unit_id      uuid NOT NULL,
      warehouse_id      uuid NOT NULL,

      received_quantity numeric(20,10) NOT NULL,
      /* Derived from the order line's net value; never sent by a client. */
      unit_cost         numeric(20,10) NOT NULL,
      total_cost        numeric(20,10) NOT NULL,

      /* The movement this line produced. One line, one movement, one value. */
      movement_id       uuid,

      item_code         text NOT NULL DEFAULT '',
      item_name         text NOT NULL DEFAULT '',
      base_unit_code    text NOT NULL DEFAULT '',
      warehouse_code    text NOT NULL DEFAULT '',

      created_at        timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT goods_receipt_lines_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE,
      CONSTRAINT goods_receipt_lines_receipt_fk
        FOREIGN KEY (organization_id, company_id, receipt_id)
        REFERENCES goods_receipts (organization_id, company_id, id) ON DELETE RESTRICT,
      /* The order line, AND that it belongs to this receipt's own order. */
      CONSTRAINT goods_receipt_lines_order_line_fk
        FOREIGN KEY (organization_id, company_id, order_id, order_line_id)
        REFERENCES purchase_order_lines (organization_id, company_id, order_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT goods_receipt_lines_item_fk
        FOREIGN KEY (organization_id, company_id, item_id)
        REFERENCES inventory_items (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT goods_receipt_lines_unit_fk
        FOREIGN KEY (organization_id, company_id, base_unit_id)
        REFERENCES units_of_measure (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT goods_receipt_lines_warehouse_fk
        FOREIGN KEY (organization_id, company_id, warehouse_id)
        REFERENCES warehouses (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT goods_receipt_lines_movement_fk
        FOREIGN KEY (organization_id, company_id, movement_id)
        REFERENCES inventory_movements (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT goods_receipt_lines_scoped_key UNIQUE (organization_id, company_id, id),
      CONSTRAINT goods_receipt_lines_receipt_line_unique UNIQUE (receipt_id, line_number),
      CONSTRAINT goods_receipt_lines_line_ck CHECK (line_number > 0),
      /* Receiving nothing moves nothing and would post an empty journal. */
      CONSTRAINT goods_receipt_lines_quantity_ck CHECK (received_quantity > 0),
      CONSTRAINT goods_receipt_lines_cost_ck CHECK (unit_cost >= 0 AND total_cost >= 0),
      /*
       * One receipt may take an order line only once. A second delivery against
       * the same line is a second RECEIPT — which is what keeps the arrival
       * history readable and every movement attributable to one delivery.
       */
      CONSTRAINT goods_receipt_lines_one_per_order_line UNIQUE (receipt_id, order_line_id)
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS goods_receipt_lines_order_line_idx
      ON goods_receipt_lines (organization_id, company_id, order_line_id)
  `.execute(db);

  /* ── Audit ──────────────────────────────────────────────────────────────── */

  /*
   * A table of its own rather than a subject added to `inventory_audit_events`,
   * whose CHECK enumerates item, warehouse, unit and settings — master data.
   * These are documents, with versions, approvals and withdrawals, and folding
   * them into the master-data trail would mean widening that constraint until
   * it constrained nothing.
   *
   * Append-only by construction: nothing in the service updates or deletes a
   * row, and a purge removes them with the tenant like every other audit trail.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS purchasing_audit_events (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id        uuid NOT NULL,
      /* order | receipt */
      subject_type      text NOT NULL,
      subject_id        uuid NOT NULL,
      action            text NOT NULL,
      detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
      previous_version  integer,
      resulting_version integer,
      actor_user_id     uuid,
      actor_name        text NOT NULL DEFAULT '',
      request_id        text NOT NULL DEFAULT '',
      at                timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT purchasing_audit_events_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE,
      CONSTRAINT purchasing_audit_events_subject_ck
        CHECK (subject_type IN ('order','receipt'))
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS purchasing_audit_events_by_subject
      ON purchasing_audit_events (organization_id, company_id, subject_type, subject_id, at DESC)
  `.execute(db);

  /* ── The stock ledger learns the AP1 receipt ────────────────────────────── */

  /*
   * `purchase-receipt` is a distinct kind from the standalone `receipt`, and
   * not a cosmetic label: both credit goods-received-not-invoiced, but only one
   * of them has an order behind it, a supplier, a permitted quantity and a
   * future supplier invoice to be matched against. A schedule that could not
   * tell them apart would report an order-less warehouse receipt as awaiting an
   * invoice nobody is ever going to send.
   */
  await sql`
    ALTER TABLE inventory_documents DROP CONSTRAINT IF EXISTS inventory_documents_kind_ck
  `.execute(db);
  await sql`
    ALTER TABLE inventory_documents
      ADD CONSTRAINT inventory_documents_kind_ck CHECK (kind IN (${sql.raw(DOCUMENT_KINDS)}))
  `.execute(db);

  await sql`
    ALTER TABLE inventory_document_numbering
      DROP CONSTRAINT IF EXISTS inventory_document_numbering_kind_ck
  `.execute(db);
  await sql`
    ALTER TABLE inventory_document_numbering
      ADD CONSTRAINT inventory_document_numbering_kind_ck
      CHECK (kind IN (${sql.raw(DOCUMENT_KINDS)}))
  `.execute(db);

  await sql`
    ALTER TABLE inventory_documents ADD COLUMN IF NOT EXISTS source_goods_receipt_id uuid
  `.execute(db);
  await sql`
    ALTER TABLE inventory_documents
      DROP CONSTRAINT IF EXISTS inventory_documents_goods_receipt_fk
  `.execute(db);
  await sql`
    ALTER TABLE inventory_documents
      ADD CONSTRAINT inventory_documents_goods_receipt_fk
      FOREIGN KEY (organization_id, company_id, source_goods_receipt_id)
      REFERENCES goods_receipts (organization_id, company_id, id) ON DELETE RESTRICT
  `.execute(db);
  /*
   * Only a purchase receipt may name one, and it must name one — so every such
   * movement can be traced to the arrival and, through it, to the order that
   * authorised the quantity and the cost.
   */
  await sql`
    ALTER TABLE inventory_documents
      DROP CONSTRAINT IF EXISTS inventory_documents_goods_receipt_kind_ck
  `.execute(db);
  await sql`
    ALTER TABLE inventory_documents
      ADD CONSTRAINT inventory_documents_goods_receipt_kind_ck
      CHECK ((kind = 'purchase-receipt') = (source_goods_receipt_id IS NOT NULL))
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS inventory_documents_goods_receipt_idx
      ON inventory_documents (organization_id, company_id, source_goods_receipt_id)
      WHERE source_goods_receipt_id IS NOT NULL
  `.execute(db);

  /* ── A posted receipt is a fact ─────────────────────────────────────────── */

  /*
   * The same allow-list shape the stock count uses, and for the same reason: a
   * deny-list silently permits whatever it forgets, and the column it forgets
   * is the one somebody edits. Only the withdrawal itself may move.
   */
  await sql`
    CREATE OR REPLACE FUNCTION goods_receipt_is_immutable() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF current_setting('ledgora.allow_stock_purge', true) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION
          'A posted goods receipt cannot be deleted. Reverse it instead: the receipt, its stock '
          'movements and its journal are the record of what arrived that day.'
          USING ERRCODE = '23514';
      END IF;

      /*
       * The stock document is linked once, from NULL, inside the posting
       * transaction: the document cannot exist before the receipt it names, so
       * the pointer has to be filled in a moment later. Every other fact is
       * frozen from the first insert, and once linked it can never move again.
       */
      IF NOT (OLD.inventory_document_id IS NULL AND NEW.inventory_document_id IS NOT NULL)
         AND NEW.inventory_document_id IS DISTINCT FROM OLD.inventory_document_id THEN
        RAISE EXCEPTION 'A goods receipt cannot be moved to a different stock document.'
          USING ERRCODE = '23514';
      END IF;

      IF ROW(NEW.receipt_number, NEW.order_id, NEW.supplier_id, NEW.receipt_date,
             NEW.posting_date, NEW.delivery_note_reference, NEW.memo, NEW.total_value,
             NEW.idempotency_key, NEW.received_by, NEW.created_at)
         IS DISTINCT FROM
         ROW(OLD.receipt_number, OLD.order_id, OLD.supplier_id, OLD.receipt_date,
             OLD.posting_date, OLD.delivery_note_reference, OLD.memo, OLD.total_value,
             OLD.idempotency_key, OLD.received_by, OLD.created_at) THEN
        RAISE EXCEPTION
          'A posted goods receipt cannot be edited. What arrived does not change; reverse it and '
          'record what actually came in.'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.status IS DISTINCT FROM OLD.status
         AND NOT (OLD.status = 'posted' AND NEW.status = 'reversed') THEN
        RAISE EXCEPTION 'A goods receipt moves from posted to reversed, once, and nowhere else.'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`DROP TRIGGER IF EXISTS goods_receipt_immutable ON goods_receipts`.execute(db);
  await sql`
    CREATE TRIGGER goods_receipt_immutable
      BEFORE UPDATE OR DELETE ON goods_receipts
      FOR EACH ROW EXECUTE FUNCTION goods_receipt_is_immutable()
  `.execute(db);

  /* A receipt line has no state to move through: it never changes at all. */
  await sql`
    CREATE OR REPLACE FUNCTION goods_receipt_line_is_immutable() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF current_setting('ledgora.allow_stock_purge', true) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'A received line cannot be deleted. Reverse the receipt instead.'
          USING ERRCODE = '23514';
      END IF;
      /*
       * No update path at all, not even to link the movement: the lines are
       * written AFTER the movements exist, so each one names its movement from
       * the moment it is inserted and never needs to change.
       */
      RAISE EXCEPTION
        'A received line cannot be edited. What arrived is an observation, not a figure to revise.'
        USING ERRCODE = '23514';
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`DROP TRIGGER IF EXISTS goods_receipt_line_immutable ON goods_receipt_lines`.execute(db);
  await sql`
    CREATE TRIGGER goods_receipt_line_immutable
      BEFORE UPDATE OR DELETE ON goods_receipt_lines
      FOR EACH ROW EXECUTE FUNCTION goods_receipt_line_is_immutable()
  `.execute(db);

  /* ── An order line that has been received is frozen ─────────────────────── */

  /*
   * Not "a posted order is immutable" — an order has no posting — but the
   * narrower and more useful rule: once a receipt exists against a line, the
   * facts that receipt was derived FROM cannot change. Editing the ordered
   * quantity, the price, the item, the unit or the warehouse afterwards would
   * silently rewrite what a posted movement and a posted journal mean.
   *
   * In the database rather than only in the service, because a service check is
   * one careless edit away from being gone and the movements it protects are
   * permanent.
   */
  await sql`
    CREATE OR REPLACE FUNCTION purchase_order_line_respects_receipts() RETURNS trigger AS $$
    DECLARE
      received bigint;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF current_setting('ledgora.allow_stock_purge', true) = 'on' THEN
          RETURN OLD;
        END IF;
        SELECT COUNT(*) INTO received FROM goods_receipt_lines WHERE order_line_id = OLD.id;
        IF received > 0 THEN
          RAISE EXCEPTION
            'This order line has been received against and cannot be removed. Its receipt, that '
            'receipt''s stock and its journal would be left describing something the order no '
            'longer admits to.'
            USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
      END IF;

      IF ROW(NEW.item_id, NEW.base_unit_id, NEW.warehouse_id, NEW.ordered_quantity,
             NEW.unit_price, NEW.discount_type, NEW.discount_value, NEW.tax_code_id,
             NEW.net_amount)
         IS NOT DISTINCT FROM
         ROW(OLD.item_id, OLD.base_unit_id, OLD.warehouse_id, OLD.ordered_quantity,
             OLD.unit_price, OLD.discount_type, OLD.discount_value, OLD.tax_code_id,
             OLD.net_amount) THEN
        RETURN NEW;
      END IF;

      SELECT COUNT(*) INTO received FROM goods_receipt_lines WHERE order_line_id = OLD.id;
      IF received > 0 THEN
        RAISE EXCEPTION
          'This order line has a goods receipt against it, so its item, unit, warehouse, quantity, '
          'price, discount or tax cannot be changed. Doing so would rewrite what the receipt '
          'already in the books means. Reverse the receipt first, or raise a new order.'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    DROP TRIGGER IF EXISTS purchase_order_line_receipt_guard ON purchase_order_lines
  `.execute(db);
  await sql`
    CREATE TRIGGER purchase_order_line_receipt_guard
      BEFORE UPDATE OR DELETE ON purchase_order_lines
      FOR EACH ROW EXECUTE FUNCTION purchase_order_line_respects_receipts()
  `.execute(db);

  /* The supplier on an order with receipts is frozen, for the same reason. */
  await sql`
    CREATE OR REPLACE FUNCTION purchase_order_respects_receipts() RETURNS trigger AS $$
    DECLARE
      received bigint;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF current_setting('ledgora.allow_stock_purge', true) = 'on' THEN
          RETURN OLD;
        END IF;
        SELECT COUNT(*) INTO received FROM goods_receipts WHERE order_id = OLD.id;
        IF received > 0 THEN
          RAISE EXCEPTION
            'This purchase order has goods receipts against it and cannot be deleted. Close or '
            'cancel it instead: the receipts, their stock and their journals stay.'
            USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
      END IF;

      IF NEW.supplier_id IS DISTINCT FROM OLD.supplier_id THEN
        SELECT COUNT(*) INTO received FROM goods_receipts WHERE order_id = OLD.id;
        IF received > 0 THEN
          RAISE EXCEPTION
            'This purchase order has been received against, so its supplier cannot be changed. The '
            'receipt records goods arriving from one party; moving the order to another would make '
            'the books say they came from somebody else.'
            USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`DROP TRIGGER IF EXISTS purchase_order_receipt_guard ON purchase_orders`.execute(db);
  await sql`
    CREATE TRIGGER purchase_order_receipt_guard
      BEFORE UPDATE OR DELETE ON purchase_orders
      FOR EACH ROW EXECUTE FUNCTION purchase_order_respects_receipts()
  `.execute(db);
}

/**
 * Down refuses to destroy a commitment that has already brought stock in.
 *
 * Dropping these tables while receipts exist would leave posted movements and a
 * posted goods-received-not-invoiced credit with nothing behind them: an
 * inventory balance whose source document is gone, and a liability nobody could
 * explain or ever match to a supplier invoice. That is precisely the state a
 * rollback must not create.
 */
export async function down(db: AnyKysely): Promise<void> {
  const { rows } = await sql<{ orders: string; receipts: string; documents: string }>`
    SELECT
      (SELECT COUNT(*)::text FROM purchase_orders)  AS orders,
      (SELECT COUNT(*)::text FROM goods_receipts)   AS receipts,
      (SELECT COUNT(*)::text FROM inventory_documents WHERE kind = 'purchase-receipt') AS documents
  `.execute(db);

  const orders = Number(rows[0]?.orders ?? '0');
  const receipts = Number(rows[0]?.receipts ?? '0');
  const documents = Number(rows[0]?.documents ?? '0');

  if (orders > 0 || receipts > 0 || documents > 0) {
    throw new Error(
      `Refusing to roll back 042: ${orders} purchase order(s), ${receipts} goods receipt(s) and `
      + `${documents} purchase-receipt stock document(s) exist. Dropping them would leave posted `
      + 'stock movements and a goods-received-not-invoiced balance in the ledger with no document '
      + 'behind them, which nobody could reconcile or match to a supplier invoice. Remedy: reverse '
      + 'the receipts and delete them deliberately, then roll back.',
    );
  }

  await sql`DROP TRIGGER IF EXISTS purchase_order_receipt_guard ON purchase_orders`.execute(db);
  await sql`DROP FUNCTION IF EXISTS purchase_order_respects_receipts()`.execute(db);
  await sql`
    DROP TRIGGER IF EXISTS purchase_order_line_receipt_guard ON purchase_order_lines
  `.execute(db);
  await sql`DROP FUNCTION IF EXISTS purchase_order_line_respects_receipts()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS goods_receipt_line_immutable ON goods_receipt_lines`.execute(db);
  await sql`DROP FUNCTION IF EXISTS goods_receipt_line_is_immutable()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS goods_receipt_immutable ON goods_receipts`.execute(db);
  await sql`DROP FUNCTION IF EXISTS goods_receipt_is_immutable()`.execute(db);

  await sql`DROP INDEX IF EXISTS inventory_documents_goods_receipt_idx`.execute(db);
  await sql`
    ALTER TABLE inventory_documents
      DROP CONSTRAINT IF EXISTS inventory_documents_goods_receipt_kind_ck
  `.execute(db);
  await sql`
    ALTER TABLE inventory_documents DROP CONSTRAINT IF EXISTS inventory_documents_goods_receipt_fk
  `.execute(db);
  await sql`
    ALTER TABLE inventory_documents DROP COLUMN IF EXISTS source_goods_receipt_id
  `.execute(db);

  const PREVIOUS = ['receipt', 'issue', 'transfer', 'adjustment', 'bill-receipt', 'invoice-issue']
    .map((k) => `'${k}'`).join(',');
  await sql`
    ALTER TABLE inventory_document_numbering
      DROP CONSTRAINT IF EXISTS inventory_document_numbering_kind_ck
  `.execute(db);
  await sql`
    ALTER TABLE inventory_document_numbering
      ADD CONSTRAINT inventory_document_numbering_kind_ck CHECK (kind IN (${sql.raw(PREVIOUS)}))
  `.execute(db);
  await sql`
    ALTER TABLE inventory_documents DROP CONSTRAINT IF EXISTS inventory_documents_kind_ck
  `.execute(db);
  await sql`
    ALTER TABLE inventory_documents
      ADD CONSTRAINT inventory_documents_kind_ck CHECK (kind IN (${sql.raw(PREVIOUS)}))
  `.execute(db);

  await sql`DROP TABLE IF EXISTS purchasing_audit_events`.execute(db);
  await sql`DROP TABLE IF EXISTS goods_receipt_lines`.execute(db);
  await sql`DROP TABLE IF EXISTS goods_receipts`.execute(db);
  await sql`DROP INDEX IF EXISTS purchase_order_lines_order_identity_uidx`.execute(db);
  await sql`DROP TABLE IF EXISTS purchase_order_lines`.execute(db);
  await sql`DROP INDEX IF EXISTS purchase_orders_supplier_identity_uidx`.execute(db);
  await sql`DROP TABLE IF EXISTS purchase_orders`.execute(db);
  await sql`DROP TABLE IF EXISTS purchasing_document_numbering`.execute(db);
}

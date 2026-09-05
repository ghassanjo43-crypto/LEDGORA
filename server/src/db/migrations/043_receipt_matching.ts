/**
 * Advanced Purchasing AP2 — matching a supplier bill to AP1 goods receipts,
 * and clearing goods-received-not-invoiced exactly.
 *
 * ══ What AP2 recognises, and what it must not ════════════════════════════════
 *
 * AP1 already put the goods in stock against an accrual:
 *
 *   Dr Inventory  /  Cr Goods received not invoiced
 *
 * The supplier's invoice is what turns that accrual into a debt and makes the
 * input tax recoverable:
 *
 *   Dr Goods received not invoiced   (the matched receipt value, exactly)
 *   Dr Recoverable input tax         (resolved by P3 on the bill's own date)
 *       Cr Accounts payable          (what the supplier is owed)
 *
 * No inventory movement. The goods arrived once and were costed once; a second
 * movement would put the same physical purchase into stock twice. Nothing here
 * touches an AP1 movement, its frozen cost, or the weighted average it fed.
 *
 * ══ Why there is no variance column, and no variance account ═════════════════
 *
 * The product does not resolve what a receipt-to-invoice price difference DOES.
 * `ledgora-inventory-module-spec.md` §12 states the bill entry as exactly three
 * legs — GRNI, input tax, payable — with no variance line. The only place
 * `Dr/Cr Purchase Price Variance` appears is §23, under STANDARD COST, which
 * this product does not implement for movements: I2 and AP1 refuse any item
 * that is not weighted-average, and `stockLedger.ts` says standard costing
 * exists only inside manufacturing work orders. `purchasePriceVarianceAccountId`
 * is a browser settings field read by nothing, anywhere.
 *
 * And the difference could not be allocated even if a destination existed. This
 * is moving-average costing with, in the ledger's own words, "no cost layers":
 * nothing can say how many of a PARTICULAR receipt's units are still on hand,
 * so a split between remaining inventory and cost of sales is not computable,
 * let alone auditable.
 *
 * So AP2 matches at EXACT VALUE and refuses a difference by name. A bill whose
 * net for the matched quantity is not the receipt's own frozen value cannot be
 * posted, and the refusal says why. That leaves inventory, profit and the
 * accrual all exactly where the evidence puts them, and defers the decision
 * rather than making one up in a schema.
 *
 * ══ Why matching is an append-only ALLOCATION table ══════════════════════════
 *
 * `matched`, `unmatched` and `remaining` are never stored. They are sums over
 * active allocations, taken under the receipt line's row lock inside the
 * posting transaction — the same shape AP1 uses for received-versus-ordered,
 * and for the same reason: a stored counter is a second answer that drifts the
 * first time anything fails halfway, and afterwards the figure people act on is
 * the wrong one.
 *
 * An allocation is never deleted and never edited. A reversed bill marks its
 * allocations reversed, which is what returns capacity to the receipt — the row
 * leaves the set that `active` sums over, and the history of what was once
 * cleared stays readable.
 *
 * ══ The cardinality this establishes, and why ════════════════════════════════
 *
 * One bill line names exactly ONE receipt line. One BILL may therefore match
 * many receipts, through many lines, and one RECEIPT LINE may be matched by
 * many bills over time, capped at its own quantity and value. That is the
 * shape AP1's partial receipts already have against an order line, extended
 * one document further; the specification states no cardinality at all, so the
 * established pattern is followed rather than a wider one invented. A bill line
 * spanning several receipt lines would need a value-splitting rule the product
 * has never stated.
 *
 * ══ What this migration deliberately does NOT create ═════════════════════════
 *
 * No tolerance configuration — none exists anywhere in the product, so matching
 * is exact and an exception is refused rather than approved by somebody. No
 * variance account. No purchase return, debit note or supplier credit: the
 * specification gives a return no journal before the bill, gives a credit no
 * tax point and no code, and the browser's own rule refuses a credit once the
 * bill is paid — three undefined accounting rules, and inventing them here
 * would put figures in the books that nothing can defend. No
 * goods-invoiced-not-received asset, so a bill cannot run ahead of the goods.
 */
import { sql, type Kysely } from 'kysely';

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type AnyKysely = Kysely<any>;

/**
 * Which workflow a bill belongs to, stated rather than inferred.
 *
 *   expense         — services and non-stock costs. P2/P3, no goods.
 *   stocked-direct  — I3: the bill IS the receipt, and recognises inventory.
 *   receipt-matched — AP2: the goods arrived on an AP1 receipt; this clears it.
 *
 * Inferring the workflow from whichever optional field happened to be set is
 * how a bill ends up recognising inventory twice — once because it named an
 * item, and once because a receipt already had. The column makes the choice
 * explicit and the CHECK below makes the two shapes mutually exclusive.
 */
const BILL_WORKFLOWS = ['expense', 'stocked-direct', 'receipt-matched']
  .map((w) => `'${w}'`).join(',');

/** An allocation is live, or it has been withdrawn with its bill. */
const MATCH_STATUSES = ['active', 'reversed'].map((s) => `'${s}'`).join(',');

export async function up(db: AnyKysely): Promise<void> {
  /* ── Preconditions ──────────────────────────────────────────────────────── */

  /*
   * A posted bill whose lines name an item but whose stock document has gone
   * would be backfilled as `stocked-direct` while having nothing behind it.
   * Counted and refused with the number rather than relabelled.
   */
  const { rows: orphans } = await sql<{ n: string }>`
    SELECT COUNT(DISTINCT b.id)::text AS n
      FROM bills b
      JOIN bill_lines l
        ON l.bill_id = b.id
       AND l.organization_id = b.organization_id
       AND l.company_id = b.company_id
     WHERE b.status = 'posted'
       AND l.item_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM inventory_documents d
          WHERE d.source_bill_id = b.id
            AND d.organization_id = b.organization_id
            AND d.company_id = b.company_id
       )
  `.execute(db);
  const orphaned = Number(orphans[0]?.n ?? '0');
  if (orphaned > 0) {
    throw new Error(
      `Refusing to add receipt matching: ${orphaned} posted bill(s) name a stock item but have no `
      + 'stock document behind them. Labelling those as direct stocked purchases would assert an '
      + 'inventory recognition that never happened, and labelling them anything else would hide it. '
      + 'Remedy: investigate those bills — their movements were removed outside the product — then '
      + 'run this again.',
    );
  }

  /* ── The workflow a bill belongs to ─────────────────────────────────────── */

  await sql`
    ALTER TABLE bills ADD COLUMN IF NOT EXISTS workflow text NOT NULL DEFAULT 'expense'
  `.execute(db);

  /*
   * Backfilled from what each bill ALREADY IS, never guessed: a bill with a
   * stocked line recognised inventory itself, which is exactly `stocked-direct`.
   * Everything else predates receipt matching and cannot be one.
   */
  await sql`
    UPDATE bills b
       SET workflow = 'stocked-direct'
     WHERE EXISTS (
       SELECT 1 FROM bill_lines l
        WHERE l.bill_id = b.id
          AND l.organization_id = b.organization_id
          AND l.company_id = b.company_id
          AND l.item_id IS NOT NULL
     )
  `.execute(db);

  await sql`ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_workflow_ck`.execute(db);
  await sql`
    ALTER TABLE bills
      ADD CONSTRAINT bills_workflow_ck CHECK (workflow IN (${sql.raw(BILL_WORKFLOWS)}))
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS bills_workflow_idx
      ON bills (organization_id, company_id, workflow, posting_date)
  `.execute(db);

  /* ── A bill line may name the receipt line it settles ───────────────────── */

  await sql`
    ALTER TABLE bill_lines ADD COLUMN IF NOT EXISTS receipt_line_id uuid
  `.execute(db);
  /* The quantity of that receipt line this bill is settling. */
  await sql`
    ALTER TABLE bill_lines ADD COLUMN IF NOT EXISTS matched_quantity numeric(20,10)
  `.execute(db);

  await sql`
    ALTER TABLE bill_lines DROP CONSTRAINT IF EXISTS bill_lines_receipt_line_fk
  `.execute(db);
  await sql`
    ALTER TABLE bill_lines
      ADD CONSTRAINT bill_lines_receipt_line_fk
      FOREIGN KEY (organization_id, company_id, receipt_line_id)
      REFERENCES goods_receipt_lines (organization_id, company_id, id) ON DELETE RESTRICT
  `.execute(db);

  /*
   * The two stocked shapes are mutually exclusive, in the database.
   *
   * A line that both names an item (I3 recognises inventory from the bill) and
   * names a receipt line (AP1 already recognised it) is the double-recognition
   * this whole slice exists to prevent. It is not a validation to remember, it
   * is a row that cannot exist.
   */
  await sql`
    ALTER TABLE bill_lines DROP CONSTRAINT IF EXISTS bill_lines_one_stock_path_ck
  `.execute(db);
  await sql`
    ALTER TABLE bill_lines
      ADD CONSTRAINT bill_lines_one_stock_path_ck
      CHECK (item_id IS NULL OR receipt_line_id IS NULL)
  `.execute(db);

  /* A matched line carries a positive quantity; an unmatched one carries none. */
  await sql`
    ALTER TABLE bill_lines DROP CONSTRAINT IF EXISTS bill_lines_matched_quantity_ck
  `.execute(db);
  await sql`
    ALTER TABLE bill_lines
      ADD CONSTRAINT bill_lines_matched_quantity_ck
      CHECK (
        (receipt_line_id IS NULL AND matched_quantity IS NULL)
        OR (receipt_line_id IS NOT NULL AND matched_quantity IS NOT NULL AND matched_quantity > 0)
      )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS bill_lines_receipt_line_idx
      ON bill_lines (organization_id, company_id, receipt_line_id)
      WHERE receipt_line_id IS NOT NULL
  `.execute(db);

  /* ── The allocation ledger ──────────────────────────────────────────────── */

  /*
   * The unique index a match's composite key needs, so an allocation can only
   * name a bill line that belongs to the bill it names.
   */
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS bill_lines_bill_identity_uidx
      ON bill_lines (organization_id, company_id, bill_id, id)
  `.execute(db);
  /* And the same for a receipt line against its receipt. */
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS goods_receipt_lines_receipt_identity_uidx
      ON goods_receipt_lines (organization_id, company_id, receipt_id, id)
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS bill_receipt_matches (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      company_id        uuid NOT NULL,

      /* What was settled. */
      bill_id           uuid NOT NULL,
      bill_line_id      uuid NOT NULL,
      /* What it settled. */
      receipt_id        uuid NOT NULL,
      receipt_line_id   uuid NOT NULL,
      /* And the commitment both descend from, so lineage survives either side. */
      order_id          uuid NOT NULL,
      order_line_id     uuid NOT NULL,

      supplier_id       uuid NOT NULL,
      item_id           uuid NOT NULL,
      base_unit_id      uuid NOT NULL,

      matched_quantity  numeric(20,10) NOT NULL,

      /*
       * The receipt's own frozen figures, copied at matching. Reading them from
       * the receipt later would be reading a row that cannot change — but
       * copying makes the allocation self-contained, so a schedule can explain
       * a clearing without joining through documents that may be archived.
       */
      receipt_unit_cost      numeric(20,10) NOT NULL,
      matched_receipt_value  numeric(20,10) NOT NULL,

      /* What the supplier charged for the same quantity, net of recoverable tax. */
      bill_net_unit_price    numeric(20,10) NOT NULL,
      matched_bill_value     numeric(20,10) NOT NULL,

      /*
       * Zero, always, in this slice — and stored rather than omitted so the
       * reconciliation can assert it. A difference is refused at posting
       * because the product resolves no destination for one; the column is the
       * place a future slice would record what it decided, and its being zero
       * is the evidence that nothing was quietly absorbed.
       */
      value_difference       numeric(20,10) NOT NULL DEFAULT 0,

      /* The account this clearing actually debited, frozen from the receipt. */
      grni_account_id   uuid NOT NULL,

      status            text NOT NULL DEFAULT 'active',
      reversal_reason   text NOT NULL DEFAULT '',
      reversed_at       timestamptz,
      reversed_by       uuid,

      matched_by        uuid,
      created_at        timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT bill_receipt_matches_company_fk
        FOREIGN KEY (organization_id, company_id)
        REFERENCES companies (organization_id, id) ON DELETE CASCADE,
      CONSTRAINT bill_receipt_matches_scoped_key UNIQUE (organization_id, company_id, id),

      /* The bill line, AND that it belongs to the bill this row names. */
      CONSTRAINT bill_receipt_matches_bill_line_fk
        FOREIGN KEY (organization_id, company_id, bill_id, bill_line_id)
        REFERENCES bill_lines (organization_id, company_id, bill_id, id) ON DELETE RESTRICT,
      /* The receipt line, AND that it belongs to the receipt this row names. */
      CONSTRAINT bill_receipt_matches_receipt_line_fk
        FOREIGN KEY (organization_id, company_id, receipt_id, receipt_line_id)
        REFERENCES goods_receipt_lines (organization_id, company_id, receipt_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT bill_receipt_matches_order_line_fk
        FOREIGN KEY (organization_id, company_id, order_id, order_line_id)
        REFERENCES purchase_order_lines (organization_id, company_id, order_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT bill_receipt_matches_supplier_fk
        FOREIGN KEY (organization_id, company_id, supplier_id)
        REFERENCES business_parties (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT bill_receipt_matches_item_fk
        FOREIGN KEY (organization_id, company_id, item_id)
        REFERENCES inventory_items (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT bill_receipt_matches_unit_fk
        FOREIGN KEY (organization_id, company_id, base_unit_id)
        REFERENCES units_of_measure (organization_id, company_id, id) ON DELETE RESTRICT,
      CONSTRAINT bill_receipt_matches_grni_account_fk
        FOREIGN KEY (organization_id, company_id, grni_account_id)
        REFERENCES accounts (organization_id, company_id, id) ON DELETE RESTRICT,

      CONSTRAINT bill_receipt_matches_status_ck CHECK (status IN (${sql.raw(MATCH_STATUSES)})),
      CONSTRAINT bill_receipt_matches_quantity_ck CHECK (matched_quantity > 0),
      CONSTRAINT bill_receipt_matches_values_ck CHECK (
        receipt_unit_cost >= 0 AND matched_receipt_value >= 0
        AND bill_net_unit_price >= 0 AND matched_bill_value >= 0
      ),
      /*
       * Exact-value matching, enforced by the database and not only by the
       * service. While no destination for a difference exists, a row whose two
       * values disagree would be an unexplained amount sitting in the books.
       */
      CONSTRAINT bill_receipt_matches_exact_value_ck CHECK (
        matched_bill_value = matched_receipt_value AND value_difference = 0
      ),
      /* A withdrawal is only recorded on a row that says it happened. */
      CONSTRAINT bill_receipt_matches_reversal_shape_ck CHECK (
        (status = 'reversed') = (reversed_at IS NOT NULL)
      ),
      /*
       * One bill line settles one receipt line, once. A second delivery or a
       * second invoice is another line on another document, which is what keeps
       * every clearing attributable to one pair.
       */
      CONSTRAINT bill_receipt_matches_line_unique UNIQUE (bill_line_id)
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS bill_receipt_matches_receipt_idx
      ON bill_receipt_matches (organization_id, company_id, receipt_line_id, status)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS bill_receipt_matches_bill_idx
      ON bill_receipt_matches (organization_id, company_id, bill_id, status)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS bill_receipt_matches_supplier_idx
      ON bill_receipt_matches (organization_id, company_id, supplier_id, created_at)
  `.execute(db);

  /* ── An allocation is append-only ───────────────────────────────────────── */

  /*
   * The same shape AP1's receipt uses, and for the same reason. A clearing is
   * evidence that a payable replaced an accrual; editing one would restate what
   * the books already said about a supplier's invoice. The only permitted
   * change is becoming reversed, once, with its bill.
   */
  await sql`
    CREATE OR REPLACE FUNCTION bill_receipt_match_is_append_only() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF current_setting('ledgora.allow_stock_purge', true) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION
          'A receipt-to-bill match cannot be deleted. Reverse the bill instead: the match is the '
          'record of an accrual becoming a debt.'
          USING ERRCODE = '23514';
      END IF;

      IF ROW(NEW.bill_id, NEW.bill_line_id, NEW.receipt_id, NEW.receipt_line_id,
             NEW.order_id, NEW.order_line_id, NEW.supplier_id, NEW.item_id, NEW.base_unit_id,
             NEW.matched_quantity, NEW.receipt_unit_cost, NEW.matched_receipt_value,
             NEW.bill_net_unit_price, NEW.matched_bill_value, NEW.value_difference,
             NEW.grni_account_id, NEW.matched_by, NEW.created_at)
         IS DISTINCT FROM
         ROW(OLD.bill_id, OLD.bill_line_id, OLD.receipt_id, OLD.receipt_line_id,
             OLD.order_id, OLD.order_line_id, OLD.supplier_id, OLD.item_id, OLD.base_unit_id,
             OLD.matched_quantity, OLD.receipt_unit_cost, OLD.matched_receipt_value,
             OLD.bill_net_unit_price, OLD.matched_bill_value, OLD.value_difference,
             OLD.grni_account_id, OLD.matched_by, OLD.created_at) THEN
        RAISE EXCEPTION
          'A receipt-to-bill match cannot be edited. What a bill settled does not change; reverse '
          'the bill and raise a corrected one.'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.status IS DISTINCT FROM OLD.status
         AND NOT (OLD.status = 'active' AND NEW.status = 'reversed') THEN
        RAISE EXCEPTION 'A match moves from active to reversed, once, and nowhere else.'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    DROP TRIGGER IF EXISTS bill_receipt_match_append_only ON bill_receipt_matches
  `.execute(db);
  await sql`
    CREATE TRIGGER bill_receipt_match_append_only
      BEFORE UPDATE OR DELETE ON bill_receipt_matches
      FOR EACH ROW EXECUTE FUNCTION bill_receipt_match_is_append_only()
  `.execute(db);

  /* ── A receipt line that has been matched is frozen ─────────────────────── */

  /*
   * AP1 already freezes a posted receipt line outright. This adds the other
   * direction: the line cannot be removed while a match points at it, so a
   * purge is the only thing that can take the pair away, and it takes both.
   */
  await sql`
    CREATE OR REPLACE FUNCTION goods_receipt_line_respects_matches() RETURNS trigger AS $$
    DECLARE
      matched bigint;
    BEGIN
      IF current_setting('ledgora.allow_stock_purge', true) = 'on' THEN
        RETURN OLD;
      END IF;
      SELECT COUNT(*) INTO matched FROM bill_receipt_matches WHERE receipt_line_id = OLD.id;
      IF matched > 0 THEN
        RAISE EXCEPTION
          'This received line has been matched to a supplier bill and cannot be removed. Reverse '
          'the bill first: its payable and its tax were recognised against this receipt.'
          USING ERRCODE = '23514';
      END IF;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    DROP TRIGGER IF EXISTS goods_receipt_line_match_guard ON goods_receipt_lines
  `.execute(db);
  await sql`
    CREATE TRIGGER goods_receipt_line_match_guard
      BEFORE DELETE ON goods_receipt_lines
      FOR EACH ROW EXECUTE FUNCTION goods_receipt_line_respects_matches()
  `.execute(db);

  /* ── Audit ──────────────────────────────────────────────────────────────── */

  /*
   * AP1's purchasing trail learns one more subject. A match is not an order and
   * not a receipt: it is the moment an accrual became a debt, and it needs to be
   * findable as itself.
   */
  await sql`
    ALTER TABLE purchasing_audit_events
      DROP CONSTRAINT IF EXISTS purchasing_audit_events_subject_ck
  `.execute(db);
  await sql`
    ALTER TABLE purchasing_audit_events
      ADD CONSTRAINT purchasing_audit_events_subject_ck
      CHECK (subject_type IN ('order','receipt','match'))
  `.execute(db);
}

/**
 * Down refuses to destroy the record of an accrual becoming a debt.
 *
 * Dropping the allocations while their bills stay posted would leave a payable
 * and a recovered input tax in the books with nothing saying which goods they
 * were for, and a goods-received-not-invoiced balance that had been cleared by
 * a document no longer admitting to it. Nobody could reconcile that, and no
 * error anywhere would say why.
 */
export async function down(db: AnyKysely): Promise<void> {
  const { rows } = await sql<{ matches: string; bills: string }>`
    SELECT
      (SELECT COUNT(*)::text FROM bill_receipt_matches) AS matches,
      (SELECT COUNT(*)::text FROM bills WHERE workflow = 'receipt-matched') AS bills
  `.execute(db);

  const matches = Number(rows[0]?.matches ?? '0');
  const bills = Number(rows[0]?.bills ?? '0');

  if (matches > 0 || bills > 0) {
    throw new Error(
      `Refusing to roll back 043: ${matches} receipt-to-bill match(es) and ${bills} `
      + 'receipt-matched bill(s) exist. Dropping them would leave a payable and a recovered input '
      + 'tax in the ledger with nothing saying which goods they settled, and a '
      + 'goods-received-not-invoiced balance cleared by a document that no longer says so. '
      + 'Remedy: reverse those bills deliberately, then roll back.',
    );
  }

  await sql`
    DROP TRIGGER IF EXISTS goods_receipt_line_match_guard ON goods_receipt_lines
  `.execute(db);
  await sql`DROP FUNCTION IF EXISTS goods_receipt_line_respects_matches()`.execute(db);
  await sql`
    DROP TRIGGER IF EXISTS bill_receipt_match_append_only ON bill_receipt_matches
  `.execute(db);
  await sql`DROP FUNCTION IF EXISTS bill_receipt_match_is_append_only()`.execute(db);
  await sql`DROP TABLE IF EXISTS bill_receipt_matches`.execute(db);

  await sql`DROP INDEX IF EXISTS goods_receipt_lines_receipt_identity_uidx`.execute(db);
  await sql`DROP INDEX IF EXISTS bill_lines_bill_identity_uidx`.execute(db);
  await sql`DROP INDEX IF EXISTS bill_lines_receipt_line_idx`.execute(db);

  await sql`
    ALTER TABLE bill_lines DROP CONSTRAINT IF EXISTS bill_lines_matched_quantity_ck
  `.execute(db);
  await sql`
    ALTER TABLE bill_lines DROP CONSTRAINT IF EXISTS bill_lines_one_stock_path_ck
  `.execute(db);
  await sql`
    ALTER TABLE bill_lines DROP CONSTRAINT IF EXISTS bill_lines_receipt_line_fk
  `.execute(db);
  await sql`ALTER TABLE bill_lines DROP COLUMN IF EXISTS matched_quantity`.execute(db);
  await sql`ALTER TABLE bill_lines DROP COLUMN IF EXISTS receipt_line_id`.execute(db);

  await sql`DROP INDEX IF EXISTS bills_workflow_idx`.execute(db);
  await sql`ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_workflow_ck`.execute(db);
  await sql`ALTER TABLE bills DROP COLUMN IF EXISTS workflow`.execute(db);

  await sql`
    ALTER TABLE purchasing_audit_events
      DROP CONSTRAINT IF EXISTS purchasing_audit_events_subject_ck
  `.execute(db);
  await sql`
    ALTER TABLE purchasing_audit_events
      ADD CONSTRAINT purchasing_audit_events_subject_ck
      CHECK (subject_type IN ('order','receipt'))
  `.execute(db);
}

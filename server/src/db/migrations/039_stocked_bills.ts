/**
 * Inventory I3 — stocked supplier bills.
 *
 * ══ Why the bill IS the receipt ══════════════════════════════════════════════
 *
 * This product recognises a stocked purchase when the BILL posts, not when
 * goods arrive. `purchaseRecognitionMode` is `'on-bill'` — the only value it is
 * ever given, in the seed and the store default, and never read by any branch,
 * so on-bill is not a default among alternatives but the whole of the
 * behaviour. `useGrni` is seeded false and likewise never read. The browser's
 * own stocked-purchase builder posts Dr Inventory (net) + Dr recoverable input
 * tax / Cr Trade Payables and creates the inbound movement from the bill.
 *
 * So this migration adds the two columns that let a bill line name what arrived
 * and where it went, and nothing else. There is no purchase order (the product
 * has no such document — `bills.purchase_order_id` is a bare optional string
 * with no entity behind it), no separate goods-receipt document in the
 * purchasing path, no goods-received-not-invoiced clearing, and no matching
 * table — because inventory and the liability arise in the SAME document, so
 * there is nothing to match and no variance that can arise between them.
 *
 * ══ Why there is no purchase-price variance column ═══════════════════════════
 *
 * `purchasePriceVarianceAccountId` exists in the browser settings and is read
 * by nothing, anywhere. Whether a difference between an expected and an
 * invoiced price capitalises into stock, lands in cost of sales, or goes to a
 * variance account is a decision this product has not made. Under bill-first
 * recognition no such difference can arise — the price on the bill IS the cost
 * — so the question is deferred rather than answered badly.
 *
 * ══ What makes the two ledgers agree by construction ═════════════════════════
 *
 * A stocked line's account is FORCED to the item's inventory account, and the
 * movement's cost is the line's own taxable amount — the very figure the bill's
 * journal debits. One number, one debit, one movement: the subledger and the
 * general ledger cannot disagree because they are reading the same thing.
 */
import { sql, type Kysely } from 'kysely';

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type AnyKysely = Kysely<any>;

/** The document kinds the stock ledger can stand behind, plus the new one. */
const DOCUMENT_KINDS = ['receipt', 'issue', 'transfer', 'adjustment', 'bill-receipt']
  .map((k) => `'${k}'`).join(',');

export async function up(db: AnyKysely): Promise<void> {
  /* ── A bill line may name what arrived, and where ───────────────────────── */

  await sql`ALTER TABLE bill_lines ADD COLUMN IF NOT EXISTS item_id uuid`.execute(db);
  await sql`ALTER TABLE bill_lines ADD COLUMN IF NOT EXISTS warehouse_id uuid`.execute(db);

  await sql`ALTER TABLE bill_lines DROP CONSTRAINT IF EXISTS bill_lines_item_fk`.execute(db);
  await sql`
    ALTER TABLE bill_lines
      ADD CONSTRAINT bill_lines_item_fk
      FOREIGN KEY (organization_id, company_id, item_id)
      REFERENCES inventory_items (organization_id, company_id, id) ON DELETE RESTRICT
  `.execute(db);

  await sql`ALTER TABLE bill_lines DROP CONSTRAINT IF EXISTS bill_lines_warehouse_fk`.execute(db);
  await sql`
    ALTER TABLE bill_lines
      ADD CONSTRAINT bill_lines_warehouse_fk
      FOREIGN KEY (organization_id, company_id, warehouse_id)
      REFERENCES warehouses (organization_id, company_id, id) ON DELETE RESTRICT
  `.execute(db);

  /*
   * Both or neither. A line naming an item but no warehouse could not say where
   * the goods went, and one naming a warehouse but no item could not say what
   * did — either way the movement it implies is unwritable.
   */
  await sql`ALTER TABLE bill_lines DROP CONSTRAINT IF EXISTS bill_lines_stocked_pair_ck`.execute(db);
  await sql`
    ALTER TABLE bill_lines
      ADD CONSTRAINT bill_lines_stocked_pair_ck
      CHECK ((item_id IS NULL) = (warehouse_id IS NULL))
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS bill_lines_item_idx
      ON bill_lines (organization_id, company_id, item_id)
      WHERE item_id IS NOT NULL
  `.execute(db);

  /* ── The stock ledger learns one more document kind ─────────────────────── */

  /*
   * `bill-receipt` carries the BILL's journal rather than one of its own. The
   * bill already debits inventory and credits the payable in a single balanced
   * entry; a second journal here would double the liability and the asset.
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
      ADD CONSTRAINT inventory_document_numbering_kind_ck CHECK (kind IN (${sql.raw(DOCUMENT_KINDS)}))
  `.execute(db);

  /*
   * A stock document may point back at the bill that produced it, so a reversal
   * can find its movements and a reader can get from a quantity to the invoice
   * that bought it.
   */
  await sql`
    ALTER TABLE inventory_documents ADD COLUMN IF NOT EXISTS source_bill_id uuid
  `.execute(db);
  await sql`
    ALTER TABLE inventory_documents DROP CONSTRAINT IF EXISTS inventory_documents_bill_fk
  `.execute(db);
  await sql`
    ALTER TABLE inventory_documents
      ADD CONSTRAINT inventory_documents_bill_fk
      FOREIGN KEY (organization_id, company_id, source_bill_id)
      REFERENCES bills (organization_id, company_id, id) ON DELETE RESTRICT
  `.execute(db);

  /* Only a bill receipt may name a bill, and it must name one. */
  await sql`
    ALTER TABLE inventory_documents DROP CONSTRAINT IF EXISTS inventory_documents_bill_kind_ck
  `.execute(db);
  await sql`
    ALTER TABLE inventory_documents
      ADD CONSTRAINT inventory_documents_bill_kind_ck
      CHECK ((kind = 'bill-receipt') = (source_bill_id IS NOT NULL))
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS inventory_documents_bill_idx
      ON inventory_documents (organization_id, company_id, source_bill_id)
      WHERE source_bill_id IS NOT NULL
  `.execute(db);
}

/**
 * Down refuses to strip a bill line of the stock it bought.
 *
 * Dropping `item_id` from a posted bill would leave its movements describing a
 * purchase the bill no longer admits to, and the subledger would still hold the
 * value while nothing said where it came from.
 */
export async function down(db: AnyKysely): Promise<void> {
  const { rows } = await sql<{ lines: string; documents: string }>`
    SELECT
      (SELECT COUNT(*)::text FROM bill_lines WHERE item_id IS NOT NULL) AS lines,
      (SELECT COUNT(*)::text FROM inventory_documents WHERE kind = 'bill-receipt') AS documents
  `.execute(db);

  const lines = Number(rows[0]?.lines ?? '0');
  const documents = Number(rows[0]?.documents ?? '0');

  if (lines > 0 || documents > 0) {
    throw new Error(
      `Refusing to roll back 039: ${lines} bill line(s) name a stock item and ${documents} stock `
      + 'document(s) were produced by a bill. Removing the columns would leave posted movements '
      + 'describing a purchase no bill admits to, and an inventory balance with nothing behind it. '
      + 'Remedy: reverse those bills and delete them deliberately, then roll back.',
    );
  }

  await sql`DROP INDEX IF EXISTS inventory_documents_bill_idx`.execute(db);
  await sql`
    ALTER TABLE inventory_documents DROP CONSTRAINT IF EXISTS inventory_documents_bill_kind_ck
  `.execute(db);
  await sql`
    ALTER TABLE inventory_documents DROP CONSTRAINT IF EXISTS inventory_documents_bill_fk
  `.execute(db);
  await sql`ALTER TABLE inventory_documents DROP COLUMN IF EXISTS source_bill_id`.execute(db);

  const ORIGINAL = ['receipt', 'issue', 'transfer', 'adjustment'].map((k) => `'${k}'`).join(',');
  await sql`
    ALTER TABLE inventory_document_numbering
      DROP CONSTRAINT IF EXISTS inventory_document_numbering_kind_ck
  `.execute(db);
  await sql`
    ALTER TABLE inventory_document_numbering
      ADD CONSTRAINT inventory_document_numbering_kind_ck CHECK (kind IN (${sql.raw(ORIGINAL)}))
  `.execute(db);
  await sql`
    ALTER TABLE inventory_documents DROP CONSTRAINT IF EXISTS inventory_documents_kind_ck
  `.execute(db);
  await sql`
    ALTER TABLE inventory_documents
      ADD CONSTRAINT inventory_documents_kind_ck CHECK (kind IN (${sql.raw(ORIGINAL)}))
  `.execute(db);

  await sql`DROP INDEX IF EXISTS bill_lines_item_idx`.execute(db);
  await sql`ALTER TABLE bill_lines DROP CONSTRAINT IF EXISTS bill_lines_stocked_pair_ck`.execute(db);
  await sql`ALTER TABLE bill_lines DROP CONSTRAINT IF EXISTS bill_lines_warehouse_fk`.execute(db);
  await sql`ALTER TABLE bill_lines DROP CONSTRAINT IF EXISTS bill_lines_item_fk`.execute(db);
  await sql`ALTER TABLE bill_lines DROP COLUMN IF EXISTS warehouse_id`.execute(db);
  await sql`ALTER TABLE bill_lines DROP COLUMN IF EXISTS item_id`.execute(db);
}

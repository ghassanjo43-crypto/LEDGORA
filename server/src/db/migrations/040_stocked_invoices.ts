/**
 * Inventory I4 — stocked sales invoices and cost of sales.
 *
 * ══ Why stock leaves when the INVOICE is issued ══════════════════════════════
 *
 * This product relieves stock when the invoice is issued, not when goods are
 * delivered. `salesRecognitionMode` is 'on-invoice' — the only value it is ever
 * given, in the seed and the store default, and read by no branch anywhere — so
 * on-invoice is not a default among alternatives but the whole of the
 * behaviour. The per-line `inventoryFulfillmentMode` has exactly one value
 * other than 'none', and that value is 'issue-on-invoice'.
 *
 * There is also nothing else it COULD be. This product has no sales order, no
 * delivery note, no shipment and no reservation — not as an entity, a table, a
 * status or a lifecycle. Relieving stock at delivery would have meant inventing
 * the document that records one, and the authority to confirm it. Separate
 * delivery fulfilment therefore remains deferred, and this migration adds
 * nothing that anticipates it.
 *
 * ══ Why the invoice posts a SECOND journal, not a bigger first one ═══════════
 *
 * The browser's own builder settles this: the COGS half of an inventory invoice
 * is Dr COGS / Cr Inventory at average cost, and "the revenue/tax/receivable
 * half is posted by the invoice itself, so COGS posts exactly once". Two
 * balanced entries, linked to one invoice.
 *
 * That differs from I3's stocked bill, and the difference is not a preference.
 * A bill DEBITS inventory as part of the very entry that credits the supplier —
 * one document, one balanced entry, and a second would double both sides. A
 * sale's revenue entry has no inventory leg at all: cost of sales is a separate
 * measurement, made against a position the revenue entry never reads. So the
 * bill receipt carries the bill's journal, and the invoice issue posts its own.
 *
 * ══ The columns ═════════════════════════════════════════════════════════════
 *
 * `invoice_lines.item_id` and `warehouse_id` have existed as bare uuids since
 * 019, when they mirrored a browser catalogue. This migration does not add
 * them; it gives them composite company-scoped foreign keys, so a cross-company
 * item or warehouse becomes unrepresentable rather than merely refused, and a
 * CHECK that a line names both or neither.
 */
import { sql, type Kysely } from 'kysely';

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type AnyKysely = Kysely<any>;

/** The document kinds the stock ledger can stand behind, plus the new one. */
const DOCUMENT_KINDS = ['receipt', 'issue', 'transfer', 'adjustment', 'bill-receipt', 'invoice-issue']
  .map((k) => `'${k}'`).join(',');

export async function up(db: AnyKysely): Promise<void> {
  /* ── Precondition: halt, never invent ───────────────────────────────────── */

  /*
   * 037 already refused to create the item register while any invoice line
   * named an item, so item_id is null on every row by the time this runs.
   * The warehouse column was never checked, because until now nothing read it.
   * A value there came from a browser catalogue this database never held, and
   * it describes no goods at all without an item beside it — but nulling it
   * would be this migration deciding that somebody's data was meaningless, so
   * it halts and says where to look instead.
   */
  const { rows } = await sql<{ n: string; sample: string | null }>`
    SELECT COUNT(*)::text AS n, MIN(i.invoice_number) AS sample
      FROM invoice_lines l
      JOIN invoices i ON i.id = l.invoice_id
     WHERE l.warehouse_id IS NOT NULL
  `.execute(db);
  const stale = Number(rows[0]?.n ?? '0');
  if (stale > 0) {
    throw new Error(
      `Refusing to constrain stocked invoice lines: ${stale} line(s) already name a warehouse `
      + `(for example invoice ${rows[0]?.sample ?? 'unknown'}) while naming no item. Those ids came `
      + 'from a browser catalogue the server never held, and a warehouse without an item says '
      + 'nothing about what was sold. Remedy: repoint the lines at server items and warehouses, or '
      + '— if the invoices are disposable development data — clear the column deliberately, then '
      + 'run this again.',
    );
  }

  /* ── A sold line may name what left, and from where ─────────────────────── */

  await sql`ALTER TABLE invoice_lines DROP CONSTRAINT IF EXISTS invoice_lines_item_fk`.execute(db);
  await sql`
    ALTER TABLE invoice_lines
      ADD CONSTRAINT invoice_lines_item_fk
      FOREIGN KEY (organization_id, company_id, item_id)
      REFERENCES inventory_items (organization_id, company_id, id) ON DELETE RESTRICT
  `.execute(db);

  await sql`ALTER TABLE invoice_lines DROP CONSTRAINT IF EXISTS invoice_lines_warehouse_fk`.execute(db);
  await sql`
    ALTER TABLE invoice_lines
      ADD CONSTRAINT invoice_lines_warehouse_fk
      FOREIGN KEY (organization_id, company_id, warehouse_id)
      REFERENCES warehouses (organization_id, company_id, id) ON DELETE RESTRICT
  `.execute(db);

  /*
   * Both or neither, for the reason 039 gives on the purchase side: a line
   * naming an item but no warehouse cannot say where the goods came from, and
   * one naming a warehouse but no item cannot say what did. Either way the
   * movement it implies is unwritable.
   */
  await sql`ALTER TABLE invoice_lines DROP CONSTRAINT IF EXISTS invoice_lines_stocked_pair_ck`.execute(db);
  await sql`
    ALTER TABLE invoice_lines
      ADD CONSTRAINT invoice_lines_stocked_pair_ck
      CHECK ((item_id IS NULL) = (warehouse_id IS NULL))
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS invoice_lines_item_idx
      ON invoice_lines (organization_id, company_id, item_id)
      WHERE item_id IS NOT NULL
  `.execute(db);

  /* ── The stock ledger learns one more document kind ─────────────────────── */

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
   * A stock document may point back at the invoice that sold it, so voiding
   * can find its movements and a reader can get from a cost of sales to the
   * sale that caused it.
   */
  await sql`
    ALTER TABLE inventory_documents ADD COLUMN IF NOT EXISTS source_invoice_id uuid
  `.execute(db);
  await sql`
    ALTER TABLE inventory_documents DROP CONSTRAINT IF EXISTS inventory_documents_invoice_fk
  `.execute(db);
  await sql`
    ALTER TABLE inventory_documents
      ADD CONSTRAINT inventory_documents_invoice_fk
      FOREIGN KEY (organization_id, company_id, source_invoice_id)
      REFERENCES invoices (organization_id, company_id, id) ON DELETE RESTRICT
  `.execute(db);

  /* Only an invoice issue may name an invoice, and it must name one. */
  await sql`
    ALTER TABLE inventory_documents DROP CONSTRAINT IF EXISTS inventory_documents_invoice_kind_ck
  `.execute(db);
  await sql`
    ALTER TABLE inventory_documents
      ADD CONSTRAINT inventory_documents_invoice_kind_ck
      CHECK ((kind = 'invoice-issue') = (source_invoice_id IS NOT NULL))
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS inventory_documents_invoice_idx
      ON inventory_documents (organization_id, company_id, source_invoice_id)
      WHERE source_invoice_id IS NOT NULL
  `.execute(db);
}

/**
 * Down refuses to strip a sale of the stock it consumed.
 *
 * Dropping the constraints from a posted invoice would leave its movements
 * describing a sale the invoice no longer admits to, and a cost of sales in the
 * general ledger with nothing in the subledger behind it.
 */
export async function down(db: AnyKysely): Promise<void> {
  const { rows } = await sql<{ lines: string; documents: string }>`
    SELECT
      (SELECT COUNT(*)::text FROM invoice_lines WHERE item_id IS NOT NULL) AS lines,
      (SELECT COUNT(*)::text FROM inventory_documents WHERE kind = 'invoice-issue') AS documents
  `.execute(db);

  const lines = Number(rows[0]?.lines ?? '0');
  const documents = Number(rows[0]?.documents ?? '0');

  if (lines > 0 || documents > 0) {
    throw new Error(
      `Refusing to roll back 040: ${lines} invoice line(s) name a stock item and ${documents} stock `
      + 'document(s) were produced by an invoice. Removing the constraints would leave posted '
      + 'movements describing a sale no invoice admits to, and a cost of sales with nothing behind '
      + 'it. Remedy: void those invoices and delete them deliberately, then roll back.',
    );
  }

  await sql`DROP INDEX IF EXISTS inventory_documents_invoice_idx`.execute(db);
  await sql`
    ALTER TABLE inventory_documents DROP CONSTRAINT IF EXISTS inventory_documents_invoice_kind_ck
  `.execute(db);
  await sql`
    ALTER TABLE inventory_documents DROP CONSTRAINT IF EXISTS inventory_documents_invoice_fk
  `.execute(db);
  await sql`ALTER TABLE inventory_documents DROP COLUMN IF EXISTS source_invoice_id`.execute(db);

  const PRIOR = ['receipt', 'issue', 'transfer', 'adjustment', 'bill-receipt']
    .map((k) => `'${k}'`).join(',');
  await sql`
    ALTER TABLE inventory_document_numbering
      DROP CONSTRAINT IF EXISTS inventory_document_numbering_kind_ck
  `.execute(db);
  await sql`
    ALTER TABLE inventory_document_numbering
      ADD CONSTRAINT inventory_document_numbering_kind_ck CHECK (kind IN (${sql.raw(PRIOR)}))
  `.execute(db);
  await sql`
    ALTER TABLE inventory_documents DROP CONSTRAINT IF EXISTS inventory_documents_kind_ck
  `.execute(db);
  await sql`
    ALTER TABLE inventory_documents
      ADD CONSTRAINT inventory_documents_kind_ck CHECK (kind IN (${sql.raw(PRIOR)}))
  `.execute(db);

  await sql`DROP INDEX IF EXISTS invoice_lines_item_idx`.execute(db);
  await sql`ALTER TABLE invoice_lines DROP CONSTRAINT IF EXISTS invoice_lines_stocked_pair_ck`.execute(db);
  await sql`ALTER TABLE invoice_lines DROP CONSTRAINT IF EXISTS invoice_lines_warehouse_fk`.execute(db);
  await sql`ALTER TABLE invoice_lines DROP CONSTRAINT IF EXISTS invoice_lines_item_fk`.execute(db);
}

/**
 * Giving a source-generated journal an identity the database can enforce.
 *
 * ══ The failure this closes ══════════════════════════════════════════════════
 *
 * A document module posts its journal, the response is lost to a dropped
 * connection, and the browser retries. Or the user refreshes mid-post. Or a
 * second tab issues the same document. Without a uniqueness invariant every one
 * of those writes a SECOND posted journal for one economic event, and the books
 * are then overstated by exactly one document with nothing to show which entry
 * is the duplicate.
 *
 * A `SELECT` before the `INSERT` does not fix this. Two connections can both
 * find nothing and both insert; that window is precisely where retries land,
 * because a retry follows a timeout and a timeout is when the first attempt is
 * still in flight. The guarantee has to be a constraint.
 *
 * ══ Why the key needs an EVENT, not just a document ══════════════════════════
 *
 * `(organization_id, company_id, source_type, source_id)` is the obvious key
 * and it is wrong. One sales invoice legitimately produces several journals:
 * the issue posting, and one more for every receipt against it — and today both
 * `invoiceService` and `invoiceSettlementService` write them with the SAME
 * `source_type` and `source_id`. A unique constraint on those four columns
 * would refuse the second receipt a customer ever paid.
 *
 * So the key carries `source_event`: what happened to the document, not which
 * document it was. `issue`, `settlement:<paymentId>`, `depreciation:2026-06`.
 * The document identity stays in `source_type`/`source_id`, which is what
 * reversal and reconciliation look up.
 *
 * ══ Why the index is PARTIAL on source_event ═════════════════════════════════
 *
 * Existing rows have no event and are excluded, so the invoice paths written
 * before this keep working exactly as they did. Everything posted through the
 * new source-posting service always supplies one, so everything that door
 * accepts is covered from its first day. The alternative — backfilling an event
 * onto historical rows — would invent a value nobody recorded, and the two
 * invoice journals that share a source id give no honest way to say which was
 * the issue.
 *
 * ══ Why source_id becomes text ═══════════════════════════════════════════════
 *
 * It was `uuid`, which quietly assumed only server-side documents would ever
 * generate a journal. They do not: inventory documents, journal vouchers and
 * fixed assets live in the browser and mint `inv_…`, `jv_…`, `fa_…`. A uuid
 * column cannot hold those at all, so the identity a retry needs to match on
 * could not be stored. A source id is an external document reference and text
 * is what an external reference is.
 */
import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = Kysely<any>;

export async function up(db: AnyKysely): Promise<void> {
  /*
   * uuid → text is lossless and every existing value stays byte-identical in
   * its canonical form. The old index is dropped first because it is defined
   * over the column being retyped.
   */
  await sql`DROP INDEX IF EXISTS journal_entries_source_idx`.execute(db);
  await sql`
    ALTER TABLE journal_entries
      ALTER COLUMN source_id TYPE text USING source_id::text
  `.execute(db);

  await sql`
    ALTER TABLE journal_entries
      ADD COLUMN IF NOT EXISTS source_event text
  `.execute(db);

  /*
   * An event without a document would be an identity that names nothing, and it
   * would sit in the unique index below matching other orphans. Refused.
   */
  await sql`ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_source_event_needs_source`.execute(db);
  await sql`
    ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_source_event_needs_source CHECK (
      source_event IS NULL OR (source_type IS NOT NULL AND source_id IS NOT NULL)
    )
  `.execute(db);

  /* Lookup by document identity: what a reversal and a reconcile ask for. */
  await sql`
    CREATE INDEX IF NOT EXISTS journal_entries_source_idx
      ON journal_entries (organization_id, company_id, source_type, source_id)
      WHERE source_type IS NOT NULL
  `.execute(db);

  /*
   * THE INVARIANT. One journal per company, per document, per event — enforced
   * by PostgreSQL rather than by a check the caller has to remember, so a
   * concurrent retry loses the race with a constraint violation the service can
   * turn back into "here is the entry you already posted".
   *
   * Company-scoped as well as organization-scoped: two companies under one
   * subscriber can each hold a document with the same browser-minted reference,
   * and refusing the second would be refusing a different company's books.
   */
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_source_event_unique
      ON journal_entries (organization_id, company_id, source_type, source_id, source_event)
      WHERE source_event IS NOT NULL
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`DROP INDEX IF EXISTS journal_entries_source_event_unique`.execute(db);
  await sql`DROP INDEX IF EXISTS journal_entries_source_idx`.execute(db);
  await sql`ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_source_event_needs_source`.execute(db);
  await sql`ALTER TABLE journal_entries DROP COLUMN IF EXISTS source_event`.execute(db);

  /*
   * Back to uuid, which SUCCEEDS ONLY IF nothing browser-minted was ever
   * posted. That is the honest behaviour: a rollback that silently discarded
   * the source identity of every inventory and journal-voucher posting would
   * leave those journals unreconcilable and their documents unable to find
   * them. A loud failure here means "there is now data this schema cannot
   * represent", which is true.
   */
  await sql`
    ALTER TABLE journal_entries
      ALTER COLUMN source_id TYPE uuid USING source_id::uuid
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS journal_entries_source_idx
      ON journal_entries (organization_id, source_type, source_id)
      WHERE source_type IS NOT NULL
  `.execute(db);
}

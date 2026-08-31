/**
 * Giving `invoices.customer_id` a customer it can be checked against.
 *
 * ══ What it was ══════════════════════════════════════════════════════════════
 *
 * A bare uuid. Migration 019 says so plainly and gives the reason: the business
 * entity directory was browser-resident, and "an FK to a table that does not
 * exist is not a constraint, it is a failed migration". It also promised the
 * constraint would land with the table. S1 created the table; this is that
 * promise.
 *
 * Until now an invoice could name any uuid at all — another tenant's customer,
 * a browser record the server never saw, a value typed by hand — and nothing
 * would refuse it. The composite key closes that: organization, company and
 * party together, so a cross-company reference is unrepresentable rather than
 * merely unlikely.
 *
 * ══ The party must hold the CUSTOMER role ════════════════════════════════════
 *
 * A foreign key alone would let an invoice name a supplier-only party. The role
 * is a mutable flag rather than a key, so it cannot be enforced by the same
 * constraint; the service checks it on the way in, and this migration records
 * that division of labour rather than leaving the next reader to wonder why the
 * database is silent about it.
 *
 * ══ Existing rows: halt, never invent ════════════════════════════════════════
 *
 * Any invoice whose `customer_id` has no matching party would break the
 * constraint. There is no honest automatic remedy: the browser records those
 * ids came from are disposable test data the server never held, so this
 * migration cannot map them to anything — inventing a party, or nulling the
 * column, would silently rewrite which customer an issued invoice names.
 *
 * So it REFUSES, and says exactly how many rows and what to do. A migration
 * that halts is recoverable; one that guesses at a customer identity on a
 * posted document is not.
 */
import { sql, type Kysely } from 'kysely';

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type AnyKysely = Kysely<any>;

const CONSTRAINT = 'invoices_customer_party_fk';

export async function up(db: AnyKysely): Promise<void> {
  /* ── Precondition ─────────────────────────────────────────────────────── */

  const { rows: orphans } = await sql<{ n: string; sample: string | null }>`
    SELECT COUNT(*)::text AS n,
           MIN(i.invoice_number) AS sample
      FROM invoices i
      LEFT JOIN business_parties p
        ON p.id = i.customer_id
       AND p.organization_id = i.organization_id
       AND p.company_id = i.company_id
     WHERE p.id IS NULL
  `.execute(db);

  const count = Number(orphans[0]?.n ?? '0');
  if (count > 0) {
    throw new Error(
      `Refusing to add ${CONSTRAINT}: ${count} invoice row(s) name a customer that does not `
      + `exist in business_parties for the same company (for example ${orphans[0]?.sample ?? 'unknown'}). `
      + 'These ids came from browser records the server never held, so there is no mapping this '
      + 'migration could apply without inventing which customer an issued invoice names. '
      + 'Remedy: create the matching customers through /api/customers and repoint the invoices, '
      + 'or — if the invoices are disposable development data — delete them, then run this again.',
    );
  }

  /* ── The constraint ───────────────────────────────────────────────────── */

  /*
   * Idempotent, because migration 012 is a repair that can be replayed against
   * a database still holding this work. See `deletionTombstoneRepair`.
   */
  await sql`ALTER TABLE invoices DROP CONSTRAINT IF EXISTS ${sql.raw(CONSTRAINT)}`.execute(db);
  await sql`
    ALTER TABLE invoices
      ADD CONSTRAINT ${sql.raw(CONSTRAINT)}
      FOREIGN KEY (organization_id, company_id, customer_id)
      REFERENCES business_parties (organization_id, company_id, id)
      ON DELETE RESTRICT
  `.execute(db);

  /*
   * RESTRICT, not CASCADE. A customer named on an issued invoice must stay
   * identifiable for as long as the invoice does — which is why the directory
   * has no delete path at all, only archiving. This is the database saying the
   * same thing.
   */

  await sql`
    CREATE INDEX IF NOT EXISTS invoices_customer_idx
      ON invoices (organization_id, company_id, customer_id)
  `.execute(db);
}

export async function down(db: AnyKysely): Promise<void> {
  await sql`ALTER TABLE invoices DROP CONSTRAINT IF EXISTS ${sql.raw(CONSTRAINT)}`.execute(db);
  await sql`DROP INDEX IF EXISTS invoices_customer_idx`.execute(db);
}

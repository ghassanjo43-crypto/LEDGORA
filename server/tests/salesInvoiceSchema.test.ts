/**
 * The sales-invoice schema, and the guarantees it is supposed to give.
 *
 * Invoices are moving out of the browser because a tax authority has to clear
 * them, and clearance needs properties a `localStorage` store cannot have: a
 * credential the browser never sees, evidence that survives a cache clear, a
 * durable retry queue, and immutability once cleared.
 *
 * These pin the structural half of that — tenant isolation, exact money, and
 * the numbering rule — because those are the parts a later migration could
 * quietly weaken.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, type TestContext } from './helpers/testApp.js';

let ctx: TestContext;
let orgA: string;
let orgB: string;

/** The set of books each seeded organization keeps, by organization id. */
const booksFor = new Map<string, string>();
const books = (org: string): string => booksFor.get(org)!;

/**
 * A bare organization with one owner and one company — enough to hang invoices
 * off.
 *
 * The company is created here because this helper inserts organizations
 * directly rather than through `createOrganization`, and every invoice, account
 * and journal row is company-scoped since migration 025. Marked adopted, since
 * at most one PROVISIONAL company may exist per organization (migration 026)
 * and nothing here is waiting for a browser to claim it.
 */
async function organization(name: string): Promise<string> {
  const owner = await seedUser(ctx, { email: `${name.toLowerCase()}@invoices.test` });
  const org = await ctx.db.transaction().execute(async (trx) => {
    const row = await trx.insertInto('organizations')
      .values({
        subscriber_owner_user_id: owner.id, legal_name: name, country: 'JO',
        base_currency: 'JOD', fiscal_year_start: '01-01', data_classification: 'test',
      })
      .returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('organization_memberships')
      .values({ organization_id: row.id, user_id: owner.id, role: 'owner' }).execute();
    return row.id;
  });

  const { rows } = await sql<{ id: string }>`
    INSERT INTO companies (organization_id, client_reference, legal_name, adopted_at)
    VALUES (${org}, ${`co_${org}`}, ${`${name} Books`}, now())
    RETURNING id
  `.execute(ctx.db);
  booksFor.set(org, rows[0]!.id);
  return org;
}

async function account(org: string, code: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO accounts (organization_id, company_id, account_code, account_name, account_type, normal_balance)
    VALUES (${org}, ${books(org)}, ${code}, 'Sales', 'income', 'credit') RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

async function invoice(org: string, number: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO invoices (organization_id, company_id, issuing_entity_id, customer_id, invoice_number,
                          issue_date, due_date, transaction_currency, functional_currency)
    VALUES (${org}, ${books(org)}, gen_random_uuid(), gen_random_uuid(), ${number},
            '2026-01-15', '2026-02-15', 'JOD', 'JOD')
    RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

beforeEach(async () => {
  ctx = await createTestContext();
  booksFor.clear();
  orgA = await organization('Alpha');
  orgB = await organization('Beta');
});
afterEach(async () => ctx.close());

describe('tenant isolation', () => {
  it('lets two organizations both use INV-0001', () => {
    // A document number is the tenant's own sequence. A global one would leak
    // how much every other subscriber invoices.
    return expect(Promise.all([invoice(orgA, 'INV-0001'), invoice(orgB, 'INV-0001')]))
      .resolves.toHaveLength(2);
  });

  it('refuses a duplicate number within one organization', async () => {
    await invoice(orgA, 'INV-0002');
    await expect(invoice(orgA, 'INV-0002')).rejects.toThrow(/unique|duplicate/i);
  });

  it('makes a line pointing at another tenant unrepresentable', async () => {
    const alphaInvoice = await invoice(orgA, 'INV-0003');
    const betaAccount = await account(orgB, '4000');

    // The composite key carries the organization, so this is refused by the
    // database rather than by a check somebody has to remember to write.
    await expect(sql`
      INSERT INTO invoice_lines (organization_id, company_id, invoice_id, line_number, account_id)
      VALUES (${orgA}, ${books(orgA)}, ${alphaInvoice}, 1, ${betaAccount})
    `.execute(ctx.db)).rejects.toThrow();
  });
});

describe('money and lifecycle', () => {
  it('keeps an amount exact rather than rounding it to a float', async () => {
    const id = await invoice(orgA, 'INV-0004');
    const account4000 = await account(orgA, '4000');
    await sql`
      INSERT INTO invoice_lines (organization_id, company_id, invoice_id, line_number, account_id,
                                 quantity, unit_price, line_total)
      VALUES (${orgA}, ${books(orgA)}, ${id}, 1, ${account4000}, 3, '0.1', '0.3')
    `.execute(ctx.db);

    const { rows } = await sql<{ line_total: string }>`
      SELECT line_total FROM invoice_lines WHERE invoice_id = ${id}
    `.execute(ctx.db);
    // A string, not a number — node-postgres returns NUMERIC as text so the
    // exact value is never pushed through a float on the way out.
    expect(typeof rows[0]!.line_total).toBe('string');
    expect(Number(rows[0]!.line_total)).toBe(0.3);
  });

  it('refuses a void invoice with no reason recorded', async () => {
    const id = await invoice(orgA, 'INV-0005');
    await expect(sql`
      UPDATE invoices SET status = 'void', voided_at = now() WHERE id = ${id}
    `.execute(ctx.db)).rejects.toThrow(/invoices_void_complete/i);
  });

  it('refuses an issued invoice with no issue timestamp', async () => {
    const id = await invoice(orgA, 'INV-0006');
    await expect(sql`
      UPDATE invoices SET status = 'issued' WHERE id = ${id}
    `.execute(ctx.db)).rejects.toThrow(/invoices_issued_complete/i);
  });

  it('allows voiding an invoice that was never issued', async () => {
    /*
     * An approved invoice can be cancelled before it ever reaches a customer,
     * and that document has no issue date to record. Demanding one would force
     * a date on which nothing was sent into the row.
     */
    const id = await invoice(orgA, 'INV-0007');
    await sql`
      UPDATE invoices SET status = 'void', voided_at = now(), void_reason = 'Cancelled before issue'
      WHERE id = ${id}
    `.execute(ctx.db);

    const { rows } = await sql<{ status: string; issued_at: Date | null }>`
      SELECT status, issued_at FROM invoices WHERE id = ${id}
    `.execute(ctx.db);
    expect(rows[0]).toMatchObject({ status: 'void', issued_at: null });
  });
});

describe('numbering', () => {
  it('holds the next sequence rather than deriving it from the invoices', async () => {
    /*
     * Derived numbering reuses a number after a deletion, and a tax authority
     * that has already cleared the first INV-0009 will reject the second.
     */
    await sql`
      INSERT INTO invoice_numbering (organization_id, company_id, issuing_entity_id, next_sequence)
      VALUES (${orgA}, ${books(orgA)}, gen_random_uuid(), 9)
    `.execute(ctx.db);

    const { rows } = await sql<{ next_sequence: number; prefix: string }>`
      SELECT next_sequence, prefix FROM invoice_numbering WHERE organization_id = ${orgA}
    `.execute(ctx.db);
    expect(rows[0]).toMatchObject({ next_sequence: 9, prefix: 'INV-' });
  });
});

describe('the ledger link', () => {
  it('will not let the journal entry an invoice posted be deleted', async () => {
    const id = await invoice(orgA, 'INV-0008');
    const { rows } = await sql<{ id: string }>`
      INSERT INTO journal_entries (organization_id, company_id, journal_number, transaction_date, posting_date,
                                   transaction_currency, functional_currency)
      VALUES (${orgA}, ${books(orgA)}, 'JE-0001', '2026-01-15', '2026-01-15', 'JOD', 'JOD')
      RETURNING id
    `.execute(ctx.db);
    const entry = rows[0]!.id;
    await sql`UPDATE invoices SET journal_entry_id = ${entry} WHERE id = ${id}`.execute(ctx.db);

    // The entry IS the accounting record of the invoice. It does not vanish
    // because somebody tidied the ledger.
    await expect(sql`DELETE FROM journal_entries WHERE id = ${entry}`.execute(ctx.db))
      .rejects.toThrow();
  });
});

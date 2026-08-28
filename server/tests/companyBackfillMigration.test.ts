/**
 * Phase 2 — migration 025's backfill, and what it refuses to guess.
 *
 * ══ Why this is tested by rolling back and forward again ═════════════════════
 *
 * The interesting behaviour only exists when accounting rows PREDATE the
 * company column. A test context is migrated to the latest schema, so the rows
 * it can create already have a company and there is nothing to backfill. Each
 * test here therefore steps 025 back down, plants rows in the old shape, and
 * runs it forward again — which is the exact sequence a real deployment
 * performs against a database with history in it.
 *
 * ══ What is actually at stake ════════════════════════════════════════════════
 *
 * A migration that assigns historical journals to the wrong company produces no
 * error, no failed deployment and no alert. It produces a customer's ledger
 * containing another company's transactions, discovered — if ever — at audit.
 * So the tests that matter most here are the ones asserting that the migration
 * STOPS: refusing to deploy is a bad afternoon, and guessing is a bad year.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, type TestContext } from './helpers/testApp.js';
import { createMigrator } from '../src/db/migrator.js';

let ctx: TestContext;

beforeEach(async () => { ctx = await createTestContext(); });
afterEach(async () => { await ctx.close(); });

/**
 * Step back off the company migrations, leaving the pre-company accounting
 * schema.
 *
 * One step per migration stacked above 025, newest first, because
 * `migrateDown` removes one at a time. Asserting the NAMES rather than a
 * count so that adding a later migration makes this fail loudly instead of
 * silently rolling back something else.
 */
async function rollBackCompanyScoping(): Promise<void> {
  for (const expected of [
    '027_company_settings',
    '026_company_adoption_state',
    '025_company_scoped_accounting',
  ]) {
    const result = await createMigrator(ctx.db).migrateDown();
    if (result.error) throw result.error;
    expect(result.results?.[0]?.migrationName).toBe(expected);
  }
}

/** Run it forward again, returning the error when it refuses. */
async function applyCompanyScoping(): Promise<Error | null> {
  const result = await createMigrator(ctx.db).migrateToLatest();
  return (result.error as Error | undefined) ?? null;
}

async function organization(name: string): Promise<string> {
  const owner = await seedUser(ctx, { email: `${name.toLowerCase()}@backfill.test` });
  return ctx.db.transaction().execute(async (trx) => {
    const org = await trx.insertInto('organizations').values({
      subscriber_owner_user_id: owner.id, legal_name: name, country: 'JO',
      base_currency: 'JOD', fiscal_year_start: '01-01', data_classification: 'test',
    }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('organization_memberships')
      .values({ organization_id: org.id, user_id: owner.id, role: 'owner' }).execute();
    return org.id;
  });
}

/**
 * `createOrganization` now creates a first company, and the seeding above does
 * not — which is what lets these tests produce the pre-025 world on purpose.
 */
async function company(org: string, reference: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO companies (organization_id, client_reference, legal_name)
    VALUES (${org}, ${reference}, ${`Books ${reference}`}) RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

/** Accounting rows in the OLD shape: organization only, no company. */
async function legacyBooks(org: string): Promise<{ account: string; entry: string }> {
  const { rows: acc } = await sql<{ id: string }>`
    INSERT INTO accounts (organization_id, account_code, account_name, account_type, normal_balance)
    VALUES (${org}, '1000', 'Cash', 'asset', 'debit') RETURNING id
  `.execute(ctx.db);
  const { rows: je } = await sql<{ id: string }>`
    INSERT INTO journal_entries (
      organization_id, journal_number, transaction_date, posting_date, status,
      transaction_currency, functional_currency
    ) VALUES (${org}, 'JE-000001', '2025-06-01', '2025-06-01', 'draft', 'JOD', 'JOD')
    RETURNING id
  `.execute(ctx.db);
  await sql`
    INSERT INTO journal_lines (
      organization_id, journal_entry_id, line_number, account_id,
      debit_transaction, credit_transaction, debit_functional, credit_functional
    ) VALUES (${org}, ${je[0]!.id}, 1, ${acc[0]!.id}, 25, 0, 25, 0)
  `.execute(ctx.db);
  return { account: acc[0]!.id, entry: je[0]!.id };
}

/* ══ The unambiguous case ══════════════════════════════════════════════════ */

describe('backfilling historical accounting rows', () => {
  it('assigns them when the organization has exactly one company', async () => {
    const org = await organization('Solo');
    await rollBackCompanyScoping();
    const books = await legacyBooks(org);
    const only = await company(org, 'co_solo');

    expect(await applyCompanyScoping()).toBeNull();

    const account = await ctx.db.selectFrom('accounts').select('company_id')
      .where('id', '=', books.account).executeTakeFirstOrThrow();
    const entry = await ctx.db.selectFrom('journal_entries').select('company_id')
      .where('id', '=', books.entry).executeTakeFirstOrThrow();
    const line = await ctx.db.selectFrom('journal_lines').select('company_id')
      .where('journal_entry_id', '=', books.entry).executeTakeFirstOrThrow();

    expect(account.company_id).toBe(only);
    expect(entry.company_id).toBe(only);
    /* The line inherits from its ENTRY, so a child can never disagree with the
     * record it belongs to. */
    expect(line.company_id).toBe(only);
  });

  it('keeps two organizations’ rows in their own companies', async () => {
    const acme = await organization('Acme');
    const globex = await organization('Globex');
    await rollBackCompanyScoping();
    const acmeBooks = await legacyBooks(acme);
    const globexBooks = await legacyBooks(globex);
    const acmeCompany = await company(acme, 'co_acme');
    const globexCompany = await company(globex, 'co_globex');

    expect(await applyCompanyScoping()).toBeNull();

    const rows = await ctx.db.selectFrom('journal_entries')
      .select(['id', 'company_id']).execute();
    expect(rows.find((r) => r.id === acmeBooks.entry)!.company_id).toBe(acmeCompany);
    expect(rows.find((r) => r.id === globexBooks.entry)!.company_id).toBe(globexCompany);
  });

  it('leaves an organization with no accounting rows alone, companies or not', async () => {
    const quiet = await organization('Quiet');
    await rollBackCompanyScoping();
    /* Several companies, but nothing posted — so there is nothing to attribute
     * and nothing to be ambiguous about. */
    await company(quiet, 'co_one');
    await company(quiet, 'co_two');

    expect(await applyCompanyScoping()).toBeNull();
  });
});

/* ══ The cases it refuses ══════════════════════════════════════════════════ */

describe('backfilling when the company cannot be determined', () => {
  it('STOPS when an organization has books and several companies', async () => {
    const org = await organization('Ambiguous');
    await rollBackCompanyScoping();
    await legacyBooks(org);
    await company(org, 'co_first');
    await company(org, 'co_second');

    const error = await applyCompanyScoping();
    expect(error).not.toBeNull();
    expect(String(error)).toMatch(/2 registered companies|cannot be determined/i);
  });

  it('changes NOTHING when it stops', async () => {
    const org = await organization('Ambiguous');
    await rollBackCompanyScoping();
    const books = await legacyBooks(org);
    await company(org, 'co_first');
    await company(org, 'co_second');

    expect(await applyCompanyScoping()).not.toBeNull();

    /*
     * The rows are still there, unmodified — and the column is not merely
     * unpopulated, it does not exist. The refusal happens inside the
     * migration's transaction, so even the `ADD COLUMN` is rolled back and the
     * database is bit-for-bit what it was before the deployment was attempted.
     *
     * That completeness is the property worth having. A failure that
     * half-assigned the books would be worse than one that refused, because
     * afterwards there would be no way to tell which half had been guessed.
     */
    const entry = await ctx.db.selectFrom('journal_entries').selectAll()
      .where('id', '=', books.entry).executeTakeFirstOrThrow();
    expect(entry.journal_number).toBe('JE-000001');

    const { rows: columns } = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'journal_entries' AND column_name = 'company_id'
    `.execute(ctx.db);
    expect(columns).toEqual([]);

    const accounts = await ctx.db.selectFrom('accounts').selectAll().execute();
    expect(accounts).toHaveLength(1);
  });

  it('STOPS when an organization has books and NO company', async () => {
    const org = await organization('Orphan');
    await rollBackCompanyScoping();
    await legacyBooks(org);

    const error = await applyCompanyScoping();
    expect(error).not.toBeNull();
    /* Told what to do about it, not merely that it failed. */
    expect(String(error)).toMatch(/no registered company/i);
    expect(String(error)).toMatch(/Register the company/i);
  });
});

/* ══ The explicit mapping ══════════════════════════════════════════════════ */

describe('an operator-supplied mapping', () => {
  /*
   * The GUC is set on the connection, and PGlite runs the whole test on one
   * connection, so a plain SET persists for the migration that follows.
   */
  const setMapping = (json: string) =>
    sql.raw(`SET ledgora.company_backfill_map = '${json}'`).execute(ctx.db);
  const clearMapping = () => sql`SET ledgora.company_backfill_map = ''`.execute(ctx.db);

  it('resolves an otherwise ambiguous organization', async () => {
    const org = await organization('Ambiguous');
    await rollBackCompanyScoping();
    const books = await legacyBooks(org);
    await company(org, 'co_first');
    const chosen = await company(org, 'co_second');

    await setMapping(JSON.stringify({ [org]: chosen }));
    expect(await applyCompanyScoping()).toBeNull();
    await clearMapping();

    const entry = await ctx.db.selectFrom('journal_entries').select('company_id')
      .where('id', '=', books.entry).executeTakeFirstOrThrow();
    /* The company the operator named — the SECOND one, which no automatic rule
     * would have chosen. */
    expect(entry.company_id).toBe(chosen);
  });

  it('refuses a mapping naming another organization’s company', async () => {
    const acme = await organization('Acme');
    const globex = await organization('Globex');
    await rollBackCompanyScoping();
    await legacyBooks(acme);
    await company(acme, 'co_acme_one');
    await company(acme, 'co_acme_two');
    const foreign = await company(globex, 'co_globex');

    await setMapping(JSON.stringify({ [acme]: foreign }));
    const error = await applyCompanyScoping();
    await clearMapping();

    /*
     * A mapping states a fact the database cannot infer. It is never a way to
     * override one it can — and "this company belongs to that organization" is
     * something the database knows perfectly well.
     */
    expect(error).not.toBeNull();
    expect(String(error)).toMatch(/does not belong to it/i);
  });
});

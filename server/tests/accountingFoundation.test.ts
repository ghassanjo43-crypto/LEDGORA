/**
 * Phase A1 — the accounting foundation's DATABASE invariants.
 *
 * ══ Why these test SQL and not a service ═════════════════════════════════════
 *
 * Every rule below was previously enforced only in browser TypeScript, in code
 * the account holder could edit. Moving the books to PostgreSQL is only worth
 * anything if the rules moved with them — so these tests bypass the application
 * entirely and attack the tables directly. A rule that survives a hand-written
 * INSERT is a rule; one that only survives the service layer is a convention.
 *
 * The tenant-isolation cases matter most. They do not check that a query
 * filters by organization; they check that the DATABASE REFUSES to relate one
 * tenant's row to another's, so a forgotten `where organization_id` cannot
 * quietly produce a cross-tenant ledger.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, type TestContext } from './helpers/testApp.js';

let ctx: TestContext;
let orgA: string;
let orgB: string;
/** The default set of books for each organization, keyed by organization id. */
const defaultCompany = new Map<string, string>();

/** The company every helper writes into unless a test names another. */
const booksOf = (org: string): string => defaultCompany.get(org)!;

/** A company under `org`. Several may exist, which is the point of most of this file. */
async function company(org: string, reference: string, name = 'Books'): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO companies (organization_id, client_reference, legal_name)
    VALUES (${org}, ${reference}, ${name})
    RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

/** A bare organization row, with one set of books — enough to hang accounting off. */
async function organization(name: string): Promise<string> {
  const owner = await seedUser(ctx, { email: `${name.toLowerCase().replace(/\W+/gu, '-')}@foundation.test` });
  const org = await ctx.db.transaction().execute(async (trx) => {
    const row = await trx.insertInto('organizations').values({ subscriber_owner_user_id: owner.id, legal_name: name, country: 'JO', base_currency: 'JOD', fiscal_year_start: '01-01', data_classification: 'test' }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('organization_memberships').values({ organization_id: row.id, user_id: owner.id, role: 'owner' }).execute();
    return row.id;
  });
  defaultCompany.set(org, await company(org, `co_${org}`, `${name} Books`));
  return org;
}

async function account(
  org: string,
  code: string,
  type = 'asset',
  normal = 'debit',
  books = booksOf(org),
): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO accounts (organization_id, company_id, account_code, account_name, account_type, normal_balance)
    VALUES (${org}, ${books}, ${code}, ${`Account ${code}`}, ${type}, ${normal})
    RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

async function entry(
  org: string,
  number: string,
  status = 'draft',
  books = booksOf(org),
): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO journal_entries (
      organization_id, company_id, journal_number, transaction_date, posting_date, status,
      transaction_currency, functional_currency, exchange_rate,
      posted_at
    ) VALUES (
      ${org}, ${books}, ${number}, '2026-08-01', '2026-08-01', ${status},
      'JOD', 'JOD', 1,
      ${status === 'posted' ? '2026-08-01T00:00:00Z' : null}
    ) RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

/** Insert a line, returning the error message when the database refuses. */
async function line(
  org: string,
  entryId: string,
  accountId: string,
  lineNumber: number,
  debit: number,
  credit: number,
  books = booksOf(org),
): Promise<string | null> {
  try {
    await sql`
      INSERT INTO journal_lines (
        organization_id, company_id, journal_entry_id, line_number, account_id,
        debit_transaction, credit_transaction, debit_functional, credit_functional
      ) VALUES (
        ${org}, ${books}, ${entryId}, ${lineNumber}, ${accountId},
        ${debit}, ${credit}, ${debit}, ${credit}
      )
    `.execute(ctx.db);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

beforeEach(async () => {
  ctx = await createTestContext();
  defaultCompany.clear();
  orgA = await organization('Org A');
  orgB = await organization('Org B');
});
afterEach(async () => {
  await ctx.close();
});

/* ══ Schema shape ══════════════════════════════════════════════════════════ */

describe('the accounting schema', () => {
  it('creates every table the foundation needs', async () => {
    const { rows } = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('accounting_periods','accounts','journal_entries',
                            'journal_lines','journal_entry_versions','accounting_audit_events')
       ORDER BY table_name
    `.execute(ctx.db);
    expect(rows.map((r) => r.table_name)).toEqual([
      'accounting_audit_events',
      'accounting_periods',
      'accounts',
      'journal_entries',
      'journal_entry_versions',
      'journal_lines',
    ]);
  });

  it('stores money as exact numeric, never floating point', async () => {
    const { rows } = await sql<{ column_name: string; data_type: string; numeric_scale: number }>`
      SELECT column_name, data_type, numeric_scale
        FROM information_schema.columns
       WHERE table_name = 'journal_lines'
         AND column_name IN ('debit_transaction','credit_transaction','debit_functional','credit_functional')
    `.execute(ctx.db);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.data_type, `${row.column_name} must be exact`).toBe('numeric');
      expect(row.numeric_scale).toBeGreaterThanOrEqual(4);
    }
  });

  it('keeps a three-decimal currency exact through a round trip', async () => {
    // JOD has three minor units; a float would not survive this.
    const acc = await account(orgA, '1000');
    const je = await entry(orgA, 'JE-0001');
    expect(await line(orgA, je, acc, 1, 1234.567, 0)).toBeNull();
    const { rows } = await sql<{ debit_transaction: string }>`
      SELECT debit_transaction FROM journal_lines WHERE journal_entry_id = ${je}
    `.execute(ctx.db);
    expect(Number(rows[0]!.debit_transaction)).toBe(1234.567);
  });
});

/* ══ Double-entry rules, enforced by the database ══════════════════════════ */

describe('double-entry rules', () => {
  it('refuses a line carrying BOTH a debit and a credit', async () => {
    const acc = await account(orgA, '1000');
    const je = await entry(orgA, 'JE-0001');
    const error = await line(orgA, je, acc, 1, 100, 100);
    expect(error, 'the database itself must refuse this').toMatch(/debit_xor_credit/);
  });

  it('refuses a negative amount', async () => {
    const acc = await account(orgA, '1000');
    const je = await entry(orgA, 'JE-0001');
    const error = await line(orgA, je, acc, 1, -100, 0);
    expect(error).toMatch(/debit_transaction_check|violates check/i);
  });

  it('refuses functional and transaction sides that disagree', async () => {
    const acc = await account(orgA, '1000');
    const je = await entry(orgA, 'JE-0001');
    let error: string | null = null;
    try {
      await sql`
        INSERT INTO journal_lines (
          organization_id, company_id, journal_entry_id, line_number, account_id,
          debit_transaction, credit_transaction, debit_functional, credit_functional
        ) VALUES (${orgA}, ${booksOf(orgA)}, ${je}, 1, ${acc}, 100, 0, 0, 100)
      `.execute(ctx.db);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    // A debit in one currency cannot become a credit in another.
    expect(error).toMatch(/functional_side/);
  });

  it('accepts a debit-only and a credit-only line', async () => {
    const debitAccount = await account(orgA, '1000');
    const creditAccount = await account(orgA, '3000', 'equity', 'credit');
    const je = await entry(orgA, 'JE-0001');
    expect(await line(orgA, je, debitAccount, 1, 100_000, 0)).toBeNull();
    expect(await line(orgA, je, creditAccount, 2, 0, 100_000)).toBeNull();
  });

  it('refuses a duplicate line number inside one entry', async () => {
    const acc = await account(orgA, '1000');
    const je = await entry(orgA, 'JE-0001');
    await line(orgA, je, acc, 1, 100, 0);
    expect(await line(orgA, je, acc, 1, 50, 0)).toMatch(/number_unique|duplicate key/i);
  });

  it('requires a posted entry to record when it was posted', async () => {
    let error: string | null = null;
    try {
      await sql`
        INSERT INTO journal_entries (organization_id, company_id, journal_number, transaction_date, posting_date,
                                     status, transaction_currency, functional_currency)
        VALUES (${orgA}, ${booksOf(orgA)}, 'JE-BAD', '2026-08-01', '2026-08-01', 'posted', 'JOD', 'JOD')
      `.execute(ctx.db);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    expect(error).toMatch(/posted_complete/);
  });

  it('refuses an unknown status', async () => {
    let error: string | null = null;
    try {
      await sql`
        INSERT INTO journal_entries (organization_id, company_id, journal_number, transaction_date, posting_date,
                                     status, transaction_currency, functional_currency)
        VALUES (${orgA}, ${booksOf(orgA)}, 'JE-BAD2', '2026-08-01', '2026-08-01', 'half-posted', 'JOD', 'JOD')
      `.execute(ctx.db);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    expect(error).toMatch(/status_check|violates check/i);
  });
});

/* ══ Tenant isolation, enforced by the database ════════════════════════════ */

describe('tenant isolation', () => {
  it('scopes journal numbers per organization — both tenants may hold JE-0001', async () => {
    await entry(orgA, 'JE-0001');
    await expect(entry(orgB, 'JE-0001')).resolves.toBeTruthy();
  });

  it('refuses a duplicate journal number WITHIN one organization', async () => {
    await entry(orgA, 'JE-0001');
    await expect(entry(orgA, 'JE-0001')).rejects.toThrow(/number_unique|duplicate key/i);
  });

  it('refuses a line that posts one tenant’s entry to another tenant’s account', async () => {
    const accountOfB = await account(orgB, '1000');
    const entryOfA = await entry(orgA, 'JE-0001');

    const error = await line(orgA, entryOfA, accountOfB, 1, 100, 0);

    // The composite foreign key makes this unrepresentable, not merely unlikely.
    expect(error, 'cross-tenant account must be refused by the database').toMatch(
      /account_same_org|violates foreign key/i,
    );
  });

  it('refuses a line whose organization differs from its entry’s', async () => {
    const accountOfB = await account(orgB, '2000');
    const entryOfA = await entry(orgA, 'JE-0002');
    const error = await line(orgB, entryOfA, accountOfB, 1, 100, 0);
    expect(error).toMatch(/entry_same_org|violates foreign key/i);
  });

  it('refuses an account parented under another tenant’s account', async () => {
    const parentOfB = await account(orgB, '1000');
    let error: string | null = null;
    try {
      await sql`
        INSERT INTO accounts (organization_id, company_id, account_code, account_name, account_type,
                              normal_balance, parent_account_id)
        VALUES (${orgA}, ${booksOf(orgA)}, '1100', 'Child', 'asset', 'debit', ${parentOfB})
      `.execute(ctx.db);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    expect(error).toMatch(/parent_same_company|violates foreign key/i);
  });

  it('refuses a correction link across tenants', async () => {
    const entryOfB = await entry(orgB, 'JE-0009');
    let error: string | null = null;
    try {
      await sql`
        INSERT INTO journal_entries (organization_id, company_id, journal_number, transaction_date, posting_date,
                                     transaction_currency, functional_currency, original_entry_id)
        VALUES (${orgA}, ${booksOf(orgA)}, 'JE-0010', '2026-08-01', '2026-08-01', 'JOD', 'JOD', ${entryOfB})
      `.execute(ctx.db);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    expect(error).toMatch(/same_company|violates foreign key/i);
  });

  it('scopes account codes per organization', async () => {
    await account(orgA, '1000');
    await expect(account(orgB, '1000')).resolves.toBeTruthy();
    await expect(account(orgA, '1000')).rejects.toThrow(/code_unique|duplicate key/i);
  });
});

/* ══ Accounts are deactivated, never deleted once used ═════════════════════ */

describe('account lifecycle', () => {
  it('refuses to delete an account a journal line references', async () => {
    const acc = await account(orgA, '1000');
    const je = await entry(orgA, 'JE-0001');
    await line(orgA, je, acc, 1, 100, 0);

    let error: string | null = null;
    try {
      await sql`DELETE FROM accounts WHERE id = ${acc}`.execute(ctx.db);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    // Deactivate instead — the ledger keeps pointing at it forever.
    expect(error, 'the delete must be refused').toMatch(/update or delete on table "accounts"|violates foreign key|still referenced/i);

    await sql`UPDATE accounts SET active = false WHERE id = ${acc}`.execute(ctx.db);
    const { rows } = await sql<{ active: boolean }>`SELECT active FROM accounts WHERE id = ${acc}`.execute(ctx.db);
    expect(rows[0]!.active).toBe(false);
  });

  it('deletes an unused account freely', async () => {
    const acc = await account(orgA, '9999');
    await expect(sql`DELETE FROM accounts WHERE id = ${acc}`.execute(ctx.db)).resolves.toBeTruthy();
  });
});

/* ══ Accounting periods ════════════════════════════════════════════════════ */

describe('accounting periods', () => {
  const period = (
    org: string, year: number, number_: number, start: string, end: string,
    status = 'open', books = booksOf(org),
  ) =>
    sql`
      INSERT INTO accounting_periods (organization_id, company_id, fiscal_year, period_number, start_date, end_date, status)
      VALUES (${org}, ${books}, ${year}, ${number_}, ${start}, ${end}, ${status})
    `.execute(ctx.db);

  it('accepts consecutive periods and rejects a duplicate', async () => {
    await expect(period(orgA, 2026, 1, '2026-01-01', '2026-01-31')).resolves.toBeTruthy();
    await expect(period(orgA, 2026, 2, '2026-02-01', '2026-02-28')).resolves.toBeTruthy();
    await expect(period(orgA, 2026, 1, '2026-01-01', '2026-01-31')).rejects.toThrow(/unique|duplicate key/i);
  });

  it('lets two organizations hold the same period independently', async () => {
    await period(orgA, 2026, 1, '2026-01-01', '2026-01-31');
    await expect(period(orgB, 2026, 1, '2026-01-01', '2026-01-31')).resolves.toBeTruthy();
  });

  it('refuses a period that ends before it starts', async () => {
    await expect(period(orgA, 2026, 3, '2026-03-31', '2026-03-01')).rejects.toThrow(/range|violates check/i);
  });

  it('refuses an unknown status', async () => {
    await expect(period(orgA, 2026, 4, '2026-04-01', '2026-04-30', 'ajar')).rejects.toThrow(/status|violates check/i);
  });
});

/* ══ History and audit are append-only evidence ════════════════════════════ */

describe('version history and audit', () => {
  it('keeps a version snapshot bound to its entry and organization', async () => {
    const je = await entry(orgA, 'JE-0001');
    await sql`
      INSERT INTO journal_entry_versions (organization_id, company_id, journal_entry_id, version, change_kind, reason, snapshot)
      VALUES (${orgA}, ${booksOf(orgA)}, ${je}, 1, 'created', '', ${JSON.stringify({ status: 'draft' })}::jsonb)
    `.execute(ctx.db);

    const { rows } = await sql<{ version: number; change_kind: string }>`
      SELECT version, change_kind FROM journal_entry_versions WHERE journal_entry_id = ${je}
    `.execute(ctx.db);
    expect(rows).toEqual([{ version: 1, change_kind: 'created' }]);
  });

  it('refuses two snapshots of the same version', async () => {
    const je = await entry(orgA, 'JE-0001');
    const insert = () => sql`
      INSERT INTO journal_entry_versions (organization_id, company_id, journal_entry_id, version, change_kind, snapshot)
      VALUES (${orgA}, ${booksOf(orgA)}, ${je}, 1, 'created', '{}'::jsonb)
    `.execute(ctx.db);
    await insert();
    await expect(insert()).rejects.toThrow(/unique|duplicate key/i);
  });

  it('refuses a version snapshot attached across tenants', async () => {
    const entryOfB = await entry(orgB, 'JE-0001');
    await expect(
      sql`
        INSERT INTO journal_entry_versions (organization_id, company_id, journal_entry_id, version, change_kind, snapshot)
        VALUES (${orgA}, ${booksOf(orgA)}, ${entryOfB}, 1, 'created', '{}'::jsonb)
      `.execute(ctx.db),
    ).rejects.toThrow(/same_company|violates foreign key/i);
  });

  it('keeps an audit event after the record it describes is gone', async () => {
    const je = await entry(orgA, 'JE-0001');
    await sql`
      INSERT INTO accounting_audit_events (organization_id, company_id, action, record_type, record_id, actor_name)
      VALUES (${orgA}, ${booksOf(orgA)}, 'JOURNAL_CREATED', 'journal_entry', ${je}, 'Tester')
    `.execute(ctx.db);

    // The draft is deleted; the record of who created it must survive, which is
    // why this table has no foreign key to the entry.
    await sql`DELETE FROM journal_entries WHERE id = ${je}`.execute(ctx.db);

    const { rows } = await sql<{ action: string }>`
      SELECT action FROM accounting_audit_events WHERE record_id = ${je}
    `.execute(ctx.db);
    expect(rows.map((r) => r.action)).toEqual(['JOURNAL_CREATED']);
  });

  it('removes accounting rows when the tenant itself is deleted', async () => {
    const acc = await account(orgA, '1000');
    const je = await entry(orgA, 'JE-0001');
    await line(orgA, je, acc, 1, 100, 0);

    // Ownership is immutable, so the workspace shell may only be destroyed once
    // its permanent claim has been retired — exactly what the purge path does
    // before it removes the tenant. Without this the delete is refused.
    await sql`UPDATE subscriber_workspace_ownership_claims
      SET retired_at = now() WHERE workspace_id = ${orgA} AND retired_at IS NULL`.execute(ctx.db);
    await sql`DELETE FROM organizations WHERE id = ${orgA}`.execute(ctx.db);

    for (const table of ['accounts', 'journal_entries', 'journal_lines', 'accounting_audit_events']) {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM ${sql.table(table)} WHERE organization_id = ${orgA}
      `.execute(ctx.db);
      expect(rows[0]!.n, `${table} must not outlive its tenant`).toBe(0);
    }
  });
});

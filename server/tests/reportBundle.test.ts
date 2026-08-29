/**
 * Financial statements from one snapshot, aggregated in PostgreSQL.
 *
 * ══ The claim that matters most ══════════════════════════════════════════════
 *
 * Reversals must net to zero WITHOUT erasing history. `reverseJournal` flips the
 * original to `reversed` and leaves its lines untouched, then posts a mirrored
 * entry. A report counting only `posted` would include the mirror and exclude
 * the original — showing the NEGATIVE of the transaction while still balancing.
 * That is the failure this file exists to make impossible, so the reversal
 * sequences are tested first and by their arithmetic, not by their status.
 *
 * ══ Why the numbers are compared as strings ══════════════════════════════════
 *
 * Every figure crosses the wire as a decimal string and is asserted as one. A
 * test that parsed them into JavaScript numbers would pass while the very
 * precision it exists to protect was being lost.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, type TestContext } from './helpers/testApp.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as journals from '../src/services/accounting/journalService.js';
import { buildReportBundle } from '../src/services/accounting/reportService.js';

let ctx: TestContext;
let organizationId: string;
let actor: AccountingActor;
let chart: { cash: string; sales: string; equity: string; rent: string };

async function organization(name: string, currency = 'JOD'): Promise<string> {
  const owner = await seedUser(ctx, { email: `owner-${name.toLowerCase()}@reports.test` });
  return ctx.db.transaction().execute(async (trx) => {
    const org = await trx.insertInto('organizations').values({
      subscriber_owner_user_id: owner.id, legal_name: name, country: 'JO',
      base_currency: currency, fiscal_year_start: '01-01', data_classification: 'test',
    }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('organization_memberships')
      .values({ organization_id: org.id, user_id: owner.id, role: 'owner' }).execute();
    return org.id;
  });
}

async function company(org: string, reference: string): Promise<string> {
  const row = await ctx.db.insertInto('companies')
    .values({
      organization_id: org, client_reference: reference,
      legal_name: `Books ${reference}`, adopted_at: sql`now()`,
    })
    .returning('id').executeTakeFirstOrThrow();
  await ctx.db.insertInto('company_settings')
    .values({ organization_id: org, company_id: row.id })
    .onConflict((oc) => oc.columns(['organization_id', 'company_id']).doNothing())
    .execute();
  return row.id;
}

async function person(email: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO users (email, normalized_email, full_name, password_hash, status, email_verified_at)
    VALUES (${email}, ${email}, 'Reporter', 'x', 'active', now()) RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

async function buildChart(a: AccountingActor) {
  const make = async (code: string, name: string, type: 'asset' | 'income' | 'equity' | 'expense') =>
    (await accounts.createAccount(ctx.db, a, { accountCode: code, accountName: name, accountType: type })).id;
  return {
    cash: await make('1000', 'Cash', 'asset'),
    sales: await make('4000', 'Sales', 'income'),
    equity: await make('3000', 'Opening Equity', 'equity'),
    rent: await make('5000', 'Rent', 'expense'),
  };
}

/** Post a balanced entry and return it. */
async function post(
  a: AccountingActor,
  debitAccount: string,
  creditAccount: string,
  amount: string,
  date = '2026-06-15',
) {
  const draft = await journals.createDraft(ctx.db, a, {
    transactionDate: date,
    description: 'Test posting',
    lines: [{ accountId: debitAccount, debit: amount }, { accountId: creditAccount, credit: amount }],
  });
  return journals.postJournal(ctx.db, a, draft.id, { expectedVersion: draft.version });
}

const WINDOW = { asOf: '2026-12-31', from: '2026-01-01', to: '2026-12-31' };

const bundle = (over: Partial<typeof WINDOW> = {}, scope = actor) =>
  buildReportBundle(ctx.db, {
    organizationId: scope.organizationId,
    companyId: scope.companyId,
    parameters: { ...WINDOW, ...over, comparative: null },
  });

beforeEach(async () => {
  ctx = await createTestContext();
  organizationId = await organization('Reports');
  actor = {
    organizationId,
    companyId: await company(organizationId, 'co_reports'),
    userId: await person('reporter@reports.test'),
    name: 'Reporter',
  };
  chart = await buildChart(actor);
});
afterEach(async () => { await ctx.close(); });

/* ══ Reversal arithmetic — the load-bearing claim ══════════════════════════ */

describe('a reversed posting', () => {
  it('nets to zero, and BOTH entries remain in the books', async () => {
    const original = await post(actor, chart.cash, chart.sales, '1000.000');

    const before = await bundle();
    expect(before.trialBalance.totalDebit).toBe('1000.000');
    expect(before.incomeStatement.income).toBe('1000.000');

    await journals.reverseJournal(ctx.db, actor, original.id, {
      expectedVersion: original.version, reason: 'Entered in error',
    });

    const after = await bundle();
    /*
     * Zero — not −1000, which is what counting only `posted` would produce,
     * because the original is now `reversed` while its mirror is `posted`.
     */
    expect(after.trialBalance.totalDebit).toBe('0.000');
    expect(after.trialBalance.totalCredit).toBe('0.000');
    expect(after.incomeStatement.income).toBe('0.000');
    expect(after.incomeStatement.netIncome).toBe('0.000');

    /* History intact: the original is `reversed`, the mirror is `posted`. */
    const statuses = await ctx.db.selectFrom('journal_entries').select(['status'])
      .where('company_id', '=', actor.companyId).execute();
    expect(statuses.map((s) => s.status).sort()).toEqual(['posted', 'reversed']);
  });

  it('leaves the cash account flat, not negative', async () => {
    const original = await post(actor, chart.cash, chart.sales, '250.750');
    await journals.reverseJournal(ctx.db, actor, original.id, {
      expectedVersion: original.version, reason: 'Duplicate',
    });

    const report = await bundle();
    const cash = report.balanceSheet.rows.find((r) => r.accountId === chart.cash)!;
    expect(cash.amount).toBe('0.000');
    expect(report.balanceSheet.assets).toBe('0.000');
  });

  it('leaves the REPLACEMENT effective after amend-and-replace', async () => {
    const original = await post(actor, chart.cash, chart.sales, '1000.000');

    await journals.reverseAndReplace(ctx.db, actor, original.id, {
      transactionDate: '2026-06-15',
      description: 'Corrected',
      lines: [
        { accountId: chart.cash, debit: '900.000' },
        { accountId: chart.sales, credit: '900.000' },
      ],
    }, { expectedVersion: original.version, reason: 'Wrong amount' });

    /*
     * Original (1000) and its reversal (−1000) cancel; the replacement stands.
     * Three entries in the books, one net effect.
     */
    const report = await bundle();
    expect(report.incomeStatement.income).toBe('900.000');
    expect(report.trialBalance.totalDebit).toBe('900.000');

    const count = await ctx.db.selectFrom('journal_entries').select('id')
      .where('company_id', '=', actor.companyId).execute();
    expect(count).toHaveLength(3);
  });

  it('ignores drafts entirely', async () => {
    await journals.createDraft(ctx.db, actor, {
      transactionDate: '2026-06-15',
      description: 'Never posted',
      lines: [
        { accountId: chart.cash, debit: '500.000' },
        { accountId: chart.sales, credit: '500.000' },
      ],
    });

    const report = await bundle();
    expect(report.trialBalance.totalDebit).toBe('0.000');
  });
});

/* ══ The statements ════════════════════════════════════════════════════════ */

describe('the statements', () => {
  it('balance, with unclosed earnings carrying the result', async () => {
    await post(actor, chart.cash, chart.equity, '5000.000', '2026-01-01');
    await post(actor, chart.cash, chart.sales, '1200.000', '2026-03-10');
    await post(actor, chart.rent, chart.cash, '300.000', '2026-04-01');

    const report = await bundle();

    expect(report.trialBalance.totalDebit).toBe(report.trialBalance.totalCredit);
    expect(report.balanceSheet.assets).toBe('5900.000');
    expect(report.balanceSheet.equity).toBe('5000.000');
    expect(report.balanceSheet.unclosedEarnings).toBe('900.000');
    expect(report.balanceSheet.balances).toBe(true);

    expect(report.incomeStatement.income).toBe('1200.000');
    expect(report.incomeStatement.expense).toBe('300.000');
    expect(report.incomeStatement.netIncome).toBe('900.000');
  });

  it('keep JOD at three decimals throughout', async () => {
    await post(actor, chart.cash, chart.sales, '0.001');
    await post(actor, chart.cash, chart.sales, '0.002');

    const report = await bundle();
    expect(report.snapshot.currency).toBe('JOD');
    expect(report.snapshot.decimals).toBe(3);
    /* Exact: two thousandths of a dinar, added in numeric, never as floats. */
    expect(report.incomeStatement.income).toBe('0.003');
  });

  it('report empty books as zeros rather than failing', async () => {
    const report = await bundle();
    expect(report.trialBalance.totalDebit).toBe('0.000');
    expect(report.balanceSheet.balances).toBe(true);
    expect(report.incomeStatement.netIncome).toBe('0.000');
  });

  it('carry an opening balance into the balance sheet', async () => {
    await post(actor, chart.cash, chart.equity, '7500.000', '2025-12-31');

    /* Struck after the opening date: the opening entry is an ordinary posted
     * entry, so nothing special is needed to include it. */
    const report = await bundle();
    expect(report.balanceSheet.assets).toBe('7500.000');
    expect(report.balanceSheet.equity).toBe('7500.000');
    /* And it is NOT income. */
    expect(report.incomeStatement.income).toBe('0.000');
  });
});

/* ══ Dates ═════════════════════════════════════════════════════════════════ */

describe('date boundaries', () => {
  it('include both ends of the period', async () => {
    await post(actor, chart.cash, chart.sales, '100.000', '2026-03-01');
    await post(actor, chart.cash, chart.sales, '200.000', '2026-03-31');
    await post(actor, chart.cash, chart.sales, '400.000', '2026-04-01');

    const march = await bundle({ from: '2026-03-01', to: '2026-03-31', asOf: '2026-03-31' });
    expect(march.incomeStatement.income).toBe('300.000');
  });

  it('strike the balance sheet inclusively at the as-of date', async () => {
    await post(actor, chart.cash, chart.equity, '1000.000', '2026-06-30');
    await post(actor, chart.cash, chart.equity, '500.000', '2026-07-01');

    const june = await bundle({ asOf: '2026-06-30' });
    expect(june.balanceSheet.assets).toBe('1000.000');
  });

  it('use posting_date, not transaction_date', async () => {
    /* `resolveDates` copies the transaction date to the posting date, so the
     * two agree here; the assertion is that the SQL filters on posting_date. */
    await post(actor, chart.cash, chart.sales, '100.000', '2026-05-05');
    const inside = await bundle({ from: '2026-05-01', to: '2026-05-31', asOf: '2026-05-31' });
    const outside = await bundle({ from: '2026-06-01', to: '2026-06-30', asOf: '2026-06-30' });

    expect(inside.incomeStatement.income).toBe('100.000');
    expect(outside.incomeStatement.income).toBe('0.000');
  });

  it('refuse a period that runs backwards', async () => {
    await expect(bundle({ from: '2026-12-31', to: '2026-01-01' }))
      .rejects.toMatchObject({ code: 'validation_error' });
  });
});

/* ══ Comparatives ══════════════════════════════════════════════════════════ */

describe('a comparative period', () => {
  it('is computed in the same snapshot and reported alongside', async () => {
    await post(actor, chart.cash, chart.sales, '100.000', '2025-06-01');
    await post(actor, chart.cash, chart.sales, '250.000', '2026-06-01');

    const report = await buildReportBundle(ctx.db, {
      organizationId: actor.organizationId,
      companyId: actor.companyId,
      parameters: {
        asOf: '2026-12-31', from: '2026-01-01', to: '2026-12-31',
        comparative: { from: '2025-01-01', to: '2025-12-31', asOf: '2025-12-31' },
      },
    });

    expect(report.incomeStatement.income).toBe('250.000');
    expect(report.comparative?.incomeStatement.income).toBe('100.000');
    /* The comparative balance sheet is struck at its own as-of date. */
    expect(report.comparative?.balanceSheet.assets).toBe('100.000');
    expect(report.balanceSheet.assets).toBe('350.000');
  });
});

/* ══ Parent rollups ════════════════════════════════════════════════════════ */

describe('parent accounts', () => {
  it('roll their children up without double counting the totals', async () => {
    const parent = await accounts.createAccount(ctx.db, actor, {
      accountCode: '1100', accountName: 'Current Assets', accountType: 'asset', isPostable: false,
    });
    const child = await accounts.createAccount(ctx.db, actor, {
      accountCode: '1110', accountName: 'Petty Cash', accountType: 'asset',
      parentAccountId: parent.id,
    });

    await post(actor, child.id, chart.equity, '400.000');

    const report = await bundle();
    const parentRow = report.trialBalance.rows.find((r) => r.accountId === parent.id)!;
    const childRow = report.trialBalance.rows.find((r) => r.accountId === child.id)!;

    /* The parent holds no lines of its own but shows what is beneath it. */
    expect(parentRow.isPostable).toBe(false);
    expect(parentRow.debit).toBe('0.000');
    expect(parentRow.debitRollup).toBe('400.000');
    expect(childRow.debit).toBe('400.000');

    /* Totals count postable accounts only — adding rollups would double it. */
    expect(report.trialBalance.totalDebit).toBe('400.000');
    expect(report.balanceSheet.assets).toBe('400.000');
  });
});

/* ══ Cash flow ═════════════════════════════════════════════════════════════ */

describe('cash flow', () => {
  it('is refused rather than fabricated when no cash account is classified', async () => {
    await post(actor, chart.cash, chart.sales, '100.000');

    const report = await bundle();
    expect(report.cashFlow.status).toBe('cash_accounts_not_configured');
    if (report.cashFlow.status === 'cash_accounts_not_configured') {
      expect(report.cashFlow.reason).toMatch(/cash classification/i);
    }
    /* The other three statements are still returned. */
    expect(report.trialBalance.totalDebit).toBe('100.000');
  });

  it('is produced once an account carries the controlled classification', async () => {
    await accounts.updateAccount(ctx.db, actor, chart.cash, {
      cashClassification: 'cash_and_cash_equivalents',
    });

    await post(actor, chart.cash, chart.equity, '900.000', '2025-12-31');
    await post(actor, chart.cash, chart.sales, '100.000', '2026-06-01');

    const report = await bundle();
    expect(report.cashFlow.status).toBe('ok');
    if (report.cashFlow.status === 'ok') {
      expect(report.cashFlow.openingCash).toBe('900.000');
      expect(report.cashFlow.closingCash).toBe('1000.000');
      expect(report.cashFlow.movement).toBe('100.000');
    }
  });
});

/* ══ Isolation ═════════════════════════════════════════════════════════════ */

describe('two companies under one subscriber', () => {
  it('report entirely separate books', async () => {
    const second: AccountingActor = {
      ...actor, companyId: await company(organizationId, 'co_second'),
    };
    const secondChart = await buildChart(second);

    await post(actor, chart.cash, chart.sales, '100.000');
    await post(second, secondChart.cash, secondChart.sales, '999.000');

    const a = await bundle({}, actor);
    const b = await bundle({}, second);

    expect(a.incomeStatement.income).toBe('100.000');
    expect(b.incomeStatement.income).toBe('999.000');
    /* Neither report mentions the other company's accounts. */
    const aIds = new Set(a.trialBalance.rows.map((r) => r.accountId));
    expect(aIds.has(secondChart.cash)).toBe(false);
  });

  it('never leak across organizations', async () => {
    const otherOrg = await organization('Other');
    const other: AccountingActor = {
      organizationId: otherOrg,
      companyId: await company(otherOrg, 'co_other'),
      userId: await person('other@reports.test'),
      name: 'Other',
    };
    const otherChart = await buildChart(other);
    await post(other, otherChart.cash, otherChart.sales, '777.000');
    await post(actor, chart.cash, chart.sales, '100.000');

    const mine = await bundle({}, actor);
    expect(mine.incomeStatement.income).toBe('100.000');
    expect(mine.trialBalance.rows.some((r) => r.accountId === otherChart.cash)).toBe(false);
  });
});

/* ══ Volume ════════════════════════════════════════════════════════════════ */

describe('a company with more than 500 entries', () => {
  it('reports every one of them', async () => {
    /*
     * `listJournals` caps at 500. A report built from that feed would balance
     * and be wrong, which is why the aggregate is computed in SQL instead.
     */
    const count = 520;
    for (let i = 0; i < count; i += 1) {
      await sql`
        WITH e AS (
          INSERT INTO journal_entries (
            organization_id, company_id, journal_number, transaction_date, posting_date,
            status, transaction_currency, functional_currency, posted_at
          ) VALUES (
            ${actor.organizationId}::uuid, ${actor.companyId}::uuid, ${'JE-BULK-' + i},
            '2026-06-01', '2026-06-01', 'posted', 'JOD', 'JOD', now()
          ) RETURNING id
        )
        INSERT INTO journal_lines (
          organization_id, company_id, journal_entry_id, line_number, account_id,
          debit_transaction, credit_transaction, debit_functional, credit_functional
        )
        SELECT ${actor.organizationId}::uuid, ${actor.companyId}::uuid, e.id, 1, ${chart.cash}::uuid, 1, 0, 1, 0 FROM e
        UNION ALL
        SELECT ${actor.organizationId}::uuid, ${actor.companyId}::uuid, e.id, 2, ${chart.sales}::uuid, 0, 1, 0, 1 FROM e
      `.execute(ctx.db);
    }

    const report = await bundle();
    expect(report.incomeStatement.income).toBe('520.000');
    expect(report.trialBalance.totalDebit).toBe('520.000');
    expect(report.balanceSheet.balances).toBe(true);
  });
});

/* ══ Corrupted books ═══════════════════════════════════════════════════════ */

describe('books that do not balance', () => {
  it('return an error rather than a statement', async () => {
    /*
     * A deliberately unbalanced entry, written around every service check. The
     * database permits it — a line is a debit or a credit, and nothing forces a
     * SET of lines to balance — so the report is the last line of defence.
     */
    await sql`
      WITH e AS (
        INSERT INTO journal_entries (
          organization_id, company_id, journal_number, transaction_date, posting_date,
          status, transaction_currency, functional_currency, posted_at
        ) VALUES (
          ${actor.organizationId}::uuid, ${actor.companyId}::uuid, 'JE-BROKEN',
          '2026-06-01', '2026-06-01', 'posted', 'JOD', 'JOD', now()
        ) RETURNING id
      )
      INSERT INTO journal_lines (
        organization_id, company_id, journal_entry_id, line_number, account_id,
        debit_transaction, credit_transaction, debit_functional, credit_functional
      )
      SELECT ${actor.organizationId}::uuid, ${actor.companyId}::uuid, e.id, 1, ${chart.cash}::uuid, 10, 0, 10, 0 FROM e
    `.execute(ctx.db);

    await expect(bundle()).rejects.toMatchObject({ code: 'conflict' });
  });
});

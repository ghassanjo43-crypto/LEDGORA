/**
 * The bound ledger, and the per-account summaries the collapsed view reads.
 *
 * ══ The two claims ═══════════════════════════════════════════════════════════
 *
 * A collapsed multi-account row shows an opening balance, period turnover and a
 * closing balance. If those were summed in the browser from the lines it
 * happened to hold, an opening balance would depend on what had been loaded —
 * so they come from the bundle, and they must equal what the DETAILED ledger
 * says for the same account and period. A summary that disagreed with the
 * ledger it opens into would make the reader distrust both.
 *
 * And an export must be COMPLETE and ORDERED. A bound ledger assembled from one
 * request per account is a set of pages that were never simultaneously true;
 * one that reshuffles between exports cannot be diffed, which is most of what
 * anybody does with one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, type TestContext } from './helpers/testApp.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as journals from '../src/services/accounting/journalService.js';
import { readLedgerPage, exportGroupedLedger } from '../src/services/accounting/ledgerService.js';
import { buildReportBundle } from '../src/services/accounting/reportService.js';

let ctx: TestContext;
let actor: AccountingActor;
let chart: { cash: string; sales: string; equity: string };

const RANGE = { from: '2026-01-01', to: '2026-12-31' };

async function organization(name: string): Promise<string> {
  const owner = await seedUser(ctx, { email: `owner-${name.toLowerCase()}@grouped.test` });
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
    VALUES (${email}, ${email}, 'Grouped Reader', 'x', 'active', now()) RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

async function buildChart(a: AccountingActor) {
  const make = async (code: string, name: string, type: 'asset' | 'income' | 'equity') =>
    (await accounts.createAccount(ctx.db, a, {
      accountCode: code, accountName: name, accountType: type,
    })).id;
  return {
    cash: await make('1000', 'Cash', 'asset'),
    sales: await make('4000', 'Sales', 'income'),
    equity: await make('3000', 'Opening Equity', 'equity'),
  };
}

async function post(amount: string, date: string, a = actor, credit = chart.sales) {
  const draft = await journals.createDraft(ctx.db, a, {
    transactionDate: date,
    description: `Posting ${amount}`,
    lines: [{ accountId: chart.cash, debit: amount }, { accountId: credit, credit: amount }],
  });
  return journals.postJournal(ctx.db, a, draft.id, { expectedVersion: draft.version });
}

const scope = () => ({ organizationId: actor.organizationId, companyId: actor.companyId });

const grouped = (over: Record<string, unknown> = {}) =>
  exportGroupedLedger(ctx.db, scope(), { ...RANGE, ...over });

const bundle = () => buildReportBundle(ctx.db, {
  organizationId: actor.organizationId,
  companyId: actor.companyId,
  parameters: { asOf: RANGE.to, from: RANGE.from, to: RANGE.to, comparative: null },
});

beforeEach(async () => {
  ctx = await createTestContext();
  const organizationId = await organization('Grouped');
  actor = {
    organizationId,
    companyId: await company(organizationId, 'co_grouped'),
    userId: await person('reader@grouped.test'),
    name: 'Grouped Reader',
  };
  chart = await buildChart(actor);
});
afterEach(async () => { await ctx.close(); });

/* ══ The bundle's per-account summaries ════════════════════════════════════ */

describe('the ledger summaries in the report bundle', () => {
  it('states opening, turnover and closing per posting account', async () => {
    await post('900.000', '2025-12-31');
    await post('100.000', '2026-06-01');

    const summaries = (await bundle()).accountLedgers;
    const cash = summaries.find((row) => row.accountCode === '1000')!;

    expect(cash.openingBalance).toBe('900.000');
    expect(cash.periodDebit).toBe('100.000');
    expect(cash.periodCredit).toBe('0.000');
    expect(cash.netMovement).toBe('100.000');
    expect(cash.closingBalance).toBe('1000.000');
    expect(cash.lineCount).toBe(1);
    expect(cash.normalBalance).toBe('debit');
  });

  it('AGREES with the detailed ledger it opens into', async () => {
    await post('250.000', '2025-11-30');
    for (const day of ['01', '02', '03']) await post('10.000', `2026-06-${day}`);

    const summary = (await bundle()).accountLedgers.find((row) => row.accountCode === '1000')!;
    const detail = await readLedgerPage(ctx.db, scope(), { accountId: chart.cash, ...RANGE });

    /* The figure on the collapsed row and the figure on the opened ledger are
     * the same figure, or the reader has no reason to trust either. */
    expect(summary.openingBalance).toBe(detail.openingBalance);
    expect(summary.periodDebit).toBe(detail.totals.debit);
    expect(summary.periodCredit).toBe(detail.totals.credit);
    expect(summary.netMovement).toBe(detail.totals.movement);
    expect(summary.closingBalance).toBe(detail.totals.closingBalance);
    expect(summary.lineCount).toBe(detail.totals.lineCount);
  });

  it('lists only POSTING accounts, in account-code order', async () => {
    await post('10.000', '2026-06-01');

    const summaries = (await bundle()).accountLedgers;

    /* A parent holds no lines; listing one beside its children would show the
     * same money twice. */
    expect(summaries.every((row) => row.accountCode.length > 0)).toBe(true);
    const codes = summaries.map((row) => row.accountCode);
    expect([...codes].sort()).toEqual(codes);
  });

  it('counts a reversal exactly as the ledger does', async () => {
    const original = await post('1000.000', '2026-06-01');
    await journals.reverseJournal(ctx.db, actor, original.id, {
      expectedVersion: original.version, reason: 'Wrong amount',
    });

    const summary = (await bundle()).accountLedgers.find((row) => row.accountCode === '1000')!;
    const detail = await readLedgerPage(ctx.db, scope(), { accountId: chart.cash, ...RANGE });

    expect(summary.closingBalance).toBe('0.000');
    expect(summary.closingBalance).toBe(detail.totals.closingBalance);
    expect(summary.lineCount).toBe(2);
  });
});

/* ══ The bound ledger export ═══════════════════════════════════════════════ */

describe('the grouped ledger export', () => {
  it('returns every account and every line, in ONE snapshot', async () => {
    for (const day of ['01', '02', '03']) await post('10.000', `2026-06-${day}`);

    const result = await grouped();

    expect(result.complete).toBe(true);
    expect(result.snapshot.at).toBeTruthy();
    expect(result.snapshot.currency).toBe('JOD');
    /* Cash and Sales were both posted to; Opening Equity was not. */
    const codes = result.accounts.map((a) => a.accountCode);
    expect(codes).toContain('1000');
    expect(codes).toContain('4000');
    expect(codes).not.toContain('3000');

    const cash = result.accounts.find((a) => a.accountCode === '1000')!;
    expect(cash.lines).toHaveLength(3);
    expect(result.totals.lineCount).toBe(6);
  });

  it('orders accounts by code and lines by the ledger ordering, deterministically', async () => {
    /* Several lines on ONE day, so the date alone cannot order them. */
    for (let i = 0; i < 6; i += 1) await post('1.000', '2026-06-01');

    const first = await grouped();
    const second = await grouped();

    const shape = (result: Awaited<ReturnType<typeof grouped>>) =>
      result.accounts.map((a) => [a.accountCode, ...a.lines.map((l) => l.lineId)]);

    /* Two exports of unchanged books are identical, which is what makes a bound
     * ledger diffable. */
    expect(shape(second)).toEqual(shape(first));
    expect(first.accounts.map((a) => a.accountCode))
      .toEqual([...first.accounts.map((a) => a.accountCode)].sort());
  });

  it('carries a running balance that starts from each account’s own opening', async () => {
    await post('50.000', '2025-12-31');
    for (const day of ['01', '02']) await post('10.000', `2026-06-${day}`);

    const cash = (await grouped()).accounts.find((a) => a.accountCode === '1000')!;

    expect(cash.openingBalance).toBe('50.000');
    /* Continued from the opening, not restarted at zero, and not continued
     * across the account boundary from the previous account. */
    expect(cash.lines.map((l) => l.runningBalance)).toEqual(['60.000', '70.000']);
    expect(cash.totals.closingBalance).toBe('70.000');
  });

  it('agrees with the detailed ledger, account by account', async () => {
    await post('120.000', '2025-10-01');
    for (const day of ['05', '06', '07']) await post('3.000', `2026-04-${day}`);

    const exported = (await grouped()).accounts.find((a) => a.accountCode === '1000')!;
    const detail = await readLedgerPage(ctx.db, scope(), { accountId: chart.cash, ...RANGE });

    expect(exported.openingBalance).toBe(detail.openingBalance);
    expect(exported.totals.debit).toBe(detail.totals.debit);
    expect(exported.totals.closingBalance).toBe(detail.totals.closingBalance);
    expect(exported.lines.map((l) => l.lineId)).toEqual(detail.lines.map((l) => l.lineId));
  });

  it('omits a dormant account unless asked for it', async () => {
    await post('10.000', '2026-06-01');

    const lean = await grouped();
    const full = await grouped({ includeZero: true });

    expect(lean.accounts.map((a) => a.accountCode)).not.toContain('3000');
    expect(full.accounts.map((a) => a.accountCode)).toContain('3000');
    /* Including it adds no lines: it is listed, not invented. */
    expect(full.accounts.find((a) => a.accountCode === '3000')!.lines).toHaveLength(0);
  });

  it('keeps an account with an opening balance but no activity', async () => {
    /* Posted before the period: no lines in range, but a real opening balance.
     * Dropping it would lose money from the bound ledger. */
    await post('75.000', '2025-06-01');

    const cash = (await grouped()).accounts.find((a) => a.accountCode === '1000')!;
    expect(cash.openingBalance).toBe('75.000');
    expect(cash.lines).toHaveLength(0);
    expect(cash.totals.closingBalance).toBe('75.000');
  });

  it('validates the period', async () => {
    await expect(grouped({ from: 'not-a-date' })).rejects.toThrow(/calendar date/i);
    await expect(grouped({ from: '2026-12-31', to: '2026-01-01' }))
      .rejects.toThrow(/cannot end before it starts/i);
  });
});

/* ══ Isolation ═════════════════════════════════════════════════════════════ */

describe('grouped export scoping', () => {
  it('does not carry a sibling company’s ledger', async () => {
    await post('100.000', '2026-06-01');

    const second: AccountingActor = {
      ...actor, companyId: await company(actor.organizationId, 'co_grouped_two'),
    };
    const secondChart = await buildChart(second);
    const draft = await journals.createDraft(ctx.db, second, {
      transactionDate: '2026-06-01', description: 'Other company',
      lines: [
        { accountId: secondChart.cash, debit: '999.000' },
        { accountId: secondChart.sales, credit: '999.000' },
      ],
    });
    await journals.postJournal(ctx.db, second, draft.id, { expectedVersion: draft.version });

    const mine = await grouped();
    const theirs = await exportGroupedLedger(ctx.db,
      { organizationId: second.organizationId, companyId: second.companyId }, RANGE);

    expect(mine.accounts.find((a) => a.accountCode === '1000')!.totals.closingBalance).toBe('100.000');
    expect(theirs.accounts.find((a) => a.accountCode === '1000')!.totals.closingBalance).toBe('999.000');
    /* No line from one set of books appears in the other. */
    const mineIds = new Set(mine.accounts.flatMap((a) => a.lines.map((l) => l.lineId)));
    const theirIds = theirs.accounts.flatMap((a) => a.lines.map((l) => l.lineId));
    expect(theirIds.some((id) => mineIds.has(id))).toBe(false);
  });

  it('answers another organization’s books as empty rather than leaking them', async () => {
    await post('100.000', '2026-06-01');

    const otherOrg = await organization('Globex');
    const otherCompany = await company(otherOrg, 'co_globex');

    const result = await exportGroupedLedger(ctx.db,
      { organizationId: otherOrg, companyId: otherCompany }, RANGE);

    expect(result.accounts).toHaveLength(0);
    expect(result.totals.lineCount).toBe(0);
  });
});

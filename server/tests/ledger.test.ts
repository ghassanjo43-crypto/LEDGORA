/**
 * The general ledger: one account, paged, with totals PostgreSQL computed.
 *
 * ══ The two claims that matter ═══════════════════════════════════════════════
 *
 * Totals and the closing balance must not depend on which pages were fetched.
 * A closing balance that grew as somebody scrolled would be the most quietly
 * wrong thing a ledger could do — every figure on screen individually correct,
 * and the one at the bottom a function of how far the reader had got.
 *
 * And keyset pagination must not duplicate or omit. Offset pagination has
 * exactly the opposite property under concurrent inserts, which is why it is
 * not used; that this one behaves under a genuinely concurrent posting can only
 * be shown against a real server, and is proved in the P5 ledger probe.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, type TestContext } from './helpers/testApp.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as journals from '../src/services/accounting/journalService.js';
import * as source from '../src/services/accounting/sourcePostingService.js';
import { readLedgerPage } from '../src/services/accounting/ledgerService.js';

let ctx: TestContext;
let actor: AccountingActor;
let chart: { cash: string; sales: string; equity: string };

async function organization(name: string): Promise<string> {
  const owner = await seedUser(ctx, { email: `owner-${name.toLowerCase()}@ledger.test` });
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
    VALUES (${email}, ${email}, 'Ledger Reader', 'x', 'active', now()) RETURNING id
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

const RANGE = { from: '2026-01-01', to: '2026-12-31' };
const page = (over: Record<string, unknown> = {}) =>
  readLedgerPage(ctx.db, { organizationId: actor.organizationId, companyId: actor.companyId },
    { accountId: chart.cash, ...RANGE, ...over });

beforeEach(async () => {
  ctx = await createTestContext();
  const organizationId = await organization('Ledger');
  actor = {
    organizationId,
    companyId: await company(organizationId, 'co_ledger'),
    userId: await person('reader@ledger.test'),
    name: 'Ledger Reader',
  };
  chart = await buildChart(actor);
});
afterEach(async () => { await ctx.close(); });

/* ══ Opening, totals, closing ══════════════════════════════════════════════ */

describe('the figures PostgreSQL computes', () => {
  it('strikes the opening balance strictly BEFORE the period', async () => {
    await post('900.000', '2025-12-31');
    await post('100.000', '2026-06-01');

    const result = await page();

    /* Not derived by subtracting the period from a cumulative figure — that is
     * only right when the range ends where the cumulative was taken. */
    expect(result.openingBalance).toBe('900.000');
    expect(result.totals.debit).toBe('100.000');
    expect(result.totals.closingBalance).toBe('1000.000');
    expect(result.lines).toHaveLength(1);
  });

  it('keeps totals and closing balance IDENTICAL across every page', async () => {
    for (let i = 1; i <= 12; i += 1) {
      await post('10.000', `2026-0${Math.min(i, 9)}-0${(i % 9) + 1}`);
    }

    const first = await page({ limit: 5 });
    const second = await page({ limit: 5, cursor: first.nextCursor });
    const third = await page({ limit: 5, cursor: second.nextCursor });

    for (const result of [first, second, third]) {
      /* The figure at the bottom of the screen must not be a function of how
       * far the reader scrolled. */
      expect(result.totals.debit).toBe('120.000');
      expect(result.totals.closingBalance).toBe('120.000');
      expect(result.totals.lineCount).toBe(12);
      expect(result.openingBalance).toBe('0.000');
    }
  });

  it('carries the running balance across page boundaries', async () => {
    await post('50.000', '2025-12-31');
    for (const day of ['01', '02', '03', '04']) await post('10.000', `2026-06-${day}`);

    const first = await page({ limit: 2 });
    const second = await page({ limit: 2, cursor: first.nextCursor });

    /* Opening 50 then +10 each. Restarting the running balance at each page
     * would show 10, 20 again on the second page. */
    expect(first.lines.map((l) => l.runningBalance)).toEqual(['60.000', '70.000']);
    expect(second.lines.map((l) => l.runningBalance)).toEqual(['80.000', '90.000']);
  });

  it('holds three-decimal values exactly', async () => {
    await post('0.001', '2026-06-01');
    await post('0.002', '2026-06-02');

    const result = await page();

    expect(result.totals.debit).toBe('0.003');
    expect(result.totals.closingBalance).toBe('0.003');
    expect(result.lines.map((l) => l.debit)).toEqual(['0.001', '0.002']);
  });
});

/* ══ Pagination ════════════════════════════════════════════════════════════ */

describe('keyset pagination', () => {
  it('walks every line exactly once, with no duplicates and no omissions', async () => {
    for (let i = 0; i < 25; i += 1) {
      const day = String((i % 28) + 1).padStart(2, '0');
      await post('1.000', `2026-03-${day}`);
    }

    const seen: string[] = [];
    let cursor: string | null | undefined = null;
    let guard = 0;
    do {
      const result: Awaited<ReturnType<typeof page>> = await page({ limit: 7, cursor });
      seen.push(...result.lines.map((l) => l.lineId));
      cursor = result.nextCursor;
      guard += 1;
    } while (cursor && guard < 20);

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it('is deterministic when many lines share a posting date', async () => {
    /* The date alone is not a total order, and neither is date + number once an
     * entry has several lines on one account. The last key is the line id. */
    for (let i = 0; i < 9; i += 1) await post('1.000', '2026-06-01');

    const runA: string[] = [];
    const runB: string[] = [];
    for (const into of [runA, runB]) {
      let cursor: string | null | undefined = null;
      do {
        const result: Awaited<ReturnType<typeof page>> = await page({ limit: 4, cursor });
        into.push(...result.lines.map((l) => l.lineId));
        cursor = result.nextCursor;
      } while (cursor);
    }
    expect(runA).toEqual(runB);
    expect(runA).toHaveLength(9);
  });

  it('reports no next cursor on the last page', async () => {
    await post('1.000', '2026-06-01');
    const result = await page({ limit: 50 });
    expect(result.nextCursor).toBeNull();
  });

  it('refuses a cursor it did not produce', async () => {
    await expect(page({ cursor: 'not-a-real-cursor' })).rejects.toThrow(/page reference is not valid/i);
  });

  it('caps an oversized page request', async () => {
    for (let i = 0; i < 3; i += 1) await post('1.000', '2026-06-01');
    const result = await page({ limit: 100000 });
    expect(result.lines.length).toBeLessThanOrEqual(500);
  });
});

/* ══ Which entries count ═══════════════════════════════════════════════════ */

describe('what appears in the ledger', () => {
  it('shows a reversed original AND its mirror, netting to zero', async () => {
    const original = await post('1000.000', '2026-06-01');
    await journals.reverseJournal(ctx.db, actor, original.id, {
      expectedVersion: original.version, reason: 'Wrong amount',
    });

    const result = await page();

    /* Both remain. Excluding the reversed original would show the NEGATIVE of
     * the transaction — the same rule the report bundle is built on. */
    expect(result.lines).toHaveLength(2);
    expect(result.totals.closingBalance).toBe('0.000');
    expect(result.lines.map((l) => l.status).sort()).toEqual(['posted', 'reversed']);
  });

  it('excludes a draft', async () => {
    await journals.createDraft(ctx.db, actor, {
      transactionDate: '2026-06-01',
      description: 'Never posted',
      lines: [
        { accountId: chart.cash, debit: '500.000' },
        { accountId: chart.sales, credit: '500.000' },
      ],
    });

    const result = await page();
    expect(result.lines).toHaveLength(0);
    expect(result.totals.closingBalance).toBe('0.000');
  });

  it('respects the inclusive date boundaries', async () => {
    await post('1.000', '2025-12-31');
    await post('2.000', '2026-01-01');
    await post('4.000', '2026-12-31');
    await post('8.000', '2027-01-01');

    const result = await page();

    /* Both ends inclusive; the earlier posting is opening, the later is out. */
    expect(result.openingBalance).toBe('1.000');
    expect(result.totals.debit).toBe('6.000');
    expect(result.lines).toHaveLength(2);
  });

  it('carries the source identity for the drill-down', async () => {
    await source.postSourceJournal(ctx.db, actor, {
      sourceType: 'inventory_document', sourceId: 'inv_1', sourceEvent: 'post',
      transactionDate: '2026-06-01', reference: 'GRN-1', description: 'Goods received',
      lines: [
        { accountId: chart.cash, debit: '30.000' },
        { accountId: chart.sales, credit: '30.000' },
      ],
    });

    const [line] = (await page()).lines;

    expect(line!.sourceType).toBe('inventory_document');
    expect(line!.sourceId).toBe('inv_1');
    expect(line!.sourceEvent).toBe('post');
    /* And the journal itself, so a row can open the entry that made it. */
    expect(line!.journalId).toBeTruthy();
    expect(line!.journalNumber).toMatch(/^JE-/);
  });
});

/* ══ Isolation ═════════════════════════════════════════════════════════════ */

describe('scoping', () => {
  it('refuses another company’s account', async () => {
    const otherCompanyId = await company(actor.organizationId, 'co_ledger_two');

    await expect(readLedgerPage(ctx.db,
      { organizationId: actor.organizationId, companyId: otherCompanyId },
      { accountId: chart.cash, ...RANGE })).rejects.toThrow(/not found/i);
  });

  it('refuses another organization’s account', async () => {
    const otherOrg = await organization('Globex');
    const otherCompany = await company(otherOrg, 'co_globex');

    await expect(readLedgerPage(ctx.db,
      { organizationId: otherOrg, companyId: otherCompany },
      { accountId: chart.cash, ...RANGE })).rejects.toThrow(/not found/i);
  });

  it('does not count a sibling company’s postings', async () => {
    await post('100.000', '2026-06-01');

    const second: AccountingActor = {
      ...actor, companyId: await company(actor.organizationId, 'co_ledger_three'),
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

    const mine = await page();
    const theirs = await readLedgerPage(ctx.db,
      { organizationId: second.organizationId, companyId: second.companyId },
      { accountId: secondChart.cash, ...RANGE });

    expect(mine.totals.closingBalance).toBe('100.000');
    expect(theirs.totals.closingBalance).toBe('999.000');
  });

  it('validates the period', async () => {
    await expect(page({ from: 'not-a-date' })).rejects.toThrow(/calendar date/i);
    await expect(page({ from: '2026-12-31', to: '2026-01-01' }))
      .rejects.toThrow(/cannot end before it starts/i);
  });
});

/* ══ The watermark ═════════════════════════════════════════════════════════ */

describe('the change watermark', () => {
  it('is stable while nothing changes', async () => {
    await post('10.000', '2026-06-01');
    const first = await page();
    const second = await page();
    expect(second.watermark).toBe(first.watermark);
  });

  it('CHANGES when a backdated entry is posted mid-browse', async () => {
    await post('10.000', '2026-06-10');
    await post('10.000', '2026-06-11');
    const first = await page({ limit: 1 });

    /* The case keyset pagination cannot cover: this sorts BEFORE the cursor and
     * will not be seen for the rest of the run. The watermark is how the reader
     * finds out, rather than being handed a mixture and left to wonder. */
    await post('99.000', '2026-06-01');

    const second = await page({ limit: 1, cursor: first.nextCursor });
    expect(second.watermark).not.toBe(first.watermark);
    /* And the totals on that later page are already current. */
    expect(second.totals.debit).toBe('119.000');
  });
});

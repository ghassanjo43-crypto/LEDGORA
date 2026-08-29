/**
 * The chart of accounts as an AUTHORITATIVE record.
 *
 * ══ What is being proved ═════════════════════════════════════════════════════
 *
 * Two properties, and they fail in opposite directions.
 *
 * The first is that a cash classification is CONTROLLED. The browser decided
 * which accounts were cash by matching a regular expression against a free-text
 * subcategory, and the first version of `reportService` inherited that shape by
 * comparing an exact subtype string. Both mean renaming a label silently
 * changes a cash-flow statement. So the tests here refuse an invented value, a
 * value that contradicts the account type, and a value on a header account —
 * and they check the refusal happens in the SERVICE, with a sentence a
 * bookkeeper can act on, rather than surfacing as a constraint name.
 *
 * The second is that the chart SURVIVES a round trip. An account created as a
 * finance cost must not come back as a plain expense: the ledger has five
 * account types and the chart of accounts screen has twelve presentation
 * classes, and flattening the second into the first is not a display detail. A
 * chart that changes shape when it is reloaded is not authoritative, whatever
 * it is stored in.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, type TestContext } from './helpers/testApp.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as journals from '../src/services/accounting/journalService.js';
import { buildReportBundle } from '../src/services/accounting/reportService.js';

let ctx: TestContext;
let actor: AccountingActor;

async function organization(name: string): Promise<string> {
  const owner = await seedUser(ctx, { email: `owner-${name.toLowerCase()}@chart.test` });
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
    VALUES (${email}, ${email}, 'Chart Keeper', 'x', 'active', now()) RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

const make = (input: Partial<accounts.CreateAccountInput> & { accountCode: string }) =>
  accounts.createAccount(ctx.db, actor, {
    accountName: `Account ${input.accountCode}`,
    accountType: 'asset',
    ...input,
  });

beforeEach(async () => {
  ctx = await createTestContext();
  const organizationId = await organization('Chart');
  actor = {
    organizationId,
    companyId: await company(organizationId, 'co_chart'),
    userId: await person('keeper@chart.test'),
    name: 'Chart Keeper',
  };
});
afterEach(async () => { await ctx.close(); });

/* ══ The controlled cash vocabulary ════════════════════════════════════════ */

describe('cash classification', () => {
  it('defaults to none, so nothing is cash until somebody says so', async () => {
    const account = await make({ accountCode: '1000', accountName: 'Cash' });
    expect(account.cashClassification).toBe('none');
  });

  it('accepts each value the domain has', async () => {
    const cash = await make({ accountCode: '1000', cashClassification: 'cash_and_cash_equivalents' });
    const restricted = await make({ accountCode: '1010', cashClassification: 'restricted_cash' });
    const overdraft = await make({
      accountCode: '2000', accountType: 'liability', cashClassification: 'bank_overdraft',
    });

    expect(cash.cashClassification).toBe('cash_and_cash_equivalents');
    expect(restricted.cashClassification).toBe('restricted_cash');
    expect(overdraft.cashClassification).toBe('bank_overdraft');
  });

  it('rejects a value that is not in the vocabulary', async () => {
    await expect(make({ accountCode: '1000', cashClassification: 'petty_cash' }))
      .rejects.toThrow(/not a recognised cash classification/i);
  });

  it('rejects a near-miss spelling rather than interpreting it', async () => {
    /* The exact failure the free-text subtype allowed: close enough to look
     * right on a screen, and silently NOT cash to every report. */
    await expect(make({ accountCode: '1000', cashClassification: 'Cash and Cash Equivalents' }))
      .rejects.toThrow(/not a recognised cash classification/i);
  });

  it('refuses cash on an account that is not an asset', async () => {
    await expect(make({
      accountCode: '5000', accountType: 'expense', cashClassification: 'cash_and_cash_equivalents',
    })).rejects.toThrow(/must be an asset/i);
  });

  it('refuses an overdraft that is not a liability', async () => {
    await expect(make({ accountCode: '1000', cashClassification: 'bank_overdraft' }))
      .rejects.toThrow(/must be a liability/i);
  });

  it('refuses cash on a header account, which would double-count its children', async () => {
    await expect(make({
      accountCode: '1000', isPostable: false, cashClassification: 'cash_and_cash_equivalents',
    })).rejects.toThrow(/posting account/i);
  });

  it('refuses a type change that would leave the classification contradicting the account', async () => {
    const account = await make({ accountCode: '1000', cashClassification: 'cash_and_cash_equivalents' });

    /*
     * The patch alone looks harmless — it says nothing about cash. Only the
     * MERGED state shows the account would become an expense still classified
     * as cash, which is why the rule is checked against what the account will
     * be rather than against what was sent.
     */
    await expect(accounts.updateAccount(ctx.db, actor, account.id, { accountType: 'expense' }))
      .rejects.toThrow(/must be an asset/i);
  });

  it('refuses turning a classified cash account into a header', async () => {
    const account = await make({ accountCode: '1000', cashClassification: 'cash_and_cash_equivalents' });
    await expect(accounts.updateAccount(ctx.db, actor, account.id, { isPostable: false }))
      .rejects.toThrow(/posting account/i);
  });

  it('allows the type change once the classification is cleared in the same request', async () => {
    const account = await make({ accountCode: '1000', cashClassification: 'cash_and_cash_equivalents' });
    const updated = await accounts.updateAccount(ctx.db, actor, account.id, {
      accountType: 'expense', cashClassification: 'none',
    });
    expect(updated.accountType).toBe('expense');
    expect(updated.cashClassification).toBe('none');
  });

  it('is refused by the DATABASE too, not only by the service', async () => {
    const account = await make({ accountCode: '1000' });
    /*
     * The service is the readable refusal; the CHECK is the one that still holds
     * when a future query forgets to ask. Written directly against the table so
     * the constraint is what answers.
     */
    await expect(
      sql`UPDATE accounts SET cash_classification = 'imaginary' WHERE id = ${account.id}`.execute(ctx.db),
    ).rejects.toThrow();

    await expect(
      sql`UPDATE accounts SET cash_classification = 'cash_and_cash_equivalents', account_type = 'expense'
          WHERE id = ${account.id}`.execute(ctx.db),
    ).rejects.toThrow();
  });
});

/* ══ What the classification is FOR ════════════════════════════════════════ */

describe('the cash figure', () => {
  const WINDOW = { asOf: '2026-12-31', from: '2026-01-01', to: '2026-12-31', comparative: null };
  const bundle = () => buildReportBundle(ctx.db, {
    organizationId: actor.organizationId, companyId: actor.companyId, parameters: WINDOW,
  });

  /** `make` returns the whole record; the journal wants ids. */
  const id = async (input: Parameters<typeof make>[0]) => (await make(input)).id;

  async function post(debit: string, credit: string, amount: string, date = '2026-06-01') {
    const draft = await journals.createDraft(ctx.db, actor, {
      transactionDate: date,
      description: 'Cash test',
      lines: [{ accountId: debit, debit: amount }, { accountId: credit, credit: amount }],
    });
    return journals.postJournal(ctx.db, actor, draft.id, { expectedVersion: draft.version });
  }

  it('is unavailable while nothing is classified, however the accounts are named', async () => {
    /* A name that the browser's regular expression would have matched. */
    const cash = await id({ accountCode: '1000', accountName: 'Cash and cash equivalents' });
    const equity = await id({ accountCode: '3000', accountType: 'equity' });
    await post(cash, equity, '100.000');

    const report = await bundle();
    expect(report.cashFlow.status).toBe('cash_accounts_not_configured');
  });

  it('counts a classified cash account', async () => {
    const cash = await id({ accountCode: '1000', cashClassification: 'cash_and_cash_equivalents' });
    const equity = await id({ accountCode: '3000', accountType: 'equity' });
    await post(cash, equity, '900.000', '2025-12-31');
    await post(cash, equity, '100.000', '2026-06-01');

    const report = await bundle();
    expect(report.cashFlow.status).toBe('ok');
    if (report.cashFlow.status === 'ok') {
      expect(report.cashFlow.openingCash).toBe('900.000');
      expect(report.cashFlow.movement).toBe('100.000');
      expect(report.cashFlow.closingCash).toBe('1000.000');
    }
  });

  it('subtracts an overdraft, which IAS 7 counts as negative cash', async () => {
    const cash = await id({ accountCode: '1000', cashClassification: 'cash_and_cash_equivalents' });
    const overdraft = await id({
      accountCode: '2000', accountType: 'liability', cashClassification: 'bank_overdraft',
    });
    const equity = await id({ accountCode: '3000', accountType: 'equity' });

    await post(cash, equity, '1000.000');
    /* Drawing on the overdraft: cash up 300, overdraft liability up 300. */
    await post(cash, overdraft, '300.000');

    const report = await bundle();
    expect(report.cashFlow.status).toBe('ok');
    if (report.cashFlow.status === 'ok') {
      /* 1300 of bank balance less the 300 owed on the overdraft. */
      expect(report.cashFlow.closingCash).toBe('1000.000');
    }
  });

  it('EXCLUDES restricted cash, which is the reason that value exists', async () => {
    const cash = await id({ accountCode: '1000', cashClassification: 'cash_and_cash_equivalents' });
    const restricted = await id({ accountCode: '1010', cashClassification: 'restricted_cash' });
    const equity = await id({ accountCode: '3000', accountType: 'equity' });

    await post(cash, equity, '400.000');
    await post(restricted, equity, '600.000');

    const report = await bundle();
    expect(report.cashFlow.status).toBe('ok');
    if (report.cashFlow.status === 'ok') {
      /* The restricted 600 is cash the entity cannot use, so it is not counted. */
      expect(report.cashFlow.closingCash).toBe('400.000');
    }
    /* It is still an asset on the balance sheet — excluded from cash, not lost. */
    expect(report.balanceSheet.assets).toBe('1000.000');
  });
});

/* ══ The chart survives a round trip ═══════════════════════════════════════ */

describe('presentation classification', () => {
  it('keeps the finer class the ledger has no room for', async () => {
    const account = await make({
      accountCode: '6100',
      accountName: 'Interest payable to the bank',
      accountType: 'expense',
      presentationType: 'FINANCE',
      ifrsStatement: 'PROFIT_OR_LOSS',
      ifrsCategory: 'Finance costs',
      ifrsSubcategory: 'Interest expense',
      cashFlowCategory: 'FINANCING',
      profitOrLossCategory: 'FINANCING',
      description: 'Interest on the overdraft facility',
      industryTag: 'general',
    });

    const [reloaded] = await accounts.listAccounts(ctx.db, actor);

    /* The ledger type is still one of the five it has to be… */
    expect(reloaded!.accountType).toBe('expense');
    /* …and the chart of accounts still knows it is a finance cost. */
    expect(reloaded!.presentationType).toBe('FINANCE');
    expect(reloaded!.ifrsStatement).toBe('PROFIT_OR_LOSS');
    expect(reloaded!.ifrsCategory).toBe('Finance costs');
    expect(reloaded!.ifrsSubcategory).toBe('Interest expense');
    expect(reloaded!.cashFlowCategory).toBe('FINANCING');
    expect(reloaded!.profitOrLossCategory).toBe('FINANCING');
    expect(reloaded!.description).toBe('Interest on the overdraft facility');
    expect(reloaded!.industryTag).toBe('general');
    expect(account.id).toBe(reloaded!.id);
  });

  it('rejects a presentation class that is not in the vocabulary', async () => {
    await expect(make({ accountCode: '6100', presentationType: 'FINANCE_COSTS' }))
      .rejects.toThrow(/not a recognised account presentation type/i);
  });

  it('rejects an unknown IFRS statement and cash-flow category', async () => {
    await expect(make({ accountCode: '6100', ifrsStatement: 'INCOME_STATEMENT' }))
      .rejects.toThrow(/not a recognised IFRS statement/i);
    await expect(make({ accountCode: '6101', cashFlowCategory: 'OPERATIONS' }))
      .rejects.toThrow(/not a recognised cash-flow category/i);
  });

  it('refuses a presentation class that contradicts the ledger type', async () => {
    /*
     * A finance cost is an expense to the ledger. Stored against an asset it
     * would appear under expenses on the screen and on the opposite side of
     * the balance sheet, which is worse than either alone.
     */
    await expect(make({ accountCode: '1000', accountType: 'asset', presentationType: 'FINANCE' }))
      .rejects.toThrow(/posted as expense in the ledger, not as asset/i);
  });

  it('clears a presentation the type change left behind', async () => {
    const account = await make({
      accountCode: '5000', accountType: 'expense', presentationType: 'COST_OF_SALES',
    });

    /* The type moves and nothing is said about the presentation. Leaving
     * `COST_OF_SALES` on an income account would be a contradiction; the class
     * is dropped so the account presents as what it now is. */
    const updated = await accounts.updateAccount(ctx.db, actor, account.id, { accountType: 'income' });

    expect(updated.accountType).toBe('income');
    expect(updated.presentationType).toBe('');
  });

  it('keeps a presentation that is still consistent after a type change', async () => {
    const account = await make({
      accountCode: '5000', accountType: 'expense', presentationType: 'FINANCE',
    });
    const updated = await accounts.updateAccount(ctx.db, actor, account.id, { accountName: 'Interest' });

    expect(updated.presentationType).toBe('FINANCE');
  });

  it('treats an omitted presentation as no opinion rather than an error', async () => {
    const account = await make({ accountCode: '1000' });
    expect(account.presentationType).toBe('');
    expect(account.ifrsStatement).toBe('');
  });
});

/* ══ Ordering ══════════════════════════════════════════════════════════════ */

describe('sibling ordering', () => {
  it('appends a new account after its siblings rather than in front of them', async () => {
    const first = await make({ accountCode: '1000' });
    const second = await make({ accountCode: '1010' });
    const third = await make({ accountCode: '1020' });

    expect(first.sortOrder).toBe(0);
    expect(second.sortOrder).toBe(1);
    expect(third.sortOrder).toBe(2);
  });

  it('orders by the chosen sequence, not by the code', async () => {
    const bank = await make({ accountCode: '1000', accountName: 'Bank' });
    const petty = await make({ accountCode: '1090', accountName: 'Petty cash' });

    await accounts.reorderAccounts(ctx.db, actor, null, [petty.id, bank.id]);

    const chart = await accounts.listAccounts(ctx.db, actor);
    expect(chart.map((a) => a.accountName)).toEqual(['Petty cash', 'Bank']);
  });

  it('orders siblings within their own parent', async () => {
    const parent = await make({ accountCode: '1000', isPostable: false });
    const a = await make({ accountCode: '1001', parentAccountId: parent.id });
    const b = await make({ accountCode: '1002', parentAccountId: parent.id });

    await accounts.reorderAccounts(ctx.db, actor, parent.id, [b.id, a.id]);

    const chart = await accounts.listAccounts(ctx.db, actor);
    const children = chart.filter((account) => account.parentAccountId === parent.id);
    expect(children.map((c) => c.accountCode)).toEqual(['1002', '1001']);
  });

  it('refuses a partial order, which would leave colliding positions', async () => {
    const a = await make({ accountCode: '1000' });
    await make({ accountCode: '1010' });

    await expect(accounts.reorderAccounts(ctx.db, actor, null, [a.id]))
      .rejects.toThrow(/every account under this parent exactly once/i);
  });

  it('refuses a duplicate, and an account belonging to another parent', async () => {
    const parent = await make({ accountCode: '1000', isPostable: false });
    const child = await make({ accountCode: '1001', parentAccountId: parent.id });

    await expect(accounts.reorderAccounts(ctx.db, actor, null, [parent.id, parent.id]))
      .rejects.toThrow(/appears twice/i);
    await expect(accounts.reorderAccounts(ctx.db, actor, null, [child.id]))
      .rejects.toThrow(/every account under this parent exactly once/i);
  });

  it('is idempotent, so a retry after a dropped connection is safe', async () => {
    const a = await make({ accountCode: '1000' });
    const b = await make({ accountCode: '1010' });

    await accounts.reorderAccounts(ctx.db, actor, null, [b.id, a.id]);
    await accounts.reorderAccounts(ctx.db, actor, null, [b.id, a.id]);

    const chart = await accounts.listAccounts(ctx.db, actor);
    expect(chart.map((account) => account.accountCode)).toEqual(['1010', '1000']);
  });

  it('cannot reorder another company’s accounts', async () => {
    const other: AccountingActor = {
      ...actor,
      companyId: await company(actor.organizationId, 'co_other'),
    };
    const mine = await make({ accountCode: '1000' });

    /* From the other company's books this account simply is not there, so the
     * request reads as an order naming an account that does not exist. */
    await expect(accounts.reorderAccounts(ctx.db, other, null, [mine.id]))
      .rejects.toThrow(/every account under this parent exactly once/i);

    const untouched = await accounts.listAccounts(ctx.db, actor);
    expect(untouched).toHaveLength(1);
  });
});

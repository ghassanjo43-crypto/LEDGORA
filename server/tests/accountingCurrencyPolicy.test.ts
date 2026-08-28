/**
 * The company currency is the transaction currency.
 *
 * ══ The rule ═════════════════════════════════════════════════════════════════
 *
 * The functional currency chosen when a company is created is the MANDATORY
 * currency for its ordinary accounting transactions. A JOD company records JOD
 * journals at an exchange rate of 1. There is no per-transaction currency
 * choice — not in a form, and not in the API.
 *
 * ══ Why the API tests matter more than the form tests ════════════════════════
 *
 * Removing the dropdown from every editor removes the CHOICE. It does not
 * remove the CAPABILITY: anyone can post `{"transactionCurrency":"USD"}` to the
 * journal API directly, from devtools or curl, with no interface involved. A
 * form-only restriction is precisely the kind of enforcement Phase A exists to
 * replace, so most of what follows is a direct service call that never touches
 * the browser.
 *
 * ══ And what it must NOT do ══════════════════════════════════════════════════
 *
 * The restriction governs NEW transactions. Records already carrying another
 * currency — pre-policy entries, and eventually the browser-resident books when
 * they are migrated — must survive untouched rather than being quietly
 * converted. Those cases are at the bottom of this file, and they are the ones
 * that would do real damage if they regressed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, type TestContext } from './helpers/testApp.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as journals from '../src/services/accounting/journalService.js';

let ctx: TestContext;
let jod: AccountingActor;
let cash: string;
let sales: string;

async function organization(name: string, currency: string): Promise<string> {
  const owner = await seedUser(ctx, { email: `${name.toLowerCase().replace(/\W+/gu, '-')}@currency.test` });
  return ctx.db.transaction().execute(async (trx) => {
    const org = await trx.insertInto('organizations').values({ subscriber_owner_user_id: owner.id, legal_name: name, country: 'JO', base_currency: currency, fiscal_year_start: '01-01', data_classification: 'test' }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('organization_memberships').values({ organization_id: org.id, user_id: owner.id, role: 'owner' }).execute();
    return org.id;
  });
}

async function user(email: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO users (email, normalized_email, full_name, password_hash, status)
    VALUES (${email}, ${email}, 'Test Person', 'x', 'active')
    RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

/**
 * The set of books for a directly-seeded organization.
 *
 * These tests insert their tenant with raw SQL rather than through
 * `createOrganization`, so they bypass the first company it creates. Accounting
 * rows are company-scoped, so without this there is nowhere to post.
 */
async function books(organizationId: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO companies (organization_id, client_reference, legal_name)
    VALUES (${organizationId}, ${`co_${organizationId}`}, 'Test Books')
    RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

/** A company with a chart of accounts, keeping its books in `currency`. */
async function company(
  name: string,
  currency: string,
): Promise<{ actor: AccountingActor; cash: string; sales: string }> {
  const organizationId = await organization(name, currency);
  const actor: AccountingActor = {
    organizationId,
    companyId: await books(organizationId),
    userId: await user(`${name.toLowerCase().replace(/\W/g, '')}@test.local`),
    name: `${name} Bookkeeper`,
  };
  const cashAccount = await accounts.createAccount(ctx.db, actor, {
    accountCode: '1000', accountName: 'Cash', accountType: 'asset',
  });
  const salesAccount = await accounts.createAccount(ctx.db, actor, {
    accountCode: '4000', accountName: 'Sales', accountType: 'income',
  });
  return { actor, cash: cashAccount.id, sales: salesAccount.id };
}

function entry(
  debitAccount: string,
  creditAccount: string,
  value = '100.00',
): journals.JournalInput {
  return {
    transactionDate: '2026-08-01',
    description: 'Consulting fee',
    lines: [
      { accountId: debitAccount, debit: value },
      { accountId: creditAccount, credit: value },
    ],
  };
}

beforeEach(async () => {
  ctx = await createTestContext();
  const randa = await company('Randa Trading', 'JOD');
  jod = randa.actor;
  cash = randa.cash;
  sales = randa.sales;
});
afterEach(async () => {
  await ctx.close();
});

/* ══ The default ═══════════════════════════════════════════════════════════ */

describe('a new transaction takes the company currency automatically', () => {
  it('denominates it in the company currency at par, with nothing supplied', async () => {
    const journal = await journals.createDraft(ctx.db, jod, entry(cash, sales));

    expect(journal.transactionCurrency).toBe('JOD');
    expect(journal.functionalCurrency).toBe('JOD');
    expect(journal.exchangeRate).toBe('1.0000000000');
    // At par the two sides are the same figure, so nothing was translated.
    expect(journal.lines[0]!.debit).toBe(journal.lines[0]!.debitFunctional);
  });

  it('carries the currency and par rate through to posting', async () => {
    const draft = await journals.createDraft(ctx.db, jod, entry(cash, sales));
    const posted = await journals.postJournal(ctx.db, jod, draft.id, {
      expectedVersion: draft.version,
    });
    expect(posted.status).toBe('posted');
    expect(posted.transactionCurrency).toBe('JOD');
    expect(posted.exchangeRate).toBe('1.0000000000');
  });

  it('resolves each organization’s own currency when several exist', async () => {
    // Switching between organizations must resolve each one's own currency —
    // there is no global default anywhere in the path.
    const euro = await company('Euro Handel', 'EUR');
    const kuwaiti = await company('Kuwait Co', 'KWD');

    const theirs = await journals.createDraft(ctx.db, euro.actor, entry(euro.cash, euro.sales));
    const kuwaitis = await journals.createDraft(ctx.db, kuwaiti.actor, entry(kuwaiti.cash, kuwaiti.sales));
    const ours = await journals.createDraft(ctx.db, jod, entry(cash, sales));

    expect([theirs.transactionCurrency, kuwaitis.transactionCurrency, ours.transactionCurrency])
      .toEqual(['EUR', 'KWD', 'JOD']);
  });
});

/* ══ The refusal ═══════════════════════════════════════════════════════════ */

describe('a foreign currency cannot be supplied', () => {
  it('refuses USD for a JOD company, and writes nothing', async () => {
    await expect(
      journals.createDraft(ctx.db, jod, { ...entry(cash, sales), transactionCurrency: 'USD' }),
    ).rejects.toMatchObject({ code: 'validation_error' });

    // Refused, not silently corrected: a caller that believed it recorded USD
    // must be told, not left to discover a JOD entry later.
    await expect(
      journals.createDraft(ctx.db, jod, { ...entry(cash, sales), transactionCurrency: 'USD' }),
    ).rejects.toThrow(/accounting currency is JOD/i);

    expect(await journals.listJournals(ctx.db, jod, {})).toHaveLength(0);
  });

  it('accepts the company’s own currency however it is spelled', async () => {
    // Redundant but harmless — it means the same thing, so it is not an error.
    const created = await journals.createDraft(ctx.db, jod, {
      ...entry(cash, sales), transactionCurrency: 'jod', exchangeRate: '1',
    });
    expect(created.transactionCurrency).toBe('JOD');
    expect(created.exchangeRate).toBe('1.0000000000');
  });

  it('refuses an exchange rate other than par', async () => {
    for (const rate of ['0.709', '0', '1.5']) {
      await expect(
        journals.createDraft(ctx.db, jod, { ...entry(cash, sales), exchangeRate: rate }),
      ).rejects.toThrow(/exchange rate of 1/i);
    }
    // Par expressed with decimals is still par.
    const ok = await journals.createDraft(ctx.db, jod, {
      ...entry(cash, sales), exchangeRate: '1.0000',
    });
    expect(ok.exchangeRate).toBe('1.0000000000');
  });

  it('does not let one company borrow another’s currency', async () => {
    const euro = await company('Euro Handel', 'EUR');
    await expect(
      journals.createDraft(ctx.db, euro.actor, {
        ...entry(euro.cash, euro.sales), transactionCurrency: 'JOD',
      }),
    ).rejects.toThrow(/accounting currency is EUR/i);
  });
});

/* ══ No way round it ═══════════════════════════════════════════════════════ */

describe('the currency cannot be changed after the fact', () => {
  it('refuses to re-denominate a draft through an edit', async () => {
    const draft = await journals.createDraft(ctx.db, jod, entry(cash, sales));
    await expect(
      journals.updateDraft(ctx.db, jod, draft.id, {
        ...entry(cash, sales, '200.00'), transactionCurrency: 'USD',
      }, { expectedVersion: draft.version }),
    ).rejects.toThrow(/cannot be changed by editing/i);

    // An ordinary edit that leaves the currency alone still works.
    const edited = await journals.updateDraft(ctx.db, jod, draft.id, entry(cash, sales, '200.00'), {
      expectedVersion: draft.version,
    });
    expect(edited.transactionCurrency).toBe('JOD');
    expect(edited.lines[0]!.debit).toBe('200.0000000000');
  });

  it('refuses to re-denominate a posted entry through an amendment', async () => {
    const draft = await journals.createDraft(ctx.db, jod, entry(cash, sales));
    const posted = await journals.postJournal(ctx.db, jod, draft.id, { expectedVersion: 1 });

    await expect(
      journals.amendPostedJournal(ctx.db, jod, posted.id, {
        ...entry(cash, sales, '150.00'), transactionCurrency: 'USD',
      }, { expectedVersion: posted.version, reason: 'Trying to re-denominate' }),
    ).rejects.toThrow(/cannot be changed by editing/i);

    expect((await journals.getJournal(ctx.db, jod, posted.id)).transactionCurrency).toBe('JOD');
  });

  it('refuses to smuggle one in through a replacement, atomically', async () => {
    const draft = await journals.createDraft(ctx.db, jod, entry(cash, sales));
    const posted = await journals.postJournal(ctx.db, jod, draft.id, { expectedVersion: 1 });

    await expect(
      journals.reverseAndReplace(ctx.db, jod, posted.id, {
        ...entry(cash, sales), transactionCurrency: 'USD',
      }, { expectedVersion: posted.version, reason: 'Replacing in the wrong currency' }),
    ).rejects.toThrow(/accounting currency is JOD/i);

    // And the original was not left reversed with nothing to replace it.
    expect((await journals.getJournal(ctx.db, jod, posted.id)).status).toBe('posted');
    expect(await journals.listJournals(ctx.db, jod, {})).toHaveLength(1);
  });
});

/* ══ Records already in another currency ═══════════════════════════════════ */

describe('records already in another currency', () => {
  /**
   * A legacy entry, written straight to the table as a pre-policy record or a
   * future browser-to-server import would be.
   *
   * These are the tests that would do real damage if they regressed: the new
   * restriction governs NEW transactions, and must not reach back and restate
   * what is already in the books.
   */
  async function legacyPostedUsdEntry(): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      INSERT INTO journal_entries (
        organization_id, company_id, journal_number, transaction_date, posting_date, status,
        transaction_currency, functional_currency, exchange_rate, posted_at, version
      ) VALUES (
        ${jod.organizationId}, ${jod.companyId}, 'JE-900001', '2025-01-15', '2025-01-15', 'posted',
        'USD', 'JOD', 0.709, '2025-01-15T00:00:00Z', 1
      ) RETURNING id
    `.execute(ctx.db);
    const id = rows[0]!.id;

    for (const line of [
      { n: 1, account: cash, debit: 100, credit: 0 },
      { n: 2, account: sales, debit: 0, credit: 100 },
    ]) {
      await sql`
        INSERT INTO journal_lines (
          organization_id, company_id, journal_entry_id, line_number, account_id,
          debit_transaction, credit_transaction, debit_functional, credit_functional, exchange_rate
        ) VALUES (
          ${jod.organizationId}, ${jod.companyId}, ${id}, ${line.n}, ${line.account},
          ${line.debit}, ${line.credit}, ${line.debit * 0.709}, ${line.credit * 0.709}, 0.709
        )
      `.execute(ctx.db);
    }
    return id;
  }

  it('leaves a posted foreign-currency entry exactly as it was', async () => {
    const entryId = await legacyPostedUsdEntry();
    const stored = await journals.getJournal(ctx.db, jod, entryId);

    expect(stored.transactionCurrency).toBe('USD');
    expect(stored.exchangeRate).toBe('0.7090000000');
    expect(stored.lines[0]!.debit).toBe('100.0000000000');
    expect(stored.lines[0]!.debitFunctional).toBe('70.9000000000');
  });

  it('does not convert it when an unrelated correction is made', async () => {
    const entryId = await legacyPostedUsdEntry();
    const amended = await journals.amendPostedJournal(ctx.db, jod, entryId, {
      transactionDate: '2025-01-15',
      description: 'Narration corrected',
      lines: [
        { accountId: cash, debit: '120.00' },
        { accountId: sales, credit: '120.00' },
      ],
    }, { expectedVersion: 1, reason: 'The narration on the original was wrong' });

    // Still USD at its historical rate. Correcting a figure must not move the
    // money into a different currency behind the user's back.
    expect(amended.transactionCurrency).toBe('USD');
    expect(amended.exchangeRate).toBe('0.7090000000');
    expect(amended.lines[0]!.debitFunctional).toBe('85.0800000000');
  });

  it('reverses it in its own currency, and replaces it in the company’s', async () => {
    const entryId = await legacyPostedUsdEntry();
    const { reversal, replacement } = await journals.reverseAndReplace(ctx.db, jod, entryId, {
      transactionDate: '2026-08-01',
      lines: [
        { accountId: cash, debit: '75.00' },
        { accountId: sales, credit: '75.00' },
      ],
    }, { expectedVersion: 1, reason: 'Re-recording under the current currency policy' });

    // A reversal must mirror what it withdraws, or it does not withdraw it.
    expect(reversal.transactionCurrency).toBe('USD');
    expect(reversal.exchangeRate).toBe('0.7090000000');
    expect(reversal.lines.find((l) => l.accountId === cash)!.creditFunctional).toBe('70.9000000000');

    // The replacement is a new transaction, so it follows the current policy —
    // which is how a legacy record gets brought into line deliberately.
    expect(replacement.transactionCurrency).toBe('JOD');
    expect(replacement.exchangeRate).toBe('1.0000000000');
  });
});

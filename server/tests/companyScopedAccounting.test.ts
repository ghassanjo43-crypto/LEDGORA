/**
 * Phase 2/3 — two companies under ONE subscriber must never meet.
 *
 * ══ Why this file is separate from the tenant-isolation tests ════════════════
 *
 * `accountingFoundation.test.ts` proves that one ORGANIZATION cannot reach
 * another's books. That boundary was never really in doubt: the two tenants
 * share nothing, and every query already filtered by organization.
 *
 * This is the harder boundary, and the one the old schema got wrong. Both
 * companies here belong to the SAME subscriber. Every row passes an
 * `organization_id` check. A forgotten company filter therefore produces no
 * error, no permission failure and no empty result — it produces a ledger that
 * quietly contains somebody else's transactions, in a system whose only job is
 * to be right about numbers.
 *
 * So the claims are:
 *
 *   independence  the same account code, journal number and invoice number may
 *                 exist in both companies, because they are different books;
 *   refusal       a reference that crosses companies is rejected by the
 *                 DATABASE, not merely by a service that remembered to check;
 *   invisibility  one company's journal is not readable, postable, amendable,
 *                 reversible or deletable from the other — and answers 404
 *                 rather than 403, which would confirm it exists.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, type TestContext } from './helpers/testApp.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as journals from '../src/services/accounting/journalService.js';

let ctx: TestContext;
/** One subscriber. Two sets of books. */
let organizationId: string;
let north: AccountingActor;
let south: AccountingActor;

async function organization(name: string): Promise<string> {
  const owner = await seedUser(ctx, { email: `${name}@scoped.test` });
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
 * A company seeded directly, already ADOPTED.
 *
 * `adopted_at` is set because these stand for books a client has claimed, and
 * because at most one PROVISIONAL company may exist per organization
 * (migration 026). Two unadopted rows is the state the index forbids — which is
 * the point of it, and why this helper must be explicit rather than relying on
 * the column's default.
 */
async function company(org: string, reference: string, name: string): Promise<string> {
  const row = await ctx.db.insertInto('companies')
    .values({
      organization_id: org,
      client_reference: reference,
      legal_name: name,
      adopted_at: sql`now()`,
    })
    .returning('id').executeTakeFirstOrThrow();
  return row.id;
}

async function person(email: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO users (email, normalized_email, full_name, password_hash, status, email_verified_at)
    VALUES (${email}, ${email}, 'Bookkeeper', 'x', 'active', now()) RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

beforeEach(async () => {
  ctx = await createTestContext();
  organizationId = await organization('One Subscriber');
  const bookkeeper = await person('books@scoped.test');
  north = {
    organizationId,
    companyId: await company(organizationId, 'co_north', 'Northern Trading'),
    userId: bookkeeper,
    name: 'Bookkeeper',
  };
  south = {
    organizationId,
    companyId: await company(organizationId, 'co_south', 'Southern Logistics'),
    userId: bookkeeper,
    name: 'Bookkeeper',
  };
});
afterEach(async () => { await ctx.close(); });

const chart = async (actor: AccountingActor) => ({
  cash: (await accounts.createAccount(ctx.db, actor, {
    accountCode: '1000', accountName: 'Cash', accountType: 'asset',
  })).id,
  sales: (await accounts.createAccount(ctx.db, actor, {
    accountCode: '4000', accountName: 'Sales', accountType: 'income',
  })).id,
});

const entry = (cash: string, sales: string, value = '250.750') => ({
  transactionDate: '2026-08-01',
  description: 'Consulting fee',
  lines: [{ accountId: cash, debit: value }, { accountId: sales, credit: value }],
});

/* ══ Two companies, one subscriber ═════════════════════════════════════════ */

describe('two companies inside one organization', () => {
  it('are the same tenant and still separate books', async () => {
    expect(north.organizationId).toBe(south.organizationId);
    expect(north.companyId).not.toBe(south.companyId);
  });

  it('may both use the account code 1000', async () => {
    /*
     * Under organization-only scoping this was a duplicate-key error, and a
     * customer's second company could not open a cash account. It is not a
     * duplicate: they are different charts of accounts.
     */
    const a = await chart(north);
    const b = await chart(south);
    expect(a.cash).not.toBe(b.cash);

    const codes = await ctx.db.selectFrom('accounts')
      .select(['account_code', 'company_id'])
      .where('organization_id', '=', organizationId).execute();
    expect(codes.filter((r) => r.account_code === '1000')).toHaveLength(2);
  });

  it('may both hold JE-000001, numbered independently', async () => {
    const a = await chart(north);
    const b = await chart(south);
    const first = await journals.createDraft(ctx.db, north, entry(a.cash, a.sales));
    const second = await journals.createDraft(ctx.db, south, entry(b.cash, b.sales));

    /* Each company's sequence starts at one. The second company does not
     * inherit the first company's position. */
    expect(second.journalNumber).toBe(first.journalNumber);
  });

  it('lists only its own entries', async () => {
    const a = await chart(north);
    const b = await chart(south);
    await journals.createDraft(ctx.db, north, entry(a.cash, a.sales));
    await journals.createDraft(ctx.db, north, entry(a.cash, a.sales));
    await journals.createDraft(ctx.db, south, entry(b.cash, b.sales));

    expect(await journals.listJournals(ctx.db, north, {})).toHaveLength(2);
    expect(await journals.listJournals(ctx.db, south, {})).toHaveLength(1);
  });

  it('lists only its own accounts', async () => {
    await chart(north);
    await chart(south);
    const seen = await accounts.listAccounts(ctx.db, north);
    expect(seen).toHaveLength(2);
    expect(seen.every((a) => a.id !== undefined)).toBe(true);
  });
});

/* ══ The database refuses, not merely the service ══════════════════════════ */

describe('a reference that crosses companies', () => {
  it('is refused for a journal line, by the database itself', async () => {
    const a = await chart(north);
    const b = await chart(south);
    const draft = await journals.createDraft(ctx.db, north, entry(a.cash, a.sales));

    /*
     * Around every service check: a hand-written INSERT putting SOUTH's account
     * on a line of NORTH's entry, with the organization matching throughout.
     * This is the exact shape a forgotten company filter would produce, and the
     * composite foreign key is what makes it unrepresentable.
     */
    const direct = sql`
      INSERT INTO journal_lines (
        organization_id, company_id, journal_entry_id, line_number, account_id,
        debit_transaction, credit_transaction, debit_functional, credit_functional
      ) VALUES (
        ${organizationId}, ${north.companyId}, ${draft.id}, 9, ${b.cash}, 5, 0, 5, 0
      )
    `.execute(ctx.db);

    await expect(direct).rejects.toThrow(/account_same_company|foreign key/i);
  });

  it('is refused for an account parented in the other company', async () => {
    const b = await chart(south);
    const attempt = sql`
      INSERT INTO accounts (organization_id, company_id, account_code, account_name,
                            account_type, normal_balance, parent_account_id)
      VALUES (${organizationId}, ${north.companyId}, '1100', 'Child', 'asset', 'debit', ${b.cash})
    `.execute(ctx.db);
    await expect(attempt).rejects.toThrow(/parent_same_company|foreign key/i);
  });

  it('is refused for a correction link between companies', async () => {
    const b = await chart(south);
    const theirs = await journals.createDraft(ctx.db, south, entry(b.cash, b.sales));

    /* A reversal must never cross companies: it would withdraw an amount from
     * books that never carried it. */
    const attempt = sql`
      INSERT INTO journal_entries (
        organization_id, company_id, journal_number, transaction_date, posting_date,
        transaction_currency, functional_currency, original_entry_id
      ) VALUES (
        ${organizationId}, ${north.companyId}, 'JE-CROSS', '2026-08-01', '2026-08-01',
        'JOD', 'JOD', ${theirs.id}
      )
    `.execute(ctx.db);
    await expect(attempt).rejects.toThrow(/same_company|foreign key/i);
  });

  it('is refused for a version snapshot attached to the other company’s entry', async () => {
    const b = await chart(south);
    const theirs = await journals.createDraft(ctx.db, south, entry(b.cash, b.sales));
    const attempt = sql`
      INSERT INTO journal_entry_versions (organization_id, company_id, journal_entry_id, version, change_kind, snapshot)
      VALUES (${organizationId}, ${north.companyId}, ${theirs.id}, 99, 'created', '{}'::jsonb)
    `.execute(ctx.db);
    await expect(attempt).rejects.toThrow(/same_company|foreign key/i);
  });

  it('is refused at draft time as a readable validation error', async () => {
    const a = await chart(north);
    const b = await chart(south);
    /*
     * The service refuses first, so an ordinary user sees a sentence rather
     * than a constraint name. The constraint above is what makes the refusal
     * true; this is what makes it usable.
     */
    await expect(journals.createDraft(ctx.db, north, {
      transactionDate: '2026-08-01',
      description: 'Cross-company',
      lines: [{ accountId: b.cash, debit: '10.00' }, { accountId: a.sales, credit: '10.00' }],
    })).rejects.toMatchObject({ code: 'validation_error' });
  });
});

/* ══ Invisibility across companies ═════════════════════════════════════════ */

describe('one company’s journal, seen from the other', () => {
  async function northsPostedEntry() {
    const a = await chart(north);
    const draft = await journals.createDraft(ctx.db, north, entry(a.cash, a.sales));
    return journals.postJournal(ctx.db, north, draft.id, { expectedVersion: draft.version });
  }

  it('cannot be read', async () => {
    const posted = await northsPostedEntry();
    /* 404, not 403: a refusal that distinguished "exists but forbidden" would
     * confirm the entry is real, which is itself the leak. */
    await expect(journals.getJournal(ctx.db, south, posted.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('cannot be posted', async () => {
    const a = await chart(north);
    const draft = await journals.createDraft(ctx.db, north, entry(a.cash, a.sales));
    await expect(journals.postJournal(ctx.db, south, draft.id, { expectedVersion: draft.version }))
      .rejects.toMatchObject({ code: 'not_found' });

    const untouched = await journals.getJournal(ctx.db, north, draft.id);
    expect(untouched.status).toBe('draft');
  });

  it('cannot be deleted as a draft', async () => {
    const a = await chart(north);
    const draft = await journals.createDraft(ctx.db, north, entry(a.cash, a.sales));
    await expect(journals.deleteDraft(ctx.db, south, draft.id, { expectedVersion: draft.version }))
      .rejects.toMatchObject({ code: 'not_found' });

    expect(await journals.getJournal(ctx.db, north, draft.id)).toBeTruthy();
  });

  it('cannot be reversed', async () => {
    const posted = await northsPostedEntry();
    await expect(journals.reverseJournal(ctx.db, south, posted.id, {
      expectedVersion: posted.version, reason: 'Not mine to reverse',
    })).rejects.toMatchObject({ code: 'not_found' });

    const still = await journals.getJournal(ctx.db, north, posted.id);
    expect(still.status).toBe('posted');
  });

  it('cannot be amended', async () => {
    const posted = await northsPostedEntry();
    const b = await chart(south);
    await expect(journals.amendPostedJournal(
      ctx.db, south, posted.id, entry(b.cash, b.sales),
      { expectedVersion: posted.version, reason: 'Not mine to amend' },
    )).rejects.toMatchObject({ code: 'not_found' });
  });

  it('cannot be reversed and replaced', async () => {
    const posted = await northsPostedEntry();
    const b = await chart(south);
    await expect(journals.reverseAndReplace(
      ctx.db, south, posted.id, entry(b.cash, b.sales),
      { expectedVersion: posted.version, reason: 'Not mine to replace' },
    )).rejects.toMatchObject({ code: 'not_found' });
  });

  it('does not appear in the other company’s history', async () => {
    const posted = await northsPostedEntry();
    await expect(journals.listJournalHistory(ctx.db, south, posted.id))
      .rejects.toMatchObject({ code: 'not_found' });
  });
});

/* ══ Audit trails do not bleed ═════════════════════════════════════════════ */

describe('the accounting audit trail', () => {
  it('records each company’s events against that company', async () => {
    const a = await chart(north);
    await chart(south);
    await journals.createDraft(ctx.db, north, entry(a.cash, a.sales));

    const rows = await ctx.db.selectFrom('accounting_audit_events')
      .select(['company_id', 'action'])
      .where('organization_id', '=', organizationId).execute();

    /* Every event belongs to exactly one set of books, and North's journal
     * creation is not among South's. */
    const southEvents = rows.filter((r) => r.company_id === south.companyId);
    expect(southEvents.every((r) => r.action.startsWith('ACCOUNT_'))).toBe(true);
    expect(rows.some((r) => r.company_id === north.companyId && r.action === 'JOURNAL_CREATED')).toBe(true);
  });
});

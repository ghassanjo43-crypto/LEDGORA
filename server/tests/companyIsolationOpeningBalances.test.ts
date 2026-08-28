/**
 * Opening balances and invoices, across two companies of ONE subscriber.
 *
 * ══ Why this file exists ═════════════════════════════════════════════════════
 *
 * `companyScopedAccounting.test.ts` covers accounts and journals, and passed
 * throughout — while `openingBalanceService` was scoped by organization alone
 * and had never been company-scoped at all. Every one of its reads and writes
 * went through one helper (`rowOf`) that filtered on organization and id, so a
 * user of company B could list company A's chart of accounts, read its
 * opening-balance audit trail, and take a row lock on its set.
 *
 * The gap survived because the tests asked about journals and the defect was in
 * opening balances. So this file asks the same question of every remaining
 * surface, one export at a time, rather than sampling.
 *
 * ══ What "safe" has to mean here ═════════════════════════════════════════════
 *
 * Several of these paths would ALSO have failed at the journal layer, which was
 * correctly scoped — but only after locking the other company's row, and only
 * because of the order the calls happen to be in. A test that accepted "it
 * throws eventually" would keep passing if someone reordered them. These assert
 * `not_found` from the opening-balance layer itself, and that the other
 * company's record is untouched afterwards.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, type TestContext } from './helpers/testApp.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as openingBalances from '../src/services/accounting/openingBalanceService.js';

let ctx: TestContext;
let organizationId: string;
let north: AccountingActor;
let south: AccountingActor;

async function organization(name: string): Promise<string> {
  const owner = await seedUser(ctx, { email: `${name}@ob-isolation.test` });
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

/** An adopted company: at most one PROVISIONAL row may exist per organization. */
async function company(org: string, reference: string, name: string): Promise<string> {
  const row = await ctx.db.insertInto('companies')
    .values({
      organization_id: org, client_reference: reference, legal_name: name,
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
  const who = await person('books@ob-isolation.test');
  north = {
    organizationId, companyId: await company(organizationId, 'co_north', 'Northern Trading'),
    userId: who, name: 'Bookkeeper',
  };
  south = {
    organizationId, companyId: await company(organizationId, 'co_south', 'Southern Logistics'),
    userId: who, name: 'Bookkeeper',
  };
});
afterEach(async () => { await ctx.close(); });

/** Two postable equity/asset accounts, so an opening balance can be drafted. */
async function chart(actor: AccountingActor) {
  const cash = await accounts.createAccount(ctx.db, actor, {
    accountCode: '1000', accountName: 'Cash', accountType: 'asset',
  });
  const equity = await accounts.createAccount(ctx.db, actor, {
    accountCode: '3000', accountName: 'Opening Equity', accountType: 'equity',
  });
  return { cash: cash.id, equity: equity.id };
}

const draftInput = (cash: string, equity: string) => ({
  bookkeepingStartDate: '2026-01-01',
  openingBalanceDate: '2025-12-31',
  reference: 'OPENING-2026',
  description: 'Opening balances',
  lines: [
    { accountId: cash, debit: '5000.000' },
    { accountId: equity, credit: '5000.000' },
  ],
});

/** North's opening-balance draft, which South must never reach. */
async function northsDraft() {
  const a = await chart(north);
  return openingBalances.createOrLoadDraft(ctx.db, north, draftInput(a.cash, a.equity));
}

/* ══ The account list offered for opening balances ═════════════════════════ */

describe('the eligible-account list', () => {
  it('offers only THIS company’s accounts', async () => {
    await chart(north);
    await chart(south);

    const forNorth = await openingBalances.listEligibleAccounts(ctx.db, north);
    const forSouth = await openingBalances.listEligibleAccounts(ctx.db, south);

    /*
     * Two accounts each, not four. Organization-only, this returned every
     * company's chart — and it is the endpoint the opening-balance screen calls.
     */
    expect(forNorth.accounts).toHaveLength(2);
    expect(forSouth.accounts).toHaveLength(2);

    const northIds = new Set(forNorth.accounts.map((a) => (a as { id: string }).id));
    const southIds = new Set(forSouth.accounts.map((a) => (a as { id: string }).id));
    for (const id of southIds) expect(northIds.has(id)).toBe(false);
  });

  it('offers nothing at all to a company with no accounts', async () => {
    await chart(north);
    const forSouth = await openingBalances.listEligibleAccounts(ctx.db, south);
    expect(forSouth.accounts).toEqual([]);
  });
});

/* ══ One company's opening balance, seen from the other ════════════════════ */

describe('another company’s opening balance', () => {
  it('cannot be read by id', async () => {
    const draft = await northsDraft();
    await expect(openingBalances.getById(ctx.db, south, draft.id))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('does not appear as the other company’s current set', async () => {
    await northsDraft();
    /* South has none of its own, and must not inherit North's. */
    expect(await openingBalances.getCurrent(ctx.db, south)).toBeNull();
    expect(await openingBalances.getCurrent(ctx.db, north)).not.toBeNull();
  });

  it('cannot have its audit history inspected', async () => {
    const draft = await northsDraft();
    /*
     * Directly exploitable before the fix: `rowOf` admitted the row and the
     * audit read was organization-scoped, so no journal check stood in the way.
     */
    await expect(openingBalances.auditHistory(ctx.db, south, draft.id))
      .rejects.toMatchObject({ code: 'not_found' });

    /* North still sees its own. */
    expect((await openingBalances.auditHistory(ctx.db, north, draft.id)).length).toBeGreaterThan(0);
  });

  it('cannot be updated', async () => {
    const draft = await northsDraft();
    const b = await chart(south);
    await expect(openingBalances.updateDraft(
      ctx.db, south, draft.id, draftInput(b.cash, b.equity), draft.version,
    )).rejects.toMatchObject({ code: 'not_found' });

    const untouched = await openingBalances.getById(ctx.db, north, draft.id);
    expect(untouched.reference).toBe('OPENING-2026');
    expect(untouched.version).toBe(draft.version);
  });

  it('cannot be submitted', async () => {
    const draft = await northsDraft();
    await expect(openingBalances.submit(ctx.db, south, draft.id, draft.version))
      .rejects.toMatchObject({ code: 'not_found' });
    expect((await openingBalances.getById(ctx.db, north, draft.id)).status).toBe('draft');
  });

  it('cannot be approved', async () => {
    const draft = await northsDraft();
    await openingBalances.submit(ctx.db, north, draft.id, draft.version);
    const submitted = await openingBalances.getById(ctx.db, north, draft.id);

    await expect(openingBalances.approve(ctx.db, south, draft.id, submitted.version))
      .rejects.toMatchObject({ code: 'not_found' });
    expect((await openingBalances.getById(ctx.db, north, draft.id)).status).toBe('submitted');
  });

  it('cannot be posted', async () => {
    const draft = await northsDraft();
    await openingBalances.submit(ctx.db, north, draft.id, draft.version);
    const submitted = await openingBalances.getById(ctx.db, north, draft.id);
    await openingBalances.approve(ctx.db, north, draft.id, submitted.version);
    const approved = await openingBalances.getById(ctx.db, north, draft.id);

    await expect(openingBalances.post(ctx.db, south, draft.id, approved.version))
      .rejects.toMatchObject({ code: 'not_found' });
    expect((await openingBalances.getById(ctx.db, north, draft.id)).status).toBe('approved');
  });

  it('cannot be reversed', async () => {
    const draft = await northsDraft();
    await openingBalances.submit(ctx.db, north, draft.id, draft.version);
    await openingBalances.approve(
      ctx.db, north, draft.id, (await openingBalances.getById(ctx.db, north, draft.id)).version,
    );
    await openingBalances.post(
      ctx.db, north, draft.id, (await openingBalances.getById(ctx.db, north, draft.id)).version,
    );
    const posted = await openingBalances.getById(ctx.db, north, draft.id);
    expect(posted.status).toBe('posted');

    await expect(openingBalances.reverse(ctx.db, south, draft.id, posted.version, 'Not mine'))
      .rejects.toMatchObject({ code: 'not_found' });
    expect((await openingBalances.getById(ctx.db, north, draft.id)).status).toBe('posted');
  });

  it('cannot be used as the original for a replacement', async () => {
    const draft = await northsDraft();
    const b = await chart(south);
    await expect(openingBalances.createReplacement(
      ctx.db, south, draft.id, draftInput(b.cash, b.equity),
    )).rejects.toMatchObject({ code: 'not_found' });
  });
});

/* ══ The rule that was stricter than the database ══════════════════════════ */

describe('the one-active-set rule', () => {
  it('is per COMPANY, so both companies may keep opening balances', async () => {
    const a = await chart(north);
    const b = await chart(south);

    await openingBalances.createOrLoadDraft(ctx.db, north, draftInput(a.cash, a.equity));
    /*
     * Organization-wide, this refused — a subscriber's second company could
     * never record opening balances at all, while the message claimed to speak
     * "for this company". The database index was always per company; the
     * service was the thing that disagreed.
     */
    const southDraft = await openingBalances.createOrLoadDraft(ctx.db, south, draftInput(b.cash, b.equity));
    expect(southDraft.status).toBe('draft');

    const rows = await ctx.db.selectFrom('opening_balance_sets')
      .select(['id', 'company_id'])
      .where('organization_id', '=', organizationId).execute();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.company_id)).size).toBe(2);
  });
});

/* ══ Lines may not draw on another company's accounts ══════════════════════ */

describe('an opening balance drawing on the other company’s accounts', () => {
  it('is refused, naming the company rather than the organization', async () => {
    const a = await chart(north);
    const b = await chart(south);

    /*
     * A line on NORTH's set pointing at SOUTH's account. Refused by the
     * eligibility check; the composite foreign key would refuse the posting
     * regardless, and this turns that into a readable sentence.
     */
    await expect(openingBalances.createOrLoadDraft(ctx.db, north, {
      ...draftInput(a.cash, a.equity),
      lines: [
        { accountId: b.cash, debit: '5000.000' },
        { accountId: a.equity, credit: '5000.000' },
      ],
    })).rejects.toMatchObject({ code: 'validation_error' });
  });
});

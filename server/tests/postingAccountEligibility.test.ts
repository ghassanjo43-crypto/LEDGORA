import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, type TestContext } from './helpers/testApp.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as journals from '../src/services/accounting/journalService.js';

let ctx: TestContext;
let actor: AccountingActor;
let otherActor: AccountingActor;
let sequence = 0;

async function organization(name: string): Promise<string> {
  const owner = await seedUser(ctx, { email: `${name.toLowerCase().replace(/\W+/gu, '-')}@eligibility.test` });
  return ctx.db.transaction().execute(async (trx) => {
    const org = await trx.insertInto('organizations').values({ subscriber_owner_user_id: owner.id, legal_name: name, country: 'JO', base_currency: 'JOD', fiscal_year_start: '01-01', data_classification: 'test' }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('organization_memberships').values({ organization_id: org.id, user_id: owner.id, role: 'owner' }).execute();
    return org.id;
  });
}

async function user(email: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO users (email, normalized_email, full_name, password_hash, status, email_verified_at)
    VALUES (${email}, ${email}, 'Eligibility Tester', 'x', 'active', now()) RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

/**
 * The set of books for a directly-seeded organization. These tests build their
 * tenants with raw inserts rather than through `createOrganization`, so they
 * bypass the first company it creates — and accounting rows are company-scoped.
 */
async function books(organizationId: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO companies (organization_id, client_reference, legal_name)
    VALUES (${organizationId}, ${`co_${organizationId}`}, 'Eligibility Books')
    RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

async function account(overrides: Partial<accounts.CreateAccountInput> = {}, owner = actor) {
  sequence += 1;
  return accounts.createAccount(ctx.db, owner, {
    accountCode: `E${sequence}`,
    accountName: `Eligibility ${sequence}`,
    accountType: 'asset',
    ...overrides,
  });
}

async function draftWith(debitAccountId: string, creditAccountId: string) {
  return journals.createDraft(ctx.db, actor, {
    transactionDate: '2026-08-01',
    lines: [
      { accountId: debitAccountId, debit: '10.000' },
      { accountId: creditAccountId, credit: '10.000' },
    ],
  });
}

async function expectPostingRefused(accountId: string, pattern: RegExp) {
  const counterparty = await account({ accountType: 'income' });
  const draft = await draftWith(accountId, counterparty.id);
  await expect(journals.postJournal(ctx.db, actor, draft.id, { expectedVersion: draft.version }))
    .rejects.toThrow(pattern);
  expect((await journals.getJournal(ctx.db, actor, draft.id)).lines[0]!.accountId).toBe(accountId);
}

beforeAll(async () => {
  ctx = await createTestContext();
  const ownOrganization = await organization('Eligibility A');
  const otherOrganization = await organization('Eligibility B');
  actor = { organizationId: ownOrganization, companyId: await books(ownOrganization), userId: await user('eligibility-a@test.local'), name: 'Eligibility A' };
  otherActor = { organizationId: otherOrganization, companyId: await books(otherOrganization), userId: await user('eligibility-b@test.local'), name: 'Eligibility B' };
});

afterAll(async () => ctx.close());

describe('authoritative posting-account eligibility', () => {
  it('keeps migrated and newly-created account states backward compatible by default', async () => {
    const created = await account();
    expect(created).toMatchObject({ active: true, blocked: false, archived: false, isPostable: true });

    const { rows } = await sql<{ active: boolean; blocked: boolean; archived: boolean }>`
      INSERT INTO accounts (organization_id, company_id, account_code, account_name, account_type, normal_balance)
      VALUES (${actor.organizationId}, ${actor.companyId}, ${`RAW${++sequence}`}, 'Pre-migration-shaped account', 'asset', 'debit')
      RETURNING active, blocked, archived
    `.execute(ctx.db);
    expect(rows[0]).toEqual({ active: true, blocked: false, archived: false });
  });

  it('persists blocked and archived states and enforces valid lifecycle transitions', async () => {
    const blocked = await account({ blocked: true });
    expect(blocked.blocked).toBe(true);
    const archived = await accounts.updateAccount(ctx.db, actor, blocked.id, { active: false, blocked: false, archived: true });
    expect(archived).toMatchObject({ active: false, blocked: false, archived: true });
    await expect(accounts.updateAccount(ctx.db, actor, blocked.id, { active: true }))
      .rejects.toThrow(/unarchive.*reactivat/i);
  });

  it('rejects a blocked account without substituting its reference', async () => {
    await expectPostingRefused((await account({ blocked: true })).id, /blocked/i);
  });

  it('rejects an archived account', async () => {
    await expectPostingRefused((await account({ active: false, archived: true })).id, /archived/i);
  });

  it('rejects an inactive account', async () => {
    await expectPostingRefused((await account({ active: false })).id, /inactive/i);
  });

  it('rejects a non-postable account', async () => {
    await expectPostingRefused((await account({ isPostable: false })).id, /parent accounts cannot receive transactions/i);
  });

  it('rejects an actual parent even when its stored postable flag is malformed', async () => {
    const parent = await account();
    await sql`
      INSERT INTO accounts (organization_id, company_id, account_code, account_name, account_type, normal_balance,
                            parent_account_id, is_postable)
      VALUES (${actor.organizationId}, ${actor.companyId}, ${`CHILD${++sequence}`}, 'Child', 'asset', 'debit', ${parent.id}, true)
    `.execute(ctx.db);
    await expectPostingRefused(parent.id, /parent accounts cannot receive transactions/i);
  });

  it('rejects cross-tenant account IDs before a draft can persist them', async () => {
    const theirs = await account({}, otherActor);
    const counterparty = await account({ accountType: 'income' });
    await expect(draftWith(theirs.id, counterparty.id)).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('accepts active, unblocked, unarchived posting leaves', async () => {
    const debit = await account();
    const credit = await account({ accountType: 'income' });
    const draft = await draftWith(debit.id, credit.id);
    await expect(journals.postJournal(ctx.db, actor, draft.id, { expectedVersion: draft.version }))
      .resolves.toMatchObject({ status: 'posted' });
  });

  it('keeps historical lines readable and reverses their recorded IDs after an account is blocked', async () => {
    const debit = await account();
    const credit = await account({ accountType: 'income' });
    const draft = await draftWith(debit.id, credit.id);
    const posted = await journals.postJournal(ctx.db, actor, draft.id, { expectedVersion: draft.version });
    const recorded = posted.lines.map((line) => ({ accountId: line.accountId, debit: line.debit, credit: line.credit }));

    await accounts.updateAccount(ctx.db, actor, debit.id, { blocked: true });
    const historical = await journals.getJournal(ctx.db, actor, posted.id);
    expect(historical.lines.map((line) => ({ accountId: line.accountId, debit: line.debit, credit: line.credit })))
      .toEqual(recorded);

    const { reversal } = await journals.reverseJournal(ctx.db, actor, posted.id, {
      expectedVersion: posted.version,
      reason: 'Withdraw the recorded historical entry',
    });
    expect(reversal.lines.map((line) => line.accountId)).toEqual(posted.lines.map((line) => line.accountId));
    expect(reversal.lines[0]!.credit).toBe(posted.lines[0]!.debit);
    expect(reversal.lines[1]!.debit).toBe(posted.lines[1]!.credit);
  });
});

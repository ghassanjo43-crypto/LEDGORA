/**
 * Journal numbering under genuine concurrency.
 *
 * ══ Why this suite is separate, and conditional ══════════════════════════════
 *
 * Every other test in this repository runs on PGlite — real PostgreSQL, in
 * process, one connection. That is exactly the right trade for the rest of the
 * suite and exactly WRONG for this one claim: with a single connection, two
 * "concurrent" transactions cannot overlap, so a lost-update race is unprovable
 * and, worse, a broken implementation would pass.
 *
 * So this file talks to a real PostgreSQL server over several connections, and
 * SKIPS ITSELF when none is configured rather than pretending. A test that
 * quietly proves nothing is more dangerous than an absent one, because the green
 * tick is read as evidence.
 *
 * Run it with a throwaway local database:
 *
 *   ACCOUNTING_CONCURRENCY_DATABASE_URL=postgres://…/scratch npm run server:test
 *
 * ══ What it proves ══════════════════════════════════════════════════════════
 *
 * `allocateJournalNumber` reads the highest number and writes the next one.
 * Under READ COMMITTED that is a textbook lost update: both transactions read
 * JE-000003 and both attempt JE-000004. The transaction-scoped advisory lock is
 * what serialises them. If it were removed, this test fails — either with a
 * unique violation or with duplicate numbers — which is precisely the point.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { createDatabase, type Db } from '../src/db/index.js';
import { migrateToLatest, assertMigrationsSucceeded } from '../src/db/migrator.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as journals from '../src/services/accounting/journalService.js';

const DATABASE_URL = process.env.ACCOUNTING_CONCURRENCY_DATABASE_URL;

/**
 * Deliberately `describe.skipIf` and not a silent early return: a skipped suite
 * is reported as skipped, so nobody mistakes "not run" for "passed".
 */
describe.skipIf(!DATABASE_URL)('journal numbering under real concurrency', () => {
  let db: Db;
  let actor: AccountingActor;
  let cash: string;
  let sales: string;

  beforeAll(async () => {
    db = await createDatabase({ databaseUrl: DATABASE_URL });
    assertMigrationsSucceeded(await migrateToLatest(db));

    const { rows: orgRows } = await sql<{ id: string }>`
      INSERT INTO organizations (legal_name, country, base_currency, data_classification)
      VALUES (${`Concurrency ${Date.now()}`}, 'JO', 'JOD', 'test')
      RETURNING id
    `.execute(db);
    const { rows: userRows } = await sql<{ id: string }>`
      INSERT INTO users (email, normalized_email, full_name, password_hash, status)
      VALUES (${`c${Date.now()}@test.local`}, ${`c${Date.now()}@test.local`}, 'Concurrency', 'x', 'active')
      RETURNING id
    `.execute(db);

    actor = { organizationId: orgRows[0]!.id, userId: userRows[0]!.id, name: 'Concurrency Tester' };
    cash = (await accounts.createAccount(db, actor, {
      accountCode: '1000', accountName: 'Cash', accountType: 'asset',
    })).id;
    sales = (await accounts.createAccount(db, actor, {
      accountCode: '4000', accountName: 'Sales', accountType: 'income',
    })).id;
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    // Cascades from `organizations`, so the scratch database is left clean.
    if (actor) {
      await sql`DELETE FROM organizations WHERE id = ${actor.organizationId}`.execute(db);
      await sql`DELETE FROM users WHERE id = ${actor.userId}`.execute(db);
    }
    await db.destroy();
  });

  it('gives twenty simultaneous drafts twenty distinct numbers, with no gaps', async () => {
    const COUNT = 20;
    const created = await Promise.all(
      Array.from({ length: COUNT }, () =>
        journals.createDraft(db, actor, {
          transactionDate: '2026-08-01',
          lines: [
            { accountId: cash, debit: '10.00' },
            { accountId: sales, credit: '10.00' },
          ],
        }),
      ),
    );

    const numbers = created.map((j) => j.journalNumber).sort();
    expect(new Set(numbers).size).toBe(COUNT);
    // A contiguous run: allocation neither collides nor skips. A gap would look
    // to an auditor exactly like a deleted entry.
    expect(numbers).toEqual(
      Array.from({ length: COUNT }, (_, i) => `JE-${String(i + 1).padStart(6, '0')}`),
    );
  }, 60_000);

  it('serialises two postings of the same entry so only one succeeds', async () => {
    const draft = await journals.createDraft(db, actor, {
      transactionDate: '2026-08-01',
      lines: [
        { accountId: cash, debit: '25.00' },
        { accountId: sales, credit: '25.00' },
      ],
    });

    // Both callers hold version 1 and both try to post. The row lock inside
    // `lockAndVerify` decides; the loser must be refused, never merged.
    const outcomes = await Promise.allSettled([
      journals.postJournal(db, actor, draft.id, { expectedVersion: draft.version }),
      journals.postJournal(db, actor, draft.id, { expectedVersion: draft.version }),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'conflict' });

    // And the entry was posted exactly once.
    const posted = await journals.getJournal(db, actor, draft.id);
    expect(posted.status).toBe('posted');
    const history = await journals.listJournalHistory(db, actor, draft.id);
    expect(history.filter((v) => v.changeKind === 'posted')).toHaveLength(1);
  }, 60_000);
});

/**
 * Phase A1 — the accounting SERVICE layer.
 *
 * ══ What these prove ═════════════════════════════════════════════════════════
 *
 * `accountingFoundation.test.ts` attacks the tables directly and proves the
 * database refuses what it must. This suite proves the layer above it: that the
 * rules which cannot be expressed as constraints — balance across a whole entry,
 * period locks, the correction philosophy, optimistic concurrency — are enforced
 * where every caller has to pass through them.
 *
 * The claims:
 *
 *   numbering    the server allocates journal numbers, never the caller, and a
 *                supplied one is ignored;
 *   validation   an unbalanced, empty, inactive-account or header-account entry
 *                cannot be posted, and the refusal names the reason;
 *   atomicity    a failure ANYWHERE in a posting leaves nothing behind — proved
 *                by injecting a fault mid-transaction, not by inspection;
 *   concurrency  a stale `expectedVersion` is refused, and an OMITTED one is
 *                refused too, so the check cannot be skipped by leaving it out;
 *   history      every change snapshots the version it superseded;
 *   corrections  a posted entry is never deleted, an amendment must still
 *                balance, a reversal mirrors exactly, and reverse-and-replace is
 *                all-or-nothing;
 *   decimals     amounts survive as exact decimals, including three-minor-unit
 *                currencies and very large figures;
 *   isolation    no operation reaches another organization's records.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, type TestContext } from './helpers/testApp.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as periods from '../src/services/accounting/periodService.js';
import * as journals from '../src/services/accounting/journalService.js';

let ctx: TestContext;
let orgA: AccountingActor;
let orgB: AccountingActor;
let cash: string;
let sales: string;
let bank: string;

async function organization(name: string, currency = 'JOD'): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO organizations (legal_name, country, base_currency, data_classification)
    VALUES (${name}, 'JO', ${currency}, 'test')
    RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

async function user(email: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO users (email, normalized_email, full_name, password_hash, status, email_verified_at)
    VALUES (${email}, ${email}, 'Test Person', 'x', 'active', now())
    RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

/** A two-line balanced entry, the shape most tests start from. */
function balanced(debit: string, credit = debit, date = '2026-08-01'): journals.JournalInput {
  return {
    transactionDate: date,
    description: 'Sale',
    lines: [
      { accountId: cash, debit },
      { accountId: sales, credit },
    ],
  };
}

const draftOf = async (input = balanced('100.00')) => journals.createDraft(ctx.db, orgA, input);

beforeEach(async () => {
  ctx = await createTestContext();
  const [a, b] = [await organization('Org A'), await organization('Org B')];
  orgA = { organizationId: a, userId: await user('a@test.local'), name: 'Ayman A' };
  orgB = { organizationId: b, userId: await user('b@test.local'), name: 'Bilal B' };

  cash = (await accounts.createAccount(ctx.db, orgA, {
    accountCode: '1000', accountName: 'Cash', accountType: 'asset',
  })).id;
  sales = (await accounts.createAccount(ctx.db, orgA, {
    accountCode: '4000', accountName: 'Sales', accountType: 'income',
  })).id;
  bank = (await accounts.createAccount(ctx.db, orgA, {
    accountCode: '1010', accountName: 'Bank', accountType: 'asset',
  })).id;
});
afterEach(async () => {
  await ctx.close();
});

/* ══ Journal numbering ═════════════════════════════════════════════════════ */

describe('journal numbering', () => {
  it('is allocated by the server, in sequence', async () => {
    const first = await draftOf();
    const second = await draftOf();
    const third = await draftOf();
    expect([first.journalNumber, second.journalNumber, third.journalNumber]).toEqual([
      'JE-000001', 'JE-000002', 'JE-000003',
    ]);
  });

  it('ignores a number supplied by the caller', async () => {
    // The client has no say in identity. A caller that could choose the number
    // could claim an existing entry's, or leave gaps that look like deletions.
    const created = await journals.createDraft(ctx.db, orgA, {
      ...balanced('10.00'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ journalNumber: 'JE-999999', id: '00000000-0000-0000-0000-000000000001' } as any),
    });
    expect(created.journalNumber).toBe('JE-000001');
    expect(created.id).not.toBe('00000000-0000-0000-0000-000000000001');
  });

  it('numbers each organization independently', async () => {
    await draftOf();
    await draftOf();
    const otherOrgAccount = await accounts.createAccount(ctx.db, orgB, {
      accountCode: '1000', accountName: 'Cash', accountType: 'asset',
    });
    const theirs = await journals.createDraft(ctx.db, orgB, {
      transactionDate: '2026-08-01',
      lines: [{ accountId: otherOrgAccount.id, debit: '5.00' }],
    });
    // Not JE-000003. A shared sequence would leak how many entries every other
    // tenant has written.
    expect(theirs.journalNumber).toBe('JE-000001');
  });

  it('is refused a duplicate by the database, not only by the service', async () => {
    await draftOf();
    const clash = sql`
      INSERT INTO journal_entries (organization_id, journal_number, transaction_date, posting_date,
                                   transaction_currency, functional_currency)
      VALUES (${orgA.organizationId}, 'JE-000001', '2026-08-01', '2026-08-01', 'JOD', 'JOD')
    `.execute(ctx.db);
    await expect(clash).rejects.toThrow(/unique|duplicate/i);
  });
});

/* ══ Validation ════════════════════════════════════════════════════════════ */

describe('posting validation', () => {
  it('accepts a balanced entry', async () => {
    const draft = await draftOf();
    const posted = await journals.postJournal(ctx.db, orgA, draft.id, { expectedVersion: draft.version });
    expect(posted.status).toBe('posted');
    expect(posted.postedAt).not.toBeNull();
  });

  it('refuses an unbalanced entry, saying by how much', async () => {
    const draft = await draftOf({
      transactionDate: '2026-08-01',
      lines: [
        { accountId: cash, debit: '100.00' },
        { accountId: sales, credit: '90.00' },
      ],
    });
    await expect(
      journals.postJournal(ctx.db, orgA, draft.id, { expectedVersion: draft.version }),
    ).rejects.toThrow(/does not balance/i);
  });

  it('refuses an entry that is out by the smallest representable amount', async () => {
    /*
     * The case a floating-point comparison with a tolerance would wave through:
     * one fils, the smallest amount this company's currency can express.
     *
     * This used to be out by 1e-10. That is no longer expressible — a JOD entry
     * may not carry more than three decimals, and `createDraft` now refuses the
     * over-precise figure before posting is ever reached. The claim under test
     * is the balance check's lack of tolerance, so the imbalance is stated at
     * the currency's own smallest unit, which is the sharper version of it.
     */
    const draft = await draftOf({
      transactionDate: '2026-08-01',
      lines: [
        { accountId: cash, debit: '100.001' },
        { accountId: sales, credit: '100.000' },
      ],
    });
    await expect(
      journals.postJournal(ctx.db, orgA, draft.id, { expectedVersion: draft.version }),
    ).rejects.toThrow(/does not balance/i);
  });

  it('refuses an over-precise amount before it can ever be posted', async () => {
    // And the figure the previous test used to rely on is now caught earlier,
    // at the write, with a message about precision rather than about balance.
    await expect(
      draftOf({
        transactionDate: '2026-08-01',
        lines: [
          { accountId: cash, debit: '100.0000000001' },
          { accountId: sales, credit: '100.0000000000' },
        ],
      }),
    ).rejects.toThrow(/JOD supports a maximum of 3 decimal places/i);
  });

  it('refuses a single-line entry', async () => {
    const draft = await draftOf({ transactionDate: '2026-08-01', lines: [{ accountId: cash, debit: '5.00' }] });
    await expect(
      journals.postJournal(ctx.db, orgA, draft.id, { expectedVersion: draft.version }),
    ).rejects.toThrow(/at least two lines/i);
  });

  it('refuses an entry with no lines at all', async () => {
    const draft = await draftOf({ transactionDate: '2026-08-01', lines: [] });
    await expect(
      journals.postJournal(ctx.db, orgA, draft.id, { expectedVersion: draft.version }),
    ).rejects.toThrow(/at least two lines/i);
  });

  it('refuses a line on an inactive account', async () => {
    await accounts.updateAccount(ctx.db, orgA, sales, { active: false });
    const draft = await draftOf();
    await expect(
      journals.postJournal(ctx.db, orgA, draft.id, { expectedVersion: draft.version }),
    ).rejects.toThrow(/inactive/i);
  });

  it('refuses a line on a header account', async () => {
    const header = await accounts.createAccount(ctx.db, orgA, {
      accountCode: '1', accountName: 'Assets', accountType: 'asset', isPostable: false,
    });
    const draft = await draftOf({
      transactionDate: '2026-08-01',
      lines: [{ accountId: header.id, debit: '10.00' }, { accountId: sales, credit: '10.00' }],
    });
    await expect(
      journals.postJournal(ctx.db, orgA, draft.id, { expectedVersion: draft.version }),
    ).rejects.toThrow(/header account/i);
  });

  it('refuses an entry that is all debits or all credits', async () => {
    const draft = await draftOf({
      transactionDate: '2026-08-01',
      lines: [{ accountId: cash, debit: '10.00' }, { accountId: bank, debit: '10.00' }],
    });
    await expect(
      journals.postJournal(ctx.db, orgA, draft.id, { expectedVersion: draft.version }),
    ).rejects.toThrow(/at least one credit/i);
  });

  it('lets a draft be saved unbalanced, and refuses only at posting', async () => {
    // Work in progress must be storable. Refusing to save an unfinished entry is
    // how people end up keeping figures somewhere the ledger cannot see.
    const draft = await draftOf({
      transactionDate: '2026-08-01',
      lines: [{ accountId: cash, debit: '100.00' }],
    });
    expect(draft.status).toBe('draft');
    expect(draft.lines).toHaveLength(1);
  });

  it('refuses a malformed amount as a validation error, not a crash', async () => {
    await expect(
      journals.createDraft(ctx.db, orgA, {
        transactionDate: '2026-08-01',
        lines: [{ accountId: cash, debit: '1e5' }, { accountId: sales, credit: '100000' }],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });
});

/* ══ Period locks ══════════════════════════════════════════════════════════ */

describe('accounting periods', () => {
  const august = { fiscalYear: 2026, periodNumber: 8, startDate: '2026-08-01', endDate: '2026-08-31' };

  it('permits posting into an open period', async () => {
    await periods.createPeriod(ctx.db, orgA, august);
    const draft = await draftOf();
    expect((await journals.postJournal(ctx.db, orgA, draft.id, { expectedVersion: draft.version })).status)
      .toBe('posted');
  });

  it('refuses posting into a locked period', async () => {
    const period = await periods.createPeriod(ctx.db, orgA, august);
    const draft = await draftOf();
    await periods.setPeriodStatus(ctx.db, orgA, period.id, 'locked');
    await expect(
      journals.postJournal(ctx.db, orgA, draft.id, { expectedVersion: draft.version }),
    ).rejects.toThrow(/locked/i);
  });

  it('refuses posting into a soft-closed period but still allows a correction', async () => {
    const period = await periods.createPeriod(ctx.db, orgA, august);
    const posted = await journals.postJournal(
      ctx.db, orgA, (await draftOf()).id, { expectedVersion: 1 },
    );
    await periods.setPeriodStatus(ctx.db, orgA, period.id, 'soft_closed');

    const another = await draftOf();
    await expect(
      journals.postJournal(ctx.db, orgA, another.id, { expectedVersion: another.version }),
    ).rejects.toThrow(/closed for posting/i);

    // The month under review still accepts an authorised correction — which is
    // the whole reason soft_closed exists as a state distinct from locked.
    const amended = await journals.amendPostedJournal(
      ctx.db, orgA, posted.id, balanced('120.00'),
      { expectedVersion: posted.version, reason: 'Agreed with the reviewer' },
    );
    expect(amended.lines[0]!.debit).toBe('120.0000000000');
  });

  it('requires a reason to reopen a locked period, and records it', async () => {
    const period = await periods.createPeriod(ctx.db, orgA, august);
    await periods.setPeriodStatus(ctx.db, orgA, period.id, 'locked');
    await expect(periods.setPeriodStatus(ctx.db, orgA, period.id, 'open', 'x'))
      .rejects.toThrow(/reason/i);

    await periods.setPeriodStatus(ctx.db, orgA, period.id, 'open', 'Auditor found a misposting');
    const events = await ctx.db.selectFrom('accounting_audit_events').selectAll()
      .where('action', '=', 'PERIOD_REOPENED').execute();
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe('Auditor found a misposting');
  });

  it('posts freely when no calendar has been defined', async () => {
    // An organization that has not set up periods can still work. Refusing would
    // make the engine unusable until somebody configured twelve months.
    const draft = await draftOf();
    expect((await journals.postJournal(ctx.db, orgA, draft.id, { expectedVersion: draft.version })).status)
      .toBe('posted');
  });

  it('refuses a period that overlaps an existing one', async () => {
    await periods.createPeriod(ctx.db, orgA, august);
    await expect(
      periods.createPeriod(ctx.db, orgA, {
        fiscalYear: 2026, periodNumber: 9, startDate: '2026-08-15', endDate: '2026-09-30',
      }),
    ).rejects.toThrow(/overlaps/i);
  });
});

/* ══ Atomicity ═════════════════════════════════════════════════════════════ */

describe('posting atomicity', () => {
  it('leaves nothing behind when the audit write fails', async () => {
    /*
     * The fault is injected between the status change and the audit insert —
     * the exact window in which a non-transactional design would leave an entry
     * posted with no record of who posted it.
     */
    const draft = await draftOf();
    await expect(
      journals.postJournal(ctx.db, orgA, draft.id, { expectedVersion: draft.version }, {
        beforeAudit: async () => {
          throw new Error('injected fault: audit storage unavailable');
        },
      }),
    ).rejects.toThrow(/injected fault/);

    const after = await journals.getJournal(ctx.db, orgA, draft.id);
    expect(after.status).toBe('draft');
    expect(after.postedAt).toBeNull();
    expect(after.version).toBe(draft.version);

    // And no half-written history or audit event survived.
    const versions = await journals.listJournalHistory(ctx.db, orgA, draft.id);
    expect(versions.map((v) => v.changeKind)).toEqual(['created']);
    expect(versions.map((v) => v.version)).toEqual([1]);
    const posted = await ctx.db.selectFrom('accounting_audit_events').selectAll()
      .where('action', '=', 'JOURNAL_POSTED').execute();
    expect(posted).toHaveLength(0);
  });

  it('rolls the reversal back when the replacement fails to validate', async () => {
    const posted = await journals.postJournal(ctx.db, orgA, (await draftOf()).id, { expectedVersion: 1 });

    await expect(
      journals.reverseAndReplace(
        ctx.db, orgA, posted.id,
        // Unbalanced: the replacement cannot be posted.
        {
          transactionDate: '2026-08-01',
          lines: [{ accountId: cash, debit: '100.00' }, { accountId: sales, credit: '1.00' }],
        },
        { expectedVersion: posted.version, reason: 'Wrong customer entirely' },
      ),
    ).rejects.toThrow(/does not balance/i);

    // The original is untouched and, crucially, NOT reversed. A ledger holding a
    // reversal with no replacement has silently lost a transaction.
    const after = await journals.getJournal(ctx.db, orgA, posted.id);
    expect(after.status).toBe('posted');
    expect(after.reversalEntryId).toBeNull();
    expect(await journals.listJournals(ctx.db, orgA, {})).toHaveLength(1);
  });
});

/* ══ Optimistic concurrency ════════════════════════════════════════════════ */

describe('optimistic concurrency', () => {
  it('refuses a stale version with a conflict, not a merge', async () => {
    const draft = await draftOf();
    await journals.updateDraft(ctx.db, orgA, draft.id, balanced('200.00'), {
      expectedVersion: draft.version,
    });

    await expect(
      journals.updateDraft(ctx.db, orgA, draft.id, balanced('300.00'), {
        expectedVersion: draft.version, // what the second editor loaded
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    // The first editor's work is intact — the loser overwrites nothing.
    expect((await journals.getJournal(ctx.db, orgA, draft.id)).lines[0]!.debit).toBe('200.0000000000');
  });

  it('refuses an OMITTED version just as firmly as a stale one', async () => {
    // The bypass that matters. If leaving the token out meant "whatever is
    // current", every caller could opt out of the check by forgetting a field.
    const draft = await draftOf();
    await expect(
      journals.updateDraft(ctx.db, orgA, draft.id, balanced('200.00'), {}),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('applies the same check to posting, deleting, amending and reversing', async () => {
    const draft = await draftOf();
    await expect(journals.postJournal(ctx.db, orgA, draft.id, {})).rejects.toMatchObject({ code: 'conflict' });
    await expect(journals.deleteDraft(ctx.db, orgA, draft.id, {})).rejects.toMatchObject({ code: 'conflict' });

    const posted = await journals.postJournal(ctx.db, orgA, draft.id, { expectedVersion: draft.version });
    await expect(
      journals.amendPostedJournal(ctx.db, orgA, posted.id, balanced('1.00'), { reason: 'Corrected figure' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      journals.reverseJournal(ctx.db, orgA, posted.id, { reason: 'Corrected figure' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('increments the version on every mutation', async () => {
    const draft = await draftOf();
    expect(draft.version).toBe(1);
    const edited = await journals.updateDraft(ctx.db, orgA, draft.id, balanced('2.00'), { expectedVersion: 1 });
    expect(edited.version).toBe(2);
    const posted = await journals.postJournal(ctx.db, orgA, draft.id, { expectedVersion: 2 });
    expect(posted.version).toBe(3);
  });
});

/* ══ Version history ═══════════════════════════════════════════════════════ */

describe('version history', () => {
  it('holds a complete snapshot of every version, not just the current one', async () => {
    const draft = await draftOf(balanced('100.00'));
    await journals.updateDraft(ctx.db, orgA, draft.id, balanced('150.00'), { expectedVersion: 1 });
    await journals.postJournal(ctx.db, orgA, draft.id, { expectedVersion: 2 });

    const history = await journals.listJournalHistory(ctx.db, orgA, draft.id);
    expect(history.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(history.map((v) => v.changeKind)).toEqual(['created', 'amended', 'posted']);

    /*
     * Each row says what the entry SAID at that version, so "what did this read
     * at the time" is answered by one row rather than by replaying diffs. The
     * superseded 100.00 is still there, in version 1.
     */
    const asWritten = history[0]!.snapshot as { lines: { debit: string }[]; status: string };
    expect(asWritten.lines[0]!.debit).toBe('100.0000000000');
    expect(asWritten.status).toBe('draft');
    const asEdited = history[1]!.snapshot as { lines: { debit: string }[] };
    expect(asEdited.lines[0]!.debit).toBe('150.0000000000');
    const asPosted = history[2]!.snapshot as { status: string };
    expect(asPosted.status).toBe('posted');
  });

  it('records who made each change, and the reason for a correction', async () => {
    const posted = await journals.postJournal(ctx.db, orgA, (await draftOf()).id, { expectedVersion: 1 });
    await journals.amendPostedJournal(ctx.db, orgA, posted.id, balanced('175.00'), {
      expectedVersion: posted.version, reason: 'Invoice was restated by the customer',
    });

    const history = await journals.listJournalHistory(ctx.db, orgA, posted.id);
    const amendment = history.find((v) => v.reason !== '')!;
    expect(amendment.actorName).toBe('Ayman A');
    expect(amendment.reason).toBe('Invoice was restated by the customer');
  });
});

/* ══ Corrections ═══════════════════════════════════════════════════════════ */

describe('correcting entries', () => {
  it('never deletes a posted entry', async () => {
    const posted = await journals.postJournal(ctx.db, orgA, (await draftOf()).id, { expectedVersion: 1 });
    await expect(
      journals.deleteDraft(ctx.db, orgA, posted.id, { expectedVersion: posted.version }),
    ).rejects.toThrow(/never deleted/i);
    expect((await journals.getJournal(ctx.db, orgA, posted.id)).status).toBe('posted');
  });

  it('deletes a draft, and keeps the record of who deleted it', async () => {
    const draft = await draftOf();
    await journals.deleteDraft(ctx.db, orgA, draft.id, { expectedVersion: draft.version });
    await expect(journals.getJournal(ctx.db, orgA, draft.id)).rejects.toThrow(/not found/i);

    // The audit event outlives the record it describes — which is precisely the
    // question "who removed that draft?" that it exists to answer.
    const events = await ctx.db.selectFrom('accounting_audit_events').selectAll()
      .where('action', '=', 'JOURNAL_DELETED_DRAFT').execute();
    expect(events).toHaveLength(1);
    expect(events[0]!.actor_name).toBe('Ayman A');
  });

  it('requires a reason to amend a posted entry', async () => {
    const posted = await journals.postJournal(ctx.db, orgA, (await draftOf()).id, { expectedVersion: 1 });
    await expect(
      journals.amendPostedJournal(ctx.db, orgA, posted.id, balanced('9.00'), {
        expectedVersion: posted.version, reason: 'oops',
      }),
    ).rejects.toThrow(/reason is required/i);
  });

  it('requires an amendment to still balance', async () => {
    const posted = await journals.postJournal(ctx.db, orgA, (await draftOf()).id, { expectedVersion: 1 });
    await expect(
      journals.amendPostedJournal(ctx.db, orgA, posted.id, {
        transactionDate: '2026-08-01',
        lines: [{ accountId: cash, debit: '50.00' }, { accountId: sales, credit: '40.00' }],
      }, { expectedVersion: posted.version, reason: 'Adjusting the sale value' }),
    ).rejects.toThrow(/does not balance/i);
    // And left the posted figures alone.
    expect((await journals.getJournal(ctx.db, orgA, posted.id)).lines[0]!.debit).toBe('100.0000000000');
  });

  it('reverses an entry by mirroring every line exactly', async () => {
    const posted = await journals.postJournal(ctx.db, orgA, (await draftOf()).id, { expectedVersion: 1 });
    const { original, reversal } = await journals.reverseJournal(ctx.db, orgA, posted.id, {
      expectedVersion: posted.version, reason: 'Duplicate of JE-000001',
    });

    expect(original.status).toBe('reversed');
    expect(original.reversalEntryId).toBe(reversal.id);
    expect(reversal.status).toBe('posted');
    expect(reversal.originalEntryId).toBe(posted.id);

    const byAccount = new Map(reversal.lines.map((l) => [l.accountId, l]));
    expect(byAccount.get(cash)!.credit).toBe('100.0000000000');
    expect(byAccount.get(cash)!.debit).toBe('0.0000000000');
    expect(byAccount.get(sales)!.debit).toBe('100.0000000000');
  });

  it('refuses to reverse the same entry twice', async () => {
    const posted = await journals.postJournal(ctx.db, orgA, (await draftOf()).id, { expectedVersion: 1 });
    const { original } = await journals.reverseJournal(ctx.db, orgA, posted.id, {
      expectedVersion: posted.version, reason: 'Duplicate entry',
    });
    await expect(
      journals.reverseJournal(ctx.db, orgA, posted.id, {
        expectedVersion: original.version, reason: 'Duplicate entry',
      }),
    ).rejects.toThrow(/already been reversed/i);
  });

  it('reverses and replaces as one operation, leaving three linked entries', async () => {
    const posted = await journals.postJournal(ctx.db, orgA, (await draftOf()).id, { expectedVersion: 1 });
    const result = await journals.reverseAndReplace(
      ctx.db, orgA, posted.id,
      {
        transactionDate: '2026-08-01',
        description: 'Sale to the correct customer',
        lines: [{ accountId: bank, debit: '100.00' }, { accountId: sales, credit: '100.00' }],
      },
      { expectedVersion: posted.version, reason: 'Posted against the wrong bank account' },
    );

    expect(result.original.status).toBe('reversed');
    expect(result.original.reversalEntryId).toBe(result.reversal.id);
    expect(result.original.replacementEntryId).toBe(result.replacement.id);
    expect(result.replacement.status).toBe('posted');
    expect(result.replacement.lines.find((l) => l.accountId === bank)!.debit).toBe('100.0000000000');

    // Net effect on Cash is nil; the value now sits in Bank.
    const all = await journals.listJournals(ctx.db, orgA, {});
    expect(all).toHaveLength(3);
  });

  it('refuses to amend a journal another module owns', async () => {
    // Editing the journal alone would leave it and its source document
    // disagreeing, with nothing to say which is right.
    const draft = await journals.createDraft(ctx.db, orgA, {
      ...balanced('60.00'), sourceType: 'invoice', sourceId: orgA.userId,
    });
    const posted = await journals.postJournal(ctx.db, orgA, draft.id, { expectedVersion: draft.version });
    await expect(
      journals.amendPostedJournal(ctx.db, orgA, posted.id, balanced('70.00'), {
        expectedVersion: posted.version, reason: 'Changing the amount',
      }),
    ).rejects.toThrow(/Correct that document instead/i);
  });
});

/* ══ Amendment assessment ══════════════════════════════════════════════════ */

describe('assessing how an entry may be corrected', () => {
  it('offers direct editing for a draft', async () => {
    const draft = await draftOf();
    const assessment = await journals.assessAmendment(ctx.db, orgA, draft.id);
    expect(assessment.mode).toBe('direct_edit');
    expect(assessment.reasonRequired).toBe(false);
  });

  it('offers amendment in place for a standalone posted entry', async () => {
    const posted = await journals.postJournal(ctx.db, orgA, (await draftOf()).id, { expectedVersion: 1 });
    const assessment = await journals.assessAmendment(ctx.db, orgA, posted.id);
    expect(assessment.mode).toBe('amend_in_place');
    expect(assessment.reasonRequired).toBe(true);
  });

  it('blocks an entry a source document owns, and says which', async () => {
    const draft = await journals.createDraft(ctx.db, orgA, {
      ...balanced('60.00'), sourceType: 'invoice', sourceId: orgA.userId,
    });
    const posted = await journals.postJournal(ctx.db, orgA, draft.id, { expectedVersion: draft.version });
    const assessment = await journals.assessAmendment(ctx.db, orgA, posted.id);
    expect(assessment.mode).toBe('blocked');
    expect(assessment.explanation).toMatch(/invoice/);
  });

  it('blocks anything in a locked period, whatever its status', async () => {
    const period = await periods.createPeriod(ctx.db, orgA, {
      fiscalYear: 2026, periodNumber: 8, startDate: '2026-08-01', endDate: '2026-08-31',
    });
    const draft = await draftOf();
    await periods.setPeriodStatus(ctx.db, orgA, period.id, 'locked');
    const assessment = await journals.assessAmendment(ctx.db, orgA, draft.id);
    expect(assessment.mode).toBe('blocked');
    expect(assessment.explanation).toMatch(/locked/i);
  });

  it('does not call an entry conflicted merely because another uses the same account', async () => {
    /*
     * The distinction that keeps this feature usable. Two entries touching Cash
     * is the normal case, not a conflict — if it were, nothing in an active
     * ledger could ever be corrected.
     */
    const first = await journals.postJournal(ctx.db, orgA, (await draftOf()).id, { expectedVersion: 1 });
    await journals.postJournal(ctx.db, orgA, (await draftOf()).id, { expectedVersion: 1 });

    const assessment = await journals.assessAmendment(ctx.db, orgA, first.id);
    expect(assessment.mode).toBe('amend_in_place');
  });
});

/* ══ Exact decimals ════════════════════════════════════════════════════════ */

describe('decimal exactness', () => {
  it('keeps a three-minor-unit currency exact', async () => {
    // JOD has three, not two. A hard-coded two-decimal assumption loses a fils.
    const draft = await draftOf({
      transactionDate: '2026-08-01',
      lines: [{ accountId: cash, debit: '1234.567' }, { accountId: sales, credit: '1234.567' }],
    });
    const posted = await journals.postJournal(ctx.db, orgA, draft.id, { expectedVersion: draft.version });
    expect(posted.lines[0]!.debit).toBe('1234.5670000000');
  });

  it('keeps a very large figure exact', async () => {
    const big = '1250000000.00';
    const draft = await draftOf({
      transactionDate: '2026-08-01',
      lines: [{ accountId: cash, debit: big }, { accountId: sales, credit: big }],
    });
    const posted = await journals.postJournal(ctx.db, orgA, draft.id, { expectedVersion: draft.version });
    expect(posted.lines[0]!.debit).toBe('1250000000.0000000000');
  });

  it('balances sums that floating point would not', async () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point. In the ledger it must.
    const draft = await draftOf({
      transactionDate: '2026-08-01',
      lines: [
        { accountId: cash, debit: '0.10' },
        { accountId: bank, debit: '0.20' },
        { accountId: sales, credit: '0.30' },
      ],
    });
    expect((await journals.postJournal(ctx.db, orgA, draft.id, { expectedVersion: draft.version })).status)
      .toBe('posted');
  });

  it('records both sides of an ordinary entry at par', async () => {
    /*
     * This test used to post USD into a JOD company at 0.709. That is no longer
     * possible: an ordinary transaction is denominated in the company's own
     * currency, so both sides are the same figure and the translation is the
     * identity. See `accountingCurrencyPolicy.test.ts`, which proves the rule
     * and separately proves that the translation columns still hold a genuine
     * converted value for records that legitimately carry another currency.
     */
    const draft = await draftOf();
    const posted = await journals.postJournal(ctx.db, orgA, draft.id, { expectedVersion: draft.version });
    expect(posted.transactionCurrency).toBe('JOD');
    expect(posted.functionalCurrency).toBe('JOD');
    expect(posted.exchangeRate).toBe('1.0000000000');
    expect(posted.lines[0]!.debit).toBe('100.0000000000');
    expect(posted.lines[0]!.debitFunctional).toBe('100.0000000000');
  });
});

/* ══ Tenant isolation ══════════════════════════════════════════════════════ */

describe('tenant isolation', () => {
  it('cannot read another organization’s journal', async () => {
    const mine = await draftOf();
    // 404, not 403: answering "forbidden" would confirm the id belongs to
    // somebody, which is a cross-tenant disclosure in itself.
    await expect(journals.getJournal(ctx.db, orgB, mine.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('cannot post, amend, reverse or delete another organization’s journal', async () => {
    const mine = await draftOf();
    for (const attempt of [
      journals.postJournal(ctx.db, orgB, mine.id, { expectedVersion: 1 }),
      journals.deleteDraft(ctx.db, orgB, mine.id, { expectedVersion: 1 }),
      journals.reverseJournal(ctx.db, orgB, mine.id, { expectedVersion: 1, reason: 'Not mine at all' }),
    ]) {
      await expect(attempt).rejects.toMatchObject({ code: 'not_found' });
    }
    expect((await journals.getJournal(ctx.db, orgA, mine.id)).status).toBe('draft');
  });

  it('cannot post to an account belonging to another organization', async () => {
    const theirs = await accounts.createAccount(ctx.db, orgB, {
      accountCode: '1000', accountName: 'Their Cash', accountType: 'asset',
    });
    // Refused at draft time, as a validation error rather than a raw constraint
    // violation — and the composite foreign key stands behind that refusal.
    await expect(
      draftOf({
        transactionDate: '2026-08-01',
        lines: [{ accountId: theirs.id, debit: '10.00' }, { accountId: sales, credit: '10.00' }],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });

    const direct = sql`
      INSERT INTO journal_lines (organization_id, journal_entry_id, line_number, account_id,
                                 debit_transaction, credit_transaction, debit_functional, credit_functional)
      VALUES (${orgA.organizationId}, ${(await draftOf()).id}, 9, ${theirs.id}, 1, 0, 1, 0)
    `.execute(ctx.db);
    await expect(direct).rejects.toThrow(/journal_lines_account_same_org|foreign key/i);
  });

  it('lists only the caller’s own entries', async () => {
    await draftOf();
    await draftOf();
    expect(await journals.listJournals(ctx.db, orgB, {})).toHaveLength(0);
    expect(await journals.listJournals(ctx.db, orgA, {})).toHaveLength(2);
  });
});

/* ══ Malformed input ═══════════════════════════════════════════════════════ */

describe('malformed input', () => {
  it('answers a bad date as a validation error on every write path', async () => {
    const posted = await journals.postJournal(ctx.db, orgA, (await draftOf()).id, { expectedVersion: 1 });
    const bad = { ...balanced('10.00'), transactionDate: '01/08/2026' };

    // Without this the value reaches PostgreSQL as a failed `date` cast and is
    // reported as a server fault, for what is plainly a bad request.
    await expect(journals.createDraft(ctx.db, orgA, bad)).rejects.toMatchObject({ code: 'validation_error' });
    await expect(
      journals.amendPostedJournal(ctx.db, orgA, posted.id, bad, {
        expectedVersion: posted.version, reason: 'Correcting the date',
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('refuses a dimension that is a name rather than an identifier', async () => {
    await expect(
      draftOf({
        transactionDate: '2026-08-01',
        lines: [
          { accountId: cash, debit: '10.00', projectId: 'Head Office' },
          { accountId: sales, credit: '10.00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('refuses an exchange rate of zero', async () => {
    // Now caught by the ordinary-currency rule, which admits only par — a
    // stricter answer to the same bad input.
    await expect(
      journals.createDraft(ctx.db, orgA, { ...balanced('10.00'), exchangeRate: '0' }),
    ).rejects.toThrow(/exchange rate of 1/i);
  });
});

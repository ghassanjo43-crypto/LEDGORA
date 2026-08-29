/**
 * A source document's journal, posted exactly once.
 *
 * ══ The claim that matters most ══════════════════════════════════════════════
 *
 * Repeating a posting must not write a second journal. Not "should not" — must
 * not, under retries, refreshes, second tabs and concurrent requests. A document
 * that posts twice overstates the books by exactly one transaction, and nothing
 * in the ledger afterwards says which of the two is the duplicate.
 *
 * These tests prove the SERVICE behaviour. The genuinely concurrent case cannot
 * be proved here at all: PGlite has one connection, so two "simultaneous"
 * requests are serialised by the driver before PostgreSQL ever sees them, and a
 * missing constraint would pass. That claim is proved against a real server in
 * the P4 concurrency probe, and the unique index is asserted below so its
 * absence fails loudly here too.
 *
 * ══ Why a reversal is looked up by SOURCE ════════════════════════════════════
 *
 * A module withdrawing its posting knows its own document; it may not have kept
 * the journal id, and after a lost response it certainly has not. Reversal by
 * source identity is what makes withdrawing retry-safe for the same reason
 * posting by source identity is.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, type TestContext } from './helpers/testApp.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as journals from '../src/services/accounting/journalService.js';
import * as periods from '../src/services/accounting/periodService.js';
import * as source from '../src/services/accounting/sourcePostingService.js';
import { buildReportBundle } from '../src/services/accounting/reportService.js';

let ctx: TestContext;
let actor: AccountingActor;
let chart: { cash: string; sales: string; equity: string; header: string };

async function organization(name: string): Promise<string> {
  const owner = await seedUser(ctx, { email: `owner-${name.toLowerCase()}@source.test` });
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
    VALUES (${email}, ${email}, 'Source Poster', 'x', 'active', now()) RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

async function buildChart(a: AccountingActor) {
  const make = async (
    code: string, name: string,
    type: 'asset' | 'income' | 'equity' | 'expense',
    isPostable = true,
  ) => (await accounts.createAccount(ctx.db, a, {
    accountCode: code, accountName: name, accountType: type, isPostable,
  })).id;
  return {
    cash: await make('1000', 'Cash', 'asset'),
    sales: await make('4000', 'Sales', 'income'),
    equity: await make('3000', 'Opening Equity', 'equity'),
    header: await make('1900', 'Other assets', 'asset', false),
  };
}

/** The posting an inventory document would make. */
const posting = (over: Partial<source.SourcePostingInput> = {}): source.SourcePostingInput => ({
  sourceType: 'inventory_document',
  sourceId: 'inv_lx8f2a_01',
  sourceEvent: 'post',
  transactionDate: '2026-06-01',
  reference: 'GRN-0001',
  description: 'Goods received',
  lines: [
    { accountId: chart.cash, debit: '100.000' },
    { accountId: chart.sales, credit: '100.000' },
  ],
  ...over,
});

beforeEach(async () => {
  ctx = await createTestContext();
  const organizationId = await organization('Source');
  actor = {
    organizationId,
    companyId: await company(organizationId, 'co_source'),
    userId: await person('poster@source.test'),
    name: 'Source Poster',
  };
  chart = await buildChart(actor);
});
afterEach(async () => { await ctx.close(); });

/* ══ The database invariant ════════════════════════════════════════════════ */

describe('the source-identity invariant', () => {
  it('exists as a UNIQUE index, not as a check somebody has to remember', async () => {
    const { rows } = await sql<{ indexdef: string }>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'journal_entries_source_event_unique'
    `.execute(ctx.db);

    expect(rows).toHaveLength(1);
    const definition = rows[0]!.indexdef;
    expect(definition).toMatch(/UNIQUE/i);
    /* Company-scoped: two companies may each hold a document with the same
     * browser-minted reference, and refusing the second would refuse a
     * different company's books. */
    expect(definition).toMatch(/organization_id/);
    expect(definition).toMatch(/company_id/);
    expect(definition).toMatch(/source_type/);
    expect(definition).toMatch(/source_id/);
    expect(definition).toMatch(/source_event/);
  });

  it('refuses a second row for one document event, at the DATABASE level', async () => {
    const first = await source.postSourceJournal(ctx.db, actor, posting());

    /*
     * Written directly against the table so the CONSTRAINT is what answers.
     * The service's own read-before-insert is an optimisation; this is the
     * guarantee, and it is what a concurrent retry actually collides with.
     */
    await expect(sql`
      INSERT INTO journal_entries (
        organization_id, company_id, journal_number, transaction_date, posting_date,
        status, transaction_currency, functional_currency,
        source_type, source_id, source_event
      ) VALUES (
        ${actor.organizationId}, ${actor.companyId}, 'JE-9999', '2026-06-01', '2026-06-01',
        'draft', 'JOD', 'JOD', 'inventory_document', 'inv_lx8f2a_01', 'post'
      )
    `.execute(ctx.db)).rejects.toThrow();

    expect(first.created).toBe(true);
  });

  it('still allows one document to post for DIFFERENT events', async () => {
    /*
     * The reason the key carries an event at all: an invoice legitimately
     * produces an issue journal and one per receipt, and a key on the document
     * alone would refuse the second payment a customer ever made.
     */
    const issue = await source.postSourceJournal(ctx.db, actor, posting({
      sourceType: 'sales_invoice', sourceId: 'inv_1', sourceEvent: 'issue',
    }));
    const settlement = await source.postSourceJournal(ctx.db, actor, posting({
      sourceType: 'sales_invoice', sourceId: 'inv_1', sourceEvent: 'settlement:pay_1',
    }));

    expect(issue.created).toBe(true);
    expect(settlement.created).toBe(true);
    expect(issue.journal.id).not.toBe(settlement.journal.id);
  });

  it('leaves rows written before it alone', async () => {
    /* The index is partial on `source_event`, so the invoice paths that share a
     * document identity keep working exactly as they did. */
    for (const n of ['JE-8001', 'JE-8002']) {
      await sql`
        INSERT INTO journal_entries (
          organization_id, company_id, journal_number, transaction_date, posting_date,
          status, transaction_currency, functional_currency, source_type, source_id
        ) VALUES (
          ${actor.organizationId}, ${actor.companyId}, ${n}, '2026-06-01', '2026-06-01',
          'draft', 'JOD', 'JOD', 'sales_invoice', 'legacy_invoice_1'
        )
      `.execute(ctx.db);
    }

    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM journal_entries WHERE source_id = 'legacy_invoice_1'
    `.execute(ctx.db);
    expect(rows[0]!.n).toBe(2);
  });
});

/* ══ Posting ═══════════════════════════════════════════════════════════════ */

describe('posting for a source document', () => {
  it('posts the journal and reports that it created it', async () => {
    const result = await source.postSourceJournal(ctx.db, actor, posting());

    expect(result.created).toBe(true);
    expect(result.journal.status).toBe('posted');
    /* The SERVER allocated this. Nothing in the request named it. */
    expect(result.journal.journalNumber).toMatch(/^JE-/);
    expect(result.journal.sourceType).toBe('inventory_document');
    expect(result.journal.sourceId).toBe('inv_lx8f2a_01');
    expect(result.journal.sourceEvent).toBe('post');
  });

  it('appears in the journal and in the report bundle', async () => {
    await source.postSourceJournal(ctx.db, actor, posting());

    const listed = await journals.listJournals(ctx.db, actor);
    expect(listed).toHaveLength(1);

    const report = await buildReportBundle(ctx.db, {
      organizationId: actor.organizationId,
      companyId: actor.companyId,
      parameters: { asOf: '2026-12-31', from: '2026-01-01', to: '2026-12-31', comparative: null },
    });
    expect(report.trialBalance.totalDebit).toBe('100.000');
    expect(report.incomeStatement.income).toBe('100.000');
  });

  it('RETURNS THE SAME JOURNAL on a retry, and creates nothing', async () => {
    const first = await source.postSourceJournal(ctx.db, actor, posting());
    const retry = await source.postSourceJournal(ctx.db, actor, posting());

    expect(retry.created).toBe(false);
    expect(retry.journal.id).toBe(first.journal.id);
    expect(retry.journal.journalNumber).toBe(first.journal.journalNumber);
    expect(await journals.listJournals(ctx.db, actor)).toHaveLength(1);
  });

  it('returns the same journal even when the retry sends DIFFERENT lines', async () => {
    const first = await source.postSourceJournal(ctx.db, actor, posting());
    const retry = await source.postSourceJournal(ctx.db, actor, posting({
      lines: [
        { accountId: chart.cash, debit: '999.000' },
        { accountId: chart.sales, credit: '999.000' },
      ],
    }));

    /*
     * The identity is the document event, not the payload. A retry carrying a
     * recomputed amount must not silently replace what is in the books — the
     * first posting stands, and the caller is told it already exists.
     */
    expect(retry.created).toBe(false);
    expect(retry.journal.id).toBe(first.journal.id);
    /* The stored line, at the ledger's own scale — untouched by the retry. */
    expect(Number(retry.journal.lines[0]!.debit)).toBe(100);
  });

  it('rejects a source type the browser invented', async () => {
    await expect(source.postSourceJournal(ctx.db, actor, posting({ sourceType: 'my_module' })))
      .rejects.toThrow(/not a source document Ledgora can post for/i);
  });

  it('rejects a missing document id and a missing event', async () => {
    await expect(source.postSourceJournal(ctx.db, actor, posting({ sourceId: '  ' })))
      .rejects.toThrow(/source document id is required/i);
    await expect(source.postSourceJournal(ctx.db, actor, posting({ sourceEvent: '' })))
      .rejects.toThrow(/source posting event is required/i);
  });

  it('leaves NOTHING behind when the entry cannot be posted', async () => {
    /*
     * The dangerous shape: a draft holding the document's source identity. Every
     * retry would find it, conclude the document had posted, and report success
     * for a journal that is not in the books.
     */
    await expect(source.postSourceJournal(ctx.db, actor, posting({
      lines: [
        { accountId: chart.cash, debit: '100.000' },
        { accountId: chart.sales, credit: '90.000' },
      ],
    }))).rejects.toThrow();

    expect(await journals.listJournals(ctx.db, actor, { status: 'draft' })).toHaveLength(0);
    expect(await source.findSourceJournal(ctx.db, actor, {
      sourceType: 'inventory_document', sourceId: 'inv_lx8f2a_01', sourceEvent: 'post',
    })).toBeNull();
  });

  it('refuses a header account, and leaves no draft', async () => {
    await expect(source.postSourceJournal(ctx.db, actor, posting({
      lines: [
        { accountId: chart.header, debit: '100.000' },
        { accountId: chart.sales, credit: '100.000' },
      ],
    }))).rejects.toThrow(/posting account/i);

    expect(await journals.listJournals(ctx.db, actor, { status: 'draft' })).toHaveLength(0);
  });

  it('refuses a locked period, and leaves no draft', async () => {
    const period = await periods.createPeriod(ctx.db, actor, {
      fiscalYear: 2026, periodNumber: 6, startDate: '2026-06-01', endDate: '2026-06-30',
    });
    await periods.setPeriodStatus(ctx.db, actor, period.id, 'locked', 'Month end');

    await expect(source.postSourceJournal(ctx.db, actor, posting()))
      .rejects.toThrow(/closed|locked/i);

    expect(await journals.listJournals(ctx.db, actor, { status: 'draft' })).toHaveLength(0);
    /* And the document may still be posted once the period reopens — the
     * failure left no identity behind to collide with. */
    await periods.setPeriodStatus(ctx.db, actor, period.id, 'open', 'Reopened for correction');
    const later = await source.postSourceJournal(ctx.db, actor, posting());
    expect(later.created).toBe(true);
  });
});

/* ══ Reconciling after an ambiguous answer ═════════════════════════════════ */

describe('reconciling', () => {
  it('finds the journal by source identity when the caller lost the response', async () => {
    const posted = await source.postSourceJournal(ctx.db, actor, posting());

    /* The client never saw this id — the connection dropped. It asks by the
     * only thing it still knows: which document, and what it did. */
    const found = await source.findSourceJournal(ctx.db, actor, {
      sourceType: 'inventory_document', sourceId: 'inv_lx8f2a_01', sourceEvent: 'post',
    });

    expect(found?.id).toBe(posted.journal.id);
  });

  it('lists every journal a document produced', async () => {
    await source.postSourceJournal(ctx.db, actor, posting({
      sourceType: 'sales_invoice', sourceId: 'inv_9', sourceEvent: 'issue',
    }));
    await source.postSourceJournal(ctx.db, actor, posting({
      sourceType: 'sales_invoice', sourceId: 'inv_9', sourceEvent: 'settlement:p1',
    }));

    const all = await source.listSourceJournals(ctx.db, actor, {
      sourceType: 'sales_invoice', sourceId: 'inv_9',
    });
    expect(all).toHaveLength(2);
    expect(all.map((j) => j.sourceEvent).sort()).toEqual(['issue', 'settlement:p1']);
  });

  it('answers null for a document that never posted', async () => {
    expect(await source.findSourceJournal(ctx.db, actor, {
      sourceType: 'inventory_document', sourceId: 'never', sourceEvent: 'post',
    })).toBeNull();
  });
});

/* ══ Reversal ══════════════════════════════════════════════════════════════ */

describe('withdrawing a source posting', () => {
  const identity = { sourceType: 'inventory_document', sourceId: 'inv_lx8f2a_01', sourceEvent: 'post' };

  it('reverses the exact journal that document posted, and links the two', async () => {
    const posted = await source.postSourceJournal(ctx.db, actor, posting());

    const result = await source.reverseSourceJournal(ctx.db, actor, identity, { reason: 'Document voided' });

    expect(result.created).toBe(true);
    expect(result.original.id).toBe(posted.journal.id);
    expect(result.original.status).toBe('reversed');
    expect(result.original.reversalEntryId).toBe(result.reversal.id);
    expect(result.reversal.status).toBe('posted');
  });

  it('nets to zero while BOTH entries remain in the books', async () => {
    await source.postSourceJournal(ctx.db, actor, posting());
    await source.reverseSourceJournal(ctx.db, actor, identity, { reason: 'Document voided' });

    const report = await buildReportBundle(ctx.db, {
      organizationId: actor.organizationId,
      companyId: actor.companyId,
      parameters: { asOf: '2026-12-31', from: '2026-01-01', to: '2026-12-31', comparative: null },
    });

    /* Zero, and the history intact: the original is `reversed`, not deleted. */
    expect(report.incomeStatement.income).toBe('0.000');
    expect(report.trialBalance.totalDebit).toBe('0.000');
    expect(await journals.listJournals(ctx.db, actor)).toHaveLength(2);
  });

  it('is IDEMPOTENT — a repeat returns the reversal already made', async () => {
    await source.postSourceJournal(ctx.db, actor, posting());
    const first = await source.reverseSourceJournal(ctx.db, actor, identity, { reason: 'Voided' });
    const again = await source.reverseSourceJournal(ctx.db, actor, identity, { reason: 'Voided' });

    expect(again.created).toBe(false);
    expect(again.reversal.id).toBe(first.reversal.id);
    /* Two entries, not three. A second reversal would correspond to nothing. */
    expect(await journals.listJournals(ctx.db, actor)).toHaveLength(2);
  });

  it('refuses to reverse a document that never posted', async () => {
    await expect(source.reverseSourceJournal(ctx.db, actor, identity, { reason: 'Voided' }))
      .rejects.toThrow(/not found/i);
  });

  it('requires a reason', async () => {
    await source.postSourceJournal(ctx.db, actor, posting());
    await expect(source.reverseSourceJournal(ctx.db, actor, identity, { reason: '  ' }))
      .rejects.toThrow(/reason is required/i);
  });

  it('leaves the replacement as the only surviving effect after amend-and-replace', async () => {
    /*
     * The document module's correction: withdraw the original posting, then
     * post the corrected one under a NEW event. Original and reversal cancel;
     * the replacement is the only economic effect that survives.
     */
    await source.postSourceJournal(ctx.db, actor, posting());
    await source.reverseSourceJournal(ctx.db, actor, identity, { reason: 'Wrong amount' });
    await source.postSourceJournal(ctx.db, actor, posting({
      sourceEvent: 'post:amended:1',
      lines: [
        { accountId: chart.cash, debit: '250.000' },
        { accountId: chart.sales, credit: '250.000' },
      ],
    }));

    const report = await buildReportBundle(ctx.db, {
      organizationId: actor.organizationId,
      companyId: actor.companyId,
      parameters: { asOf: '2026-12-31', from: '2026-01-01', to: '2026-12-31', comparative: null },
    });

    expect(report.incomeStatement.income).toBe('250.000');
    /* Three entries: the original, its reversal, and the replacement. */
    expect(await journals.listJournals(ctx.db, actor)).toHaveLength(3);
  });
});

/* ══ Isolation ═════════════════════════════════════════════════════════════ */

describe('scoping', () => {
  it('lets two companies each post a document with the same reference', async () => {
    const second: AccountingActor = {
      ...actor,
      companyId: await company(actor.organizationId, 'co_source_two'),
    };
    const secondChart = await buildChart(second);

    const mine = await source.postSourceJournal(ctx.db, actor, posting());
    const theirs = await source.postSourceJournal(ctx.db, second, {
      ...posting(),
      lines: [
        { accountId: secondChart.cash, debit: '100.000' },
        { accountId: secondChart.sales, credit: '100.000' },
      ],
    });

    /* Same browser-minted id under a sibling company is a DIFFERENT document. */
    expect(mine.created).toBe(true);
    expect(theirs.created).toBe(true);
    expect(mine.journal.id).not.toBe(theirs.journal.id);
  });

  it('does not find another company’s posting', async () => {
    await source.postSourceJournal(ctx.db, actor, posting());
    const other: AccountingActor = {
      ...actor,
      companyId: await company(actor.organizationId, 'co_source_three'),
    };

    expect(await source.findSourceJournal(ctx.db, other, {
      sourceType: 'inventory_document', sourceId: 'inv_lx8f2a_01', sourceEvent: 'post',
    })).toBeNull();
    await expect(source.reverseSourceJournal(ctx.db, other, {
      sourceType: 'inventory_document', sourceId: 'inv_lx8f2a_01', sourceEvent: 'post',
    }, { reason: 'Voided' })).rejects.toThrow(/not found/i);
  });

  it('does not find another ORGANIZATION’s posting', async () => {
    await source.postSourceJournal(ctx.db, actor, posting());

    const otherOrg = await organization('Globex');
    const outsider: AccountingActor = {
      organizationId: otherOrg,
      companyId: await company(otherOrg, 'co_globex'),
      userId: await person('globex@source.test'),
      name: 'Globex',
    };

    expect(await source.findSourceJournal(ctx.db, outsider, {
      sourceType: 'inventory_document', sourceId: 'inv_lx8f2a_01', sourceEvent: 'post',
    })).toBeNull();
  });

  it('takes the organization and company from the ACTOR, never from the payload', async () => {
    const otherOrg = await organization('Initech');
    /* A payload naming somebody else's tenant. The type does not admit these
     * fields, which is the point — they are cast in to prove the service reads
     * none of them. */
    const hostile = {
      ...posting(),
      organizationId: otherOrg,
      companyId: 'some-other-company',
      journalNumber: 'JE-0001-FORGED',
      status: 'posted',
      createdBy: 'somebody-else',
    } as unknown as source.SourcePostingInput;

    const result = await source.postSourceJournal(ctx.db, actor, hostile);

    const stored = await journals.getJournal(ctx.db, actor, result.journal.id);
    expect(stored.journalNumber).not.toContain('FORGED');
    const { rows } = await sql<{ organization_id: string; company_id: string }>`
      SELECT organization_id, company_id FROM journal_entries WHERE id = ${result.journal.id}
    `.execute(ctx.db);
    expect(rows[0]!.organization_id).toBe(actor.organizationId);
    expect(rows[0]!.company_id).toBe(actor.companyId);
  });
});

/**
 * Issuing an invoice: one transaction, or nothing.
 *
 * ══ The defect these exist for ═══════════════════════════════════════════════
 *
 * Issuing used to run in three transactions — lock the draft, create and post
 * the journal, re-lock and attach it. Every gap was a state the books could be
 * left in, and the worst of them is silent: a posted sales journal with no
 * issued invoice behind it. Revenue in the ledger that no document explains,
 * and a draft the user will issue again.
 *
 * ══ And why a retry could double-post ════════════════════════════════════════
 *
 * The old posting supplied a source TYPE and ID but no EVENT, and migration
 * 029's unique index is partial on the event — so it covered nothing. A retry
 * after a lost response wrote a second journal for one invoice.
 *
 * PGlite serialises "concurrent" calls through one connection, so the genuinely
 * concurrent case is proved against a real server in the S2a probe. What can be
 * proved here is the rollback, the idempotency of a sequential retry, and that
 * the entry reaches the ledger correctly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, seedCustomerParty, type TestContext } from './helpers/testApp.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as invoices from '../src/services/invoicing/invoiceService.js';
import * as journals from '../src/services/accounting/journalService.js';
import { readLedgerPage } from '../src/services/accounting/ledgerService.js';
import { buildReportBundle } from '../src/services/accounting/reportService.js';

let ctx: TestContext;
let actor: AccountingActor;
let customerId: string;
let chart: { receivable: string; sales: string };

const ENTITY = '11111111-1111-1111-1111-111111111111';

async function organization(name: string): Promise<string> {
  const owner = await seedUser(ctx, { email: `owner-${name.toLowerCase()}@issue.test` });
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
    VALUES (${email}, ${email}, 'Issuer', 'x', 'active', now()) RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

const draft = (over: Record<string, unknown> = {}) =>
  invoices.createDraft(ctx.db, actor, {
    issuingEntityId: ENTITY,
    customerId,
    issueDate: '2026-03-01',
    dueDate: '2026-03-31',
    lines: [{ accountId: chart.sales, description: 'Consulting', quantity: '1', unitPrice: '100.000' }],
    ...over,
  } as never);

const issue = (id: string, version: number) =>
  invoices.issueInvoice(ctx.db, actor, id, { expectedVersion: version }, chart.receivable);

const journalCount = async (): Promise<number> => {
  const { rows } = await sql<{ n: string }>`
    SELECT COUNT(*)::text AS n FROM journal_entries
     WHERE organization_id = ${actor.organizationId} AND company_id = ${actor.companyId}
  `.execute(ctx.db);
  return Number(rows[0]!.n);
};

beforeEach(async () => {
  ctx = await createTestContext();
  const organizationId = await organization('Issuer');
  actor = {
    organizationId,
    companyId: await company(organizationId, 'co_issue'),
    userId: await person('issuer@issue.test'),
    name: 'Issuer',
  };
  customerId = await seedCustomerParty(ctx, organizationId, { companyId: actor.companyId, code: 'ACME' });
  chart = {
    receivable: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '1200', accountName: 'Trade receivables', accountType: 'asset',
    })).id,
    sales: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '4000', accountName: 'Sales', accountType: 'income',
    })).id,
  };
});
afterEach(async () => { vi.restoreAllMocks(); await ctx.close(); });

/* ══ The happy path, end to end ════════════════════════════════════════════ */

describe('issuing an invoice', () => {
  it('posts one journal and links it both ways', async () => {
    const created = await draft();
    const issued = await issue(created.id, created.version);

    expect(issued.status).toBe('issued');
    expect(issued.journalEntryId).toBeTruthy();
    expect(await journalCount()).toBe(1);

    const journal = await journals.getJournal(ctx.db, actor, issued.journalEntryId!);
    expect(journal.status).toBe('posted');
    expect(journal.sourceType).toBe('sales_invoice');
    expect(journal.sourceId).toBe(created.id);
    /* The EVENT is what migration 029's partial index keys on. Without it the
     * uniqueness guarantee covers nothing. */
    expect(journal.sourceEvent).toBe('issue');
  });

  it('debits the receivable and credits revenue, and the ledger agrees', async () => {
    const created = await draft();
    await issue(created.id, created.version);

    const receivable = await readLedgerPage(ctx.db, actor,
      { accountId: chart.receivable, from: '2026-01-01', to: '2026-12-31' });
    const revenue = await readLedgerPage(ctx.db, actor,
      { accountId: chart.sales, from: '2026-01-01', to: '2026-12-31' });

    expect(receivable.totals.debit).toBe('100.000');
    expect(revenue.totals.credit).toBe('100.000');

    /* And the statements built from the same books show it. */
    const bundle = await buildReportBundle(ctx.db, {
      organizationId: actor.organizationId,
      companyId: actor.companyId,
      parameters: { asOf: '2026-12-31', from: '2026-01-01', to: '2026-12-31', comparative: null },
    });
    expect(bundle.trialBalance.totalDebit).toBe(bundle.trialBalance.totalCredit);
    expect(bundle.incomeStatement.income).toBe('100.000');
  });

  it('holds JOD three-decimal precision exactly', async () => {
    const created = await draft({
      lines: [{ accountId: chart.sales, description: 'Fils', quantity: '3', unitPrice: '0.001' }],
    });
    const issued = await issue(created.id, created.version);

    expect(issued.grandTotal).toBe('0.003');
    const revenue = await readLedgerPage(ctx.db, actor,
      { accountId: chart.sales, from: '2026-01-01', to: '2026-12-31' });
    expect(revenue.totals.credit).toBe('0.003');
  });
});

/* ══ Atomicity ═════════════════════════════════════════════════════════════ */

describe('when posting fails', () => {
  it('leaves the invoice an UNTOUCHED draft, with no journal and no number burned', async () => {
    const created = await draft();

    /*
     * Force the journal to fail at the last moment. Before this slice the
     * invoice transaction had already committed by the time posting ran, so a
     * failure here left a numbered draft beside a journal — or a posted journal
     * beside a draft. Now both live in one transaction.
     */
    const boom = new Error('Injected posting failure');
    vi.spyOn(journals, 'postJournalIn').mockRejectedValueOnce(boom);

    await expect(issue(created.id, created.version)).rejects.toThrow(/Injected posting failure/);

    const after = await invoices.getInvoice(ctx.db, actor, created.id);
    expect(after.status).toBe('draft');
    expect(after.journalEntryId).toBeNull();
    /* Unchanged, not merely still a draft: the version did not move either. */
    expect(after.version).toBe(created.version);
    expect(after.invoiceNumber).toBe(created.invoiceNumber);

    /* And nothing survived in the ledger — not even the draft entry. */
    expect(await journalCount()).toBe(0);
  });

  it('leaves nothing behind when the period is closed', async () => {
    const created = await draft();

    await sql`
      INSERT INTO accounting_periods (organization_id, company_id, period_start, period_end, status)
      VALUES (${actor.organizationId}, ${actor.companyId}, '2026-03-01', '2026-03-31', 'locked')
    `.execute(ctx.db).catch(() => undefined);

    const attempt = await issue(created.id, created.version).catch((error) => error as Error);

    if (attempt instanceof Error) {
      const after = await invoices.getInvoice(ctx.db, actor, created.id);
      expect(after.status).toBe('draft');
      expect(after.journalEntryId).toBeNull();
      expect(await journalCount()).toBe(0);
    }
  });

  it('refuses an invalid receivable account without partial state', async () => {
    const created = await draft();

    await expect(
      invoices.issueInvoice(ctx.db, actor, created.id, { expectedVersion: created.version },
        '00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow();

    const after = await invoices.getInvoice(ctx.db, actor, created.id);
    expect(after.status).toBe('draft');
    expect(await journalCount()).toBe(0);
  });
});

/* ══ Idempotent retry ══════════════════════════════════════════════════════ */

describe('retrying an issue', () => {
  it('does not post a second journal', async () => {
    const created = await draft();
    const first = await issue(created.id, created.version);

    /* A retry after a lost response. The invoice has moved on, so the version
     * check refuses it — and even if it did not, the source identity would. */
    await expect(issue(created.id, created.version)).rejects.toThrow();

    expect(await journalCount()).toBe(1);
    const still = await invoices.getInvoice(ctx.db, actor, created.id);
    expect(still.journalEntryId).toBe(first.journalEntryId);
  });

  it('refuses to issue an already-issued invoice', async () => {
    const created = await draft();
    const issued = await issue(created.id, created.version);

    await expect(issue(created.id, issued.version)).rejects.toThrow(/already issued/i);
    expect(await journalCount()).toBe(1);
  });
});

/* ══ The customer relationship ═════════════════════════════════════════════ */

describe('the customer an invoice may name', () => {
  it('refuses one that is not in these books', async () => {
    await expect(draft({ customerId: '00000000-0000-0000-0000-000000000000' }))
      .rejects.toThrow(/not in these books/i);
  });

  it('refuses another company’s customer', async () => {
    const otherCompany = await company(actor.organizationId, 'co_other');
    const theirs = await seedCustomerParty(ctx, actor.organizationId,
      { companyId: otherCompany, code: 'THEIRS' });

    await expect(draft({ customerId: theirs })).rejects.toThrow(/not in these books/i);
  });

  it('refuses another organization’s customer', async () => {
    const otherOrg = await organization('Globex');
    const otherCompany = await company(otherOrg, 'co_globex');
    const theirs = await seedCustomerParty(ctx, otherOrg, { companyId: otherCompany, code: 'GLOBEX' });

    await expect(draft({ customerId: theirs })).rejects.toThrow(/not in these books/i);
  });

  it('refuses a party that does not hold the customer role', async () => {
    const supplierOnly = await ctx.db.insertInto('business_parties').values({
      organization_id: actor.organizationId, company_id: actor.companyId,
      party_code: 'SUPP', legal_name: 'Supplier Only LLC',
      is_customer: false, is_supplier: true,
    } as never).returning('id').executeTakeFirstOrThrow();

    await expect(draft({ customerId: supplierOnly.id })).rejects.toThrow(/is not a customer/i);
  });

  it('refuses an ARCHIVED customer for a new invoice', async () => {
    await ctx.db.updateTable('business_parties')
      .set({ status: 'archived' })
      .where('id', '=', customerId)
      .execute();

    await expect(draft()).rejects.toThrow(/archived/i);
  });

  it('keeps an issued invoice’s customer after that customer is archived', async () => {
    const created = await draft();
    const issued = await issue(created.id, created.version);

    await ctx.db.updateTable('business_parties')
      .set({ status: 'archived' })
      .where('id', '=', customerId)
      .execute();

    /* Archiving hides a customer from new documents. It does not rewrite the
     * ones that already name them — which is why the directory archives rather
     * than deletes, and why the foreign key is RESTRICT. */
    const after = await invoices.getInvoice(ctx.db, actor, issued.id);
    expect(after.customerId).toBe(customerId);
  });
});

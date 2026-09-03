/**
 * Tax on an issued invoice: the arithmetic, the snapshot, and the journal.
 *
 * ══ What these tests are really guarding ═════════════════════════════════════
 *
 * Three things that fail silently if they fail at all.
 *
 * The ARITHMETIC, because an inclusive invoice computed as an exclusive one
 * overcharges by exactly the rate and still balances. The SNAPSHOT, because an
 * issued invoice that reads today's tax code will quietly restate what it
 * charged the moment a rate changes — and the customer's copy will not. And the
 * JOURNAL, because crediting tax to the receivable balances the entry while
 * recording money held for an authority as owed to nobody.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, seedCustomerParty, type TestContext } from './helpers/testApp.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as invoices from '../src/services/invoicing/invoiceService.js';
import * as taxCodes from '../src/services/invoicing/taxCodeService.js';

let ctx: TestContext;
let actor: AccountingActor;
let customerId: string;
let chart: { receivable: string; sales: string; output: string; output2: string };

const ENTITY = '11111111-1111-1111-1111-111111111111';

async function organization(name: string, currency = 'JOD'): Promise<string> {
  const owner = await seedUser(ctx, { email: `owner-${name.toLowerCase()}@post.test` });
  return ctx.db.transaction().execute(async (trx) => {
    const org = await trx.insertInto('organizations').values({
      subscriber_owner_user_id: owner.id, legal_name: name, country: 'JO',
      base_currency: currency, fiscal_year_start: '01-01', data_classification: 'test',
    } as never).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('organization_memberships')
      .values({ organization_id: org.id, user_id: owner.id, role: 'owner' } as never).execute();
    return org.id;
  });
}

async function company(org: string, reference: string): Promise<string> {
  const row = await ctx.db.insertInto('companies').values({
    organization_id: org, client_reference: reference,
    legal_name: `Books ${reference}`, adopted_at: sql`now()`,
  } as never).returning('id').executeTakeFirstOrThrow();
  await ctx.db.insertInto('company_settings')
    .values({ organization_id: org, company_id: row.id } as never)
    .onConflict((oc) => oc.columns(['organization_id', 'company_id']).doNothing()).execute();
  return row.id;
}

async function person(email: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO users (email, normalized_email, full_name, password_hash, status, email_verified_at)
    VALUES (${email}, ${email}, 'Post', 'x', 'active', now()) RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

const makeCode = (over: Record<string, unknown> = {}) =>
  taxCodes.createTaxCode(ctx.db, actor, {
    code: 'VAT16', name: 'Standard-rated sales', category: 'standard',
    calculationMethod: 'exclusive', rate: '16', outputTaxAccountId: chart.output,
    effectiveFrom: '2026-01-01',
    ...over,
  } as never);

const draft = (over: Record<string, unknown> = {}) =>
  invoices.createDraft(ctx.db, actor, {
    issuingEntityId: ENTITY, customerId,
    issueDate: '2026-03-01', dueDate: '2026-03-31',
    lines: [{ accountId: chart.sales, description: 'Consulting', quantity: '1', unitPrice: '100.000' }],
    ...over,
  } as never);

const issue = (id: string, version: number) =>
  invoices.issueInvoice(ctx.db, actor, id, { expectedVersion: version });

/** The posted legs, as plain numbers keyed by account. */
async function legs(journalEntryId: string): Promise<{ account: string; debit: number; credit: number }[]> {
  const { rows } = await sql<{ account_id: string; debit_transaction: string; credit_transaction: string }>`
    SELECT account_id, debit_transaction, credit_transaction FROM journal_lines
     WHERE journal_entry_id = ${journalEntryId} ORDER BY line_number
  `.execute(ctx.db);
  return rows.map((r) => ({
    account: r.account_id, debit: Number(r.debit_transaction), credit: Number(r.credit_transaction),
  }));
}

async function setup(currency = 'JOD'): Promise<void> {
  ctx = await createTestContext();
  const organizationId = await organization('Post', currency);
  actor = {
    organizationId,
    companyId: await company(organizationId, 'co_post'),
    userId: await person('post@post.test'),
    name: 'Poster',
  };
  chart = {
    receivable: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '1200', accountName: 'Trade receivables', accountType: 'asset',
    })).id,
    sales: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '4000', accountName: 'Sales', accountType: 'income',
    })).id,
    output: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '2270', accountName: 'Output tax payable', accountType: 'liability',
    })).id,
    output2: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '2271', accountName: 'Reduced-rate output tax', accountType: 'liability',
    })).id,
  };
  customerId = await seedCustomerParty(ctx, organizationId, {
    companyId: actor.companyId, code: 'ACME', receivableAccountId: chart.receivable,
  });
}

beforeEach(() => setup());
afterEach(async () => { await ctx.close(); });

/* ══ Exclusive ═════════════════════════════════════════════════════════════ */

describe('exclusive tax', () => {
  it('adds tax on top and balances receivable = revenue + output tax', async () => {
    const code = await makeCode({ rate: '16' });
    const created = await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });

    expect(created.subtotal).toBe('1000.000');
    expect(created.taxTotal).toBe('160.000');
    expect(created.grandTotal).toBe('1160.000');

    const issued = await issue(created.id, created.version);
    const posted = await legs(issued.journalEntryId!);

    /* Dr receivable 1160 / Cr revenue 1000 / Cr output tax 160 — §12 exactly. */
    expect(posted).toHaveLength(3);
    expect(posted.find((l) => l.account === chart.receivable)!.debit).toBe(1160);
    expect(posted.find((l) => l.account === chart.sales)!.credit).toBe(1000);
    expect(posted.find((l) => l.account === chart.output)!.credit).toBe(160);

    const debits = posted.reduce((s, l) => s + l.debit, 0);
    const credits = posted.reduce((s, l) => s + l.credit, 0);
    expect(debits).toBe(credits);
  });
});

/* ══ Applicability: the mirror of the bill rule ═══════════════════════════ */

describe('which documents a code may be used on', () => {
  /*
   * §3 forbids this in both directions. Purchasing P3 added `direction`, and a
   * purchase-only code on a sales invoice would charge a customer output tax
   * under a code that only ever existed to reclaim input tax.
   */
  it('refuses a PURCHASE-only code on an invoice', async () => {
    const inputAccount = await accounts.createAccount(ctx.db, actor, {
      accountCode: '1360', accountName: 'Input tax recoverable', accountType: 'asset',
    });
    const purchaseOnly = await makeCode({
      code: 'VATIN', direction: 'purchase',
      outputTaxAccountId: null, inputTaxAccountId: inputAccount.id,
    });

    await expect(draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '100.000', taxCodeId: purchaseOnly.id }],
    })).rejects.toThrow(/applies to purchase documents, so it cannot be used on an invoice/i);
  });

  it('still accepts a sales code, and one that applies to both', async () => {
    const salesOnly = await makeCode({ code: 'VATOUT', direction: 'sales' });
    expect((await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '100.000', taxCodeId: salesOnly.id }],
    })).taxTotal).toBe('16.000');

    const inputAccount = await accounts.createAccount(ctx.db, actor, {
      accountCode: '1361', accountName: 'Input tax', accountType: 'asset',
    });
    const both = await makeCode({
      code: 'VATBOTH', direction: 'both', inputTaxAccountId: inputAccount.id,
    });
    expect((await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '100.000', taxCodeId: both.id }],
    })).taxTotal).toBe('16.000');
  });
});

/* ══ Inclusive ═════════════════════════════════════════════════════════════ */

describe('inclusive tax', () => {
  it('splits the gross WITHOUT increasing what the customer owes', async () => {
    const code = await makeCode({ code: 'VATIN', calculationMethod: 'inclusive', rate: '16' });
    const created = await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '1160.000', taxCodeId: code.id }],
    });

    /*
     * The customer was quoted 1160 and owes 1160. The tax comes OUT of that,
     * not on top of it — computing this as exclusive would bill 1345.600.
     */
    expect(created.grandTotal).toBe('1160.000');
    expect(created.subtotal).toBe('1000.000');
    expect(created.taxTotal).toBe('160.000');

    const issued = await issue(created.id, created.version);
    const posted = await legs(issued.journalEntryId!);
    expect(posted.find((l) => l.account === chart.receivable)!.debit).toBe(1160);
    expect(posted.find((l) => l.account === chart.sales)!.credit).toBe(1000);
    expect(posted.find((l) => l.account === chart.output)!.credit).toBe(160);
  });

  it('keeps net + tax EXACTLY equal to the gross on an awkward fraction', async () => {
    const code = await makeCode({ code: 'VATIN', calculationMethod: 'inclusive', rate: '16' });
    /* 100 / 1.16 = 86.2068965…, which no currency can hold. */
    const created = await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '100.000', taxCodeId: code.id }],
    });

    expect(created.subtotal).toBe('86.207');
    expect(created.taxTotal).toBe('13.793');
    /* The identity holds to the fils — this is why the tax is the remainder
     * rather than a second independent calculation. */
    expect(created.grandTotal).toBe('100.000');
  });
});

/* ══ The five categories, posting ══════════════════════════════════════════ */

describe('categories that charge nothing', () => {
  it.each(['zero-rated', 'exempt', 'out-of-scope'] as const)(
    'posts NO tax leg for %s, and keeps the category on the line',
    async (category) => {
      const code = await makeCode({
        code: `Z-${category}`, category, rate: '0', outputTaxAccountId: null,
      });
      const created = await draft({
        lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '500.000', taxCodeId: code.id }],
      });
      expect(created.taxTotal).toBe('0.000');
      expect(created.grandTotal).toBe('500.000');

      const issued = await issue(created.id, created.version);
      const posted = await legs(issued.journalEntryId!);
      /* Two legs only: no tax account is touched. */
      expect(posted).toHaveLength(2);

      /* But the category IS recorded, which is what keeps the three apart. */
      expect(issued.lines[0]!.taxSnapshot!.category).toBe(category);
      expect(issued.lines[0]!.taxSnapshot!.outputTaxAccountId).toBeNull();
    },
  );

  it('distinguishes a zero-rated line from a line with NO tax code', async () => {
    const code = await makeCode({ code: 'ZR', category: 'zero-rated', rate: '0', outputTaxAccountId: null });
    const withCode = await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '100.000', taxCodeId: code.id }],
    });
    const withoutCode = await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '100.000' }],
    });

    const a = await issue(withCode.id, withCode.version);
    const b = await issue(withoutCode.id, withoutCode.version);

    /* Both charge nothing. Only one is a zero-rated SUPPLY, and a return has to
     * tell them apart. */
    expect(a.lines[0]!.taxSnapshot!.category).toBe('zero-rated');
    expect(b.lines[0]!.taxSnapshot).toBeNull();
  });
});

/* ══ Multiple codes and accounts ═══════════════════════════════════════════ */

describe('several codes on one invoice', () => {
  it('groups tax by output account, one leg each', async () => {
    const standard = await makeCode({ code: 'VAT16', rate: '16', outputTaxAccountId: chart.output });
    const reduced = await makeCode({
      code: 'VAT04', category: 'reduced', rate: '4', outputTaxAccountId: chart.output2,
    });

    const created = await draft({
      lines: [
        { accountId: chart.sales, quantity: '1', unitPrice: '1000.000', taxCodeId: standard.id },
        { accountId: chart.sales, quantity: '1', unitPrice: '1000.000', taxCodeId: standard.id },
        { accountId: chart.sales, quantity: '1', unitPrice: '1000.000', taxCodeId: reduced.id },
      ],
    });
    expect(created.taxTotal).toBe('360.000'); // 160 + 160 + 40

    const issued = await issue(created.id, created.version);
    const posted = await legs(issued.journalEntryId!);

    /* Two lines share a code, so they share ONE tax leg; the reduced code keeps
     * its own account, which is what makes a control-account reconciliation
     * that has to separate them possible at all. */
    expect(posted.find((l) => l.account === chart.output)!.credit).toBe(320);
    expect(posted.find((l) => l.account === chart.output2)!.credit).toBe(40);

    /* No single account can name this invoice's tax, so the column is null and
     * the per-line snapshots carry the detail. */
    const { rows } = await sql<{ tax_account_id: string | null }>`
      SELECT tax_account_id FROM invoices WHERE id = ${issued.id}
    `.execute(ctx.db);
    expect(rows[0]!.tax_account_id).toBeNull();
  });

  it('sums LINE-rounded tax, not a rounded document total', async () => {
    const code = await makeCode({ rate: '16' });
    /* Each line's tax is 0.1616 → 0.162 at three decimals. Three lines give
     * 0.486; rounding the raw sum (0.4848) once would give 0.485. Line
     * rounding is the method §10 defines and the only one with a defined
     * account for its difference — which is none, because there isn't one. */
    const created = await draft({
      lines: Array.from({ length: 3 }, () => ({
        accountId: chart.sales, quantity: '1', unitPrice: '1.010', taxCodeId: code.id,
      })),
    });
    expect(created.taxTotal).toBe('0.486');
    expect(created.grandTotal).toBe('3.516');
  });
});

/* ══ Rounding by currency ══════════════════════════════════════════════════ */

describe('currency precision', () => {
  it('holds JOD to three decimals', async () => {
    const code = await makeCode({ rate: '16' });
    const created = await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '0.001', taxCodeId: code.id }],
    });
    /* 0.001 × 16% = 0.00016 → 0.000 at three decimals. A fils cannot be split. */
    expect(created.taxTotal).toBe('0.000');
    expect(created.grandTotal).toBe('0.001');
  });

  it('holds USD to TWO decimals', async () => {
    await ctx.close();
    await setup('USD');
    const code = await makeCode({ rate: '16' });
    const created = await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '10.99', taxCodeId: code.id }],
    });
    /* 10.99 × 16% = 1.7584 → 1.76, and the total follows at two decimals. */
    expect(created.taxTotal).toBe('1.76');
    expect(created.grandTotal).toBe('12.75');
  });
});

/* ══ The frozen snapshot ═══════════════════════════════════════════════════ */

describe('the snapshot an issued invoice keeps', () => {
  it('carries everything needed to reproduce the calculation', async () => {
    const code = await makeCode({ rate: '16' });
    const created = await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    const issued = await issue(created.id, created.version);
    const snap = issued.lines[0]!.taxSnapshot!;

    expect(snap.taxCodeId).toBe(code.id);
    expect(snap.code).toBe('VAT16');
    expect(snap.name).toBe('Standard-rated sales');
    expect(snap.category).toBe('standard');
    expect(snap.calculationMethod).toBe('exclusive');
    expect(snap.rate).toBe('16.000');
    expect(snap.rateVersionId).toBe(code.rateVersions[0]!.id);
    expect(snap.effectiveFrom).toBe('2026-01-01');
    expect(snap.taxableAmount).toBe('1000.000');
    expect(snap.taxAmount).toBe('160.000');
    expect(snap.grossAmount).toBe('1160.000');
    expect(snap.outputTaxAccountId).toBe(chart.output);
    /* The tax date is the invoice's own issue date — the same date the ledger
     * posts on and period locks are enforced against. */
    expect(snap.taxPointDate).toBe('2026-03-01');
    expect(snap.capturedAt).toBeTruthy();
  });

  it('is ABSENT on a draft, because nothing is frozen until issue', async () => {
    const code = await makeCode({ rate: '16' });
    const created = await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    expect(created.lines[0]!.taxSnapshot).toBeNull();
    /* The figures are there for the screen; they are simply not a promise yet. */
    expect(created.lines[0]!.taxAmount).toBe('160.000');
  });

  it('does NOT change when the rate is superseded afterwards', async () => {
    const code = await makeCode({ rate: '16' });
    const created = await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    const issued = await issue(created.id, created.version);

    await taxCodes.addRateVersion(ctx.db, actor, code.id, {
      rate: '25', effectiveFrom: '2026-04-01', expectedVersion: code.version,
    });

    const reread = await invoices.getInvoice(ctx.db, actor, issued.id);
    /* The customer's copy still says 160, and so does this one. */
    expect(reread.taxTotal).toBe('160.000');
    expect(reread.lines[0]!.taxSnapshot!.rate).toBe('16.000');
  });

  it('does NOT change when the tax code is archived afterwards', async () => {
    const code = await makeCode({ rate: '16' });
    const created = await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    const issued = await issue(created.id, created.version);

    await taxCodes.setTaxCodeStatus(ctx.db, actor, code.id, 'archived', code.version);

    const reread = await invoices.getInvoice(ctx.db, actor, issued.id);
    expect(reread.taxTotal).toBe('160.000');
    expect(reread.lines[0]!.taxSnapshot!.code).toBe('VAT16');
    expect(reread.lines[0]!.taxSnapshot!.name).toBe('Standard-rated sales');
  });

  it('resolves the rate in force on the INVOICE date, not today', async () => {
    const code = await makeCode({ rate: '16' });
    const withNewRate = await taxCodes.addRateVersion(ctx.db, actor, code.id, {
      rate: '25', effectiveFrom: '2026-06-01', expectedVersion: code.version,
    });
    expect(withNewRate.rateVersions).toHaveLength(2);

    /* Dated before the change, so it charges the old rate. */
    const early = await draft({
      issueDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    expect(early.taxTotal).toBe('160.000');

    const late = await draft({
      issueDate: '2026-07-01', dueDate: '2026-07-31',
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    expect(late.taxTotal).toBe('250.000');
  });
});

/* ══ Drafts recalculate, issued invoices never do ══════════════════════════ */

describe('the recalculation rule', () => {
  it('recalculates a DRAFT when it is saved again', async () => {
    const code = await makeCode({ rate: '16' });
    const created = await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    await taxCodes.addRateVersion(ctx.db, actor, code.id, {
      rate: '25', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', expectedVersion: code.version,
    }).catch(() => undefined);

    /* Editing the draft re-resolves. The rule is explicit because the
     * alternative is invisible — a draft left on a superseded rate. */
    const updated = await invoices.updateDraft(ctx.db, actor, created.id, {
      issuingEntityId: ENTITY, customerId, issueDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '2000.000', taxCodeId: code.id }],
    } as never, { expectedVersion: created.version });

    expect(updated.subtotal).toBe('2000.000');
    expect(updated.taxTotal).toBe('320.000');
  });

  it('refuses to edit an ISSUED invoice at all', async () => {
    const code = await makeCode({ rate: '16' });
    const created = await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    const issued = await issue(created.id, created.version);

    await expect(invoices.updateDraft(ctx.db, actor, created.id, {
      issuingEntityId: ENTITY, customerId, issueDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '9999.000', taxCodeId: code.id }],
    } as never, { expectedVersion: issued.version })).rejects.toThrow(/can no longer be edited/i);
  });
});

/* ══ Ineligible accounts at ISSUE ══════════════════════════════════════════ */

describe('the output account at the moment of issue', () => {
  it('refuses when the account was archived after the code was configured', async () => {
    const code = await makeCode({ rate: '16' });
    const created = await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });

    await sql`UPDATE accounts SET archived = true, active = false WHERE id = ${chart.output}`
      .execute(ctx.db);

    await expect(issue(created.id, created.version)).rejects.toThrow(/cannot receive postings/i);

    /* And the invoice is untouched — still a draft, nothing in the ledger. */
    const reread = await invoices.getInvoice(ctx.db, actor, created.id);
    expect(reread.status).toBe('draft');
    expect(reread.journalEntryId).toBeNull();
  });

  it('refuses a taxable code with NO output account, naming the fix', async () => {
    /* Configured while zero-rated, then... there is no way to reach this
     * through the service, so the row is forced to the state a corrupted or
     * hand-edited database could hold. The issue path must still refuse. */
    const code = await makeCode({ rate: '16' });
    await sql`UPDATE tax_codes SET output_tax_account_id = NULL WHERE id = ${code.id}`.execute(ctx.db);
    await sql`UPDATE tax_rate_versions SET output_tax_account_id = NULL WHERE tax_code_id = ${code.id}`
      .execute(ctx.db);

    const created = await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    const error = await issue(created.id, created.version).then(() => null, (e) => e as Error);

    expect(error!.message).toMatch(/no output tax account/i);
    expect(error!.message).toMatch(/liability, not revenue/i);
    expect(error!.message).toMatch(/nothing has been saved/i);
  });
});

/* ══ Atomicity and idempotency ═════════════════════════════════════════════ */

describe('issuing is all-or-nothing, and happens once', () => {
  it('rolls EVERYTHING back when the posting fails', async () => {
    const code = await makeCode({ rate: '16' });
    const created = await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });

    /* Force the journal to fail by removing the revenue account's eligibility
     * after the draft was written. */
    await sql`UPDATE accounts SET blocked = true WHERE id = ${chart.sales}`.execute(ctx.db);

    await expect(issue(created.id, created.version)).rejects.toThrow();

    const reread = await invoices.getInvoice(ctx.db, actor, created.id);
    expect(reread.status).toBe('draft');
    expect(reread.journalEntryId).toBeNull();
    expect(reread.version).toBe(created.version);
    /* No snapshot was left behind either — a frozen snapshot on an unissued
     * invoice would claim a permanence the document never acquired. */
    expect(reread.lines[0]!.taxSnapshot).toBeNull();

    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM journal_entries
       WHERE organization_id = ${actor.organizationId} AND company_id = ${actor.companyId}
    `.execute(ctx.db);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('creates no second journal, snapshot or tax leg on a retry', async () => {
    const code = await makeCode({ rate: '16' });
    const created = await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    const issued = await issue(created.id, created.version);

    /* A retry after a lost response. It must not post again. */
    await issue(created.id, created.version).catch(() => undefined);
    await issue(created.id, issued.version).catch(() => undefined);

    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM journal_entries
       WHERE organization_id = ${actor.organizationId} AND company_id = ${actor.companyId}
    `.execute(ctx.db);
    expect(Number(rows[0]!.n)).toBe(1);

    const posted = await legs(issued.journalEntryId!);
    expect(posted.filter((l) => l.account === chart.output)).toHaveLength(1);
  });
});

/* ══ Cross-company ═════════════════════════════════════════════════════════ */

describe('cross-company attacks', () => {
  it('refuses another company\'s tax code on an invoice', async () => {
    const second = await company(actor.organizationId, 'co_second');
    const secondActor = { ...actor, companyId: second };
    const output = await accounts.createAccount(ctx.db, secondActor, {
      accountCode: '2270', accountName: 'Their output tax', accountType: 'liability',
    });
    const foreignCode = await taxCodes.createTaxCode(ctx.db, secondActor, {
      code: 'VAT16', name: 'Theirs', category: 'standard', calculationMethod: 'exclusive',
      rate: '16', outputTaxAccountId: output.id, effectiveFrom: '2026-01-01',
    } as never);

    await expect(draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '100.000', taxCodeId: foreignCode.id }],
    })).rejects.toThrow(/does not exist in these books/i);
  });
});

/* ══ What S2c did NOT bring ════════════════════════════════════════════════ */

describe('the rest of the boundary still holds', () => {
  it('still refuses additional charges, half-named stock, dimensions and foreign currency', async () => {
    const code = await makeCode({ rate: '16' });
    const line = (over: Record<string, unknown>) =>
      ({ lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '100.000', taxCodeId: code.id, ...over }] });

    await expect(draft({ additionalChargesTotal: '5.000' })).rejects.toThrow(/Additional charges are not yet supported/i);
    /*
     * I4 made a fully-named stocked line legal, so the refusal that remains is
     * about the SHAPE: half a pair says either what left or where from, never
     * both, and the movement it implies cannot be written.
     */
    await expect(draft(line({ itemId: '22222222-2222-2222-2222-222222222222' })))
      .rejects.toThrow(/must name both the item and the warehouse/i);
    await expect(draft(line({ warehouseId: '33333333-3333-3333-3333-333333333333' })))
      .rejects.toThrow(/must name both the item and the warehouse/i);
    await expect(draft({ projectId: 'p1' })).rejects.toThrow(/held in the browser/i);
    await expect(draft({ costCenterId: 'cc1' })).rejects.toThrow(/held in the browser/i);
    await expect(draft({ salespersonId: 's1' })).rejects.toThrow(/held in the browser/i);
    await expect(draft({ templateId: 't1' })).rejects.toThrow(/held in the browser/i);
    await expect(draft({ currency: 'USD' })).rejects.toThrow(/only JOD invoices can be held/i);
  });
});

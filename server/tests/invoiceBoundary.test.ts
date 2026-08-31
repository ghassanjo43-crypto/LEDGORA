/**
 * What a durable sales invoice may contain — and what is refused, not dropped.
 *
 * ══ Why refusal rather than omission ═════════════════════════════════════════
 *
 * Every field below names a record the server cannot verify or an amount it
 * cannot derive. The tempting alternative is to accept the invoice and store
 * nothing for the tax, the project, the warehouse. That is much the worse
 * failure: the user sees a document they believe carries a cost centre and a
 * tax charge, the books carry neither, and nothing says so. A refusal is
 * recoverable; a silently different invoice is discovered at an audit.
 *
 * The tax case is the sharpest. Converting a taxable invoice to a zero-tax one
 * would understate output tax on a document the customer receives and a tax
 * authority may clear — so it is refused outright, and these tests hold it to
 * that rather than to "the tax came out as zero".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, seedCustomerParty, type TestContext } from './helpers/testApp.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as invoices from '../src/services/invoicing/invoiceService.js';

let ctx: TestContext;
let actor: AccountingActor;
let customerId: string;
let chart: { receivable: string; sales: string };

const ENTITY = '11111111-1111-1111-1111-111111111111';

async function organization(name: string): Promise<string> {
  const owner = await seedUser(ctx, { email: `owner-${name.toLowerCase()}@bound.test` });
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
    VALUES (${email}, ${email}, 'Boundary', 'x', 'active', now()) RETURNING id
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

const invoiceCount = async (): Promise<number> => {
  const { rows } = await sql<{ n: string }>`
    SELECT COUNT(*)::text AS n FROM invoices
     WHERE organization_id = ${actor.organizationId} AND company_id = ${actor.companyId}
  `.execute(ctx.db);
  return Number(rows[0]!.n);
};

beforeEach(async () => {
  ctx = await createTestContext();
  const organizationId = await organization('Bound');
  actor = {
    organizationId,
    companyId: await company(organizationId, 'co_bound'),
    userId: await person('bound@bound.test'),
    name: 'Boundary',
  };
  chart = {
    receivable: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '1200', accountName: 'Trade receivables', accountType: 'asset',
    })).id,
    sales: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '4000', accountName: 'Sales', accountType: 'income',
    })).id,
  };
  customerId = await seedCustomerParty(ctx, organizationId, {
    companyId: actor.companyId, code: 'ACME', receivableAccountId: chart.receivable,
  });
});
afterEach(async () => { await ctx.close(); });

/* ══ Tax: the code is the client's, every figure is the server's ═════════ */

describe('who decides the tax on a durable invoice', () => {
  /*
   * S2b refused tax outright, because the server could not compute it. S2c can,
   * so the refusal MOVED rather than disappeared: what is refused now is the
   * client telling the server what the answer is. These tests pin the new line,
   * and the ones that follow still pin everything S2c did not bring.
   */
  it('REFUSES a client-supplied rate — that figure belongs to the server', async () => {
    await expect(draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '100.000', taxRate: '16' }],
    })).rejects.toThrow(/supplies a rate for its tax/i);

    /* And nothing was written. A refusal that leaves a draft behind is not a
     * refusal, it is a half-saved invoice. */
    expect(await invoiceCount()).toBe(0);
  });

  it('refuses a client-supplied tax amount', async () => {
    await expect(draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '100.000', taxAmount: '16.000' }],
    })).rejects.toThrow(/supplies an amount for its tax/i);
    expect(await invoiceCount()).toBe(0);
  });

  it('refuses a ZERO rate too — that is still an assertion about the tax', async () => {
    /*
     * The tempting exception. "0" is refused with every other figure because a
     * zero from a client that believed the supply was exempt is exactly the
     * mistake a server-resolved category exists to prevent.
     */
    await expect(draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '100.000', taxRate: '0' }],
    })).rejects.toThrow(/supplies a rate for its tax/i);
    expect(await invoiceCount()).toBe(0);
  });

  it('says WHY, so the message is actionable rather than a bare refusal', async () => {
    const error = await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '100.000', taxRate: '16' }],
    }).then(() => null, (e) => e as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toMatch(/calculated by the server/i);
    expect(error!.message).toMatch(/send the tax code alone/i);
    expect(error!.message).toMatch(/nothing has been saved/i);
  });

  it('refuses a tax code from ANOTHER company', async () => {
    await expect(draft({
      lines: [{
        accountId: chart.sales, quantity: '1', unitPrice: '100.000',
        taxCodeId: '33333333-3333-3333-3333-333333333333',
      }],
    })).rejects.toThrow(/does not exist in these books/i);
    expect(await invoiceCount()).toBe(0);
  });

  it('ACCEPTS a line with no tax code at all', async () => {
    const created = await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '100.000' }],
    });
    expect(created.taxTotal).toBe('0.000');
    expect(created.grandTotal).toBe('100.000');
    /* No code means no tax — which is NOT the same as a zero-rated supply, and
     * the absent snapshot is how the two stay distinguishable. */
    expect(created.lines[0]!.taxSnapshot).toBeNull();
  });
});

/* ══ Charges, stock, and browser-resident dimensions ══════════════════════ */

describe('unsupported dependencies', () => {
  it('refuses additional charges, naming the missing account model', async () => {
    await expect(draft({ additionalChargesTotal: '5.000' }))
      .rejects.toThrow(/no controlled account for them/i);
    expect(await invoiceCount()).toBe(0);
  });

  it('refuses a stocked line by its SHAPE, not by a client flag', async () => {
    /* The line names an item, so it could move stock. That is a property of
     * what was sent rather than a claim the client makes about itself. */
    await expect(draft({
      lines: [{
        accountId: chart.sales, quantity: '1', unitPrice: '100.000',
        itemId: '44444444-4444-4444-4444-444444444444',
      }],
    })).rejects.toThrow(/stock movements and cost of sales/i);
    expect(await invoiceCount()).toBe(0);
  });

  it('refuses a project, a cost centre, a salesperson and a template', async () => {
    for (const field of ['projectId', 'costCenterId', 'salespersonId', 'templateId']) {
      await expect(draft({ [field]: '55555555-5555-5555-5555-555555555555' }))
        .rejects.toThrow(/held in the browser and cannot be verified/i);
    }
    await expect(draft({
      lines: [{
        accountId: chart.sales, quantity: '1', unitPrice: '100.000',
        costCenterId: '55555555-5555-5555-5555-555555555555',
      }],
    })).rejects.toThrow(/held in the browser and cannot be verified/i);
    expect(await invoiceCount()).toBe(0);
  });

  it('refuses a foreign currency rather than converting it at par', async () => {
    await expect(draft({ currency: 'USD' }))
      .rejects.toThrow(/only JOD invoices can be held on the server/i);
    expect(await invoiceCount()).toBe(0);
  });
});

/* ══ What the client may not decide ════════════════════════════════════════ */

describe('server-owned fields', () => {
  it('refuses a client-chosen status', async () => {
    await expect(draft({ status: 'issued' })).rejects.toThrow(/set by issuing or voiding it/i);
  });

  it('refuses a client-chosen invoice number', async () => {
    await expect(draft({ invoiceNumber: 'INV-9999-0001' }))
      .rejects.toThrow(/allocated by the server/i);
  });

  it('ignores client totals and computes its own', async () => {
    /* Sent deliberately wrong. The server recomputes from quantity, price and
     * discount, so the lie never reaches the books. */
    const created = await draft({
      subtotal: '1.000', grandTotal: '1.000', taxTotal: '999.000',
      lines: [{ accountId: chart.sales, quantity: '2', unitPrice: '30.000' }],
    });

    expect(created.subtotal).toBe('60.000');
    expect(created.grandTotal).toBe('60.000');
    expect(created.taxTotal).toBe('0.000');
  });
});

/* ══ The arithmetic the server does own ═══════════════════════════════════ */

describe('exact-decimal calculation', () => {
  it('computes a percentage discount at JOD precision', async () => {
    const created = await draft({
      lines: [{
        accountId: chart.sales, quantity: '3', unitPrice: '33.333',
        discountType: 'percentage', discountValue: '10',
      }],
    });

    /* 3 × 33.333 = 99.999; less 10% = 89.9991 → 89.999 at three decimals. */
    expect(created.subtotal).toBe('89.999');
    expect(created.grandTotal).toBe('89.999');
  });

  it('computes a fixed discount', async () => {
    const created = await draft({
      lines: [{
        accountId: chart.sales, quantity: '1', unitPrice: '100.000',
        discountType: 'amount', discountValue: '0.001',
      }],
    });
    expect(created.subtotal).toBe('99.999');
  });

  it('refuses a discount larger than the line', async () => {
    await expect(draft({
      lines: [{
        accountId: chart.sales, quantity: '1', unitPrice: '10.000',
        discountType: 'amount', discountValue: '11.000',
      }],
    })).rejects.toThrow(/discount exceeds the line value/i);
  });

  it('holds a single fils exactly', async () => {
    const created = await draft({
      lines: [{ accountId: chart.sales, quantity: '1', unitPrice: '0.001' }],
    });
    expect(created.grandTotal).toBe('0.001');
  });
});

/* ══ Revenue accounts ═════════════════════════════════════════════════════ */

describe('the accounts a line may credit', () => {
  it('refuses an account from another company', async () => {
    const otherCompany = await company(actor.organizationId, 'co_elsewhere');
    const theirs = await accounts.createAccount(ctx.db,
      { ...actor, companyId: otherCompany },
      { accountCode: '4000', accountName: 'Their sales', accountType: 'income' });

    await expect(draft({
      lines: [{ accountId: theirs.id, quantity: '1', unitPrice: '10.000' }],
    })).rejects.toThrow();
    expect(await invoiceCount()).toBe(0);
  });

  it('refuses an account that does not exist', async () => {
    await expect(draft({
      lines: [{ accountId: '66666666-6666-6666-6666-666666666666', quantity: '1', unitPrice: '10.000' }],
    })).rejects.toThrow();
  });
});

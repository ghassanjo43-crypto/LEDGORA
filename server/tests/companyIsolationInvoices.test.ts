/**
 * Invoices, across two companies of ONE subscriber.
 *
 * ══ The specific hole this closes ════════════════════════════════════════════
 *
 * Every invoice WRITE was gated by `lockInvoice`, which is company-scoped and
 * takes the row lock — so no invoice could ever be corrupted across companies.
 * But `voidInvoice` performed a pre-flight READ before that transaction, scoped
 * by organization alone. It disclosed another company's invoice number, status
 * and journal id, and could answer "this invoice is already void" for a
 * document the caller must not know exists.
 *
 * An information leak is quieter than a corruption and just as much a breach of
 * the boundary, so it gets the same treatment: `not_found`, identical to an
 * invoice that was never issued.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, type TestContext, seedCustomerParty } from './helpers/testApp.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as invoices from '../src/services/invoicing/invoiceService.js';

let ctx: TestContext;
let organizationId: string;
let northCustomer: string;
let southCustomer: string;
let north: AccountingActor;
let south: AccountingActor;

async function organization(name: string): Promise<string> {
  const owner = await seedUser(ctx, { email: `${name}@inv-isolation.test` });
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
  const who = await person('books@inv-isolation.test');
  north = {
    organizationId, companyId: await company(organizationId, 'co_north', 'Northern Trading'),
    userId: who, name: 'Bookkeeper',
  };
  south = {
    organizationId, companyId: await company(organizationId, 'co_south', 'Southern Logistics'),
    userId: who, name: 'Bookkeeper',
  };

  /*
   * One customer per COMPANY, not one shared between them.
   *
   * A business party belongs to a single set of books — that is what migration
   * 031's composite foreign key enforces — so these two companies cannot name
   * the same customer, which is itself the isolation this file is about.
   */
  northCustomer = await seedCustomerParty(ctx, organizationId, { companyId: north.companyId, code: 'NORTH-CUST' });
  southCustomer = await seedCustomerParty(ctx, organizationId, { companyId: south.companyId, code: 'SOUTH-CUST' });
});
afterEach(async () => { await ctx.close(); });

async function chart(actor: AccountingActor) {
  const receivable = await accounts.createAccount(ctx.db, actor, {
    accountCode: '1200', accountName: 'Receivable', accountType: 'asset',
  });
  const sales = await accounts.createAccount(ctx.db, actor, {
    accountCode: '4000', accountName: 'Sales', accountType: 'income',
  });
  return { receivable: receivable.id, sales: sales.id };
}

/** A draft invoice in NORTH's books. */
async function northsInvoice() {
  const a = await chart(north);
  const draft = await invoices.createDraft(ctx.db, north, {
    issuingEntityId: '11111111-1111-1111-1111-111111111111',
    customerId: northCustomer,
    issueDate: '2026-03-01',
    dueDate: '2026-03-31',
    lines: [{
      accountId: a.sales, description: 'Consulting', quantity: '1', unitPrice: '100.000',
    }],
  });
  return { draft, chart: a };
}

/* ══ Reading ═══════════════════════════════════════════════════════════════ */

describe('another company’s invoice', () => {
  it('cannot be read by id', async () => {
    const { draft } = await northsInvoice();
    await expect(invoices.getInvoice(ctx.db, south, draft.id))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('does not appear in the other company’s list', async () => {
    await northsInvoice();
    expect(await invoices.listInvoices(ctx.db, south, {})).toHaveLength(0);
    expect(await invoices.listInvoices(ctx.db, north, {})).toHaveLength(1);
  });

  it('cannot have its audit history inspected', async () => {
    const { draft } = await northsInvoice();
    await expect(invoices.auditHistory(ctx.db, south, draft.id))
      .rejects.toMatchObject({ code: 'not_found' });
  });
});

/* ══ Writing ═══════════════════════════════════════════════════════════════ */

describe('another company’s invoice, written to', () => {
  it('cannot be updated', async () => {
    const { draft } = await northsInvoice();
    const b = await chart(south);
    await expect(invoices.updateDraft(ctx.db, south, draft.id, {
      issuingEntityId: '11111111-1111-1111-1111-111111111111',
      customerId: '33333333-3333-3333-3333-333333333333',
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [{ accountId: b.sales, quantity: '1', unitPrice: '999.000' }],
    }, { expectedVersion: draft.version })).rejects.toMatchObject({ code: 'not_found' });

    const untouched = await invoices.getInvoice(ctx.db, north, draft.id);
    expect(untouched.customerId).toBe(northCustomer);
  });

  it('cannot be deleted', async () => {
    const { draft } = await northsInvoice();
    await expect(invoices.deleteDraft(ctx.db, south, draft.id, { expectedVersion: draft.version }))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(await invoices.getInvoice(ctx.db, north, draft.id)).toBeTruthy();
  });

  it('cannot be issued', async () => {
    const { draft, chart: a } = await northsInvoice();
    await expect(invoices.issueInvoice(
      ctx.db, south, draft.id, { expectedVersion: draft.version }, a.receivable,
    )).rejects.toMatchObject({ code: 'not_found' });
    expect((await invoices.getInvoice(ctx.db, north, draft.id)).status).toBe('draft');
  });

  it('cannot be voided, and DISCLOSES NOTHING in the attempt', async () => {
    const { draft, chart: a } = await northsInvoice();
    const issued = await invoices.issueInvoice(
      ctx.db, north, draft.id, { expectedVersion: draft.version }, a.receivable,
    );

    /*
     * The regression this file was written for. The pre-flight read ran before
     * the company-scoped lock, so the refusal used to depend on what the OTHER
     * company's invoice happened to contain — and could reveal its state.
     */
    const refusal = await invoices.voidInvoice(
      ctx.db, south, draft.id, { expectedVersion: issued.version, reason: 'Not mine to void' },
    ).then(() => null, (error: unknown) => error as { code?: string; message?: string });

    expect(refusal?.code).toBe('not_found');
    /* The message must not carry the invoice number or its status. */
    expect(refusal?.message ?? '').not.toMatch(new RegExp(issued.invoiceNumber ?? 'INV-'));
    expect(refusal?.message ?? '').not.toMatch(/already void|issued/i);

    expect((await invoices.getInvoice(ctx.db, north, draft.id)).status).toBe('issued');
  });

  it('does not reveal that a foreign invoice is ALREADY void', async () => {
    const { draft, chart: a } = await northsInvoice();
    const issued = await invoices.issueInvoice(
      ctx.db, north, draft.id, { expectedVersion: draft.version }, a.receivable,
    );
    const voided = await invoices.voidInvoice(
      ctx.db, north, draft.id, { expectedVersion: issued.version, reason: 'Cancelled' },
    );
    expect(voided.status).toBe('void');

    /*
     * THE case the pre-flight read leaked.
     *
     * `voidInvoice` checked `status === 'void'` on an organization-scoped read
     * and threw a 409 "already void" — before any company-scoped call could
     * refuse. So South learned, from the status code alone, that North holds an
     * invoice with this id and that it has been voided. Everything else in this
     * file already answered `not_found` for another reason, which is exactly why
     * this case needs its own test.
     */
    const refusal = await invoices.voidInvoice(
      ctx.db, south, draft.id, { expectedVersion: voided.version, reason: 'Not mine' },
    ).then(() => null, (error: unknown) => error as { code?: string; message?: string });

    expect(refusal?.code).toBe('not_found');
    expect(refusal?.message ?? '').not.toMatch(/already void/i);
  });

  it('answers the same for a foreign invoice and one that never existed', async () => {
    const { draft } = await northsInvoice();

    const foreign = await invoices.getInvoice(ctx.db, south, draft.id)
      .then(() => null, (e: { code?: string; message?: string }) => e);
    const fictional = await invoices.getInvoice(ctx.db, south, '00000000-0000-4000-8000-000000000000')
      .then(() => null, (e: { code?: string; message?: string }) => e);

    expect(foreign?.code).toBe(fictional?.code);
    expect(foreign?.message).toBe(fictional?.message);
  });
});

/* ══ Numbering stays independent ═══════════════════════════════════════════ */

describe('invoice numbering', () => {
  it('gives both companies the same first number', async () => {
    const a = await chart(north);
    const b = await chart(south);

    const issue = async (actor: AccountingActor, ch: { receivable: string; sales: string }) => {
      const draft = await invoices.createDraft(ctx.db, actor, {
        issuingEntityId: '11111111-1111-1111-1111-111111111111',
        customerId: actor.companyId === north.companyId ? northCustomer : southCustomer,
        issueDate: '2026-03-01', dueDate: '2026-03-31',
        lines: [{ accountId: ch.sales, quantity: '1', unitPrice: '100.000' }],
      });
      return invoices.issueInvoice(
        ctx.db, actor, draft.id, { expectedVersion: draft.version }, ch.receivable,
      );
    };

    const first = await issue(north, a);
    const second = await issue(south, b);
    /* Different books, so each sequence starts at one. */
    expect(second.invoiceNumber).toBe(first.invoiceNumber);
  });
});

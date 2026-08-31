/**
 * Recording, settling and reversing receipts against a sales invoice.
 *
 * The invariant under test throughout: the invoice's `amount_paid` and the
 * ledger's receivable balance move together or not at all. A subledger that
 * disagrees with the general ledger is an unreconcilable book, and it is the
 * failure the browser store could never rule out because it had no ledger to
 * disagree with.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeaders, createTestContext, login, seedUser, type SessionCookies, type TestContext, seedCustomerParty } from './helpers/testApp.js';
import * as journals from '../src/services/accounting/journalService.js';

let ctx: TestContext;
let customerId: string;
let admin: SessionCookies;
const password = 'Bright-Harbour-58-Zq';

beforeEach(async () => {
  ctx = await createTestContext();
  await seedUser(ctx, { email: 'super@ledgora.test', platformRoles: ['super_admin'] });
  admin = await login(ctx, 'super@ledgora.test');
});
afterEach(async () => ctx.close());

async function planId(): Promise<string> {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
  return response.json().plans.find((plan: { code: string }) => plan.code === 'core').id;
}

async function tenantUser(name: string): Promise<{ user: SessionCookies; organizationId: string }> {
  const created = await ctx.app.inject({ method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(admin), payload: {
    fullName: `${name} Owner`, email: `owner@${name.toLowerCase()}.test`, organizationLegalName: `${name} LLC`,
    country: 'JO', baseCurrency: 'JOD', planId: await planId(), onboarding: 'temporary', paymentConfirmed: true,
  } });
  expect(created.statusCode, created.body).toBe(201);
  const organizationId = created.json().subscriber.organizationId;
  /* Migration 031 gave `invoices.customer_id` a foreign key, so the customer
   * these invoices name has to be a real party — and a party belongs to one set
   * of books, so each organization gets its own. */
  customerId = await seedCustomerParty(ctx, organizationId);


  const invited = await ctx.app.inject({ method: 'POST', url: '/api/admin/users', headers: authHeaders(admin), payload: {
    fullName: 'Cashier Person', email: `cash@${name.toLowerCase()}.test`,
    organizationId, role: 'admin', onboarding: 'invitation',
  } });
  expect(invited.statusCode, invited.body).toBe(201);
  await ctx.app.inject({ method: 'POST', url: '/api/auth/reset-password',
    payload: { token: invited.json().credential.invitationToken, newPassword: password } });
  return { user: await login(ctx, `cash@${name.toLowerCase()}.test`, password), organizationId };
}

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, user: SessionCookies, payload?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, headers: authHeaders(user), payload });

async function account(user: SessionCookies, code: string, name: string, type: string): Promise<string> {
  const response = await call('POST', '/api/accounting/accounts', user, {
    accountCode: code, accountName: name, accountType: type,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().account.id;
}

/**
 * A reader for this organization's books.
 *
 * Carries the COMPANY as well as the organization: journals are company-scoped,
 * so an actor without one resolves nothing. The tenant keeps exactly one set of
 * books, so it is found rather than passed in.
 */
async function actorFor(organizationId: string) {
  const company = await ctx.db
    .selectFrom('companies')
    .select('id')
    .where('organization_id', '=', organizationId)
    .executeTakeFirstOrThrow();
  return { organizationId, companyId: company.id, userId: null, name: 'test', requestId: 't' };
}

async function postedLines(organizationId: string, journalEntryId: string) {
  const actor = await actorFor(organizationId);
  const entry = await journals.getJournal(ctx.db, actor as never, journalEntryId);
  return entry.lines.map((line: { accountId: string; debit: string; credit: string }) => ({
    accountId: line.accountId, debit: Number(line.debit), credit: Number(line.credit),
  }));
}

/**
 * An ISSUED invoice for 116, with every account it used.
 *
 * Formerly 100 net plus 16 tax. Tax is refused inside the zero-tax boundary and
 * was never what this file is about — receipts settle a balance whatever made
 * it — so the same 116 is raised as a single net line and every expectation
 * below is unchanged.
 */
async function issued(name: string) {
  const { user, organizationId } = await tenantUser(name);
  const receivable = await account(user, '1200', 'Trade receivables', 'asset');
  /* Issuing derives the debit account from the customer, not the request. */
  await ctx.db.insertInto('business_party_customer_profiles').values({
    organization_id: organizationId,
    company_id: (await ctx.db.selectFrom('companies').select('id')
      .where('organization_id', '=', organizationId).executeTakeFirstOrThrow()).id,
    party_id: customerId,
    default_receivable_account_id: receivable,
  } as never).onConflict((oc) => oc
    .columns(['organization_id', 'company_id', 'party_id'])
    .doUpdateSet({ default_receivable_account_id: receivable })).execute();
  const sales = await account(user, '4000', 'Sales', 'income');
  const taxPayable = await account(user, '2300', 'Sales tax payable', 'liability');
  const bank = await account(user, '1000', 'Bank', 'asset');

  const created = await call('POST', '/api/invoices', user, {
    issuingEntityId: '11111111-1111-1111-1111-111111111111',
    customerId,
    issueDate: '2026-03-01', dueDate: '2026-03-31',
    lines: [{ accountId: sales, description: 'Consulting', quantity: '1', unitPrice: '116.000' }],
  });
  expect(created.statusCode, created.body).toBe(201);

  const response = await call('POST', `/api/invoices/${created.json().invoice.id}/issue`, user, {
    expectedVersion: created.json().invoice.version,
  });
  expect(response.statusCode, response.body).toBe(200);
  return { user, organizationId, invoice: response.json().invoice, receivable, sales, taxPayable, bank };
}

type Issued = Awaited<ReturnType<typeof issued>>;

const pay = (t: Issued, over: Record<string, unknown> = {}) =>
  call('POST', `/api/invoices/${t.invoice.id}/payments`, t.user, {
    expectedVersion: t.invoice.version,
    paidOn: '2026-03-10', amount: '50.000', bankAccountId: t.bank, method: 'transfer',
    ...over,
  });

const paymentsOf = async (t: Issued) =>
  (await call('GET', `/api/invoices/${t.invoice.id}/payments`, t.user)).json().payments;

describe('recording a receipt', () => {
  it('reduces the balance and posts bank against the receivable the invoice used', async () => {
    const t = await issued('Echo');
    const response = await pay(t);
    expect(response.statusCode, response.body).toBe(201);

    expect(response.json().invoice).toMatchObject({
      amountPaid: '50.000', balanceDue: '66.000', status: 'issued',
    });

    const payments = await paymentsOf(t);
    expect(payments).toHaveLength(1);
    const lines = await postedLines(t.organizationId, payments[0].journalEntryId);
    expect(lines.find((l) => l.accountId === t.bank)!.debit).toBe(50);
    // The receivable is the one stored at issue, never one the caller chose.
    expect(lines.find((l) => l.accountId === t.receivable)!.credit).toBe(50);
  });

  it('settles the invoice when the balance reaches zero', async () => {
    const t = await issued('Foxtrot');
    const part = await pay(t);
    const rest = await pay(
      { ...t, invoice: part.json().invoice },
      { amount: '66.000', paidOn: '2026-03-11' },
    );

    expect(rest.json().invoice.balanceDue).toBe('0.000');
    // 'paid' is reached by arriving at zero, never asserted by a caller.
    expect(rest.json().invoice.status).toBe('paid');
  });

  it('refuses an overpayment rather than absorbing it', async () => {
    const t = await issued('Golf');
    const response = await pay(t, { amount: '200.000' });
    // A negative balance due is a credit the customer does not know they hold.
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.message).toMatch(/more than the/i);
  });

  it('refuses a receipt against a draft', async () => {
    const { user } = await tenantUser('Hotel');
    const sales = await account(user, '4000', 'Sales', 'income');
    const bank = await account(user, '1000', 'Bank', 'asset');
    const created = await call('POST', '/api/invoices', user, {
      issuingEntityId: '11111111-1111-1111-1111-111111111111',
      customerId,
      issueDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{ accountId: sales, quantity: '1', unitPrice: '100.000' }],
    });
    const response = await call('POST', `/api/invoices/${created.json().invoice.id}/payments`, user, {
      expectedVersion: created.json().invoice.version,
      paidOn: '2026-03-10', amount: '10.000', bankAccountId: bank,
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error.message).toMatch(/issue it before/i);
  });

  it('refuses a receipt with no concurrency token', async () => {
    const t = await issued('India');
    const response = await call('POST', `/api/invoices/${t.invoice.id}/payments`, t.user, {
      paidOn: '2026-03-10', amount: '10.000', bankAccountId: t.bank,
    });
    expect(response.statusCode, response.body).toBe(400);
  });

  it('refuses a zero or negative receipt', async () => {
    const t = await issued('Juliet');
    expect((await pay(t, { amount: '0' })).statusCode).toBe(400);
    expect((await pay(t, { amount: '-5.000' })).statusCode).toBe(400);
  });
});

describe('reversing a receipt', () => {
  it('restores the balance and keeps both documents', async () => {
    const t = await issued('Kilo');
    const paid = await pay(t);
    const payments = await paymentsOf(t);

    const reversed = await call('POST', `/api/invoices/payments/${payments[0].id}/reverse`, t.user, {
      expectedVersion: paid.json().invoice.version, reason: 'Recorded against the wrong invoice',
    });
    expect(reversed.statusCode, reversed.body).toBe(200);
    expect(reversed.json().invoice).toMatchObject({ amountPaid: '0.000', balanceDue: '116.000' });

    // The row stays: a reversal that deletes makes the mistake unfindable.
    const after = await paymentsOf(t);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ reversalReason: 'Recorded against the wrong invoice' });
    expect(after[0].reversedAt).toBeTruthy();
  });

  it('un-settles an invoice that had been paid in full', async () => {
    const t = await issued('Lima');
    const full = await pay(t, { amount: '116.000' });
    expect(full.json().invoice.status).toBe('paid');

    const payments = await paymentsOf(t);
    const reversed = await call('POST', `/api/invoices/payments/${payments[0].id}/reverse`, t.user, {
      expectedVersion: full.json().invoice.version, reason: 'Payment bounced',
    });

    /*
     * Leaving it 'paid' with money owing is how an invoice stops appearing on
     * the very report that would chase it.
     */
    expect(reversed.json().invoice).toMatchObject({ status: 'issued', balanceDue: '116.000' });
  });

  it('requires a reason', async () => {
    const t = await issued('Mike');
    const paid = await pay(t);
    const payments = await paymentsOf(t);
    const response = await call('POST', `/api/invoices/payments/${payments[0].id}/reverse`, t.user, {
      expectedVersion: paid.json().invoice.version,
    });
    expect(response.statusCode, response.body).toBe(400);
  });

  it('refuses to reverse the same receipt twice', async () => {
    const t = await issued('November');
    const paid = await pay(t);
    const payments = await paymentsOf(t);
    const once = await call('POST', `/api/invoices/payments/${payments[0].id}/reverse`, t.user, {
      expectedVersion: paid.json().invoice.version, reason: 'Entered in error',
    });
    expect(once.statusCode, once.body).toBe(200);
    const twice = await call('POST', `/api/invoices/payments/${payments[0].id}/reverse`, t.user, {
      expectedVersion: once.json().invoice.version, reason: 'Entered in error again',
    });
    expect(twice.statusCode, twice.body).toBe(409);
  });
});

describe('additional charges, while they have no controlled account', () => {
  /*
   * ══ What this block used to assert ═════════════════════════════════════════
   *
   * Charges were once dropped on the floor, so a migrated invoice's total
   * silently disagreed with the document the customer already held. The tests
   * here proved the fix: the charge reaches the total (107.500 on a 100 sale),
   * the receivable is debited the full amount, and the charge is credited to
   * its own account rather than smuggled into revenue.
   *
   * The server has no CONTROLLED account for charges — nothing in company
   * settings says where delivery or handling posts — so the caller used to name
   * one, which let a request decide where a sale landed. Rather than keep that,
   * charges are refused until the account model exists, and the reasoning above
   * is what a later slice has to restore.
   */
  it('is REFUSED, rather than posting to an account the caller named', async () => {
    const { user } = await tenantUser('Oscar');
    const sales = await account(user, '4000', 'Sales', 'income');

    const created = await call('POST', '/api/invoices', user, {
      issuingEntityId: '11111111-1111-1111-1111-111111111111',
      customerId,
      issueDate: '2026-03-01', dueDate: '2026-03-31',
      additionalChargesTotal: '7.500',
      lines: [{ accountId: sales, quantity: '1', unitPrice: '100.000' }],
    });

    expect(created.statusCode).toBe(400);
    expect(created.json().error.message).toMatch(/no controlled account for them/i);
  });
});

describe('tenant isolation', () => {
  it('will not settle another organization invoice', async () => {
    const mine = await issued('Quebec');
    const other = await tenantUser('Romeo');
    const response = await call('POST', `/api/invoices/${mine.invoice.id}/payments`, other.user, {
      expectedVersion: mine.invoice.version,
      paidOn: '2026-03-10', amount: '10.000', bankAccountId: mine.bank,
    });
    expect(response.statusCode, response.body).toBe(404);
  });
});

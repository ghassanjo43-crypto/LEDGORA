/**
 * Receipts against a sales invoice, and the ledger they produce.
 *
 * ── Why the tax posting is tested here ───────────────────────────────────────
 * A receipt is settled against a receivable. If the receivable the invoice
 * created is wrong, every payment recorded against it is wrong too, and the
 * error compounds instead of surfacing. So the first thing this file pins is
 * what issuing actually debits the customer for.
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

/** An invoice for 100 net + 16 tax, plus every account it needs. */
async function taxedInvoice(name: string) {
  const { user, organizationId } = await tenantUser(name);
  const receivable = await account(user, '1200', 'Trade receivables', 'asset');
  const sales = await account(user, '4000', 'Sales', 'income');
  const taxPayable = await account(user, '2300', 'Sales tax payable', 'liability');
  const bank = await account(user, '1000', 'Bank', 'asset');

  const response = await call('POST', '/api/invoices', user, {
    issuingEntityId: '11111111-1111-1111-1111-111111111111',
    customerId,
    issueDate: '2026-03-01', dueDate: '2026-03-31',
    lines: [{
      accountId: sales, description: 'Consulting',
      quantity: '1', unitPrice: '100.000', taxAmount: '16.000', taxRate: '16',
    }],
  });
  expect(response.statusCode, response.body).toBe(201);
  return { user, organizationId, invoice: response.json().invoice, receivable, sales, taxPayable, bank };
}

/**
 * A reader for this organization's books.
 *
 * Carries the COMPANY as well as the organization, because journals are
 * company-scoped: an actor without one resolves nothing at all, which is the
 * point — there is no such thing as reading an organization's journals without
 * saying which set of books. The tenant keeps exactly one, so it is found
 * rather than passed in.
 */
async function actorFor(organizationId: string) {
  const company = await ctx.db
    .selectFrom('companies')
    .select('id')
    .where('organization_id', '=', organizationId)
    .executeTakeFirstOrThrow();
  return { organizationId, companyId: company.id, userId: null, name: 'test', requestId: 't' };
}

/** The posted journal behind an invoice, as debit/credit pairs by account. */
async function postedLines(organizationId: string, journalEntryId: string) {
  const actor = await actorFor(organizationId);
  const entry = await journals.getJournal(ctx.db, actor as never, journalEntryId);
  return entry.lines.map((line: { accountId: string; debit: string; credit: string }) => ({
    accountId: line.accountId,
    debit: Number(line.debit),
    credit: Number(line.credit),
  }));
}

describe('what issuing a taxed invoice debits and credits', () => {
  it('debits the customer the tax-inclusive total', async () => {
    const t = await taxedInvoice('Alpha');
    const issued = await call('POST', `/api/invoices/${t.invoice.id}/issue`, t.user, {
      expectedVersion: t.invoice.version,
      receivableAccountId: t.receivable,
      taxAccountId: t.taxPayable,
    });
    expect(issued.statusCode, issued.body).toBe(200);

    const lines = await postedLines(t.organizationId, issued.json().invoice.journalEntryId);
    const receivableDebit = lines
      .filter((l) => l.accountId === t.receivable)
      .reduce((sum, l) => sum + l.debit - l.credit, 0);

    /*
     * The customer owes 116, not 100. Crediting the tax back to the receivable
     * nets the customer's balance down to the sale value and the tax collected
     * is never recorded as owed to anyone.
     */
    expect(receivableDebit).toBe(116);
  });

  it('credits the tax to a liability account, not back to the receivable', async () => {
    const t = await taxedInvoice('Bravo');
    const issued = await call('POST', `/api/invoices/${t.invoice.id}/issue`, t.user, {
      expectedVersion: t.invoice.version,
      receivableAccountId: t.receivable,
      taxAccountId: t.taxPayable,
    });

    const lines = await postedLines(t.organizationId, issued.json().invoice.journalEntryId);
    const taxCredit = lines
      .filter((l) => l.accountId === t.taxPayable)
      .reduce((sum, l) => sum + l.credit - l.debit, 0);

    // Tax collected on behalf of the authority is a liability until remitted.
    expect(taxCredit).toBe(16);
  });

  it('refuses to issue a taxed invoice with nowhere to put the tax', async () => {
    const t = await taxedInvoice('Charlie');
    const issued = await call('POST', `/api/invoices/${t.invoice.id}/issue`, t.user, {
      expectedVersion: t.invoice.version,
      receivableAccountId: t.receivable,
    });
    // Silently absorbing it into the receivable is what this replaces.
    expect(issued.statusCode, issued.body).toBe(400);
    expect(issued.json().error.message).toMatch(/tax/i);
  });

  it('still issues a zero-tax invoice without one', async () => {
    const { user } = await tenantUser('Delta');
    const receivable = await account(user, '1200', 'Trade receivables', 'asset');
    const sales = await account(user, '4000', 'Sales', 'income');
    const created = await call('POST', '/api/invoices', user, {
      issuingEntityId: '11111111-1111-1111-1111-111111111111',
      customerId,
      issueDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{ accountId: sales, quantity: '1', unitPrice: '100.000' }],
    });
    const issued = await call('POST', `/api/invoices/${created.json().invoice.id}/issue`, user, {
      expectedVersion: created.json().invoice.version, receivableAccountId: receivable,
    });
    expect(issued.statusCode, issued.body).toBe(200);
  });
});

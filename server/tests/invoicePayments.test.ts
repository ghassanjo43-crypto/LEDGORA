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
  /* No 201 assertion: within the zero-tax boundary this is REFUSED, and the
   * refusal is what the surviving test inspects. */
  return { user, organizationId, response, receivable, sales, taxPayable, bank };
}



describe('a taxed invoice, now that tax IS server-authoritative', () => {
  /*
   * ══ What changed, and where the accounting now lives ═══════════════════════
   *
   * Until S2c a taxed invoice was refused outright, because the server could not
   * compute the tax and issuing at zero would have understated output tax on a
   * document the customer holds. S2c brought controlled tax codes, so the three
   * properties this block used to guard are restored and proved in full by
   * `invoiceTaxPosting`:
   *
   *   · the receivable is debited the TAX-INCLUSIVE total (1160, not 1000);
   *   · the tax is credited to a LIABILITY account, because tax collected on
   *     the authority's behalf is owed until remitted;
   *   · issuing is refused when there is nowhere to put the tax.
   *
   * What survives HERE is the narrower rule this file can still see: the client
   * does not get to say what the tax IS. The refusal moved rather than
   * disappearing — a rate in the request is the browser authoring the one figure
   * a tax authority will hold a copy of.
   */
  it('REFUSES a client-supplied rate rather than trusting it', async () => {
    const { response } = await taxedInvoice('Alpha');

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/supplies a rate for its tax/i);
    expect(response.json().error.message).toMatch(/calculated by the server/i);
    expect(response.json().error.message).toMatch(/nothing has been saved/i);
  });

  it('still issues a ZERO-tax invoice, which is the supported path', async () => {
    const { user, organizationId } = await tenantUser('Delta');
    const receivable = await account(user, '1200', 'Trade receivables', 'asset');
    const sales = await account(user, '4000', 'Sales', 'income');

    /* The receivable now comes from the customer's own profile rather than the
     * issue request, so it is set here. */
    const company = await ctx.db.selectFrom('companies').select('id')
      .where('organization_id', '=', organizationId).executeTakeFirstOrThrow();
    await ctx.db.insertInto('business_party_customer_profiles')
      .values({
        organization_id: organizationId, company_id: company.id,
        party_id: customerId, default_receivable_account_id: receivable,
      } as never)
      .onConflict((oc) => oc
        .columns(['organization_id', 'company_id', 'party_id'])
        .doUpdateSet({ default_receivable_account_id: receivable }))
      .execute();

    const created = await call('POST', '/api/invoices', user, {
      issuingEntityId: '11111111-1111-1111-1111-111111111111',
      customerId,
      issueDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{ accountId: sales, quantity: '1', unitPrice: '100.000' }],
    });
    expect(created.statusCode, created.body).toBe(201);

    const issued = await call('POST', `/api/invoices/${created.json().invoice.id}/issue`, user, {
      expectedVersion: created.json().invoice.version,
    });
    expect(issued.statusCode, issued.body).toBe(200);
    expect(issued.json().invoice.grandTotal).toBe('100.000');
  });
});

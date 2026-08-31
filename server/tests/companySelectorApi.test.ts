/**
 * Phase 1/3 — the company selector, over HTTP, on a real subscriber.
 *
 * ══ What is being proved here that the service tests do not ══════════════════
 *
 * The service tests hand an `AccountingActor` straight to a function, so the
 * company is always present by construction. These requests carry only a
 * session cookie and, sometimes, a header — which is what a real client has.
 *
 * The claims:
 *
 *   selection      the header names which of the caller's own companies a
 *                  request concerns, and nothing else;
 *   no authority   a header naming another tenant's company buys nothing, and
 *                  is answered as an unknown reference would be;
 *   no guessing    with several companies and no header, the server refuses
 *                  rather than choosing a set of books on the user's behalf;
 *   independence   two companies under one subscriber number their journals and
 *                  invoices separately, including under concurrency.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  authHeaders,
  createTestContext,
  login,
  seedUser,
  type SessionCookies,
  type TestContext,
} from './helpers/testApp.js';
import { COMPANY_REFERENCE_HEADER } from '../src/guards/companyScope.js';

let ctx: TestContext;
let admin: SessionCookies;

const PASSWORD = 'Copper-Lantern-64-Wm';

beforeEach(async () => {
  ctx = await createTestContext();
  await seedUser(ctx, {
    email: 'super@ledgora.test', fullName: 'Platform Super Admin', platformRoles: ['super_admin'],
  });
  admin = await login(ctx, 'super@ledgora.test');
});
afterEach(async () => { await ctx.close(); });

async function planId(code = 'core'): Promise<string> {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
  return response.json().plans.find((p: { code: string }) => p.code === code).id;
}

async function tenant(name: string, plan = 'core'): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(admin),
    payload: {
      fullName: `${name} Owner`, email: `owner@${name.toLowerCase()}.test`,
      organizationLegalName: `${name} Trading LLC`, country: 'JO', baseCurrency: 'JOD',
      planId: await planId(plan), onboarding: 'temporary', paymentConfirmed: true,
    },
  });
  expect(created.statusCode).toBe(201);
  const organizationId = created.json().subscriber.organizationId as string;
  return organizationId;
}

async function member(organizationId: string, email: string, role = 'admin'): Promise<SessionCookies> {
  const created = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: authHeaders(admin),
    payload: {
      fullName: `Person ${email}`, email, organizationId, role,
      onboarding: 'invitation', permissions: [],
    },
  });
  expect(created.statusCode).toBe(201);
  const token = created.json().credential.invitationToken as string;
  await ctx.app.inject({
    method: 'POST', url: '/api/auth/reset-password', payload: { token, newPassword: PASSWORD },
  });
  return login(ctx, email, PASSWORD);
}

/** A request, optionally naming a company. */
const call = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  cookies: SessionCookies,
  payload?: Record<string, unknown>,
  companyReference?: string,
) => ctx.app.inject({
  method,
  url,
  headers: {
    ...authHeaders(cookies),
    ...(companyReference ? { [COMPANY_REFERENCE_HEADER]: companyReference } : {}),
  },
  payload,
});

/**
 * Register a set of books and return its client reference.
 *
 * The FIRST call for a tenant adopts its provisional company; later calls add
 * further companies against the plan allowance. Both answer 201, because both
 * establish a registration.
 */
async function addCompany(user: SessionCookies, reference: string, name: string): Promise<string> {
  const created = await call('POST', '/api/organizations/current/companies', user, {
    clientReference: reference, legalName: name,
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json().company.clientReference as string;
}

const chart = async (user: SessionCookies, reference?: string) => {
  const cash = await call('POST', '/api/accounting/accounts', user, {
    accountCode: '1000', accountName: 'Cash', accountType: 'asset',
  }, reference);
  const sales = await call('POST', '/api/accounting/accounts', user, {
    accountCode: '4000', accountName: 'Sales', accountType: 'income',
  }, reference);
  expect([cash.statusCode, sales.statusCode], `${cash.body} ${sales.body}`).toEqual([201, 201]);
  return { cash: cash.json().account.id as string, sales: sales.json().account.id as string };
};

const entry = (cash: string, sales: string) => ({
  transactionDate: '2026-08-01',
  description: 'Consulting fee',
  lines: [{ accountId: cash, debit: '100.000' }, { accountId: sales, credit: '100.000' }],
});

/* ══ Resolution over HTTP ══════════════════════════════════════════════════ */

describe('when the selector is omitted', () => {
  it('resolves for a subscriber with exactly one company', async () => {
    const org = await tenant('Solo');
    const user = await member(org, 'admin@solo.test');

    /* No header at all — every existing client behaves this way. */
    const accounts = await call('GET', '/api/accounting/accounts', user);
    expect(accounts.statusCode).toBe(200);
  });

  it('refuses as ambiguous once a second company exists', async () => {
    /*
     * TWO registrations: the first adopts the tenant's provisional books, the
     * second adds a further company. Only then is there anything to be
     * ambiguous about — one provisional company resolves perfectly well on its
     * own, which is what lets a new subscriber post before their browser syncs.
     */
    const org = await tenant('Duo', 'projects');
    const user = await member(org, 'admin@duo.test');
    await addCompany(user, 'co_first', 'Duo Trading LLC');
    await addCompany(user, 'co_second', 'Duo Logistics LLC');

    const accounts = await call('GET', '/api/accounting/accounts', user);
    /*
     * The load-bearing refusal. Choosing a company here would scope a report —
     * or a posting — to books the user never selected.
     */
    expect(accounts.statusCode).toBe(400);
    expect(accounts.json().error.code).toBe('company_selection_required');
  });

  it('names the company and succeeds again', async () => {
    const org = await tenant('Duo', 'projects');
    const user = await member(org, 'admin@duo.test');
    await addCompany(user, 'co_first', 'Duo Trading LLC');
    const second = await addCompany(user, 'co_second', 'Duo Logistics LLC');

    const accounts = await call('GET', '/api/accounting/accounts', user, undefined, second);
    expect(accounts.statusCode).toBe(200);
  });

  it('refuses when the organization keeps no books at all', async () => {
    const org = await tenant('Empty');
    const user = await member(org, 'admin@empty.test');
    /* Remove the provisional company, which is the only way to reach this state. */
    await ctx.db.deleteFrom('companies').where('organization_id', '=', org).execute();

    const accounts = await call('GET', '/api/accounting/accounts', user);
    expect(accounts.statusCode).toBe(400);
    expect(accounts.json().error.code).toBe('company_not_registered');
  });
});

/* ══ The header is a selector, not authorization ═══════════════════════════ */

describe('a header naming a company the caller may not use', () => {
  it('answers another tenant’s reference exactly as an unknown one', async () => {
    const acme = await tenant('Acme');
    const globex = await tenant('Globex');
    const acmeUser = await member(acme, 'admin@acme.test');
    const globexUser = await member(globex, 'admin@globex.test');
    const globexBooks = await addCompany(globexUser, 'co_globex_only', 'Globex Trading LLC');

    const foreign = await call('GET', '/api/accounting/accounts', acmeUser, undefined, globexBooks);
    const fictional = await call('GET', '/api/accounting/accounts', acmeUser, undefined, 'co_never_existed');

    /* Identical: a real reference belonging to somebody else, and one that
     * names nothing anywhere. Anything less would let a caller enumerate other
     * customers' companies. */
    expect(foreign.statusCode).toBe(404);
    expect(fictional.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe(fictional.json().error.code);
    expect(foreign.json().error.message).toBe(fictional.json().error.message);
  });

  it('does not accept the server company uuid as a selector', async () => {
    const org = await tenant('Solo');
    const user = await member(org, 'admin@solo.test');
    const listed = await call('GET', '/api/organizations/current/companies', user);
    const serverId = listed.json().companies[0].id as string;

    /* The caller's OWN company, named by its internal key. Still refused. */
    const response = await call('GET', '/api/accounting/accounts', user, undefined, serverId);
    expect(response.statusCode).toBe(404);
  });
});

/* ══ Two companies, one subscriber, over HTTP ══════════════════════════════ */

describe('two companies under one subscriber', () => {
  /** Two ADOPTED companies: the provisional one claimed, plus a second. */
  async function duo() {
    const org = await tenant('Duo', 'projects');
    const user = await member(org, 'admin@duo.test');
    const first = await addCompany(user, 'co_first', 'Duo Trading LLC');
    const second = await addCompany(user, 'co_second', 'Duo Logistics LLC');
    return { org, user, first, second };
  }

  it('keep separate charts of accounts, both using code 1000', async () => {
    const { user, first, second } = await duo();
    const a = await chart(user, first);
    const b = await chart(user, second);
    expect(a.cash).not.toBe(b.cash);

    const firstList = await call('GET', '/api/accounting/accounts', user, undefined, first);
    const secondList = await call('GET', '/api/accounting/accounts', user, undefined, second);
    expect(firstList.json().accounts).toHaveLength(2);
    expect(secondList.json().accounts).toHaveLength(2);
  });

  it('both number their first journal JE-000001', async () => {
    const { user, first, second } = await duo();
    const a = await chart(user, first);
    const b = await chart(user, second);

    const one = await call('POST', '/api/accounting/journals', user, entry(a.cash, a.sales), first);
    const two = await call('POST', '/api/accounting/journals', user, entry(b.cash, b.sales), second);

    expect([one.statusCode, two.statusCode]).toEqual([201, 201]);
    expect(two.json().journal.journalNumber).toBe(one.json().journal.journalNumber);
  });

  it('both issue the same first invoice number', async () => {
    const { user, first, second } = await duo();

    const invoiceIn = async (reference: string) => {
      const receivable = await call('POST', '/api/accounting/accounts', user, {
        accountCode: '1200', accountName: 'Receivable', accountType: 'asset',
      }, reference);
      const sales = await call('POST', '/api/accounting/accounts', user, {
        accountCode: '4000', accountName: 'Sales', accountType: 'income',
      }, reference);
      expect([receivable.statusCode, sales.statusCode]).toEqual([201, 201]);

      /* The customer lives in the company the header names, like the invoice
       * that will reference it. See migration 031. */
      const customer = await call('POST', '/api/customers', user, {
        partyCode: `CUST-${reference}`, legalName: 'Selector Customer LLC',
      }, reference);
      expect(customer.statusCode, customer.body).toBe(201);

      const created = await call('POST', '/api/invoices', user, {
        issuingEntityId: '11111111-1111-1111-1111-111111111111',
        customerId: customer.json().customer.id,
        issueDate: '2026-03-01', dueDate: '2026-03-31',
        lines: [{
          accountId: sales.json().account.id,
          description: 'Consulting', quantity: '1', unitPrice: '100.000',
        }],
      }, reference);
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().invoice.id as string;
      /* The receivable account is named at ISSUE time — this is where the
       * invoice becomes a posting, and the account it debits must be one of
       * THIS company's. */
      const issued = await call('POST', `/api/invoices/${id}/issue`, user, {
        expectedVersion: created.json().invoice.version,
        receivableAccountId: receivable.json().account.id,
      }, reference);
      expect(issued.statusCode, issued.body).toBe(200);
      return issued.json().invoice.invoiceNumber as string;
    };

    /*
     * Each company's sequence starts at one. Under organization-only numbering
     * a customer's second company would begin wherever the first left off,
     * which is wrong on a tax document.
     */
    expect(await invoiceIn(second)).toBe(await invoiceIn(first));
  });

  it('number journals independently under concurrency', async () => {
    const { user, first, second } = await duo();
    const a = await chart(user, first);
    const b = await chart(user, second);

    /*
     * Six simultaneous postings, three into each company. Both sequences must
     * come out complete and gap-free — the advisory lock is keyed per company,
     * so the two do not contend, and neither may skip a number.
     */
    const responses = await Promise.all([
      call('POST', '/api/accounting/journals', user, entry(a.cash, a.sales), first),
      call('POST', '/api/accounting/journals', user, entry(a.cash, a.sales), first),
      call('POST', '/api/accounting/journals', user, entry(a.cash, a.sales), first),
      call('POST', '/api/accounting/journals', user, entry(b.cash, b.sales), second),
      call('POST', '/api/accounting/journals', user, entry(b.cash, b.sales), second),
      call('POST', '/api/accounting/journals', user, entry(b.cash, b.sales), second),
    ]);
    expect(responses.every((r) => r.statusCode === 201)).toBe(true);

    const numbersIn = (reference: string) =>
      call('GET', '/api/accounting/journals', user, undefined, reference)
        .then((r) => (r.json().journals as Array<{ journalNumber: string }>)
          .map((j) => j.journalNumber).sort());

    const expected = ['JE-000001', 'JE-000002', 'JE-000003'];
    expect(await numbersIn(first)).toEqual(expected);
    expect(await numbersIn(second)).toEqual(expected);
  });

  it('cannot read the other company’s journal, even naming its id', async () => {
    const { user, first, second } = await duo();
    const a = await chart(user, first);
    const created = await call('POST', '/api/accounting/journals', user, entry(a.cash, a.sales), first);
    const id = created.json().journal.id as string;

    const fromFirst = await call('GET', `/api/accounting/journals/${id}`, user, undefined, first);
    const fromSecond = await call('GET', `/api/accounting/journals/${id}`, user, undefined, second);

    expect(fromFirst.statusCode).toBe(200);
    /* Same session, same organization, same permissions — different books. */
    expect(fromSecond.statusCode).toBe(404);
  });
});

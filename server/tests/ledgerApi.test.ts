/**
 * The general ledger over HTTP.
 *
 * `ledger.test.ts` proves the arithmetic and the paging. This proves the
 * surface, and one claim in particular that the service cannot make on its own:
 *
 *   READING A LEDGER AND CARRYING IT OUT OF THE BUILDING ARE DIFFERENT ACTS.
 *
 * `general_ledger` carries both `view` and `export`, and the catalogue would be
 * decorative if the export route accepted the viewing permission. Somebody
 * trusted to look up a customer's account on screen has not necessarily been
 * trusted to take the whole of it away as a file, so that distinction is
 * asserted here against a caller who holds one and not the other.
 *
 * The second claim is that an export is the WHOLE range rather than the pages a
 * browser happened to load — an export whose totals depend on how far somebody
 * scrolled is worse than no export.
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
import { listCompanies } from '../src/services/companyService.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as journals from '../src/services/accounting/journalService.js';

let ctx: TestContext;
let admin: SessionCookies;

const PASSWORD = 'Copper-Lantern-64-Wm';
const LEDGER = '/api/accounting/ledger';
const EXPORT = '/api/accounting/ledger/export';
const GROUPED = '/api/accounting/ledger/export/grouped';
const RANGE = 'from=2026-01-01&to=2026-12-31';

interface PermissionOverride {
  subject: string;
  action: string;
  effect: 'grant' | 'deny' | 'inherit';
}

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

async function tenant(name: string): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(admin),
    payload: {
      fullName: `${name} Owner`, email: `owner@${name.toLowerCase()}.test`,
      organizationLegalName: `${name} Trading LLC`, country: 'JO', baseCurrency: 'JOD',
      planId: await planId(), onboarding: 'temporary', paymentConfirmed: true,
    },
  });
  expect(created.statusCode).toBe(201);
  return created.json().subscriber.organizationId as string;
}

async function member(
  organizationId: string,
  email: string,
  role = 'admin',
  permissions: PermissionOverride[] = [],
): Promise<{ cookies: SessionCookies; userId: string }> {
  const created = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: authHeaders(admin),
    payload: {
      fullName: `Person ${email}`, email, organizationId, role,
      onboarding: 'invitation', permissions,
    },
  });
  expect(created.statusCode).toBe(201);
  const token = created.json().credential.invitationToken as string;
  await ctx.app.inject({
    method: 'POST', url: '/api/auth/reset-password', payload: { token, newPassword: PASSWORD },
  });
  return {
    cookies: await login(ctx, email, PASSWORD),
    userId: created.json().user.userId as string,
  };
}

async function chartFor(organizationId: string, userId: string, name: string) {
  const company = (await listCompanies(ctx.db, organizationId))[0]!;
  const actor: AccountingActor = { organizationId, companyId: company.id, userId, name };
  const cash = (await accounts.createAccount(ctx.db, actor, {
    accountCode: '1000', accountName: 'Cash', accountType: 'asset',
  })).id;
  const sales = (await accounts.createAccount(ctx.db, actor, {
    accountCode: '4000', accountName: 'Sales', accountType: 'income',
  })).id;
  return { company, actor, cash, sales };
}

/**
 * A tenant with a chart and some postings.
 *
 * Seeded through the services rather than over HTTP: what is under test here is
 * the ledger surface, and building the data through a different surface keeps a
 * failure in that one from being reported as a failure in this one.
 */
async function books(name: string, postings: Array<{ amount: string; date: string }>) {
  const organizationId = await tenant(name);
  const person = await member(organizationId, `admin@${name.toLowerCase()}.test`);
  const chart = await chartFor(organizationId, person.userId, `Person ${name}`);

  for (const posting of postings) {
    const draft = await journals.createDraft(ctx.db, chart.actor, {
      transactionDate: posting.date,
      description: `Posting ${posting.amount}`,
      lines: [
        { accountId: chart.cash, debit: posting.amount },
        { accountId: chart.sales, credit: posting.amount },
      ],
    });
    await journals.postJournal(ctx.db, chart.actor, draft.id, { expectedVersion: draft.version });
  }

  return { organizationId, ...chart, cookies: person.cookies };
}

const days = (count: number, amount = '10.000') =>
  Array.from({ length: count }, (_, i) => ({
    amount, date: `2026-03-${String(i + 1).padStart(2, '0')}`,
  }));

const get = (url: string, cookies: SessionCookies, reference?: string) =>
  ctx.app.inject({
    method: 'GET', url,
    headers: {
      ...authHeaders(cookies),
      ...(reference ? { 'x-ledgora-company-reference': reference } : {}),
    },
  });

const lineIds = (lines: Array<{ lineId: string }>) => lines.map((line) => line.lineId);

/* ══ The page ══════════════════════════════════════════════════════════════ */

describe('the ledger endpoint', () => {
  it('returns one account’s page, with the figures PostgreSQL struck', async () => {
    const acme = await books('Acme', days(3));

    const response = await get(`${LEDGER}?accountId=${acme.cash}&${RANGE}`, acme.cookies);
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.account.code).toBe('1000');
    expect(body.currency).toBe('JOD');
    expect(body.decimals).toBe(3);
    /* Echoed back, so a printed ledger can say which account and which period
     * produced the figures rather than leaving the reader to remember. */
    expect(body.parameters).toMatchObject({ from: '2026-01-01', to: '2026-12-31' });
    expect(body.totals.debit).toBe('30.000');
    expect(body.totals.closingBalance).toBe('30.000');
    expect(body.lines).toHaveLength(3);
    expect(body.watermark).toBeTruthy();
  });

  it('pages over HTTP without the totals moving', async () => {
    const acme = await books('Acme', days(5));

    const first = (await get(`${LEDGER}?accountId=${acme.cash}&${RANGE}&limit=2`, acme.cookies)).json();
    expect(first.lines).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();

    const second = (await get(
      `${LEDGER}?accountId=${acme.cash}&${RANGE}&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
      acme.cookies,
    )).json();

    /* The second page is the NEXT two lines, and the figure at the bottom of
     * the screen is the same on both. */
    expect(lineIds(second.lines)).not.toEqual(lineIds(first.lines));
    expect(second.totals.closingBalance).toBe(first.totals.closingBalance);
    expect(second.totals.lineCount).toBe(5);
  });

  it('rejects an unauthenticated caller before any query', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: `${LEDGER}?accountId=x&${RANGE}` });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a caller denied the viewing permission', async () => {
    const organizationId = await tenant('Acme');
    const denied = await member(organizationId, 'nobody@acme.test', 'viewer',
      [{ subject: 'general_ledger', action: 'view', effect: 'deny' }]);

    const response = await get(`${LEDGER}?accountId=whatever&${RANGE}`, denied.cookies);
    expect(response.statusCode).toBe(403);
  });

  it('refuses a malformed period, and says what a LEDGER needs', async () => {
    const acme = await books('Acme', []);

    const response = await get(
      `${LEDGER}?accountId=${acme.cash}&from=not-a-date&to=2026-12-31`, acme.cookies,
    );
    expect(response.statusCode).toBe(400);
    /* The message must describe THIS query. A ledger has no as-of date, and
     * being told to provide one is being told to fix a field that is not
     * there. */
    expect(response.json().error.message).toMatch(/ledger/i);
    expect(response.json().error.message).not.toMatch(/as-of/i);
  });

  it('refuses a request naming no account at all', async () => {
    const acme = await books('Acme', []);
    const response = await get(`${LEDGER}?${RANGE}`, acme.cookies);
    expect(response.statusCode).toBe(400);
  });

  it('answers an account outside these books as not found', async () => {
    const acme = await books('Acme', days(1));
    const globex = await books('Globex', days(1));

    /* Acme's own credentials, Globex's account id: there is no such account in
     * THESE books, which is the honest answer and not a refusal that would
     * confirm the id exists somewhere. */
    const response = await get(`${LEDGER}?accountId=${globex.cash}&${RANGE}`, acme.cookies);
    expect(response.statusCode).toBe(404);
  });

  it('answers another tenant’s company reference as not found', async () => {
    const acme = await books('Acme', days(1));
    const globex = await books('Globex', days(1));

    const response = await get(
      `${LEDGER}?accountId=${acme.cash}&${RANGE}`, acme.cookies, globex.company.clientReference,
    );
    expect(response.statusCode).toBe(404);
  });
});

/* ══ Export is a different act ═════════════════════════════════════════════ */

describe('the ledger export endpoint', () => {
  it('returns the WHOLE range, not the pages a browser loaded', async () => {
    const acme = await books('Acme', days(12));

    const paged = (await get(`${LEDGER}?accountId=${acme.cash}&${RANGE}&limit=2`, acme.cookies)).json();
    const exported = await get(`${EXPORT}?accountId=${acme.cash}&${RANGE}&limit=2`, acme.cookies);
    expect(exported.statusCode).toBe(200);

    const body = exported.json();
    /* Every line, in one answer, with nothing left to fetch. */
    expect(body.lines).toHaveLength(12);
    expect(body.nextCursor).toBeNull();
    expect(body.complete).toBe(true);
    /* And the same totals the screen showed, so the file and the screen
     * describe the same books. */
    expect(body.totals.closingBalance).toBe(paged.totals.closingBalance);
    expect(body.totals.lineCount).toBe(12);
    /* No line appears twice in the server-side walk. */
    expect(new Set(lineIds(body.lines)).size).toBe(12);
  });

  it('REFUSES a caller who may view the ledger but not export it', async () => {
    const organizationId = await tenant('Acme');
    const reader = await member(organizationId, 'reader@acme.test', 'viewer',
      [{ subject: 'general_ledger', action: 'export', effect: 'deny' }]);
    const chart = await chartFor(organizationId, reader.userId, 'Reader');

    /* Reading on screen: allowed. */
    const viewed = await get(`${LEDGER}?accountId=${chart.cash}&${RANGE}`, reader.cookies);
    expect(viewed.statusCode).toBe(200);

    /* Carrying the whole of it away as a file: not the same act, and refused.
     * If this ever answers 200 the catalogue's `export` action has become
     * decorative. */
    const exported = await get(`${EXPORT}?accountId=${chart.cash}&${RANGE}`, reader.cookies);
    expect(exported.statusCode).toBe(403);
  });

  it('rejects an unauthenticated export before any query', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: `${EXPORT}?accountId=x&${RANGE}` });
    expect(response.statusCode).toBe(401);
  });
});

/* ══ The bound ledger over HTTP ════════════════════════════════════════════ */

describe('the grouped (bound ledger) export endpoint', () => {
  it('returns every posting account in one answer, with one snapshot', async () => {
    const acme = await books('Acme', days(4));

    const response = await get(`${GROUPED}?${RANGE}`, acme.cookies);
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.complete).toBe(true);
    /* One instant for the whole book, not one per account. */
    expect(body.snapshot.at).toBeTruthy();
    expect(body.accounts.length).toBeGreaterThan(0);

    const cash = body.accounts.find((a: { accountCode: string }) => a.accountCode === '1000');
    expect(cash.lines).toHaveLength(4);
    /* Accounts arrive in code order, decided by the server. */
    const codes = body.accounts.map((a: { accountCode: string }) => a.accountCode);
    expect(codes).toEqual([...codes].sort());
  });

  it('REFUSES a caller who may view the ledger but not export it', async () => {
    const organizationId = await tenant('Acme');
    const reader = await member(organizationId, 'reader@acme.test', 'viewer',
      [{ subject: 'general_ledger', action: 'export', effect: 'deny' }]);
    const chart = await chartFor(organizationId, reader.userId, 'Reader');

    /* Reading one account on screen: allowed. */
    const viewed = await get(`${LEDGER}?accountId=${chart.cash}&${RANGE}`, reader.cookies);
    expect(viewed.statusCode).toBe(200);

    /* Carrying the WHOLE bound ledger away: a different act, and refused. */
    const exported = await get(`${GROUPED}?${RANGE}`, reader.cookies);
    expect(exported.statusCode).toBe(403);
  });

  it('rejects an unauthenticated caller before any query', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: `${GROUPED}?${RANGE}` });
    expect(response.statusCode).toBe(401);
  });

  it('carries only the company in scope', async () => {
    const acme = await books('Acme', days(3));
    const globex = await books('Globex', days(2));

    const mine = (await get(`${GROUPED}?${RANGE}`, acme.cookies)).json();
    const theirs = (await get(`${GROUPED}?${RANGE}`, globex.cookies)).json();

    const lineIdsOf = (body: { accounts: Array<{ lines: Array<{ lineId: string }> }> }) =>
      body.accounts.flatMap((a) => a.lines.map((l) => l.lineId));

    const mineIds = new Set(lineIdsOf(mine));
    expect(lineIdsOf(theirs).some((id) => mineIds.has(id))).toBe(false);
    expect(mine.totals.lineCount).toBe(6);
    expect(theirs.totals.lineCount).toBe(4);
  });

  it('answers another tenant’s company reference as not found', async () => {
    const acme = await books('Acme', days(1));
    const globex = await books('Globex', days(1));

    const response = await get(`${GROUPED}?${RANGE}`, acme.cookies, globex.company.clientReference);
    expect(response.statusCode).toBe(404);
  });

  it('refuses a malformed period, and says what a ledger needs', async () => {
    const acme = await books('Acme', []);
    const response = await get(`${GROUPED}?from=not-a-date&to=2026-12-31`, acme.cookies);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/ledger/i);
  });
});

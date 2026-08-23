/**
 * Sales invoices through the real stack.
 *
 * The document lifecycle, the numbering, the ledger link and the permission
 * gates — exercised over HTTP rather than against the service, because the
 * guard is half of what makes an invoice tenant-safe and a service test walks
 * straight past it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeaders, createTestContext, login, seedUser, type SessionCookies, type TestContext } from './helpers/testApp.js';

let ctx: TestContext;
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

async function tenant(name: string): Promise<string> {
  const response = await ctx.app.inject({ method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(admin), payload: {
    fullName: `${name} Owner`, email: `owner@${name.toLowerCase()}.test`, organizationLegalName: `${name} LLC`,
    country: 'JO', baseCurrency: 'JOD', planId: await planId(), onboarding: 'temporary', paymentConfirmed: true,
  } });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().subscriber.organizationId;
}

/** A member of `organizationId` with the given role, signed in. */
async function member(organizationId: string, role: string, email: string): Promise<SessionCookies> {
  const response = await ctx.app.inject({ method: 'POST', url: '/api/admin/users', headers: authHeaders(admin), payload: {
    fullName: 'Invoice Person', email, organizationId, role, onboarding: 'invitation',
  } });
  expect(response.statusCode, response.body).toBe(201);
  await ctx.app.inject({ method: 'POST', url: '/api/auth/reset-password',
    payload: { token: response.json().credential.invitationToken, newPassword: password } });
  return login(ctx, email, password);
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

/** A draft invoice for one JOD 100 line, plus the accounts it needs. */
async function draft(user: SessionCookies, overrides: Record<string, unknown> = {}) {
  const receivable = await account(user, '1200', 'Trade receivables', 'asset');
  const sales = await account(user, '4000', 'Sales', 'income');
  const response = await call('POST', '/api/invoices', user, {
    issuingEntityId: '11111111-1111-1111-1111-111111111111',
    customerId: '22222222-2222-2222-2222-222222222222',
    issueDate: '2026-03-01', dueDate: '2026-03-31',
    lines: [{ accountId: sales, description: 'Consulting', quantity: '1', unitPrice: '100.000' }],
    ...overrides,
  });
  expect(response.statusCode, response.body).toBe(201);
  return { invoice: response.json().invoice, receivable, sales };
}

describe('creating a draft', () => {
  it('numbers it, computes its totals and records who made it', async () => {
    const org = await tenant('Alpha');
    const user = await member(org, 'admin', 'alpha@invoices.test');
    const { invoice } = await draft(user);

    expect(invoice.invoiceNumber).toBe('INV-2026-0001');
    expect(invoice.status).toBe('draft');
    // Totals at the currency's own precision — JOD carries three decimals.
    expect(invoice.subtotal).toBe('100.000');
    expect(invoice.grandTotal).toBe('100.000');
    expect(invoice.balanceDue).toBe('100.000');

    const history = await call('GET', `/api/invoices/${invoice.id}/history`, user);
    expect(history.json().history[0]).toMatchObject({ action: 'invoice.created' });
  });

  it('recomputes the total rather than believing the caller', async () => {
    const org = await tenant('Bravo');
    const user = await member(org, 'admin', 'bravo@invoices.test');
    const sales = await account(user, '4000', 'Sales', 'income');

    const response = await call('POST', '/api/invoices', user, {
      issuingEntityId: '11111111-1111-1111-1111-111111111111',
      customerId: '22222222-2222-2222-2222-222222222222',
      issueDate: '2026-03-01', dueDate: '2026-03-31',
      grandTotal: '1.000', // A client cannot price its own tax document.
      lines: [{ accountId: sales, quantity: '2', unitPrice: '50.000' }],
    });

    expect(response.json().invoice.grandTotal).toBe('100.000');
  });

  it('refuses a line pointed at a parent account', async () => {
    const org = await tenant('Charlie');
    const user = await member(org, 'admin', 'charlie@invoices.test');
    const parentResponse = await call('POST', '/api/accounting/accounts', user, {
      accountCode: '4000', accountName: 'Revenue', accountType: 'income', isPostable: false,
    });
    expect(parentResponse.statusCode, parentResponse.body).toBe(201);
    const parent = parentResponse.json().account.id;
    const child = await call('POST', '/api/accounting/accounts', user, {
      accountCode: '4100', accountName: 'Services', accountType: 'income', parentAccountId: parent,
    });
    expect(child.statusCode).toBe(201);

    const response = await call('POST', '/api/invoices', user, {
      issuingEntityId: '11111111-1111-1111-1111-111111111111',
      customerId: '22222222-2222-2222-2222-222222222222',
      issueDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{ accountId: parent, quantity: '1', unitPrice: '10.000' }],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/parent accounts cannot receive transactions/i);
  });

  it('refuses a due date before the issue date', async () => {
    const org = await tenant('Delta');
    const user = await member(org, 'admin', 'delta@invoices.test');
    const sales = await account(user, '4000', 'Sales', 'income');
    const response = await call('POST', '/api/invoices', user, {
      issuingEntityId: '11111111-1111-1111-1111-111111111111',
      customerId: '22222222-2222-2222-2222-222222222222',
      issueDate: '2026-03-31', dueDate: '2026-03-01',
      lines: [{ accountId: sales, quantity: '1', unitPrice: '10.000' }],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/due date cannot fall before/i);
  });
});

describe('numbering', () => {
  it('advances per entity and never reuses a number after a deletion', async () => {
    const org = await tenant('Echo');
    const user = await member(org, 'admin', 'echo@invoices.test');
    const { invoice: first } = await draft(user);
    expect(first.invoiceNumber).toBe('INV-2026-0001');

    const deleted = await call('DELETE', `/api/invoices/${first.id}`, user, { expectedVersion: first.version });
    expect(deleted.statusCode).toBe(204);

    // A counted sequence would hand out INV-2026-0001 again; a tax authority
    // that already cleared the first would reject the second.
    const sales = await call('GET', '/api/accounting/accounts', user);
    const salesId = sales.json().accounts.find((a: { accountCode: string }) => a.accountCode === '4000').id;
    const second = await call('POST', '/api/invoices', user, {
      issuingEntityId: '11111111-1111-1111-1111-111111111111',
      customerId: '22222222-2222-2222-2222-222222222222',
      issueDate: '2026-03-02', dueDate: '2026-03-31',
      lines: [{ accountId: salesId, quantity: '1', unitPrice: '5.000' }],
    });
    expect(second.json().invoice.invoiceNumber).toBe('INV-2026-0002');
  });

  it('gives two tenants the same first number without collision', async () => {
    const alpha = await member(await tenant('Foxtrot'), 'admin', 'foxtrot@invoices.test');
    const bravo = await member(await tenant('Golf'), 'admin', 'golf@invoices.test');

    const one = await draft(alpha);
    const two = await draft(bravo);
    expect(one.invoice.invoiceNumber).toBe('INV-2026-0001');
    expect(two.invoice.invoiceNumber).toBe('INV-2026-0001');
  });
});

describe('issuing', () => {
  it('posts to the ledger and links both directions', async () => {
    const org = await tenant('Hotel');
    const user = await member(org, 'admin', 'hotel@invoices.test');
    const { invoice, receivable } = await draft(user);

    const issued = await call('POST', `/api/invoices/${invoice.id}/issue`, user, {
      expectedVersion: invoice.version, receivableAccountId: receivable,
    });
    expect(issued.statusCode, issued.body).toBe(200);
    expect(issued.json().invoice.status).toBe('issued');

    const entryId = issued.json().invoice.journalEntryId;
    expect(entryId).toBeTruthy();

    // The forward link and the back link must agree, or nothing can reconcile
    // the document to the books.
    const entry = await call('GET', `/api/accounting/journals/${entryId}`, user);
    expect(entry.statusCode, entry.body).toBe(200);
    expect(entry.json().journal).toMatchObject({
      status: 'posted', sourceType: 'sales_invoice', sourceId: invoice.id,
    });
  });

  it('refuses a stale version rather than overwriting a concurrent change', async () => {
    const org = await tenant('India');
    const user = await member(org, 'admin', 'india@invoices.test');
    const { invoice, receivable } = await draft(user);

    const response = await call('POST', `/api/invoices/${invoice.id}/issue`, user, {
      expectedVersion: invoice.version + 5, receivableAccountId: receivable,
    });
    expect(response.statusCode).toBe(409);
  });

  it('will not issue the same invoice twice', async () => {
    const org = await tenant('Juliet');
    const user = await member(org, 'admin', 'juliet@invoices.test');
    const { invoice, receivable } = await draft(user);

    const first = await call('POST', `/api/invoices/${invoice.id}/issue`, user, {
      expectedVersion: invoice.version, receivableAccountId: receivable,
    });
    expect(first.statusCode).toBe(200);

    const again = await call('POST', `/api/invoices/${invoice.id}/issue`, user, {
      expectedVersion: first.json().invoice.version, receivableAccountId: receivable,
    });
    expect(again.statusCode).toBe(409);
  });
});

describe('voiding', () => {
  it('reverses the ledger entry and keeps both documents', async () => {
    const org = await tenant('Kilo');
    const user = await member(org, 'admin', 'kilo@invoices.test');
    const { invoice, receivable } = await draft(user);
    const issued = (await call('POST', `/api/invoices/${invoice.id}/issue`, user, {
      expectedVersion: invoice.version, receivableAccountId: receivable,
    })).json().invoice;

    const voided = await call('POST', `/api/invoices/${invoice.id}/void`, user, {
      expectedVersion: issued.version, reason: 'Wrong customer',
    });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(voided.json().invoice).toMatchObject({ status: 'void', voidReason: 'Wrong customer' });

    // Both entries survive: the original is evidence, the reversal withdraws it.
    expect(voided.json().invoice.journalEntryId).toBe(issued.journalEntryId);
    expect(voided.json().invoice.reversalJournalEntryId).toBeTruthy();
  });

  it('requires a reason', async () => {
    const org = await tenant('Lima');
    const user = await member(org, 'admin', 'lima@invoices.test');
    const { invoice, receivable } = await draft(user);
    const issued = (await call('POST', `/api/invoices/${invoice.id}/issue`, user, {
      expectedVersion: invoice.version, receivableAccountId: receivable,
    })).json().invoice;

    const response = await call('POST', `/api/invoices/${invoice.id}/void`, user, {
      expectedVersion: issued.version,
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses to delete an issued invoice — the number has been used', async () => {
    const org = await tenant('Mike');
    const user = await member(org, 'admin', 'mike@invoices.test');
    const { invoice, receivable } = await draft(user);
    const issued = (await call('POST', `/api/invoices/${invoice.id}/issue`, user, {
      expectedVersion: invoice.version, receivableAccountId: receivable,
    })).json().invoice;

    const response = await call('DELETE', `/api/invoices/${invoice.id}`, user, {
      expectedVersion: issued.version,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/voided, never deleted/i);
  });
});

describe('tenant isolation and permissions', () => {
  it('does not show one tenant another tenant invoice', async () => {
    const alpha = await member(await tenant('November'), 'admin', 'november@invoices.test');
    const bravo = await member(await tenant('Oscar'), 'admin', 'oscar@invoices.test');
    const { invoice } = await draft(alpha);

    // Not "forbidden" — from Bravo's side this id simply does not exist.
    expect((await call('GET', `/api/invoices/${invoice.id}`, bravo)).statusCode).toBe(404);
    expect((await call('GET', '/api/invoices', bravo)).json().invoices).toEqual([]);
  });

  it('lets a read-only auditor look but not write', async () => {
    const org = await tenant('Papa');
    const owner = await member(org, 'admin', 'papa@invoices.test');
    const auditor = await member(org, 'viewer', 'auditor@papa.test');
    const { invoice, sales } = await draft(owner);

    expect((await call('GET', `/api/invoices/${invoice.id}`, auditor)).statusCode).toBe(200);
    const attempt = await call('POST', '/api/invoices', auditor, {
      issuingEntityId: '11111111-1111-1111-1111-111111111111',
      customerId: '22222222-2222-2222-2222-222222222222',
      issueDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{ accountId: sales, quantity: '1', unitPrice: '1.000' }],
    });
    expect(attempt.statusCode).toBe(403);
  });

  it('lets a standard user author but not post to the ledger', async () => {
    const org = await tenant('Quebec');
    const owner = await member(org, 'admin', 'quebec@invoices.test');
    const author = await member(org, 'member', 'author@quebec.test');
    const { invoice, receivable } = await draft(owner);

    // Authoring is `create`/`edit`; issuing changes the LEDGER and needs `post`.
    const response = await call('POST', `/api/invoices/${invoice.id}/issue`, author, {
      expectedVersion: invoice.version, receivableAccountId: receivable,
    });
    expect(response.statusCode).toBe(403);
  });
});

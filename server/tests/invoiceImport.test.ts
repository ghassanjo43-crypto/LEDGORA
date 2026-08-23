/**
 * Migrating a company's browser invoices into the database.
 *
 * The migration is not the create path with a flag: a migrated invoice keeps
 * its number, keeps its status, and posts nothing to the ledger. Each of those
 * is a way the ordinary path would corrupt history, and each is pinned here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { authHeaders, createTestContext, login, seedUser, type SessionCookies, type TestContext } from './helpers/testApp.js';
import { sequenceOf } from '../src/services/invoicing/invoiceImportService.js';

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

async function tenantUser(name: string): Promise<SessionCookies> {
  const created = await ctx.app.inject({ method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(admin), payload: {
    fullName: `${name} Owner`, email: `owner@${name.toLowerCase()}.test`, organizationLegalName: `${name} LLC`,
    country: 'JO', baseCurrency: 'JOD', planId: await planId(), onboarding: 'temporary', paymentConfirmed: true,
  } });
  expect(created.statusCode, created.body).toBe(201);

  const invited = await ctx.app.inject({ method: 'POST', url: '/api/admin/users', headers: authHeaders(admin), payload: {
    fullName: 'Migrator', email: `mig@${name.toLowerCase()}.test`,
    organizationId: created.json().subscriber.organizationId, role: 'admin', onboarding: 'invitation',
  } });
  expect(invited.statusCode, invited.body).toBe(201);
  await ctx.app.inject({ method: 'POST', url: '/api/auth/reset-password',
    payload: { token: invited.json().credential.invitationToken, newPassword: password } });
  return login(ctx, `mig@${name.toLowerCase()}.test`, password);
}

const call = (method: 'GET' | 'POST', url: string, user: SessionCookies, payload?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, headers: authHeaders(user), payload });

async function account(user: SessionCookies, code: string, name: string, type = 'income'): Promise<string> {
  const response = await call('POST', '/api/accounting/accounts', user, {
    accountCode: code, accountName: name, accountType: type,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().account.id;
}

const ENTITY = '11111111-1111-1111-1111-111111111111';
const CUSTOMER = '22222222-2222-2222-2222-222222222222';

/** One invoice as the browser holds it — account referenced by CODE. */
const browserInvoice = (over: Record<string, unknown> = {}) => ({
  invoiceNumber: 'INV-2025-0042',
  status: 'issued',
  issuingEntityId: ENTITY,
  customerId: CUSTOMER,
  issueDate: '2025-06-01',
  dueDate: '2025-06-30',
  subtotal: '100.000', taxTotal: '16.000', grandTotal: '116.000', amountPaid: '0',
  lines: [{ accountCode: '4000', description: 'Consulting', quantity: '1', unitPrice: '100.000', lineSubtotal: '100.000', lineTotal: '116.000' }],
  ...over,
});

const importInvoices = (user: SessionCookies, list: unknown[]) =>
  call('POST', '/api/invoices/import', user, { invoices: list });

describe('what migration preserves', () => {
  it('keeps the number, the status and the issue date', async () => {
    const user = await tenantUser('Alpha');
    await account(user, '4000', 'Sales');

    const response = await importInvoices(user, [browserInvoice()]);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().outcome).toMatchObject({ imported: 1, skipped: 0, failures: [] });

    const list = (await call('GET', '/api/invoices', user)).json().invoices;
    expect(list).toHaveLength(1);
    // The number is on a document the customer already holds. Re-numbering it
    // would make our records disagree with theirs.
    expect(list[0]).toMatchObject({
      invoiceNumber: 'INV-2025-0042', status: 'issued', issueDate: '2025-06-01', grandTotal: '116.000',
    });
  });

  it('posts nothing to the ledger, and says so on the invoice', async () => {
    const user = await tenantUser('Bravo');
    await account(user, '4000', 'Sales');
    await importInvoices(user, [browserInvoice()]);

    const invoice = (await call('GET', '/api/invoices', user)).json().invoices[0];
    // The entry for this sale already exists in the books it came from.
    // Posting again would double-count every migrated sale.
    expect(invoice.journalEntryId).toBeNull();

    const journals = await call('GET', '/api/accounting/journals', user);
    expect(journals.json().journals).toEqual([]);

    const history = (await call('GET', `/api/invoices/${invoice.id}/history`, user)).json().history;
    expect(history[0].action).toBe('invoice.imported');
    expect(history[0].detail).toMatch(/no ledger entry was posted/i);
  });
});

describe('unmatched accounts', () => {
  it('lands the line on a suspense account and records which code was missing', async () => {
    const user = await tenantUser('Charlie');
    // Deliberately NOT creating 4000 — the browser chart was never imported.
    const response = await importInvoices(user, [browserInvoice()]);

    expect(response.json().outcome).toMatchObject({
      imported: 1,
      unmatchedAccounts: [{ invoiceNumber: 'INV-2025-0042', accountCode: '4000' }],
    });

    // A migration that stopped on the first unmapped line would strand the
    // other nine hundred, so the value is parked somewhere real and visible.
    const accounts = (await call('GET', '/api/accounting/accounts', user)).json().accounts;
    const suspense = accounts.find((a: { accountCode: string }) => a.accountCode === '9999');
    expect(suspense).toMatchObject({ accountName: 'Migration suspense', isPostable: true });

    const invoice = (await call('GET', '/api/invoices', user)).json().invoices[0];
    const history = (await call('GET', `/api/invoices/${invoice.id}/history`, user)).json().history;
    expect(history.some((e: { action: string }) => e.action === 'invoice.import_account_unmatched')).toBe(true);
  });
});

describe('re-running the migration', () => {
  it('skips what is already there instead of duplicating it', async () => {
    const user = await tenantUser('Delta');
    await account(user, '4000', 'Sales');

    expect((await importInvoices(user, [browserInvoice()])).json().outcome.imported).toBe(1);
    // An interrupted migration is resumed by running it again.
    const second = await importInvoices(user, [browserInvoice()]);
    expect(second.json().outcome).toMatchObject({ imported: 0, skipped: 1 });
    expect((await call('GET', '/api/invoices', user)).json().invoices).toHaveLength(1);
  });
});

describe('numbering after a migration', () => {
  it('advances the sequence past everything imported', async () => {
    const user = await tenantUser('Echo');
    const sales = await account(user, '4000', 'Sales');
    await account(user, '1200', 'Receivables', 'asset');

    await importInvoices(user, [
      browserInvoice({ invoiceNumber: 'INV-2025-0041' }),
      browserInvoice({ invoiceNumber: 'INV-2025-0042' }),
    ]);

    /*
     * THE failure this guards. Without advancing the sequence, the first
     * invoice created after a migration is numbered 0001 — a number a customer
     * already holds, and one an authority may already have cleared.
     */
    const created = await call('POST', '/api/invoices', user, {
      issuingEntityId: ENTITY, customerId: CUSTOMER,
      issueDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{ accountId: sales, quantity: '1', unitPrice: '10.000' }],
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().invoice.invoiceNumber).toBe('INV-2026-0043');
  });

  it('never moves an existing sequence backwards', async () => {
    const user = await tenantUser('Foxtrot');
    const sales = await account(user, '4000', 'Sales');

    // Live numbering is already well past the historical records.
    const first = await call('POST', '/api/invoices', user, {
      issuingEntityId: ENTITY, customerId: CUSTOMER,
      issueDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{ accountId: sales, quantity: '1', unitPrice: '10.000' }],
    });
    expect(first.json().invoice.invoiceNumber).toBe('INV-2026-0001');

    await importInvoices(user, [browserInvoice({ invoiceNumber: 'OLD-1' })]);

    const next = await call('POST', '/api/invoices', user, {
      issuingEntityId: ENTITY, customerId: CUSTOMER,
      issueDate: '2026-03-02', dueDate: '2026-03-31',
      lines: [{ accountId: sales, quantity: '1', unitPrice: '10.000' }],
    });
    // Importing "OLD-1" must not reset the live sequence to 2.
    expect(next.json().invoice.invoiceNumber).toBe('INV-2026-0002');
  });

  it('reads the sequence off the tail of a number, or declines to guess', () => {
    expect(sequenceOf('INV-2026-0042')).toBe(42);
    expect(sequenceOf('2025/A/7')).toBe(7);
    expect(sequenceOf('DRAFT')).toBeNull();
  });
});

describe('constraints the browser never had', () => {
  it('supplies a void reason rather than aborting on a record that lacks one', async () => {
    const user = await tenantUser('Golf');
    await account(user, '4000', 'Sales');

    // The table requires a reason on a void invoice; browser records predate
    // that rule, so a stand-in is recorded instead of losing the document.
    const response = await importInvoices(user, [browserInvoice({ status: 'void', voidReason: undefined })]);
    expect(response.json().outcome.imported).toBe(1);

    const invoice = (await call('GET', '/api/invoices', user)).json().invoices[0];
    expect(invoice).toMatchObject({ status: 'void', voidReason: 'Voided before migration' });
  });

  it('reports a bad record without abandoning the good ones', async () => {
    const user = await tenantUser('Hotel');
    await account(user, '4000', 'Sales');

    const response = await importInvoices(user, [
      browserInvoice({ invoiceNumber: 'GOOD-1' }),
      browserInvoice({ invoiceNumber: 'BAD-1', issueDate: 'not-a-date' }),
      browserInvoice({ invoiceNumber: 'GOOD-2' }),
    ]);

    const outcome = response.json().outcome;
    expect(outcome.imported).toBe(2);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toMatchObject({ invoiceNumber: 'BAD-1' });
  });
});

describe('tenant isolation', () => {
  it('imports into the caller own organization and nowhere else', async () => {
    const alpha = await tenantUser('India');
    const bravo = await tenantUser('Juliet');
    await account(alpha, '4000', 'Sales');

    await importInvoices(alpha, [browserInvoice()]);

    expect((await call('GET', '/api/invoices', bravo)).json().invoices).toEqual([]);
    const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM invoices`.execute(ctx.db);
    expect(rows[0]!.n).toBe(1);
  });
});

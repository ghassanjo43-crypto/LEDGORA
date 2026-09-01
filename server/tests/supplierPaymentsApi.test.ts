/**
 * Supplier payments through the real stack.
 *
 * The service tests prove the accounting. These prove the half a service test
 * walks straight past: the permission gates, the company scope, and that the
 * refusals reach a client as refusals rather than as a 500 — including the one
 * a user will actually meet, trying to reverse a bill they have already paid.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeaders, createTestContext, login, seedUser,
  type SessionCookies, type TestContext,
} from './helpers/testApp.js';

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
  const response = await ctx.app.inject({
    method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(admin),
    payload: {
      fullName: `${name} Owner`, email: `owner@${name.toLowerCase()}.test`,
      organizationLegalName: `${name} LLC`, country: 'JO', baseCurrency: 'JOD',
      planId: await planId(), onboarding: 'temporary', paymentConfirmed: true,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().subscriber.organizationId;
}

async function member(organizationId: string, role: string, email: string): Promise<SessionCookies> {
  const response = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: authHeaders(admin),
    payload: { fullName: 'Payment Person', email, organizationId, role, onboarding: 'invitation' },
  });
  expect(response.statusCode, response.body).toBe(201);
  await ctx.app.inject({
    method: 'POST', url: '/api/auth/reset-password',
    payload: { token: response.json().credential.invitationToken, newPassword: password },
  });
  return login(ctx, email, password);
}

const call = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  user: SessionCookies,
  payload?: Record<string, unknown>,
) => ctx.app.inject({ method, url, headers: authHeaders(user), payload });

async function account(
  user: SessionCookies, code: string, name: string, type: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const response = await call('POST', '/api/accounting/accounts', user, {
    accountCode: code, accountName: name, accountType: type, ...extra,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().account.id;
}

const ENTITY = '11111111-1111-1111-1111-111111111111';

/** A tenant with a chart, a supplier, and one posted JOD 1,000 bill. */
async function books(name: string, role = 'admin') {
  const org = await tenant(name);
  const user = await member(org, role, `${name.toLowerCase()}@payments.test`);

  const payable = await account(user, '2100', 'Accounts payable', 'liability');
  const expense = await account(user, '5100', 'Professional fees', 'expense');
  const bank = await account(user, '1100', 'Bank current', 'asset', {
    cashClassification: 'cash_and_cash_equivalents',
  });

  const supplier = await call('POST', '/api/vendors', user, {
    partyCode: 'ACME', legalName: 'Acme Supplies Ltd',
    supplier: { defaultPayableAccountId: payable },
  });
  expect(supplier.statusCode, supplier.body).toBe(201);
  const supplierId = supplier.json().supplier.id;

  const drafted = await call('POST', '/api/bills', user, {
    issuingEntityId: ENTITY, supplierId, supplierInvoiceNumber: 'SUP-001',
    billDate: '2026-03-01', dueDate: '2026-03-31',
    lines: [{ accountId: expense, description: 'Services', quantity: '1', unitPrice: '1000.000' }],
  });
  expect(drafted.statusCode, drafted.body).toBe(201);
  const bill = drafted.json().bill;

  const posted = await call('POST', `/api/bills/${bill.id}/post`, user, {
    expectedVersion: bill.version,
  });
  expect(posted.statusCode, posted.body).toBe(200);

  return { org, user, supplierId, bank, payable, expense, bill: posted.json().bill };
}

/** Draft and post a payment settling the whole bill. */
async function settle(
  user: SessionCookies, supplierId: string, bank: string, billId: string, amount = '1000.000',
) {
  const drafted = await call('POST', '/api/payments', user, {
    issuingEntityId: ENTITY, supplierId, paymentDate: '2026-04-01',
    amount, cashAccountId: bank, reference: 'TRF-1',
  });
  expect(drafted.statusCode, drafted.body).toBe(201);
  const payment = drafted.json().payment;

  const posted = await call('POST', `/api/payments/${payment.id}/post`, user, {
    expectedVersion: payment.version,
    allocations: [{ billId, amount }],
  });
  expect(posted.statusCode, posted.body).toBe(200);
  return posted.json().payment;
}

describe('the payment lifecycle over HTTP', () => {
  it('drafts, posts, reallocates and reverses', async () => {
    const { user, supplierId, bank, bill, payable } = await books('Alpha');
    const payment = await settle(user, supplierId, bank, bill.id);

    expect(payment.paymentNumber).toBe('PAY-2026-0001');
    expect(payment.status).toBe('posted');
    expect(payment.payableAccountId).toBe(payable);
    expect(payment.allocations).toHaveLength(1);

    /* A second bill to move the money onto. */
    const second = await call('POST', '/api/bills', user, {
      issuingEntityId: ENTITY, supplierId, supplierInvoiceNumber: 'SUP-002',
      billDate: '2026-03-05', dueDate: '2026-04-05',
      lines: [{ accountId: bill.lines[0].accountId, quantity: '1', unitPrice: '1000.000' }],
    });
    const secondBill = second.json().bill;
    await call('POST', `/api/bills/${secondBill.id}/post`, user, {
      expectedVersion: secondBill.version,
    });

    const moved = await call('POST', `/api/payments/${payment.id}/reallocate`, user, {
      expectedVersion: payment.version,
      allocations: [{ billId: secondBill.id, amount: '1000.000' }],
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().payment.allocations[0].billId).toBe(secondBill.id);

    const reversed = await call('POST', `/api/payments/${payment.id}/reverse`, user, {
      expectedVersion: moved.json().payment.version, reason: 'Bank returned it',
    });
    expect(reversed.statusCode, reversed.body).toBe(200);
    expect(reversed.json().payment.status).toBe('reversed');
    expect(reversed.json().payment.allocations).toEqual([]);
  });

  it('refuses to reverse a paid bill, and says how to proceed', async () => {
    const { user, supplierId, bank, bill } = await books('Bravo');
    const payment = await settle(user, supplierId, bank, bill.id);

    const attempt = await call('POST', `/api/bills/${bill.id}/reverse`, user, {
      expectedVersion: bill.version, reason: 'Wrong supplier',
    });

    /* A CONFLICT, not a 500 and not a silent success. */
    expect(attempt.statusCode, attempt.body).toBe(409);
    const message = attempt.json().error.message;
    expect(message).toContain(payment.paymentNumber);
    expect(message).toContain('1000.000');
    expect(message).toMatch(/reverse that payment first/i);
    expect(message).toMatch(/reallocate its full amount/i);
  });

  it('refuses an under-allocated payment as a validation error', async () => {
    const { user, supplierId, bank, bill } = await books('Charlie');
    const drafted = await call('POST', '/api/payments', user, {
      issuingEntityId: ENTITY, supplierId, paymentDate: '2026-04-01',
      amount: '1000.000', cashAccountId: bank,
    });
    const payment = drafted.json().payment;

    const attempt = await call('POST', `/api/payments/${payment.id}/post`, user, {
      expectedVersion: payment.version,
      allocations: [{ billId: bill.id, amount: '400.000' }],
    });
    expect(attempt.statusCode, attempt.body).toBe(400);
    expect(attempt.json().error.message).toMatch(/allocated in full|unapplied cash/i);
  });

  it('refuses a post with NO allocations at the schema, before any work is done', async () => {
    const { user, supplierId, bank } = await books('Delta');
    const drafted = await call('POST', '/api/payments', user, {
      issuingEntityId: ENTITY, supplierId, paymentDate: '2026-04-01',
      amount: '1000.000', cashAccountId: bank,
    });
    const payment = drafted.json().payment;

    const attempt = await call('POST', `/api/payments/${payment.id}/post`, user, {
      expectedVersion: payment.version, allocations: [],
    });
    expect(attempt.statusCode, attempt.body).toBe(400);
  });
});

describe('reading what is owed', () => {
  it('serves the outstanding schedule, the ageing and the supplier statement', async () => {
    const { user, supplierId, bank, bill } = await books('Echo');
    await settle(user, supplierId, bank, bill.id, '400.000');

    const owed = await call('GET', '/api/payments/payables?asOfDate=2026-06-01', user);
    expect(owed.statusCode, owed.body).toBe(200);
    const row = owed.json().outstanding.find((r: { billId: string }) => r.billId === bill.id);
    expect(row.outstanding).toBe('600.000');
    expect(owed.json().aging.total).toBe('600.000');

    const statement = await call(
      'GET',
      `/api/payments/statement?supplierId=${supplierId}&periodStart=2026-01-01&periodEnd=2026-12-31`,
      user,
    );
    expect(statement.statusCode, statement.body).toBe(200);
    expect(statement.json().statement.closingBalance).toBe('600.000');
    expect(statement.json().statement.isReconciled).toBe(true);
  });

  it('does not read `payables` or `statement` as a payment identifier', async () => {
    const { user } = await books('Foxtrot');
    /* If the parametric route won, these would be 404 "Payment not found" or a
     * uuid parse failure rather than a report. */
    expect((await call('GET', '/api/payments/payables', user)).statusCode).toBe(200);
    const statement = await call('GET', '/api/payments/statement', user);
    /* No supplier named — a validation error from the REPORT, not a lookup. */
    expect(statement.statusCode).toBe(400);
  });
});

describe('who may do what', () => {
  it('lets a viewer read payments but not create, post or reverse one', async () => {
    const owner = await books('Golf');
    const payment = await settle(owner.user, owner.supplierId, owner.bank, owner.bill.id);
    const viewer = await member(owner.org, 'viewer', 'viewer@payments.test');

    expect((await call('GET', '/api/payments', viewer)).statusCode).toBe(200);

    const created = await call('POST', '/api/payments', viewer, {
      issuingEntityId: ENTITY, supplierId: owner.supplierId, paymentDate: '2026-04-01',
      amount: '10.000', cashAccountId: owner.bank,
    });
    expect(created.statusCode).toBe(403);

    const reversed = await call('POST', `/api/payments/${payment.id}/reverse`, viewer, {
      expectedVersion: payment.version, reason: 'Nope',
    });
    expect(reversed.statusCode).toBe(403);
  });

  it("refuses another tenant's payment outright", async () => {
    const mine = await books('Hotel');
    const payment = await settle(mine.user, mine.supplierId, mine.bank, mine.bill.id);

    const stranger = await books('India');
    const peek = await call('GET', `/api/payments/${payment.id}`, stranger.user);
    /* Not found rather than forbidden: the payment does not exist in their
     * books, and saying "forbidden" would confirm that it exists somewhere. */
    expect(peek.statusCode).toBe(404);
  });
});

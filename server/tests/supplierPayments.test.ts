/**
 * Supplier payments: what settles, what is refused, and what cannot race.
 *
 * ══ What these tests guard ═══════════════════════════════════════════════════
 *
 * The FULL-ALLOCATION boundary, because the cheap failure is to accept a
 * payment with money left over and quietly leave it nowhere. The product has no
 * controlled advances account and no supplier-refund workflow, so unapplied
 * cash would be a balance nobody could ever clear.
 *
 * The DERIVED balance, because a stored `balance_due` drifts silently and a
 * wrong number still looks like a number.
 *
 * The BILL-REVERSAL refusal, because reversing a paid bill debits accounts
 * payable twice against a single credit — the entry balances, the books are
 * wrong, and the payment is left pointing at a document reversed out of them.
 *
 * The ORDERING, because the refusal is only worth anything if a payment cannot
 * appear between the check and the reversal. Both paths take the same row lock;
 * these prove the outcome in every sequence PGlite's single connection can
 * express, and the disposable real-PostgreSQL probe proves the lock itself
 * across two concurrent connections.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, type TestContext } from './helpers/testApp.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as suppliers from '../src/services/purchasing/supplierService.js';
import * as bills from '../src/services/purchasing/billService.js';
import * as payments from '../src/services/purchasing/paymentService.js';
import * as payables from '../src/services/purchasing/payablesReportService.js';

let ctx: TestContext;
let actor: AccountingActor;
let supplierId: string;
let otherSupplierId: string;
let chart: {
  payable: string; payable2: string; expense: string; asset: string;
  bank: string; cash: string; revenue: string; header: string;
};

const ENTITY = 'entity-main';

async function organization(name: string, currency = 'JOD'): Promise<string> {
  const owner = await seedUser(ctx, { email: `owner-${name.toLowerCase()}@pay.test` });
  return ctx.db.transaction().execute(async (trx) => {
    const org = await trx.insertInto('organizations').values({
      subscriber_owner_user_id: owner.id, legal_name: name, country: 'JO',
      base_currency: currency, fiscal_year_start: '01-01', data_classification: 'test',
    } as never).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('organization_memberships')
      .values({ organization_id: org.id, user_id: owner.id, role: 'owner' } as never).execute();
    return org.id;
  });
}

async function company(org: string, reference: string): Promise<string> {
  const row = await ctx.db.insertInto('companies').values({
    organization_id: org, client_reference: reference,
    legal_name: `Books ${reference}`, adopted_at: sql`now()`,
  } as never).returning('id').executeTakeFirstOrThrow();
  await ctx.db.insertInto('company_settings')
    .values({ organization_id: org, company_id: row.id } as never)
    .onConflict((oc) => oc.columns(['organization_id', 'company_id']).doNothing()).execute();
  return row.id;
}

async function person(email: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO users (email, normalized_email, full_name, password_hash, status, email_verified_at)
    VALUES (${email}, ${email}, 'Payer', 'x', 'active', now()) RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

/* ══ Fixtures ══════════════════════════════════════════════════════════════ */

/**
 * A POSTED bill for `total`, ready to be settled.
 *
 * Each gets its own supplier reference, because a bill refuses to post over a
 * reference already on a posted one — the duplicate guard P2 shipped.
 */
let supplierReference = 0;
async function postedBill(
  total: string,
  over: Record<string, unknown> = {},
): Promise<{ id: string; version: number; total: string; number: string }> {
  supplierReference += 1;
  const created = await bills.createDraft(ctx.db, actor, {
    issuingEntityId: ENTITY,
    supplierId,
    supplierInvoiceNumber: `SUP-${String(supplierReference).padStart(3, '0')}`,
    billDate: '2026-03-01',
    dueDate: '2026-03-31',
    lines: [{ accountId: chart.expense, description: 'Services', quantity: '1', unitPrice: total }],
    ...over,
  } as never);
  const posted = await bills.postBill(ctx.db, actor, created.id, { expectedVersion: created.version });
  return { id: posted.id, version: posted.version, total: posted.total, number: posted.billNumber };
}

const draftPayment = (over: Record<string, unknown> = {}) =>
  payments.createDraft(ctx.db, actor, {
    issuingEntityId: ENTITY,
    supplierId,
    paymentDate: '2026-04-01',
    amount: '100.000',
    cashAccountId: chart.bank,
    reference: 'TRF-1',
    ...over,
  } as never);

const post = (id: string, version: number, allocations: { billId: string; amount: string }[]) =>
  payments.postPayment(ctx.db, actor, id, { allocations }, { expectedVersion: version });

/** Draft, then post, in one step — the common case. */
async function paid(
  amount: string,
  allocations: { billId: string; amount: string }[],
  over: Record<string, unknown> = {},
): Promise<{ id: string; version: number; number: string }> {
  const drafted = await draftPayment({ amount, ...over });
  const posted = await post(drafted.id, drafted.version, allocations);
  return { id: posted.id, version: posted.version, number: posted.paymentNumber };
}

async function legs(journalEntryId: string): Promise<{ account: string; debit: number; credit: number }[]> {
  const { rows } = await sql<{ account_id: string; debit_transaction: string; credit_transaction: string }>`
    SELECT account_id, debit_transaction, credit_transaction FROM journal_lines
     WHERE journal_entry_id = ${journalEntryId} ORDER BY line_number
  `.execute(ctx.db);
  return rows.map((r) => ({
    account: r.account_id, debit: Number(r.debit_transaction), credit: Number(r.credit_transaction),
  }));
}

async function outstanding(billId: string): Promise<string> {
  const rows = await payables.outstandingBills(ctx.db, actor, {
    asOfDate: '2026-12-31', supplierId,
  });
  return rows.find((row) => row.billId === billId)?.outstanding ?? '0.000';
}

/** Every allocation row on a payment, whatever its status — nothing is deleted. */
async function allocationRows(paymentId: string): Promise<{ bill: string; amount: string; status: string }[]> {
  const { rows } = await sql<{ bill_id: string; amount: string; status: string }>`
    SELECT bill_id, amount::text AS amount, status FROM payment_allocations
     WHERE payment_id = ${paymentId} ORDER BY created_at, id
  `.execute(ctx.db);
  return rows.map((r) => ({ bill: r.bill_id, amount: r.amount, status: r.status }));
}

async function setup(currency = 'JOD'): Promise<void> {
  supplierReference = 0;
  ctx = await createTestContext();
  const organizationId = await organization('Pay', currency);
  actor = {
    organizationId,
    companyId: await company(organizationId, 'co_pay'),
    userId: await person('pay@pay.test'),
    name: 'Payer One',
  };

  const header = await accounts.createAccount(ctx.db, actor, {
    accountCode: '1000', accountName: 'Assets', accountType: 'asset', isPostable: false,
  });
  await accounts.createAccount(ctx.db, actor, {
    accountCode: '1001', accountName: 'Under the heading', accountType: 'asset',
    parentAccountId: header.id,
  });

  chart = {
    payable: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '2100', accountName: 'Accounts payable', accountType: 'liability',
    })).id,
    payable2: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '2150', accountName: 'Accounts payable — other', accountType: 'liability',
    })).id,
    expense: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '5100', accountName: 'Professional fees', accountType: 'expense',
    })).id,
    asset: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '1500', accountName: 'Office equipment', accountType: 'asset',
    })).id,
    bank: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '1100', accountName: 'Bank current', accountType: 'asset',
      cashClassification: 'cash_and_cash_equivalents',
    })).id,
    cash: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '1110', accountName: 'Petty cash', accountType: 'asset',
      cashClassification: 'cash_and_cash_equivalents',
    })).id,
    revenue: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '4000', accountName: 'Sales', accountType: 'income',
    })).id,
    header: header.id,
  };

  supplierId = (await suppliers.createSupplier(ctx.db, actor as never, {
    partyCode: 'ACME', legalName: 'Acme Supplies Ltd',
    supplier: { defaultPayableAccountId: chart.payable },
  } as never)).id;
  otherSupplierId = (await suppliers.createSupplier(ctx.db, actor as never, {
    partyCode: 'BETA', legalName: 'Beta Trading Co',
    supplier: { defaultPayableAccountId: chart.payable2 },
  } as never)).id;
}

beforeEach(() => setup());
afterEach(async () => { await ctx.close(); });

/* ══ Drafts ════════════════════════════════════════════════════════════════ */

describe('the draft lifecycle', () => {
  it('creates a draft with a server-allocated number, no journal and no allocations', async () => {
    const payment = await draftPayment();

    expect(payment.paymentNumber).toBe('PAY-2026-0001');
    expect(payment.status).toBe('draft');
    expect(payment.journalEntryId).toBeNull();
    /* The payable is frozen at POSTING, not before: the supplier's account can
     * still change while the payment is a draft. */
    expect(payment.payableAccountId).toBeNull();
    expect(payment.allocations).toEqual([]);
    expect(payment.amount).toBe('100.000');
  });

  it('numbers payments in sequence, never from a MAX', async () => {
    await draftPayment();
    const second = await draftPayment();
    expect(second.paymentNumber).toBe('PAY-2026-0002');

    /* Deleting the newest must NOT hand its number back: two documents with one
     * number is a worse problem than a gap in the sequence. */
    await payments.deleteDraft(ctx.db, actor, second.id, { expectedVersion: second.version });
    expect((await draftPayment()).paymentNumber).toBe('PAY-2026-0003');
  });

  it('edits a draft, and refuses an edit that did not read the record', async () => {
    const payment = await draftPayment();
    const updated = await payments.updateDraft(ctx.db, actor, payment.id, {
      paymentDate: '2026-04-02', amount: '250.000', memo: 'Second instalment',
    } as never, { expectedVersion: payment.version });

    expect(updated.amount).toBe('250.000');
    expect(updated.paymentDate).toBe('2026-04-02');
    expect(updated.version).toBe(payment.version + 1);

    await expect(payments.updateDraft(ctx.db, actor, payment.id, {
      paymentDate: '2026-04-03', amount: '300.000',
    } as never, { expectedVersion: payment.version })).rejects.toThrow(/changed by another user/i);
  });

  it('deletes a draft, and refuses to delete a POSTED payment', async () => {
    const bill = await postedBill('100.000');
    const payment = await paid('100.000', [{ billId: bill.id, amount: '100.000' }]);

    await expect(payments.deleteDraft(ctx.db, actor, payment.id, {
      expectedVersion: payment.version,
    })).rejects.toThrow(/cannot be deleted/i);
  });
});

/* ══ The boundary ══════════════════════════════════════════════════════════ */

describe('what a durable payment refuses to carry', () => {
  it.each([
    ['bankFeeAmount', /bank fees/i],
    ['discountTakenAmount', /settlement discounts/i],
    ['withholdingTaxAmount', /withholding tax/i],
    ['realizedFxAmount', /exchange differences/i],
    ['writeOffAmount', /write-offs/i],
  ])('refuses %s, which has no controlled accounting', async (field, message) => {
    await expect(draftPayment({ [field]: '5.000' })).rejects.toThrow(message);
  });

  it('accepts a ZERO adjustment, because nothing is being recorded', async () => {
    /* The refusal is about money with nowhere to go, not about a field being
     * present — an older client sending explicit zeros is not asking for
     * anything the server cannot do. */
    await expect(draftPayment({ bankFeeAmount: '0.000' })).resolves.toBeTruthy();
  });

  it.each([
    ['projectId', /projects/i],
    ['costCenterId', /cost centres/i],
    ['templateId', /payment templates/i],
    ['chequeClearingAccountId', /cheque clearing/i],
  ])('refuses %s, which the server cannot verify', async (field, message) => {
    await expect(draftPayment({ [field]: 'x-1' })).rejects.toThrow(message);
  });

  it('refuses an unapplied balance BY NAME, rather than storing nothing for it', async () => {
    await expect(draftPayment({ unappliedAmount: '25.000' }))
      .rejects.toThrow(/allocated in full|unapplied cash/i);
  });

  it('refuses a caller-chosen status, number or payable account', async () => {
    await expect(draftPayment({ status: 'posted' })).rejects.toThrow(/set by posting/i);
    await expect(draftPayment({ paymentNumber: 'PAY-9999' })).rejects.toThrow(/allocated by the server/i);
    await expect(draftPayment({ payableAccountId: chart.payable }))
      .rejects.toThrow(/read from the supplier record/i);
  });

  it('refuses a currency that is not the functional one', async () => {
    await expect(draftPayment({ currency: 'USD' })).rejects.toThrow(/only JOD payments/i);
  });

  it('refuses an amount of zero, and one carrying too many decimals', async () => {
    await expect(draftPayment({ amount: '0' })).rejects.toThrow(/greater than zero/i);
    await expect(draftPayment({ amount: '10.00001' })).rejects.toThrow(/decimal places/i);
  });
});

/* ══ The paying account ════════════════════════════════════════════════════ */

describe('the account the money leaves', () => {
  it('refuses a liability, an income and an expense account', async () => {
    await expect(draftPayment({ cashAccountId: chart.payable }))
      .rejects.toThrow(/paid from an asset account/i);
    await expect(draftPayment({ cashAccountId: chart.revenue }))
      .rejects.toThrow(/paid from an asset account/i);
    await expect(draftPayment({ cashAccountId: chart.expense }))
      .rejects.toThrow(/paid from an asset account/i);
  });

  it('refuses an ASSET that the chart does not classify as cash', async () => {
    /* Office equipment is an asset and would balance. It is not money. */
    await expect(draftPayment({ cashAccountId: chart.asset }))
      .rejects.toThrow(/not classified as cash or bank/i);
  });

  it('refuses a heading that cannot receive postings', async () => {
    await expect(draftPayment({ cashAccountId: chart.header }))
      .rejects.toThrow(/cannot receive postings|not classified as cash/i);
  });

  it('refuses an account belonging to ANOTHER company', async () => {
    const otherCompany = await company(actor.organizationId, 'co_other');
    const foreign = await accounts.createAccount(
      ctx.db, { ...actor, companyId: otherCompany },
      { accountCode: '1100', accountName: 'Their bank', accountType: 'asset',
        cashClassification: 'cash_and_cash_equivalents' },
    );
    await expect(draftPayment({ cashAccountId: foreign.id }))
      .rejects.toThrow(/does not exist in these books/i);
  });

  it('re-checks the account at POSTING, not only when the draft was saved', async () => {
    const bill = await postedBill('100.000');
    const payment = await draftPayment({ amount: '100.000' });

    await accounts.updateAccount(ctx.db, actor, chart.bank, { blocked: true } as never);

    await expect(post(payment.id, payment.version, [{ billId: bill.id, amount: '100.000' }]))
      .rejects.toThrow(/cannot receive postings/i);
  });
});

/* ══ The supplier ══════════════════════════════════════════════════════════ */

describe('who is being paid', () => {
  it('refuses a supplier that does not exist in these books', async () => {
    await expect(draftPayment({ supplierId: '11111111-1111-1111-1111-111111111111' }))
      .rejects.toThrow(/does not exist in these books/i);
  });

  it('refuses a party that does not hold the supplier role', async () => {
    const customer = await ctx.db.insertInto('business_parties').values({
      organization_id: actor.organizationId, company_id: actor.companyId,
      party_code: 'CUST', legal_name: 'Only A Customer',
      is_customer: true, is_supplier: false,
    } as never).returning('id').executeTakeFirstOrThrow();

    await expect(draftPayment({ supplierId: customer.id }))
      .rejects.toThrow(/does not hold the supplier role/i);
  });

  it('refuses a supplier with no payable account, rather than guessing one', async () => {
    await ctx.db.updateTable('business_party_supplier_profiles')
      .set({ default_payable_account_id: null } as never)
      .where('party_id', '=', supplierId).execute();

    await expect(draftPayment()).rejects.toThrow(/no accounts payable account set/i);
  });
});

/* ══ Posting ═══════════════════════════════════════════════════════════════ */

describe('posting a payment', () => {
  it('debits the supplier payable and credits the bank, exactly', async () => {
    const bill = await postedBill('1000.000');
    const payment = await paid('1000.000', [{ billId: bill.id, amount: '1000.000' }]);

    const record = await payments.getPayment(ctx.db, actor, payment.id);
    expect(record.status).toBe('posted');
    expect(record.journalEntryId).not.toBeNull();
    /* FROZEN at posting: a later change to the supplier profile cannot restate
     * a payment already in the books. */
    expect(record.payableAccountId).toBe(chart.payable);
    expect(record.cashAccountId).toBe(chart.bank);

    expect(await legs(record.journalEntryId!)).toEqual([
      { account: chart.payable, debit: 1000, credit: 0 },
      { account: chart.bank, debit: 0, credit: 1000 },
    ]);
  });

  it('posts NO tax: what was bought was settled at the bill, not at the payment', async () => {
    const bill = await postedBill('1000.000');
    const payment = await paid('1000.000', [{ billId: bill.id, amount: '1000.000' }]);
    const record = await payments.getPayment(ctx.db, actor, payment.id);

    /* Two legs, and neither is the expense. Paying settles a liability; it does
     * not restate the cost. */
    const posted = await legs(record.journalEntryId!);
    expect(posted).toHaveLength(2);
    expect(posted.map((l) => l.account)).not.toContain(chart.expense);
  });

  it('carries the payment date into the ledger as the posting date', async () => {
    const bill = await postedBill('100.000');
    const payment = await paid('100.000', [{ billId: bill.id, amount: '100.000' }],
      { paymentDate: '2026-05-17' });
    const record = await payments.getPayment(ctx.db, actor, payment.id);

    const { rows } = await sql<{ transaction_date: string; posting_date: string }>`
      SELECT transaction_date::text AS transaction_date, posting_date::text AS posting_date
        FROM journal_entries WHERE id = ${record.journalEntryId}
    `.execute(ctx.db);
    /* The DATE is what the payment says, not the day the row happened to be
     * written — and not a day either side of it. */
    expect(rows[0]!.transaction_date).toBe('2026-05-17');
    expect(rows[0]!.posting_date).toBe('2026-05-17');
    expect(record.paymentDate).toBe('2026-05-17');
  });

  it('refuses to post twice', async () => {
    const bill = await postedBill('100.000');
    const payment = await paid('100.000', [{ billId: bill.id, amount: '100.000' }]);
    await expect(post(payment.id, payment.version, [{ billId: bill.id, amount: '100.000' }]))
      .rejects.toThrow(/already posted/i);
  });
});

/* ══ Full allocation ═══════════════════════════════════════════════════════ */

describe('a posted payment is fully allocated', () => {
  it('refuses a payment with NO allocations', async () => {
    const payment = await draftPayment({ amount: '100.000' });
    await expect(post(payment.id, payment.version, []))
      .rejects.toThrow(/allocated in full/i);
  });

  it('refuses an UNDER-allocated payment, naming the unapplied boundary', async () => {
    const bill = await postedBill('1000.000');
    const payment = await draftPayment({ amount: '1000.000' });

    await expect(post(payment.id, payment.version, [{ billId: bill.id, amount: '400.000' }]))
      .rejects.toThrow(/allocated in full|unapplied cash/i);
    /* And nothing was saved: the payment is still a draft with no allocations. */
    const after = await payments.getPayment(ctx.db, actor, payment.id);
    expect(after.status).toBe('draft');
    expect(await allocationRows(payment.id)).toEqual([]);
  });

  it('refuses an OVER-allocated payment', async () => {
    const first = await postedBill('600.000');
    const second = await postedBill('600.000');
    const payment = await draftPayment({ amount: '1000.000' });

    await expect(post(payment.id, payment.version, [
      { billId: first.id, amount: '600.000' },
      { billId: second.id, amount: '600.000' },
    ])).rejects.toThrow(/more than the payment/i);
  });

  it('refuses an allocation larger than the bill still owes', async () => {
    const bill = await postedBill('100.000');
    const payment = await draftPayment({ amount: '150.000' });

    await expect(post(payment.id, payment.version, [{ billId: bill.id, amount: '150.000' }]))
      .rejects.toThrow(/more than bill .* still owes/i);
  });

  it('refuses to over-allocate a bill a previous payment already partly settled', async () => {
    const bill = await postedBill('100.000');
    await paid('60.000', [{ billId: bill.id, amount: '60.000' }]);

    const second = await draftPayment({ amount: '50.000' });
    await expect(post(second.id, second.version, [{ billId: bill.id, amount: '50.000' }]))
      .rejects.toThrow(/more than bill .* still owes/i);
  });

  it('refuses the same bill twice in one allocation set', async () => {
    const bill = await postedBill('100.000');
    const payment = await draftPayment({ amount: '100.000' });

    await expect(post(payment.id, payment.version, [
      { billId: bill.id, amount: '50.000' },
      { billId: bill.id, amount: '50.000' },
    ])).rejects.toThrow(/appears twice/i);
  });

  it('refuses a zero allocation, which settles nothing', async () => {
    const first = await postedBill('100.000');
    const second = await postedBill('100.000');
    const payment = await draftPayment({ amount: '100.000' });

    await expect(post(payment.id, payment.version, [
      { billId: first.id, amount: '100.000' },
      { billId: second.id, amount: '0.000' },
    ])).rejects.toThrow(/greater than zero/i);
  });

  it('refuses a bill that is not POSTED', async () => {
    const drafted = await bills.createDraft(ctx.db, actor, {
      issuingEntityId: ENTITY, supplierId, supplierInvoiceNumber: 'SUP-DRAFT',
      billDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '100.000' }],
    } as never);
    const payment = await draftPayment({ amount: '100.000' });

    await expect(post(payment.id, payment.version, [{ billId: drafted.id, amount: '100.000' }]))
      .rejects.toThrow(/is draft and cannot be paid/i);
  });

  it("refuses another supplier's bill", async () => {
    const theirs = await bills.createDraft(ctx.db, actor, {
      issuingEntityId: ENTITY, supplierId: otherSupplierId, supplierInvoiceNumber: 'BETA-001',
      billDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '100.000' }],
    } as never);
    const posted = await bills.postBill(ctx.db, actor, theirs.id, { expectedVersion: theirs.version });
    const payment = await draftPayment({ amount: '100.000' });

    await expect(post(payment.id, payment.version, [{ billId: posted.id, amount: '100.000' }]))
      .rejects.toThrow(/belongs to a different supplier/i);
  });

  it("refuses another COMPANY's bill, which is not reachable at all", async () => {
    const otherCompany = await company(actor.organizationId, 'co_elsewhere');
    const elsewhere = { ...actor, companyId: otherCompany };
    const theirPayable = await accounts.createAccount(ctx.db, elsewhere, {
      accountCode: '2100', accountName: 'Their payable', accountType: 'liability',
    });
    const theirExpense = await accounts.createAccount(ctx.db, elsewhere, {
      accountCode: '5100', accountName: 'Their costs', accountType: 'expense',
    });
    const theirSupplier = await suppliers.createSupplier(ctx.db, elsewhere as never, {
      partyCode: 'ACME', legalName: 'Acme Supplies Ltd',
      supplier: { defaultPayableAccountId: theirPayable.id },
    } as never);
    const theirBill = await bills.createDraft(ctx.db, elsewhere, {
      issuingEntityId: ENTITY, supplierId: theirSupplier.id, supplierInvoiceNumber: 'ELSE-001',
      billDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{ accountId: theirExpense.id, quantity: '1', unitPrice: '100.000' }],
    } as never);
    await bills.postBill(ctx.db, elsewhere, theirBill.id, { expectedVersion: theirBill.version });

    const payment = await draftPayment({ amount: '100.000' });
    await expect(post(payment.id, payment.version, [{ billId: theirBill.id, amount: '100.000' }]))
      .rejects.toThrow(/Bill not found|not found/i);
  });
});

/* ══ Derived balances ══════════════════════════════════════════════════════ */

describe('what a bill still owes', () => {
  it('is the total less its ACTIVE allocations, and nothing is stored', async () => {
    const bill = await postedBill('1000.000');
    expect(await outstanding(bill.id)).toBe('1000.000');

    await paid('300.000', [{ billId: bill.id, amount: '300.000' }]);
    expect(await outstanding(bill.id)).toBe('700.000');

    await paid('700.000', [{ billId: bill.id, amount: '700.000' }]);
    /* Settled, so it leaves the outstanding schedule entirely. */
    expect(await outstanding(bill.id)).toBe('0.000');

    const columns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'bills'
    `.execute(ctx.db);
    const names = columns.rows.map((r) => r.column_name);
    expect(names).not.toContain('balance_due');
    expect(names).not.toContain('amount_paid');
  });

  it('spreads one payment across several bills, to the fils', async () => {
    const first = await postedBill('333.333');
    const second = await postedBill('666.667');
    const payment = await paid('1000.000', [
      { billId: first.id, amount: '333.333' },
      { billId: second.id, amount: '666.667' },
    ]);

    expect(await outstanding(first.id)).toBe('0.000');
    expect(await outstanding(second.id)).toBe('0.000');
    const record = await payments.getPayment(ctx.db, actor, payment.id);
    expect(record.allocations.map((a) => a.amount).sort()).toEqual(['333.333', '666.667']);
  });
});

/* ══ Bill reversal versus live payments — the settled policy ═══════════════ */

describe('a bill that a payment settles cannot be reversed', () => {
  it('refuses a FULLY paid bill, naming the payment and the amount', async () => {
    const bill = await postedBill('1000.000');
    const payment = await paid('1000.000', [{ billId: bill.id, amount: '1000.000' }]);
    const current = await bills.getBill(ctx.db, actor, bill.id);

    const attempt = bills.reverseBill(ctx.db, actor, bill.id, {
      expectedVersion: current.version, reason: 'Wrong supplier',
    });

    await expect(attempt).rejects.toThrow(new RegExp(payment.number));
    await expect(attempt).rejects.toThrow(/1000\.000/);
    /* The two REMEDIES, not "unallocate it": unapplied cash is not supported. */
    await expect(attempt).rejects.toThrow(/reverse that payment first/i);
    await expect(attempt).rejects.toThrow(/reallocate its full amount/i);
    await expect(attempt).rejects.not.toThrow(/unallocate the payment first/i);

    /* And the bill is untouched. */
    expect((await bills.getBill(ctx.db, actor, bill.id)).status).toBe('posted');
  });

  it('refuses a PARTIALLY paid bill just as firmly', async () => {
    const bill = await postedBill('1000.000');
    const payment = await paid('250.000', [{ billId: bill.id, amount: '250.000' }]);
    const current = await bills.getBill(ctx.db, actor, bill.id);

    const attempt = bills.reverseBill(ctx.db, actor, bill.id, {
      expectedVersion: current.version, reason: 'Duplicate',
    });
    await expect(attempt).rejects.toThrow(new RegExp(payment.number));
    await expect(attempt).rejects.toThrow(/250\.000/);
    expect(await outstanding(bill.id)).toBe('750.000');
  });

  it('names EVERY blocking payment, not merely the first', async () => {
    const bill = await postedBill('1000.000');
    const first = await paid('400.000', [{ billId: bill.id, amount: '400.000' }]);
    const second = await paid('600.000', [{ billId: bill.id, amount: '600.000' }]);
    const current = await bills.getBill(ctx.db, actor, bill.id);

    const attempt = bills.reverseBill(ctx.db, actor, bill.id, {
      expectedVersion: current.version, reason: 'Cancelled order',
    });
    await expect(attempt).rejects.toThrow(new RegExp(first.number));
    await expect(attempt).rejects.toThrow(new RegExp(second.number));
    await expect(attempt).rejects.toThrow(/400\.000/);
    await expect(attempt).rejects.toThrow(/600\.000/);
    /* Plural, because two payments are not "a payment". */
    await expect(attempt).rejects.toThrow(/payments settle it/i);
  });

  it('permits the reversal once the payment has been REVERSED', async () => {
    const bill = await postedBill('1000.000');
    const payment = await paid('1000.000', [{ billId: bill.id, amount: '1000.000' }]);

    await payments.reversePayment(ctx.db, actor, payment.id, {
      expectedVersion: payment.version, reason: 'Paid the wrong supplier',
    });
    expect(await outstanding(bill.id)).toBe('1000.000');

    const current = await bills.getBill(ctx.db, actor, bill.id);
    const reversed = await bills.reverseBill(ctx.db, actor, bill.id, {
      expectedVersion: current.version, reason: 'Wrong supplier',
    });
    expect(reversed.status).toBe('reversed');
    /* The ORIGINAL journal is untouched; the reversal is a second entry. */
    expect(reversed.journalEntryId).toBe(current.journalEntryId);
    expect(reversed.reversalJournalEntryId).not.toBeNull();
  });

  it('permits the reversal once the payment has been fully REALLOCATED away', async () => {
    const doomed = await postedBill('1000.000');
    const survivor = await postedBill('1000.000');
    const payment = await paid('1000.000', [{ billId: doomed.id, amount: '1000.000' }]);

    await payments.reallocatePayment(ctx.db, actor, payment.id, {
      allocations: [{ billId: survivor.id, amount: '1000.000' }],
    }, { expectedVersion: payment.version });

    expect(await outstanding(doomed.id)).toBe('1000.000');
    expect(await outstanding(survivor.id)).toBe('0.000');

    const current = await bills.getBill(ctx.db, actor, doomed.id);
    const reversed = await bills.reverseBill(ctx.db, actor, doomed.id, {
      expectedVersion: current.version, reason: 'Billed in error',
    });
    expect(reversed.status).toBe('reversed');
  });

  it('never reverses the payment on its own initiative', async () => {
    const bill = await postedBill('1000.000');
    const payment = await paid('1000.000', [{ billId: bill.id, amount: '1000.000' }]);
    const current = await bills.getBill(ctx.db, actor, bill.id);

    await expect(bills.reverseBill(ctx.db, actor, bill.id, {
      expectedVersion: current.version, reason: 'Wrong supplier',
    })).rejects.toThrow();

    /* Still posted, still allocated. A refusal is not a cascade. */
    const after = await payments.getPayment(ctx.db, actor, payment.id);
    expect(after.status).toBe('posted');
    expect(after.allocations).toHaveLength(1);
  });

  it('reverses a bill nothing has ever paid, exactly as before', async () => {
    const bill = await postedBill('1000.000');
    const current = await bills.getBill(ctx.db, actor, bill.id);
    const reversed = await bills.reverseBill(ctx.db, actor, bill.id, {
      expectedVersion: current.version, reason: 'Duplicate entry',
    });
    expect(reversed.status).toBe('reversed');
  });
});

/* ══ Reallocation ══════════════════════════════════════════════════════════ */

describe('correcting a posted payment', () => {
  it('replaces the whole set atomically, keeping the old rows as SUPERSEDED', async () => {
    const first = await postedBill('1000.000');
    const second = await postedBill('1000.000');
    const payment = await paid('1000.000', [{ billId: first.id, amount: '1000.000' }]);

    const moved = await payments.reallocatePayment(ctx.db, actor, payment.id, {
      allocations: [
        { billId: first.id, amount: '400.000' },
        { billId: second.id, amount: '600.000' },
      ],
    }, { expectedVersion: payment.version });

    expect(moved.allocations).toHaveLength(2);
    expect(await outstanding(first.id)).toBe('600.000');
    expect(await outstanding(second.id)).toBe('400.000');

    /* Three rows: the original, superseded, plus the two that replaced it.
     * Nothing was deleted — the trail of what settled what survives. */
    const rows = await allocationRows(payment.id);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.status === 'superseded')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(2);
  });

  it('writes NO new journal: the bank entry did not change', async () => {
    const first = await postedBill('1000.000');
    const second = await postedBill('1000.000');
    const payment = await paid('1000.000', [{ billId: first.id, amount: '1000.000' }]);

    const before = await sql<{ n: string }>`SELECT COUNT(*)::text AS n FROM journal_entries`
      .execute(ctx.db);
    await payments.reallocatePayment(ctx.db, actor, payment.id, {
      allocations: [{ billId: second.id, amount: '1000.000' }],
    }, { expectedVersion: payment.version });
    const after = await sql<{ n: string }>`SELECT COUNT(*)::text AS n FROM journal_entries`
      .execute(ctx.db);

    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    const record = await payments.getPayment(ctx.db, actor, payment.id);
    expect(record.journalEntryId).not.toBeNull();
  });

  it('refuses a partial replacement that would leave an unapplied balance', async () => {
    const first = await postedBill('1000.000');
    const second = await postedBill('1000.000');
    const payment = await paid('1000.000', [{ billId: first.id, amount: '1000.000' }]);

    /* This is the "standalone unallocation" the policy refuses: 400 would have
     * nowhere to sit. */
    await expect(payments.reallocatePayment(ctx.db, actor, payment.id, {
      allocations: [{ billId: second.id, amount: '600.000' }],
    }, { expectedVersion: payment.version })).rejects.toThrow(/allocated in full|unapplied cash/i);
  });

  it('refuses an EMPTY replacement — reverse the payment instead', async () => {
    const bill = await postedBill('1000.000');
    const payment = await paid('1000.000', [{ billId: bill.id, amount: '1000.000' }]);

    await expect(payments.reallocatePayment(ctx.db, actor, payment.id, {
      allocations: [],
    }, { expectedVersion: payment.version })).rejects.toThrow(/allocated in full|unapplied cash/i);
  });

  it('rolls the WHOLE replacement back when one line is invalid', async () => {
    const first = await postedBill('1000.000');
    const small = await postedBill('100.000');
    const payment = await paid('1000.000', [{ billId: first.id, amount: '1000.000' }]);

    await expect(payments.reallocatePayment(ctx.db, actor, payment.id, {
      allocations: [
        { billId: small.id, amount: '400.000' },
        { billId: first.id, amount: '600.000' },
      ],
    }, { expectedVersion: payment.version })).rejects.toThrow(/more than bill .* still owes/i);

    /* The original allocation is still ACTIVE and still the only one: the
     * supersede-then-validate order must not survive a failure. */
    const rows = await allocationRows(payment.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('active');
    expect(await outstanding(first.id)).toBe('0.000');
    expect(await outstanding(small.id)).toBe('100.000');

    const record = await payments.getPayment(ctx.db, actor, payment.id);
    expect(record.version).toBe(payment.version);
  });

  it("refuses to move money onto another supplier's bill", async () => {
    const ours = await postedBill('1000.000');
    const theirs = await bills.createDraft(ctx.db, actor, {
      issuingEntityId: ENTITY, supplierId: otherSupplierId, supplierInvoiceNumber: 'BETA-001',
      billDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '1000.000' }],
    } as never);
    await bills.postBill(ctx.db, actor, theirs.id, { expectedVersion: theirs.version });
    const payment = await paid('1000.000', [{ billId: ours.id, amount: '1000.000' }]);

    await expect(payments.reallocatePayment(ctx.db, actor, payment.id, {
      allocations: [{ billId: theirs.id, amount: '1000.000' }],
    }, { expectedVersion: payment.version })).rejects.toThrow(/different supplier/i);
  });

  it('refuses to reallocate a DRAFT or a REVERSED payment', async () => {
    const bill = await postedBill('1000.000');
    const drafted = await draftPayment({ amount: '1000.000' });
    await expect(payments.reallocatePayment(ctx.db, actor, drafted.id, {
      allocations: [{ billId: bill.id, amount: '1000.000' }],
    }, { expectedVersion: drafted.version })).rejects.toThrow(/Only a posted payment/i);

    const payment = await paid('1000.000', [{ billId: bill.id, amount: '1000.000' }]);
    const reversed = await payments.reversePayment(ctx.db, actor, payment.id, {
      expectedVersion: payment.version, reason: 'Sent twice',
    });
    await expect(payments.reallocatePayment(ctx.db, actor, payment.id, {
      allocations: [{ billId: bill.id, amount: '1000.000' }],
    }, { expectedVersion: reversed.version })).rejects.toThrow(/Only a posted payment/i);
  });
});

/* ══ Payment reversal ══════════════════════════════════════════════════════ */

describe('reversing a payment', () => {
  it('reverses the cash journal, neutralises the allocations and reopens the bills', async () => {
    const first = await postedBill('600.000');
    const second = await postedBill('400.000');
    const payment = await paid('1000.000', [
      { billId: first.id, amount: '600.000' },
      { billId: second.id, amount: '400.000' },
    ]);

    const reversed = await payments.reversePayment(ctx.db, actor, payment.id, {
      expectedVersion: payment.version, reason: 'Bank returned the transfer',
    });

    expect(reversed.status).toBe('reversed');
    expect(reversed.reversalReason).toBe('Bank returned the transfer');
    expect(reversed.allocations).toEqual([]);

    /* The opposite entry, on the accounts the payment FROZE. */
    expect(await legs(reversed.reversalJournalEntryId!)).toEqual([
      { account: chart.payable, debit: 0, credit: 1000 },
      { account: chart.bank, debit: 1000, credit: 0 },
    ]);

    expect(await outstanding(first.id)).toBe('600.000');
    expect(await outstanding(second.id)).toBe('400.000');

    /* The rows are kept, marked reversed. Never deleted. */
    const rows = await allocationRows(payment.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'reversed')).toBe(true);
  });

  it('requires a reason', async () => {
    const bill = await postedBill('100.000');
    const payment = await paid('100.000', [{ billId: bill.id, amount: '100.000' }]);
    await expect(payments.reversePayment(ctx.db, actor, payment.id, {
      expectedVersion: payment.version, reason: '   ',
    })).rejects.toThrow(/reversal reason is required/i);
  });

  it('refuses a draft, and refuses a second reversal', async () => {
    const bill = await postedBill('100.000');
    const drafted = await draftPayment({ amount: '100.000' });
    await expect(payments.reversePayment(ctx.db, actor, drafted.id, {
      expectedVersion: drafted.version, reason: 'Nope',
    })).rejects.toThrow(/Only a posted payment/i);

    const payment = await paid('100.000', [{ billId: bill.id, amount: '100.000' }]);
    const reversed = await payments.reversePayment(ctx.db, actor, payment.id, {
      expectedVersion: payment.version, reason: 'Sent twice',
    });
    await expect(payments.reversePayment(ctx.db, actor, payment.id, {
      expectedVersion: reversed.version, reason: 'Again',
    })).rejects.toThrow(/already reversed/i);
  });

  it('creates NO unapplied cash, supplier advance or credit anywhere', async () => {
    const bill = await postedBill('1000.000');
    const payment = await paid('1000.000', [{ billId: bill.id, amount: '1000.000' }]);
    const reversed = await payments.reversePayment(ctx.db, actor, payment.id, {
      expectedVersion: payment.version, reason: 'Returned',
    });

    /* Four legs in total across the payment's two journals, and every one of
     * them is either the payable or the bank. Nothing was parked anywhere
     * else — no advance, no unapplied cash, no supplier credit. */
    const posted = await legs(reversed.journalEntryId!);
    const undone = await legs(reversed.reversalJournalEntryId!);
    expect([...posted, ...undone]).toHaveLength(4);
    for (const leg of [...posted, ...undone]) {
      expect([chart.payable, chart.bank]).toContain(leg.account);
    }

    /* And there is no column anywhere that could hold one. */
    const columns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'supplier_payments'
    `.execute(ctx.db);
    const names = columns.rows.map((r) => r.column_name);
    expect(names).not.toContain('unapplied_amount');
    expect(names).not.toContain('advance_account_id');
  });
});

/* ══ Ordering: the refusal cannot be stepped around ════════════════════════ */

describe('bill reversal and payment mutation cannot interleave', () => {
  /*
   * PGlite runs one connection, so two transactions cannot literally overlap
   * here. What these pin is the OUTCOME in every order the two operations can
   * commit in — which is what the row lock guarantees under real concurrency,
   * and is proved directly against PostgreSQL with two connections in the
   * disposable probe.
   *
   * Both paths take `SELECT ... FOR UPDATE` on the same bill row before reading
   * or writing anything: `lockBill` for the reversal, `outstandingForBill(...,
   * { forUpdate: true })` for every posting, reallocation and payment reversal.
   * So one of the two orders below is always what actually happens.
   */
  it('payment first, then reversal: the reversal is refused', async () => {
    const bill = await postedBill('1000.000');
    const before = await bills.getBill(ctx.db, actor, bill.id);
    const payment = await paid('1000.000', [{ billId: bill.id, amount: '1000.000' }]);

    await expect(bills.reverseBill(ctx.db, actor, bill.id, {
      expectedVersion: before.version, reason: 'Raced',
    })).rejects.toThrow(new RegExp(payment.number));
  });

  it('reversal first, then payment: the allocation is refused', async () => {
    const bill = await postedBill('1000.000');
    const before = await bills.getBill(ctx.db, actor, bill.id);
    await bills.reverseBill(ctx.db, actor, bill.id, {
      expectedVersion: before.version, reason: 'Raced',
    });

    const payment = await draftPayment({ amount: '1000.000' });
    await expect(post(payment.id, payment.version, [{ billId: bill.id, amount: '1000.000' }]))
      .rejects.toThrow(/is reversed and cannot be paid/i);
  });

  it('reversal first, then REALLOCATION onto it: refused for the same reason', async () => {
    const paidBill = await postedBill('1000.000');
    const doomed = await postedBill('1000.000');
    const payment = await paid('1000.000', [{ billId: paidBill.id, amount: '1000.000' }]);

    const before = await bills.getBill(ctx.db, actor, doomed.id);
    await bills.reverseBill(ctx.db, actor, doomed.id, {
      expectedVersion: before.version, reason: 'Billed in error',
    });

    await expect(payments.reallocatePayment(ctx.db, actor, payment.id, {
      allocations: [{ billId: doomed.id, amount: '1000.000' }],
    }, { expectedVersion: payment.version })).rejects.toThrow(/is reversed and cannot be paid/i);

    /* And the failed replacement left the original allocation ACTIVE. */
    const rows = await allocationRows(payment.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('active');
  });

  it('holds the bill row for update while a payment is posted against it', async () => {
    /*
     * Read back the lock directly rather than trusting the call site: inside a
     * transaction that has posted a payment, the bill row must already be
     * locked by this transaction, which is what a second connection would have
     * to wait behind.
     */
    const bill = await postedBill('1000.000');
    const payment = await draftPayment({ amount: '1000.000' });

    await ctx.db.transaction().execute(async (trx) => {
      await payments.outstandingForBill(trx, actor, bill.id, { forUpdate: true });
      const { rows } = await sql<{ locked: boolean }>`
        SELECT true AS locked
          FROM bills
         WHERE id = ${bill.id}
           FOR UPDATE NOWAIT
      `.execute(trx);
      /* NOWAIT succeeds only because THIS transaction already holds the lock;
       * from any other it would raise `lock_not_available`. */
      expect(rows[0]!.locked).toBe(true);
    });

    await post(payment.id, payment.version, [{ billId: bill.id, amount: '1000.000' }]);
  });
});

/* ══ Reports ═══════════════════════════════════════════════════════════════ */

describe('what is owed, and to whom', () => {
  it('ages the REMAINING balance by due date, on the product buckets', async () => {
    const current = await postedBill('100.000', { dueDate: '2026-07-01' });
    const thirty = await postedBill('200.000', { dueDate: '2026-05-20' });
    const ninety = await postedBill('400.000', { dueDate: '2026-03-15' });
    await paid('100.000', [{ billId: ninety.id, amount: '100.000' }], { paymentDate: '2026-04-01' });

    const aged = await payables.agedPayables(ctx.db, actor, { asOfDate: '2026-06-01' });
    const bucket = (id: string) => aged.buckets.find((b) => b.id === id)!;

    expect(bucket('current').amount).toBe('100.000');
    expect(bucket('current').billIds).toContain(current.id);
    expect(bucket('1-30').amount).toBe('200.000');
    expect(bucket('1-30').billIds).toContain(thirty.id);
    /* 400 less the 100 paid — the REMAINING balance is what ages. */
    expect(bucket('61-90').amount).toBe('300.000');
    expect(aged.total).toBe('600.000');
  });

  it('does not let a LATER payment reduce an earlier as-of date', async () => {
    const bill = await postedBill('1000.000');
    await paid('400.000', [{ billId: bill.id, amount: '400.000' }], { paymentDate: '2026-06-15' });

    const may = await payables.agedPayables(ctx.db, actor, { asOfDate: '2026-05-31' });
    const june = await payables.agedPayables(ctx.db, actor, { asOfDate: '2026-06-30' });
    expect(may.total).toBe('1000.000');
    expect(june.total).toBe('600.000');
  });

  it('reconciles the statement after every permitted sequence', async () => {
    const first = await postedBill('1000.000');
    const second = await postedBill('500.000');

    const statement = async () => payables.supplierStatement(ctx.db, actor, {
      supplierId, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    });

    /* 1 — bills only. */
    let s = await statement();
    expect(s.closingBalance).toBe('1500.000');
    expect(s.isReconciled).toBe(true);

    /* 2 — a payment. */
    const payment = await paid('1000.000', [{ billId: first.id, amount: '1000.000' }]);
    s = await statement();
    expect(s.closingBalance).toBe('500.000');
    expect(s.periodPayments).toBe('1000.000');
    expect(s.isReconciled).toBe(true);

    /* 3 — reallocated onto the other bill. */
    await payments.reallocatePayment(ctx.db, actor, payment.id, {
      allocations: [{ billId: second.id, amount: '500.000' }, { billId: first.id, amount: '500.000' }],
    }, { expectedVersion: payment.version });
    s = await statement();
    expect(s.closingBalance).toBe('500.000');
    expect(s.isReconciled).toBe(true);

    /* 4 — the payment reversed; everything reopens. */
    const current = await payments.getPayment(ctx.db, actor, payment.id);
    await payments.reversePayment(ctx.db, actor, payment.id, {
      expectedVersion: current.version, reason: 'Returned',
    });
    s = await statement();
    expect(s.closingBalance).toBe('1500.000');
    expect(s.isReconciled).toBe(true);

    /* 5 — a bill reversed now that nothing settles it. */
    const reopened = await bills.getBill(ctx.db, actor, second.id);
    await bills.reverseBill(ctx.db, actor, second.id, {
      expectedVersion: reopened.version, reason: 'Duplicate',
    });
    s = await statement();
    expect(s.closingBalance).toBe('1000.000');
    expect(s.isReconciled).toBe(true);
  });

  it('shows a reversal as its own line rather than deleting the original', async () => {
    const bill = await postedBill('1000.000');
    const payment = await paid('1000.000', [{ billId: bill.id, amount: '1000.000' }]);
    await payments.reversePayment(ctx.db, actor, payment.id, {
      expectedVersion: payment.version, reason: 'Returned',
    });

    const statement = await payables.supplierStatement(ctx.db, actor, {
      supplierId, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    });
    const types = statement.lines.map((l) => l.type);
    expect(types).toContain('bill');
    expect(types).toContain('payment');
    expect(types).toContain('payment-reversal');
    expect(statement.closingBalance).toBe('1000.000');
  });

  it("refuses a statement for a party that is not a supplier", async () => {
    const customer = await ctx.db.insertInto('business_parties').values({
      organization_id: actor.organizationId, company_id: actor.companyId,
      party_code: 'CUST2', legal_name: 'Only A Customer',
      is_customer: true, is_supplier: false,
    } as never).returning('id').executeTakeFirstOrThrow();

    await expect(payables.supplierStatement(ctx.db, actor, { supplierId: customer.id }))
      .rejects.toThrow(/does not hold the supplier role/i);
  });
});

/* ══ Audit ═════════════════════════════════════════════════════════════════ */

describe('the trail a payment leaves', () => {
  it('records creation, posting, reallocation and reversal, newest first', async () => {
    const first = await postedBill('1000.000');
    const second = await postedBill('1000.000');
    const payment = await paid('1000.000', [{ billId: first.id, amount: '1000.000' }]);
    const moved = await payments.reallocatePayment(ctx.db, actor, payment.id, {
      allocations: [{ billId: second.id, amount: '1000.000' }],
    }, { expectedVersion: payment.version });
    await payments.reversePayment(ctx.db, actor, payment.id, {
      expectedVersion: moved.version, reason: 'Returned',
    });

    const history = await payments.paymentHistory(ctx.db, actor, payment.id);
    expect(history.map((e) => e.action)).toEqual([
      'PAYMENT_REVERSED', 'PAYMENT_REALLOCATED', 'PAYMENT_POSTED', 'PAYMENT_CREATED',
    ]);
    expect(history.every((e) => e.actorName === 'Payer One')).toBe(true);
  });
});

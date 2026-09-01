/**
 * Supplier bills: what is computed, what is refused, and what posts.
 *
 * ══ What these tests guard ═══════════════════════════════════════════════════
 *
 * The ARITHMETIC, because a discount applied at the wrong point still balances
 * — storing the net in `subtotal` and subtracting the discount again halves
 * every discounted bill and nothing downstream notices.
 *
 * The REFUSALS, because the cheap failure is to accept a tax-bearing or stocked
 * bill and store nothing for the part that cannot be honoured. The user sees a
 * document carrying input tax and a warehouse receipt; the books carry neither.
 *
 * The POSTING, because crediting anything other than the supplier's own payable
 * balances the entry while understating what the business owes — and a later
 * payment would clear something nobody owed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, type TestContext } from './helpers/testApp.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as suppliers from '../src/services/purchasing/supplierService.js';
import * as bills from '../src/services/purchasing/billService.js';

let ctx: TestContext;
let actor: AccountingActor;
let supplierId: string;
let chart: {
  payable: string; expense: string; expense2: string; asset: string;
  revenue: string; bank: string; header: string; equity: string;
};

const ENTITY = 'entity-main';

async function organization(name: string, currency = 'JOD'): Promise<string> {
  const owner = await seedUser(ctx, { email: `owner-${name.toLowerCase()}@bill.test` });
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
    VALUES (${email}, ${email}, 'Buyer', 'x', 'active', now()) RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

const draft = (over: Record<string, unknown> = {}) =>
  bills.createDraft(ctx.db, actor, {
    issuingEntityId: ENTITY,
    supplierId,
    supplierInvoiceNumber: 'SUP-001',
    billDate: '2026-03-01',
    dueDate: '2026-03-31',
    lines: [{ accountId: chart.expense, description: 'Consulting', quantity: '1', unitPrice: '100.000' }],
    ...over,
  } as never);

const post = (id: string, version: number, over: Record<string, unknown> = {}) =>
  bills.postBill(ctx.db, actor, id, { expectedVersion: version, ...over });

async function legs(journalEntryId: string): Promise<{ account: string; debit: number; credit: number }[]> {
  const { rows } = await sql<{ account_id: string; debit_transaction: string; credit_transaction: string }>`
    SELECT account_id, debit_transaction, credit_transaction FROM journal_lines
     WHERE journal_entry_id = ${journalEntryId} ORDER BY line_number
  `.execute(ctx.db);
  return rows.map((r) => ({
    account: r.account_id, debit: Number(r.debit_transaction), credit: Number(r.credit_transaction),
  }));
}

async function setup(currency = 'JOD'): Promise<void> {
  ctx = await createTestContext();
  const organizationId = await organization('Buy', currency);
  actor = {
    organizationId,
    companyId: await company(organizationId, 'co_buy'),
    userId: await person('buy@bill.test'),
    name: 'Buyer One',
  };

  const header = await accounts.createAccount(ctx.db, actor, {
    accountCode: '5000', accountName: 'Expenses', accountType: 'expense', isPostable: false,
  });
  await accounts.createAccount(ctx.db, actor, {
    accountCode: '5001', accountName: 'Under the heading', accountType: 'expense',
    parentAccountId: header.id,
  });

  chart = {
    payable: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '2100', accountName: 'Accounts payable', accountType: 'liability',
    })).id,
    expense: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '5100', accountName: 'Professional fees', accountType: 'expense',
    })).id,
    expense2: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '5200', accountName: 'Office costs', accountType: 'expense',
    })).id,
    asset: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '1500', accountName: 'Office equipment', accountType: 'asset',
    })).id,
    revenue: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '4000', accountName: 'Sales', accountType: 'income',
    })).id,
    bank: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '1100', accountName: 'Bank current', accountType: 'asset',
      cashClassification: 'cash_and_cash_equivalents',
    })).id,
    equity: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '3000', accountName: 'Retained earnings', accountType: 'equity',
    })).id,
    header: header.id,
  };

  supplierId = (await suppliers.createSupplier(ctx.db, actor as never, {
    partyCode: 'ACME', legalName: 'Acme Supplies Ltd',
    supplier: { defaultPayableAccountId: chart.payable },
  } as never)).id;
}

beforeEach(() => setup());
afterEach(async () => { await ctx.close(); });

/* ══ Drafts ════════════════════════════════════════════════════════════════ */

describe('the draft lifecycle', () => {
  it('creates a draft with a server-allocated number and NO journal', async () => {
    const bill = await draft();

    expect(bill.billNumber).toBe('BILL-2026-0001');
    expect(bill.status).toBe('draft');
    expect(bill.total).toBe('100.000');
    /* Creating a draft must never touch the ledger. */
    expect(bill.journalEntryId).toBeNull();

    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM journal_entries WHERE organization_id = ${actor.organizationId}
    `.execute(ctx.db);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('allocates sequential numbers per company', async () => {
    expect((await draft()).billNumber).toBe('BILL-2026-0001');
    expect((await draft()).billNumber).toBe('BILL-2026-0002');

    const second = await company(actor.organizationId, 'co_second');
    const secondActor = { ...actor, companyId: second };
    const otherPayable = await accounts.createAccount(ctx.db, secondActor, {
      accountCode: '2100', accountName: 'Payable', accountType: 'liability',
    });
    const otherExpense = await accounts.createAccount(ctx.db, secondActor, {
      accountCode: '5100', accountName: 'Fees', accountType: 'expense',
    });
    const otherSupplier = await suppliers.createSupplier(ctx.db, secondActor as never, {
      partyCode: 'ACME', legalName: 'Acme',
      supplier: { defaultPayableAccountId: otherPayable.id },
    } as never);

    const elsewhere = await bills.createDraft(ctx.db, secondActor, {
      issuingEntityId: ENTITY, supplierId: otherSupplier.id, supplierInvoiceNumber: 'X',
      billDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{ accountId: otherExpense.id, quantity: '1', unitPrice: '10.000' }],
    } as never);
    /* Each company numbers independently. */
    expect(elsewhere.billNumber).toBe('BILL-2026-0001');
  });

  it('edits a draft and recalculates', async () => {
    const bill = await draft();
    const updated = await bills.updateDraft(ctx.db, actor, bill.id, {
      billDate: '2026-03-01', dueDate: '2026-03-31', supplierInvoiceNumber: 'SUP-001',
      lines: [{ accountId: chart.expense, quantity: '2', unitPrice: '250.000' }],
    } as never, { expectedVersion: bill.version });

    expect(updated.total).toBe('500.000');
    expect(updated.version).toBe(bill.version + 1);
  });

  it('deletes a draft, which never reached the books', async () => {
    const bill = await draft();
    await bills.deleteDraft(ctx.db, actor, bill.id, { expectedVersion: bill.version });
    await expect(bills.getBill(ctx.db, actor, bill.id)).rejects.toThrow(/not found/i);
  });

  it('lists and searches', async () => {
    await draft({ supplierInvoiceNumber: 'ALPHA-1' });
    await draft({ supplierInvoiceNumber: 'BETA-2' });

    expect(await bills.listBills(ctx.db, actor)).toHaveLength(2);
    expect(await bills.listBills(ctx.db, actor, { search: 'alpha' })).toHaveLength(1);
    expect(await bills.listBills(ctx.db, actor, { status: 'posted' })).toHaveLength(0);
  });
});

/* ══ Calculation ═══════════════════════════════════════════════════════════ */

describe('server calculation', () => {
  it('computes quantity x price', async () => {
    const bill = await draft({
      lines: [{ accountId: chart.expense, quantity: '3', unitPrice: '33.333' }],
    });
    expect(bill.subtotal).toBe('99.999');
    expect(bill.total).toBe('99.999');
  });

  it('applies a PERCENTAGE discount to the gross, keeping subtotal gross', async () => {
    const bill = await draft({
      lines: [{
        accountId: chart.expense, quantity: '3', unitPrice: '33.333',
        discountType: 'percentage', discountValue: '10',
      }],
    });

    /*
     * The audited meaning: subtotal is the GROSS sum and the discount is
     * subtracted at the document level. Storing the net here and subtracting
     * again would halve the bill — and it would still balance.
     */
    expect(bill.subtotal).toBe('99.999');
    expect(bill.discountTotal).toBe('10.000');
    expect(bill.total).toBe('89.999');
    expect(bill.lines[0]!.lineSubtotal).toBe('99.999');
    expect(bill.lines[0]!.lineNet).toBe('89.999');
  });

  it('applies a FIXED discount', async () => {
    const bill = await draft({
      lines: [{
        accountId: chart.expense, quantity: '1', unitPrice: '100.000',
        discountType: 'amount', discountValue: '0.001',
      }],
    });
    expect(bill.total).toBe('99.999');
  });

  it('CLAMPS a discount larger than its line, as the browser does', async () => {
    const bill = await draft({
      lines: [{
        accountId: chart.expense, quantity: '1', unitPrice: '10.000',
        discountType: 'amount', discountValue: '25.000',
      }],
    });
    /* Clamped to the line, never negative. */
    expect(bill.discountTotal).toBe('10.000');
    expect(bill.total).toBe('0.000');
  });

  it('refuses a NEGATIVE discount, quantity or price', async () => {
    await expect(draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '10.000', discountType: 'amount', discountValue: '-5' }],
    })).rejects.toThrow(/discount cannot be negative/i);
    await expect(draft({
      lines: [{ accountId: chart.expense, quantity: '-1', unitPrice: '10.000' }],
    })).rejects.toThrow(/quantity cannot be negative/i);
    await expect(draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '-10.000' }],
    })).rejects.toThrow(/unit price cannot be negative/i);
  });

  it('refuses a malformed decimal', async () => {
    await expect(draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: 'not-a-number' }],
    })).rejects.toThrow();
  });

  it('refuses an unsupported discount FORM rather than approximating it', async () => {
    await expect(draft({
      lines: [{
        accountId: chart.expense, quantity: '1', unitPrice: '10.000',
        discountType: 'tiered', discountValue: '5',
      }],
    })).rejects.toThrow(/not a discount this server supports/i);
  });

  it('holds JOD to three decimals', async () => {
    const bill = await draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '0.001' }],
    });
    expect(bill.total).toBe('0.001');
  });

  it('holds USD to TWO decimals', async () => {
    await ctx.close();
    await setup('USD');
    const bill = await draft({
      lines: [{
        accountId: chart.expense, quantity: '1', unitPrice: '10.99',
        discountType: 'percentage', discountValue: '10',
      }],
    });
    /* 10.99 less 10% = 9.891 -> 1.10 discount at two decimals, net 9.89. */
    expect(bill.subtotal).toBe('10.99');
    expect(bill.discountTotal).toBe('1.10');
    expect(bill.total).toBe('9.89');
  });

  it('refuses a client-supplied total', async () => {
    await expect(draft({ total: '1.000' })).rejects.toThrow(/computed by the server/i);
    await expect(draft({ subtotal: '1.000' })).rejects.toThrow(/computed by the server/i);
  });

  it('refuses a client-chosen bill number or status', async () => {
    await expect(draft({ billNumber: 'BILL-9999' })).rejects.toThrow(/allocated by the server/i);
    await expect(draft({ status: 'posted' })).rejects.toThrow(/set by posting or reversing/i);
  });
});

/* ══ Tax: the code is the client's, every figure is the server's ═════════ */

describe('who decides the purchase tax on a bill', () => {
  /*
   * P2 refused purchase tax outright, because the server could not compute it.
   * P3 can, so the refusal MOVED rather than disappearing: what is refused now
   * is the client telling the server what the answer is. The arithmetic, the
   * categories and the posting are covered in `purchaseTax`; this file keeps
   * the narrower rule it can still see.
   */
  it('REFUSES a client-supplied rate — that figure belongs to the server', async () => {
    await expect(draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '100.000', taxRate: '16' }],
    })).rejects.toThrow(/supplies a rate for its tax/i);
    expect(await bills.listBills(ctx.db, actor)).toHaveLength(0);
  });

  it('refuses a client-supplied amount and base', async () => {
    await expect(draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '100.000', taxAmount: '16.000' }],
    })).rejects.toThrow(/supplies an amount for its tax/i);
    await expect(draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '100.000', taxableAmount: '84.000' }],
    })).rejects.toThrow(/supplies a taxable base/i);
  });

  it('refuses a ZERO rate too — that is still an assertion about the tax', async () => {
    await expect(draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '100.000', taxRate: '0' }],
    })).rejects.toThrow(/supplies a rate for its tax/i);
  });

  it('says WHY, so the message is actionable', async () => {
    const error = await draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '100.000', taxRate: '16' }],
    }).then(() => null, (e) => e as Error);

    expect(error!.message).toMatch(/calculated by the server/i);
    expect(error!.message).toMatch(/send the tax code alone/i);
    expect(error!.message).toMatch(/nothing has been saved/i);
  });

  it('still refuses withholding, which has no server treatment', async () => {
    await expect(draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '100.000', withholdingTaxRate: '5' }],
    })).rejects.toThrow(/withholds tax/i);
  });

  it('ACCEPTS a line with no tax code at all', async () => {
    const bill = await draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '100.000' }],
    });
    expect(bill.taxTotal).toBe('0.000');
    expect(bill.total).toBe('100.000');
    /* No code means no tax — which is NOT the same as a zero-rated purchase,
     * and the absent snapshot is how the two stay distinguishable. */
    expect(bill.lines[0]!.taxSnapshot).toBeNull();
  });
});

/* ══ Unsupported dependencies ══════════════════════════════════════════════ */

describe('unsupported dependencies', () => {
  it('refuses additional charges', async () => {
    await expect(draft({ additionalChargesTotal: '5.000' }))
      .rejects.toThrow(/Additional charges are not supported/i);
  });

  it.each(['itemId', 'inventoryItemId', 'warehouseId', 'capitalAssetId'])(
    'refuses a stocked line by its SHAPE (%s)',
    async (field) => {
      await expect(draft({
        lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '10.000', [field]: 'x' }],
      })).rejects.toThrow(/receives stock/i);
    },
  );

  it('refuses a stocked line even when it claims not to be stock', async () => {
    /* `inventoryReceiptMode: 'none'` alongside an item is exactly the shape a
     * client would use to slip past the subledger. */
    await expect(draft({
      lines: [{
        accountId: chart.expense, quantity: '1', unitPrice: '10.000',
        inventoryItemId: 'item-1', inventoryReceiptMode: 'none',
      }],
    })).rejects.toThrow(/receives stock/i);
  });

  it.each([
    ['projectId', /projects/i],
    ['costCenterId', /cost centres/i],
    ['purchaseOrderId', /purchase orders/i],
    ['goodsReceiptId', /goods receipts/i],
    ['templateId', /bill templates/i],
  ])('refuses %s at the document level', async (field, pattern) => {
    await expect(draft({ [field]: 'x' })).rejects.toThrow(pattern);
  });

  it('refuses attachments', async () => {
    await expect(draft({ attachments: [{ fileName: 'a.pdf' }] }))
      .rejects.toThrow(/attachments/i);
  });

  it('refuses a foreign currency rather than converting it', async () => {
    await expect(draft({ currency: 'USD' }))
      .rejects.toThrow(/only JOD bills can be held on the server/i);
  });
});

/* ══ Accounts ══════════════════════════════════════════════════════════════ */

describe('the accounts a bill may use', () => {
  it('accepts an expense line and a non-inventory ASSET line', async () => {
    const bill = await draft({
      lines: [
        { accountId: chart.expense, quantity: '1', unitPrice: '100.000' },
        { accountId: chart.asset, quantity: '1', unitPrice: '400.000' },
      ],
    });
    expect(bill.total).toBe('500.000');
  });

  it.each([
    ['revenue', 'revenue'],
    ['equity', 'equity'],
  ])('refuses a %s line account', async (kind) => {
    const accountId = kind === 'revenue' ? chart.revenue : chart.equity;
    await expect(draft({ lines: [{ accountId, quantity: '1', unitPrice: '10.000' }] }))
      .rejects.toThrow(/debits an expense or a non-inventory asset/i);
  });

  it('refuses a liability (payable) line account', async () => {
    await expect(draft({ lines: [{ accountId: chart.payable, quantity: '1', unitPrice: '10.000' }] }))
      .rejects.toThrow(/debits an expense or a non-inventory asset/i);
  });

  it('refuses a CASH/BANK line — that is a payment, not a bill', async () => {
    const error = await draft({ lines: [{ accountId: chart.bank, quantity: '1', unitPrice: '10.000' }] })
      .then(() => null, (e) => e as Error);
    expect(error!.message).toMatch(/cash or bank account/i);
    expect(error!.message).toMatch(/payments are not on the server yet/i);
  });

  it('refuses a heading account', async () => {
    /* The line refusal passes the LEDGER's own verdict through, prefixed with
     * the line, so an account is described the same way wherever it is refused. */
    await expect(draft({ lines: [{ accountId: chart.header, quantity: '1', unitPrice: '10.000' }] }))
      .rejects.toThrow(/Line 1: Select a posting account/i);
  });

  it.each([
    ['archived', sql`archived = true, active = false`, /archived and cannot receive/i],
    ['inactive', sql`active = false`, /Select an active posting account/i],
    ['blocked', sql`blocked = true`, /blocked and cannot receive/i],
  ])('refuses an %s line account', async (_label, mutation, pattern) => {
    await sql`UPDATE accounts SET ${mutation} WHERE id = ${chart.expense}`.execute(ctx.db);
    await expect(draft()).rejects.toThrow(pattern);
  });

  it('refuses an account from another company', async () => {
    const otherOrg = await organization('Rival');
    const otherCompany = await company(otherOrg, 'co_rival');
    const foreign = await accounts.createAccount(ctx.db, {
      organizationId: otherOrg, companyId: otherCompany, userId: actor.userId, name: 'Rival',
    }, { accountCode: '5100', accountName: 'Their expense', accountType: 'expense' });

    await expect(draft({ lines: [{ accountId: foreign.id, quantity: '1', unitPrice: '10.000' }] }))
      .rejects.toThrow(/does not exist in these books/i);
  });
});

/* ══ The supplier and its payable ══════════════════════════════════════════ */

describe('the supplier', () => {
  it('refuses a fabricated supplier', async () => {
    await expect(draft({ supplierId: '99999999-9999-9999-9999-999999999999' }))
      .rejects.toThrow(/does not exist in these books/i);
  });

  it('refuses a party that is not a supplier', async () => {
    const { rows } = await sql<{ id: string }>`
      INSERT INTO business_parties (organization_id, company_id, party_code, legal_name, is_customer)
      VALUES (${actor.organizationId}, ${actor.companyId}, 'CUSTONLY', 'Customer Only', true)
      RETURNING id
    `.execute(ctx.db);
    await expect(draft({ supplierId: rows[0]!.id }))
      .rejects.toThrow(/does not hold the supplier role/i);
  });

  it('refuses an ARCHIVED supplier on a new bill', async () => {
    const supplier = await suppliers.getSupplier(ctx.db, actor as never, supplierId);
    await suppliers.setSupplierArchived(ctx.db, actor as never, supplierId, {
      archived: true, expectedVersion: supplier.version,
    });
    await expect(draft()).rejects.toThrow(/archived and cannot be put on a new bill/i);
  });

  it('refuses a supplier from another company', async () => {
    const second = await company(actor.organizationId, 'co_second');
    const secondActor = { ...actor, companyId: second };
    const otherPayable = await accounts.createAccount(ctx.db, secondActor, {
      accountCode: '2100', accountName: 'Payable', accountType: 'liability',
    });
    const foreign = await suppliers.createSupplier(ctx.db, secondActor as never, {
      partyCode: 'FOREIGN', legalName: 'Foreign Supplies',
      supplier: { defaultPayableAccountId: otherPayable.id },
    } as never);

    await expect(draft({ supplierId: foreign.id }))
      .rejects.toThrow(/does not exist in these books/i);
  });

  it('refuses posting when the supplier has NO payable account', async () => {
    const bare = await suppliers.createSupplier(ctx.db, actor as never, {
      partyCode: 'BARE', legalName: 'Bare Supplier',
    } as never);
    const error = await bills.createDraft(ctx.db, actor, {
      issuingEntityId: ENTITY, supplierId: bare.id, supplierInvoiceNumber: 'S1',
      billDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '10.000' }],
    } as never).then(() => null, (e) => e as Error);

    expect(error!.message).toMatch(/no accounts payable account set/i);
    expect(error!.message).toMatch(/liability/i);
  });

  it.each([
    ['archived', sql`archived = true, active = false`],
    ['blocked', sql`blocked = true`],
  ])('refuses posting when the payable became %s', async (_label, mutation) => {
    const bill = await draft();
    await sql`UPDATE accounts SET ${mutation} WHERE id = ${chart.payable}`.execute(ctx.db);

    await expect(post(bill.id, bill.version)).rejects.toThrow(/cannot receive postings/i);

    /* And the bill is untouched. */
    const reread = await bills.getBill(ctx.db, actor, bill.id);
    expect(reread.status).toBe('draft');
    expect(reread.journalEntryId).toBeNull();
  });
});

/* ══ Posting ═══════════════════════════════════════════════════════════════ */

describe('posting', () => {
  it('debits each line net and credits the supplier payable, balanced', async () => {
    const bill = await draft({
      lines: [
        { accountId: chart.expense, quantity: '1', unitPrice: '600.000' },
        { accountId: chart.expense2, quantity: '2', unitPrice: '200.000', discountType: 'percentage', discountValue: '50' },
      ],
    });
    expect(bill.total).toBe('800.000'); // 600 + (400 - 200)

    const posted = await post(bill.id, bill.version);
    expect(posted.status).toBe('posted');
    expect(posted.payableAccountId).toBe(chart.payable);

    const entry = await legs(posted.journalEntryId!);
    expect(entry).toHaveLength(3);
    expect(entry.find((l) => l.account === chart.expense)!.debit).toBe(600);
    expect(entry.find((l) => l.account === chart.expense2)!.debit).toBe(200);
    expect(entry.find((l) => l.account === chart.payable)!.credit).toBe(800);

    const debits = entry.reduce((s, l) => s + l.debit, 0);
    const credits = entry.reduce((s, l) => s + l.credit, 0);
    expect(debits).toBe(credits);
  });

  it('requires the supplier invoice number before posting', async () => {
    const bill = await draft({ supplierInvoiceNumber: '' });
    await expect(post(bill.id, bill.version))
      .rejects.toThrow(/supplier's own invoice number is required/i);
  });

  it('refuses a duplicate supplier reference, and allows an explicit override', async () => {
    const first = await draft({ supplierInvoiceNumber: 'DUP-1' });
    await post(first.id, first.version);

    const second = await draft({ supplierInvoiceNumber: 'DUP-1' });
    await expect(post(second.id, second.version))
      .rejects.toThrow(/already recorded on bill/i);

    /* The audited behaviour: refused, but overridable on purpose. */
    const forced = await post(second.id, second.version, { overrideDuplicate: true });
    expect(forced.status).toBe('posted');
  });

  it('ignores drafts when checking for a duplicate reference', async () => {
    await draft({ supplierInvoiceNumber: 'ONLY-DRAFT' });
    const second = await draft({ supplierInvoiceNumber: 'ONLY-DRAFT' });
    /* A draft has not claimed the reference. */
    const posted = await post(second.id, second.version);
    expect(posted.status).toBe('posted');
  });

  it('refuses a zero-total bill', async () => {
    const bill = await draft({
      lines: [{ accountId: chart.expense, quantity: '0', unitPrice: '0' }],
    });
    await expect(post(bill.id, bill.version)).rejects.toThrow(/must be greater than zero/i);
  });

  it('makes a posted bill immutable', async () => {
    const bill = await draft();
    const posted = await post(bill.id, bill.version);

    await expect(bills.updateDraft(ctx.db, actor, bill.id, {
      billDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '9999.000' }],
    } as never, { expectedVersion: posted.version }))
      .rejects.toThrow(/can no longer be edited/i);

    await expect(bills.deleteDraft(ctx.db, actor, bill.id, { expectedVersion: posted.version }))
      .rejects.toThrow(/cannot be deleted/i);
  });

  it('refuses a stale posting attempt', async () => {
    const bill = await draft();
    await bills.updateDraft(ctx.db, actor, bill.id, {
      billDate: '2026-03-01', dueDate: '2026-03-31', supplierInvoiceNumber: 'SUP-001',
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '120.000' }],
    } as never, { expectedVersion: bill.version });

    await expect(post(bill.id, bill.version)).rejects.toThrow(/changed by another user/i);
  });

  it('rolls EVERYTHING back when the posting fails', async () => {
    const bill = await draft();
    /* Block the expense account after the draft was written. */
    await sql`UPDATE accounts SET blocked = true WHERE id = ${chart.expense}`.execute(ctx.db);

    await expect(post(bill.id, bill.version)).rejects.toThrow();

    const reread = await bills.getBill(ctx.db, actor, bill.id);
    expect(reread.status).toBe('draft');
    expect(reread.journalEntryId).toBeNull();
    expect(reread.version).toBe(bill.version);

    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM journal_entries WHERE organization_id = ${actor.organizationId}
    `.execute(ctx.db);
    expect(Number(rows[0]!.n)).toBe(0);

    const events = await bills.billHistory(ctx.db, actor, bill.id);
    expect(events.map((e) => e.action)).not.toContain('BILL_POSTED');
  });

  it('creates no second journal on a retry', async () => {
    const bill = await draft();
    const posted = await post(bill.id, bill.version);

    await post(bill.id, bill.version).catch(() => undefined);
    await post(bill.id, posted.version).catch(() => undefined);

    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM journal_entries
       WHERE source_type = 'bill' AND source_id = ${bill.id}
    `.execute(ctx.db);
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

/* ══ Reversal ══════════════════════════════════════════════════════════════ */

describe('reversal', () => {
  it('reverses a posted bill with a reversing journal, keeping both', async () => {
    const bill = await draft();
    const posted = await post(bill.id, bill.version);

    const reversed = await bills.reverseBill(ctx.db, actor, bill.id, {
      expectedVersion: posted.version, reason: 'Duplicate of SUP-000',
    });

    expect(reversed.status).toBe('reversed');
    expect(reversed.reversalReason).toBe('Duplicate of SUP-000');
    expect(reversed.reversalJournalEntryId).toBeTruthy();
    /* The ORIGINAL journal is untouched — nothing deletes a posted entry. */
    expect(reversed.journalEntryId).toBe(posted.journalEntryId);

    const original = await legs(posted.journalEntryId!);
    expect(original.find((l) => l.account === chart.payable)!.credit).toBe(100);

    const reversal = await legs(reversed.reversalJournalEntryId!);
    /* Mirrored: the payable is now debited. */
    expect(reversal.find((l) => l.account === chart.payable)!.debit).toBe(100);
  });

  it('requires a reason', async () => {
    const bill = await draft();
    const posted = await post(bill.id, bill.version);
    await expect(bills.reverseBill(ctx.db, actor, bill.id, {
      expectedVersion: posted.version, reason: '   ',
    })).rejects.toThrow(/reversal reason is required/i);
  });

  it('refuses to reverse a draft, and refuses a second reversal', async () => {
    const draftBill = await draft();
    await expect(bills.reverseBill(ctx.db, actor, draftBill.id, {
      expectedVersion: draftBill.version, reason: 'x',
    })).rejects.toThrow(/only a posted bill can be reversed/i);

    const posted = await post(draftBill.id, draftBill.version);
    const reversed = await bills.reverseBill(ctx.db, actor, draftBill.id, {
      expectedVersion: posted.version, reason: 'first',
    });
    await expect(bills.reverseBill(ctx.db, actor, draftBill.id, {
      expectedVersion: reversed.version, reason: 'again',
    })).rejects.toThrow(/already reversed/i);
  });
});

/* ══ Isolation and audit ═══════════════════════════════════════════════════ */

describe('company isolation', () => {
  it('does not read, edit, post or reverse another company\'s bill', async () => {
    const bill = await draft();
    const second = await company(actor.organizationId, 'co_second');
    const intruder: AccountingActor = { ...actor, companyId: second };

    await expect(bills.getBill(ctx.db, intruder, bill.id)).rejects.toThrow(/not found/i);
    await expect(bills.postBill(ctx.db, intruder, bill.id, { expectedVersion: bill.version }))
      .rejects.toThrow(/not found/i);
    await expect(bills.reverseBill(ctx.db, intruder, bill.id, { expectedVersion: bill.version, reason: 'x' }))
      .rejects.toThrow(/not found/i);
    expect(await bills.listBills(ctx.db, intruder)).toHaveLength(0);
  });
});

describe('audit history', () => {
  it('records creation, posting and reversal', async () => {
    const bill = await draft();
    const posted = await post(bill.id, bill.version);
    await bills.reverseBill(ctx.db, actor, bill.id, {
      expectedVersion: posted.version, reason: 'Wrong supplier',
    });

    const history = await bills.billHistory(ctx.db, actor, bill.id);
    expect(history.map((e) => e.action)).toEqual(
      expect.arrayContaining(['BILL_CREATED', 'BILL_POSTED', 'BILL_REVERSED']),
    );
    expect(history.every((e) => e.actorName === 'Buyer One')).toBe(true);

    const postEvent = history.find((e) => e.action === 'BILL_POSTED');
    expect(postEvent!.detail).toMatchObject({ payableAccountId: chart.payable, total: '100.0000000000' });
  });
});

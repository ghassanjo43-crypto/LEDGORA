/**
 * Purchase tax on a supplier bill: applicability, arithmetic, and the entry.
 *
 * ══ What these tests guard ═══════════════════════════════════════════════════
 *
 * APPLICABILITY, because §3 forbids a sales-only code on a bill and a
 * purchase-only code on an invoice. Reclaiming input tax under a code that only
 * ever charged output tax is a filing error nothing downstream would catch.
 *
 * The INCLUSIVE split, because computing an inclusive bill as exclusive
 * overcharges the supplier by exactly the rate and still balances.
 *
 * The SNAPSHOT, because a posted bill that reads today's tax code silently
 * restates what it was charged the moment a rate changes — and the supplier's
 * copy does not change with it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, type TestContext } from './helpers/testApp.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as suppliers from '../src/services/purchasing/supplierService.js';
import * as bills from '../src/services/purchasing/billService.js';
import * as taxCodes from '../src/services/invoicing/taxCodeService.js';

let ctx: TestContext;
let actor: AccountingActor;
let supplierId: string;
let chart: {
  payable: string; expense: string; expense2: string;
  inputTax: string; inputTax2: string; outputTax: string;
  bank: string; revenue: string;
};

const ENTITY = 'entity-main';

async function organization(name: string, currency = 'JOD'): Promise<string> {
  const owner = await seedUser(ctx, { email: `owner-${name.toLowerCase()}@ptax.test` });
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

const makeCode = (over: Record<string, unknown> = {}) =>
  taxCodes.createTaxCode(ctx.db, actor, {
    code: 'VATIN16', name: 'Standard-rated purchases', category: 'standard',
    calculationMethod: 'exclusive', direction: 'purchase', rate: '16',
    inputTaxAccountId: chart.inputTax, effectiveFrom: '2026-01-01',
    ...over,
  } as never);

const draft = (over: Record<string, unknown> = {}) =>
  bills.createDraft(ctx.db, actor, {
    issuingEntityId: ENTITY, supplierId, supplierInvoiceNumber: 'SUP-1',
    billDate: '2026-03-01', dueDate: '2026-03-31',
    lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '1000.000' }],
    ...over,
  } as never);

const post = (id: string, version: number) =>
  bills.postBill(ctx.db, actor, id, { expectedVersion: version });

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
    userId: await person('buy@ptax.test'),
    name: 'Buyer One',
  };

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
    inputTax: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '1360', accountName: 'Input tax recoverable', accountType: 'asset',
    })).id,
    inputTax2: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '1361', accountName: 'Input tax — reduced', accountType: 'asset',
    })).id,
    outputTax: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '2270', accountName: 'Output tax payable', accountType: 'liability',
    })).id,
    bank: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '1100', accountName: 'Bank current', accountType: 'asset',
      cashClassification: 'cash_and_cash_equivalents',
    })).id,
    revenue: (await accounts.createAccount(ctx.db, actor, {
      accountCode: '4000', accountName: 'Sales', accountType: 'income',
    })).id,
  };

  supplierId = (await suppliers.createSupplier(ctx.db, actor as never, {
    partyCode: 'ACME', legalName: 'Acme Supplies Ltd',
    supplier: { defaultPayableAccountId: chart.payable },
  } as never)).id;
}

beforeEach(() => setup());
afterEach(async () => { await ctx.close(); });

/* ══ Applicability ═════════════════════════════════════════════════════════ */

describe('which documents a code may be used on', () => {
  it('refuses a SALES-only code on a bill', async () => {
    const salesOnly = await makeCode({
      code: 'VATOUT', direction: 'sales',
      outputTaxAccountId: chart.outputTax, inputTaxAccountId: null,
    });
    await expect(draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '100.000', taxCodeId: salesOnly.id }],
    })).rejects.toThrow(/applies to sales documents, so it cannot be used on a bill/i);
  });

  it('accepts a code that applies to BOTH', async () => {
    const both = await makeCode({
      code: 'VAT16', direction: 'both',
      outputTaxAccountId: chart.outputTax, inputTaxAccountId: chart.inputTax,
    });
    const bill = await draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '1000.000', taxCodeId: both.id }],
    });
    expect(bill.taxTotal).toBe('160.000');
  });

  it('defaults a code with no direction to SALES, which a bill then refuses', async () => {
    /* Every code created before purchase tax existed is a sales code, and
     * recording that is history rather than a new decision. */
    const legacy = await makeCode({
      code: 'LEGACY', direction: undefined,
      outputTaxAccountId: chart.outputTax, inputTaxAccountId: null,
    });
    expect(legacy.direction).toBe('sales');
    await expect(draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '100.000', taxCodeId: legacy.id }],
    })).rejects.toThrow(/applies to sales documents/i);
  });

  it('refuses a withholding direction by name', async () => {
    await expect(makeCode({ code: 'WHT', direction: 'withholding-payable' }))
      .rejects.toThrow(/withholding is recognised at a payment stage/i);
  });

  it('refuses to change a direction, because posted lines froze it', async () => {
    const code = await makeCode();
    await expect(taxCodes.updateTaxCode(ctx.db, actor, code.id, {
      name: code.name, direction: 'both', inputTaxAccountId: chart.inputTax,
      expectedVersion: code.version,
    })).rejects.toThrow(/direction cannot be changed/i);
  });
});

/* ══ Exclusive ═════════════════════════════════════════════════════════════ */

describe('exclusive purchase tax', () => {
  it('adds tax on top and posts Dr expense, Dr input tax, Cr payable', async () => {
    const code = await makeCode({ rate: '16' });
    const bill = await draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });

    expect(bill.taxTotal).toBe('160.000');
    expect(bill.total).toBe('1160.000');

    const posted = await post(bill.id, bill.version);
    const entry = await legs(posted.journalEntryId!);

    /* §13 exactly. */
    expect(entry).toHaveLength(3);
    expect(entry.find((l) => l.account === chart.expense)!.debit).toBe(1000);
    expect(entry.find((l) => l.account === chart.inputTax)!.debit).toBe(160);
    expect(entry.find((l) => l.account === chart.payable)!.credit).toBe(1160);

    const debits = entry.reduce((s, l) => s + l.debit, 0);
    const credits = entry.reduce((s, l) => s + l.credit, 0);
    expect(debits).toBe(credits);
  });

  it('records the input account on the bill when unambiguous', async () => {
    const code = await makeCode();
    const bill = await draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    const posted = await post(bill.id, bill.version);
    expect(posted.inputTaxAccountId).toBe(chart.inputTax);
  });
});

/* ══ Inclusive ═════════════════════════════════════════════════════════════ */

describe('inclusive purchase tax', () => {
  it('splits the gross WITHOUT increasing what the supplier is owed', async () => {
    const code = await makeCode({ code: 'VATIN', calculationMethod: 'inclusive', rate: '16' });
    const bill = await draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '1160.000', taxCodeId: code.id }],
    });

    /*
     * The supplier billed 1160 and is owed 1160. Computing this as exclusive
     * would owe them 1345.600 — and it would still balance.
     */
    expect(bill.total).toBe('1160.000');
    expect(bill.taxTotal).toBe('160.000');

    const posted = await post(bill.id, bill.version);
    const entry = await legs(posted.journalEntryId!);
    expect(entry.find((l) => l.account === chart.expense)!.debit).toBe(1000);
    expect(entry.find((l) => l.account === chart.inputTax)!.debit).toBe(160);
    expect(entry.find((l) => l.account === chart.payable)!.credit).toBe(1160);
  });

  it('keeps net + tax EXACTLY equal to the gross on an awkward fraction', async () => {
    const code = await makeCode({ code: 'VATIN', calculationMethod: 'inclusive', rate: '16' });
    const bill = await draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '100.000', taxCodeId: code.id }],
    });

    /* 100 / 1.16 = 86.2068965…, which no currency can hold. */
    expect(bill.lines[0]!.taxableAmount).toBe('86.207');
    expect(bill.taxTotal).toBe('13.793');
    expect(bill.total).toBe('100.000');
  });
});

/* ══ Categories ════════════════════════════════════════════════════════════ */

describe('categories that charge nothing stay distinct', () => {
  it.each(['zero-rated', 'exempt', 'out-of-scope'] as const)(
    'posts NO input-tax leg for %s, and keeps the category on the line',
    async (category) => {
      const code = await makeCode({
        code: `Z-${category}`, category, rate: '0', inputTaxAccountId: null,
      });
      const bill = await draft({
        lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '500.000', taxCodeId: code.id }],
      });
      expect(bill.taxTotal).toBe('0.000');
      expect(bill.total).toBe('500.000');

      const posted = await post(bill.id, bill.version);
      expect(await legs(posted.journalEntryId!)).toHaveLength(2);

      /* The classification survives even though the amount is zero. */
      expect(posted.lines[0]!.taxSnapshot!.category).toBe(category);
      expect(posted.lines[0]!.taxSnapshot!.inputTaxAccountId).toBeNull();
    },
  );

  it('distinguishes a zero-rated line from a line with NO tax code', async () => {
    const code = await makeCode({ code: 'ZR', category: 'zero-rated', rate: '0', inputTaxAccountId: null });
    const withCode = await draft({
      supplierInvoiceNumber: 'A',
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '100.000', taxCodeId: code.id }],
    });
    const withoutCode = await draft({
      supplierInvoiceNumber: 'B',
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '100.000' }],
    });

    const a = await post(withCode.id, withCode.version);
    const b = await post(withoutCode.id, withoutCode.version);

    expect(a.lines[0]!.taxSnapshot!.category).toBe('zero-rated');
    expect(b.lines[0]!.taxSnapshot).toBeNull();
  });

  it('supports a REDUCED rate alongside a standard one, on separate accounts', async () => {
    const standard = await makeCode({ code: 'VAT16', rate: '16', inputTaxAccountId: chart.inputTax });
    const reduced = await makeCode({
      code: 'VAT04', category: 'reduced', rate: '4', inputTaxAccountId: chart.inputTax2,
    });

    const bill = await draft({
      lines: [
        { accountId: chart.expense, quantity: '1', unitPrice: '1000.000', taxCodeId: standard.id },
        { accountId: chart.expense2, quantity: '1', unitPrice: '1000.000', taxCodeId: reduced.id },
      ],
    });
    expect(bill.taxTotal).toBe('200.000'); // 160 + 40

    const posted = await post(bill.id, bill.version);
    const entry = await legs(posted.journalEntryId!);
    expect(entry.find((l) => l.account === chart.inputTax)!.debit).toBe(160);
    expect(entry.find((l) => l.account === chart.inputTax2)!.debit).toBe(40);
    expect(entry.find((l) => l.account === chart.payable)!.credit).toBe(2200);

    /* Two accounts, so no single one can name this bill's input tax. */
    expect(posted.inputTaxAccountId).toBeNull();
  });

  it('mixes a taxable line with a zero-tax-category line', async () => {
    const standard = await makeCode({ code: 'VAT16', rate: '16' });
    const exempt = await makeCode({ code: 'EX', category: 'exempt', rate: '0', inputTaxAccountId: null });

    const bill = await draft({
      lines: [
        { accountId: chart.expense, quantity: '1', unitPrice: '1000.000', taxCodeId: standard.id },
        { accountId: chart.expense2, quantity: '1', unitPrice: '500.000', taxCodeId: exempt.id },
      ],
    });
    expect(bill.taxTotal).toBe('160.000');
    expect(bill.total).toBe('1660.000');
  });
});

/* ══ Rounding and discounts ════════════════════════════════════════════════ */

describe('exact-decimal behaviour', () => {
  it('applies the discount BEFORE tax', async () => {
    const code = await makeCode({ rate: '16' });
    const bill = await draft({
      lines: [{
        accountId: chart.expense, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id,
        discountType: 'percentage', discountValue: '10',
      }],
    });
    /* 1000 less 10% = 900; tax on 900 = 144. */
    expect(bill.lines[0]!.taxableAmount).toBe('900.000');
    expect(bill.taxTotal).toBe('144.000');
    expect(bill.total).toBe('1044.000');
  });

  it('sums LINE-rounded tax across many lines', async () => {
    const code = await makeCode({ rate: '16' });
    const bill = await draft({
      lines: Array.from({ length: 3 }, () => ({
        accountId: chart.expense, quantity: '1', unitPrice: '1.010', taxCodeId: code.id,
      })),
    });
    /* Each line 1.010 x 16% = 0.1616 -> 0.162; three give 0.486. */
    expect(bill.taxTotal).toBe('0.486');
    expect(bill.total).toBe('3.516');
  });

  it('holds JOD to three decimals', async () => {
    const code = await makeCode({ rate: '16' });
    const bill = await draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '0.001', taxCodeId: code.id }],
    });
    expect(bill.taxTotal).toBe('0.000');
    expect(bill.total).toBe('0.001');
  });

  it('holds USD to TWO decimals', async () => {
    await ctx.close();
    await setup('USD');
    const code = await makeCode({ rate: '16' });
    const bill = await draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '10.99', taxCodeId: code.id }],
    });
    /* 10.99 x 16% = 1.7584 -> 1.76. */
    expect(bill.taxTotal).toBe('1.76');
    expect(bill.total).toBe('12.75');
  });
});

/* ══ Effective dating ══════════════════════════════════════════════════════ */

describe('effective-dated rates', () => {
  it('resolves on the POSTING date, at the boundary', async () => {
    const code = await makeCode({ rate: '16' });
    await taxCodes.addRateVersion(ctx.db, actor, code.id, {
      rate: '25', effectiveFrom: '2026-06-01', expectedVersion: code.version,
      inputTaxAccountId: chart.inputTax,
    });

    const before = await draft({
      billDate: '2026-05-31', dueDate: '2026-06-30',
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    const onTheDay = await draft({
      billDate: '2026-06-01', dueDate: '2026-06-30', supplierInvoiceNumber: 'SUP-2',
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });

    expect(before.taxTotal).toBe('160.000');
    expect(onTheDay.taxTotal).toBe('250.000');
  });

  it('refuses a date with no rate in force', async () => {
    const code = await makeCode({ rate: '16', effectiveFrom: '2026-06-01' });
    await expect(draft({
      billDate: '2026-01-01', dueDate: '2026-01-31',
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '100.000', taxCodeId: code.id }],
    })).rejects.toThrow(/does not apply on 2026-01-01/i);
  });

  it('refuses an archived or inactive code on a new bill', async () => {
    const code = await makeCode();
    const archived = await taxCodes.setTaxCodeStatus(ctx.db, actor, code.id, 'archived', code.version);
    await expect(draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '100.000', taxCodeId: code.id }],
    })).rejects.toThrow(/archived and cannot be put on a new bill/i);

    await taxCodes.setTaxCodeStatus(ctx.db, actor, code.id, 'inactive', archived.version);
    await expect(draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '100.000', taxCodeId: code.id }],
    })).rejects.toThrow(/inactive and cannot be put on a new bill/i);
  });

  it('uses a rate-version INPUT account override', async () => {
    const code = await makeCode({ rate: '16', inputTaxAccountId: chart.inputTax });
    await taxCodes.addRateVersion(ctx.db, actor, code.id, {
      rate: '20', effectiveFrom: '2026-06-01', expectedVersion: code.version,
      inputTaxAccountId: chart.inputTax2,
    });

    const bill = await draft({
      billDate: '2026-06-01', dueDate: '2026-06-30',
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    const posted = await post(bill.id, bill.version);
    const entry = await legs(posted.journalEntryId!);

    /* The version's account wins over the code's — a rate change that moved
     * control accounts must not restate the old one. */
    expect(entry.find((l) => l.account === chart.inputTax2)!.debit).toBe(200);
    expect(entry.find((l) => l.account === chart.inputTax)).toBeUndefined();
  });
});

/* ══ The input account ═════════════════════════════════════════════════════ */

describe('the input tax account', () => {
  it('refuses a LIABILITY account as an input account', async () => {
    await expect(makeCode({ code: 'BAD', inputTaxAccountId: chart.outputTax }))
      .rejects.toThrow(/must be an asset account/i);
  });

  it('refuses a CASH account as an input account', async () => {
    const error = await makeCode({ code: 'BAD', inputTaxAccountId: chart.bank })
      .then(() => null, (e) => e as Error);
    expect(error!.message).toMatch(/cash or bank account/i);
    expect(error!.message).toMatch(/claim on an authority/i);
  });

  it('refuses posting when a taxable code has NO input account', async () => {
    const code = await makeCode();
    const bill = await draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    await sql`UPDATE tax_codes SET input_tax_account_id = NULL WHERE id = ${code.id}`.execute(ctx.db);
    await sql`UPDATE tax_rate_versions SET input_tax_account_id = NULL WHERE tax_code_id = ${code.id}`
      .execute(ctx.db);

    const error = await post(bill.id, bill.version).then(() => null, (e) => e as Error);
    expect(error!.message).toMatch(/no input tax account/i);
    expect(error!.message).toMatch(/expects back from an authority/i);
  });

  it.each([
    ['archived', sql`archived = true, active = false`],
    ['blocked', sql`blocked = true`],
  ])('refuses posting when the input account became %s', async (_label, mutation) => {
    const code = await makeCode();
    const bill = await draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    await sql`UPDATE accounts SET ${mutation} WHERE id = ${chart.inputTax}`.execute(ctx.db);

    await expect(post(bill.id, bill.version)).rejects.toThrow(/cannot receive postings/i);

    const reread = await bills.getBill(ctx.db, actor, bill.id);
    expect(reread.status).toBe('draft');
    expect(reread.journalEntryId).toBeNull();
  });

  it('refuses an input account from another company', async () => {
    const otherOrg = await organization('Rival');
    const otherCompany = await company(otherOrg, 'co_rival');
    const foreign = await accounts.createAccount(ctx.db, {
      organizationId: otherOrg, companyId: otherCompany, userId: actor.userId, name: 'Rival',
    }, { accountCode: '1360', accountName: 'Their input tax', accountType: 'asset' });

    await expect(makeCode({ code: 'XC', inputTaxAccountId: foreign.id }))
      .rejects.toThrow(/does not exist in these books/i);
  });
});

/* ══ Client tampering ══════════════════════════════════════════════════════ */

describe('the client may name a code and nothing else', () => {
  it.each([
    ['taxRate', '5'],
    ['taxAmount', '5.000'],
    ['taxableAmount', '95.000'],
    ['taxCategory', 'exempt'],
    ['taxCalculationMethod', 'inclusive'],
    ['taxDirection', 'both'],
    ['taxRecoverability', 'recoverable'],
    ['recoverableTaxAmount', '5.000'],
    ['taxRateVersionId', '11111111-1111-1111-1111-111111111111'],
    ['taxAccountId', '22222222-2222-2222-2222-222222222222'],
    ['taxSnapshot', { rate: '5' }],
    ['taxInclusive', true],
    ['reverseCharge', true],
  ])('refuses a supplied %s', async (field, value) => {
    const code = await makeCode();
    await expect(draft({
      lines: [{
        accountId: chart.expense, quantity: '1', unitPrice: '100.000',
        taxCodeId: code.id, [field]: value,
      }],
    })).rejects.toThrow(/calculated by the server/i);
  });

  it('refuses partial recoverability BY NAME', async () => {
    const code = await makeCode();
    const error = await draft({
      lines: [{
        accountId: chart.expense, quantity: '1', unitPrice: '100.000',
        taxCodeId: code.id, recoverabilityPercent: 80,
      }],
    }).then(() => null, (e) => e as Error);

    expect(error!.message).toMatch(/partial or non-recoverable input tax is not supported/i);
    expect(error!.message).toMatch(/contradicts the fields beside it/i);
  });

  it('leaves NOTHING behind when a tampered bill is refused', async () => {
    const code = await makeCode();
    await expect(draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '100.000', taxCodeId: code.id, taxRate: '5' }],
    })).rejects.toThrow();
    expect(await bills.listBills(ctx.db, actor)).toHaveLength(0);
  });
});

/* ══ Snapshot immutability ═════════════════════════════════════════════════ */

describe('the frozen snapshot', () => {
  it('carries everything needed to reproduce the calculation', async () => {
    const code = await makeCode({ rate: '16' });
    const bill = await draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    const posted = await post(bill.id, bill.version);
    const snap = posted.lines[0]!.taxSnapshot!;

    expect(snap.taxCodeId).toBe(code.id);
    expect(snap.code).toBe('VATIN16');
    expect(snap.name).toBe('Standard-rated purchases');
    expect(snap.direction).toBe('purchase');
    expect(snap.category).toBe('standard');
    expect(snap.calculationMethod).toBe('exclusive');
    expect(snap.recoverability).toBe('recoverable');
    expect(snap.rate).toBe('16.000');
    expect(snap.rateVersionId).toBe(code.rateVersions[0]!.id);
    expect(snap.effectiveFrom).toBe('2026-01-01');
    expect(snap.taxableAmount).toBe('1000.000');
    expect(snap.taxAmount).toBe('160.000');
    expect(snap.recoverableTaxAmount).toBe('160.000');
    expect(snap.grossAmount).toBe('1160.000');
    expect(snap.inputTaxAccountId).toBe(chart.inputTax);
    /* The tax date is the bill's posting date — the date the ledger posts on. */
    expect(snap.taxPointDate).toBe('2026-03-01');
    expect(snap.capturedAt).toBeTruthy();
  });

  it('is ABSENT on a draft, because nothing is frozen until posting', async () => {
    const code = await makeCode();
    const bill = await draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    expect(bill.lines[0]!.taxSnapshot).toBeNull();
    /* The figures are there for the screen; they are not a promise yet. */
    expect(bill.lines[0]!.taxAmount).toBe('160.000');
  });

  it('does NOT change when the rate is superseded afterwards', async () => {
    const code = await makeCode({ rate: '16' });
    const bill = await draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    const posted = await post(bill.id, bill.version);

    await taxCodes.addRateVersion(ctx.db, actor, code.id, {
      rate: '25', effectiveFrom: '2026-04-01', expectedVersion: code.version,
      inputTaxAccountId: chart.inputTax,
    });

    const reread = await bills.getBill(ctx.db, actor, posted.id);
    expect(reread.taxTotal).toBe('160.000');
    expect(reread.lines[0]!.taxSnapshot!.rate).toBe('16.000');
  });

  it('does NOT change when the code is archived afterwards', async () => {
    const code = await makeCode();
    const bill = await draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    const posted = await post(bill.id, bill.version);
    await taxCodes.setTaxCodeStatus(ctx.db, actor, code.id, 'archived', code.version);

    const reread = await bills.getBill(ctx.db, actor, posted.id);
    expect(reread.lines[0]!.taxSnapshot!.code).toBe('VATIN16');
    expect(reread.taxTotal).toBe('160.000');
  });

  it('recalculates a DRAFT but never a posted bill', async () => {
    const code = await makeCode({ rate: '16' });
    const bill = await draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });

    const updated = await bills.updateDraft(ctx.db, actor, bill.id, {
      billDate: '2026-03-01', dueDate: '2026-03-31', supplierInvoiceNumber: 'SUP-1',
      lines: [{ accountId: chart.expense, quantity: '2', unitPrice: '1000.000', taxCodeId: code.id }],
    } as never, { expectedVersion: bill.version });
    expect(updated.taxTotal).toBe('320.000');

    const posted = await post(updated.id, updated.version);
    await expect(bills.updateDraft(ctx.db, actor, bill.id, {
      billDate: '2026-03-01', dueDate: '2026-03-31',
      lines: [{ accountId: chart.expense, quantity: '9', unitPrice: '1000.000', taxCodeId: code.id }],
    } as never, { expectedVersion: posted.version })).rejects.toThrow(/can no longer be edited/i);
  });
});

/* ══ Reversal ══════════════════════════════════════════════════════════════ */

describe('reversal uses the frozen original', () => {
  it('mirrors every leg, including the input tax', async () => {
    const code = await makeCode({ rate: '16' });
    const bill = await draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    const posted = await post(bill.id, bill.version);

    /* The configuration moves AFTER posting; the reversal must not follow it. */
    await taxCodes.addRateVersion(ctx.db, actor, code.id, {
      rate: '25', effectiveFrom: '2026-04-01', expectedVersion: code.version,
      inputTaxAccountId: chart.inputTax2,
    });

    const reversed = await bills.reverseBill(ctx.db, actor, bill.id, {
      expectedVersion: posted.version, reason: 'Duplicate',
    });

    const reversal = await legs(reversed.reversalJournalEntryId!);
    expect(reversal.find((l) => l.account === chart.payable)!.debit).toBe(1160);
    expect(reversal.find((l) => l.account === chart.expense)!.credit).toBe(1000);
    /* The ORIGINAL input account and amount, not the new ones. */
    expect(reversal.find((l) => l.account === chart.inputTax)!.credit).toBe(160);
    expect(reversal.find((l) => l.account === chart.inputTax2)).toBeUndefined();

    /* And the snapshot still says what was charged. */
    expect(reversed.lines[0]!.taxSnapshot!.rate).toBe('16.000');
  });
});

/* ══ Atomicity and idempotency ═════════════════════════════════════════════ */

describe('posting is all-or-nothing, and happens once', () => {
  it('rolls back the snapshot as well as the journal', async () => {
    const code = await makeCode();
    const bill = await draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    await sql`UPDATE accounts SET blocked = true WHERE id = ${chart.expense}`.execute(ctx.db);

    await expect(post(bill.id, bill.version)).rejects.toThrow();

    const reread = await bills.getBill(ctx.db, actor, bill.id);
    expect(reread.status).toBe('draft');
    expect(reread.journalEntryId).toBeNull();
    /* No frozen snapshot on an unposted bill. */
    expect(reread.lines[0]!.taxSnapshot).toBeNull();

    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM journal_entries WHERE organization_id = ${actor.organizationId}
    `.execute(ctx.db);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('creates no second journal or snapshot on a retry', async () => {
    const code = await makeCode();
    const bill = await draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '1000.000', taxCodeId: code.id }],
    });
    const posted = await post(bill.id, bill.version);

    await post(bill.id, bill.version).catch(() => undefined);
    await post(bill.id, posted.version).catch(() => undefined);

    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM journal_entries
       WHERE source_type = 'bill' AND source_id = ${bill.id}
    `.execute(ctx.db);
    expect(Number(rows[0]!.n)).toBe(1);

    const entry = await legs(posted.journalEntryId!);
    expect(entry.filter((l) => l.account === chart.inputTax)).toHaveLength(1);
  });
});

/* ══ Isolation ═════════════════════════════════════════════════════════════ */

describe('company isolation', () => {
  it('refuses another company\'s tax code on a bill', async () => {
    const second = await company(actor.organizationId, 'co_second');
    const secondActor = { ...actor, companyId: second };
    const otherInput = await accounts.createAccount(ctx.db, secondActor, {
      accountCode: '1360', accountName: 'Their input tax', accountType: 'asset',
    });
    const foreign = await taxCodes.createTaxCode(ctx.db, secondActor, {
      code: 'VATIN16', name: 'Theirs', category: 'standard', calculationMethod: 'exclusive',
      direction: 'purchase', rate: '16', inputTaxAccountId: otherInput.id,
      effectiveFrom: '2026-01-01',
    } as never);

    await expect(draft({
      lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '100.000', taxCodeId: foreign.id }],
    })).rejects.toThrow(/does not exist in these books/i);
  });
});

/* ══ P2 refusals still stand ═══════════════════════════════════════════════ */

describe('everything P3 did not bring is still refused', () => {
  it('still refuses withholding, charges, stock, currency and dimensions', async () => {
    const code = await makeCode();
    const line = (over: Record<string, unknown>) =>
      ({ lines: [{ accountId: chart.expense, quantity: '1', unitPrice: '100.000', taxCodeId: code.id, ...over }] });

    await expect(draft(line({ withholdingTaxRate: '5' }))).rejects.toThrow(/withholds tax/i);
    await expect(draft({ additionalChargesTotal: '5.000' })).rejects.toThrow(/Additional charges are not supported/i);
    await expect(draft(line({ inventoryItemId: 'i1' }))).rejects.toThrow(/receives stock/i);
    await expect(draft({ currency: 'USD' })).rejects.toThrow(/only JOD bills can be held/i);
    await expect(draft({ projectId: 'p1' })).rejects.toThrow(/projects/i);
    await expect(draft({ costCenterId: 'c1' })).rejects.toThrow(/cost centres/i);
    await expect(draft({ purchaseOrderId: 'po1' })).rejects.toThrow(/purchase orders/i);
  });

  it('still refuses a revenue or cash line account', async () => {
    await expect(draft({ lines: [{ accountId: chart.revenue, quantity: '1', unitPrice: '10.000' }] }))
      .rejects.toThrow(/debits an expense or a non-inventory asset/i);
    await expect(draft({ lines: [{ accountId: chart.bank, quantity: '1', unitPrice: '10.000' }] }))
      .rejects.toThrow(/cash or bank account/i);
  });
});

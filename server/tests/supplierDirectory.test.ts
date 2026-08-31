/**
 * The supplier directory: one legal party, the supplier role, and its payable.
 *
 * ══ What these tests are guarding ════════════════════════════════════════════
 *
 * Three things that go wrong quietly.
 *
 * The IDENTITY model, because the easy mistake is to let the same legal entity
 * exist twice — once as a customer, once as a supplier — each with its own code
 * and a tax number recordable against only one of them.
 *
 * The PAYABLE account, because an account of the wrong type balances every
 * entry it appears in while recording what the business owes as something else
 * entirely. A foreign key cannot express "must be a liability".
 *
 * The ISOLATION, because a supplier or an account reachable from another
 * company's books is not a bug you notice — it is one you find in an audit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, type TestContext } from './helpers/testApp.js';
import type { PartyActor } from '../src/services/sales/businessPartyService.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as suppliers from '../src/services/purchasing/supplierService.js';
import * as customers from '../src/services/sales/businessPartyService.js';

let ctx: TestContext;
let actor: PartyActor;
let chart: {
  payable: string; payable2: string; expense: string;
  revenue: string; receivable: string; header: string;
};

async function organization(name: string): Promise<string> {
  const owner = await seedUser(ctx, { email: `owner-${name.toLowerCase()}@sup.test` });
  return ctx.db.transaction().execute(async (trx) => {
    const org = await trx.insertInto('organizations').values({
      subscriber_owner_user_id: owner.id, legal_name: name, country: 'JO',
      base_currency: 'JOD', fiscal_year_start: '01-01', data_classification: 'test',
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

const create = (over: Record<string, unknown> = {}) =>
  suppliers.createSupplier(ctx.db, actor, {
    partyCode: 'ACME',
    legalName: 'Acme Supplies Ltd',
    supplier: { defaultPayableAccountId: chart.payable },
    ...over,
  } as never);

beforeEach(async () => {
  ctx = await createTestContext();
  const organizationId = await organization('Buy');
  actor = {
    organizationId,
    companyId: await company(organizationId, 'co_buy'),
    userId: await person('buy@sup.test'),
    name: 'Buyer One',
  };

  const header = await accounts.createAccount(ctx.db, actor as never, {
    accountCode: '2000', accountName: 'Liabilities', accountType: 'liability', isPostable: false,
  });
  await accounts.createAccount(ctx.db, actor as never, {
    accountCode: '2001', accountName: 'Under the heading', accountType: 'liability',
    parentAccountId: header.id,
  });

  chart = {
    payable: (await accounts.createAccount(ctx.db, actor as never, {
      accountCode: '2100', accountName: 'Accounts payable', accountType: 'liability',
    })).id,
    payable2: (await accounts.createAccount(ctx.db, actor as never, {
      accountCode: '2110', accountName: 'Payable — overseas', accountType: 'liability',
    })).id,
    expense: (await accounts.createAccount(ctx.db, actor as never, {
      accountCode: '5000', accountName: 'Cost of services', accountType: 'expense',
    })).id,
    revenue: (await accounts.createAccount(ctx.db, actor as never, {
      accountCode: '4000', accountName: 'Sales', accountType: 'income',
    })).id,
    receivable: (await accounts.createAccount(ctx.db, actor as never, {
      accountCode: '1200', accountName: 'Trade receivables', accountType: 'asset',
    })).id,
    header: header.id,
  };
});
afterEach(async () => { await ctx.close(); });

/* ══ Lifecycle ═════════════════════════════════════════════════════════════ */

describe('the supplier lifecycle', () => {
  it('creates a supplier with its payable account', async () => {
    const supplier = await create();

    expect(supplier.partyCode).toBe('ACME');
    expect(supplier.legalName).toBe('Acme Supplies Ltd');
    expect(supplier.isSupplier).toBe(true);
    /* A supplier-only party is NOT a customer. The roles are independent. */
    expect(supplier.isCustomer).toBe(false);
    expect(supplier.supplier!.defaultPayableAccountId).toBe(chart.payable);
    expect(supplier.status).toBe('active');
    expect(supplier.version).toBe(1);
  });

  it('lists and searches by code, legal name and trading name', async () => {
    await create({ partyCode: 'ACME', legalName: 'Acme Supplies Ltd' });
    await create({ partyCode: 'BOLT', legalName: 'Bolt Fasteners', tradingName: 'Boltco' });

    expect((await suppliers.listSuppliers(ctx.db, actor)).parties).toHaveLength(2);
    expect((await suppliers.listSuppliers(ctx.db, actor, { search: 'acme' })).parties)
      .toHaveLength(1);
    expect((await suppliers.listSuppliers(ctx.db, actor, { search: 'boltco' })).parties[0]!.partyCode)
      .toBe('BOLT');
  });

  it('updates shared fields and the supplier profile together', async () => {
    const supplier = await create();

    const updated = await suppliers.updateSupplier(ctx.db, actor, supplier.id, {
      expectedVersion: supplier.version,
      legalName: 'Acme Supplies PLC',
      contactPerson: 'Dana',
      supplier: {
        defaultPayableAccountId: chart.payable2,
        supplierCategory: 'Consumables',
        withholdingTaxApplicable: true,
      },
    } as never);

    expect(updated.legalName).toBe('Acme Supplies PLC');
    expect(updated.contactPerson).toBe('Dana');
    expect(updated.supplier!.defaultPayableAccountId).toBe(chart.payable2);
    expect(updated.supplier!.supplierCategory).toBe('Consumables');
    /* Recorded, not acted on: there is no withholding workflow on the server. */
    expect(updated.supplier!.withholdingTaxApplicable).toBe(true);
    expect(updated.version).toBe(supplier.version + 1);
  });

  it('archives and reactivates, and hides archived from the default list', async () => {
    const supplier = await create();

    const archived = await suppliers.setSupplierArchived(ctx.db, actor, supplier.id, {
      archived: true, expectedVersion: supplier.version, reason: 'No longer trading',
    });
    expect(archived.status).toBe('archived');
    expect((await suppliers.listSuppliers(ctx.db, actor)).parties).toHaveLength(0);
    expect((await suppliers.listSuppliers(ctx.db, actor, { includeArchived: true })).parties)
      .toHaveLength(1);

    const restored = await suppliers.setSupplierArchived(ctx.db, actor, supplier.id, {
      archived: false, expectedVersion: archived.version,
    });
    expect(restored.status).toBe('active');
    expect((await suppliers.listSuppliers(ctx.db, actor)).parties).toHaveLength(1);
  });

  it('refuses to edit an archived supplier until it is restored', async () => {
    const supplier = await create();
    const archived = await suppliers.setSupplierArchived(ctx.db, actor, supplier.id, {
      archived: true, expectedVersion: supplier.version,
    });

    await expect(suppliers.updateSupplier(ctx.db, actor, supplier.id, {
      expectedVersion: archived.version, legalName: 'Changed',
    } as never)).rejects.toThrow(/archived/i);
  });

  it('offers NO delete path at all', () => {
    /* Archiving is the only removal. A supplier named on a document must stay
     * identifiable for as long as the document does. */
    expect((suppliers as Record<string, unknown>).deleteSupplier).toBeUndefined();
  });
});

/* ══ Identity ══════════════════════════════════════════════════════════════ */

describe('supplier codes', () => {
  it('refuses a duplicate code in the same books, case-insensitively', async () => {
    await create({ partyCode: 'ACME' });
    await expect(create({ partyCode: 'acme', legalName: 'Another' }))
      .rejects.toThrow(/party code is already used/i);
  });

  it('refuses a duplicate code held by a CUSTOMER party', async () => {
    /* One directory, one code space. The clash is the model working: the same
     * code cannot name two legal entities. */
    await customers.createCustomer(ctx.db, actor, {
      partyCode: 'SHARED', legalName: 'Shared Party Ltd',
    } as never);

    await expect(create({ partyCode: 'SHARED', legalName: 'Different Ltd' }))
      .rejects.toThrow(/party code is already used/i);
  });

  it('refuses a duplicate tax registration number', async () => {
    await create({ partyCode: 'ONE', taxRegistrationNumber: 'JO-123' });
    await expect(create({ partyCode: 'TWO', taxRegistrationNumber: 'JO-123' }))
      .rejects.toThrow(/tax registration number is already used/i);
  });

  it('lets two COMPANIES hold the same supplier code', async () => {
    await create({ partyCode: 'ACME' });
    const second = await company(actor.organizationId, 'co_second');
    const created = await suppliers.createSupplier(ctx.db, { ...actor, companyId: second }, {
      partyCode: 'ACME', legalName: 'Acme Supplies Ltd',
    } as never);
    /* Two companies in one group legitimately both trade with the same firm. */
    expect(created.partyCode).toBe('ACME');
  });

  it('allocates NO number: the code is the caller\'s and is required', async () => {
    await expect(create({ partyCode: '   ' })).rejects.toThrow(/supplier code is required/i);
  });
});

/* ══ One party, two roles ══════════════════════════════════════════════════ */

describe('a party that is both customer and supplier', () => {
  it('grants the supplier role to an existing customer, keeping ONE record', async () => {
    const customer = await customers.createCustomer(ctx.db, actor, {
      partyCode: 'BOTH', legalName: 'Both Ways Trading',
      customer: { defaultReceivableAccountId: chart.receivable },
    } as never);

    const supplier = await suppliers.grantSupplierRole(ctx.db, actor, customer.id, {
      expectedVersion: customer.version,
      supplier: { defaultPayableAccountId: chart.payable },
    });

    /* One id, one code, one tax number — both roles. */
    expect(supplier.id).toBe(customer.id);
    expect(supplier.isCustomer).toBe(true);
    expect(supplier.isSupplier).toBe(true);
    expect(supplier.customer!.defaultReceivableAccountId).toBe(chart.receivable);
    expect(supplier.supplier!.defaultPayableAccountId).toBe(chart.payable);
  });

  it('refuses to grant a role the party already holds', async () => {
    const supplier = await create();
    await expect(suppliers.grantSupplierRole(ctx.db, actor, supplier.id, {
      expectedVersion: supplier.version,
    })).rejects.toThrow(/already a supplier/i);
  });

  it('does not let the supplier route touch a CUSTOMER field', async () => {
    const customer = await customers.createCustomer(ctx.db, actor, {
      partyCode: 'BOTH', legalName: 'Both Ways',
      customer: { defaultReceivableAccountId: chart.receivable, customerCategory: 'Retail' },
    } as never);
    const supplier = await suppliers.grantSupplierRole(ctx.db, actor, customer.id, {
      expectedVersion: customer.version,
    });

    await suppliers.updateSupplier(ctx.db, actor, customer.id, {
      expectedVersion: supplier.version,
      legalName: 'Both Ways Trading',
      supplier: { supplierCategory: 'Wholesale' },
    } as never);

    /* The customer profile is untouched, because the supplier service issues no
     * statement against that table. */
    const after = await customers.getCustomer(ctx.db, actor, customer.id);
    expect(after.customer!.customerCategory).toBe('Retail');
    expect(after.customer!.defaultReceivableAccountId).toBe(chart.receivable);
  });

  it('does not list a customer-only party as a supplier', async () => {
    await customers.createCustomer(ctx.db, actor, {
      partyCode: 'CUSTONLY', legalName: 'Customer Only',
    } as never);
    expect((await suppliers.listSuppliers(ctx.db, actor)).parties).toHaveLength(0);
  });
});

/* ══ The payable account ═══════════════════════════════════════════════════ */

describe('the payable account', () => {
  it('refuses an account that is not a LIABILITY', async () => {
    const error = await create({ supplier: { defaultPayableAccountId: chart.revenue } })
      .then(() => null, (e) => e as Error);

    expect(error!.message).toMatch(/must be a liability account/i);
    /* The reason, not just the rule. */
    expect(error!.message).toMatch(/what the business owes a supplier is a liability/i);
  });

  it('refuses an ASSET account', async () => {
    await expect(create({ supplier: { defaultPayableAccountId: chart.receivable } }))
      .rejects.toThrow(/must be a liability account/i);
  });

  it('refuses a heading account', async () => {
    await expect(create({ supplier: { defaultPayableAccountId: chart.header } }))
      .rejects.toThrow(/cannot receive postings/i);
  });

  it.each([
    ['archived', sql`archived = true, active = false`],
    ['inactive', sql`active = false`],
    ['blocked', sql`blocked = true`],
  ])('refuses an %s account', async (_label, mutation) => {
    await sql`UPDATE accounts SET ${mutation} WHERE id = ${chart.payable}`.execute(ctx.db);
    await expect(create()).rejects.toThrow(/cannot receive postings/i);
  });

  it('refuses an account that does not exist', async () => {
    await expect(create({
      supplier: { defaultPayableAccountId: '99999999-9999-9999-9999-999999999999' },
    })).rejects.toThrow(/does not exist in these books/i);
  });

  it('requires the default EXPENSE account to be an expense account', async () => {
    await expect(create({
      supplier: { defaultPayableAccountId: chart.payable, defaultExpenseAccountId: chart.payable },
    })).rejects.toThrow(/must be an expense account/i);
  });

  it('accepts a supplier with NO payable account yet', async () => {
    /* P1 posts nothing, so an unassigned payable is a normal in-progress state
     * rather than an error. The refusal belongs where a bill is posted. */
    const supplier = await create({ supplier: {} });
    expect(supplier.supplier!.defaultPayableAccountId).toBeNull();
  });

  it('leaves NOTHING behind when the account is refused', async () => {
    await expect(create({ supplier: { defaultPayableAccountId: chart.revenue } })).rejects.toThrow();
    expect((await suppliers.listSuppliers(ctx.db, actor, { includeArchived: true })).parties)
      .toHaveLength(0);
  });
});

/* ══ Isolation ═════════════════════════════════════════════════════════════ */

describe('company isolation', () => {
  it('refuses another company\'s account as a payable', async () => {
    const otherOrg = await organization('Rival');
    const otherCompany = await company(otherOrg, 'co_rival');
    const foreign = await accounts.createAccount(ctx.db, {
      organizationId: otherOrg, companyId: otherCompany, userId: actor.userId, name: 'Rival',
    } as never, { accountCode: '2100', accountName: 'Their payable', accountType: 'liability' });

    await expect(create({ supplier: { defaultPayableAccountId: foreign.id } }))
      .rejects.toThrow(/does not exist in these books/i);
  });

  it('does not read, update or archive another company\'s supplier', async () => {
    const supplier = await create();
    const second = await company(actor.organizationId, 'co_second');
    const intruder: PartyActor = { ...actor, companyId: second };

    await expect(suppliers.getSupplier(ctx.db, intruder, supplier.id))
      .rejects.toThrow(/not found/i);
    await expect(suppliers.updateSupplier(ctx.db, intruder, supplier.id, {
      expectedVersion: supplier.version, legalName: 'Hijacked',
    } as never)).rejects.toThrow(/not found/i);
    await expect(suppliers.setSupplierArchived(ctx.db, intruder, supplier.id, {
      archived: true, expectedVersion: supplier.version,
    })).rejects.toThrow(/not found/i);
    await expect(suppliers.supplierHistory(ctx.db, intruder, supplier.id))
      .rejects.toThrow(/not found/i);

    /* And the record is untouched. */
    const after = await suppliers.getSupplier(ctx.db, actor, supplier.id);
    expect(after.legalName).toBe('Acme Supplies Ltd');
    expect(after.status).toBe('active');
  });

  it('counts only this company\'s suppliers', async () => {
    await create();
    const second = await company(actor.organizationId, 'co_second');
    expect(await suppliers.countSuppliers(ctx.db, actor)).toBe(1);
    expect(await suppliers.countSuppliers(ctx.db, { ...actor, companyId: second })).toBe(0);
  });
});

/* ══ Concurrency ═══════════════════════════════════════════════════════════ */

describe('concurrent and stale writes', () => {
  it('refuses a stale update rather than overwriting a newer record', async () => {
    const supplier = await create();
    await suppliers.updateSupplier(ctx.db, actor, supplier.id, {
      expectedVersion: supplier.version, legalName: 'First edit',
    } as never);

    await expect(suppliers.updateSupplier(ctx.db, actor, supplier.id, {
      expectedVersion: supplier.version, legalName: 'Second edit',
    } as never)).rejects.toThrow(/changed by someone else/i);

    /* The first edit stands. A stale write must never win. */
    expect((await suppliers.getSupplier(ctx.db, actor, supplier.id)).legalName).toBe('First edit');
  });

  it('refuses a stale archive', async () => {
    const supplier = await create();
    await suppliers.updateSupplier(ctx.db, actor, supplier.id, {
      expectedVersion: supplier.version, legalName: 'Edited',
    } as never);

    await expect(suppliers.setSupplierArchived(ctx.db, actor, supplier.id, {
      archived: true, expectedVersion: supplier.version,
    })).rejects.toThrow(/changed by someone else/i);
  });

  it('lets only ONE of two creates take a contested code', async () => {
    /* Both pass any read-before-write; the unique index stops the second.
     * Genuine multi-connection concurrency is proved against a real server in
     * the disposable probe — PGlite runs in one process. */
    await create({ partyCode: 'RACE' });
    await expect(create({ partyCode: 'RACE', legalName: 'Loser' }))
      .rejects.toThrow(/party code is already used/i);

    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM business_parties
       WHERE organization_id = ${actor.organizationId}
         AND company_id = ${actor.companyId}
         AND lower(party_code) = 'race'
    `.execute(ctx.db);
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

/* ══ Audit ═════════════════════════════════════════════════════════════════ */

describe('audit history', () => {
  it('records creation and the supplier role being granted', async () => {
    const supplier = await create();
    const history = await suppliers.supplierHistory(ctx.db, actor, supplier.id);

    expect(history.map((e) => e.action)).toEqual(
      expect.arrayContaining(['PARTY_CREATED', 'SUPPLIER_ROLE_GRANTED']),
    );
    expect(history.every((e) => e.actorName === 'Buyer One')).toBe(true);
  });

  it('records a PAYABLE ACCOUNT change with both sides of it', async () => {
    const supplier = await create();
    await suppliers.updateSupplier(ctx.db, actor, supplier.id, {
      expectedVersion: supplier.version,
      legalName: supplier.legalName,
      supplier: { defaultPayableAccountId: chart.payable2 },
    } as never);

    const event = (await suppliers.supplierHistory(ctx.db, actor, supplier.id))
      .find((e) => e.action === 'SUPPLIER_PAYABLE_ACCOUNT_CHANGED');

    expect(event).toBeDefined();
    expect(event!.detail).toMatchObject({ from: chart.payable, to: chart.payable2 });
  });

  it('records a TAX IDENTITY change separately', async () => {
    const supplier = await create({ taxRegistrationNumber: 'JO-1' });
    await suppliers.updateSupplier(ctx.db, actor, supplier.id, {
      expectedVersion: supplier.version,
      legalName: supplier.legalName,
      taxRegistrationNumber: 'JO-2',
    } as never);

    const event = (await suppliers.supplierHistory(ctx.db, actor, supplier.id))
      .find((e) => e.action === 'SUPPLIER_TAX_IDENTITY_CHANGED');

    expect(event).toBeDefined();
    expect(event!.detail).toMatchObject({ from: 'JO-1', to: 'JO-2' });
  });

  it('records archiving with its reason', async () => {
    const supplier = await create();
    await suppliers.setSupplierArchived(ctx.db, actor, supplier.id, {
      archived: true, expectedVersion: supplier.version, reason: 'Ceased trading',
    });

    const event = (await suppliers.supplierHistory(ctx.db, actor, supplier.id))
      .find((e) => e.action === 'PARTY_ARCHIVED');
    expect(event!.detail).toMatchObject({ reason: 'Ceased trading' });
  });
});

/* ══ Addresses ═════════════════════════════════════════════════════════════ */

describe('the remittance address', () => {
  it('stores a billing address and marks the only one primary', async () => {
    const supplier = await create({
      addresses: [{ purpose: 'billing', addressLine1: '12 Mill Road', city: 'Amman', country: 'JO' }],
    });

    expect(supplier.addresses).toHaveLength(1);
    expect(supplier.addresses[0]!.city).toBe('Amman');
    /* An address nothing marks primary is an address no document picks up. */
    expect(supplier.addresses[0]!.isPrimary).toBe(true);
  });
});

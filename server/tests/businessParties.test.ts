/**
 * The business-party directory: one identity, roles on top of it.
 *
 * ══ What these hold the design to ════════════════════════════════════════════
 *
 * A party may be a customer, a supplier, or both, and the three cases share one
 * code, one tax number and one address book. The claims that matter:
 *
 *   · the customer route may change SHARED fields and customer fields, and is
 *     structurally unable to reach a supplier field;
 *   · withdrawing one role never removes the party or the other role;
 *   · uniqueness of code and tax number holds across ALL roles, per company,
 *     case-insensitively — enforced by the database, not by a read-before-write
 *     that two connections can both pass;
 *   · there is no delete, so a party named on a document stays identifiable;
 *   · nothing here writes a journal. Master data is not an accounting event.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, seedUser, type TestContext } from './helpers/testApp.js';
import * as parties from '../src/services/sales/businessPartyService.js';

let ctx: TestContext;
let actor: parties.PartyActor;

async function organization(name: string): Promise<string> {
  const owner = await seedUser(ctx, { email: `owner-${name.toLowerCase()}@party.test` });
  return ctx.db.transaction().execute(async (trx) => {
    const org = await trx.insertInto('organizations').values({
      subscriber_owner_user_id: owner.id, legal_name: name, country: 'JO',
      base_currency: 'JOD', fiscal_year_start: '01-01', data_classification: 'test',
    }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('organization_memberships')
      .values({ organization_id: org.id, user_id: owner.id, role: 'owner' }).execute();
    return org.id;
  });
}

async function company(org: string, reference: string): Promise<string> {
  const row = await ctx.db.insertInto('companies')
    .values({
      organization_id: org, client_reference: reference,
      legal_name: `Books ${reference}`, adopted_at: sql`now()`,
    })
    .returning('id').executeTakeFirstOrThrow();
  await ctx.db.insertInto('company_settings')
    .values({ organization_id: org, company_id: row.id })
    .onConflict((oc) => oc.columns(['organization_id', 'company_id']).doNothing())
    .execute();
  return row.id;
}

async function person(email: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO users (email, normalized_email, full_name, password_hash, status, email_verified_at)
    VALUES (${email}, ${email}, 'Directory Keeper', 'x', 'active', now()) RETURNING id
  `.execute(ctx.db);
  return rows[0]!.id;
}

const create = (over: Partial<parties.CreateCustomerInput> = {}, who = actor) =>
  parties.createCustomer(ctx.db, who, {
    partyCode: 'ACME', legalName: 'Acme Trading LLC', ...over,
  });

beforeEach(async () => {
  ctx = await createTestContext();
  const organizationId = await organization('Directory');
  actor = {
    organizationId,
    companyId: await company(organizationId, 'co_directory'),
    userId: await person('keeper@party.test'),
    name: 'Directory Keeper',
  };
});
afterEach(async () => { await ctx.close(); });

/* ══ Identity and roles ════════════════════════════════════════════════════ */

describe('a business party', () => {
  it('is created with the customer role and its own profile', async () => {
    const party = await create({
      tradingName: 'Acme',
      customer: { creditLimit: '5000.000', customerCategory: 'wholesale' },
    });

    expect(party.partyCode).toBe('ACME');
    expect(party.isCustomer).toBe(true);
    /* The customer route never grants the supplier role. */
    expect(party.isSupplier).toBe(false);
    expect(party.customer?.creditLimit).toBe('5000.0000000000');
    expect(party.version).toBe(1);
    expect(party.status).toBe('active');
  });

  it('keeps the credit limit as an exact decimal, never a float', async () => {
    /* A value a double cannot hold exactly. Through `numeric` it survives. */
    const party = await create({ customer: { creditLimit: '12345678901234.1234567891' } });
    expect(party.customer?.creditLimit).toBe('12345678901234.1234567891');
  });

  it('normalises exactly what the browser directory normalised', async () => {
    const party = await create({
      partyCode: '  acme-2  ',
      legalName: '  Acme Trading LLC  ',
      iban: 'jo94 cbjo 0010 0000',
      swiftCode: 'cbjojoax',
      defaultCurrency: 'jod',
    });

    expect(party.partyCode).toBe('acme-2');
    expect(party.legalName).toBe('Acme Trading LLC');
    expect(party.iban).toBe('JO94CBJO00100000');
    expect(party.swiftCode).toBe('CBJOJOAX');
    expect(party.defaultCurrency).toBe('JOD');
  });

  it('stores several addresses, with one primary per purpose', async () => {
    const party = await create({
      addresses: [
        { purpose: 'billing', addressLine1: 'Head office', city: 'Amman' },
        { purpose: 'shipping', addressLine1: 'Warehouse', city: 'Zarqa' },
      ],
    });

    expect(party.addresses).toHaveLength(2);
    /* The first of each purpose becomes primary: an address no document picks
     * up is an address that might as well not be recorded. */
    expect(party.addresses.every((a) => a.isPrimary)).toBe(true);
  });

  it('refuses a party with no legal name or no code', async () => {
    await expect(create({ legalName: '   ' })).rejects.toThrow(/legal name/i);
    await expect(create({ partyCode: '  ' })).rejects.toThrow(/party code/i);
  });

  it('refuses a negative credit limit', async () => {
    await expect(create({ customer: { creditLimit: '-1.000' } })).rejects.toThrow(/negative/i);
  });
});

/* ══ Uniqueness, across every role ═════════════════════════════════════════ */

describe('directory uniqueness', () => {
  it('refuses a duplicate party code, case-insensitively', async () => {
    await create({ partyCode: 'ACME' });
    await expect(create({ partyCode: 'acme', legalName: 'Another' }))
      .rejects.toThrow(/party code is already used/i);
  });

  it('refuses a duplicate tax registration number', async () => {
    await create({ partyCode: 'ONE', taxRegistrationNumber: 'JO-123' });
    await expect(create({ partyCode: 'TWO', legalName: 'Other', taxRegistrationNumber: 'jo-123' }))
      .rejects.toThrow(/tax registration number is already used/i);
  });

  it('allows many parties with NO tax number', async () => {
    /* The index is partial: blank is not a value that can collide. */
    await create({ partyCode: 'A', taxRegistrationNumber: '' });
    await create({ partyCode: 'B', legalName: 'B Co', taxRegistrationNumber: '' });
    const { parties: list } = await parties.listCustomers(ctx.db, actor);
    expect(list).toHaveLength(2);
  });

  it('scopes uniqueness to the COMPANY, not the organization', async () => {
    await create({ partyCode: 'SHARED' });
    const second = { ...actor, companyId: await company(actor.organizationId, 'co_second') };

    /* Two companies in one group keep separate directories and legitimately
     * both trade with the same supplier. */
    const other = await create({ partyCode: 'SHARED' }, second);
    expect(other.partyCode).toBe('SHARED');
  });
});

/* ══ Editing ═══════════════════════════════════════════════════════════════ */

describe('editing a customer', () => {
  it('changes shared and customer fields together, and bumps the version', async () => {
    const party = await create();

    const updated = await parties.updateCustomer(ctx.db, actor, party.id, {
      expectedVersion: party.version,
      legalName: 'Acme Trading FZE',
      customer: { creditLimit: '9000.000' },
    });

    expect(updated.legalName).toBe('Acme Trading FZE');
    expect(updated.customer?.creditLimit).toBe('9000.0000000000');
    expect(updated.version).toBe(2);
  });

  it('REFUSES a stale version rather than overwriting', async () => {
    const party = await create();
    await parties.updateCustomer(ctx.db, actor, party.id, {
      expectedVersion: party.version, legalName: 'First edit',
    });

    /* The second editor still holds version 1. Without this check their write
     * would silently discard the first edit. */
    await expect(parties.updateCustomer(ctx.db, actor, party.id, {
      expectedVersion: party.version, legalName: 'Second edit',
    })).rejects.toThrow(/changed by someone else/i);

    expect((await parties.getCustomer(ctx.db, actor, party.id)).legalName).toBe('First edit');
  });

  it('records WHICH fields changed, so a later supplier edit can be traced', async () => {
    const party = await create();
    await parties.updateCustomer(ctx.db, actor, party.id, {
      expectedVersion: party.version, legalName: 'Renamed', phone: '+962 6 000 0000',
    });

    const [latest] = await parties.customerHistory(ctx.db, actor, party.id);
    expect(latest!.action).toBe('PARTY_UPDATED');
    expect(latest!.previousVersion).toBe(1);
    expect(latest!.resultingVersion).toBe(2);
    expect(latest!.detail.changed).toEqual(['legal_name', 'phone']);
  });

  it('refuses a duplicate code on edit as firmly as on create', async () => {
    await create({ partyCode: 'TAKEN' });
    const party = await create({ partyCode: 'FREE', legalName: 'Free Co' });

    await expect(parties.updateCustomer(ctx.db, actor, party.id, {
      expectedVersion: party.version, partyCode: 'taken',
    })).rejects.toThrow(/party code is already used/i);
  });
});

/* ══ Archive, restore, and the absence of delete ═══════════════════════════ */

describe('archiving', () => {
  it('hides a party from the directory without removing it', async () => {
    const party = await create();

    const archived = await parties.setCustomerArchived(ctx.db, actor, party.id, {
      archived: true, expectedVersion: party.version, reason: 'No longer trading',
    });
    expect(archived.status).toBe('archived');

    /* Gone from the picker… */
    const active = await parties.listCustomers(ctx.db, actor);
    expect(active.parties).toHaveLength(0);
    /* …but still there, and still fetchable by the documents that name it. */
    const all = await parties.listCustomers(ctx.db, actor, { includeArchived: true });
    expect(all.parties).toHaveLength(1);
    expect(await parties.getCustomer(ctx.db, actor, party.id)).toBeTruthy();
  });

  it('restores exactly what it archived', async () => {
    const party = await create();
    const archived = await parties.setCustomerArchived(ctx.db, actor, party.id, {
      archived: true, expectedVersion: party.version,
    });
    const restored = await parties.setCustomerArchived(ctx.db, actor, party.id, {
      archived: false, expectedVersion: archived.version,
    });

    expect(restored.status).toBe('active');
    const history = await parties.customerHistory(ctx.db, actor, party.id);
    expect(history.map((e) => e.action)).toContain('PARTY_ARCHIVED');
    expect(history.map((e) => e.action)).toContain('PARTY_RESTORED');
  });

  it('offers no destructive delete at all', async () => {
    /* Not "refuses when referenced" — the operation does not exist. A party
     * named on an issued invoice must stay identifiable for as long as the
     * invoice does, and the surest way to guarantee that is to have no path. */
    expect((parties as Record<string, unknown>).deleteCustomer).toBeUndefined();
    expect((parties as Record<string, unknown>).destroyParty).toBeUndefined();
  });
});

/* ══ Isolation ═════════════════════════════════════════════════════════════ */

describe('scoping', () => {
  it('does not show one company’s customers to another', async () => {
    await create({ partyCode: 'MINE' });
    const second = { ...actor, companyId: await company(actor.organizationId, 'co_other') };

    const theirs = await parties.listCustomers(ctx.db, second);
    expect(theirs.parties).toHaveLength(0);
  });

  it('answers another organization’s customer as not found', async () => {
    const party = await create();
    const otherOrg = await organization('Globex');
    const otherCompany = await company(otherOrg, 'co_globex');

    await expect(parties.getCustomer(ctx.db,
      { organizationId: otherOrg, companyId: otherCompany }, party.id))
      .rejects.toThrow(/not found/i);
  });

  it('refuses to edit a party belonging to another company', async () => {
    const party = await create();
    const second = { ...actor, companyId: await company(actor.organizationId, 'co_third') };

    await expect(parties.updateCustomer(ctx.db, second, party.id, {
      expectedVersion: 1, legalName: 'Hijacked',
    })).rejects.toThrow(/not found/i);
  });
});

/* ══ Selection ═════════════════════════════════════════════════════════════ */

describe('the picker', () => {
  it('searches code, legal name and trading name', async () => {
    await create({ partyCode: 'AAA', legalName: 'Alpha Industrial', tradingName: 'Alpha' });
    await create({ partyCode: 'BBB', legalName: 'Beta Supplies', tradingName: 'Beta' });

    const byName = await parties.listCustomers(ctx.db, actor, { search: 'beta' });
    expect(byName.parties.map((p) => p.partyCode)).toEqual(['BBB']);

    const byCode = await parties.listCustomers(ctx.db, actor, { search: 'aaa' });
    expect(byCode.parties.map((p) => p.partyCode)).toEqual(['AAA']);
  });

  it('pages deterministically, without repeating or skipping', async () => {
    for (let i = 0; i < 7; i += 1) {
      await create({ partyCode: `C${String(i).padStart(2, '0')}`, legalName: `Customer ${i}` });
    }

    const seen: string[] = [];
    let after: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof parties.listCustomers>> =
        await parties.listCustomers(ctx.db, actor, { limit: 3, after });
      seen.push(...page.parties.map((p) => p.partyCode));
      after = page.nextCursor;
    } while (after);

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    /* The server's order, by code, so two readers see the same sequence. */
    expect(seen).toEqual([...seen].sort());
  });

  it('caps an oversized page request', async () => {
    await create();
    const page = await parties.listCustomers(ctx.db, actor, { limit: 10_000 });
    expect(page.parties.length).toBeLessThanOrEqual(200);
  });
});

/* ══ Master data is not an accounting event ════════════════════════════════ */

describe('accounting', () => {
  it('creates NO journal entry for any customer operation', async () => {
    const party = await create({ customer: { creditLimit: '1000.000' } });
    await parties.updateCustomer(ctx.db, actor, party.id, {
      expectedVersion: party.version, legalName: 'Renamed',
    });
    await parties.setCustomerArchived(ctx.db, actor, party.id, {
      archived: true, expectedVersion: 2,
    });

    /* A credit limit is a control, not a balance, and a directory edit is not a
     * transaction. If this ever fails, master data has started posting. */
    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM journal_entries
       WHERE organization_id = ${actor.organizationId} AND company_id = ${actor.companyId}
    `.execute(ctx.db);
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

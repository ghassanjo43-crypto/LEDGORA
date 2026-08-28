/**
 * The provisional-company lifecycle.
 *
 * ══ The invariant ════════════════════════════════════════════════════════════
 *
 *   One real set of books creates exactly one company row.
 *
 * An organization is born with one company, because accounting records are
 * company-scoped and a subscriber with nowhere to post is a broken subscriber.
 * The browser separately mints `co_lx8f2a…` for the same books. Those are two
 * names for one legal entity, and before adoption existed they produced two
 * rows — a Core subscriber holding two companies against a one-entity plan,
 * journals split across two ledgers depending on when they were posted, and a
 * migration-025 backfill made ambiguous by ordinary onboarding.
 *
 * ══ What these tests hold on to ══════════════════════════════════════════════
 *
 * The single most important assertion in this file is that the SERVER UUID does
 * not change across adoption. A subscriber can post before their browser ever
 * registers; if adoption minted a new id, those postings would be stranded in a
 * company nobody selects again. Identity is preserved and only the NAME moves.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import {
  authHeaders,
  createTestContext,
  login,
  seedUser,
  type SessionCookies,
  type TestContext,
} from './helpers/testApp.js';
import { createOrganization } from '../src/services/organizationService.js';
import {
  registerCompany,
  listCompanies,
  resolveCompany,
  provisionalReference,
} from '../src/services/companyService.js';
import type { AccountingActor } from '../src/services/accounting/audit.js';
import * as accounts from '../src/services/accounting/accountService.js';
import * as journals from '../src/services/accounting/journalService.js';

let ctx: TestContext;
let admin: SessionCookies;


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

/** A subscriber created through the platform console. */
async function consoleTenant(name: string, plan = 'core'): Promise<{ organizationId: string; ownerId: string }> {
  const created = await ctx.app.inject({
    method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(admin),
    payload: {
      fullName: `${name} Owner`, email: `owner@${name.toLowerCase()}.test`,
      organizationLegalName: `${name} Trading LLC`, country: 'JO', baseCurrency: 'JOD',
      planId: await planId(plan), onboarding: 'temporary', paymentConfirmed: true,
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const organizationId = created.json().subscriber.organizationId as string;
  const owner = await ctx.db.selectFrom('organization_memberships').select('user_id')
    .where('organization_id', '=', organizationId).where('role', '=', 'owner')
    .executeTakeFirstOrThrow();
  return { organizationId, ownerId: owner.user_id };
}

/** A subscriber who registered themselves. */
async function selfServiceTenant(name: string): Promise<{ organizationId: string; ownerId: string }> {
  const owner = await seedUser(ctx, { email: `${name.toLowerCase()}@self.test`, fullName: `${name} Owner` });
  const org = await createOrganization(ctx.db, owner.id, {
    legalName: `${name} Trading LLC`, country: 'JO', baseCurrency: 'JOD',
  });
  return { organizationId: org.id, ownerId: owner.id };
}

const register = (organizationId: string, actorUserId: string, reference: string, legalName: string) =>
  registerCompany(ctx.db, { organizationId, clientReference: reference, legalName, actorUserId });

/* ══ Birth: exactly one, and provisional ═══════════════════════════════════ */

describe('a new organization', () => {
  it('is born with exactly one PROVISIONAL company (self-service)', async () => {
    const { organizationId } = await selfServiceTenant('Acme');
    const companies = await listCompanies(ctx.db, organizationId);

    expect(companies).toHaveLength(1);
    expect(companies[0]!.adoptedAt).toBeNull();
    expect(companies[0]!.adoptedBy).toBeNull();
    expect(companies[0]!.clientReference).toBe(provisionalReference(organizationId));
    expect(companies[0]!.legalName).toBe('Acme Trading LLC');
  });

  it('is born with exactly one PROVISIONAL company (platform console)', async () => {
    const { organizationId } = await consoleTenant('Globex');
    const companies = await listCompanies(ctx.db, organizationId);

    expect(companies).toHaveLength(1);
    expect(companies[0]!.adoptedAt).toBeNull();
    expect(companies[0]!.clientReference).toBe(provisionalReference(organizationId));
  });

  it('cannot hold two provisional companies, by database constraint', async () => {
    const { organizationId } = await selfServiceTenant('Acme');
    /*
     * The invariant where it can actually be promised. A service rule holds only
     * for callers who go through it; a partial unique index holds for everyone.
     */
    await expect(sql`
      INSERT INTO companies (organization_id, client_reference, legal_name)
      VALUES (${organizationId}, 'provisional:second', 'Second Provisional')
    `.execute(ctx.db)).rejects.toThrow(/companies_one_provisional|duplicate key/i);
  });

  it('refuses a client that tries to claim the provisional reference by name', async () => {
    const { organizationId, ownerId } = await selfServiceTenant('Acme');
    /* The marker is the server's, not something a browser may send. */
    await expect(register(organizationId, ownerId, provisionalReference(organizationId), 'Acme Trading LLC'))
      .rejects.toThrow(/reserved/i);
  });
});

/* ══ Adoption ══════════════════════════════════════════════════════════════ */

describe('the first browser registration', () => {
  it('ADOPTS the provisional row, keeping the same server uuid', async () => {
    const { organizationId, ownerId } = await selfServiceTenant('Acme');
    const before = (await listCompanies(ctx.db, organizationId))[0]!;

    const result = await register(organizationId, ownerId, 'co_lx8f2a_9d4kz1', 'Acme Trading LLC');

    expect(result.adopted).toBe(true);
    expect(result.created).toBe(true);
    /*
     * THE assertion of this file. Accounts and journals may already point at
     * this id; a new one would strand every record posted before the browser
     * first synced.
     */
    expect(result.company.id).toBe(before.id);
    expect(result.company.clientReference).toBe('co_lx8f2a_9d4kz1');
    expect(result.company.adoptedAt).not.toBeNull();
    expect(result.company.adoptedBy).toBe(ownerId);
  });

  it('leaves the organization with exactly one company', async () => {
    const { organizationId, ownerId } = await selfServiceTenant('Acme');
    await register(organizationId, ownerId, 'co_lx8f2a', 'Acme Trading LLC');
    expect(await listCompanies(ctx.db, organizationId)).toHaveLength(1);
  });

  it('reconciles the legal name during adoption — identity completion, not a rename', async () => {
    const { organizationId, ownerId } = await selfServiceTenant('Acme');
    const result = await register(organizationId, ownerId, 'co_lx8f2a', 'Acme Trading & Logistics LLC');

    expect(result.company.legalName).toBe('Acme Trading & Logistics LLC');
    expect(await listCompanies(ctx.db, organizationId)).toHaveLength(1);
  });

  it('records both names in the audit when adoption changed it', async () => {
    const { organizationId, ownerId } = await selfServiceTenant('Acme');
    await register(organizationId, ownerId, 'co_lx8f2a', 'Acme Trading & Logistics LLC');

    const row = await ctx.db.selectFrom('audit_logs').selectAll()
      .where('organization_id', '=', organizationId)
      .where('action', '=', 'company.adopted')
      .executeTakeFirstOrThrow();

    /* The provisional name is otherwise gone, and "what were these called
     * before anyone claimed them" is exactly what an audit answers. */
    expect(JSON.stringify(row.metadata)).toMatch(/Acme Trading LLC/);
    expect(JSON.stringify(row.metadata)).toMatch(/Acme Trading & Logistics LLC/);
  });

  it('is idempotent on replay', async () => {
    const { organizationId, ownerId } = await selfServiceTenant('Acme');
    const first = await register(organizationId, ownerId, 'co_lx8f2a', 'Acme Trading LLC');
    const replay = await register(organizationId, ownerId, 'co_lx8f2a', 'Acme Trading LLC');

    expect(first.adopted).toBe(true);
    expect(replay.adopted).toBe(false);
    expect(replay.created).toBe(false);
    expect(replay.company.id).toBe(first.company.id);
    expect(await listCompanies(ctx.db, organizationId)).toHaveLength(1);
  });

  it('refuses a conflicting legal name AFTER adoption', async () => {
    const { organizationId, ownerId } = await selfServiceTenant('Acme');
    await register(organizationId, ownerId, 'co_lx8f2a', 'Acme Trading LLC');

    /* Reconciliation is a one-time act. Once claimed, a different name is a
     * disagreement about what these books are, not a rename. */
    await expect(register(organizationId, ownerId, 'co_lx8f2a', 'Acme Holdings LLC'))
      .rejects.toThrow(/already registered as/i);

    const [only] = await listCompanies(ctx.db, organizationId);
    expect(only!.legalName).toBe('Acme Trading LLC');
  });

  it('cannot rename a DIFFERENT already-adopted company', async () => {
    const { organizationId, ownerId } = await consoleTenant('Multi', 'projects');
    const adopted = await register(organizationId, ownerId, 'co_first', 'First Books LLC');
    const second = await register(organizationId, ownerId, 'co_second', 'Second Books LLC');

    expect(second.adopted).toBe(false);
    expect(second.company.id).not.toBe(adopted.company.id);
    /* The first company's name is untouched by the second registration. */
    const first = (await listCompanies(ctx.db, organizationId)).find((c) => c.clientReference === 'co_first');
    expect(first!.legalName).toBe('First Books LLC');
  });
});

/* ══ Concurrency ═══════════════════════════════════════════════════════════ */

describe('two simultaneous first registrations', () => {
  it('adopt once and never create a duplicate', async () => {
    const { organizationId, ownerId } = await selfServiceTenant('Acme');
    const provisionalId = (await listCompanies(ctx.db, organizationId))[0]!.id;

    /*
     * The same browser, twice — a double-clicked button, or two tabs. Both
     * requests see a provisional row before either commits; the advisory lock
     * serialises them and the `adopted_at IS NULL` guard means the loser
     * updates nothing.
     */
    const [a, b] = await Promise.all([
      register(organizationId, ownerId, 'co_race', 'Acme Trading LLC'),
      register(organizationId, ownerId, 'co_race', 'Acme Trading LLC'),
    ]);

    expect(a.company.id).toBe(provisionalId);
    expect(b.company.id).toBe(provisionalId);
    /* Exactly one of them performed the adoption. */
    expect([a.adopted, b.adopted].filter(Boolean)).toHaveLength(1);
    expect(await listCompanies(ctx.db, organizationId)).toHaveLength(1);
  });

  it('do not create two companies when the references differ', async () => {
    const { organizationId, ownerId } = await consoleTenant('Acme');

    /*
     * Two DIFFERENT browsers racing to claim the same provisional books. One
     * adopts; the other is an additional company and meets the plan allowance —
     * Core covers one entity, so it is refused rather than silently added.
     */
    const results = await Promise.allSettled([
      register(organizationId, ownerId, 'co_browser_a', 'Acme Trading LLC'),
      register(organizationId, ownerId, 'co_browser_b', 'Acme Trading LLC'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(await listCompanies(ctx.db, organizationId)).toHaveLength(1);
  });
});

/* ══ Accounting continuity ═════════════════════════════════════════════════ */

describe('accounting written before adoption', () => {
  it('is still there afterwards, reachable through the new reference', async () => {
    const { organizationId, ownerId } = await selfServiceTenant('Acme');
    const provisional = (await listCompanies(ctx.db, organizationId))[0]!;

    /*
     * Books posted while the company was still provisional — which is exactly
     * what happens between a subscriber signing up and their browser first
     * syncing.
     */
    const actor: AccountingActor = {
      organizationId, companyId: provisional.id, userId: ownerId, name: 'Acme Owner',
    };
    const cash = await accounts.createAccount(ctx.db, actor, {
      accountCode: '1000', accountName: 'Cash', accountType: 'asset',
    });
    const sales = await accounts.createAccount(ctx.db, actor, {
      accountCode: '4000', accountName: 'Sales', accountType: 'income',
    });
    const draft = await journals.createDraft(ctx.db, actor, {
      transactionDate: '2026-08-01',
      description: 'Before adoption',
      lines: [{ accountId: cash.id, debit: '100.000' }, { accountId: sales.id, credit: '100.000' }],
    });
    const posted = await journals.postJournal(ctx.db, actor, draft.id, { expectedVersion: draft.version });

    await register(organizationId, ownerId, 'co_lx8f2a', 'Acme Trading LLC');

    /* The browser's reference now resolves to the SAME books. */
    const resolved = await resolveCompany(ctx.db, organizationId, 'co_lx8f2a');
    expect(resolved.id).toBe(provisional.id);

    const after: AccountingActor = { ...actor, companyId: resolved.id };
    expect(await journals.getJournal(ctx.db, after, posted.id)).toMatchObject({ status: 'posted' });
    expect(await accounts.listAccounts(ctx.db, after)).toHaveLength(2);
  });

  it('resolves the sole provisional company when no selector is sent', async () => {
    const { organizationId } = await selfServiceTenant('Acme');
    const provisional = (await listCompanies(ctx.db, organizationId))[0]!;

    const resolved = await resolveCompany(ctx.db, organizationId, null);
    expect(resolved.id).toBe(provisional.id);
  });

  it('does not create anything for an unknown reference before adoption', async () => {
    const { organizationId } = await selfServiceTenant('Acme');

    /* A header naming books the server has never heard of is answered, not
     * acted upon: resolution never writes. */
    await expect(resolveCompany(ctx.db, organizationId, 'co_never_registered'))
      .rejects.toMatchObject({ failure: 'not_found' });
    expect(await listCompanies(ctx.db, organizationId)).toHaveLength(1);
  });

  it('keeps another tenant’s reference not-found', async () => {
    const acme = await selfServiceTenant('Acme');
    const globex = await selfServiceTenant('Globex');
    await register(globex.organizationId, globex.ownerId, 'co_globex', 'Globex Trading LLC');

    await expect(resolveCompany(ctx.db, acme.organizationId, 'co_globex'))
      .rejects.toMatchObject({ failure: 'not_found' });
  });
});

/* ══ The plan allowance ════════════════════════════════════════════════════ */

describe('the company allowance', () => {
  it('lets a Core subscriber complete ordinary onboarding with ONE company', async () => {
    const { organizationId, ownerId } = await consoleTenant('Core', 'core');
    await register(organizationId, ownerId, 'co_core', 'Core Trading LLC');

    /* The defect this whole change fixes: a one-entity plan holding two rows. */
    expect(await listCompanies(ctx.db, organizationId)).toHaveLength(1);
  });

  it('refuses a Core subscriber a SECOND company rather than exceeding the plan', async () => {
    const { organizationId, ownerId } = await consoleTenant('Core', 'core');
    await register(organizationId, ownerId, 'co_first', 'Core Trading LLC');

    await expect(register(organizationId, ownerId, 'co_second', 'Core Logistics LLC'))
      .rejects.toThrow(/covers 1 company|Upgrade the plan/i);
    expect(await listCompanies(ctx.db, organizationId)).toHaveLength(1);
  });

  it('lets a larger plan add a second company', async () => {
    /* `projects` covers two entities; `core` covers one. See migration 014. */
    const { organizationId, ownerId } = await consoleTenant('Pro', 'projects');
    await register(organizationId, ownerId, 'co_first', 'Pro Trading LLC');
    const second = await register(organizationId, ownerId, 'co_second', 'Pro Logistics LLC');

    expect(second.created).toBe(true);
    expect(second.adopted).toBe(false);
    expect(await listCompanies(ctx.db, organizationId)).toHaveLength(2);
  });
});

/* ══ Migration 025 stays unambiguous ═══════════════════════════════════════ */

describe('after ordinary onboarding', () => {
  it('leaves migration 025’s backfill with exactly one candidate company', async () => {
    const { organizationId, ownerId } = await consoleTenant('Acme');
    await register(organizationId, ownerId, 'co_acme', 'Acme Trading LLC');

    /*
     * 025 refuses when an organization with books has several companies. Before
     * adoption existed, ordinary onboarding produced exactly that state — the
     * migration would have halted on a tenant that had done nothing unusual.
     */
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM companies WHERE organization_id = ${organizationId}
    `.execute(ctx.db);
    expect(rows[0]!.n).toBe(1);
  });
});

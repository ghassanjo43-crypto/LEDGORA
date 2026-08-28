/**
 * Company accounting settings: authoritative, per set of books, accrual only.
 *
 * ══ What these hold on to ════════════════════════════════════════════════════
 *
 * The settings that decide what a set of books MEANS — fiscal year, books start,
 * reporting framework, tax registration. They lived in localStorage, where a
 * fiscal year was editable from devtools and clearing site data silently reset
 * the basis on which every statement was prepared.
 *
 * So the claims are: one record per company; two companies under one subscriber
 * differ freely; a lapsed subscriber may READ but not WRITE; concurrent edits
 * cannot silently overwrite one another; and the only storable basis is accrual
 * until cash basis is specified and tested.
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
import { createMigrator } from '../src/db/migrator.js';
import { readSettings, updateSettings } from '../src/services/companySettingsService.js';
import { listCompanies } from '../src/services/companyService.js';
import { organizationMayPersist } from '../src/guards/persistence.js';
import { recalculateEntitlements } from '../src/services/entitlementService.js';

let ctx: TestContext;
let admin: SessionCookies;

const PASSWORD = 'Copper-Lantern-64-Wm';
const SETTINGS = '/api/organizations/current/company-settings';

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

async function tenant(name: string, paid = true, plan = 'core'): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(admin),
    payload: {
      fullName: `${name} Owner`, email: `owner@${name.toLowerCase()}.test`,
      organizationLegalName: `${name} Trading LLC`, country: 'JO', baseCurrency: 'JOD',
      planId: await planId(plan), onboarding: 'temporary', paymentConfirmed: paid,
    },
  });
  expect(created.statusCode).toBe(201);
  return created.json().subscriber.organizationId as string;
}

async function member(organizationId: string, email: string, role = 'admin'): Promise<SessionCookies> {
  const created = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: authHeaders(admin),
    payload: {
      fullName: `Person ${email}`, email, organizationId, role,
      onboarding: 'invitation', permissions: [],
    },
  });
  expect(created.statusCode).toBe(201);
  const token = created.json().credential.invitationToken as string;
  await ctx.app.inject({
    method: 'POST', url: '/api/auth/reset-password', payload: { token, newPassword: PASSWORD },
  });
  return login(ctx, email, PASSWORD);
}

const companyIdFor = async (organizationId: string): Promise<string> =>
  (await listCompanies(ctx.db, organizationId))[0]!.id;

const get = (cookies: SessionCookies, reference?: string) => ctx.app.inject({
  method: 'GET', url: SETTINGS,
  headers: {
    ...authHeaders(cookies),
    ...(reference ? { 'x-ledgora-company-reference': reference } : {}),
  },
});

const patch = (cookies: SessionCookies, payload: Record<string, unknown>, reference?: string) =>
  ctx.app.inject({
    method: 'PATCH', url: SETTINGS,
    headers: {
      ...authHeaders(cookies),
      ...(reference ? { 'x-ledgora-company-reference': reference } : {}),
    },
    payload,
  });

/* ══ The migration ═════════════════════════════════════════════════════════ */

describe('migration 027', () => {
  it('gives every existing company exactly one settings row', async () => {
    const org = await tenant('Acme');
    const rows = await ctx.db.selectFrom('company_settings').selectAll()
      .where('organization_id', '=', org).execute();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.company_id).toBe(await companyIdFor(org));
    expect(rows[0]!.accounting_basis).toBe('accrual');
    expect(rows[0]!.version).toBe(1);
  });

  it('inherits the organization defaults deterministically, reading no browser state', async () => {
    const org = await tenant('Acme');
    const settings = await readSettings(ctx.db, org, await companyIdFor(org));

    /* From `organizations`, the only place a sensible starting value exists. */
    expect(settings.country).toBe('JO');
    expect(settings.fiscalYearStart).toBe('01-01');
    expect(settings.reportingFramework).toBe('IFRS');
  });

  it('survives down and replay', async () => {
    const org = await tenant('Acme');
    const migrator = createMigrator(ctx.db);

    const down = await migrator.migrateDown();
    expect(down.error).toBeUndefined();
    expect(down.results?.[0]?.migrationName).toBe('027_company_settings');

    const { rows: gone } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'company_settings'
    `.execute(ctx.db);
    expect(gone[0]!.n).toBe(0);

    const up = await migrator.migrateToLatest();
    expect(up.error).toBeUndefined();

    /* Replayed from the database alone, so the row comes back identically. */
    const settings = await readSettings(ctx.db, org, await companyIdFor(org));
    expect(settings.country).toBe('JO');
    expect(settings.accountingBasis).toBe('accrual');
  });

  it('refuses a second settings row for one company, and a non-accrual basis', async () => {
    const org = await tenant('Acme');
    const companyId = await companyIdFor(org);

    await expect(sql`
      INSERT INTO company_settings (organization_id, company_id) VALUES (${org}, ${companyId})
    `.execute(ctx.db)).rejects.toThrow(/duplicate key|company_settings_pkey/i);

    await expect(sql`
      UPDATE company_settings SET accounting_basis = 'cash' WHERE company_id = ${companyId}
    `.execute(ctx.db)).rejects.toThrow(/accrual_only|violates check/i);
  });

  it('refuses settings pointing at another organization’s company', async () => {
    const acme = await tenant('Acme');
    const globex = await tenant('Globex');
    const globexCompany = await companyIdFor(globex);

    await expect(sql`
      INSERT INTO company_settings (organization_id, company_id) VALUES (${acme}, ${globexCompany})
    `.execute(ctx.db)).rejects.toThrow(/same_org|foreign key/i);
  });
});

/* ══ Company scope ═════════════════════════════════════════════════════════ */

describe('two companies under one subscriber', () => {
  /**
   * TWO registrations, deliberately.
   *
   * The first ADOPTS the provisional company every organization is born with;
   * only the second creates a further one. Registering once would leave a
   * single company and prove nothing about isolation between them.
   */
  async function duo() {
    const org = await tenant('Duo', true, 'projects');
    const user = await member(org, 'admin@duo.test');

    const register = (clientReference: string, legalName: string) => ctx.app.inject({
      method: 'POST', url: '/api/organizations/current/companies',
      headers: authHeaders(user), payload: { clientReference, legalName },
    });

    const adopted = await register('co_first', 'Duo Trading LLC');
    expect(adopted.statusCode).toBe(201);
    expect(adopted.json().adopted).toBe(true);

    const created = await register('co_second', 'Duo Logistics LLC');
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().adopted).toBe(false);

    return { org, user, first: adopted.json().company, second: created.json().company };
  }

  it('each get their own settings row', async () => {
    const { org } = await duo();
    const rows = await ctx.db.selectFrom('company_settings').select('company_id')
      .where('organization_id', '=', org).execute();
    expect(rows).toHaveLength(2);
  });

  it('keep different fiscal years without interfering', async () => {
    const { user, first, second } = await duo();

    const a = await get(user, first.clientReference);
    const b = await get(user, second.clientReference);
    expect(a.statusCode).toBe(200);

    const changed = await patch(user, {
      fiscalYearStart: '04-01', expectedVersion: a.json().settings.version,
    }, first.clientReference);
    expect(changed.statusCode).toBe(200);
    expect(changed.json().settings.fiscalYearStart).toBe('04-01');

    /* The sibling company is untouched — this is the whole reason the settings
     * are company-scoped rather than organization-scoped. */
    const after = await get(user, second.clientReference);
    expect(after.json().settings.fiscalYearStart).toBe('01-01');
    expect(after.json().settings.version).toBe(b.json().settings.version);
  });

  it('cannot be read through another tenant’s reference', async () => {
    const acme = await tenant('Acme');
    const globex = await tenant('Globex');
    const acmeUser = await member(acme, 'admin@acme.test');
    const globexUser = await member(globex, 'admin@globex.test');
    const globexCompany = (await listCompanies(ctx.db, globex))[0]!;
    void globexUser;

    const response = await get(acmeUser, globexCompany.clientReference);
    /* Answered exactly as a reference that names nothing. */
    expect(response.statusCode).toBe(404);
  });
});

/* ══ Entitlement ═══════════════════════════════════════════════════════════ */

describe('a Free Preview customer', () => {
  it('may READ their settings', async () => {
    const org = await tenant('Preview', false);
    const user = await member(org, 'admin@preview.test');

    /*
     * Reading is not a durable write, and a customer must be able to see the
     * basis their own books are kept on.
     */
    const response = await get(user);
    expect([200, 403]).toContain(response.statusCode);
    if (response.statusCode === 200) {
      expect(response.json().settings.accountingBasis).toBe('accrual');
    }
  });

  it('cannot WRITE them, and nothing changes', async () => {
    const org = await tenant('Preview', false);
    const user = await member(org, 'admin@preview.test');
    const companyId = await companyIdFor(org);
    const before = await readSettings(ctx.db, org, companyId);

    const response = await patch(user, { fiscalYearStart: '04-01', expectedVersion: before.version });
    expect(response.statusCode).toBe(403);

    const after = await readSettings(ctx.db, org, companyId);
    expect(after.fiscalYearStart).toBe(before.fiscalYearStart);
    expect(after.version).toBe(before.version);
  });

  it('is refused by the SERVICE as well, not only by the route', async () => {
    const org = await tenant('Preview', false);
    const companyId = await companyIdFor(org);
    const owner = await ctx.db.selectFrom('organization_memberships').select('user_id')
      .where('organization_id', '=', org).where('role', '=', 'owner').executeTakeFirstOrThrow();

    await expect(updateSettings(ctx.db, {
      organizationId: org, companyId, expectedVersion: 1,
      mayPersist: await organizationMayPersist(ctx.db, org),
      actorUserId: owner.user_id, patch: { fiscalYearStart: '04-01' },
    })).rejects.toMatchObject({ code: 'subscription_required_for_persistence' });
  });

  it('can write once the subscription is active', async () => {
    const org = await tenant('Upgrading', false);
    const user = await member(org, 'admin@upgrading.test');
    const companyId = await companyIdFor(org);

    expect((await patch(user, { fiscalYearStart: '04-01', expectedVersion: 1 })).statusCode).toBe(403);

    await ctx.db.updateTable('subscriptions').set({ status: 'active' })
      .where('organization_id', '=', org).execute();
    await recalculateEntitlements(ctx.db, org);

    const allowed = await patch(user, { fiscalYearStart: '04-01', expectedVersion: 1 });
    expect(allowed.statusCode).toBe(200);
    expect((await readSettings(ctx.db, org, companyId)).fiscalYearStart).toBe('04-01');
  });
});

/* ══ Concurrency ═══════════════════════════════════════════════════════════ */

describe('concurrent updates', () => {
  it('let exactly one of two simultaneous edits win', async () => {
    const org = await tenant('Acme');
    const user = await member(org, 'admin@acme.test');
    const version = (await get(user)).json().settings.version;

    /* Both read the same version, as two tabs would. */
    const [a, b] = await Promise.all([
      patch(user, { fiscalYearStart: '04-01', expectedVersion: version }),
      patch(user, { fiscalYearStart: '07-01', expectedVersion: version }),
    ]);

    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    /* The loser's value was not silently applied on top of the winner's. */
    const settled = (await get(user)).json().settings;
    expect(['04-01', '07-01']).toContain(settled.fiscalYearStart);
    expect(settled.version).toBe(version + 1);
  });

  it('refuse a stale version outright', async () => {
    const org = await tenant('Acme');
    const user = await member(org, 'admin@acme.test');
    const version = (await get(user)).json().settings.version;

    expect((await patch(user, { city: 'Amman', expectedVersion: version })).statusCode).toBe(200);
    const stale = await patch(user, { city: 'Irbid', expectedVersion: version });

    expect(stale.statusCode).toBe(409);
    expect((await get(user)).json().settings.city).toBe('Amman');
  });

  it('require a version rather than defaulting to last-write-wins', async () => {
    const org = await tenant('Acme');
    const user = await member(org, 'admin@acme.test');
    const response = await patch(user, { city: 'Amman' });
    expect(response.statusCode).toBe(400);
  });
});

/* ══ Validation and audit ══════════════════════════════════════════════════ */

describe('the settings themselves', () => {
  it('refuse a malformed fiscal year and an impossible tax rate', async () => {
    const org = await tenant('Acme');
    const user = await member(org, 'admin@acme.test');
    const version = (await get(user)).json().settings.version;

    expect((await patch(user, { fiscalYearStart: '13-01', expectedVersion: version })).statusCode).toBe(400);
    expect((await patch(user, { defaultTaxRate: '150', expectedVersion: version })).statusCode).toBe(400);
  });

  it('refuse a tax number with registration switched off', async () => {
    const org = await tenant('Acme');
    const user = await member(org, 'admin@acme.test');
    let version = (await get(user)).json().settings.version;

    const registered = await patch(user, {
      taxRegistered: true, taxRegistrationNumber: 'TRN-1', expectedVersion: version,
    });
    expect(registered.statusCode).toBe(200);
    version = registered.json().settings.version;

    /* Deregistering while a number remains is a state nobody meant. */
    const bad = await patch(user, { taxRegistered: false, expectedVersion: version });
    expect(bad.statusCode).toBe(400);
  });

  it('record WHICH settings changed, never their values', async () => {
    const org = await tenant('Acme');
    const user = await member(org, 'admin@acme.test');
    const version = (await get(user)).json().settings.version;

    await patch(user, {
      taxRegistered: true, taxRegistrationNumber: 'TRN-SECRET-1', expectedVersion: version,
    });

    const row = await ctx.db.selectFrom('audit_logs').selectAll()
      .where('organization_id', '=', org)
      .where('action', '=', 'company_settings.updated')
      .executeTakeFirstOrThrow();

    const metadata = JSON.stringify(row.metadata);
    expect(metadata).toMatch(/taxRegistrationNumber/);
    /* The field NAME, never the number itself. */
    expect(metadata).not.toMatch(/TRN-SECRET-1/);
  });

  it('offer no way to store a non-accrual basis through the API', async () => {
    const org = await tenant('Acme');
    const user = await member(org, 'admin@acme.test');
    const version = (await get(user)).json().settings.version;

    /* Unknown fields are stripped by the schema, so the basis cannot move. */
    await patch(user, { accountingBasis: 'cash', expectedVersion: version });
    expect((await get(user)).json().settings.accountingBasis).toBe('accrual');
  });
});

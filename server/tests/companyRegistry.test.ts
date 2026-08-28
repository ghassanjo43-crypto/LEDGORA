/**
 * Phase 1 — the authoritative company registry and the request selector.
 *
 * ══ The claim under test ═════════════════════════════════════════════════════
 *
 * A company reference from the browser is a SELECTOR, not authorization. Every
 * test here is a variation on that one sentence:
 *
 *   registration   is idempotent on (organization, reference), and a
 *                  conflicting legal name is refused rather than applied;
 *   isolation      another tenant's reference is answered exactly as a
 *                  reference that names nothing — the response cannot be used
 *                  to discover that somebody else's books exist;
 *   resolution     an omitted selector resolves only when there is nothing to
 *                  be ambiguous about, and is refused otherwise rather than
 *                  guessed;
 *   immutability   the bookkeeping language is chosen once, and the DATABASE
 *                  is what makes that true — not the service in front of it.
 *
 * The last one is tested by going around the service entirely. A rule that only
 * holds for callers who came through the right function is not the guarantee
 * migration 022 was written to make.
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
import { organizationMayPersist } from '../src/guards/persistence.js';
import {
  registerCompany,
  resolveCompany,
  lockBookkeepingLanguage,
  listCompanies,
  CompanyResolutionError,
} from '../src/services/companyService.js';

let ctx: TestContext;
let admin: SessionCookies;

beforeEach(async () => {
  ctx = await createTestContext();
  await seedUser(ctx, {
    email: 'super@ledgora.test',
    fullName: 'Platform Super Admin',
    platformRoles: ['super_admin'],
  });
  admin = await login(ctx, 'super@ledgora.test');
});
afterEach(async () => {
  await ctx.close();
});

async function planId(code = 'core'): Promise<string> {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
  return response.json().plans.find((p: { code: string }) => p.code === code).id;
}

/** A paid subscriber tenant, with its owner's id. */
async function tenant(name: string, plan = 'core'): Promise<{ organizationId: string; ownerId: string }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/subscribers',
    headers: authHeaders(admin),
    payload: {
      fullName: `${name} Owner`,
      email: `owner@${name.toLowerCase()}.test`,
      organizationLegalName: `${name} Trading LLC`,
      country: 'JO',
      baseCurrency: 'JOD',
      planId: await planId(plan),
      onboarding: 'temporary',
      paymentConfirmed: true,
    },
  });
  expect(created.statusCode).toBe(201);
  const organizationId = created.json().subscriber.organizationId as string;
  const owner = await ctx.db
    .selectFrom('organization_memberships')
    .select('user_id')
    .where('organization_id', '=', organizationId)
    .where('role', '=', 'owner')
    .executeTakeFirstOrThrow();
  return { organizationId, ownerId: owner.user_id };
}

/**
 * Register through the REAL entitlement rule.
 *
 * `mayCreatePermanentCompany` is resolved the way the route resolves it —
 * from the organization's own subscription row — rather than hardcoded true.
 * Passing a literal would test a code path no request can produce, and would
 * keep passing if the rule were removed.
 */
const register = async (organizationId: string, ownerId: string, reference: string, legalName: string) =>
  registerCompany(ctx.db, {
    organizationId,
    clientReference: reference,
    legalName,
    actorUserId: ownerId,
    mayCreatePermanentCompany: await organizationMayPersist(ctx.db, organizationId),
  });

/* ══ Registration and adoption ═════════════════════════════════════════════ */

describe('registering a company', () => {
  it('adopts a browser company under a server-generated uuid', async () => {
    const { organizationId, ownerId } = await tenant('Acme');
    const { company, created } = await register(organizationId, ownerId, 'co_lx8f2a_9d4kz1', 'Acme Trading LLC');

    expect(created).toBe(true);
    /* A real uuid, not the browser's `co_...` reference reused as a key. */
    expect(company.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(company.id).not.toBe(company.clientReference);
    /* The browser's own identifier survives, so its existing books still match. */
    expect(company.clientReference).toBe('co_lx8f2a_9d4kz1');
    expect(company.organizationId).toBe(organizationId);
    /* Nobody chose a language, so there is none. A default would be a decision. */
    expect(company.bookkeepingLanguage).toBeNull();
    expect(company.languageLockedAt).toBeNull();
  });

  it('is idempotent: a retry returns the same company and does not mint a second', async () => {
    const { organizationId, ownerId } = await tenant('Acme');
    const first = await register(organizationId, ownerId, 'co_dup', 'Acme Trading LLC');
    const second = await register(organizationId, ownerId, 'co_dup', 'Acme Trading LLC');

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.company.id).toBe(first.company.id);
    expect(await listCompanies(ctx.db, organizationId)).toHaveLength(1);
  });

  it('refuses a conflicting legal name instead of silently renaming', async () => {
    const { organizationId, ownerId } = await tenant('Acme');
    await register(organizationId, ownerId, 'co_dup', 'Acme Trading LLC');

    await expect(register(organizationId, ownerId, 'co_dup', 'Acme Holdings LLC'))
      .rejects.toThrow(/already registered as/i);

    /*
     * The name on file is untouched. A registration retry that renamed the
     * company would rewrite the identity of books that already have journals
     * posted under it.
     */
    const [only] = await listCompanies(ctx.db, organizationId);
    expect(only!.legalName).toBe('Acme Trading LLC');
  });

  it('writes one audit row for the adoption, and none for a replay', async () => {
    const { organizationId, ownerId } = await tenant('Acme');
    await register(organizationId, ownerId, 'co_audit', 'Acme Trading LLC');
    await register(organizationId, ownerId, 'co_audit', 'Acme Trading LLC');

    /*
     * `company.adopted`, not `company.registered`: the organization was already
     * born with its provisional books, so the first client registration CLAIMS
     * that row rather than bringing a new set into existence. The two are
     * separate actions precisely so the trail says which happened.
     */
    const rows = await ctx.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('action', 'in', ['company.registered', 'company.adopted'])
      .execute();

    /* One act, one row. A trail that records non-events is one nobody can read. */
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('company.adopted');
    expect(rows[0]!.actor_user_id).toBe(ownerId);
  });

  it('rejects an empty or over-long reference before touching the database', async () => {
    const { organizationId, ownerId } = await tenant('Acme');
    await expect(register(organizationId, ownerId, '   ', 'Acme')).rejects.toThrow(/reference is required/i);
    await expect(register(organizationId, ownerId, 'c'.repeat(129), 'Acme')).rejects.toThrow(/too long/i);
    await expect(register(organizationId, ownerId, 'co_x', '  ')).rejects.toThrow(/legal name is required/i);

    /*
     * Nothing was written. Measured as "the provisional books are untouched"
     * rather than "no rows", because every organization is born with one — and
     * an unadopted row is the proof that no rejected call slipped through and
     * claimed it.
     */
    const companies = await listCompanies(ctx.db, organizationId);
    expect(companies).toHaveLength(1);
    expect(companies[0]!.adoptedAt).toBeNull();
  });
});

/* ══ Two organizations, similar companies ══════════════════════════════════ */

describe('two organizations with similarly named companies', () => {
  it('keeps identical references and names entirely separate', async () => {
    const acme = await tenant('Acme');
    const globex = await tenant('Globex');

    /* Deliberately identical on BOTH fields — the worst case for a mix-up. */
    const a = await register(acme.organizationId, acme.ownerId, 'co_shared', 'Northern Trading LLC');
    const b = await register(globex.organizationId, globex.ownerId, 'co_shared', 'Northern Trading LLC');

    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.company.id).not.toBe(b.company.id);

    /* Each organization sees exactly its own. */
    expect(await listCompanies(ctx.db, acme.organizationId)).toHaveLength(1);
    expect((await listCompanies(ctx.db, globex.organizationId))[0]!.id).toBe(b.company.id);
  });

  it('answers another tenant’s reference exactly as an unknown one', async () => {
    const acme = await tenant('Acme');
    const globex = await tenant('Globex');
    await register(globex.organizationId, globex.ownerId, 'co_globex_only', 'Globex Trading LLC');
    await register(acme.organizationId, acme.ownerId, 'co_acme', 'Acme Trading LLC');

    /*
     * Two lookups from Acme: one for a reference that exists but belongs to
     * Globex, one for a reference that has never existed anywhere. If these
     * answers differed, the endpoint would be an oracle for enumerating other
     * customers' companies.
     */
    const foreign = await resolveCompany(ctx.db, acme.organizationId, 'co_globex_only')
      .then(() => null, (e: CompanyResolutionError) => e);
    const fictional = await resolveCompany(ctx.db, acme.organizationId, 'co_never_existed')
      .then(() => null, (e: CompanyResolutionError) => e);

    expect(foreign).toBeInstanceOf(CompanyResolutionError);
    expect(fictional).toBeInstanceOf(CompanyResolutionError);
    expect(foreign!.failure).toBe('not_found');
    expect(fictional!.failure).toBe('not_found');
    expect(foreign!.message).toBe(fictional!.message);
  });

  it('does not accept a server company uuid as a selector', async () => {
    const acme = await tenant('Acme');
    const { company } = await register(acme.organizationId, acme.ownerId, 'co_acme', 'Acme Trading LLC');

    /*
     * The caller's OWN company, named by its server key. Still refused: the key
     * is an internal identifier, and honouring it here would make it behave
     * like a credential that appears in every accounting foreign key.
     */
    await expect(resolveCompany(ctx.db, acme.organizationId, company.id))
      .rejects.toMatchObject({ failure: 'not_found' });
  });
});

/* ══ Resolution when the selector is omitted ═══════════════════════════════ */

describe('an omitted company selector', () => {
  it('resolves when the organization keeps exactly one set of books', async () => {
    const { organizationId, ownerId } = await tenant('Acme');
    const { company } = await register(organizationId, ownerId, 'co_only', 'Acme Trading LLC');

    const resolved = await resolveCompany(ctx.db, organizationId, null);
    expect(resolved.id).toBe(company.id);
  });

  it('resolves the sole PROVISIONAL company, so a new tenant can post at once', async () => {
    const { organizationId } = await tenant('Acme');
    const provisional = (await listCompanies(ctx.db, organizationId))[0]!;

    /*
     * Deliberate: a subscriber whose browser has not yet registered still has
     * exactly one set of books, and there is nothing to be ambiguous about.
     * Refusing here would mean a newly created tenant could not post anything
     * until their browser happened to sync.
     */
    const resolved = await resolveCompany(ctx.db, organizationId, null);
    expect(resolved.id).toBe(provisional.id);
    expect(resolved.adoptedAt).toBeNull();
  });

  it('refuses when the organization truly keeps no books', async () => {
    const { organizationId } = await tenant('Acme');
    /* The provisional row removed, which is the only way to reach this state. */
    await ctx.db.deleteFrom('companies').where('organization_id', '=', organizationId).execute();

    await expect(resolveCompany(ctx.db, organizationId, null))
      .rejects.toMatchObject({ failure: 'none_registered' });
  });

  it('refuses as ambiguous when several exist, rather than choosing one', async () => {
    /* `projects` covers two entities; `core` covers one and would refuse the
     * second registration before ambiguity could arise. See migration 014. */
    const { organizationId, ownerId } = await tenant('Acme', 'projects');
    await register(organizationId, ownerId, 'co_first', 'Acme Trading LLC');
    await register(organizationId, ownerId, 'co_second', 'Acme Logistics LLC');

    /*
     * The important refusal. Picking "the first" or "the most recent" would
     * post real journals into the wrong company's books — a mistake nobody sees
     * until reconciliation, caused by a choice the user never made.
     */
    await expect(resolveCompany(ctx.db, organizationId, null))
      .rejects.toMatchObject({ failure: 'ambiguous' });
  });

  it('treats whitespace as omission rather than as a reference', async () => {
    const { organizationId, ownerId } = await tenant('Acme');
    await register(organizationId, ownerId, 'co_only', 'Acme Trading LLC');
    const resolved = await resolveCompany(ctx.db, organizationId, '   ');
    expect(resolved.clientReference).toBe('co_only');
  });
});

/* ══ The bookkeeping language ══════════════════════════════════════════════ */

describe('the bookkeeping language', () => {
  async function companyFor(name: string) {
    const { organizationId, ownerId } = await tenant(name);
    const { company } = await register(organizationId, ownerId, `co_${name.toLowerCase()}`, `${name} Trading LLC`);
    return { organizationId, ownerId, companyId: company.id };
  }

  it('is chosen once, with the server’s timestamp and the choosing user', async () => {
    const { organizationId, ownerId, companyId } = await companyFor('Acme');
    const locked = await lockBookkeepingLanguage(ctx.db, {
      organizationId, companyId, language: 'ar', actorUserId: ownerId, actorName: 'Acme Owner',
    });

    expect(locked.bookkeepingLanguage).toBe('ar');
    expect(locked.languageLockedAt).not.toBeNull();
    expect(locked.languageSelectedBy).toBe(ownerId);
  });

  it('refuses a second choice through the service', async () => {
    const { organizationId, ownerId, companyId } = await companyFor('Acme');
    await lockBookkeepingLanguage(ctx.db, {
      organizationId, companyId, language: 'en', actorUserId: ownerId, actorName: 'Acme Owner',
    });

    await expect(lockBookkeepingLanguage(ctx.db, {
      organizationId, companyId, language: 'ar', actorUserId: ownerId, actorName: 'Acme Owner',
    })).rejects.toThrow(/chosen once and cannot be changed/i);
  });

  it('is enforced by the DATABASE, not merely by the service', async () => {
    const { organizationId, ownerId, companyId } = await companyFor('Acme');
    await lockBookkeepingLanguage(ctx.db, {
      organizationId, companyId, language: 'en', actorUserId: ownerId, actorName: 'Acme Owner',
    });

    /*
     * Around the service entirely — a direct UPDATE, as a determined operator or
     * a future bug would issue. The trigger from migration 022 is what makes
     * "no role can change this" true; a service check alone could not.
     */
    await expect(
      sql`UPDATE companies SET bookkeeping_language = 'ar' WHERE id = ${companyId}`.execute(ctx.db),
    ).rejects.toThrow(/cannot be changed/i);

    /* And unlocking, which would otherwise make it a two-step override. */
    await expect(
      sql`UPDATE companies SET language_locked_at = NULL WHERE id = ${companyId}`.execute(ctx.db),
    ).rejects.toThrow(/cannot be moved or removed/i);

    const row = await ctx.db.selectFrom('companies').selectAll()
      .where('id', '=', companyId).executeTakeFirstOrThrow();
    expect(row.bookkeeping_language).toBe('en');
  });

  it('records a permanent audit row, because there is no later choice to supersede it', async () => {
    const { organizationId, ownerId, companyId } = await companyFor('Acme');
    await lockBookkeepingLanguage(ctx.db, {
      organizationId, companyId, language: 'ar', actorUserId: ownerId, actorName: 'Acme Owner',
    });

    const row = await ctx.db.selectFrom('audit_logs').selectAll()
      .where('organization_id', '=', organizationId)
      .where('action', '=', 'company.language_locked')
      .executeTakeFirstOrThrow();

    expect(row.target_id).toBe(companyId);
    expect(JSON.stringify(row.metadata)).toMatch(/"bookkeepingLanguage":"ar"/);
  });

  it('answers another tenant’s company id as not found', async () => {
    const acme = await companyFor('Acme');
    const globex = await tenant('Globex');

    /*
     * Globex naming Acme's company by its server uuid. Not "forbidden", which
     * would confirm the id is real — the same 404 an invented uuid receives.
     */
    await expect(lockBookkeepingLanguage(ctx.db, {
      organizationId: globex.organizationId,
      companyId: acme.companyId,
      language: 'en',
      actorUserId: globex.ownerId,
      actorName: 'Globex Owner',
    })).rejects.toThrow(/not found/i);

    const untouched = await ctx.db.selectFrom('companies').selectAll()
      .where('id', '=', acme.companyId).executeTakeFirstOrThrow();
    expect(untouched.bookkeeping_language).toBeNull();
  });
});

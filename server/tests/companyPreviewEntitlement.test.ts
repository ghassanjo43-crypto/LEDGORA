/**
 * Free Preview may explore everything and keep nothing — including a company.
 *
 * ══ Why a company row is a durable write ═════════════════════════════════════
 *
 * `guards/persistence` refuses durable BUSINESS writes without an active
 * subscription, and classifies `/api/organizations` as lifecycle — the records
 * that turn a preview into a paid subscription. Company registration lives
 * under that prefix and was therefore permitted, which was wrong: a company row
 * is the most permanent record Ledgora holds. Every account, journal and
 * invoice is bound to it by foreign key, and the bookkeeping language locked
 * against it can never be changed by anyone, ever.
 *
 * So registration carries its own rule, resolved from the server's own
 * subscription row.
 *
 * ══ What must keep working ═══════════════════════════════════════════════════
 *
 * A paying subscriber registers and adopts exactly as before; a preview
 * customer who upgrades can register the moment their subscription is active;
 * and nothing already registered is touched by the rule. Those are asserted
 * here too, because a restriction is only correct if it stops the right thing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  authHeaders,
  createTestContext,
  login,
  seedUser,
  type SessionCookies,
  type TestContext,
} from './helpers/testApp.js';
import { listCompanies, registerCompany } from '../src/services/companyService.js';
import { organizationMayPersist } from '../src/guards/persistence.js';
import { recalculateEntitlements } from '../src/services/entitlementService.js';

let ctx: TestContext;
let admin: SessionCookies;

const PASSWORD = 'Copper-Lantern-64-Wm';
const COMPANIES = '/api/organizations/current/companies';

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

/**
 * A subscriber tenant. `paid: false` leaves the subscription unconfirmed, which
 * is exactly what Free Preview is on the server: every feature, no durable
 * storage, `subscriptions.status` anything but `active`.
 */
async function tenant(name: string, paid: boolean): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST', url: '/api/admin/subscribers', headers: authHeaders(admin),
    payload: {
      fullName: `${name} Owner`, email: `owner@${name.toLowerCase()}.test`,
      organizationLegalName: `${name} Trading LLC`, country: 'JO', baseCurrency: 'JOD',
      planId: await planId(), onboarding: 'temporary', paymentConfirmed: paid,
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

const register = (
  cookies: SessionCookies,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) => ctx.app.inject({
  method: 'POST', url: COMPANIES,
  headers: { ...authHeaders(cookies), ...headers },
  payload,
});

/* ══ The refusal ═══════════════════════════════════════════════════════════ */

describe('a Free Preview customer', () => {
  it('cannot register a company through the API', async () => {
    const org = await tenant('Preview', false);
    const user = await member(org, 'admin@preview.test');

    const response = await register(user, {
      clientReference: 'co_preview', legalName: 'Preview Trading LLC',
    });

    /*
     * 403, from whichever layer reaches it first.
     *
     * Two now refuse independently: the permission resolver already withholds
     * every subject but `legal_terms` while entitlement is inactive, and the
     * route's own check reads `subscriptions.status` directly. The first is a
     * DERIVED cache; the second is the authoritative row, which is why the
     * second exists. The test asserts the outcome rather than which layer won,
     * so removing either one still leaves it meaningful — and the service-level
     * refusal is pinned by its own case below.
     */
    expect(response.statusCode).toBe(403);
    expect(await listCompanies(ctx.db, org)).toHaveLength(1);
    expect((await listCompanies(ctx.db, org))[0]!.adoptedAt).toBeNull();
  });

  it('cannot ADOPT the provisional company either', async () => {
    const org = await tenant('Preview', false);
    const user = await member(org, 'admin@preview.test');
    const before = await listCompanies(ctx.db, org);
    expect(before[0]!.adoptedAt).toBeNull();

    await register(user, { clientReference: 'co_preview', legalName: 'Preview Trading LLC' });

    /*
     * The provisional row is untouched — not renamed, not adopted, not
     * duplicated. Adoption is an UPDATE, so refusing after the fact would still
     * have rewritten the row; the rule runs before the transaction opens.
     */
    const after = await listCompanies(ctx.db, org);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[0]!.adoptedAt).toBeNull();
    expect(after[0]!.clientReference).toBe(before[0]!.clientReference);
  });

  it('is refused by the SERVICE as well, not only by the route', async () => {
    const org = await tenant('Preview', false);
    const owner = await ctx.db.selectFrom('organization_memberships').select('user_id')
      .where('organization_id', '=', org).where('role', '=', 'owner').executeTakeFirstOrThrow();

    /*
     * Straight at the service, as a scheduled job or a CLI would reach it. The
     * flag is required, so no caller can arrive without stating the verdict.
     */
    await expect(registerCompany(ctx.db, {
      organizationId: org,
      clientReference: 'co_direct',
      legalName: 'Preview Trading LLC',
      actorUserId: owner.user_id,
      mayCreatePermanentCompany: await organizationMayPersist(ctx.db, org),
    })).rejects.toMatchObject({ code: 'subscription_required_for_persistence' });
  });
});

/* ══ The restriction cannot be talked around ═══════════════════════════════ */

describe('a Free Preview customer trying to get around it', () => {
  it('gains nothing from extra fields in the body', async () => {
    const paid = await tenant('Paid', true);
    const org = await tenant('Preview', false);
    const user = await member(org, 'admin@preview.test');

    /*
     * Everything a client might hope the server reads: another organization's
     * id, a claimed entitlement, a plan name, a workspace mode. None of them
     * reaches the decision — it comes from `subscriptions.status` for the
     * organization the SESSION resolves to.
     */
    const response = await register(user, {
      clientReference: 'co_preview',
      legalName: 'Preview Trading LLC',
      organizationId: paid,
      mayCreatePermanentCompany: true,
      canPersistData: true,
      subscriptionStatus: 'active',
      workspaceStorageMode: 'backend',
      plan: 'enterprise',
    });

    expect(response.statusCode).toBe(403);
    expect(await listCompanies(ctx.db, org)).toHaveLength(1);
    /* And nothing landed in the paid tenant either. */
    const paidCompanies = await listCompanies(ctx.db, paid);
    expect(paidCompanies.every((c) => c.clientReference !== 'co_preview')).toBe(true);
  });

  it('gains nothing from headers', async () => {
    const org = await tenant('Preview', false);
    const user = await member(org, 'admin@preview.test');

    const response = await register(user, {
      clientReference: 'co_preview', legalName: 'Preview Trading LLC',
    }, {
      'x-ledgora-company-reference': 'co_preview',
      'x-subscription-status': 'active',
      'x-workspace-mode': 'backend',
      'x-ledgora-can-persist': 'true',
    });

    expect(response.statusCode).toBe(403);
    expect((await listCompanies(ctx.db, org))[0]!.adoptedAt).toBeNull();
  });

  it('cannot register into a paid organization it does not belong to', async () => {
    const paid = await tenant('Paid', true);
    const org = await tenant('Preview', false);
    const user = await member(org, 'admin@preview.test');

    await register(user, {
      clientReference: 'co_smuggle', legalName: 'Smuggled LLC', organizationId: paid,
    });

    /* The organization comes from the session; the body has no say. */
    const paidCompanies = await listCompanies(ctx.db, paid);
    expect(paidCompanies.every((c) => c.clientReference !== 'co_smuggle')).toBe(true);
  });
});

/* ══ What must still work ══════════════════════════════════════════════════ */

describe('an entitled subscriber', () => {
  it('registers and adopts exactly as before', async () => {
    const org = await tenant('Paid', true);
    const user = await member(org, 'admin@paid.test');

    const response = await register(user, {
      clientReference: 'co_paid', legalName: 'Paid Trading LLC',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().adopted).toBe(true);

    const companies = await listCompanies(ctx.db, org);
    expect(companies).toHaveLength(1);
    expect(companies[0]!.clientReference).toBe('co_paid');
    expect(companies[0]!.adoptedAt).not.toBeNull();
  });

  it('keeps registration idempotent', async () => {
    const org = await tenant('Paid', true);
    const user = await member(org, 'admin@paid.test');

    const first = await register(user, { clientReference: 'co_paid', legalName: 'Paid Trading LLC' });
    const replay = await register(user, { clientReference: 'co_paid', legalName: 'Paid Trading LLC' });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().company.id).toBe(first.json().company.id);
    expect(await listCompanies(ctx.db, org)).toHaveLength(1);
  });
});

describe('a preview customer who upgrades', () => {
  it('can register the moment the subscription is active', async () => {
    const org = await tenant('Upgrading', false);
    const user = await member(org, 'admin@upgrading.test');

    const refused = await register(user, {
      clientReference: 'co_upgrading', legalName: 'Upgrading Trading LLC',
    });
    expect(refused.statusCode).toBe(403);

    /*
     * The subscription becomes active, and the derived entitlement cache is
     * recalculated — which is what the real activation path does. Updating the
     * row alone would leave the permission resolver still refusing from a stale
     * cache, and the test would prove the upgrade broken when it is not.
     */
    await ctx.db.updateTable('subscriptions')
      .set({ status: 'active' })
      .where('organization_id', '=', org)
      .execute();
    await recalculateEntitlements(ctx.db, org);

    const allowed = await register(user, {
      clientReference: 'co_upgrading', legalName: 'Upgrading Trading LLC',
    });

    expect(allowed.statusCode).toBe(201);
    expect(allowed.json().adopted).toBe(true);
    /*
     * And it adopted the SAME provisional row the refusal left alone, so the
     * upgrade costs them nothing: the server id is the one their books would
     * already have been written against.
     */
    const companies = await listCompanies(ctx.db, org);
    expect(companies).toHaveLength(1);
    expect(companies[0]!.adoptedAt).not.toBeNull();
  });
});

describe('companies that already exist', () => {
  it('are neither deleted nor altered when entitlement lapses', async () => {
    const org = await tenant('Lapsing', true);
    const user = await member(org, 'admin@lapsing.test');

    const registered = await register(user, {
      clientReference: 'co_lapsing', legalName: 'Lapsing Trading LLC',
    });
    expect(registered.statusCode).toBe(201);
    const before = (await listCompanies(ctx.db, org))[0]!;

    /* The subscription lapses. */
    await ctx.db.updateTable('subscriptions')
      .set({ status: 'expired' })
      .where('organization_id', '=', org)
      .execute();

    const afterLapse = await register(user, {
      clientReference: 'co_lapsing', legalName: 'Lapsing Trading LLC',
    });
    expect(afterLapse.statusCode).toBe(403);

    /*
     * The rule governs CREATING a permanent record, never removing one. The
     * books a customer already paid for stay exactly as they were — same id,
     * same reference, same adoption moment.
     */
    const after = (await listCompanies(ctx.db, org))[0]!;
    expect(after.id).toBe(before.id);
    expect(after.clientReference).toBe(before.clientReference);
    expect(after.legalName).toBe(before.legalName);
    expect(after.adoptedAt).toBe(before.adoptedAt);

    /* And it is still readable. */
    const listed = await ctx.app.inject({
      method: 'GET', url: COMPANIES, headers: authHeaders(user),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().companies).toHaveLength(1);
  });
});

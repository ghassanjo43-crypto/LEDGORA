/**
 * Test harness.
 *
 * Every test file gets its own PGlite instance — a real PostgreSQL 18 engine
 * running in-process — migrated with the production migrations. The SQL, the
 * constraints and the transactions under test are therefore the real ones, with
 * no database to install and no risk of touching a shared or production store.
 */
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { createDatabase, type Db } from '../../src/db/index.js';
import { assertMigrationsSucceeded, migrateToLatest } from '../../src/db/migrator.js';
import { assignPlatformRole, createUser } from '../../src/services/userService.js';
import type { PlatformRole } from '../../src/db/schema.js';
import { CSRF_HEADER, SESSION_COOKIE, CSRF_COOKIE } from '../../src/plugins/session.js';
import { MemoryFileStorage } from '../../src/storage/fileStorage.js';
import { UnavailableMailer, type Mailer } from '../../src/mail/mailer.js';

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  config: AppConfig;
  /** In-memory payment-proof storage — no filesystem touched by tests. */
  storage: MemoryFileStorage;
  close(): Promise<void>;
}

export const TEST_PASSWORD = 'Correct-Horse-9-Battery';

export interface TestContextOptions {
  /** Register extra routes (e.g. a durable business endpoint) on the real app. */
  extraRoutes?: (app: FastifyInstance) => Promise<void> | void;
  /** Override the mail transport. Defaults to one that reports `unavailable`. */
  mailer?: Mailer;
}

export async function createTestContext(
  overrides: Partial<NodeJS.ProcessEnv> = {},
  options: TestContextOptions = {},
): Promise<TestContext> {
  const config = loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-value-32-chars',
    FRONTEND_URL: 'http://localhost:5173',
    ACCOUNT_LOCK_THRESHOLD: '4',
    ACCOUNT_LOCK_MINUTES: '15',
    LOGIN_RATE_LIMIT_MAX: '50',
    /*
     * Tests are a development context, and the invitation flow cannot be
     * exercised end to end without the link — the token is stored only as a
     * digest.
     *
     * Deliberately NOT applied when a test builds a production config: that flag
     * is refused at boot in production, which is the behaviour those tests exist
     * to exercise. Forcing it on here would make them fail for the wrong reason.
     */
    ...(overrides.NODE_ENV === 'production' ? {} : { EXPOSE_INVITATION_TOKENS: 'true' }),
    ...overrides,
  } as NodeJS.ProcessEnv);

  const db = await createDatabase({ useInMemory: true });
  assertMigrationsSucceeded(await migrateToLatest(db));

  const storage = new MemoryFileStorage();
  const app = await buildApp({
    config,
    db,
    fileStorage: storage,
    // No transport by default: a test that does not care about mail must never
    // depend on a network call, and `unavailable` is the honest default.
    mailer: options.mailer ?? new UnavailableMailer(),
    extraRoutes: options.extraRoutes,
  });
  await app.ready();

  return {
    app,
    db,
    config,
    storage,
    async close() {
      await app.close();
      await db.destroy();
    },
  };
}

export async function seedUser(
  ctx: TestContext,
  input: { email: string; fullName?: string; password?: string; platformRoles?: PlatformRole[]; status?: 'active' | 'disabled' },
): Promise<{ id: string; email: string }> {
  const user = await createUser(ctx.db, {
    email: input.email,
    password: input.password ?? TEST_PASSWORD,
    fullName: input.fullName ?? 'Test User',
    status: input.status ?? 'active',
    emailVerified: true,
  });
  for (const role of input.platformRoles ?? []) {
    await assignPlatformRole(ctx.db, user.id, role);
  }
  return { id: user.id, email: user.email };
}

export interface SessionCookies {
  session: string;
  csrf: string;
}

/** Extract the session + CSRF cookies from a login/register response. */
export function readCookies(headers: Record<string, unknown>): SessionCookies {
  const raw = headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const find = (name: string): string => {
    const match = list.find((c) => c.startsWith(`${name}=`));
    return match ? (match.split(';')[0]?.split('=').slice(1).join('=') ?? '') : '';
  };
  return { session: find(SESSION_COOKIE), csrf: find(CSRF_COOKIE) };
}

/** Headers for an authenticated, CSRF-valid request. */
export function authHeaders(cookies: SessionCookies): Record<string, string> {
  return {
    cookie: `${SESSION_COOKIE}=${cookies.session}; ${CSRF_COOKIE}=${cookies.csrf}`,
    [CSRF_HEADER]: cookies.csrf,
  };
}

/** Log in and return the resulting cookies. */
export async function login(ctx: TestContext, email: string, password = TEST_PASSWORD): Promise<SessionCookies> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed (${response.statusCode}): ${response.body}`);
  }
  return readCookies(response.headers as Record<string, unknown>);
}


/**
 * A customer party, seeded directly, with an id the caller chooses.
 *
 * Invoice tests were written when `invoices.customer_id` was a bare uuid and so
 * they name a fixed fabricated one. Migration 031 gave that column a foreign
 * key, which is the point of it — an invoice may no longer name a customer that
 * does not exist. Rather than rewrite every assertion around a generated id,
 * this makes the id they already use into a real customer.
 *
 * Inserted directly rather than through the API because these tests are about
 * invoices: routing customer creation through its own surface would make a
 * failure there present as a failure here.
 */
export async function seedCustomerParty(
  ctx: TestContext,
  organizationId: string,
  options: {
    id?: string;
    code?: string;
    companyId?: string;
    /** The account an invoice to this customer debits. Required to issue. */
    receivableAccountId?: string;
  } = {},
): Promise<string> {
  const company = options.companyId
    ? { id: options.companyId }
    : await ctx.db
        .selectFrom('companies')
        .select('id')
        .where('organization_id', '=', organizationId)
        .orderBy('created_at', 'asc')
        .executeTakeFirst();

  /* An organization with no books yet has nowhere to put a customer. Callers
   * that seed defensively should not be forced to check first. */
  if (!company) return '';
  const companyId = company.id;

  const code = options.code ?? `CUST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  /*
   * Idempotent when the caller names an id. A fixture id belongs to whichever
   * tenant seeded it first, and a second tenant in the same test asking for the
   * same one wants "make sure it exists", not a primary-key collision.
   */
  const row = await ctx.db
    .insertInto('business_parties')
    .values({
      ...(options.id ? { id: options.id } : {}),
      organization_id: organizationId,
      company_id: companyId,
      party_code: code,
      legal_name: `Customer ${code}`,
      is_customer: true,
    } as never)
    .onConflict((oc) => oc.doNothing())
    .returning('id')
    .executeTakeFirst();

  const partyId = row?.id ?? options.id ?? '';

  /*
   * The customer PROFILE, which is where the receivable account lives.
   *
   * Issuing derives the account it debits from here rather than from the
   * request, so a customer without one cannot be invoiced — which is the
   * behaviour, not an oversight.
   */
  if (partyId && options.receivableAccountId) {
    await ctx.db
      .insertInto('business_party_customer_profiles')
      .values({
        organization_id: organizationId,
        company_id: companyId,
        party_id: partyId,
        default_receivable_account_id: options.receivableAccountId,
      } as never)
      .onConflict((oc) => oc
        .columns(['organization_id', 'company_id', 'party_id'])
        .doUpdateSet({ default_receivable_account_id: options.receivableAccountId }))
      .execute();
  }

  return partyId;
}

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

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  config: AppConfig;
  /** In-memory payment-proof storage — no filesystem touched by tests. */
  storage: MemoryFileStorage;
  close(): Promise<void>;
}

export const TEST_PASSWORD = 'Correct-Horse-9-Battery';

export async function createTestContext(overrides: Partial<NodeJS.ProcessEnv> = {}): Promise<TestContext> {
  const config = loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-value-32-chars',
    FRONTEND_URL: 'http://localhost:5173',
    ACCOUNT_LOCK_THRESHOLD: '4',
    ACCOUNT_LOCK_MINUTES: '15',
    LOGIN_RATE_LIMIT_MAX: '50',
    ...overrides,
  } as NodeJS.ProcessEnv);

  const db = await createDatabase({ useInMemory: true });
  assertMigrationsSucceeded(await migrateToLatest(db));

  const storage = new MemoryFileStorage();
  const app = await buildApp({ config, db, fileStorage: storage });
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

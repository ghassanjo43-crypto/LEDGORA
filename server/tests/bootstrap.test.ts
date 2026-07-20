/**
 * First-administrator bootstrap and password policy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, seedUser, type TestContext } from './helpers/testApp.js';
import { runAdminBootstrap } from '../src/cli/bootstrapAdmin.js';
import { loadConfig } from '../src/config/env.js';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../src/lib/password.js';
import { getPlatformRoles } from '../src/services/userService.js';
import { countAuditLogs } from '../src/lib/audit.js';
import { generatePaymentReference, PAYMENT_REFERENCE_PATTERN, hashToken } from '../src/lib/tokens.js';

let ctx: TestContext;

const STRONG = 'Correct-Horse-9-Battery';

function bootstrapConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-value-32-chars',
    BOOTSTRAP_ADMIN_ENABLED: 'true',
    BOOTSTRAP_ADMIN_EMAIL: 'root@ledgora.test',
    BOOTSTRAP_ADMIN_PASSWORD: STRONG,
    BOOTSTRAP_ADMIN_FULL_NAME: 'Platform Root',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

describe('administrator bootstrap', () => {
  it('does nothing unless explicitly enabled', async () => {
    const result = await runAdminBootstrap(ctx.db, bootstrapConfig({ BOOTSTRAP_ADMIN_ENABLED: 'false' }));
    expect(result).toEqual({ status: 'disabled' });
    expect(await ctx.db.selectFrom('users').selectAll().execute()).toHaveLength(0);
  });

  it('creates a super_admin who must change the password at first sign-in', async () => {
    const result = await runAdminBootstrap(ctx.db, bootstrapConfig());
    expect(result.status).toBe('created');

    const user = await ctx.db.selectFrom('users').selectAll().executeTakeFirstOrThrow();
    expect(user.must_change_password).toBe(true);
    expect(await getPlatformRoles(ctx.db, user.id)).toEqual(['super_admin']);
    expect(await countAuditLogs(ctx.db, 'admin.bootstrap')).toBe(1);
  });

  it('never records the bootstrap password in the audit metadata', async () => {
    await runAdminBootstrap(ctx.db, bootstrapConfig());
    const entry = await ctx.db.selectFrom('audit_logs').selectAll().executeTakeFirstOrThrow();
    expect(JSON.stringify(entry.metadata)).not.toContain(STRONG);
  });

  it('refuses a weak password', async () => {
    const result = await runAdminBootstrap(ctx.db, bootstrapConfig({ BOOTSTRAP_ADMIN_PASSWORD: 'short' }));
    expect(result).toEqual({ status: 'invalid', reason: 'weak_password' });
    expect(await ctx.db.selectFrom('users').selectAll().execute()).toHaveLength(0);
  });

  it('is idempotent and never overwrites an existing password', async () => {
    await seedUser(ctx, { email: 'root@ledgora.test', password: STRONG });
    const before = await ctx.db.selectFrom('users').select('password_hash').executeTakeFirstOrThrow();

    const result = await runAdminBootstrap(ctx.db, bootstrapConfig({ BOOTSTRAP_ADMIN_PASSWORD: 'Totally-Different-42x' }));
    expect(result.status).toBe('already_exists');

    const after = await ctx.db.selectFrom('users').select('password_hash').executeTakeFirstOrThrow();
    expect(after.password_hash).toBe(before.password_hash);
    // The role is still ensured, so the account is usable.
    const user = await ctx.db.selectFrom('users').selectAll().executeTakeFirstOrThrow();
    expect(await getPlatformRoles(ctx.db, user.id)).toContain('super_admin');
  });

  it('does nothing when credentials are missing', async () => {
    const result = await runAdminBootstrap(ctx.db, bootstrapConfig({ BOOTSTRAP_ADMIN_PASSWORD: '' }));
    expect(result).toEqual({ status: 'invalid', reason: 'missing_credentials' });
  });
});

describe('password policy', () => {
  it('rejects short, single-case, digitless and common passwords', () => {
    expect(checkPasswordPolicy('short').ok).toBe(false);
    expect(checkPasswordPolicy('alllowercase123').ok).toBe(false);
    expect(checkPasswordPolicy('NoDigitsHereAtAll').ok).toBe(false);
    expect(checkPasswordPolicy('password').ok).toBe(false);
  });

  it('rejects a password containing the account name or email', () => {
    expect(checkPasswordPolicy('Jane1234567890', { fullName: 'Jane Owner' }).ok).toBe(false);
    expect(checkPasswordPolicy('Ledgorauser99X', { email: 'ledgorauser@acme.test' }).ok).toBe(false);
  });

  it('accepts a strong password', () => {
    expect(checkPasswordPolicy(STRONG, { email: 'root@ledgora.test', fullName: 'Platform Root' }).ok).toBe(true);
  });
});

describe('hashing primitives', () => {
  it('produces distinct salted argon2id hashes and verifies correctly', async () => {
    const a = await hashPassword(STRONG);
    const b = await hashPassword(STRONG);
    expect(a).not.toBe(b); // per-hash salt
    expect(a.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(a, STRONG)).toBe(true);
    expect(await verifyPassword(a, 'wrong')).toBe(false);
  });

  it('returns false rather than throwing on a corrupt hash', async () => {
    expect(await verifyPassword('not-a-hash', STRONG)).toBe(false);
    expect(await verifyPassword('', STRONG)).toBe(false);
  });

  it('hashes session tokens deterministically and irreversibly', () => {
    const digest = hashToken('some-token');
    expect(digest).toHaveLength(64);
    expect(digest).toBe(hashToken('some-token'));
    expect(digest).not.toContain('some-token');
  });
});

describe('payment reference generation', () => {
  it('produces well-formed, unambiguous, non-repeating references', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const reference = generatePaymentReference();
      expect(reference).toMatch(PAYMENT_REFERENCE_PATTERN);
      // No I/L/O/U — cannot be misread when typed into a bank form.
      expect(/[ILOU]/.test(reference.slice(3))).toBe(false);
      seen.add(reference);
    }
    // Collisions at this sample size would indicate a broken generator.
    expect(seen.size).toBe(500);
  });
});

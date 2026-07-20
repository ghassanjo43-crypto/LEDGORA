/**
 * Non-interactive first-administrator bootstrap.
 *
 * Render has no terminal during deploy, so the very first administrator can be
 * provisioned from temporary secret environment variables. This is the exception,
 * not the norm — `create-platform-admin` is the everyday path.
 *
 * Guarantees:
 *  · Runs only when BOOTSTRAP_ADMIN_ENABLED is explicitly true.
 *  · Refuses weak passwords (same policy as everywhere else).
 *  · Idempotent: re-running does nothing once the administrator exists.
 *  · NEVER silently overwrites an existing account's password.
 *  · Logs that bootstrap happened, never what the credentials were.
 *  · Reminds the operator to remove the variables immediately afterwards.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import type { AppConfig } from '../config/env.js';
import { checkPasswordPolicy } from '../lib/password.js';
import { assignPlatformRole, createUser, findUserByEmail, getPlatformRoles, normaliseEmail } from '../services/userService.js';
import { writeAuditLog } from '../lib/audit.js';

export type BootstrapOutcome =
  | { status: 'disabled' }
  | { status: 'invalid'; reason: string }
  | { status: 'already_exists'; userId: string }
  | { status: 'created'; userId: string };

export async function runAdminBootstrap(
  db: Kysely<Database>,
  config: AppConfig,
  log: (message: string) => void = () => {},
): Promise<BootstrapOutcome> {
  if (!config.BOOTSTRAP_ADMIN_ENABLED) return { status: 'disabled' };

  const email = config.BOOTSTRAP_ADMIN_EMAIL.trim();
  const password = config.BOOTSTRAP_ADMIN_PASSWORD;
  const fullName = config.BOOTSTRAP_ADMIN_FULL_NAME.trim() || 'LEDGORA Administrator';

  if (!email || !password) {
    log('BOOTSTRAP_ADMIN_ENABLED is set but email/password are missing — no administrator created.');
    return { status: 'invalid', reason: 'missing_credentials' };
  }

  const policy = checkPasswordPolicy(password, { email, fullName });
  if (!policy.ok) {
    // The reasons describe the policy, never the supplied value.
    log(`Bootstrap password rejected by policy (${policy.problems.length} problem(s)) — no administrator created.`);
    return { status: 'invalid', reason: 'weak_password' };
  }

  const existing = await findUserByEmail(db, email);
  if (existing) {
    // Idempotent: ensure the role, never touch the password.
    const roles = await getPlatformRoles(db, existing.id);
    if (!roles.includes('super_admin')) {
      await assignPlatformRole(db, existing.id, 'super_admin', { actorUserId: null });
      log(`Existing user promoted to super_admin. Password left unchanged. Remove the BOOTSTRAP_ADMIN_* variables now.`);
    } else {
      log('Administrator already present — bootstrap skipped. Remove the BOOTSTRAP_ADMIN_* variables now.');
    }
    return { status: 'already_exists', userId: existing.id };
  }

  const userId = await db.transaction().execute(async (trx) => {
    const user = await createUser(trx, {
      email,
      password,
      fullName,
      status: 'active',
      emailVerified: true,
      // Provisioned from an environment variable that the operator has seen —
      // force a change at first sign-in so the durable password is chosen by a
      // human and never existed in Render's configuration.
      mustChangePassword: true,
    });
    await assignPlatformRole(trx, user.id, 'super_admin', { actorUserId: user.id });
    await writeAuditLog(trx, {
      actorUserId: user.id,
      actorPlatformRole: 'super_admin',
      action: 'admin.bootstrap',
      targetType: 'user',
      targetId: user.id,
      metadata: { email: normaliseEmail(email), mustChangePassword: true },
    });
    return user.id;
  });

  log('First super administrator created from bootstrap variables (must change password at first sign-in).');
  log('SECURITY: remove BOOTSTRAP_ADMIN_PASSWORD and set BOOTSTRAP_ADMIN_ENABLED=false in Render now.');
  return { status: 'created', userId };
}

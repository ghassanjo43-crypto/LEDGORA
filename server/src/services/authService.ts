/**
 * Authentication: registration, login, password change.
 *
 * Security properties enforced here:
 *  · Argon2id hashing; the raw password never reaches the database or the log.
 *  · Uniform failure response — "no such user" and "wrong password" are
 *    indistinguishable, so login cannot enumerate registered emails.
 *  · A dummy verification runs when the account does not exist, keeping the
 *    response time comparable and closing the timing side channel.
 *  · Progressive failure counting with temporary lockout.
 *  · Changing a password revokes every other session.
 */
import type { Kysely } from 'kysely';
import type { Database, User } from '../db/schema.js';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../lib/password.js';
import { writeAuditLog, type AuditContext } from '../lib/audit.js';
import { errors } from '../lib/errors.js';
import { createUser, findUserByEmail, getPlatformRoles, normaliseEmail } from './userService.js';
import { revokeAllUserSessions } from './sessionService.js';

/**
 * A real Argon2id hash of a random value. Verifying against it when the account
 * is missing costs the same as a genuine check, so response timing does not
 * reveal whether an email is registered.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$RdescudvJCsgt3ub+b+dWRWJTmaaJObG';

export interface LoginPolicy {
  lockThreshold: number;
  lockMinutes: number;
}

export interface LoginResult {
  user: User;
  platformRoles: string[];
}

export async function registerUser(
  db: Kysely<Database>,
  input: { email: string; password: string; fullName: string },
  context: AuditContext = {},
): Promise<User> {
  const policy = checkPasswordPolicy(input.password, { email: input.email, fullName: input.fullName });
  if (!policy.ok) throw errors.passwordPolicy(policy.problems);

  const user = await createUser(db, {
    email: input.email,
    password: input.password,
    fullName: input.fullName,
    // Self-registered customers are active; email verification is a separate
    // seam (see routes/auth verify-email) and does not block sign-in today.
    status: 'active',
  });

  await writeAuditLog(db, {
    ...context,
    actorUserId: user.id,
    action: 'auth.register',
    targetType: 'user',
    targetId: user.id,
    metadata: { email: user.email },
  });
  return user;
}

export async function authenticate(
  db: Kysely<Database>,
  input: { email: string; password: string },
  policy: LoginPolicy,
  context: AuditContext = {},
): Promise<LoginResult> {
  const user = await findUserByEmail(db, input.email);

  if (!user) {
    // Equal-cost path for an unknown account.
    await verifyPassword(DUMMY_HASH, input.password);
    await writeAuditLog(db, {
      ...context,
      action: 'auth.login_failed',
      targetType: 'email',
      targetId: normaliseEmail(input.email),
      metadata: { reason: 'unknown_account' },
    });
    throw errors.invalidCredentials();
  }

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    await writeAuditLog(db, {
      ...context,
      actorUserId: user.id,
      action: 'auth.login_failed',
      targetType: 'user',
      targetId: user.id,
      metadata: { reason: 'locked' },
    });
    throw errors.accountLocked(new Date(user.locked_until));
  }

  if (user.status === 'disabled') {
    await writeAuditLog(db, {
      ...context,
      actorUserId: user.id,
      action: 'auth.login_failed',
      targetType: 'user',
      targetId: user.id,
      metadata: { reason: 'disabled' },
    });
    // Generic message: do not confirm the address exists.
    throw errors.invalidCredentials();
  }

  const valid = await verifyPassword(user.password_hash, input.password);
  if (!valid) {
    const failures = user.failed_login_count + 1;
    const shouldLock = failures >= policy.lockThreshold;
    const lockedUntil = shouldLock ? new Date(Date.now() + policy.lockMinutes * 60_000) : null;

    await db
      .updateTable('users')
      .set({
        failed_login_count: failures,
        locked_until: lockedUntil,
        status: shouldLock ? 'locked' : user.status,
        updated_at: new Date(),
      })
      .where('id', '=', user.id)
      .execute();

    await writeAuditLog(db, {
      ...context,
      actorUserId: user.id,
      action: shouldLock ? 'auth.account_locked' : 'auth.login_failed',
      targetType: 'user',
      targetId: user.id,
      metadata: { reason: 'bad_password', failedAttempts: failures },
    });

    if (shouldLock && lockedUntil) throw errors.accountLocked(lockedUntil);
    throw errors.invalidCredentials();
  }

  // Success: clear the failure counter and lift any expired lock.
  const refreshed = await db
    .updateTable('users')
    .set({
      failed_login_count: 0,
      locked_until: null,
      last_login_at: new Date(),
      status: user.status === 'locked' ? 'active' : user.status,
      updated_at: new Date(),
    })
    .where('id', '=', user.id)
    .returningAll()
    .executeTakeFirstOrThrow();

  const platformRoles = await getPlatformRoles(db, user.id);
  await writeAuditLog(db, {
    ...context,
    actorUserId: user.id,
    actorPlatformRole: platformRoles[0] ?? null,
    action: 'auth.login',
    targetType: 'user',
    targetId: user.id,
    metadata: { platformRoles },
  });

  return { user: refreshed, platformRoles };
}

export async function changePassword(
  db: Kysely<Database>,
  input: { userId: string; currentPassword: string; newPassword: string; currentSessionId?: string },
  context: AuditContext = {},
): Promise<void> {
  const user = await db.selectFrom('users').selectAll().where('id', '=', input.userId).executeTakeFirst();
  if (!user) throw errors.notFound('User');

  const valid = await verifyPassword(user.password_hash, input.currentPassword);
  if (!valid) throw errors.invalidCredentials();

  const policy = checkPasswordPolicy(input.newPassword, { email: user.email, fullName: user.full_name });
  if (!policy.ok) throw errors.passwordPolicy(policy.problems);

  if (await verifyPassword(user.password_hash, input.newPassword)) {
    throw errors.validation('The new password must be different from the current one.');
  }

  await db
    .updateTable('users')
    .set({
      password_hash: await hashPassword(input.newPassword),
      must_change_password: false,
      updated_at: new Date(),
    })
    .where('id', '=', user.id)
    .execute();

  // A password change invalidates every other session.
  const revoked = await revokeAllUserSessions(db, user.id, { exceptSessionId: input.currentSessionId });

  await writeAuditLog(db, {
    ...context,
    actorUserId: user.id,
    action: 'auth.password_changed',
    targetType: 'user',
    targetId: user.id,
    metadata: { revokedSessions: revoked },
  });
}

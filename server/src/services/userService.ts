/**
 * User records and platform-role assignment.
 *
 * `password_hash` never leaves this module: everything the API returns goes
 * through `toPublicUser`, which builds an explicit allow-list rather than
 * deleting fields from the row (a deny-list would leak any column added later).
 */
import type { Kysely } from 'kysely';
import type { Database, PlatformRole, User, UserStatus } from '../db/schema.js';
import { hashPassword } from '../lib/password.js';
import { writeAuditLog, type AuditContext } from '../lib/audit.js';
import { errors } from '../lib/errors.js';

export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  status: UserStatus;
  emailVerified: boolean;
  mustChangePassword: boolean;
  platformRoles: PlatformRole[];
  lastLoginAt: string | null;
  createdAt: string;
}

/** Explicit allow-list — the only shape a user is ever serialised as. */
export function toPublicUser(user: User, platformRoles: PlatformRole[] = []): PublicUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    status: user.status,
    emailVerified: Boolean(user.email_verified_at),
    mustChangePassword: user.must_change_password,
    platformRoles,
    lastLoginAt: user.last_login_at ? new Date(user.last_login_at).toISOString() : null,
    createdAt: new Date(user.created_at).toISOString(),
  };
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(db: Kysely<Database>, email: string): Promise<User | undefined> {
  return db
    .selectFrom('users')
    .selectAll()
    .where('normalized_email', '=', normaliseEmail(email))
    .executeTakeFirst();
}

export async function findUserById(db: Kysely<Database>, id: string): Promise<User | undefined> {
  return db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function getPlatformRoles(db: Kysely<Database>, userId: string): Promise<PlatformRole[]> {
  const rows = await db.selectFrom('platform_user_roles').select('role').where('user_id', '=', userId).execute();
  return rows.map((r) => r.role);
}

export interface CreateUserInput {
  email: string;
  password: string;
  fullName: string;
  status?: UserStatus;
  mustChangePassword?: boolean;
  emailVerified?: boolean;
}

export async function createUser(db: Kysely<Database>, input: CreateUserInput): Promise<User> {
  const normalized = normaliseEmail(input.email);
  const existing = await findUserByEmail(db, normalized);
  if (existing) throw errors.conflict('An account with this email already exists.');

  const passwordHash = await hashPassword(input.password);
  return db
    .insertInto('users')
    .values({
      email: input.email.trim(),
      normalized_email: normalized,
      password_hash: passwordHash,
      full_name: input.fullName.trim(),
      status: input.status ?? 'active',
      must_change_password: input.mustChangePassword ?? false,
      email_verified_at: input.emailVerified ? new Date() : null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Grant a platform role. Idempotent — re-granting an existing role is a no-op
 * rather than an error, which keeps the bootstrap path safely repeatable.
 */
export async function assignPlatformRole(
  db: Kysely<Database>,
  userId: string,
  role: PlatformRole,
  context: AuditContext & { grantedByUserId?: string | null } = {},
): Promise<boolean> {
  const existing = await db
    .selectFrom('platform_user_roles')
    .select('id')
    .where('user_id', '=', userId)
    .where('role', '=', role)
    .executeTakeFirst();
  if (existing) return false;

  await db
    .insertInto('platform_user_roles')
    .values({ user_id: userId, role, created_by: context.grantedByUserId ?? null })
    .execute();

  await writeAuditLog(db, {
    ...context,
    action: 'platform_role.assigned',
    targetType: 'user',
    targetId: userId,
    metadata: { role },
  });
  return true;
}

export async function revokePlatformRole(
  db: Kysely<Database>,
  userId: string,
  role: PlatformRole,
  context: AuditContext = {},
): Promise<void> {
  await db.deleteFrom('platform_user_roles').where('user_id', '=', userId).where('role', '=', role).execute();
  await writeAuditLog(db, {
    ...context,
    action: 'platform_role.revoked',
    targetType: 'user',
    targetId: userId,
    metadata: { role },
  });
}

export async function setUserStatus(
  db: Kysely<Database>,
  userId: string,
  status: UserStatus,
  context: AuditContext = {},
): Promise<User> {
  const updated = await db
    .updateTable('users')
    .set({ status, updated_at: new Date() })
    .where('id', '=', userId)
    .returningAll()
    .executeTakeFirst();
  if (!updated) throw errors.notFound('User');

  await writeAuditLog(db, {
    ...context,
    action: 'user.status_changed',
    targetType: 'user',
    targetId: userId,
    metadata: { status },
  });
  return updated;
}

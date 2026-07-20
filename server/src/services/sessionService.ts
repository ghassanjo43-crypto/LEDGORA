/**
 * Server-side sessions.
 *
 * A session token is 256 random bits handed to the browser in an HttpOnly
 * cookie. PostgreSQL stores only its SHA-256 hash, so reading the database does
 * not yield a usable credential. Sessions expire, can be revoked individually or
 * en masse, and are re-validated against the database on every request — there
 * is no self-describing token to forge.
 */
import type { Kysely } from 'kysely';
import type { Database, PlatformRole, User } from '../db/schema.js';
import { generateSessionToken, hashToken } from '../lib/tokens.js';

export interface SessionContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface CreatedSession {
  /** Returned to the caller exactly once — never persisted or logged. */
  token: string;
  sessionId: string;
  expiresAt: Date;
}

export interface AuthenticatedPrincipal {
  user: User;
  sessionId: string;
  platformRoles: PlatformRole[];
}

export async function createSession(
  db: Kysely<Database>,
  userId: string,
  ttlHours: number,
  context: SessionContext = {},
): Promise<CreatedSession> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);

  const row = await db
    .insertInto('auth_sessions')
    .values({
      user_id: userId,
      token_hash: hashToken(token),
      expires_at: expiresAt,
      ip_address: context.ipAddress ?? null,
      user_agent: context.userAgent?.slice(0, 500) ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return { token, sessionId: row.id, expiresAt };
}

/**
 * Resolve a raw token to its principal, or null. Rejects revoked and expired
 * sessions, and users who are no longer active — so disabling an account takes
 * effect immediately on the next request rather than at session expiry.
 */
export async function resolveSession(
  db: Kysely<Database>,
  token: string,
): Promise<AuthenticatedPrincipal | null> {
  if (!token) return null;

  const session = await db
    .selectFrom('auth_sessions')
    .selectAll()
    .where('token_hash', '=', hashToken(token))
    .executeTakeFirst();

  if (!session) return null;
  if (session.revoked_at) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) return null;

  const user = await db.selectFrom('users').selectAll().where('id', '=', session.user_id).executeTakeFirst();
  if (!user || user.status !== 'active') return null;

  const roles = await db
    .selectFrom('platform_user_roles')
    .select('role')
    .where('user_id', '=', user.id)
    .execute();

  return { user, sessionId: session.id, platformRoles: roles.map((r) => r.role) };
}

/** Refresh activity. Cheap enough per request; keeps idle-session reporting real. */
export async function touchSession(db: Kysely<Database>, sessionId: string): Promise<void> {
  await db
    .updateTable('auth_sessions')
    .set({ last_used_at: new Date() })
    .where('id', '=', sessionId)
    .execute();
}

export async function revokeSession(db: Kysely<Database>, sessionId: string): Promise<void> {
  await db
    .updateTable('auth_sessions')
    .set({ revoked_at: new Date() })
    .where('id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .execute();
}

/** Revoke every live session for a user (password change, "sign out everywhere"). */
export async function revokeAllUserSessions(
  db: Kysely<Database>,
  userId: string,
  options: { exceptSessionId?: string } = {},
): Promise<number> {
  let query = db
    .updateTable('auth_sessions')
    .set({ revoked_at: new Date() })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null);

  if (options.exceptSessionId) query = query.where('id', '!=', options.exceptSessionId);

  const result = await query.executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

/** Housekeeping: drop sessions that expired or were revoked long ago. */
export async function purgeExpiredSessions(db: Kysely<Database>, olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const result = await db
    .deleteFrom('auth_sessions')
    .where((eb) => eb.or([eb('expires_at', '<', cutoff), eb('revoked_at', '<', cutoff)]))
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}

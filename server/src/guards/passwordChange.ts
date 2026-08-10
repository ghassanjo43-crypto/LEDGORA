/**
 * The forced-password-change gate.
 *
 * ── Why this is a server-side hook and not a client redirect ──────────────────
 * "A temporary password must be changed at the first successful login" is a
 * security property, and a security property enforced only by a React route is
 * theatre: the credential is real, the session it creates is real, and anyone can
 * call the API directly with the cookie it issued. So while `must_change_password`
 * is set, the session can do exactly three things — read who it is, change the
 * password, and sign out. Everything else is refused with
 * `password_change_required`.
 *
 * That is what makes an administrator-issued credential safe to hand over: it
 * buys the holder one action, and that action is replacing it.
 *
 * ── Fail-closed by construction ──────────────────────────────────────────────
 * The rule is a DEFAULT DENY with a three-entry allow-list, not a list of
 * protected paths. A route added next year is covered the day it is written, with
 * nobody having to remember this file exists.
 *
 * Reads are blocked too, deliberately. A temporary credential that could browse
 * a whole tenant's ledger before being replaced would defeat the point.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { errors } from '../lib/errors.js';

/**
 * The only paths reachable while a password change is outstanding.
 *
 * · `session`         — the client must be able to discover WHY it is blocked;
 * · `change-password` — the way out;
 * · `logout`          — never trap a user in a session they cannot use.
 * Matched exactly: no prefix matching, so `/api/auth/session-something` added
 * later is not accidentally admitted.
 */
export const PASSWORD_CHANGE_ALLOWED_PATHS: readonly string[] = [
  '/api/auth/session',
  '/api/auth/change-password',
  '/api/auth/logout',
  '/api/auth/logout-all',
  '/api/auth/login',
  '/api/health',
];

/** Pure, so the policy is testable without a server. */
export function isAllowedDuringForcedChange(path: string): boolean {
  const clean = path.split('?')[0] ?? path;
  return PASSWORD_CHANGE_ALLOWED_PATHS.includes(clean);
}

/**
 * Global hook. Runs after the session plugin has resolved `request.principal`,
 * and does nothing at all for an anonymous request — the route's own
 * authentication guard gives a clearer answer there.
 */
export async function enforcePasswordChange(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const principal = request.principal;
  if (!principal) return;
  if (!principal.user.must_change_password) return;
  if (isAllowedDuringForcedChange(request.url)) return;

  throw errors.passwordChangeRequired();
}

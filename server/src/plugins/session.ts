/**
 * Session cookie plumbing + CSRF.
 *
 * The session cookie is HttpOnly (unreadable by script), Secure in production
 * (and always when SameSite=None), Path=/, with a SameSite chosen by
 * configuration:
 *   · same-origin deployment (API reached through the frontend's `/api` proxy)
 *     → SameSite=Lax, the default;
 *   · cross-site deployment (separate API hostname) → SameSite=None, optionally
 *     Partitioned.
 *
 * Because authentication rides on a cookie, every unsafe method additionally
 * requires a double-submit CSRF token. The token is ALSO returned in the
 * login/session response body (see routes/auth) so the browser keeps it in
 * memory and echoes it in `X-CSRF-Token` — it never has to read a cookie with
 * `document.cookie`, which is impossible across origins anyway.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config/env.js';
import { resolveSession, touchSession, type AuthenticatedPrincipal } from '../services/sessionService.js';
import { errors } from '../lib/errors.js';

export const SESSION_COOKIE = 'ledgora_session';
export const CSRF_COOKIE = 'ledgora_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

declare module 'fastify' {
  interface FastifyRequest {
    principal: AuthenticatedPrincipal | null;
  }
  interface FastifyReply {
    setSessionCookie(token: string, expiresAt: Date): void;
    clearSessionCookie(): void;
  }
}

/** CSRF token derived from the session token — no extra storage required. */
export function deriveCsrfToken(sessionToken: string, secret: string): string {
  return createHmac('sha256', secret).update(sessionToken).digest('base64url');
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

async function sessionPlugin(app: FastifyInstance, options: { config: AppConfig }): Promise<void> {
  const { config } = options;

  app.decorateRequest('principal', null);

  // One attribute set for issuing AND clearing, so a cleared cookie carries the
  // exact SameSite/Secure/Partitioned a browser needs to match and evict it.
  const cookieAttrs = {
    path: '/' as const,
    secure: config.cookie.secure,
    sameSite: config.cookie.sameSite,
    ...(config.cookie.partitioned ? { partitioned: true } : {}),
  };

  app.decorateReply('setSessionCookie', function setSessionCookie(this: FastifyReply, token: string, expiresAt: Date) {
    this.setCookie(SESSION_COOKIE, token, {
      ...cookieAttrs,
      httpOnly: true,
      expires: expiresAt,
      signed: false,
    });
    // A double-submit companion cookie. The frontend does NOT read it (it uses
    // the token returned in the response body); it exists so the server can
    // verify the header against a value the browser round-trips.
    this.setCookie(CSRF_COOKIE, deriveCsrfToken(token, config.SESSION_SECRET), {
      ...cookieAttrs,
      httpOnly: false,
      expires: expiresAt,
    });
  });

  app.decorateReply('clearSessionCookie', function clearSessionCookie(this: FastifyReply) {
    this.clearCookie(SESSION_COOKIE, { ...cookieAttrs, httpOnly: true });
    this.clearCookie(CSRF_COOKIE, { ...cookieAttrs, httpOnly: false });
  });

  // Attach the principal (if any) before routes run.
  app.addHook('onRequest', async (request: FastifyRequest) => {
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) {
      request.principal = null;
      return;
    }
    const principal = await resolveSession(app.db, token);
    request.principal = principal;
    if (principal) void touchSession(app.db, principal.sessionId);
  });

  // Double-submit CSRF check for cookie-authenticated state changes.
  app.addHook('onRequest', async (request: FastifyRequest) => {
    if (!UNSAFE_METHODS.has(request.method)) return;
    const sessionToken = request.cookies?.[SESSION_COOKIE];
    // No cookie session → nothing to forge with (login/register are protected
    // by CORS + rate limiting instead).
    if (!sessionToken) return;

    const provided = request.headers[CSRF_HEADER];
    const expected = deriveCsrfToken(sessionToken, config.SESSION_SECRET);
    if (typeof provided !== 'string' || !constantTimeEqual(provided, expected)) {
      throw errors.forbidden('Missing or invalid CSRF token.');
    }
  });
}

export default fp(sessionPlugin, { name: 'ledgora-session' });

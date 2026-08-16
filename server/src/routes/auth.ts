/**
 * Authentication routes.
 *
 * Session state lives in an HttpOnly cookie backed by a database row — never in
 * localStorage, and never in a self-describing token the client could forge.
 * `GET /api/auth/session` is the single source of truth the React app uses to
 * decide who the user is and what platform role (if any) they hold.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticate, changePassword, registerUser } from '../services/authService.js';
import { createSession, revokeAllUserSessions, revokeSession } from '../services/sessionService.js';
import { getPlatformRoles, toPublicUser } from '../services/userService.js';
import { writeAuditLog } from '../lib/audit.js';
import { errors } from '../lib/errors.js';
import { requireAuthenticatedUser } from '../guards/platform.js';
import { describeToken, redeemToken } from '../services/invitationService.js';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../lib/password.js';
import { deriveCsrfToken, CSRF_HEADER, SESSION_COOKIE } from '../plugins/session.js';

const emailSchema = z.string().trim().min(3).max(320).email('Enter a valid email address.');
const passwordSchema = z.string().min(1).max(MAX_PASSWORD_LENGTH);

const registerSchema = z.object({
  email: emailSchema,
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
  fullName: z.string().trim().min(1, 'Full name is required.').max(200),
});

const loginSchema = z.object({ email: emailSchema, password: passwordSchema });

const changePasswordSchema = z.object({
  currentPassword: passwordSchema,
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});

/**
 * Redeeming a link. The token is bounded in length so an oversized value is
 * rejected before it reaches a hash function or the database.
 */
const redeemSchema = z.object({
  token: z.string().min(1, 'The link is missing its token.').max(500),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || 'form';
      fieldErrors[key] ??= issue.message;
    }
    throw errors.validation('Please fix the highlighted fields.', { fieldErrors });
  }
  return result.data;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { config } = app;

  const requestContext = (request: { ip: string; headers: Record<string, unknown> }) => ({
    ipAddress: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  });

  /**
   * Hand the double-submit CSRF token back to the client in the response body
   * AND a header. The client keeps it in memory — it must never have to read a
   * cookie with `document.cookie`, which cannot see an API-host cookie across
   * origins. Returning the exact value the CSRF hook will expect keeps the two
   * in lockstep with no shared client-side storage.
   */
  const attachCsrf = (reply: FastifyReply, sessionToken: string): string => {
    const csrfToken = deriveCsrfToken(sessionToken, config.SESSION_SECRET);
    reply.header(CSRF_HEADER, csrfToken);
    return csrfToken;
  };

  /* ── Register ─────────────────────────────────────────────────────────── */
  app.post('/api/auth/register', async (request, reply) => {
    const input = parse(registerSchema, request.body);
    const user = await registerUser(app.db, input, requestContext(request));

    const session = await createSession(app.db, user.id, config.SESSION_TTL_HOURS, requestContext(request));
    reply.setSessionCookie(session.token, session.expiresAt);
    const csrfToken = attachCsrf(reply, session.token);

    // A new customer holds no platform role — that is only ever granted in the
    // database by an existing super_admin.
    return reply.code(201).send({ user: toPublicUser(user, []), csrfToken });
  });

  /* ── Login ────────────────────────────────────────────────────────────── */
  app.post(
    '/api/auth/login',
    {
      config: {
        rateLimit: {
          max: config.LOGIN_RATE_LIMIT_MAX,
          timeWindow: config.LOGIN_RATE_LIMIT_WINDOW_MINUTES * 60_000,
        },
      },
    },
    async (request, reply) => {
      const input = parse(loginSchema, request.body);
      const { user, platformRoles } = await authenticate(
        app.db,
        input,
        { lockThreshold: config.ACCOUNT_LOCK_THRESHOLD, lockMinutes: config.ACCOUNT_LOCK_MINUTES },
        requestContext(request),
      );

      const session = await createSession(app.db, user.id, config.SESSION_TTL_HOURS, requestContext(request));
      reply.setSessionCookie(session.token, session.expiresAt);
      const csrfToken = attachCsrf(reply, session.token);

      return reply.send({
        user: toPublicUser(user, platformRoles as never),
        mustChangePassword: user.must_change_password,
        csrfToken,
      });
    },
  );

  /* ── Current session ──────────────────────────────────────────────────── */
  app.get('/api/auth/session', async (request, reply) => {
    if (!request.principal) {
      /*
       * The browser sent a cookie that resolves to nobody — revoked by a
       * password reset or a "sign out everywhere", expired, or left over from a
       * database that no longer has the row. Expire it, so the browser stops
       * presenting a dead credential on every subsequent request.
       *
       * Safe because the answer is already "not authenticated": there is no
       * session to destroy, and `clearSessionCookie` uses the SAME
       * SameSite/Secure/Partitioned attributes the cookie was set with, which is
       * what lets a browser match and evict it. Cleanup is a convenience, not a
       * fix — `POST /api/auth/login` works whether or not it has happened, which
       * is what the CSRF hook's principal check guarantees.
       */
      if (request.cookies?.[SESSION_COOKIE]) reply.clearSessionCookie();
      return reply.send({ authenticated: false, user: null });
    }
    const { user, platformRoles } = request.principal;
    // Re-supply the CSRF token so a page that reloaded (and lost its in-memory
    // copy) can make an unsafe request again without a fresh login. The raw
    // token lives only in the HttpOnly cookie; derive the companion from it.
    const sessionToken = request.cookies?.[SESSION_COOKIE] ?? '';
    const csrfToken = sessionToken ? attachCsrf(reply, sessionToken) : null;
    return reply.send({
      authenticated: true,
      user: toPublicUser(user, platformRoles),
      csrfToken,
    });
  });

  /* ── Logout ───────────────────────────────────────────────────────────── */
  app.post('/api/auth/logout', async (request, reply) => {
    if (request.principal) {
      await revokeSession(app.db, request.principal.sessionId);
      await writeAuditLog(app.db, {
        ...requestContext(request),
        actorUserId: request.principal.user.id,
        action: 'auth.logout',
        targetType: 'session',
        targetId: request.principal.sessionId,
      });
    }
    reply.clearSessionCookie();
    return reply.send({ ok: true });
  });

  /* ── Logout everywhere ────────────────────────────────────────────────── */
  app.post('/api/auth/logout-all', { preHandler: requireAuthenticatedUser }, async (request, reply) => {
    const principal = request.principal!;
    const revoked = await revokeAllUserSessions(app.db, principal.user.id);
    await writeAuditLog(app.db, {
      ...requestContext(request),
      actorUserId: principal.user.id,
      action: 'auth.logout_all',
      targetType: 'user',
      targetId: principal.user.id,
      metadata: { revokedSessions: revoked },
    });
    reply.clearSessionCookie();
    return reply.send({ ok: true, revokedSessions: revoked });
  });

  /* ── Change password ──────────────────────────────────────────────────── */
  app.post('/api/auth/change-password', { preHandler: requireAuthenticatedUser }, async (request, reply) => {
    const principal = request.principal!;
    const input = parse(changePasswordSchema, request.body);

    await changePassword(
      app.db,
      {
        userId: principal.user.id,
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
        currentSessionId: principal.sessionId,
      },
      requestContext(request),
    );

    const roles = await getPlatformRoles(app.db, principal.user.id);
    return reply.send({ ok: true, platformRoles: roles });
  });

  /* ── Service seams (deliberately not implemented in-browser) ──────────── */

  // BACKEND SEAM: needs transactional email. The endpoint always reports
  // success so it cannot be used to discover which addresses are registered.
  app.post('/api/auth/forgot-password', async (request, reply) => {
    const input = parse(z.object({ email: emailSchema }), request.body);
    app.log.info({ email: input.email }, 'password reset requested (delivery not configured)');
    return reply.send({
      ok: true,
      message: 'If an account exists for that address, reset instructions have been sent.',
    });
  });

  /* ── Invitation / reset redemption ────────────────────────────────────── */

  /**
   * Is this link still usable?
   *
   * The "set your password" screen calls this before rendering. It consumes
   * nothing, and returns a masked address and an expiry — never the account's
   * status, never the full email, and the same negative answer for a token that
   * is expired, used, revoked or entirely invented.
   *
   * ── Why a POST for something that only reads ─────────────────────────────
   * The token must not travel in the URL. Fastify's request logging records
   * `req.url`, so a query parameter would write the live credential into the
   * server log on every call — which is exactly the disclosure the hash-only
   * storage of these tokens exists to prevent. Carrying it in the body keeps it
   * out of the log line, out of any proxy's access log, and out of the
   * `Referer` header. This is the same reason RFC 7662 makes OAuth token
   * introspection a POST.
   *
   * Rate limited on the login budget: it is an unauthenticated endpoint that
   * accepts a secret, which makes it the one place a token could be guessed at.
   */
  app.post(
    '/api/auth/invitation/inspect',
    {
      config: {
        rateLimit: {
          max: config.LOGIN_RATE_LIMIT_MAX,
          timeWindow: config.LOGIN_RATE_LIMIT_WINDOW_MINUTES * 60_000,
        },
      },
    },
    async (request, reply) => {
      const { token } = parse(z.object({ token: z.string().min(1).max(500) }), request.body ?? {});
      return reply
        // A credential-bearing response must not sit in any cache on the way back.
        .header('cache-control', 'no-store, no-cache, must-revalidate, private')
        .send(await describeToken(app.db, token));
    },
  );

  /**
   * Complete password setup from a single-use link.
   *
   * This is the redemption half of the invitation flow — the endpoint that used
   * to return 501 while three code paths were busy minting tokens for it.
   *
   * Deliberately unauthenticated: the token IS the authentication. It is also
   * deliberately rate limited on the same budget as login, because both are
   * unauthenticated endpoints that accept a secret.
   */
  app.post(
    '/api/auth/reset-password',
    {
      config: {
        rateLimit: {
          max: config.LOGIN_RATE_LIMIT_MAX,
          timeWindow: config.LOGIN_RATE_LIMIT_WINDOW_MINUTES * 60_000,
        },
      },
    },
    async (request, reply) => {
      const input = parse(redeemSchema, request.body);
      const result = await redeemToken(app.db, input, requestContext(request));
      /*
       * No session is issued here. Completing setup and signing in are separate
       * acts: the person proves they hold the link, then proves they know the
       * password they have just chosen. Handing back a session would make the
       * link alone sufficient to be logged in.
       */
      return reply.send({
        ok: true,
        email: result.email,
        purpose: result.purpose,
        message: 'Your password has been set. Sign in to continue.',
      });
    },
  );

  app.post('/api/auth/verify-email', async (_request, reply) =>
    reply.code(501).send({
      error: {
        code: 'not_implemented',
        message: 'Email verification requires the mail service, which is not configured in this deployment.',
      },
    }),
  );
}

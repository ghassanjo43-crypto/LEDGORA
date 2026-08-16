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
import { describeToken, issuePasswordResetToken, redeemToken } from '../services/invitationService.js';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../lib/password.js';
import { deriveCsrfToken, CSRF_HEADER, SESSION_COOKIE } from '../plugins/session.js';
import { buildAcceptUrl } from '../mail/invitationEmail.js';
import { renderPasswordChangedEmail, renderPasswordResetEmail } from '../mail/passwordEmails.js';

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

/**
 * The one answer `POST /api/auth/forgot-password` ever gives.
 *
 * A single constant rather than three literals, so no future edit can make the
 * "we sent it" branch read differently from the "there is nobody here" branch —
 * which is the whole security property of the endpoint.
 */
const FORGOT_PASSWORD_RESPONSE = {
  ok: true as const,
  message: 'If an account exists for that address, reset instructions have been sent.',
};

/**
 * Tell the account holder their password changed.
 *
 * BEST EFFORT, and structurally so: it is called after the change has already
 * been committed, it swallows every outcome, and nothing downstream reads its
 * result. A person who has just successfully set a password must not be told the
 * attempt failed because a mail provider was slow.
 *
 * The message carries no link and no credential, so an undelivered one costs the
 * recipient nothing beyond the notice itself.
 */
async function notifyPasswordChanged(
  app: FastifyInstance,
  input: { to: string; trigger: 'reset' | 'self_service' },
): Promise<void> {
  try {
    const rendered = renderPasswordChangedEmail({ signInUrl: `${app.config.appPublicUrl}/login` });
    const result = await app.mailer.send({ to: input.to, ...rendered });
    if (result.delivery === 'failed') {
      app.log.warn(
        { template: rendered.template, trigger: input.trigger, reason: result.error },
        'password-changed notification could not be delivered',
      );
    }
  } catch (cause) {
    // A notice is not worth an unhandled rejection on a successful change.
    app.log.warn({ trigger: input.trigger, err: cause }, 'password-changed notification threw');
  }
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

    // Best effort, and awaited only so the test seam is deterministic — the
    // helper swallows every outcome, so it cannot fail the change.
    await notifyPasswordChanged(app, { to: principal.user.email, trigger: 'self_service' });

    const roles = await getPlatformRoles(app.db, principal.user.id);
    return reply.send({ ok: true, platformRoles: roles });
  });

  /* ── Forgot password ──────────────────────────────────────────────────── */

  /**
   * Send a reset link, without ever saying whether there was anyone to send it
   * to.
   *
   * ── The non-enumeration rule, and how it is kept ─────────────────────────
   * EVERY path below returns `FORGOT_PASSWORD_RESPONSE` with status 200: the
   * address is unknown, the account is disabled, the mail provider refused, no
   * mail provider is configured at all. None of them is distinguishable by a
   * caller, because the difference between them is exactly the fact — "is there
   * an account here?" — that an unauthenticated stranger must not be able to
   * ask. The one thing that would leak it is an exception escaping to the error
   * handler as a 500, so the delivery half is wrapped.
   *
   * ── What is NOT done here ────────────────────────────────────────────────
   * No session is issued: the link proves nothing yet. The raw token is never
   * logged (`app.log` sees the recipient and the outcome only), never audited
   * and never returned in the response — the browser gets the same three fields
   * whatever happened. Only its SHA-256 digest reaches the database, via the
   * SAME `password_reset_tokens` table the invitation flow uses.
   *
   * ── Rate limiting ────────────────────────────────────────────────────────
   * A tighter budget than login. The endpoint cannot enumerate, but each
   * accepted call posts mail to a third party, so the limit is what stops it
   * being used to harass an address or to burn the sending domain's reputation.
   */
  app.post(
    '/api/auth/forgot-password',
    {
      config: {
        rateLimit: {
          max: config.FORGOT_PASSWORD_RATE_LIMIT_MAX,
          timeWindow: config.LOGIN_RATE_LIMIT_WINDOW_MINUTES * 60_000,
        },
      },
    },
    async (request, reply) => {
      const input = parse(z.object({ email: emailSchema }), request.body);

      const issued = await issuePasswordResetToken(
        app.db,
        { email: input.email, ttlMinutes: config.PASSWORD_RESET_TTL_MINUTES },
        requestContext(request),
      );

      if (!issued) {
        /*
         * No account, or one that cannot act on a link. Nothing is sent and
         * nothing is written — minting an audit row for an unknown address would
         * turn the trail itself into the oracle this response denies.
         */
        return reply.send(FORGOT_PASSWORD_RESPONSE);
      }

      try {
        const rendered = renderPasswordResetEmail({
          // The SAME redemption page the invitation link opens; the token travels
          // in the query string and is immediately POSTed to `invitation/inspect`
          // so it never reaches a server request log.
          resetUrl: buildAcceptUrl(config.appPublicUrl, issued.token),
          ttlMinutes: issued.ttlMinutes,
        });

        const result = await app.mailer.send({ to: issued.email, ...rendered });
        if (result.delivery !== 'sent') {
          /*
           * Recorded server-side so an operator can see that recovery is broken,
           * and reported to the CALLER as nothing at all. The reason is a short
           * provider-independent string; the body — which holds the live link —
           * is never touched.
           */
          app.log.warn(
            { template: rendered.template, delivery: result.delivery, reason: result.error },
            'password reset email was not delivered',
          );
        }
      } catch (cause) {
        // A provider that throws must not become a 500, which would answer a
        // question the 200 refuses to.
        app.log.error({ err: cause }, 'password reset email threw during delivery');
      }

      return reply.send(FORGOT_PASSWORD_RESPONSE);
    },
  );

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
       * Tell the account holder, for a RESET only.
       *
       * An invitation redemption is the first password the account has ever had,
       * and its holder has just been through a mail round-trip to get here — a
       * "your password was changed" notice would be noise. A reset replaces an
       * existing credential, which is precisely the event somebody needs to hear
       * about if it was not them.
       */
      if (result.purpose === 'reset') {
        await notifyPasswordChanged(app, { to: result.email, trigger: 'reset' });
      }
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

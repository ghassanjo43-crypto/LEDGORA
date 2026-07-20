/**
 * Authentication routes.
 *
 * Session state lives in an HttpOnly cookie backed by a database row — never in
 * localStorage, and never in a self-describing token the client could forge.
 * `GET /api/auth/session` is the single source of truth the React app uses to
 * decide who the user is and what platform role (if any) they hold.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, changePassword, registerUser } from '../services/authService.js';
import { createSession, revokeAllUserSessions, revokeSession } from '../services/sessionService.js';
import { getPlatformRoles, toPublicUser } from '../services/userService.js';
import { writeAuditLog } from '../lib/audit.js';
import { errors } from '../lib/errors.js';
import { requireAuthenticatedUser } from '../guards/platform.js';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../lib/password.js';

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

  /* ── Register ─────────────────────────────────────────────────────────── */
  app.post('/api/auth/register', async (request, reply) => {
    const input = parse(registerSchema, request.body);
    const user = await registerUser(app.db, input, requestContext(request));

    const session = await createSession(app.db, user.id, config.SESSION_TTL_HOURS, requestContext(request));
    reply.setSessionCookie(session.token, session.expiresAt);

    // A new customer holds no platform role — that is only ever granted in the
    // database by an existing super_admin.
    return reply.code(201).send({ user: toPublicUser(user, []) });
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

      return reply.send({
        user: toPublicUser(user, platformRoles as never),
        mustChangePassword: user.must_change_password,
      });
    },
  );

  /* ── Current session ──────────────────────────────────────────────────── */
  app.get('/api/auth/session', async (request, reply) => {
    if (!request.principal) return reply.send({ authenticated: false, user: null });
    const { user, platformRoles } = request.principal;
    return reply.send({
      authenticated: true,
      user: toPublicUser(user, platformRoles),
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

  app.post('/api/auth/reset-password', async (_request, reply) =>
    reply.code(501).send({
      error: {
        code: 'not_implemented',
        message: 'Password reset requires the mail service, which is not configured in this deployment.',
      },
    }),
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

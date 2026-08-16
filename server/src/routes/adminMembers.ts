/**
 * Administrator member routes — the cross-organization "people" surface.
 *
 * ── Authorization ────────────────────────────────────────────────────────────
 * Every route names a granular capability, checked against the DATABASE-backed
 * session (`request.principal`, resolved by the session plugin from a hashed
 * cookie). Nothing here reads a role, an organization id or a capability from the
 * request body, the query string or a header — so a browser that forges
 * `platformRole: "super_admin"` in its own state changes nothing: it never
 * reaches the server, and the server would not look at it if it did.
 *
 * The split is deliberate: `members.read` for the directory and the drawer,
 * `members.manage` for account and membership changes, and a capability of its
 * own for `members.reset_password`. A support operator can therefore diagnose an
 * account without being able to issue a credential for it.
 *
 * ── Cross-tenant safety ──────────────────────────────────────────────────────
 * These routes are the ONLY cross-tenant member surface, and no customer role
 * satisfies their guards. A subscriber managing their own colleagues uses
 * `/api/organizations/current/members` (see routes/members.ts), where the
 * organization is derived from the caller's own membership and cannot be named by
 * the client at all.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePlatformCapability } from '../guards/platform.js';
import {
  MEMBER_SORT_FIELDS,
  adminResetPassword,
  getMemberDetail,
  listAllMembers,
  revokeMemberSessions,
  setMemberAccountStatus,
  unlockMember,
  updateMembershipAsAdmin,
  verifyMemberEmail,
  type MemberAdminContext,
} from '../services/memberAdminService.js';
import { errors } from '../lib/errors.js';

const listQuery = z.object({
  search: z.string().trim().max(200).optional(),
  organizationId: z.string().uuid().optional(),
  // The full ladder, including the levels migration 006 added. `all` is the
  // "no filter" sentinel the console sends.
  role: z.enum(['all', 'owner', 'admin', 'manager', 'accountant', 'member', 'viewer']).optional(),
  accountStatus: z.enum(['all', 'active', 'disabled', 'locked', 'pending_verification']).optional(),
  membershipStatus: z.enum(['all', 'active', 'invited', 'suspended']).optional(),
  verification: z.enum(['verified', 'unverified']).optional(),
  audience: z.enum(['platform', 'customer']).optional(),
  sort: z.enum(MEMBER_SORT_FIELDS).default('created_at'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

const reasonSchema = z.object({ reason: z.string().trim().min(1, 'A reason is required.').max(1000) });

/**
 * The target of a reset, taken from the URL PATH and validated before it is used.
 *
 * Without this, a malformed id travels straight into a `WHERE id = $1` against a
 * `uuid` column, Postgres rejects the syntax, and a CLIENT error surfaces as a
 * 500. Nothing leaks — the error handler returns a generic body — but reporting
 * "the server broke" for "you sent a bad id" is wrong twice over: it tells the
 * caller nothing actionable, and it buries a real fault among routine noise in
 * whatever watches the error rate.
 *
 * Validating here also makes the refusal ORDER right: a malformed target is
 * rejected before any database work happens at all.
 */
const targetParams = z.object({
  userId: z.string().uuid('Name the user to reset, by id.'),
});

const resetSchema = z.object({
  mode: z.enum(['temporary', 'link']),
  /** Leave a deliberately disabled account disabled rather than reactivating it. */
  keepDisabled: z.boolean().optional(),
  temporaryPasswordTtlMinutes: z.coerce.number().int().min(5).max(60 * 24 * 30).optional(),
  resetLinkTtlMinutes: z.coerce.number().int().min(5).max(60 * 24 * 30).optional(),
  reason: z.string().trim().max(1000).optional(),
});

const statusSchema = z.object({
  status: z.enum(['active', 'disabled', 'locked', 'pending_verification']),
  reason: z.string().trim().min(1, 'A reason is required.').max(1000),
});

const membershipSchema = z
  .object({
    organizationId: z.string().uuid('Name the organization the membership belongs to.'),
    role: z.enum(['owner', 'admin', 'manager', 'accountant', 'member', 'viewer']).optional(),
    status: z.enum(['active', 'invited', 'suspended']).optional(),
  })
  .refine((v) => v.role !== undefined || v.status !== undefined, {
    message: 'Provide a role or a status to change.',
  });

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of result.error.issues) fieldErrors[issue.path.join('.') || 'form'] ??= issue.message;
    throw errors.validation('Please fix the highlighted fields.', { fieldErrors });
  }
  return result.data;
}

export async function adminMemberRoutes(app: FastifyInstance): Promise<void> {
  /** Actor identity for the audit trail, taken only from the verified session. */
  const adminContext = (request: {
    ip: string;
    headers: Record<string, unknown>;
    principal: { user: { id: string }; platformRoles: string[] } | null;
  }): MemberAdminContext => ({
    actorUserId: request.principal!.user.id,
    actorPlatformRole: request.principal!.platformRoles.join(',') || 'unknown',
    ipAddress: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  });

  /* ── Directory ────────────────────────────────────────────────────────── */

  app.get('/api/admin/members', { preHandler: requirePlatformCapability('members.read') }, async (request, reply) => {
    const query = parse(listQuery, request.query ?? {});
    return reply.send(await listAllMembers(app.db, query));
  });

  app.get<{ Params: { userId: string } }>(
    '/api/admin/members/:userId',
    { preHandler: requirePlatformCapability('members.read') },
    async (request, reply) => reply.send({ member: await getMemberDetail(app.db, request.params.userId) }),
  );

  /* ── Credentials ──────────────────────────────────────────────────────── */

  /**
   * Reset a password. The response is the ONLY place a generated credential ever
   * appears, so it must not be cached anywhere on the way back to the browser.
   */
  app.post<{ Params: { userId: string } }>(
    '/api/admin/members/:userId/reset-password',
    { preHandler: requirePlatformCapability('members.reset_password') },
    async (request, reply) => {
      const { userId } = parse(targetParams, request.params);
      const input = parse(resetSchema, request.body ?? {});
      const result = await adminResetPassword(
        app.db,
        {
          userId,
          ...input,
          temporaryPasswordTtlMinutes:
            input.temporaryPasswordTtlMinutes ?? app.config.TEMPORARY_PASSWORD_TTL_MINUTES,
          resetLinkTtlMinutes: input.resetLinkTtlMinutes ?? app.config.PASSWORD_RESET_TTL_MINUTES,
        },
        adminContext(request),
      );
      return reply
        .header('cache-control', 'no-store, no-cache, must-revalidate, private')
        .header('pragma', 'no-cache')
        .send(result);
    },
  );

  /* ── Account maintenance ──────────────────────────────────────────────── */

  app.post<{ Params: { userId: string } }>(
    '/api/admin/members/:userId/unlock',
    { preHandler: requirePlatformCapability('members.manage') },
    async (request, reply) => reply.send(await unlockMember(app.db, request.params.userId, adminContext(request))),
  );

  app.post<{ Params: { userId: string } }>(
    '/api/admin/members/:userId/revoke-sessions',
    { preHandler: requirePlatformCapability('members.manage') },
    async (request, reply) =>
      reply.send(await revokeMemberSessions(app.db, request.params.userId, adminContext(request))),
  );

  app.patch<{ Params: { userId: string } }>(
    '/api/admin/members/:userId/status',
    { preHandler: requirePlatformCapability('members.manage') },
    async (request, reply) => {
      const input = parse(statusSchema, request.body);
      return reply.send(
        await setMemberAccountStatus(
          app.db,
          request.params.userId,
          input.status,
          input.reason,
          adminContext(request),
        ),
      );
    },
  );

  /** Administrative email verification — confirmed by a reason, always audited. */
  app.post<{ Params: { userId: string } }>(
    '/api/admin/members/:userId/verify-email',
    { preHandler: requirePlatformCapability('members.manage') },
    async (request, reply) => {
      const { reason } = parse(reasonSchema, request.body);
      return reply.send(await verifyMemberEmail(app.db, request.params.userId, reason, adminContext(request)));
    },
  );

  /* ── Membership ───────────────────────────────────────────────────────── */

  app.patch<{ Params: { userId: string } }>(
    '/api/admin/members/:userId/membership',
    { preHandler: requirePlatformCapability('members.manage') },
    async (request, reply) => {
      const input = parse(membershipSchema, request.body);
      return reply.send(
        await updateMembershipAsAdmin(
          app.db,
          { userId: request.params.userId, ...input },
          adminContext(request),
        ),
      );
    },
  );
}

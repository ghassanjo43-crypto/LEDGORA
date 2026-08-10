/**
 * Platform user administration: creation, organization assignment, platform
 * roles, invitations and the permission matrix.
 *
 * ── Authorization ────────────────────────────────────────────────────────────
 * Every route names a capability, checked against the DATABASE-backed session.
 * Nothing here reads a role, an organization or a capability from the body, the
 * query string or a header — so a client that puts `"platformRole":"super_admin"`
 * in its own state changes nothing, because that value never reaches a decision.
 *
 * The capabilities are deliberately fine-grained: `users.create` is not implied
 * by `members.manage`, and `permissions.manage` is not implied by
 * `permissions.read`. A support operator can therefore diagnose "why can this
 * customer not post?" without being able to answer it by granting themselves the
 * permission.
 *
 * ── Mass assignment ──────────────────────────────────────────────────────────
 * Every body goes through a closed Zod schema — `.strict()` where a body carries
 * privilege — so an unexpected field is a 400 rather than something quietly
 * ignored or, worse, quietly honoured. Permission pairs are additionally checked
 * against the catalogue inside the service, which is the boundary that matters:
 * a route added later inherits it.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePlatformCapability } from '../guards/platform.js';
import {
  catalogView,
  ORGANIZATION_ROLES,
  PERMISSION_ACTIONS,
  type CatalogRole,
} from '../config/permissionCatalog.js';
import {
  applyPermissionChanges,
  resetPermissionsToRole,
  resolvePermissions,
} from '../services/permissionService.js';
import {
  assignOrganization,
  createUserAsAdmin,
  setPlatformRole,
  type UserAdminContext,
} from '../services/userAdminService.js';
import { describeToken, revokeOutstandingTokens } from '../services/invitationService.js';
import { adminResetPassword } from '../services/memberAdminService.js';
import { errors } from '../lib/errors.js';

/* ── Schemas ──────────────────────────────────────────────────────────────── */

/**
 * Roles that may be ASSIGNED. `owner` is transferred, never handed out.
 *
 * Derived from the catalogue rather than restated, and narrowed to a literal
 * tuple so Zod infers the union instead of `string` — that is what lets the
 * compiler check these values against `OrganizationRole` at the call site.
 */
type AssignableRole = Exclude<CatalogRole, 'owner'>;
const assignableRoles = ORGANIZATION_ROLES.filter(
  (role): role is AssignableRole => role !== 'owner',
) as [AssignableRole, ...AssignableRole[]];

const permissionChangeSchema = z
  .object({
    subject: z.string().trim().min(1).max(64),
    action: z.enum(PERMISSION_ACTIONS),
    effect: z.enum(['grant', 'deny', 'inherit']),
  })
  .strict();

const permissionUpdateSchema = z
  .object({
    organizationId: z.string().uuid('Name the organization these permissions apply to.'),
    changes: z.array(permissionChangeSchema).min(1).max(500),
    reason: z.string().trim().max(1000).optional(),
  })
  .strict();

const createUserSchema = z
  .object({
    fullName: z.string().trim().min(1, 'Full name is required.').max(200),
    email: z.string().trim().email('Enter a valid email address.').max(320),
    organizationId: z.string().uuid().nullish(),
    role: z.enum(assignableRoles).optional(),
    accountStatus: z.enum(['active', 'disabled', 'pending_verification']).optional(),
    membershipStatus: z.enum(['active', 'invited', 'suspended']).optional(),
    /**
     * Platform authority. Present in the schema because a super administrator
     * legitimately creates operators; the SERVICE decides whether this actor may
     * grant what is asked, and records the refusal when they may not.
     */
    platformRoles: z.array(z.enum(['super_admin', 'billing_admin', 'support'])).max(3).optional(),
    onboarding: z.enum(['invitation', 'temporary_password']),
    permissions: z.array(permissionChangeSchema).max(500).optional(),
    temporaryPasswordTtlMinutes: z.coerce.number().int().min(5).max(60 * 24 * 30).optional(),
    invitationTtlMinutes: z.coerce.number().int().min(5).max(60 * 24 * 30).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

const assignOrganizationSchema = z
  .object({
    organizationId: z.string().uuid('Choose an organization.'),
    role: z.enum(assignableRoles),
    membershipStatus: z.enum(['active', 'invited', 'suspended']).optional(),
    keepExisting: z.boolean().optional(),
    reason: z.string().trim().min(1, 'A reason is required.').max(1000),
  })
  .strict();

const platformRoleSchema = z
  .object({
    role: z.enum(['super_admin', 'billing_admin', 'support']),
    granted: z.boolean(),
    reason: z.string().trim().min(1, 'A reason is required.').max(1000),
  })
  .strict();

const reasonSchema = z.object({ reason: z.string().trim().min(1, 'A reason is required.').max(1000) });

const invitationSchema = z
  .object({
    ttlMinutes: z.coerce.number().int().min(5).max(60 * 24 * 30).optional(),
    reason: z.string().trim().max(1000).optional(),
  })
  .strict();

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of result.error.issues) fieldErrors[issue.path.join('.') || 'form'] ??= issue.message;
    throw errors.validation('Please fix the highlighted fields.', { fieldErrors });
  }
  return result.data;
}

/* ── Routes ───────────────────────────────────────────────────────────────── */

export async function adminUserRoutes(app: FastifyInstance): Promise<void> {
  /** Actor identity for the audit trail, taken only from the verified session. */
  const adminContext = (request: {
    id: string;
    ip: string;
    headers: Record<string, unknown>;
    principal: { user: { id: string }; platformRoles: string[] } | null;
  }): UserAdminContext => ({
    actorUserId: request.principal!.user.id,
    actorPlatformRole: request.principal!.platformRoles.join(',') || 'unknown',
    actorPlatformRoles: request.principal!.platformRoles,
    ipAddress: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    // Correlation id, so a permission change or a refused escalation can be tied
    // back to the exact request in the server log.
    requestId: request.id,
  });

  /* ── The catalogue ────────────────────────────────────────────────────── */

  /**
   * Subjects, actions and role templates.
   *
   * The permission matrix renders exactly this. The frontend keeps no copy, so
   * there is one list in the system and the editor cannot offer a permission the
   * resolver does not know about.
   */
  app.get(
    '/api/admin/permissions/catalog',
    { preHandler: requirePlatformCapability('permissions.read') },
    async (_request, reply) => reply.send(catalogView()),
  );

  /* ── Effective permissions ────────────────────────────────────────────── */

  app.get<{ Params: { userId: string }; Querystring: { organizationId?: string } }>(
    '/api/admin/users/:userId/permissions',
    { preHandler: requirePlatformCapability('permissions.read') },
    async (request, reply) => {
      const { organizationId } = parse(
        z.object({ organizationId: z.string().uuid('Name the organization.') }),
        request.query ?? {},
      );
      return reply.send(await resolvePermissions(app.db, request.params.userId, organizationId));
    },
  );

  app.patch<{ Params: { userId: string } }>(
    '/api/admin/users/:userId/permissions',
    { preHandler: requirePlatformCapability('permissions.manage') },
    async (request, reply) => {
      const input = parse(permissionUpdateSchema, request.body);
      return reply.send(
        await applyPermissionChanges(
          app.db,
          {
            userId: request.params.userId,
            organizationId: input.organizationId,
            changes: input.changes,
            reason: input.reason,
          },
          {
            ...adminContext(request),
            /*
             * `null` = unconstrained. Reaching this route already required
             * `permissions.manage`, which only `super_admin` holds, and a super
             * administrator holds every permission by rule 1b of the resolver —
             * so the "cannot grant what you do not hold" test would be vacuous.
             * The ORGANIZATION-ADMIN path passes a real set; see orgAdminUsers.
             */
            actorAllowedKeys: null,
          },
        ),
      );
    },
  );

  app.post<{ Params: { userId: string } }>(
    '/api/admin/users/:userId/permissions/reset',
    { preHandler: requirePlatformCapability('permissions.manage') },
    async (request, reply) => {
      const input = parse(
        z
          .object({
            organizationId: z.string().uuid('Name the organization.'),
            reason: z.string().trim().max(1000).optional(),
          })
          .strict(),
        request.body,
      );
      return reply.send(
        await resetPermissionsToRole(
          app.db,
          { userId: request.params.userId, organizationId: input.organizationId, reason: input.reason },
          { ...adminContext(request), actorAllowedKeys: null },
        ),
      );
    },
  );

  /* ── Creation ─────────────────────────────────────────────────────────── */

  /**
   * Create a user.
   *
   * The response carries the one-time credential and is the ONLY place it ever
   * appears, so it must not be cached anywhere on the way back to the browser.
   */
  app.post(
    '/api/admin/users',
    { preHandler: requirePlatformCapability('users.create') },
    async (request, reply) => {
      const input = parse(createUserSchema, request.body);
      const created = await createUserAsAdmin(
        app.db,
        {
          ...input,
          temporaryPasswordTtlMinutes:
            input.temporaryPasswordTtlMinutes ?? app.config.TEMPORARY_PASSWORD_TTL_MINUTES,
          invitationTtlMinutes: input.invitationTtlMinutes ?? app.config.PASSWORD_RESET_TTL_MINUTES,
        },
        adminContext(request),
      );
      return reply
        .header('cache-control', 'no-store, no-cache, must-revalidate, private')
        .header('pragma', 'no-cache')
        .code(201)
        .send(created);
    },
  );

  /* ── Organization assignment ──────────────────────────────────────────── */

  app.post<{ Params: { userId: string } }>(
    '/api/admin/users/:userId/organization',
    { preHandler: requirePlatformCapability('users.assign_organization') },
    async (request, reply) => {
      const input = parse(assignOrganizationSchema, request.body);
      return reply.send(
        await assignOrganization(app.db, { userId: request.params.userId, ...input }, adminContext(request)),
      );
    },
  );

  /* ── Platform authority ───────────────────────────────────────────────── */

  app.patch<{ Params: { userId: string } }>(
    '/api/admin/users/:userId/platform-role',
    // `manage-platform-roles` is the existing capability for this act; the
    // service applies the "only a super admin may grant one" rule on top.
    { preHandler: requirePlatformCapability('manage-platform-roles') },
    async (request, reply) => {
      const input = parse(platformRoleSchema, request.body);
      return reply.send(
        await setPlatformRole(app.db, { userId: request.params.userId, ...input }, adminContext(request)),
      );
    },
  );

  /* ── Invitations ──────────────────────────────────────────────────────── */

  /**
   * Issue a fresh invitation link.
   *
   * Implemented as a password RESET in `link` mode, which is the established
   * one-time-secret path — so there is one place that mints a token, one
   * envelope shape, and one dialog in the console that handles it.
   */
  app.post<{ Params: { userId: string } }>(
    '/api/admin/users/:userId/invitation',
    { preHandler: requirePlatformCapability('members.reset_password') },
    async (request, reply) => {
      const input = parse(invitationSchema, request.body ?? {});
      const result = await adminResetPassword(
        app.db,
        {
          userId: request.params.userId,
          mode: 'link',
          resetLinkTtlMinutes: input.ttlMinutes ?? app.config.PASSWORD_RESET_TTL_MINUTES,
          reason: input.reason,
        },
        adminContext(request),
      );
      return reply
        .header('cache-control', 'no-store, no-cache, must-revalidate, private')
        .header('pragma', 'no-cache')
        .send(result);
    },
  );

  /**
   * Withdraw every outstanding link without touching the password.
   *
   * POST rather than DELETE because it carries a required reason, and a DELETE
   * with a body is awkward for clients (the shared `api.del` helper sends none)
   * and inconsistently handled by intermediaries.
   */
  app.post<{ Params: { userId: string } }>(
    '/api/admin/users/:userId/invitation/revoke',
    { preHandler: requirePlatformCapability('members.reset_password') },
    async (request, reply) => {
      const { reason } = parse(reasonSchema, request.body);
      return reply.send(
        await revokeOutstandingTokens(app.db, { userId: request.params.userId, reason }, adminContext(request)),
      );
    },
  );

  /**
   * Whether an outstanding link is still live.
   *
   * Takes the token, so it can only be asked by someone who already holds it —
   * there is no endpoint that hands a stored token back. Present so the console
   * can confirm a link it has just shown is valid before an operator sends it on.
   *
   * POST, and the token rides in the body, for the same reason the public
   * endpoint does: a query parameter would be written to the server log as part
   * of `req.url`. See routes/auth.
   */
  app.post(
    '/api/admin/invitations/inspect',
    { preHandler: requirePlatformCapability('members.reset_password') },
    async (request, reply) => {
      const { token } = parse(z.object({ token: z.string().min(1).max(500) }), request.body ?? {});
      return reply
        .header('cache-control', 'no-store, no-cache, must-revalidate, private')
        .send(await describeToken(app.db, token));
    },
  );
}

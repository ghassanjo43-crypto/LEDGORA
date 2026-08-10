/**
 * User administration for an ORGANIZATION ADMIN, inside their own tenant.
 *
 * ── The one structural decision this file rests on ───────────────────────────
 * The organization is taken from the CALLER'S OWN active membership and is never
 * accepted from the request. Not from the body, not from the query, not from a
 * route parameter — there is no parameter to supply. Tenant isolation here is
 * therefore not a check that could be forgotten on a route added later; it is a
 * property of where the value comes from, and the only way to break it would be
 * to add a parameter that does not exist.
 *
 * Every route additionally re-verifies that the TARGET is a member of that same
 * organization before touching them. Two independent facts have to line up, so a
 * modified request naming another tenant's user id fails on the second even if
 * something ever went wrong with the first.
 *
 * ── What an Organization Admin structurally cannot do ────────────────────────
 *  · reach another tenant                — no parameter exists to name one;
 *  · grant platform authority            — no field exists to ask for it, and
 *                                          `platform_user_roles` is written only
 *                                          by capability-guarded operator paths;
 *  · grant a permission they lack        — `actorAllowedKeys` is their OWN
 *                                          resolved set, and the attempt is
 *                                          audited before it is refused;
 *  · open a module the tenant has not bought — rule 2 of the resolver sits above
 *                                          every user-scoped rule.
 *
 * The first two are unrepresentable rather than merely rejected, which is the
 * stronger property: there is no payload that expresses them.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOwnOrganizationPermission } from '../guards/permissions.js';
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
  ASSIGNABLE_ROLES,
  cancelInvitation,
  inviteMember,
  listMembers,
  resendInvitation,
  seatUsage,
  updateMember,
} from '../services/memberService.js';
import { errors } from '../lib/errors.js';
import { buildAcceptUrl, renderInvitationEmail } from '../mail/invitationEmail.js';
import type { MailDelivery } from '../mail/mailer.js';

/**
 * Roles an Organization Admin may assign.
 *
 * `owner` is excluded because ownership is transferred, and `admin` is excluded
 * because an Organization Admin minting more Organization Admins is lateral
 * privilege propagation — that promotion belongs to the owner or to a platform
 * operator.
 */
type AssignableRole = Exclude<CatalogRole, 'owner' | 'admin'>;
const ASSIGNABLE = ORGANIZATION_ROLES.filter(
  (role): role is AssignableRole => role !== 'owner' && role !== 'admin',
) as [AssignableRole, ...AssignableRole[]];

const permissionChangeSchema = z
  .object({
    subject: z.string().trim().min(1).max(64),
    action: z.enum(PERMISSION_ACTIONS),
    effect: z.enum(['grant', 'deny', 'inherit']),
  })
  .strict();

const updatePermissionsSchema = z
  .object({
    changes: z.array(permissionChangeSchema).min(1).max(500),
    reason: z.string().trim().max(1000).optional(),
  })
  .strict();

const updateRoleSchema = z
  .object({
    role: z.enum(ASSIGNABLE).optional(),
    status: z.enum(['active', 'invited', 'suspended']).optional(),
    reason: z.string().trim().min(1, 'A reason is required.').max(1000),
  })
  .strict()
  .refine((value) => value.role !== undefined || value.status !== undefined, {
    message: 'Provide a role or a status to change.',
  });

/**
 * Roles an Organization Admin may hand out in an invitation.
 *
 * Derived from the service's own list so the form and the enforcement cannot
 * drift: `owner` is transferred rather than assigned, and `admin` is excluded
 * because an Organization Admin minting more Organization Admins is lateral
 * privilege propagation.
 */
type InvitableRole = (typeof ASSIGNABLE_ROLES)[number];
const invitableRoles = [...ASSIGNABLE_ROLES] as [InvitableRole, ...InvitableRole[]];

const inviteSchema = z
  .object({
    fullName: z.string().trim().min(1, 'Full name is required.').max(200),
    email: z.string().trim().email('Enter a valid email address.').max(320),
    role: z.enum(invitableRoles),
    /**
     * How the person gets their first credential. `invitation` is the default
     * and the recommended path — nobody, including the administrator, ever
     * learns the password.
     */
    onboarding: z.enum(['invitation', 'temporary_password']).optional(),
    /**
     * Required for `temporary_password`. Validated against the CANONICAL policy
     * and hashed inside the service; the plaintext is never stored, never
     * logged (`req.body.temporaryPassword` is redacted) and never returned.
     */
    temporaryPassword: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((v) => v.onboarding !== 'temporary_password' || Boolean(v.temporaryPassword), {
    message: 'Enter a temporary password, or choose to send an invitation link instead.',
    path: ['temporaryPassword'],
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


/**
 * Decide what may leave the process.
 *
 * THE boundary for invitation tokens. The service always mints one; this is the
 * only place that decides whether it reaches a client, and it says no unless a
 * development deployment has explicitly opted in. Production cannot opt in —
 * `loadConfig` refuses to boot with the flag set.
 */
function presentInvitation<T extends { invitationToken?: string }>(
  result: T,
  exposeTokens: boolean,
): T & { developmentOnlyLink: boolean } {
  if (exposeTokens) {
    // Flagged so the UI is obliged to label it, rather than showing a live
    // credential as though it were ordinary data.
    return { ...result, developmentOnlyLink: true };
  }
  const { invitationToken: _withheld, ...rest } = result;
  void _withheld;
  return { ...(rest as T), developmentOnlyLink: false };
}


/**
 * Deliver an invitation, and report what actually happened.
 *
 * ── Why delivery is separate from creation ───────────────────────────────────
 * The membership and its token are already committed by the time this runs. A
 * mail failure therefore does NOT undo the invitation: the seat stays reserved,
 * the membership stays pending, and the administrator can resend later without
 * consuming a second seat or creating a second membership. Rolling the
 * membership back on a provider outage would be the worse failure — the operator
 * would have to redo the work, and a retry storm would churn seats.
 *
 * The link is built here, handed to the mailer, and dropped. It is not returned,
 * not logged and not audited.
 */
async function deliverInvitation(
  app: FastifyInstance,
  input: {
    token: string;
    recipientEmail: string;
    recipientName: string;
    organizationName: string;
    inviterName?: string | null;
    roleLabel: string;
    expiresAt: string;
    isResend?: boolean;
  },
): Promise<MailDelivery> {
  const rendered = renderInvitationEmail({
    recipientName: input.recipientName,
    organizationName: input.organizationName,
    inviterName: input.inviterName ?? null,
    roleLabel: input.roleLabel,
    acceptUrl: buildAcceptUrl(app.config.FRONTEND_URL, input.token),
    expiresAt: new Date(input.expiresAt),
    isResend: input.isResend,
  });

  const result = await app.mailer.send({ to: input.recipientEmail, ...rendered });
  if (result.delivery === 'failed') {
    // The reason only — never the body, which contains the acceptance link.
    app.log.warn(
      { template: rendered.template, reason: result.error },
      'invitation email delivery failed',
    );
  }
  return result.delivery;
}

export async function orgAdminUserRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The guard resolves the caller's permissions and stashes them on the request.
   * Reusing that resolution — rather than repeating it — is what keeps the
   * authorization decision and the "can they grant this?" decision consistent.
   */
  const manageUsers = requireOwnOrganizationPermission('user_administration', 'manage_users');
  const viewUsers = requireOwnOrganizationPermission('user_administration', 'view');

  /**
   * The caller's own organization, from the resolution the guard already did.
   *
   * Never a request value. If this is ever null the guard did not run, which is
   * a programming error rather than an authorization decision — so it throws
   * rather than falling back to something permissive.
   */
  const ownOrganization = (request: { permissions: { organizationId: string } | null }): string => {
    if (!request.permissions) throw errors.forbidden('You do not have access to this organization.');
    return request.permissions.organizationId;
  };

  /** The target must be a member of the CALLER'S organization. The second fact. */
  const requireSameTenant = async (organizationId: string, userId: string): Promise<{ role: string }> => {
    const membership = await app.db
      .selectFrom('organization_memberships')
      .select(['role', 'status'])
      .where('organization_id', '=', organizationId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    /*
     * 404, not 403. A user outside this tenant must be indistinguishable from a
     * user that does not exist — answering "forbidden" would confirm the id
     * belongs to somebody, which is a cross-tenant disclosure in itself.
     */
    if (!membership) throw errors.notFound('Member');
    return { role: membership.role };
  };

  const actorContext = (request: {
    ip: string;
    headers: Record<string, unknown>;
    principal: { user: { id: string } } | null;
    permissions: { allowedKeys: string[] } | null;
  }) => ({
    actorUserId: request.principal!.user.id,
    // An Organization Admin is a customer, not a platform operator. Recording a
    // platform role here would misattribute the act in the audit trail.
    actorPlatformRole: null,
    ipAddress: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    /** Their OWN resolved rights — the ceiling on what they can hand out. */
    actorAllowedKeys: new Set(request.permissions!.allowedKeys) as ReadonlySet<string>,
  });

  /* ── The catalogue ────────────────────────────────────────────────────── */

  /**
   * The same catalogue the platform console uses. Served here too so an
   * Organization Admin gets the identical matrix without needing an operator
   * capability — there is one definition of what a permission is.
   */
  app.get(
    '/api/organizations/current/permissions/catalog',
    { preHandler: viewUsers },
    async (_request, reply) => reply.send(catalogView()),
  );

  /* ── Seats ────────────────────────────────────────────────────────────── */

  /**
   * Seat usage for the caller's own organization.
   *
   * The SAME `seatUsage` the invitation path enforces under its row lock, so
   * what this screen shows and what the server refuses cannot disagree.
   */
  app.get('/api/organizations/current/seats', { preHandler: viewUsers }, async (request, reply) =>
    reply.send({ seats: await seatUsage(app.db, ownOrganization(request)) }),
  );

  /* ── Invitations ──────────────────────────────────────────────────────── */

  /**
   * Invite somebody into the caller's OWN organization.
   *
   * The organization is derived, never supplied — so there is no parameter for a
   * modified request to point at another tenant. Seat limits, lifecycle state
   * and duplicate membership are all enforced inside one locked transaction; see
   * `services/memberService.inviteMember`.
   *
   * The response carries the single-use invitation token, which exists in this
   * response and nowhere else. It must not be cached on the way back.
   */
  app.post('/api/organizations/current/users/invite', { preHandler: manageUsers }, async (request, reply) => {
    const organizationId = ownOrganization(request);
    const input = parse(inviteSchema, request.body);
    const result = await inviteMember(
      app.db,
      { organizationId, ...input, invitationTtlMinutes: app.config.PASSWORD_RESET_TTL_MINUTES },
      {
        actorUserId: request.principal!.user.id,
        // A customer administrator is not a platform operator.
        actorPlatformRole: null,
        ipAddress: request.ip,
        userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
        requestId: request.id,
      },
    );
    const organization = await app.db
      .selectFrom('organizations')
      .select('legal_name')
      .where('id', '=', organizationId)
      .executeTakeFirstOrThrow();

    const delivery = await deliverInvitation(app, {
      token: result.invitationToken!,
      recipientEmail: result.member.email,
      recipientName: result.member.fullName,
      organizationName: organization.legal_name,
      inviterName: request.principal!.user.full_name,
      roleLabel: result.member.role,
      expiresAt: result.expiresAt,
    });

    return reply
      .header('cache-control', 'no-store, no-cache, must-revalidate, private')
      .header('pragma', 'no-cache')
      .code(201)
      .send(presentInvitation({ ...result, delivery }, app.config.EXPOSE_INVITATION_TOKENS));
  });

  app.post<{ Params: { userId: string } }>(
    '/api/organizations/current/users/:userId/resend-invitation',
    { preHandler: manageUsers },
    async (request, reply) => {
      const organizationId = ownOrganization(request);
      await requireSameTenant(organizationId, request.params.userId);
      const result = await resendInvitation(
        app.db,
        {
          organizationId,
          userId: request.params.userId,
          invitationTtlMinutes: app.config.PASSWORD_RESET_TTL_MINUTES,
        },
        {
          actorUserId: request.principal!.user.id,
          actorPlatformRole: null,
          ipAddress: request.ip,
          userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
          requestId: request.id,
        },
      );
      const [organization, member] = await Promise.all([
        app.db
          .selectFrom('organizations')
          .select('legal_name')
          .where('id', '=', organizationId)
          .executeTakeFirstOrThrow(),
        app.db
          .selectFrom('organization_memberships')
          .innerJoin('users', 'users.id', 'organization_memberships.user_id')
          .select(['users.email', 'users.full_name', 'organization_memberships.role'])
          .where('organization_memberships.organization_id', '=', organizationId)
          .where('organization_memberships.user_id', '=', request.params.userId)
          .executeTakeFirstOrThrow(),
      ]);

      /*
       * `isResend` tells the recipient plainly that any earlier link has stopped
       * working — which it has: `resendInvitation` revoked every outstanding
       * token before minting this one, so retries cannot leave a stack of
       * parallel valid links.
       */
      const delivery = await deliverInvitation(app, {
        token: result.invitationToken,
        recipientEmail: member.email,
        recipientName: member.full_name,
        organizationName: organization.legal_name,
        inviterName: request.principal!.user.full_name,
        roleLabel: member.role,
        expiresAt: result.expiresAt,
        isResend: true,
      });

      return reply
        .header('cache-control', 'no-store, no-cache, must-revalidate, private')
        .send(presentInvitation({ ...result, delivery }, app.config.EXPOSE_INVITATION_TOKENS));
    },
  );

  app.post<{ Params: { userId: string } }>(
    '/api/organizations/current/users/:userId/cancel-invitation',
    { preHandler: manageUsers },
    async (request, reply) => {
      const organizationId = ownOrganization(request);
      await requireSameTenant(organizationId, request.params.userId);
      return reply.send(
        await cancelInvitation(
          app.db,
          { organizationId, userId: request.params.userId },
          {
            actorUserId: request.principal!.user.id,
            actorPlatformRole: null,
            ipAddress: request.ip,
            userAgent:
              typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
            requestId: request.id,
          },
        ),
      );
    },
  );

  /* ── Directory ────────────────────────────────────────────────────────── */

  app.get('/api/organizations/current/users', { preHandler: viewUsers }, async (request, reply) => {
    const organizationId = ownOrganization(request);
    return reply.send({
      organizationId,
      members: await listMembers(app.db, organizationId),
      // Shipped with the roster so the page never renders a member list and a
      // seat counter that were read at different moments.
      seats: await seatUsage(app.db, organizationId),
    });
  });

  app.get<{ Params: { userId: string } }>(
    '/api/organizations/current/users/:userId/permissions',
    { preHandler: viewUsers },
    async (request, reply) => {
      const organizationId = ownOrganization(request);
      await requireSameTenant(organizationId, request.params.userId);
      return reply.send(await resolvePermissions(app.db, request.params.userId, organizationId));
    },
  );

  /* ── Permission changes ───────────────────────────────────────────────── */

  app.patch<{ Params: { userId: string } }>(
    '/api/organizations/current/users/:userId/permissions',
    { preHandler: manageUsers },
    async (request, reply) => {
      const organizationId = ownOrganization(request);
      const input = parse(updatePermissionsSchema, request.body);
      await requireSameTenant(organizationId, request.params.userId);

      return reply.send(
        await applyPermissionChanges(
          app.db,
          {
            userId: request.params.userId,
            organizationId,
            changes: input.changes,
            reason: input.reason,
          },
          actorContext(request),
        ),
      );
    },
  );

  app.post<{ Params: { userId: string } }>(
    '/api/organizations/current/users/:userId/permissions/reset',
    { preHandler: manageUsers },
    async (request, reply) => {
      const organizationId = ownOrganization(request);
      const input = parse(
        z.object({ reason: z.string().trim().max(1000).optional() }).strict(),
        request.body ?? {},
      );
      await requireSameTenant(organizationId, request.params.userId);

      return reply.send(
        await resetPermissionsToRole(
          app.db,
          { userId: request.params.userId, organizationId, reason: input.reason },
          actorContext(request),
        ),
      );
    },
  );

  /* ── Role and membership status ───────────────────────────────────────── */

  app.patch<{ Params: { userId: string } }>(
    '/api/organizations/current/users/:userId',
    { preHandler: manageUsers },
    async (request, reply) => {
      const organizationId = ownOrganization(request);
      const input = parse(updateRoleSchema, request.body);
      const target = await requireSameTenant(organizationId, request.params.userId);

      /*
       * Self first. An admin editing themselves is also an admin editing an
       * admin, so checking the peer rule first would answer "only the owner can
       * change this member" — true, but not the useful thing to say to someone
       * who has just tried to change their own role.
       */
      if (request.params.userId === request.principal!.user.id) {
        throw errors.validation('You cannot change your own role or status.');
      }
      /*
       * An Organization Admin may not act on an owner or on another admin.
       * Both would be lateral or upward moves against a peer, and the second is
       * how "admin demotes every other admin" becomes a takeover.
       */
      if (target.role === 'owner' || target.role === 'admin') {
        throw errors.forbidden(
          'Only the organization owner or a platform administrator can change this member.',
        );
      }

      const member = await updateMember(
        app.db,
        { organizationId, userId: request.params.userId, role: input.role as never, status: input.status },
        {
          actorUserId: request.principal!.user.id,
          actorPlatformRole: null,
          ipAddress: request.ip,
          userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
        },
      );
      return reply.send({ member });
    },
  );
}

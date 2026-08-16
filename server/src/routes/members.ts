/**
 * Member management, in the TWO contexts Ledgora has — and no third.
 *
 *   subscriber : `/api/organizations/current/members`
 *                The organization is derived from the caller's own active
 *                membership. No organization id is accepted from the client, so
 *                there is nothing to tamper with.
 *
 *   operator   : `/api/admin/organizations/:organizationId/members[...]`
 *                The organization id IS in the URL, so it is authorized
 *                explicitly: a backend-verified platform capability, plus the
 *                organization must exist. A tenant calling these gets 403 from
 *                the capability guard — being able to type an id buys nothing.
 *
 * The operator path exists because a platform administrator is deliberately
 * TENANTLESS. Asking "what is the caller's organization?" is the wrong question
 * for them — it is correctly null — and answering it with "then create one" is
 * the defect this route pair fixes. The administrator never gains a membership:
 * see `services/memberService`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuthenticatedUser, requirePlatformCapability } from '../guards/platform.js';
import { findMembershipForUser } from '../services/organizationService.js';
import {
  cancelInvitation,
  countSeats,
  inviteMember,
  listMembers,
  removeMember,
  requireOrganization,
  resendInvitation,
  seatLimit,
  seatUsage,
  updateMember,
} from '../services/memberService.js';
import { errors } from '../lib/errors.js';
import { buildAcceptUrl, renderInvitationEmail } from '../mail/invitationEmail.js';
import type { MailDelivery } from '../mail/mailer.js';

const inviteSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.').max(200),
  fullName: z.string().trim().min(1, 'Full name is required.').max(200),
  // `owner` and `admin` are absent: ownership is transferred, and minting an
  // Organization Admin through an invite would be lateral privilege propagation.
  role: z.enum(['manager', 'accountant', 'member', 'viewer']),
});

const updateSchema = z
  .object({
    role: z.enum(['owner', 'admin', 'manager', 'accountant', 'member', 'viewer']).optional(),
    status: z.enum(['active', 'invited', 'suspended']).optional(),
  })
  .refine((v) => v.role !== undefined || v.status !== undefined, {
    message: 'Provide a role or a status to change.',
  });

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of result.error.issues) {
      fieldErrors[issue.path.join('.') || 'form'] ??= issue.message;
    }
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
    // `appPublicUrl`, not `FRONTEND_URL`: the latter is a CORS allow-list that
    // may hold several origins, and a link has to name exactly one.
    acceptUrl: buildAcceptUrl(app.config.appPublicUrl, input.token),
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

export async function memberRoutes(app: FastifyInstance): Promise<void> {
  const context = (request: { ip: string; headers: Record<string, unknown> }) => ({
    ipAddress: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  });

  /* ── Subscriber: the caller's OWN organization ─────────────────────────── */

  app.get('/api/organizations/current/members', { preHandler: requireAuthenticatedUser }, async (request, reply) => {
    const membership = await findMembershipForUser(app.db, request.principal!.user.id);
    // A caller with no membership genuinely has no members to list. This is the
    // ONLY context in which "create your organization first" is the right answer.
    if (!membership) {
      return reply.send({ organizationId: null, members: [], seatsUsed: 0, seatLimit: null, role: null });
    }
    const organizationId = membership.organizationId;
    return reply.send({
      organizationId,
      members: await listMembers(app.db, organizationId),
      seatsUsed: await countSeats(app.db, organizationId),
      seatLimit: await seatLimit(app.db, organizationId),
      role: membership.role,
    });
  });

  /* ── Operator: an explicitly named organization ────────────────────────── */

  app.get<{ Params: { organizationId: string } }>(
    '/api/admin/organizations/:organizationId/members',
    { preHandler: requirePlatformCapability('view-admin') },
    async (request, reply) => {
      const { organizationId } = request.params;
      const organization = await requireOrganization(app.db, organizationId);
      return reply.send({
        organizationId,
        organization: { id: organization.id, legalName: organization.legalName, status: organization.status },
        members: await listMembers(app.db, organizationId),
        seatsUsed: await countSeats(app.db, organizationId),
        seatLimit: await seatLimit(app.db, organizationId),
      });
    },
  );

  app.post<{ Params: { organizationId: string } }>(
    '/api/admin/organizations/:organizationId/members/invite',
    // Creating an account inside someone else's tenant is a user-management act.
    { preHandler: requirePlatformCapability('manage-users') },
    async (request, reply) => {
      const input = parse(inviteSchema, request.body);
      const result = await inviteMember(
        app.db,
        {
          organizationId: request.params.organizationId,
          ...input,
          invitationTtlMinutes: app.config.PASSWORD_RESET_TTL_MINUTES,
        },
        {
          ...context(request),
          actorUserId: request.principal!.user.id,
          actorPlatformRole: request.principal!.platformRoles.join(',') || null,
        },
      );
      const organization = await requireOrganization(app.db, request.params.organizationId);
      const delivery = await deliverInvitation(app, {
        token: result.invitationToken!,
        recipientEmail: result.member.email,
        recipientName: result.member.fullName,
        organizationName: organization.legalName,
        inviterName: request.principal!.user.full_name,
        roleLabel: result.member.role,
        expiresAt: result.expiresAt,
      });

      /*
       * The invitation token appears in THIS response and nowhere else — only
       * its digest is stored — so the response must not be cached on the way
       * back to the browser. `presentInvitation` decides whether it may appear
       * at all; production never lets it.
       */
      return reply
        .header('cache-control', 'no-store, no-cache, must-revalidate, private')
        .header('pragma', 'no-cache')
        .code(201)
        .send(presentInvitation({ ...result, delivery }, app.config.EXPOSE_INVITATION_TOKENS));
    },
  );

  /**
   * Seat usage for an explicitly named subscriber.
   *
   * The SAME `seatUsage` the subscriber workspace reads and the invitation path
   * enforces under its row lock. The operator console previously decomposed
   * these figures from the roster in the browser, which is a second calculation
   * that can disagree with the one that actually refuses an invitation.
   */
  app.get<{ Params: { organizationId: string } }>(
    '/api/admin/organizations/:organizationId/seats',
    { preHandler: requirePlatformCapability('view-admin') },
    async (request, reply) => {
      await requireOrganization(app.db, request.params.organizationId);
      return reply.send({ seats: await seatUsage(app.db, request.params.organizationId) });
    },
  );

  /**
   * Resend a pending invitation for a named subscriber.
   *
   * ── Why this exists beside the subscriber route ──────────────────────────
   * The subscriber path derives its organization from the CALLER'S membership,
   * which a platform operator correctly does not have. Reusing it would have
   * required impersonating the customer or mutating a "current organization" —
   * both of which replace an explicit, auditable target with an implicit one.
   * This route names the organization in the URL and is reachable only behind a
   * platform capability no customer role satisfies.
   *
   * The service verifies the membership belongs to THAT organization and
   * revokes every outstanding token before minting a new one, so a cross-tenant
   * membership id resolves to 404 and prior links stop working.
   */
  app.post<{ Params: { organizationId: string; userId: string } }>(
    '/api/admin/organizations/:organizationId/members/:userId/resend-invitation',
    { preHandler: requirePlatformCapability('manage-users') },
    async (request, reply) => {
      await requireOrganization(app.db, request.params.organizationId);
      const result = await resendInvitation(
        app.db,
        {
          organizationId: request.params.organizationId,
          userId: request.params.userId,
          invitationTtlMinutes: app.config.PASSWORD_RESET_TTL_MINUTES,
        },
        {
          ...context(request),
          actorUserId: request.principal!.user.id,
          actorPlatformRole: request.principal!.platformRoles.join(',') || null,
          requestId: request.id,
        },
      );

      const member = await app.db
        .selectFrom('organization_memberships')
        .innerJoin('users', 'users.id', 'organization_memberships.user_id')
        .select(['users.email', 'users.full_name', 'organization_memberships.role'])
        .where('organization_memberships.organization_id', '=', request.params.organizationId)
        .where('organization_memberships.user_id', '=', request.params.userId)
        .executeTakeFirstOrThrow();
      const organization = await requireOrganization(app.db, request.params.organizationId);

      const delivery = await deliverInvitation(app, {
        token: result.invitationToken,
        recipientEmail: member.email,
        recipientName: member.full_name,
        organizationName: organization.legalName,
        inviterName: request.principal!.user.full_name,
        roleLabel: member.role,
        expiresAt: result.expiresAt,
        isResend: true,
      });

      // `presentInvitation` strips the raw token unless a development
      // deployment has explicitly opted in; production cannot.
      return reply
        .header('cache-control', 'no-store, no-cache, must-revalidate, private')
        .header('pragma', 'no-cache')
        .send(presentInvitation({ ...result, delivery }, app.config.EXPOSE_INVITATION_TOKENS));
    },
  );

  /** Withdraw a pending invitation for a named subscriber. Releases its seat. */
  app.post<{ Params: { organizationId: string; userId: string } }>(
    '/api/admin/organizations/:organizationId/members/:userId/cancel-invitation',
    { preHandler: requirePlatformCapability('manage-users') },
    async (request, reply) => {
      await requireOrganization(app.db, request.params.organizationId);
      return reply.send(
        await cancelInvitation(
          app.db,
          { organizationId: request.params.organizationId, userId: request.params.userId },
          {
            ...context(request),
            actorUserId: request.principal!.user.id,
            actorPlatformRole: request.principal!.platformRoles.join(',') || null,
            requestId: request.id,
          },
        ),
      );
    },
  );

  app.patch<{ Params: { organizationId: string; userId: string } }>(
    '/api/admin/organizations/:organizationId/members/:userId',
    { preHandler: requirePlatformCapability('manage-users') },
    async (request, reply) => {
      const input = parse(updateSchema, request.body);
      const member = await updateMember(
        app.db,
        { organizationId: request.params.organizationId, userId: request.params.userId, ...input },
        {
          ...context(request),
          actorUserId: request.principal!.user.id,
          actorPlatformRole: request.principal!.platformRoles.join(',') || null,
        },
      );
      return reply.send({ member });
    },
  );

  app.delete<{ Params: { organizationId: string; userId: string } }>(
    '/api/admin/organizations/:organizationId/members/:userId',
    { preHandler: requirePlatformCapability('manage-users') },
    async (request, reply) => {
      await removeMember(
        app.db,
        { organizationId: request.params.organizationId, userId: request.params.userId },
        {
          ...context(request),
          actorUserId: request.principal!.user.id,
          actorPlatformRole: request.principal!.platformRoles.join(',') || null,
        },
      );
      return reply.send({ removed: true });
    },
  );
}

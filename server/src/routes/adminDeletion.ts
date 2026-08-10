/**
 * Removal, archival and deletion routes.
 *
 * ── Five capabilities, not one "delete" ──────────────────────────────────────
 * The guards mirror how different these acts actually are:
 *
 *   members.remove        reversible, routine       super_admin + billing_admin
 *   subscribers.archive   reversible, retains all   super_admin + billing_admin
 *   members.delete        irreversible              super_admin
 *   applicants.delete     irreversible              super_admin
 *   subscribers.delete    irreversible              super_admin
 *
 * `support` holds none of them, so a support operator can read every roster and
 * change nothing — which is the intended shape of that role.
 *
 * ── Eligibility is never taken from the request ──────────────────────────────
 * The impact endpoints are reads that recompute from scratch. The DELETE handlers
 * ignore whatever the client believes and re-run the same assessment inside their
 * own transaction, under row locks (see `deletionService`). A browser that posts
 * `deletionPermitted: true` achieves nothing: that field is never parsed.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePlatformCapability } from '../guards/platform.js';
import {
  archiveSubscriber,
  assessMemberDeletion,
  assessSubscriberDeletion,
  deleteAccount,
  deleteApplicant,
  disableAccount,
  purgeSubscriber,
  removeMemberFromOrganization,
  restoreSubscriber,
  setLegalHold,
  type DeletionAdminContext,
} from '../services/deletionService.js';
import { errors } from '../lib/errors.js';

const reasonSchema = z.object({ reason: z.string().trim().min(1, 'A reason is required.').max(1000) });

const removeSchema = z.object({
  organizationId: z.string().uuid('Name the organization to remove them from.'),
  reason: z.string().trim().min(1, 'A reason is required.').max(1000),
});

const deleteAccountSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required.').max(1000),
  /** Typed confirmation. Verified against the stored email, server-side. */
  expectedEmail: z.string().trim().max(320).optional(),
});

const purgeSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required.').max(1000),
  /** Typed confirmation. Verified against the stored legal name, server-side. */
  confirmationName: z.string().trim().min(1, 'Type the organization name to confirm.').max(200),
});

const legalHoldSchema = z.object({
  hold: z.boolean(),
  reason: z.string().trim().min(1, 'A reason is required.').max(1000),
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

export async function adminDeletionRoutes(app: FastifyInstance): Promise<void> {
  const adminContext = (request: {
    id: string;
    ip: string;
    headers: Record<string, unknown>;
    principal: { user: { id: string }; platformRoles: string[] } | null;
  }): DeletionAdminContext => ({
    actorUserId: request.principal!.user.id,
    actorPlatformRole: request.principal!.platformRoles.join(',') || 'unknown',
    ipAddress: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    // Correlation id, so a refused purge in the audit trail can be tied back to
    // the exact request in the server log.
    requestId: request.id,
  });

  /* ══ Members ════════════════════════════════════════════════════════════ */

  /** Remove from ONE organization. The account and its history survive. */
  app.post<{ Params: { userId: string } }>(
    '/api/admin/members/:userId/remove',
    { preHandler: requirePlatformCapability('members.remove') },
    async (request, reply) => {
      const input = parse(removeSchema, request.body);
      return reply.send(
        await removeMemberFromOrganization(app.db, { userId: request.params.userId, ...input }, adminContext(request)),
      );
    },
  );

  /** The reversible alternative to deletion. */
  app.post<{ Params: { userId: string } }>(
    '/api/admin/members/:userId/disable',
    { preHandler: requirePlatformCapability('members.manage') },
    async (request, reply) => {
      const { reason } = parse(reasonSchema, request.body);
      return reply.send(await disableAccount(app.db, { userId: request.params.userId, reason }, adminContext(request)));
    },
  );

  /**
   * What deleting this account would do. A read — the UI uses it to decide whether
   * to offer the control at all, and the DELETE handler recomputes it regardless.
   */
  app.get<{ Params: { userId: string } }>(
    '/api/admin/members/:userId/deletion-impact',
    { preHandler: requirePlatformCapability('members.read') },
    async (request, reply) =>
      reply.send({ impact: await assessMemberDeletion(app.db, request.params.userId) }),
  );

  app.delete<{ Params: { userId: string } }>(
    '/api/admin/members/:userId',
    { preHandler: requirePlatformCapability('members.delete') },
    async (request, reply) => {
      const input = parse(deleteAccountSchema, request.body ?? {});
      return reply.send(await deleteAccount(app.db, { userId: request.params.userId, ...input }, adminContext(request)));
    },
  );

  /* ══ Applicants ═════════════════════════════════════════════════════════ */

  /**
   * Delete an unused applicant, including the empty organization shell they may
   * have created. Refuses outright if that organization turns out to hold anything.
   */
  app.delete<{ Params: { userId: string } }>(
    '/api/admin/applicants/:userId',
    { preHandler: requirePlatformCapability('applicants.delete') },
    async (request, reply) => {
      const input = parse(deleteAccountSchema, request.body ?? {});
      return reply.send(await deleteApplicant(app.db, { userId: request.params.userId, ...input }, adminContext(request)));
    },
  );

  /* ══ Subscribers ════════════════════════════════════════════════════════ */

  /** The NORMAL way to retire a subscriber. Reversible; retains everything. */
  app.post<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/archive',
    { preHandler: requirePlatformCapability('subscribers.archive') },
    async (request, reply) => {
      const { reason } = parse(reasonSchema, request.body);
      return reply.send(
        await archiveSubscriber(app.db, { organizationId: request.params.organizationId, reason }, adminContext(request)),
      );
    },
  );

  app.post<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/restore',
    { preHandler: requirePlatformCapability('subscribers.archive') },
    async (request, reply) => {
      const { reason } = parse(reasonSchema, request.body);
      return reply.send(
        await restoreSubscriber(app.db, { organizationId: request.params.organizationId, reason }, adminContext(request)),
      );
    },
  );

  /**
   * The eligibility assessment. The console MUST call this before offering the
   * permanent-deletion control, and must render `serverVerifiable: false` rows as
   * "cannot be verified here" rather than as zero.
   */
  app.get<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/deletion-impact',
    { preHandler: requirePlatformCapability('subscribers.read') },
    async (request, reply) =>
      reply.send({ impact: await assessSubscriberDeletion(app.db, request.params.organizationId) }),
  );

  app.delete<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId',
    { preHandler: requirePlatformCapability('subscribers.delete') },
    async (request, reply) => {
      const input = parse(purgeSchema, request.body ?? {});
      return reply.send(
        await purgeSubscriber(app.db, { organizationId: request.params.organizationId, ...input }, adminContext(request)),
      );
    },
  );

  /** A hard block that no eligibility calculation may override. */
  app.patch<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/legal-hold',
    { preHandler: requirePlatformCapability('subscribers.manage') },
    async (request, reply) => {
      const input = parse(legalHoldSchema, request.body);
      return reply.send(
        await setLegalHold(app.db, { organizationId: request.params.organizationId, ...input }, adminContext(request)),
      );
    },
  );
}

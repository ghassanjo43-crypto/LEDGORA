/**
 * Subscriber closure and data export routes.
 *
 * ── Where the organization comes from ────────────────────────────────────────
 * The route parameter, resolved against the `organizations` table before
 * anything is done with it. That is safe here for the same reason it is safe on
 * the other operator surfaces: every route below sits behind a platform
 * capability that no customer role satisfies, so being able to type an id buys
 * nothing. A customer reaching for these gets 403 from the guard, before the id
 * is looked at.
 *
 * ── Why the destructive routes take a password ───────────────────────────────
 * Requesting a purge schedules the irreversible destruction of a tenant's
 * records. A live session proves someone signed in on this browser at some
 * point; it does not prove the person at the keyboard is the operator. The
 * step-up check is performed in `lib/reauthentication` against the ACTING
 * operator's stored digest, and the password is never stored, logged (it is in
 * the logger's redact list) or echoed back.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePlatformCapability } from '../guards/platform.js';
import {
  assessSubscriberDeletion,
  restoreSubscriber,
  type DeletionAdminContext,
} from '../services/deletionService.js';
import {
  assertRestorable,
  cancelSubscriberDeletion,
  getClosureStatus,
  listDueDeletions,
  processDueDeletions,
  requestSubscriberDeletion,
} from '../services/subscriberClosureService.js';
import {
  createSubscriberExport,
  downloadSubscriberExport,
  listSubscriberExports,
  revokeSubscriberExport,
} from '../services/subscriberExportService.js';
import { errors } from '../lib/errors.js';

const reasonSchema = z.object({ reason: z.string().trim().min(1, 'A reason is required.').max(1000) });

/**
 * The deletion request. `.strict()` so an unexpected field is a 400 rather than
 * something quietly ignored on the most destructive endpoint in the system.
 */
const requestDeletionSchema = z
  .object({
    reason: z.string().trim().min(1, 'A reason is required.').max(1000),
    /** The typed organization name or owner email. Checked against the database. */
    confirmation: z.string().trim().min(1, 'Type the organization name to confirm.').max(400),
    /** The acting operator's own password. Verified server-side, never stored. */
    password: z.string().min(1, 'Confirm your password to continue.').max(200),
    recoveryDays: z.coerce.number().int().min(1).max(365).optional(),
  })
  .strict();

const exportSchema = z
  .object({ ttlMinutes: z.coerce.number().int().min(5).max(60 * 24 * 30).optional() })
  .strict();

const downloadSchema = z.object({ token: z.string().min(1).max(500) }).strict();

const processSchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).optional() })
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

export async function adminClosureRoutes(app: FastifyInstance): Promise<void> {
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
    requestId: request.id,
  });

  /* ══ Closure status ═════════════════════════════════════════════════════ */

  /**
   * Everything the action menu needs: current status, schedule, legal hold, and
   * which actions are currently offerable.
   */
  app.get<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/closure',
    { preHandler: requirePlatformCapability('subscribers.read') },
    async (request, reply) =>
      reply.send({ closure: await getClosureStatus(app.db, request.params.organizationId) }),
  );

  /* ══ Pending deletion ═══════════════════════════════════════════════════ */

  /**
   * Request permanent deletion.
   *
   * Archives the subscriber, schedules the purge, and destroys nothing. Refused
   * server-side when the eligibility assessment says so — a Super Admin having
   * initiated it changes no retention rule.
   */
  app.post<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/request-deletion',
    { preHandler: requirePlatformCapability('subscribers.request_deletion') },
    async (request, reply) => {
      const input = parse(requestDeletionSchema, request.body);
      const result = await requestSubscriberDeletion(
        app.db,
        { organizationId: request.params.organizationId, ...input },
        adminContext(request),
      );
      // Carries the impact report; nothing sensitive, but it must not be cached.
      return reply.header('cache-control', 'no-store').send(result);
    },
  );

  /** Cancel a pending deletion. Returns the subscriber to `archived`. */
  app.post<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/cancel-deletion',
    { preHandler: requirePlatformCapability('subscribers.request_deletion') },
    async (request, reply) => {
      const { reason } = parse(reasonSchema, request.body);
      return reply.send(
        await cancelSubscriberDeletion(
          app.db,
          { organizationId: request.params.organizationId, reason },
          adminContext(request),
        ),
      );
    },
  );

  /**
   * Restore an archived subscriber.
   *
   * Refuses while a deletion request stands: cancelling a purge is a separate,
   * deliberate act and must not happen as a side effect of clicking "restore".
   */
  app.post<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/reactivate',
    { preHandler: requirePlatformCapability('subscribers.archive') },
    async (request, reply) => {
      const { reason } = parse(reasonSchema, request.body);
      await assertRestorable(app.db, request.params.organizationId);
      return reply.send(
        await restoreSubscriber(
          app.db,
          { organizationId: request.params.organizationId, reason },
          adminContext(request),
        ),
      );
    },
  );

  /* ══ The scheduled run ══════════════════════════════════════════════════ */

  /** Which subscribers are past their recovery window. A pure read. */
  app.get(
    '/api/admin/subscribers/deletions/due',
    { preHandler: requirePlatformCapability('subscribers.delete') },
    async (_request, reply) => reply.send({ due: await listDueDeletions(app.db) }),
  );

  /**
   * Carry out every due deletion that is still eligible.
   *
   * Explicit rather than automatic: this repository has no job runner, and
   * faking one would mean irreversible deletions running unattended. Each
   * subscriber is re-assessed at this moment — the request granted permission to
   * try, not to proceed regardless.
   */
  app.post(
    '/api/admin/subscribers/deletions/process',
    { preHandler: requirePlatformCapability('subscribers.delete') },
    async (request, reply) => {
      const input = parse(processSchema, request.body ?? {});
      return reply.send(await processDueDeletions(app.db, adminContext(request), input));
    },
  );

  /* ══ Data export ════════════════════════════════════════════════════════ */

  /**
   * Generate an export. The download token is in the response and nowhere else —
   * only its hash is stored — so the response must not be cached.
   */
  app.post<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/export',
    { preHandler: requirePlatformCapability('subscribers.export') },
    async (request, reply) => {
      const input = parse(exportSchema, request.body ?? {});
      const result = await createSubscriberExport(
        app.db,
        { organizationId: request.params.organizationId, ...input },
        adminContext(request),
      );
      return reply
        .header('cache-control', 'no-store, no-cache, must-revalidate, private')
        .header('pragma', 'no-cache')
        .code(201)
        .send(result);
    },
  );

  app.get<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/exports',
    { preHandler: requirePlatformCapability('subscribers.export') },
    async (request, reply) =>
      reply.send({ exports: await listSubscriberExports(app.db, request.params.organizationId) }),
  );

  /**
   * Download an export.
   *
   * POST, with the token in the body: a query parameter would be written to the
   * server log as part of `req.url`, and this token addresses a complete copy of
   * a tenant's records.
   */
  app.post<{ Params: { organizationId: string; exportId: string } }>(
    '/api/admin/subscribers/:organizationId/exports/:exportId/download',
    { preHandler: requirePlatformCapability('subscribers.export') },
    async (request, reply) => {
      const { token } = parse(downloadSchema, request.body);
      const result = await downloadSubscriberExport(
        app.db,
        { exportId: request.params.exportId, token },
        adminContext(request),
      );
      /*
       * The export belongs to the organization in the URL, or it is not served.
       * Without this, a valid token for tenant A downloaded through tenant B's
       * path would succeed — the token alone would decide, and the tenant in the
       * request would be decoration.
       */
      if (result.organizationId !== request.params.organizationId) {
        throw errors.notFound('Export');
      }
      return reply
        .header('cache-control', 'no-store, no-cache, must-revalidate, private')
        .header('content-disposition', `attachment; filename="ledgora-export-${request.params.organizationId}.json"`)
        .send(result.payload);
    },
  );

  /** Withdraw an export and destroy its stored copy. */
  app.post<{ Params: { organizationId: string; exportId: string } }>(
    '/api/admin/subscribers/:organizationId/exports/:exportId/revoke',
    { preHandler: requirePlatformCapability('subscribers.export') },
    async (request, reply) => {
      const { reason } = parse(reasonSchema, request.body);
      return reply.send(
        await revokeSubscriberExport(
          app.db,
          { exportId: request.params.exportId, reason },
          adminContext(request),
        ),
      );
    },
  );

  /* ══ Impact, re-exposed beside the closure surface ══════════════════════ */

  /**
   * The authoritative eligibility assessment.
   *
   * Already served at `/deletion-impact`; offered here too so the closure dialog
   * fetches its impact report from the same surface as everything else it needs.
   * Both call the SAME function — there is one assessment in the system.
   */
  app.get<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/closure/impact',
    { preHandler: requirePlatformCapability('subscribers.read') },
    async (request, reply) =>
      reply.send({ impact: await assessSubscriberDeletion(app.db, request.params.organizationId) }),
  );
}

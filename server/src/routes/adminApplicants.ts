/**
 * Administrator applicant routes.
 *
 * The roster the platform operator actually needs: every registered customer,
 * from the moment the account exists, whether or not they have chosen a package.
 * `/api/admin/subscriptions` remains the *subscription* view and is unchanged —
 * this is the *people* view, and it is the one that no longer loses prospects.
 *
 * Every route is behind a database-backed platform capability. There is no
 * customer-facing path into any of it: an ordinary subscriber receives 403 no
 * matter what their browser claims to be.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePlatformCapability } from '../guards/platform.js';
import {
  APPLICANT_SORT_FIELDS,
  APPLICANT_STAGES,
  getApplicant,
  listApplicants,
  recordPackageReminder,
  reconcileApplications,
  setApplicantAdminState,
  type ApplicantAdminContext,
} from '../services/applicantService.js';
import { errors } from '../lib/errors.js';

const listQuery = z.object({
  stage: z.enum(['all', ...APPLICANT_STAGES]).default('all'),
  search: z.string().trim().max(200).optional(),
  sort: z.enum(APPLICANT_SORT_FIELDS).default('registered_at'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

const reasonSchema = z.object({ reason: z.string().trim().min(1, 'A reason is required.').max(1000) });

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of result.error.issues) fieldErrors[issue.path.join('.') || 'form'] ??= issue.message;
    throw errors.validation('Please fix the highlighted fields.', { fieldErrors });
  }
  return result.data;
}

export async function adminApplicantRoutes(app: FastifyInstance): Promise<void> {
  const adminContext = (request: {
    ip: string;
    headers: Record<string, unknown>;
    principal: { user: { id: string }; platformRoles: string[] } | null;
  }): ApplicantAdminContext => ({
    actorUserId: request.principal!.user.id,
    actorPlatformRole: request.principal!.platformRoles[0] ?? 'unknown',
    ipAddress: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  });

  const dormantDays = () => app.config.APPLICANT_DORMANT_DAYS;

  /* ── Roster ───────────────────────────────────────────────────────────── */
  app.get('/api/admin/applicants', { preHandler: requirePlatformCapability('view-admin') }, async (request, reply) => {
    const query = parse(listQuery, request.query ?? {});
    return reply.send(await listApplicants(app.db, { ...query, dormantDays: dormantDays() }));
  });

  app.get<{ Params: { id: string } }>(
    '/api/admin/applicants/:id',
    { preHandler: requirePlatformCapability('view-admin') },
    async (request, reply) =>
      reply.send({ applicant: await getApplicant(app.db, request.params.id, { dormantDays: dormantDays() }) }),
  );

  /* ── Nudge a prospect who has not chosen a package ────────────────────── */
  app.post<{ Params: { id: string } }>(
    '/api/admin/applicants/:id/remind',
    { preHandler: requirePlatformCapability('manage-users') },
    async (request, reply) => reply.send(await recordPackageReminder(app.db, request.params.id, adminContext(request))),
  );

  /* ── Suspend / archive / restore (never delete) ───────────────────────── */
  for (const action of ['suspend', 'archive', 'restore'] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/admin/applicants/:id/${action}`,
      { preHandler: requirePlatformCapability('manage-users') },
      async (request, reply) => {
        const { reason } = parse(reasonSchema, request.body);
        const applicant = await setApplicantAdminState(app.db, request.params.id, action, reason, adminContext(request));
        return reply.send({ applicant });
      },
    );
  }

  /* ── Repair: create any application records that are still missing ────── */
  app.post(
    '/api/admin/applicants/reconcile',
    { preHandler: requirePlatformCapability('manage-users') },
    async (_request, reply) => reply.send(await reconcileApplications(app.db)),
  );
}

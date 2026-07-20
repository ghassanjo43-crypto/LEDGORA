/**
 * Administrator billing routes: payment review, subscription lifecycle, bank
 * details, billing settings and the package catalogue.
 *
 * Each route names the capability it needs. `support` can read the queue but
 * cannot approve; only `super_admin` may manually activate a subscription.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePlatformCapability } from '../guards/platform.js';
import {
  approvePaymentProof,
  getPaymentProof,
  getProofStorageKey,
  listPaymentProofs,
  rejectPaymentProof,
  requestProofInformation,
  type ReviewerContext,
} from '../services/paymentReviewService.js';
import {
  changeSubscriptionLifecycle,
  createPlan,
  getBankDetails,
  getBillingSettings,
  listAllPlans,
  listSubscriptions,
  setPlanArchived,
  updateBankDetails,
  updateBillingSettings,
  updatePlan,
  type AdminContext,
} from '../services/platformConfigService.js';
import { errors } from '../lib/errors.js';

const listQuery = z.object({
  status: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

const reasonSchema = z.object({ reason: z.string().trim().min(1, 'A reason is required.').max(1000) });
const noteSchema = z.object({ note: z.string().trim().min(1, 'A note is required.').max(1000) });

const planSchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  edition: z.string().trim().min(1).max(40),
  currency: z.string().trim().length(3).optional(),
  monthlyPrice: z.number().nonnegative(),
  annualPrice: z.number().nonnegative().optional(),
  userLimit: z.number().int().min(1),
  entityLimit: z.number().int().min(1),
  modules: z.array(z.string().trim().max(60)).max(50).optional(),
  isPublic: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of result.error.issues) fieldErrors[issue.path.join('.') || 'form'] ??= issue.message;
    throw errors.validation('Please fix the highlighted fields.', { fieldErrors });
  }
  return result.data;
}

export async function adminBillingRoutes(app: FastifyInstance): Promise<void> {
  /** Reviewer identity for the audit trail, taken from the verified session. */
  const reviewer = (request: {
    ip: string;
    headers: Record<string, unknown>;
    principal: { user: { id: string }; platformRoles: string[] } | null;
  }): ReviewerContext & AdminContext => ({
    reviewerUserId: request.principal!.user.id,
    reviewerRole: request.principal!.platformRoles[0] ?? 'unknown',
    actorUserId: request.principal!.user.id,
    actorPlatformRole: request.principal!.platformRoles[0] ?? 'unknown',
    ipAddress: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  });

  /* ── Payment review queue ─────────────────────────────────────────────── */
  app.get('/api/admin/payment-proofs', { preHandler: requirePlatformCapability('view-admin') }, async (request, reply) => {
    const query = parse(listQuery, request.query ?? {});
    return reply.send({ proofs: await listPaymentProofs(app.db, query) });
  });

  app.get<{ Params: { id: string } }>(
    '/api/admin/payment-proofs/:id',
    { preHandler: requirePlatformCapability('view-admin') },
    async (request, reply) => reply.send({ proof: await getPaymentProof(app.db, request.params.id) }),
  );

  /** The receipt itself. Streamed to the reviewer only — never a public URL. */
  app.get<{ Params: { id: string } }>(
    '/api/admin/payment-proofs/:id/file',
    { preHandler: requirePlatformCapability('view-admin') },
    async (request, reply) => {
      const meta = await getProofStorageKey(app.db, request.params.id);
      const content = await app.fileStorage.get(meta.storageKey);
      return reply
        .header('content-type', meta.mimeType)
        // `attachment` so a crafted file can never render in the admin origin.
        .header('content-disposition', `attachment; filename="${encodeURIComponent(meta.fileName)}"`)
        .header('x-content-type-options', 'nosniff')
        .send(content);
    },
  );

  /* ── Review decisions ─────────────────────────────────────────────────── */
  app.post<{ Params: { id: string } }>(
    '/api/admin/payment-proofs/:id/approve',
    { preHandler: requirePlatformCapability('verify-payments') },
    async (request, reply) => reply.send(await approvePaymentProof(app.db, request.params.id, reviewer(request))),
  );

  app.post<{ Params: { id: string } }>(
    '/api/admin/payment-proofs/:id/reject',
    { preHandler: requirePlatformCapability('verify-payments') },
    async (request, reply) => {
      const { reason } = parse(reasonSchema, request.body);
      return reply.send(await rejectPaymentProof(app.db, request.params.id, reason, reviewer(request)));
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/admin/payment-proofs/:id/request-information',
    { preHandler: requirePlatformCapability('verify-payments') },
    async (request, reply) => {
      const { note } = parse(noteSchema, request.body);
      return reply.send(await requestProofInformation(app.db, request.params.id, note, reviewer(request)));
    },
  );

  /* ── Subscriptions ────────────────────────────────────────────────────── */
  app.get('/api/admin/subscriptions', { preHandler: requirePlatformCapability('view-admin') }, async (request, reply) => {
    const query = parse(listQuery, request.query ?? {});
    return reply.send({ subscriptions: await listSubscriptions(app.db, query) });
  });

  for (const action of ['activate', 'suspend', 'cancel', 'renew'] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/admin/subscriptions/:id/${action}`,
      {
        // Manual activation and renewal bypass payment verification entirely,
        // so they are restricted to super_admin.
        preHandler: requirePlatformCapability(
          action === 'activate' || action === 'renew' ? 'activate-subscription' : 'verify-payments',
        ),
      },
      async (request, reply) => {
        const { reason } = parse(reasonSchema, request.body);
        return reply.send(await changeSubscriptionLifecycle(app.db, request.params.id, action, reason, reviewer(request)));
      },
    );
  }

  /* ── Bank details ─────────────────────────────────────────────────────── */
  app.get('/api/admin/bank-details', { preHandler: requirePlatformCapability('view-admin') }, async (_request, reply) =>
    reply.send({ bankDetails: await getBankDetails(app.db) }),
  );

  app.patch('/api/admin/bank-details', { preHandler: requirePlatformCapability('manage-bank-details') }, async (request, reply) => {
    const patch = parse(
      z.object({
        bankName: z.string().trim().max(160).optional(),
        accountName: z.string().trim().max(160).optional(),
        accountNumber: z.string().trim().max(60).optional(),
        iban: z.string().trim().max(60).optional(),
        swift: z.string().trim().max(20).optional(),
        branch: z.string().trim().max(160).optional(),
        instructions: z.string().trim().max(1000).optional(),
      }),
      request.body,
    );
    return reply.send({ bankDetails: await updateBankDetails(app.db, patch, reviewer(request)) });
  });

  /* ── Billing settings ─────────────────────────────────────────────────── */
  app.get('/api/admin/billing-settings', { preHandler: requirePlatformCapability('view-admin') }, async (_request, reply) =>
    reply.send({ billingSettings: await getBillingSettings(app.db) }),
  );

  app.patch(
    '/api/admin/billing-settings',
    { preHandler: requirePlatformCapability('manage-billing-settings') },
    async (request, reply) => {
      const patch = parse(
        z.object({
          currency: z.string().trim().length(3).optional(),
          paymentDueDays: z.number().int().min(1).max(90).optional(),
          graceDays: z.number().int().min(0).max(90).optional(),
          termMonths: z.number().int().min(1).max(36).optional(),
        }),
        request.body,
      );
      return reply.send({ billingSettings: await updateBillingSettings(app.db, patch, reviewer(request)) });
    },
  );

  /* ── Package catalogue ────────────────────────────────────────────────── */
  app.get('/api/admin/plans', { preHandler: requirePlatformCapability('view-admin') }, async (_request, reply) =>
    reply.send({ plans: await listAllPlans(app.db) }),
  );

  app.post('/api/admin/plans', { preHandler: requirePlatformCapability('manage-plans') }, async (request, reply) => {
    const input = parse(planSchema, request.body);
    return reply.code(201).send(await createPlan(app.db, input, reviewer(request)));
  });

  app.patch<{ Params: { id: string } }>(
    '/api/admin/plans/:id',
    { preHandler: requirePlatformCapability('manage-plans') },
    async (request, reply) => {
      const patch = parse(planSchema.partial(), request.body);
      await updatePlan(app.db, request.params.id, patch, reviewer(request));
      return reply.send({ ok: true });
    },
  );

  for (const [suffix, archived] of [['archive', true], ['restore', false]] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/admin/plans/:id/${suffix}`,
      { preHandler: requirePlatformCapability('manage-plans') },
      async (request, reply) => {
        await setPlanArchived(app.db, request.params.id, archived, reviewer(request));
        return reply.send({ ok: true });
      },
    );
  }
}

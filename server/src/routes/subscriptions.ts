/**
 * Customer-facing plan, organization, subscription and payment-proof routes.
 *
 * Everything here is scoped to the caller's own organization. No route in this
 * file can activate a subscription or grant an entitlement.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuthenticatedUser } from '../guards/platform.js';
import { createOrganization, getCurrentOrganization, requireOrganizationFor } from '../services/organizationService.js';
import { confirmSubscription, getCurrentSubscription, listPublicPlans, selectPlan } from '../services/subscriptionService.js';
import { submitPaymentProof } from '../services/paymentProofService.js';
import { errors } from '../lib/errors.js';

const organizationSchema = z.object({
  legalName: z.string().trim().min(1, 'Legal name is required.').max(200),
  tradingName: z.string().trim().max(200).optional(),
  country: z.string().trim().min(2).max(60),
  registrationNumber: z.string().trim().max(80).optional(),
  taxNumber: z.string().trim().max(80).optional(),
  industry: z.string().trim().max(80).optional(),
  baseCurrency: z.string().trim().length(3).optional(),
  fiscalYearStart: z.string().trim().max(5).optional(),
  booksStartDate: z.string().trim().max(10).optional(),
});

const selectPlanSchema = z.object({
  planId: z.string().uuid('Choose a valid package.'),
  billingCycle: z.enum(['monthly', 'annual']).optional(),
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

export async function subscriptionRoutes(app: FastifyInstance): Promise<void> {
  const context = (request: { ip: string; headers: Record<string, unknown> }) => ({
    ipAddress: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  });

  /* ── Public catalogue (no authentication — this is the pricing page) ───── */
  app.get('/api/plans/public', async (_request, reply) => {
    return reply.send({ plans: await listPublicPlans(app.db) });
  });

  /* ── Organization ─────────────────────────────────────────────────────── */
  app.post('/api/organizations', { preHandler: requireAuthenticatedUser }, async (request, reply) => {
    const input = parse(organizationSchema, request.body);
    const result = await createOrganization(app.db, request.principal!.user.id, input, context(request));
    const organization = await getCurrentOrganization(app.db, request.principal!.user.id);
    return reply.code(201).send({ organizationId: result.id, organization });
  });

  app.get('/api/organizations/current', { preHandler: requireAuthenticatedUser }, async (request, reply) => {
    return reply.send({ organization: await getCurrentOrganization(app.db, request.principal!.user.id) });
  });

  /* ── Subscription selection ───────────────────────────────────────────── */
  app.post('/api/subscriptions', { preHandler: requireAuthenticatedUser }, async (request, reply) => {
    const input = parse(selectPlanSchema, request.body);
    const userId = request.principal!.user.id;
    const organizationId = await requireOrganizationFor(app.db, userId);

    const result = await selectPlan(
      app.db,
      { organizationId, planId: input.planId, billingCycle: input.billingCycle, userId },
      context(request),
    );
    return reply.code(201).send(result);
  });

  app.get('/api/subscriptions/current', { preHandler: requireAuthenticatedUser }, async (request, reply) => {
    const userId = request.principal!.user.id;
    const organization = await getCurrentOrganization(app.db, userId);
    if (!organization) return reply.send({ subscription: null, invoice: null, bank: null });
    return reply.send(await getCurrentSubscription(app.db, organization.id));
  });

  /* ── Confirm → invoice + payment reference (one transaction) ──────────── */
  app.post<{ Params: { id: string } }>(
    '/api/subscriptions/:id/confirm',
    { preHandler: requireAuthenticatedUser },
    async (request, reply) => {
      const userId = request.principal!.user.id;
      const organizationId = await requireOrganizationFor(app.db, userId);
      const result = await confirmSubscription(
        app.db,
        { subscriptionId: request.params.id, organizationId, userId },
        context(request),
      );
      return reply.code(201).send(result);
    },
  );

  /* ── Payment proof upload (multipart) ─────────────────────────────────── */
  app.post<{ Params: { invoiceId: string } }>(
    '/api/invoices/:invoiceId/payment-proof',
    { preHandler: requireAuthenticatedUser },
    async (request, reply) => {
      const userId = request.principal!.user.id;
      const organizationId = await requireOrganizationFor(app.db, userId);

      if (!request.isMultipart()) {
        throw errors.validation('Upload the receipt as multipart/form-data.');
      }

      let content: Buffer | null = null;
      let fileName = '';
      let mimeType = '';
      const fields: Record<string, string> = {};

      for await (const part of request.parts()) {
        if (part.type === 'file') {
          // Fastify enforces MAX_UPLOAD_BYTES; this flags a truncated read.
          content = await part.toBuffer();
          if (part.file.truncated) {
            throw errors.validation('The file is larger than the upload limit.');
          }
          fileName = part.filename ?? 'receipt';
          mimeType = part.mimetype;
        } else if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value;
        }
      }

      if (!content) throw errors.validation('Attach the payment receipt.');

      const result = await submitPaymentProof(
        app.db,
        app.fileStorage,
        {
          invoiceId: request.params.invoiceId,
          organizationId,
          userId,
          content,
          fileName,
          mimeType,
          ledgoraPaymentReference: fields.ledgoraPaymentReference ?? '',
          bankTransactionReference: fields.bankTransactionReference,
          amount: Number(fields.amount ?? '0'),
          paidAt: fields.paidAt ?? '',
          note: fields.note,
        },
        app.config.MAX_UPLOAD_BYTES,
        context(request),
      );

      return reply.code(201).send(result);
    },
  );
}

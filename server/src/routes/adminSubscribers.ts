/**
 * Administrator subscriber routes — the customer-ACCOUNT surface.
 *
 * A subscriber is an organization. Every route below is keyed by
 * `:organizationId`, which is why each one is guarded by a backend-verified
 * platform capability rather than by any notion of "the caller's organization":
 * a platform operator is deliberately tenantless, so there is no membership to
 * derive. Being able to type an id buys nothing — a customer fails the guard.
 *
 * Capability split:
 *   `subscribers.read`     roster, detail, package impact preview
 *   `subscribers.create`   manual creation
 *   `subscribers.manage`   status, ownership, notes
 *   `subscriptions.assign` package assignment (grants a paid entitlement with no
 *                          payment, so it carries the same restriction as manual
 *                          activation)
 */
import type { FastifyInstance } from 'fastify';
import {
  previewCleanup,
  previewAllDisposable,
  executeCleanup,
  runFileCleanup,
  summariseExternalCleanup,
} from '../services/cleanupService.js';
import { z } from 'zod';
import {
  changeSubscriberClassification,
  confirmSubscriberClassification,
  gatherClassificationEvidence,
  ClassificationBootstrapRefused,
} from '../services/classificationService.js';
import { requirePlatformCapability } from '../guards/platform.js';
import {
  SUBSCRIBER_SORT_FIELDS,
  changeSubscriberOwner,
  createSubscriber,
  getSubscriber,
  listSubscribers,
  setSubscriberStatus,
  updateSubscriberNotes,
  type SubscriberAdminContext,
} from '../services/subscriberService.js';
import {
  ASSIGNABLE_SUBSCRIPTION_STATUSES,
  assessPackageChange,
  assignPackage,
  listPackageHistory,
} from '../services/packageAssignmentService.js';
import { getEntitlements, refreshEntitlementsAudited } from '../services/entitlementService.js';
import { errors } from '../lib/errors.js';

const listQuery = z.object({
  status: z.enum(['all', 'active', 'suspended', 'archived', 'closed']).optional(),
  /** Roster filter. `all` and an absent value mean the same thing. */
  classification: z.enum(['all', 'production', 'test', 'demo']).optional(),
  subscriptionStatus: z.string().trim().max(40).optional(),
  planId: z.string().uuid().optional(),
  search: z.string().trim().max(200).optional(),
  sort: z.enum(SUBSCRIBER_SORT_FIELDS).default('created_at'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

/** ISO date (`2026-07-26`) or full timestamp. Rejected rather than guessed. */
const dateSchema = z
  .string()
  .trim()
  .min(4)
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date.')
  .transform((v) => new Date(v));

const moduleListSchema = z.array(z.string().trim().min(1).max(60)).max(50);

const createSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required.').max(200),
  email: z.string().trim().email('Enter a valid email address.').max(320),
  organizationLegalName: z.string().trim().min(1, 'Organization legal name is required.').max(200),
  tradingName: z.string().trim().max(200).optional(),
  country: z.string().trim().min(2, 'Country is required.').max(60),
  baseCurrency: z.string().trim().length(3).optional(),
  planId: z.string().uuid('Choose a base package.'),
  /**
   * Account type. Absent means `production` — the safe default — so a client
   * that omits it cannot create a permanently-deletable tenant by accident.
   */
  dataClassification: z.enum(['production', 'test', 'demo']).optional(),
  modules: moduleListSchema.optional(),
  subscriptionStatus: z.enum(ASSIGNABLE_SUBSCRIPTION_STATUSES).optional(),
  organizationStatus: z.enum(['active', 'suspended', 'archived', 'closed']).optional(),
  startDate: dateSchema.optional(),
  billingCycle: z.enum(['monthly', 'annual']).optional(),
  seatAllowance: z.coerce.number().int().min(1).max(100_000).nullish(),
  entityAllowance: z.coerce.number().int().min(1).max(100_000).nullish(),
  storageAllowance: z.coerce.number().int().min(0).nullish(),
  paymentConfirmed: z.boolean().optional(),
  internalNotes: z.string().trim().max(4000).optional(),
  /**
   * How the customer gets in. `invite` mints a single-use link; `temporary`
   * generates a password shown exactly once. Both force a change at first login.
   */
  onboarding: z.enum(['invite', 'temporary']).default('invite'),
  temporaryPasswordTtlMinutes: z.coerce.number().int().min(5).max(60 * 24 * 30).optional(),
  resetLinkTtlMinutes: z.coerce.number().int().min(5).max(60 * 24 * 30).optional(),
});

const assignSchema = z.object({
  planId: z.string().uuid('Choose a package.'),
  modules: moduleListSchema.optional(),
  billingCycle: z.enum(['monthly', 'annual']).optional(),
  status: z.enum(ASSIGNABLE_SUBSCRIPTION_STATUSES).optional(),
  effectiveDate: dateSchema.optional(),
  seatOverride: z.coerce.number().int().min(1).max(100_000).nullish(),
  entityOverride: z.coerce.number().int().min(1).max(100_000).nullish(),
  storageOverride: z.coerce.number().int().min(0).nullish(),
  reason: z.string().trim().min(1, 'A reason is required.').max(1000),
  acknowledgedConsequences: z.array(z.string().trim().max(60)).max(20).optional(),
});

/** The preview form: everything the assignment takes except the reason. */
const impactQuery = assignSchema.omit({ reason: true, acknowledgedConsequences: true }).partial({
  modules: true,
  billingCycle: true,
  status: true,
  effectiveDate: true,
});

const statusSchema = z.object({
  action: z.enum(['activate', 'suspend', 'archive', 'restore']),
  reason: z.string().trim().min(1, 'A reason is required.').max(1000),
});

const ownerSchema = z.object({
  newOwnerUserId: z.string().uuid('Choose the member who becomes the owner.'),
  previousOwnerRole: z.enum(['accountant', 'member', 'viewer']).optional(),
  reason: z.string().trim().min(1, 'A reason is required.').max(1000),
});

const notesSchema = z.object({ internalNotes: z.string().trim().max(4000) });

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
 * Either explicit ids or the "everything disposable" sweep — never a free-form
 * predicate. The set of things that can be destroyed is always enumerable.
 */
const cleanupPreviewSchema = z
  .object({
    organizationIds: z.array(z.string().uuid()).max(500).optional(),
    allDisposable: z.boolean().optional(),
  })
  .refine((v) => v.allDisposable === true || (v.organizationIds?.length ?? 0) > 0, {
    message: 'Select subscribers to preview.',
  });

const cleanupExecuteSchema = z.object({
  organizationIds: z.array(z.string().uuid()).min(1).max(500),
  /*
   * The ids the preview covered. An id list is not a claim about eligibility —
   * the server still describes every one of them from the database — so
   * accepting it does not let the client assert anything. It only says which
   * rows the digest should be recomputed over, and the digest then has to
   * match.
   */
  previewedOrganizationIds: z.array(z.string().uuid()).max(500).optional(),
  /*
   * The digest is the ONLY piece of preview state that round-trips, and it is
   * recomputed and compared rather than believed. Counts and eligibility are
   * deliberately not accepted from the client at all.
   */
  previewDigest: z.string().min(64).max(64),
  previewedAt: z.string().datetime(),
  reason: z.string().min(10, 'Explain why these subscribers are being deleted.'),
  confirmation: z.string(),
  operationId: z.string().uuid().optional(),
});

const cleanupRetrySchema = z.object({ operationId: z.string().uuid().optional() });

/**
 * Note the enum accepts `production` as a TARGET only. There is no shape of this
 * body that expresses "make this production account disposable": the service
 * reads the current classification from the locked row and refuses, and the
 * trigger refuses again beneath it.
 */
const classificationSchema = z.object({
  classification: z.enum(['production', 'test', 'demo']),
  reason: z.string().trim().min(10, 'Explain why this subscriber is being reclassified.').max(1000),
});

/**
 * Reconciliation of the 008 migration's blanket default.
 *
 * `demo` and `test` are accepted by the SCHEMA so the service can refuse them
 * with an explanation and the evidence. Rejecting them here instead would return
 * a validation error, which reads as "you sent the wrong shape" rather than
 * "this is not something this endpoint is allowed to do".
 */
const classifySchema = z.object({
  classification: z.enum(['production', 'test', 'demo']),
  reason: z.string().trim().min(10, 'Explain the basis for this classification.').max(1000),
});

export async function adminSubscriberRoutes(app: FastifyInstance): Promise<void> {
  const adminContext = (request: {
    ip: string;
    headers: Record<string, unknown>;
    principal: { user: { id: string }; platformRoles: string[] } | null;
  }): SubscriberAdminContext => ({
    actorUserId: request.principal!.user.id,
    actorPlatformRole: request.principal!.platformRoles.join(',') || 'unknown',
    ipAddress: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  });

  /* ── Roster & detail ──────────────────────────────────────────────────── */

  app.get('/api/admin/subscribers', { preHandler: requirePlatformCapability('subscribers.read') }, async (request, reply) => {
    const query = parse(listQuery, request.query ?? {});
    return reply.send(await listSubscribers(app.db, query));
  });

  app.get<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId',
    { preHandler: requirePlatformCapability('subscribers.read') },
    async (request, reply) => reply.send(await getSubscriber(app.db, request.params.organizationId)),
  );

  app.get<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/entitlements',
    { preHandler: requirePlatformCapability('subscribers.read') },
    async (request, reply) =>
      reply.send({ entitlements: await getEntitlements(app.db, request.params.organizationId) }),
  );

  app.get<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/package-history',
    { preHandler: requirePlatformCapability('subscribers.read') },
    async (request, reply) =>
      reply.send({ history: await listPackageHistory(app.db, request.params.organizationId) }),
  );

  /* ── Creation ─────────────────────────────────────────────────────────── */

  /**
   * Create a subscriber in one transaction. 201 carries the onboarding secret
   * (temporary password or invitation token) for the ONLY time it is ever
   * available, so the response is explicitly uncacheable.
   */
  app.post(
    '/api/admin/subscribers',
    { preHandler: requirePlatformCapability('subscribers.create') },
    async (request, reply) => {
      const input = parse(createSchema, request.body);
      const created = await createSubscriber(
        app.db,
        {
          ...input,
          temporaryPasswordTtlMinutes:
            input.temporaryPasswordTtlMinutes ?? app.config.TEMPORARY_PASSWORD_TTL_MINUTES,
        },
        adminContext(request),
      );
      return reply
        .code(201)
        .header('cache-control', 'no-store, no-cache, must-revalidate, private')
        .header('pragma', 'no-cache')
        .send(created);
    },
  );

  /* ── Lifecycle ────────────────────────────────────────────────────────── */

  app.patch<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/status',
    { preHandler: requirePlatformCapability('subscribers.manage') },
    async (request, reply) => {
      const input = parse(statusSchema, request.body);
      return reply.send(
        await setSubscriberStatus(
          app.db,
          request.params.organizationId,
          input.action,
          input.reason,
          adminContext(request),
        ),
      );
    },
  );

  app.post<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/change-owner',
    { preHandler: requirePlatformCapability('subscribers.manage') },
    async (request, reply) => {
      const input = parse(ownerSchema, request.body);
      return reply.send(
        await changeSubscriberOwner(
          app.db,
          { organizationId: request.params.organizationId, ...input },
          adminContext(request),
        ),
      );
    },
  );

  app.patch<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/notes',
    { preHandler: requirePlatformCapability('subscribers.manage') },
    async (request, reply) => {
      const { internalNotes } = parse(notesSchema, request.body);
      return reply.send(
        await updateSubscriberNotes(app.db, request.params.organizationId, internalNotes, adminContext(request)),
      );
    },
  );

  /* ── Package assignment ───────────────────────────────────────────────── */

  /**
   * What WOULD happen. A pure read, so the console can call it as the
   * administrator edits the form and show downgrade consequences before any
   * confirmation. `assignPackage` re-runs the same assessment server-side, so
   * skipping this call does not skip the analysis.
   */
  app.get<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/package-impact',
    { preHandler: requirePlatformCapability('subscribers.read') },
    async (request, reply) => {
      const query = parse(impactQuery, request.query ?? {});
      return reply.send({
        assessment: await assessPackageChange(app.db, {
          organizationId: request.params.organizationId,
          planId: query.planId,
          modules: query.modules,
          status: query.status,
          seatOverride: query.seatOverride ?? null,
          entityOverride: query.entityOverride ?? null,
          storageOverride: query.storageOverride ?? null,
        }),
      });
    },
  );

  app.post<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/assign-package',
    { preHandler: requirePlatformCapability('subscriptions.assign') },
    async (request, reply) => {
      const input = parse(assignSchema, request.body);
      return reply.send(
        await assignPackage(
          app.db,
          {
            organizationId: request.params.organizationId,
            ...input,
            seatOverride: input.seatOverride ?? null,
            entityOverride: input.entityOverride ?? null,
            storageOverride: input.storageOverride ?? null,
          },
          adminContext(request),
        ),
      );
    },
  );

  /* ── Disposable-tenant cleanup ────────────────────────────────────────── */

  /**
   * The preview. A GET-shaped read expressed as POST only because the id list
   * can be long; it writes nothing, and `previewCleanup` issues SELECTs only.
   */
  app.post(
    '/api/admin/cleanup/preview',
    { preHandler: requirePlatformCapability('subscribers.delete') },
    async (request, reply) => {
      const { organizationIds, allDisposable } = parse(cleanupPreviewSchema, request.body);

      return reply.send(
        allDisposable
          ? await previewAllDisposable(app.db)
          : await previewCleanup(app.db, organizationIds ?? []),
      );
    },
  );

  /**
   * Execution.
   *
   * Everything the client sends is re-derived server-side before anything is
   * destroyed: eligibility, classification, counts and the digest. The digest is
   * the one field that must round-trip, and it is compared against a freshly
   * recomputed value rather than trusted.
   */
  app.post(
    '/api/admin/cleanup/execute',
    { preHandler: requirePlatformCapability('subscribers.delete') },
    async (request, reply) => {
      const body = parse(cleanupExecuteSchema, request.body);

      return reply.send(
        await executeCleanup(
          app.db,
          app.fileStorage,
          {
            organizationIds: body.organizationIds,
            previewedOrganizationIds: body.previewedOrganizationIds,
            previewDigest: body.previewDigest,
            previewedAt: body.previewedAt,
            reason: body.reason,
            confirmation: body.confirmation,
            operationId: body.operationId,
          },
          { ...adminContext(request), requestId: request.id },
        ),
      );
    },
  );

  /** Retry outstanding object-storage deletions. The manual stand-in for a worker. */
  app.post(
    '/api/admin/cleanup/retry-files',
    { preHandler: requirePlatformCapability('subscribers.delete') },
    async (request, reply) => {
      const { operationId } = parse(cleanupRetrySchema, request.body ?? {});
      return reply.send(await runFileCleanup(app.db, app.fileStorage, operationId));
    },
  );

  /** Outstanding external cleanup, so the console can show a truthful state. */
  app.get(
    '/api/admin/cleanup/file-status',
    { preHandler: requirePlatformCapability('subscribers.delete') },
    async (_request, reply) => reply.send(await summariseExternalCleanup(app.db)),
  );

  /** Force a recomputation — the "refresh the entitlement cache" control. */
  app.post<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/refresh-entitlements',
    { preHandler: requirePlatformCapability('subscriptions.assign') },
    async (request, reply) =>
      reply.send({
        entitlements: await refreshEntitlementsAudited(
          app.db,
          request.params.organizationId,
          adminContext(request),
        ),
      }),
  );

  /**
   * Change a subscriber's classification.
   *
   * `subscribers.manage` is super_admin-only, but the authority that matters is
   * not this guard: the service and the database trigger both refuse
   * production -> test|demo, so no caller reaching this route — forged body,
   * stolen session or otherwise — can make a protected account disposable. The
   * guard decides who may promote a sandbox, not who may override retention.
   */
  /**
   * The evidence behind a reconciliation decision. A read: it computes the same
   * summary the POST below re-computes inside its own transaction, so the dialog
   * cannot show one thing and the write act on another.
   */
  app.get<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/classification-evidence',
    { preHandler: requirePlatformCapability('subscribers.manage') },
    async (request, reply) => {
      const evidence = await gatherClassificationEvidence(app.db, request.params.organizationId);
      if (!evidence) throw errors.notFound('Subscriber');
      return reply.send({ evidence });
    },
  );

  /**
   * Confirm the classification of a subscriber nobody has reviewed.
   *
   * Writes exactly one outcome: reviewed-production. It cannot make anything
   * disposable at any evidence level, which is what makes it safe to expose over
   * HTTP at all — unlike the development CLI, it never moves data out of
   * production protection, so it grants no authority over retention.
   */
  app.post<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/classify',
    { preHandler: requirePlatformCapability('subscribers.manage') },
    async (request, reply) => {
      const body = parse(classifySchema, request.body);
      try {
        return reply.send({
          classification: await confirmSubscriberClassification(
            app.db,
            { organizationId: request.params.organizationId, ...body },
            { ...adminContext(request), requestId: request.id },
          ),
        });
      } catch (caught) {
        if (caught instanceof ClassificationBootstrapRefused) {
          throw caught.code === 'not_found'
            ? errors.notFound('Subscriber')
            : errors.conflict(caught.message);
        }
        throw caught;
      }
    },
  );

  app.patch<{ Params: { organizationId: string } }>(
    '/api/admin/subscribers/:organizationId/classification',
    { preHandler: requirePlatformCapability('subscribers.manage') },
    async (request, reply) => {
      const body = parse(classificationSchema, request.body);
      try {
        return reply.send({
          classification: await changeSubscriberClassification(
            app.db,
            { organizationId: request.params.organizationId, ...body },
            { ...adminContext(request), requestId: request.id },
          ),
        });
      } catch (caught) {
        if (caught instanceof ClassificationBootstrapRefused) {
          /*
           * 404 for a missing subscriber, 409 for every refusal. A refusal is a
           * statement about the account's state, not about the request being
           * malformed, so it must not read as a validation error the client
           * could fix by resending different fields.
           */
          throw caught.code === 'not_found'
            ? errors.notFound('Subscriber')
            : errors.conflict(caught.message);
        }
        throw caught;
      }
    },
  );
}

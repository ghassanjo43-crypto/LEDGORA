/**
 * Fixed Assets F1 — the register and its configuration, over HTTP.
 *
 * ══ One gate, and it is the one the plans actually sell ══════════════════════
 *
 * Every route here is guarded by the `fixed_assets` permission subject, whose
 * `requiredModule` is the coarse `fixed_assets` entitlement. That id is not
 * invented for this slice: it is the one `permissionCatalog` already declares
 * and the one `packageCatalogue` sells in `BOOKKEEPING`, so every package —
 * Core included — reaches it, and `permissionService` refuses it outright for a
 * tenant whose subscription has lapsed.
 *
 * The organization is never read from the request. `requireOwnOrganizationPermission`
 * derives it from the caller's own membership, and `requireCompanyScope`
 * resolves the company, so there is nothing in a body a modified request could
 * point at another tenant's register.
 *
 * ══ Why the schemas are `.strict()` ══════════════════════════════════════════
 *
 * A caller sending `acquisitionCost`, `accumulatedDepreciation`, `netBookValue`,
 * `capitalizationDate`, `createdBy` or an audit timestamp is REFUSED BY NAME
 * rather than having the field quietly dropped. Silently ignoring it is how a
 * client comes to believe this slice stored a cost it never stored — and how an
 * integration ships against a figure that does not exist.
 *
 * ══ Nothing here posts ═══════════════════════════════════════════════════════
 *
 * There is no capitalisation, depreciation, impairment, revaluation, disposal
 * or transfer endpoint, and no route that accepts a monetary cost. The named
 * refusals below exist so a caller who looks for one gets a sentence explaining
 * which decision has not been made, rather than a 404 that reads like a typo.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errors } from '../lib/errors.js';
import { requireOwnOrganizationPermission } from '../guards/permissions.js';
import { requireCompanyScope, companyOf } from '../guards/companyScope.js';
import type { FixedAssetActor } from '../services/fixedAssets/fixedAssetCore.js';
import {
  ATTACHMENTS_UNSUPPORTED,
  BILL_CAPITALIZATION_UNSUPPORTED,
  CAPITALIZATION_UNSUPPORTED,
  COMPONENT_ACCOUNTING_UNSUPPORTED,
  DEPRECIATION_CONVENTIONS,
  DEPRECIATION_METHODS,
  DEPRECIATION_UNSUPPORTED,
  DISPOSAL_UNSUPPORTED,
  FOREIGN_CURRENCY_UNSUPPORTED,
  IMPAIRMENT_UNSUPPORTED,
  MULTIPLE_BOOKS_UNSUPPORTED,
  REVALUATION_UNSUPPORTED,
  TRANSFER_UNSUPPORTED,
  USEFUL_LIFE_UNIT,
} from '../services/fixedAssets/fixedAssetCore.js';
import * as categories from '../services/fixedAssets/categoryService.js';
import * as assets from '../services/fixedAssets/assetService.js';
import { registerReport } from '../services/fixedAssets/registerReportService.js';

const uuid = z.string().uuid();
const optionalUuid = uuid.nullish();
/** Money arrives as TEXT so an exact decimal never passes through a float. */
const decimalText = z.string().max(40).nullish();
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date as yyyy-mm-dd.');

/**
 * The category body.
 *
 * `defaultMethod` and `depreciationConvention` are deliberately loose strings
 * rather than enums: an enum would refuse `reducing_balance` with a schema
 * error, and the service has a sentence explaining exactly which part of that
 * method this product has not established. A caller deserves the sentence.
 */
const categorySchema = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  defaultMethod: z.string().max(60).optional(),
  defaultUsefulLifeMonths: z.number().int().nullish(),
  defaultResidualPercent: decimalText,
  depreciationConvention: z.string().max(60).optional(),
  assetCostAccountId: optionalUuid,
  accumulatedDepreciationAccountId: optionalUuid,
  depreciationExpenseAccountId: optionalUuid,
}).strict();

/**
 * The asset body.
 *
 * `.strict()` is load-bearing here. Every figure this slice refuses to hold —
 * cost, accumulated depreciation, carrying amount, a capitalisation date, a
 * status claiming an asset is in service — is a field somebody will eventually
 * try to send, and each is rejected by name rather than dropped.
 */
const assetSchema = z.object({
  assetCode: z.string().max(60).nullish(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  categoryId: uuid,
  acquisitionDate: calendarDate,
  depreciationStartDate: calendarDate.nullish(),
  depreciationMethod: z.string().max(60).optional(),
  usefulLifeMonths: z.number().int().nullish(),
  depreciationConvention: z.string().max(60).optional(),
  residualValue: decimalText,
  quantity: z.number().int().optional(),
  location: z.string().max(200).optional(),
  custodian: z.string().max(200).optional(),
  branch: z.string().max(200).optional(),
  department: z.string().max(200).optional(),
  supplierPartyId: optionalUuid,
  purchaseReference: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
}).strict();

const versioned = z.object({ expectedVersion: z.number().int().min(0) });
const archiveSchema = versioned.extend({
  archived: z.boolean(),
  reason: z.string().max(500).optional(),
}).strict();
const categoryArchiveSchema = versioned.extend({ archived: z.boolean() }).strict();

const listCategoriesSchema = z.object({
  status: z.enum(['active', 'archived']).optional(),
  search: z.string().max(200).optional(),
  limit: z.string().regex(/^\d{1,3}$/).optional(),
});

const listAssetsSchema = z.object({
  status: z.enum(['draft', 'archived']).optional(),
  categoryId: uuid.optional(),
  search: z.string().max(200).optional(),
  limit: z.string().regex(/^\d{1,3}$/).optional(),
});

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const path = issue.path.join('.') || 'form';
      /*
       * An unrecognised key is the interesting failure, and Zod's own wording
       * for it names no field. Say which field and why it cannot be here.
       */
      if (issue.code === 'unrecognized_keys') {
        const keys = (issue as unknown as { keys: string[] }).keys ?? [];
        for (const key of keys) {
          fieldErrors[key] = UNRECOGNISED[key] ?? 'This slice does not record this field.';
        }
        continue;
      }
      fieldErrors[path] ??= issue.message;
    }
    throw errors.validation('Check the details and try again.', { fieldErrors });
  }
  return result.data;
}

/**
 * The fields somebody will try to send, and why each is not here.
 *
 * A rejection that says "unrecognized key" teaches nothing. These say which
 * decision has not been made, so an integrator stops rather than working
 * around it.
 */
const UNRECOGNISED: Readonly<Record<string, string>> = {
  acquisitionCost:
    'This slice records no acquisition cost. Cost enters the books with the capitalisation that '
    + 'posts it, and that posting does not exist yet.',
  originalCost: 'This slice records no cost. See acquisitionCost.',
  cost: 'This slice records no cost. See acquisitionCost.',
  capitalizationDate:
    'A capitalisation date is written BY the posting that capitalises the asset. There is no such '
    + 'posting yet, so a date here would claim one happened.',
  placedInServiceDate:
    'An in-service date is written by the posting that puts the asset into service. See '
    + 'capitalizationDate.',
  accumulatedDepreciation:
    'Accumulated depreciation is the sum of posted charges, never a figure a client supplies.',
  depreciationToDate: 'Depreciation to date is the sum of posted charges. See accumulatedDepreciation.',
  netBookValue: 'Carrying amount is derived from postings, never supplied.',
  carryingAmount: 'Carrying amount is derived from postings, never supplied.',
  bookValue: 'Carrying amount is derived from postings, never supplied.',
  impairmentBalance: 'Impairment is posted, not registered.',
  revaluationSurplusBalance: 'Revaluation is posted, not registered.',
  disposalDate: 'Disposal is posted, not registered.',
  disposalProceeds: 'Disposal is posted, not registered.',
  status:
    'A status is not set directly. An asset is registered as a draft and archived through its own '
    + 'endpoint; every other status asserts a posting that does not exist.',
  createdBy: 'The creator is the signed-in user, taken from the session.',
  updatedBy: 'The editor is the signed-in user, taken from the session.',
  approvedBy: 'Nothing here is approved, and an approver is never supplied by a client.',
  createdAt: 'Timestamps are the server’s.',
  updatedAt: 'Timestamps are the server’s.',
  actorName: 'The actor is the signed-in user, taken from the session.',
  version: 'Send the version as expectedVersion on an update, not as a field to write.',
  organizationId: 'The organization comes from your membership, never from a request.',
  companyId: 'The company comes from the selected books, never from a request.',
  capitalAssetId:
    'A bill line cannot name an asset yet, and an asset cannot name a bill. See the acquisition '
    + 'boundary: what a capital purchase costs and when it is capitalised are not settled.',
  billId: 'An asset is not created from a bill yet. See capitalAssetId.',
  billLineId: 'An asset is not created from a bill yet. See capitalAssetId.',
  serialNumber:
    'This product has never held a serial number on an asset. Use the description or notes rather '
    + 'than a field with a uniqueness rule nothing enforces.',
  assetTag:
    'This product has never held an asset tag. The asset code is the identifier; use it, or record '
    + 'the tag in the notes.',
  barcode: 'This product has never held a barcode on an asset. See assetTag.',
  parentAssetId: COMPONENT_ACCOUNTING_UNSUPPORTED,
  componentOfAssetId: COMPONENT_ACCOUNTING_UNSUPPORTED,
  currency: FOREIGN_CURRENCY_UNSUPPORTED,
  exchangeRate: FOREIGN_CURRENCY_UNSUPPORTED,
  costCenterId:
    'Cost centres are not part of this slice. They dimension a POSTING, and this slice posts '
    + 'nothing.',
  projectId:
    'Projects are not part of this slice. They dimension a POSTING, and this slice posts nothing.',
  attachments: ATTACHMENTS_UNSUPPORTED,
  taxBookId: MULTIPLE_BOOKS_UNSUPPORTED,
  bookId: MULTIPLE_BOOKS_UNSUPPORTED,
  reducingBalanceRatePercent:
    'A reducing-balance rate cannot be stored, because the method itself is not available yet.',
  unitsTotal:
    'A units-of-production capacity cannot be stored, because the method is not available yet — '
    + 'this product has no source of usage to charge against it.',
};

function actorOf(request: FastifyRequest): FixedAssetActor {
  if (!request.permissions) throw errors.forbidden('You do not have access to this organization.');
  return {
    organizationId: request.permissions.organizationId,
    companyId: companyOf(request).id,
    userId: request.principal!.user.id,
    name: request.principal!.user.full_name,
    requestId: request.id,
  };
}

const idOf = (request: FastifyRequest): string => {
  const { id } = request.params as { id?: string };
  if (!id) throw errors.validation('An identifier is required.');
  return id;
};

/**
 * What this slice does NOT do, served as data.
 *
 * A screen reads this rather than restating the sentences, so the product and
 * the API cannot come to disagree about which workflows exist — and a client
 * that renders the list stays correct when F2 removes an entry from it.
 */
export const FIXED_ASSET_CAPABILITIES = {
  registerRecords: true,
  categories: true,
  accountMappings: true,
  archiveAndReactivate: true,
  auditHistory: true,

  acquisitionCost: false,
  capitalization: false,
  depreciationSchedules: false,
  depreciationPosting: false,
  depreciationPreview: false,
  impairment: false,
  revaluation: false,
  disposal: false,
  transfers: false,
  billAcquisition: false,
  componentAccounting: false,
  taxBooks: false,
  multipleBooks: false,
  attachments: false,
  foreignCurrency: false,

  usefulLifeUnit: USEFUL_LIFE_UNIT,
  supportedMethods: DEPRECIATION_METHODS,
  supportedConventions: DEPRECIATION_CONVENTIONS,

  deferred: {
    capitalization: CAPITALIZATION_UNSUPPORTED,
    depreciation: DEPRECIATION_UNSUPPORTED,
    disposal: DISPOSAL_UNSUPPORTED,
    impairment: IMPAIRMENT_UNSUPPORTED,
    revaluation: REVALUATION_UNSUPPORTED,
    transfers: TRANSFER_UNSUPPORTED,
    billAcquisition: BILL_CAPITALIZATION_UNSUPPORTED,
    componentAccounting: COMPONENT_ACCOUNTING_UNSUPPORTED,
    multipleBooks: MULTIPLE_BOOKS_UNSUPPORTED,
    attachments: ATTACHMENTS_UNSUPPORTED,
    foreignCurrency: FOREIGN_CURRENCY_UNSUPPORTED,
  },
} as const;

export async function fixedAssetRoutes(app: FastifyInstance): Promise<void> {
  /*
   * Granular, and each mapped to what the permission catalogue actually
   * defines for this subject. There is no separate "archive" action in the
   * catalogue, so archiving is `edit` — the same reading Inventory applies to
   * the same act. There is no "view cost" action either, and this slice holds
   * no cost for one to gate.
   */
  const view = requireOwnOrganizationPermission('fixed_assets', 'view');
  const create = requireOwnOrganizationPermission('fixed_assets', 'create');
  const edit = requireOwnOrganizationPermission('fixed_assets', 'edit');
  const exportRegister = requireOwnOrganizationPermission('fixed_assets', 'export');

  const onBooks = (
    ...guards: Array<ReturnType<typeof requireOwnOrganizationPermission>>
  ) => [...guards, requireCompanyScope];

  /* ── What this slice supports ───────────────────────────────────────────── */

  app.get(
    '/api/fixed-assets/capabilities',
    { preHandler: onBooks(view) },
    async (_request, reply) => reply.send({ capabilities: FIXED_ASSET_CAPABILITIES }),
  );

  /* ── Categories ─────────────────────────────────────────────────────────── */

  app.get(
    '/api/fixed-assets/categories',
    { preHandler: onBooks(view) },
    async (request, reply) => {
      const query = parse(listCategoriesSchema, request.query);
      return reply.send({
        categories: await categories.listCategories(app.db, actorOf(request), {
          status: query.status,
          search: query.search,
          limit: query.limit ? Number(query.limit) : undefined,
        }),
      });
    },
  );

  app.get(
    '/api/fixed-assets/categories/:id',
    { preHandler: onBooks(view) },
    async (request, reply) =>
      reply.send({ category: await categories.getCategory(app.db, actorOf(request), idOf(request)) }),
  );

  app.get(
    '/api/fixed-assets/categories/:id/history',
    { preHandler: onBooks(view) },
    async (request, reply) =>
      reply.send({
        events: await categories.categoryHistory(app.db, actorOf(request), idOf(request)),
      }),
  );

  app.post(
    '/api/fixed-assets/categories',
    { preHandler: onBooks(create) },
    async (request, reply) => {
      const body = parse(categorySchema, request.body ?? {});
      const created = await categories.createCategory(app.db, actorOf(request), body);
      return reply.code(201).send({ category: created });
    },
  );

  app.patch(
    '/api/fixed-assets/categories/:id',
    { preHandler: onBooks(edit) },
    async (request, reply) => {
      const body = parse(categorySchema.merge(versioned).strict(), request.body ?? {});
      const { expectedVersion, ...input } = body;
      return reply.send({
        category: await categories.updateCategory(
          app.db, actorOf(request), idOf(request), expectedVersion, input,
        ),
      });
    },
  );

  /* Archive and reactivate, never delete. Assets name a category. */
  app.post(
    '/api/fixed-assets/categories/:id/archive',
    { preHandler: onBooks(edit) },
    async (request, reply) => {
      const body = parse(categoryArchiveSchema, request.body ?? {});
      return reply.send({
        category: await categories.setCategoryArchived(
          app.db, actorOf(request), idOf(request), body.expectedVersion, body.archived,
        ),
      });
    },
  );

  /* ── The register ───────────────────────────────────────────────────────── */

  app.get('/api/fixed-assets/assets', { preHandler: onBooks(view) }, async (request, reply) => {
    const query = parse(listAssetsSchema, request.query);
    return reply.send({
      assets: await assets.listAssets(app.db, actorOf(request), {
        status: query.status,
        categoryId: query.categoryId,
        search: query.search,
        limit: query.limit ? Number(query.limit) : undefined,
      }),
    });
  });

  app.get('/api/fixed-assets/assets/:id', { preHandler: onBooks(view) }, async (request, reply) =>
    reply.send({ asset: await assets.getAsset(app.db, actorOf(request), idOf(request)) }));

  app.get(
    '/api/fixed-assets/assets/:id/history',
    { preHandler: onBooks(view) },
    async (request, reply) =>
      reply.send({ events: await assets.assetHistory(app.db, actorOf(request), idOf(request)) }),
  );

  app.post('/api/fixed-assets/assets', { preHandler: onBooks(create) }, async (request, reply) => {
    const body = parse(assetSchema, request.body ?? {});
    const created = await assets.createAsset(app.db, actorOf(request), body);
    return reply.code(201).send({ asset: created });
  });

  app.patch(
    '/api/fixed-assets/assets/:id',
    { preHandler: onBooks(edit) },
    async (request, reply) => {
      const body = parse(assetSchema.merge(versioned).strict(), request.body ?? {});
      const { expectedVersion, ...input } = body;
      return reply.send({
        asset: await assets.updateAsset(
          app.db, actorOf(request), idOf(request), expectedVersion, input,
        ),
      });
    },
  );

  /*
   * Archive, and NOT disposal. An archived asset leaves the working list and
   * keeps everything else: its record, its history and its searchability.
   * Disposal derecognises a cost and posts a gain or a loss, and is F3.
   */
  app.post(
    '/api/fixed-assets/assets/:id/archive',
    { preHandler: onBooks(edit) },
    async (request, reply) => {
      const body = parse(archiveSchema, request.body ?? {});
      return reply.send({
        asset: await assets.setAssetArchived(
          app.db, actorOf(request), idOf(request),
          body.expectedVersion, body.archived, body.reason ?? '',
        ),
      });
    },
  );

  /* ── Reporting ──────────────────────────────────────────────────────────── */

  /*
   * `export` rather than `view`: a register report is the artefact somebody
   * takes out of the system, which is the distinction the catalogue's export
   * action exists to make.
   */
  app.get(
    '/api/fixed-assets/reports/register',
    { preHandler: onBooks(exportRegister) },
    async (request, reply) => reply.send({ report: await registerReport(app.db, actorOf(request)) }),
  );

  /* ── The refusals, by name ──────────────────────────────────────────────── */

  /*
   * Registered rather than left to 404, deliberately.
   *
   * A missing route says "you typed it wrong". These say which accounting
   * decision has not been made, which is the only thing that would let a caller
   * stop and ask rather than build a workaround. Each is behind the same gate
   * as the rest, so the refusal never leaks the existence of a tenant's books.
   */
  const refusals: Array<[string, string]> = [
    ['/api/fixed-assets/assets/:id/capitalize', CAPITALIZATION_UNSUPPORTED],
    ['/api/fixed-assets/assets/:id/acquire', CAPITALIZATION_UNSUPPORTED],
    ['/api/fixed-assets/assets/:id/depreciate', DEPRECIATION_UNSUPPORTED],
    ['/api/fixed-assets/depreciation/runs', DEPRECIATION_UNSUPPORTED],
    ['/api/fixed-assets/depreciation/preview', DEPRECIATION_UNSUPPORTED],
    ['/api/fixed-assets/assets/:id/impair', IMPAIRMENT_UNSUPPORTED],
    ['/api/fixed-assets/assets/:id/revalue', REVALUATION_UNSUPPORTED],
    ['/api/fixed-assets/assets/:id/dispose', DISPOSAL_UNSUPPORTED],
    ['/api/fixed-assets/assets/:id/transfer', TRANSFER_UNSUPPORTED],
    ['/api/fixed-assets/assets/:id/attachments', ATTACHMENTS_UNSUPPORTED],
    ['/api/fixed-assets/assets/from-bill', BILL_CAPITALIZATION_UNSUPPORTED],
  ];

  for (const [url, message] of refusals) {
    app.post(url, { preHandler: onBooks(view) }, async () => {
      throw errors.validation(message);
    });
  }

  /*
   * The depreciation SCHEDULE, refused as a read.
   *
   * A GET that answered with an empty array would be read as "this asset has no
   * depreciation", which is true and misleading: nothing has a schedule,
   * because schedules do not exist. Refusing says so.
   */
  app.get(
    '/api/fixed-assets/assets/:id/schedule',
    { preHandler: onBooks(view) },
    async () => {
      throw errors.validation(DEPRECIATION_UNSUPPORTED);
    },
  );
}

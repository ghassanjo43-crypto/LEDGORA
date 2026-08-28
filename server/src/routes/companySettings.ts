/**
 * The company accounting settings surface.
 *
 * ══ Which company ═══════════════════════════════════════════════════════════
 *
 * From `requireCompanyScope`, resolved from the selector header WITHIN the
 * organization the session established — never from a body field or a path
 * parameter. Settings are per set of books, so the route that reads them is
 * scoped exactly like the books themselves.
 *
 * ══ Reading and writing are not the same permission ══════════════════════════
 *
 * Reading needs `organization_settings.view`: every screen that shows a date
 * needs the fiscal year, and a lapsed subscriber must still be able to look at
 * their own books.
 *
 * Writing needs `manage_organization_settings` AND an active subscription,
 * resolved here from the server's own row. A fiscal year is precisely the kind
 * of permanent record Free Preview may not create.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errors } from '../lib/errors.js';
import { requireOwnOrganizationPermission } from '../guards/permissions.js';
import { requireCompanyScope, companyOf } from '../guards/companyScope.js';
import { organizationMayPersist } from '../guards/persistence.js';
import { readSettings, updateSettings } from '../services/companySettingsService.js';

/**
 * Every field a client may change.
 *
 * `accountingBasis` is deliberately ABSENT: it is accrual, a database CHECK
 * permits nothing else, and offering it here would imply a choice that does not
 * exist. `baseCurrency` is absent too — it lives on the organization and moving
 * it is a separate decision.
 */
const patchSchema = z.object({
  fiscalYearStart: z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/).optional(),
  booksStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  reportingFramework: z.enum(['IFRS', 'IFRS_FOR_SMES', 'US_GAAP', 'OTHER']).optional(),
  taxRegistered: z.boolean().optional(),
  taxRegistrationNumber: z.string().trim().max(64).optional(),
  /** A string, so an exact decimal survives the wire without a float. */
  defaultTaxRate: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/).optional(),
  organizationType: z.string().trim().max(80).optional(),
  industryType: z.string().trim().max(80).optional(),
  logoUrl: z.string().max(2_000_000).optional(),
  email: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(60).optional(),
  website: z.string().trim().max(200).optional(),
  country: z.string().trim().max(80).optional(),
  stateProvince: z.string().trim().max(80).optional(),
  city: z.string().trim().max(80).optional(),
  addressLine1: z.string().trim().max(200).optional(),
  addressLine2: z.string().trim().max(200).optional(),
  postalCode: z.string().trim().max(30).optional(),
  /*
   * Not defaulted. A caller that has not read the settings cannot be allowed to
   * overwrite them, and filling this in would make every update last-write-wins.
   */
  expectedVersion: z.number().int().min(1),
});

/**
 * Turn a schema failure into the 400 the client expects, with field-level
 * messages — the same shape `routes/subscriptions.ts` produces. `schema.parse`
 * would throw a ZodError that nothing maps, and the caller would see a 500 for
 * what is plainly their own typo.
 */
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

function actorOf(request: FastifyRequest) {
  if (!request.permissions) throw errors.forbidden('You do not have access to this organization.');
  return {
    organizationId: request.permissions.organizationId,
    companyId: companyOf(request).id,
    userId: request.principal!.user.id,
    requestId: request.id,
  };
}

export async function companySettingsRoutes(app: FastifyInstance): Promise<void> {
  const view = [
    requireOwnOrganizationPermission('organization_settings', 'view'),
    requireCompanyScope,
  ];
  const manage = [
    requireOwnOrganizationPermission('organization_settings', 'manage_organization_settings'),
    requireCompanyScope,
  ];

  /** The settings for the company this request is scoped to. */
  app.get('/api/organizations/current/company-settings', { preHandler: view }, async (request) => {
    const actor = actorOf(request);
    return { settings: await readSettings(request.server.db, actor.organizationId, actor.companyId) };
  });

  /**
   * Change them.
   *
   * A partial patch: absent fields are left alone rather than reset, so two
   * screens editing different halves cannot undo each other — and the version
   * token catches them when they edit the same half.
   */
  app.patch('/api/organizations/current/company-settings', { preHandler: manage }, async (request) => {
    const body = parse(patchSchema, request.body);
    const { expectedVersion, ...patch } = body;
    const actor = actorOf(request);

    /*
     * The authoritative verdict, from `subscriptions.status`. Platform staff are
     * exempt exactly as they are in `guards/persistence`: they are not
     * subscribers, and their reach is already decided by the permission guard.
     */
    const mayPersist = request.principal!.platformRoles.length > 0
      || (await organizationMayPersist(request.server.db, actor.organizationId));

    const settings = await updateSettings(request.server.db, {
      organizationId: actor.organizationId,
      companyId: actor.companyId,
      expectedVersion,
      mayPersist,
      actorUserId: actor.userId,
      requestId: actor.requestId,
      patch,
    });

    return { settings };
  });
}

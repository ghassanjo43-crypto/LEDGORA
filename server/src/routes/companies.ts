/**
 * The company HTTP surface.
 *
 * ══ Where the organization comes from ════════════════════════════════════════
 *
 * From `requireOwnOrganizationPermission`, which derives it from the caller's
 * own active membership. No route here accepts an organization identifier, so
 * there is no parameter for a modified request to point at another tenant.
 *
 * ══ What these routes deliberately do not offer ══════════════════════════════
 *
 * There is no "get company by id" and no route that takes a server company
 * UUID. Companies are reached by listing the caller's own, or by the selector
 * header — both of which are already confined to one organization. An endpoint
 * keyed on the server id would be an endpoint whose safety depended on
 * remembering to add a tenant check, and the point of the design is that there
 * is nothing to remember.
 *
 * There is also no delete. A company with posted books cannot be removed
 * without removing the books, and that is an account-closure decision made
 * through `services/deletionService`, not a line item on a settings screen.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errors } from '../lib/errors.js';
import { requireOwnOrganizationPermission } from '../guards/permissions.js';
import { organizationMayPersist } from '../guards/persistence.js';
import {
  listCompanies,
  registerCompany,
  lockBookkeepingLanguage,
} from '../services/companyService.js';

const registerSchema = z.object({
  /**
   * The browser's own identifier. Constrained in shape but not in format: real
   * ones look like `co_lx8f2a_9d4kz1`, and a stricter pattern would refuse to
   * adopt books that already exist under an older scheme — which is the one
   * thing this endpoint must never do.
   */
  clientReference: z.string().trim().min(1).max(128),
  legalName: z.string().trim().min(1).max(200),
});

const languageSchema = z.object({
  /** Not defaulted. A default here would be a choice the system made. */
  language: z.enum(['en', 'ar']),
});

function actorOf(request: FastifyRequest) {
  if (!request.permissions) throw errors.forbidden('You do not have access to this organization.');
  return {
    organizationId: request.permissions.organizationId,
    userId: request.principal!.user.id,
    name: request.principal!.user.full_name,
    requestId: request.id,
  };
}

export async function companyRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The caller's own companies.
   *
   * Readable by anyone who may see the organization's settings: a member has to
   * know which sets of books exist in order to choose one, and a company's name
   * is not privileged information inside the tenant that owns it.
   */
  app.get('/api/organizations/current/companies', {
    preHandler: requireOwnOrganizationPermission('organization_settings', 'view'),
  }, async (request) => {
    const { organizationId } = actorOf(request);
    return { companies: await listCompanies(request.server.db, organizationId) };
  });

  /**
   * Register a company: adopt the organization's provisional books, or add a
   * further set.
   *
   * 201 when this call established the registration — whether it ADOPTED the
   * provisional row or inserted an additional company. 200 on an idempotent
   * replay. `adopted` tells the two apart in the body, because the status code
   * answers "did something happen" and the client also needs to know "did a new
   * set of books come into existence", which for an adoption is no.
   *
   * The same reference with a DIFFERENT legal name is refused with 409 once the
   * books are adopted. During adoption itself the name is reconciled instead:
   * nobody had yet agreed what these books were called.
   */
  app.post('/api/organizations/current/companies', {
    preHandler: requireOwnOrganizationPermission('organization_settings', 'manage_organization_settings'),
  }, async (request, reply) => {
    const body = registerSchema.parse(request.body);
    const actor = actorOf(request);

    /*
     * Free Preview grants every feature and no durable storage, and a company
     * row is the most durable record there is. The verdict comes from the
     * server's own subscription row — `organizationMayPersist` reads
     * `subscriptions.status` — never from a workspace mode, a plan name or
     * anything else a request could assert. There is no field in the body or
     * header that reaches this decision, so there is nothing to forge.
     *
     * Platform staff are exempt, exactly as they are in `guards/persistence`:
     * they are not subscribers, and their access to a route is already decided
     * by the permission guard above.
     */
    const mayCreatePermanentCompany = request.principal!.platformRoles.length > 0
      || (await organizationMayPersist(request.server.db, actor.organizationId));

    const { company, created, adopted } = await registerCompany(request.server.db, {
      organizationId: actor.organizationId,
      clientReference: body.clientReference,
      legalName: body.legalName,
      actorUserId: actor.userId,
      mayCreatePermanentCompany,
      requestId: actor.requestId,
    });

    return reply.code(created ? 201 : 200).send({ company, created, adopted });
  });

  /**
   * Choose the bookkeeping language, once and permanently.
   *
   * The company is named by its SERVER id in the path here, which is safe for
   * the reason the file header gives elsewhere in reverse: the service scopes
   * the lookup by the derived organization as well, so an id belonging to
   * another tenant resolves to nothing and answers 404 — the same answer as an
   * id that names nothing at all.
   *
   * The database trigger from migration 022 is the final boundary. This route
   * refusing a second attempt is a courtesy that produces a readable message;
   * the trigger is what makes the guarantee true.
   *
   * Entitlement is checked here for the same reason it is on registration: this
   * is the least reversible act in the product, and a preview customer must not
   * be permanently bound by a choice made while exploring.
   */
  app.post('/api/organizations/current/companies/:companyId/bookkeeping-language', {
    preHandler: requireOwnOrganizationPermission('organization_settings', 'manage_organization_settings'),
  }, async (request) => {
    const body = languageSchema.parse(request.body);
    const { companyId } = request.params as { companyId: string };
    const actor = actorOf(request);

    /* The same authoritative verdict registration uses. See that route above. */
    const mayCreatePermanentCompany = request.principal!.platformRoles.length > 0
      || (await organizationMayPersist(request.server.db, actor.organizationId));

    const company = await lockBookkeepingLanguage(request.server.db, {
      organizationId: actor.organizationId,
      companyId,
      language: body.language,
      actorUserId: actor.userId,
      actorName: actor.name,
      mayCreatePermanentCompany,
      requestId: actor.requestId,
    });

    return { company };
  });
}

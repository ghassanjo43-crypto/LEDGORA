/**
 * The legal-acceptance API.
 *
 * ══ One context only: the caller's own organization ══════════════════════════
 *
 * Every route here derives the organization from the caller's own active
 * membership. No organization id is accepted from the client, so there is
 * nothing to tamper with — the same rule `routes/members.ts` states for the
 * subscriber path, and the reason there is no operator variant: a platform
 * administrator has no business accepting a customer's contract, and offering
 * them a route to do it would be the mechanism this whole feature refuses.
 *
 * ══ Authority is resolved once ═══════════════════════════════════════════════
 *
 * `legal_terms:accept` and `legal_terms:manage_organization_settings` are
 * resolved from the permission service and passed INTO the service, rather than
 * re-derived there. Two authorization decisions in two places is two places to
 * disagree.
 *
 * Reading the status needs no special permission beyond membership: a person
 * cannot acknowledge a document they are not allowed to see.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuthenticatedUser } from '../guards/platform.js';
import { findMembershipForUser } from '../services/organizationService.js';
import { resolvePermissions } from '../services/permissionService.js';
import { permissionKey } from '../config/permissionCatalog.js';
import { readLegalStatus, recordAcceptance, setLegalCountry } from '../services/legalService.js';
import { errors } from '../lib/errors.js';

const documentSchema = z.object({
  documentId: z.enum(['master-terms', 'addendum-ae', 'addendum-jo', 'addendum-sa']),
  version: z.string().trim().min(1).max(64),
  /* A SHA-256 of the exact text shown. Shape-checked here, matched in the service. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/, 'A 64-character SHA-256 hash is required.'),
});

const acceptanceSchema = z.object({
  scope: z.enum(['organization', 'individual']),
  documents: z.array(documentSchema).min(1).max(2),
  /*
   * Deliberately NOT defaulted to true. The screen asks the question with an
   * unticked box; a default here would answer it on the user's behalf, which is
   * the one thing a record of consent must never do.
   */
  bindingAuthorityConfirmed: z.boolean(),
});

const countrySchema = z.object({
  country: z.enum(['AE', 'JO', 'SA']),
  reason: z.string().trim().max(500).optional(),
});

/** The caller's own organization and role, or a refusal. Never from the client. */
async function ownContext(request: Parameters<typeof requireAuthenticatedUser>[0]) {
  const userId = request.principal!.user.id;
  const membership = await findMembershipForUser(request.server.db, userId);
  if (!membership) {
    throw errors.forbidden('You are not a member of an organization.');
  }
  return { userId, organizationId: membership.organizationId, role: membership.role };
}

export async function legalRoutes(app: FastifyInstance): Promise<void> {
  /**
   * What this user and this organization have accepted, and under which country.
   *
   * The client combines this with its own document registry to decide what to
   * present. The SERVER is authoritative for the country and the records; the
   * client is authoritative for nothing.
   */
  app.get('/api/organizations/current/legal/status', {
    preHandler: requireAuthenticatedUser,
  }, async (request) => {
    const { userId, organizationId, role } = await ownContext(request);
    const status = await readLegalStatus(request.server.db, userId, organizationId);

    const permissions = await resolvePermissions(request.server.db, userId, organizationId);
    return {
      ...status,
      actingAsRole: role,
      /*
       * Two DIFFERENT authorities, reported separately so a screen cannot draw
       * one control from the other. They are affordances only: the service
       * re-resolves both and refuses whatever the client believed.
       */
      mayAcknowledgeIndividually:
        permissions.allowedKeys.includes(permissionKey('legal_terms', 'acknowledge')),
      mayAcceptForOrganization:
        permissions.allowedKeys.includes(permissionKey('legal_terms', 'accept_for_organization')),
      mayAdministerLegalCountry:
        permissions.allowedKeys.includes(permissionKey('legal_terms', 'manage_organization_settings')),
    };
  });

  /**
   * Record an acceptance.
   *
   * Idempotent: the same person accepting the same versions at the same hashes
   * converges on one row per document, whether the button was double-clicked,
   * the request retried, or two tabs submitted together.
   */
  app.post('/api/organizations/current/legal/acceptance', {
    preHandler: requireAuthenticatedUser,
  }, async (request, reply) => {
    const body = acceptanceSchema.parse(request.body);
    const { userId, organizationId, role } = await ownContext(request);

    const permissions = await resolvePermissions(request.server.db, userId, organizationId);

    const result = await recordAcceptance(request.server.db, {
      userId,
      organizationId,
      scope: body.scope,
      documents: body.documents,
      bindingAuthorityConfirmed: body.bindingAuthorityConfirmed,
      actingAsRole: role,
      userAgent: request.headers['user-agent'] ?? null,
      mayAcknowledgeIndividually:
        permissions.allowedKeys.includes(permissionKey('legal_terms', 'acknowledge')),
      mayAcceptForOrganization:
        permissions.allowedKeys.includes(permissionKey('legal_terms', 'accept_for_organization')),
    });

    /* 200 on a replay, 201 on a new record: the client can tell them apart. */
    return reply.code(result.idempotentReplay ? 200 : 201).send(result);
  });

  /**
   * Set or change the organization's registered legal country.
   *
   * Restricted to the authority that may bind the organization, because the
   * country decides WHICH agreement binds it.
   */
  app.put('/api/organizations/current/legal/country', {
    preHandler: requireAuthenticatedUser,
  }, async (request) => {
    const body = countrySchema.parse(request.body);
    const { userId, organizationId, role } = await ownContext(request);

    const permissions = await resolvePermissions(request.server.db, userId, organizationId);
    const key = permissionKey('legal_terms', 'manage_organization_settings');
    const mayAdminister = permissions.allowedKeys.includes(key);

    return setLegalCountry(request.server.db, {
      organizationId,
      country: body.country,
      actorUserId: userId,
      actorRole: role,
      mayAdministerLegalCountry: mayAdminister,
      authority: role === 'owner' ? 'primary-owner' : 'explicit-permission',
      reason: body.reason ?? null,
    });
  });
}

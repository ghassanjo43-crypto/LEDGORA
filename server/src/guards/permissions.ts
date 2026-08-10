/**
 * Organization permission guards.
 *
 * ── What these are for ───────────────────────────────────────────────────────
 * `guards/platform.ts` answers "is this caller a Ledgora operator, and which
 * operator capability do they hold?". This file answers the other question:
 * "may this member do this thing, in this organization?" — resolved through
 * `services/permissionService`, which is the only implementation of the
 * precedence rule.
 *
 * ── Why the organization is never taken from the body ────────────────────────
 * `requireOwnOrganizationPermission` derives the organization from the CALLER'S
 * OWN active membership and accepts no identifier from the request at all. There
 * is consequently nothing for a modified request to point somewhere else: tenant
 * isolation here is a property of where the value comes from, not of a check
 * that has to be remembered.
 *
 * The operator counterpart (`requireOrganizationPermissionParam`) does read the
 * organization from the route, which is safe for the opposite reason — it is
 * reachable only behind a platform capability, so being able to type an id buys
 * nothing.
 *
 * ── Why the resolved permissions are cached on the request ───────────────────
 * A handler routinely needs both "may they?" and "what may they?" (to scope a
 * response, or to check the actor before letting them grant something). Resolving
 * twice would be two sets of queries AND two chances to disagree. The guard
 * stashes what it resolved on `request.permissions` for the handler to reuse.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { errors } from '../lib/errors.js';
import { requireAuthenticatedUser } from './platform.js';
import { findMembershipForUser } from '../services/organizationService.js';
import {
  permissionKey,
  isKnownPermission,
  type PermissionAction,
} from '../config/permissionCatalog.js';
import { resolvePermissions, type EffectivePermissions } from '../services/permissionService.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the guards below. The resolution the guard already paid for. */
    permissions: EffectivePermissions | null;
  }
}

/** Register the decorator. Called once from `buildApp`. */
export function decoratePermissions(app: {
  decorateRequest(name: string, value: unknown): void;
}): void {
  app.decorateRequest('permissions', null);
}

/**
 * The caller's own organization, or a 403.
 *
 * "No membership" is deliberately a 403 and not a 404: whether an organization
 * exists is not something an unauthorized caller should be able to probe.
 */
async function ownOrganizationId(request: FastifyRequest): Promise<string> {
  const membership = await findMembershipForUser(request.server.db, request.principal!.user.id);
  if (!membership) {
    throw errors.forbidden('You do not belong to an organization.');
  }
  return membership.organizationId;
}

/**
 * Require a permission inside the CALLER'S OWN organization.
 *
 * This is the guard for every customer-facing protected route. The organization
 * is derived, never supplied.
 */
export function requireOwnOrganizationPermission(subject: string, action: PermissionAction) {
  if (!isKnownPermission(subject, action)) {
    // A typo in a route definition must fail at startup, loudly, rather than
    // becoming a guard that can never pass — or, worse, one that is skipped.
    throw new Error(`Unknown permission "${subject}.${action}" named by a route guard.`);
  }

  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireAuthenticatedUser(request, reply);
    const organizationId = await ownOrganizationId(request);
    const effective = await resolvePermissions(request.server.db, request.principal!.user.id, organizationId);
    request.permissions = effective;

    if (!effective.allowedKeys.includes(permissionKey(subject, action))) {
      throw permissionRefusal(effective, subject, action);
    }
  };
}

/**
 * Require a permission inside an organization named by the route.
 *
 * For operator paths, which have already passed a platform capability guard. A
 * platform super administrator satisfies this by rule 1b of the resolver.
 */
export function requireOrganizationPermissionParam(subject: string, action: PermissionAction) {
  if (!isKnownPermission(subject, action)) {
    throw new Error(`Unknown permission "${subject}.${action}" named by a route guard.`);
  }

  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireAuthenticatedUser(request, reply);
    const params = request.params as Record<string, string | undefined>;
    const organizationId = params.organizationId ?? params.orgId;
    if (!organizationId) throw errors.validation('Organization identifier is required.');

    const effective = await resolvePermissions(request.server.db, request.principal!.user.id, organizationId);
    request.permissions = effective;

    if (!effective.allowedKeys.includes(permissionKey(subject, action))) {
      throw permissionRefusal(effective, subject, action);
    }
  };
}

/**
 * The refusal, worded from the resolved reason.
 *
 * A customer refused because their package does not include a module needs to be
 * told that — "you do not have permission" would send them to their
 * administrator, who cannot help. The distinction matches the codes
 * `lib/accessControl.apiGuard` already returns to the frontend, so the client
 * has one vocabulary for both.
 */
function permissionRefusal(effective: EffectivePermissions, subject: string, action: string) {
  const resolved = effective.permissions.find((p) => p.subject === subject && p.action === action);

  switch (resolved?.source) {
    case 'subscription_inactive':
      return errors.forbidden('Your organization does not have an active subscription.');
    case 'not_entitled':
      return errors.forbidden(`Your plan does not include the ${subject.replace(/_/g, ' ')} module.`);
    case 'membership_inactive':
      return errors.forbidden('Your membership of this organization is not active.');
    case 'no_membership':
      return errors.forbidden('You do not have access to this organization.');
    default:
      return errors.forbidden('You do not have permission to perform this action.');
  }
}

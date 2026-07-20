/**
 * Authorization guards.
 *
 * These are THE authorization decisions. A hidden React menu is not
 * authorization; every sensitive route attaches a guard, and the guard consults
 * the database-backed session — never a client-supplied value.
 *
 * Two independent dimensions, never conflated:
 *  · platform roles      — LEDGORA operators, across tenants.
 *  · organization roles  — a customer's rights inside their own organization.
 * An organization owner therefore never becomes a platform administrator.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OrganizationRole, PlatformRole } from '../db/schema.js';
import { errors } from '../lib/errors.js';

/** Capability → the platform roles that hold it. `support` is read-mostly. */
export type PlatformCapability =
  | 'view-admin'
  | 'manage-users'
  | 'manage-plans'
  | 'manage-billing-settings'
  | 'manage-bank-details'
  | 'verify-payments'
  | 'activate-subscription'
  | 'manage-platform-roles';

const CAPABILITIES: Record<PlatformCapability, PlatformRole[]> = {
  'view-admin': ['super_admin', 'billing_admin', 'support'],
  'manage-users': ['super_admin'],
  'manage-plans': ['super_admin', 'billing_admin'],
  'manage-billing-settings': ['super_admin', 'billing_admin'],
  'manage-bank-details': ['super_admin', 'billing_admin'],
  'verify-payments': ['super_admin', 'billing_admin'],
  // Manual activation bypasses the payment workflow — super_admin only.
  'activate-subscription': ['super_admin'],
  'manage-platform-roles': ['super_admin'],
};

export function roleHasCapability(role: PlatformRole, capability: PlatformCapability): boolean {
  return CAPABILITIES[capability].includes(role);
}

export function hasCapability(roles: PlatformRole[], capability: PlatformCapability): boolean {
  return roles.some((role) => roleHasCapability(role, capability));
}

/** Every authenticated route starts here. */
export async function requireAuthenticatedUser(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.principal) throw errors.unauthenticated();
  if (request.principal.user.status !== 'active') throw errors.accountDisabled();
}

export function requirePlatformRole(role: PlatformRole) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireAuthenticatedUser(request, reply);
    if (!request.principal!.platformRoles.includes(role)) {
      throw errors.forbidden('This action requires a LEDGORA platform administrator.');
    }
  };
}

export function requireAnyPlatformRole(roles: PlatformRole[]) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireAuthenticatedUser(request, reply);
    const held = request.principal!.platformRoles;
    if (!roles.some((role) => held.includes(role))) {
      throw errors.forbidden('This action requires a LEDGORA platform administrator.');
    }
  };
}

export function requirePlatformCapability(capability: PlatformCapability) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireAuthenticatedUser(request, reply);
    if (!hasCapability(request.principal!.platformRoles, capability)) {
      throw errors.forbidden('You do not have permission to perform this action.');
    }
  };
}

/**
 * Organization-scoped guard. Reads the caller's membership for the `:orgId`
 * route parameter. A platform role does NOT satisfy this — cross-tenant access
 * is a separate, explicitly audited path.
 */
export function requireOrganizationRole(allowed: OrganizationRole[]) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireAuthenticatedUser(request, reply);
    const params = request.params as Record<string, string | undefined>;
    const organizationId = params.orgId ?? params.organizationId;
    if (!organizationId) throw errors.validation('Organization identifier is required.');

    const membership = await request.server.db
      .selectFrom('organization_memberships')
      .select(['role', 'status'])
      .where('organization_id', '=', organizationId)
      .where('user_id', '=', request.principal!.user.id)
      .executeTakeFirst();

    if (!membership || membership.status !== 'active' || !allowed.includes(membership.role)) {
      throw errors.forbidden('You do not have access to this organization.');
    }
  };
}

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

/**
 * Capability → the platform roles that hold it. `support` is read-mostly.
 *
 * The dotted names are the granular administration capabilities. They are
 * deliberately separate from the older coarse ones rather than aliases of them:
 * "may read the member directory" and "may reset someone's password" are not the
 * same authority, and collapsing them into one `manage-users` check is how a
 * read-only support role ends up able to issue credentials.
 */
export type PlatformCapability =
  | 'view-admin'
  | 'manage-users'
  | 'manage-plans'
  | 'manage-billing-settings'
  | 'manage-bank-details'
  | 'verify-payments'
  | 'activate-subscription'
  | 'manage-platform-roles'
  | 'subscribers.read'
  | 'subscribers.create'
  | 'subscribers.manage'
  | 'members.read'
  | 'members.manage'
  | 'members.reset_password'
  | 'subscriptions.assign'
  /**
   * User administration proper: bringing an account into existence, moving it
   * between tenants, and configuring what it may do.
   *
   * Separate from `members.manage` on purpose. Changing someone's account status
   * is support work; deciding which organization they belong to and which
   * accounting actions they may perform is not, and a support operator who could
   * do the second through the first would be an escalation path.
   */
  | 'users.create'
  | 'users.assign_organization'
  | 'permissions.read'
  | 'permissions.manage'
  /**
   * Removal, archival and deletion. Deliberately five capabilities rather than
   * one `delete`, because these are not the same act: taking a member out of an
   * organization is routine support work, archiving a tenant is reversible
   * housekeeping, and permanently destroying records is neither.
   */
  | 'members.remove'
  | 'members.delete'
  | 'applicants.delete'
  | 'subscribers.archive'
  | 'subscribers.delete'
  /**
   * Closure workflow. Scheduling a purge and taking a copy of a tenant's data
   * are distinct authorities from archiving, and from each other.
   */
  | 'subscribers.request_deletion'
  | 'subscribers.export';

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

  /* ── Granular administration ──────────────────────────────────────────── */
  // Reading the roster is support work; changing it is not.
  'subscribers.read': ['super_admin', 'billing_admin', 'support'],
  'subscribers.create': ['super_admin'],
  'subscribers.manage': ['super_admin'],
  'members.read': ['super_admin', 'billing_admin', 'support'],
  'members.manage': ['super_admin'],
  /**
   * Issuing a credential is the most sensitive act in this console: it can hand
   * someone else's account to whoever reads the response. super_admin only, and
   * never inherited from a broader "manage" capability.
   */
  'members.reset_password': ['super_admin'],
  /**
   * Assigning a package grants a paid entitlement without a payment, exactly as
   * manual activation does — so it carries the same restriction.
   */
  'subscriptions.assign': ['super_admin'],

  /* ── User administration ──────────────────────────────────────────────── */
  /**
   * Creating an account and placing it in a tenant. super_admin only: these
   * decide WHO exists on the platform and WHOSE books they can see, which is not
   * something a billing or support role should settle.
   */
  'users.create': ['super_admin'],
  'users.assign_organization': ['super_admin'],
  /**
   * Reading someone's effective permissions is diagnostic work — "why can this
   * customer not post a journal?" — so support holds it. Changing them is an
   * authorization decision and does not come with the reading of it.
   */
  'permissions.read': ['super_admin', 'billing_admin', 'support'],
  'permissions.manage': ['super_admin'],

  /* ── Removal, archival, deletion ──────────────────────────────────────── */
  /**
   * Reversible acts a platform administrator handles day to day. Removing a
   * member does not destroy anything: the membership goes, every record they
   * authored and every audit entry naming them stays.
   */
  'members.remove': ['super_admin', 'billing_admin'],
  /**
   * Archiving is the NORMAL way to retire a subscriber — reversible, and it
   * retains everything — so it is not restricted to super_admin.
   */
  'subscribers.archive': ['super_admin', 'billing_admin'],
  /**
   * Permanent destruction, all three super_admin only. Each is irreversible and
   * each is separately gated by a server-side eligibility assessment; the
   * capability is the outer boundary, not the safety mechanism.
   */
  'members.delete': ['super_admin'],
  'applicants.delete': ['super_admin'],
  'subscribers.delete': ['super_admin'],
  /**
   * Scheduling a purge ends in irreversible destruction, so it carries the same
   * restriction as carrying one out — super_admin only, and additionally gated
   * by a step-up password check at the service layer.
   */
  'subscribers.request_deletion': ['super_admin'],
  /**
   * An export is a complete copy of a tenant's account records leaving the
   * system. super_admin only: a support operator diagnosing an account has no
   * need to extract one.
   */
  'subscribers.export': ['super_admin'],
};

export function roleHasCapability(role: PlatformRole, capability: PlatformCapability): boolean {
  return CAPABILITIES[capability].includes(role);
}

export function hasCapability(roles: PlatformRole[], capability: PlatformCapability): boolean {
  return roles.some((role) => roleHasCapability(role, capability));
}

/**
 * Every capability the given roles hold.
 *
 * Returned to the console so it can hide controls the caller cannot use. That is
 * a COURTESY, not authorization — each route re-checks the capability itself, so
 * a client that ignores this list gains nothing.
 */
export function capabilitiesFor(roles: PlatformRole[]): PlatformCapability[] {
  return (Object.keys(CAPABILITIES) as PlatformCapability[]).filter((capability) =>
    hasCapability(roles, capability),
  );
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

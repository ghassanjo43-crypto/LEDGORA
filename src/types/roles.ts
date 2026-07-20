/**
 * Two SEPARATE role dimensions. They must never be conflated:
 *
 *  · `OrganizationRole` — what a person may do inside their own subscriber
 *    organization (their books, their members, their documents).
 *  · `PlatformRole`     — what a LEDGORA *operator* may do across tenants
 *    (verify payments, edit packages, change metering/infrastructure config).
 *
 * A subscriber's organization owner is NOT a LEDGORA platform administrator.
 * In the current frontend-only build every production user has
 * `platformRole: 'none'` — see `lib/platformAccess`.
 */

/** Membership role inside a subscriber organization. */
export type OrganizationRole = 'owner' | 'admin' | 'accountant' | 'member' | 'viewer';

/** LEDGORA platform operator role. `'none'` is every normal customer. */
export type PlatformRole = 'none' | 'support' | 'billing-admin' | 'super-admin';

export const PLATFORM_ROLES: PlatformRole[] = ['none', 'support', 'billing-admin', 'super-admin'];

/** Sensitive operations the platform role gates. */
export type PlatformCapability =
  | 'verify-payments' // approve / reject / request info on payment proofs
  | 'manage-plans' // create & edit subscription packages
  | 'manage-billing-settings' // bank details, grace/term settings
  | 'activate-subscription' // turn a paid subscription on
  | 'manage-metering' // metering configuration
  | 'close-usage-periods'
  | 'view-infra-cost' // infrastructure-cost administration
  | 'manage-any-organization'; // cross-tenant member administration

/**
 * Which platform roles hold which capability. `'none'` holds nothing — a
 * customer can never appear in any of these lists.
 */
const CAPABILITIES: Record<PlatformCapability, PlatformRole[]> = {
  'verify-payments': ['billing-admin', 'super-admin'],
  'manage-plans': ['billing-admin', 'super-admin'],
  'manage-billing-settings': ['billing-admin', 'super-admin'],
  'activate-subscription': ['billing-admin', 'super-admin'],
  'manage-metering': ['super-admin'],
  'close-usage-periods': ['super-admin'],
  'view-infra-cost': ['super-admin'],
  'manage-any-organization': ['super-admin'],
};

/**
 * Pure capability lookup. This does NOT apply the production lock — callers must
 * go through `lib/platformAccess`, which resolves the *effective* role first.
 */
export function platformRoleHasCapability(role: PlatformRole, capability: PlatformCapability): boolean {
  // Fail closed on an unrecognised capability rather than throwing: a typo or a
  // capability added on the backend first must never become an access grant,
  // and must never crash the surface that is checking it.
  return CAPABILITIES[capability]?.includes(role) ?? false;
}

/**
 * Platform-operator entitlement override — the ONE policy that decides whether
 * a verified platform administrator, viewing a subscriber workspace, is granted
 * full feature access.
 *
 * ── What this changes, and what it never changes ─────────────────────────────
 * The override widens the EFFECTIVE module set the entitlement hooks hand to
 * the sidebar, routes, feature gates and action guards. It NEVER writes to the
 * subscriber's subscription: the stored edition, add-ons, limits, billing and
 * audit trail stay exactly what the subscriber pays for, and the moment the
 * operator leaves viewing mode (or signs out) the real package applies again.
 *
 * ── Trust boundary ────────────────────────────────────────────────────────────
 * `full_access` requires ALL of:
 *   1. an EFFECTIVE super-admin role — i.e. backend-verified in production, or
 *      the explicit local-dev simulation (see `lib/platformAccess`). A value a
 *      tenant plants in browser storage resolves to `'none'` and grants nothing;
 *   2. operator subscriber-view mode explicitly active (`operatorViewStore`),
 *      which `readAccessContext` already re-validates against the role;
 *   3. a coherent organization context: when the operator entered viewing mode
 *      for a specific organization, that organization must still be the one
 *      loaded. Any mismatch fails closed.
 *
 * It bypasses ONLY product-package (edition/module/limit) restrictions. It is
 * never consulted by authentication, tenant scoping, record ownership or
 * platform-capability checks — those read the session and role directly.
 */
import type { LedgoraModule } from '@/types/entitlements';
import type { PlatformRole } from '@/types/roles';
import { platformRoleHasCapability } from '@/types/roles';
import { ALL_MODULE_IDS } from '@/config/modules';
import { sortModules } from '@/config/editions';

/**
 * 'full_access'      — administrator mode: every Ledgora edition, module, page
 *                      and feature is reachable (the default while viewing).
 * 'subscriber_view'  — the operator chose "View exactly as subscriber": the
 *                      subscriber's real package applies so the customer
 *                      experience can be verified.
 * 'none'             — no override; normal entitlements apply.
 */
export type PlatformEntitlementOverride = 'full_access' | 'subscriber_view' | 'none';

export interface PlatformOverrideInput {
  /** The EFFECTIVE platform role (backend-verified or explicit dev simulation). */
  platformRole: PlatformRole;
  /** Operator subscriber-view mode is explicitly active. */
  operatorViewActive: boolean;
  /** The operator opted to see the subscriber's real package. */
  viewAsSubscriber: boolean;
  /** The organization the operator entered viewing mode for (null = generic peek). */
  viewedOrganizationId: string | null;
  /** The organization actually loaded in the workspace right now. */
  activeOrganizationId: string | null;
}

/**
 * Every gate-able module — the module set `full_access` resolves to. A superset
 * of every edition preset (Core, Projects, Construction, Manufacturing,
 * Enterprise), including experimental modules, so platform staff can diagnose
 * anything. Stable reference: computed once, never rebuilt per render.
 */
export const FULL_ACCESS_MODULE_IDS: LedgoraModule[] = sortModules(ALL_MODULE_IDS);

/** The single decision. Pure, fail-closed, and trivially unit-testable. */
export function resolvePlatformEntitlementOverride(
  input: PlatformOverrideInput,
): PlatformEntitlementOverride {
  // Only a super-admin (the role that may manage any organization) qualifies.
  if (!platformRoleHasCapability(input.platformRole, 'manage-any-organization')) return 'none';
  // Only inside explicit, session-scoped operator viewing mode.
  if (!input.operatorViewActive) return 'none';
  // The viewed-organization context must match the loaded workspace. A viewing
  // record naming an organization that is not the one loaded (or none loaded)
  // is incoherent — fail closed rather than widen access over unknown data.
  if (input.viewedOrganizationId !== null) {
    if (input.activeOrganizationId === null) return 'none';
    if (input.viewedOrganizationId !== input.activeOrganizationId) return 'none';
  }
  return input.viewAsSubscriber ? 'subscriber_view' : 'full_access';
}

/** The module list the entitlement layer should serve under an override. */
export function overriddenModuleIds(
  override: PlatformEntitlementOverride,
  owned: LedgoraModule[],
): LedgoraModule[] {
  return override === 'full_access' ? FULL_ACCESS_MODULE_IDS : owned;
}

/**
 * Metadata attached to audit records for actions an operator performs inside a
 * subscriber workspace. Audit must identify the ADMINISTRATOR — never the
 * subscriber owner — plus the organization acted on and the mode.
 */
export interface OperatorAuditMetadata {
  /** The authenticated administrator (backend user id, or the dev-sim label). */
  operatorUserId: string;
  operatorEmail?: string;
  /** The organization the action was performed in. */
  organizationId: string | null;
  operatorViewMode: Exclude<PlatformEntitlementOverride, 'none'>;
  /** ISO timestamp the metadata was captured. */
  at: string;
}

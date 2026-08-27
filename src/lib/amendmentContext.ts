/**
 * Who is acting, in which tenant, on whose books — assembled from the live
 * stores in one place so the amendment service, the stores and the UI all read
 * the same answer.
 *
 * The same trust boundary `store/platformFullAccess` documents applies here:
 * the platform role comes from the resolved override, never from a browser-held
 * value on its own, and `actingAsPlatformOperator` being true is a REFUSAL in
 * `resolveAmendmentPermission`, not a grant.
 *
 * ── What `actingAsPlatformOperator` actually means ───────────────────────────
 * NOT "this person holds a platform role". It means "this person reached the
 * organization now open through PLATFORM authority rather than through a
 * membership in it".
 *
 * The distinction is the whole point. A Super Admin viewing a subscriber's
 * workspace has no membership there, so platform status is the only thing
 * putting them in front of those books — and platform status is not subscriber
 * authorization, so they are refused. The same Super Admin working inside a
 * development organization they OWN is a member of it, and their platform role
 * is irrelevant: they act by their organization role like anybody else.
 * Refusing them there would take their own books away from them on the strength
 * of a role they hold somewhere else.
 *
 * ── Why membership, and never classification ─────────────────────────────────
 * The same rule could be phrased "development organizations are open, production
 * ones are not". It must not be, because that rule is bypassable: reclassify a
 * production subscriber as development and the gate opens. Membership cannot be
 * bypassed that way — relabelling an organization makes nobody a member of it —
 * so nothing here reads a classification, and `amendmentPlatformOperator.test`
 * holds that line.
 *
 * ── Tenant scoping ───────────────────────────────────────────────────────────
 * `organizationId` is the ACTIVE WORKSPACE's id, read from the storage adapter
 * rather than from anything a caller passed in. That is what makes a
 * cross-tenant amendment unrepresentable rather than merely refused: the
 * document stores are namespaced per workspace, so an id belonging to another
 * organization is not in the array being searched and resolves to "not found".
 * `companyId` narrows the same way inside one tenant — only the active
 * company's books are loaded into the working stores at any moment.
 */
import type { OrganizationRole } from '@/types/roles';
import type { AmendmentPermissionInput } from '@/lib/amendmentPermissions';
import { getActiveWorkspace } from '@/lib/workspaceStorage';
import { getCurrentUser } from '@/store/authStore';
import { isPlatformAdminFullAccess, resolveAuditActor } from '@/store/platformFullAccess';
import { getSubscriptionStatus } from '@/store/entitlementHooks';
import { subscriptionAllowsPosting } from '@/lib/subscriptionPostingGuard';
import { useCompanyStore } from '@/store/companyStore';

export interface AmendmentContext {
  organizationId: string;
  companyId: string;
  role: OrganizationRole;
  userId?: string;
  actorName: string;
  membershipActive: boolean;
  subscriptionActive: boolean;
  actingAsPlatformOperator: boolean;
}

/** The default for the single-user local workspace, which has no directory. */
const LOCAL_ACTOR = 'Finance Manager';

export function readAmendmentContext(): AmendmentContext {
  const user = getCurrentUser();
  const workspace = getActiveWorkspace();
  /** The operator entitlement override — viewing mode, verified role, coherent. */
  const override = isPlatformAdminFullAccess();

  /*
   * The organization whose books are actually open.
   *
   * In operator viewing mode this is the VIEWED tenant, because that is the
   * namespace `openBusinessWorkspace` points the stores at — the operator is
   * looking at that tenant's records, so that is the tenant the membership
   * question has to be asked about.
   */
  const organizationId = workspace?.organizationId ?? user?.organizationId ?? 'local';

  // Absent status is the single-user local workspace and the self-registered
  // owner, both of which are active. Only an explicit non-active state denies.
  const membershipActive = !user?.status || user.status === 'active';

  /*
   * Is the acting user a member of THIS organization?
   *
   * This is what separates "a Super Admin in a subscriber's workspace" from "a
   * Super Admin in their own development organization". Both hold the platform
   * role; only the second holds a membership in the books that are open.
   */
  const memberOfThisOrganization =
    !!user && !!user.organizationId && user.organizationId === organizationId && membershipActive;

  const actingAsPlatformOperator = override && !memberOfThisOrganization;

  return {
    organizationId,
    companyId: useCompanyStore.getState().activeCompanyId || 'primary',
    /*
     * A member acts by their OWN organization role, whatever else they are
     * elsewhere. Only somebody present purely on platform authority is reported
     * as `admin`, matching what every other document store does
     * (`invoiceStore.currentRole`) — and that case is refused anyway, so the
     * role it reports is what the audit event records rather than a grant.
     */
    role: memberOfThisOrganization
      ? user.role
      : actingAsPlatformOperator
        ? 'admin'
        : (user?.role ?? 'owner'),
    userId: user?.id,
    actorName: resolveAuditActor(user?.fullName || LOCAL_ACTOR),
    membershipActive,
    subscriptionActive: subscriptionAllowsPosting(getSubscriptionStatus()),
    actingAsPlatformOperator,
  };
}

/** The context in the shape `resolveAmendmentPermission` consumes. */
export function permissionInput(
  context: AmendmentContext,
  policy: AmendmentPermissionInput['policy'],
): AmendmentPermissionInput {
  return {
    role: context.role,
    userId: context.userId,
    membershipActive: context.membershipActive,
    subscriptionActive: context.subscriptionActive,
    actingAsPlatformOperator: context.actingAsPlatformOperator,
    policy,
  };
}

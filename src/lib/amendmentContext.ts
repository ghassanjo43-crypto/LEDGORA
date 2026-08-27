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
  const operator = isPlatformAdminFullAccess();
  const workspace = getActiveWorkspace();
  return {
    organizationId: workspace?.organizationId ?? user?.organizationId ?? 'local',
    companyId: useCompanyStore.getState().activeCompanyId || 'primary',
    /*
     * A platform operator acts with `admin` authority for every OTHER purpose
     * in this application (see `invoiceStore.currentRole`), which is why the
     * refusal is expressed by `actingAsPlatformOperator` rather than by
     * pretending the operator holds a weaker role. The role reported here is
     * the one the audit event records.
     */
    role: operator ? 'admin' : (user?.role ?? 'owner'),
    userId: user?.id,
    actorName: resolveAuditActor(user?.fullName || LOCAL_ACTOR),
    // Absent status is the single-user local workspace and the self-registered
    // owner, both of which are active. Only an explicit non-active state denies.
    membershipActive: !user?.status || user.status === 'active',
    subscriptionActive: subscriptionAllowsPosting(getSubscriptionStatus()),
    actingAsPlatformOperator: operator,
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

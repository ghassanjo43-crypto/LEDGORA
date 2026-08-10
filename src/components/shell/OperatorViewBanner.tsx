/**
 * Persistent banner shown while a platform operator is viewing the subscriber
 * application. It makes the cross-tenant context unmistakable, states that the
 * subscriber's subscription is NOT changed by the operator's full feature
 * access, and offers the one way back to administration.
 *
 * It renders ONLY for a genuine effective operator with viewing mode active — a
 * tenant can never see it, because their effective role is `'none'`. The
 * access mode itself is decided centrally (`usePlatformEntitlementOverride`);
 * this banner only reports it and toggles the optional exact-subscriber view.
 */
import { Eye, ShieldAlert } from 'lucide-react';
import { useOperatorViewStore } from '@/store/operatorViewStore';
import { usePlatformEntitlementOverride } from '@/store/platformFullAccess';
import { useEffectivePlatformRole } from '@/hooks/usePlatformRole';
import { isPlatformOperator, ROUTES } from '@/lib/accessControl';
import { useRouterStore } from '@/store/routerStore';
import { useEffectiveOrganizationSync } from '@/store/effectiveOrganization';
import { useMemberDirectoryStore } from '@/store/memberDirectoryStore';

export function OperatorViewBanner() {
  const active = useOperatorViewStore((s) => s.active);
  const orgName = useOperatorViewStore((s) => s.orgName);
  const viewAsSubscriber = useOperatorViewStore((s) => s.viewAsSubscriber);
  const setViewAsSubscriber = useOperatorViewStore((s) => s.setViewAsSubscriber);
  const exit = useOperatorViewStore((s) => s.exit);
  const role = useEffectivePlatformRole();
  const override = usePlatformEntitlementOverride();
  const navigate = useRouterStore((s) => s.navigate);
  // Confirms the viewed organization against the backend and keeps that
  // confirmation in step when the operator switches subscribers.
  const context = useEffectiveOrganizationSync();
  const clearMembers = useMemberDirectoryStore((s) => s.clear);

  if (!active || !isPlatformOperator(role)) return null;

  const returnToConsole = (): void => {
    // Clear the selected subscriber context (and any full-access override with
    // it) first, then route back. The role is never touched — the operator was
    // a super-admin throughout.
    // The roster goes too: a cached member list is tenant data, and it must not
    // be sitting there when the next subscriber's workspace is opened.
    clearMembers();
    exit();
    navigate(ROUTES.adminConsole, { replace: true });
  };

  // Prefer the name the BACKEND confirmed for the viewed organization over the
  // label carried in sessionStorage: the two are the pair that disagreed in the
  // Members-page defect, and the server is the authority on which tenant this is.
  const subscriberName = context.organizationName ?? orgName ?? 'The subscriber';
  const message =
    override === 'full_access'
      ? `You are viewing Ledgora as a platform administrator with full feature access. ${subscriberName}’s subscription remains unchanged.`
      : override === 'subscriber_view'
        ? `You are viewing Ledgora exactly as ${subscriberName}’s users see it — their real package applies.`
        : 'You are viewing Ledgora as a platform administrator.';

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 bg-amber-500 px-4 py-2 text-sm font-medium text-amber-950"
    >
      <span className="flex items-center gap-2">
        <ShieldAlert className="h-4 w-4" aria-hidden />
        {message}
      </span>
      <span className="flex flex-wrap items-center gap-2">
        {override !== 'none' && (
          <button
            type="button"
            onClick={() => setViewAsSubscriber(!viewAsSubscriber)}
            aria-pressed={viewAsSubscriber}
            className="focus-ring flex items-center gap-1.5 rounded-md bg-amber-950/10 px-3 py-1 font-semibold hover:bg-amber-950/20"
          >
            <Eye className="h-3.5 w-3.5" aria-hidden />
            {viewAsSubscriber ? 'Back to full access' : 'View exactly as subscriber'}
          </button>
        )}
        <button
          type="button"
          onClick={returnToConsole}
          className="focus-ring rounded-md bg-amber-950/10 px-3 py-1 font-semibold underline-offset-2 hover:bg-amber-950/20 hover:underline"
        >
          Return to admin console
        </button>
      </span>
    </div>
  );
}

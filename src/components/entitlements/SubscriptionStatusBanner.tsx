import { AlertTriangle, ArrowRight } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { useEntitlementStore } from '@/store/entitlementStore';
import { statusIsExpired, statusIsSuspended } from '@/lib/entitlementResolution';

/**
 * A dismissible-free warning banner shown when the subscription is not in good
 * standing. Sign-in and reporting continue; NEW posting is blocked. Never
 * rendered for trial/active/past-due.
 */
export function SubscriptionStatusBanner() {
  const status = useEntitlementStore((s) => s.subscription.status);
  const setActiveView = useStore((s) => s.setActiveView);

  const blocked = statusIsSuspended(status) || statusIsExpired(status);
  if (!blocked) return null;

  const label =
    status === 'expired'
      ? 'Your Ledgora subscription has expired.'
      : status === 'cancelled'
        ? 'Your Ledgora subscription is cancelled.'
        : 'Your Ledgora subscription is suspended.';

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 print:hidden">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="font-medium">{label}</span>
      <span className="text-amber-700/90 dark:text-amber-200/80">
        New posting is blocked and your data is preserved. Reactivate after
        bank-remittance confirmation to resume.
      </span>
      <button
        type="button"
        onClick={() => setActiveView('subscription')}
        className="focus-ring ml-auto inline-flex items-center gap-1 rounded font-medium underline-offset-2 hover:underline"
      >
        Manage subscription <ArrowRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

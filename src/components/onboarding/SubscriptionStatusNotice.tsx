/**
 * Plain-language statement of where the account currently stands, shown above
 * package selection so the subscription's status is never ambiguous.
 */
import type { AccountStatus } from '@/types/session';
import { Alert } from '@/components/ui/Alert';
import { useOrganizationStore } from '@/store/organizationStore';

const STATUS_TEXT: Record<AccountStatus, { variant: 'info' | 'warning' | 'success'; title: string; body: string }> = {
  anonymous: { variant: 'info', title: 'Not signed in', body: 'Create an account or sign in to choose a package.' },
  'registered-no-plan': {
    variant: 'info',
    title: 'No subscription yet',
    body: 'Choose a package to activate LEDGORA, or explore the free demo first. The accounting application opens once a package or the demo is selected.',
  },
  'free-demo': {
    variant: 'warning',
    title: 'Free Demo running',
    body: 'You are working in a temporary demonstration workspace. Choose a package to keep your records.',
  },
  trial: { variant: 'success', title: 'Trial active', body: 'Your trial is running. Choose a package before it ends to keep working.' },
  subscribed: { variant: 'success', title: 'Subscription active', body: 'Your subscription is active.' },
  'past-due': { variant: 'warning', title: 'Payment past due', body: 'Settle the open invoice to avoid interruption.' },
  suspended: { variant: 'warning', title: 'Subscription suspended', body: 'Contact support or choose a package to restore access.' },
};

export function SubscriptionStatusNotice({ accountStatus }: { accountStatus: AccountStatus }) {
  const lifecycle = useOrganizationStore((s) => s.subscription?.status ?? null);
  const meta = STATUS_TEXT[accountStatus];

  return (
    <Alert variant={meta.variant} title={meta.title} className="mb-4">
      {meta.body}
      {lifecycle && lifecycle !== 'active' && (
        <span className="mt-1 block text-xs opacity-80">
          Current subscription request: <b>{lifecycle.replace(/_/g, ' ')}</b>.
        </span>
      )}
    </Alert>
  );
}

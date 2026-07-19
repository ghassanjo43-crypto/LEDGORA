import { SubscriptionSettingsPage } from '@/components/settings/SubscriptionSettingsPage';
import { useIsFreeDemo } from '@/hooks/useSession';

/** Route target for the `subscription` view (/settings/subscription). */
export function SubscriptionPage() {
  // A Free Demo visitor reaching this page came from "Choose a package", so the
  // package catalogue opens directly and administration controls stay hidden.
  const isDemo = useIsFreeDemo();
  return <SubscriptionSettingsPage initialTab={isDemo ? 'packages' : 'overview'} onboardingMode={isDemo} />;
}

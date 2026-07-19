/**
 * Subscription selection for a `registered-no-plan` user.
 *
 * Two clear paths, no duplicated package management:
 *  · Paid package — the existing subscription flow (draft → invoice → bank
 *    remittance → administrator verification → activation) is used unchanged.
 *    Nothing here marks a package active on its own.
 *  · Free Demo — a $0, memory-only demonstration workspace.
 */
import { useRef } from 'react';
import { useAccountStatus } from '@/hooks/useSession';
import { FreeDemoCard } from '@/components/onboarding/FreeDemoCard';
import { OnboardingSubscriptionPage } from './OnboardingSubscriptionPage';
import { SubscriptionStatusNotice } from '@/components/onboarding/SubscriptionStatusNotice';

export function SubscriptionOnboardingPage() {
  const status = useAccountStatus();
  const packagesRef = useRef<HTMLDivElement>(null);

  return (
    <div className="min-h-full bg-slate-50 dark:bg-slate-950">
      <div className="mx-auto max-w-5xl px-4 pt-8 sm:px-6">
        <SubscriptionStatusNotice accountStatus={status} />
        <FreeDemoCard
          onChoosePackage={() => packagesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        />
      </div>
      <div ref={packagesRef}>
        <OnboardingSubscriptionPage />
      </div>
    </div>
  );
}

/**
 * Public pricing page. Lists every ACTIVE base plan and optional module straight
 * from the super-admin-editable metering configuration — no login required.
 * Choosing a plan sends visitors to /register?plan={code} (per the spec) or,
 * for signed-in users, into the subscription step.
 */
import { useMemo } from 'react';
import { useMeteringConfigStore } from '@/store/meteringConfigStore';
import { useAuthStore } from '@/store/authStore';
import { useRouterStore } from '@/store/routerStore';
import { PublicShell, money } from '@/components/onboarding/OnboardingChrome';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Icon } from '@/components/ui/icons';

const PLAN_BLURB: Record<string, string> = {
  core: 'Everything a small business needs to keep IFRS-compliant books.',
  professional: 'Growing teams with more users, companies and volume.',
  business: 'Scaling finance operations across multiple companies.',
  enterprise: 'Custom limits, consolidation and dedicated support.',
};

function planHighlights(a: {
  users: number;
  companies: number;
  storageGb: number;
  journalEntries: number;
}): string[] {
  return [
    `${a.users} users included`,
    `${a.companies} ${a.companies === 1 ? 'company' : 'companies'}`,
    `${a.storageGb} GB document storage`,
    `${a.journalEntries.toLocaleString()} journal entries / mo`,
  ];
}

export function PricingPage() {
  const config = useMeteringConfigStore((s) => s.config);
  const currentUserId = useAuthStore((s) => s.currentUserId);
  const navigate = useRouterStore((s) => s.navigate);

  const plans = useMemo(
    () => config.basePlans.filter((p) => p.isActive).sort((a, b) => a.sortOrder - b.sortOrder),
    [config.basePlans],
  );
  const modules = useMemo(
    () => config.optionalModules.filter((m) => m.isActive).sort((a, b) => a.sortOrder - b.sortOrder),
    [config.optionalModules],
  );

  const choose = (code: string): void => {
    if (currentUserId) navigate(`/onboarding/subscription?plan=${code}`);
    else navigate(`/register?plan=${code}`);
  };

  return (
    <PublicShell>
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="text-center">
          <Badge tone="violet">Simple, usage-fair pricing</Badge>
          <h1 className="mt-3 text-3xl font-bold text-slate-900 dark:text-slate-50">Choose your Ledgora plan</h1>
          <p className="mx-auto mt-2 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            One application, one accounting engine. Start on any plan and add optional modules, users and companies as
            you grow. Billed monthly in USD via bank remittance.
          </p>
        </div>

        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {plans.map((plan) => {
            const featured = plan.code === 'professional';
            return (
              <div
                key={plan.id}
                className={
                  'flex flex-col rounded-2xl border bg-white p-5 shadow-sm dark:bg-slate-900 ' +
                  (featured
                    ? 'border-brand-500 ring-1 ring-brand-500'
                    : 'border-slate-200 dark:border-slate-800')
                }
              >
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">{plan.name}</h2>
                  {featured && <Badge tone="indigo">Popular</Badge>}
                </div>
                <p className="mt-1 min-h-[40px] text-xs text-slate-500 dark:text-slate-400">
                  {PLAN_BLURB[plan.code] ?? ''}
                </p>
                <div className="mt-3">
                  {plan.startingAt && <span className="text-xs text-slate-400">from</span>}
                  <div className="flex items-end gap-1">
                    <span className="text-3xl font-bold text-slate-900 dark:text-slate-50">
                      {money(plan.priceMonthly, plan.currency)}
                    </span>
                    <span className="pb-1 text-xs text-slate-400">/ month</span>
                  </div>
                </div>
                <ul className="mt-4 space-y-1.5 text-xs text-slate-600 dark:text-slate-300">
                  {planHighlights(plan.allowances).map((h) => (
                    <li key={h} className="flex items-center gap-1.5">
                      <Icon.Check className="h-3.5 w-3.5 text-emerald-500" />
                      {h}
                    </li>
                  ))}
                </ul>
                <Button
                  className="mt-5 w-full"
                  variant={featured ? 'primary' : 'outline'}
                  onClick={() => choose(plan.code)}
                >
                  Choose {plan.name.replace('Ledgora ', '')}
                </Button>
              </div>
            );
          })}
        </div>

        <div className="mt-14">
          <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Optional modules</h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Add any module to any plan during checkout.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {modules.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900"
              >
                <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{m.name}</span>
                <span className="text-sm text-slate-500 dark:text-slate-400">
                  +{money(m.priceMonthly, m.currency)}/mo
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </PublicShell>
  );
}

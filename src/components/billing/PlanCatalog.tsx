import { useMemo, useState } from 'react';
import { Check, ArrowUpRight, ArrowDownRight, Loader2 } from 'lucide-react';
import type { SubscriptionPlan } from '@/types/billing';
import { useBillingStore, publicPlans } from '@/store/billingStore';
import { useActivePlan, usePlans } from '@/store/billingHooks';
import { useSubscriberPlanCatalog } from '@/store/planCatalogSync';
import { EDITION_INFO } from '@/config/editionCommercialInfo';
import { EDITION_RANK } from '@/lib/billingCalculations';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { formatCurrency } from '@/lib/money';
import { cn } from '@/lib/utils';
import { Package } from 'lucide-react';

/**
 * Package selection — step 1 of the payment process. Selecting a package issues
 * a subscription invoice and hands the invoice id back so the parent can move to
 * the bank-instructions / proof-upload step.
 */
export function PlanCatalog({ onInvoiceIssued }: { onInvoiceIssued: (invoiceId: string) => void }) {
  /*
   * Reads the SAME canonical records the Super Admin edits, through the PUBLIC
   * endpoint.
   *
   * This used to call the admin sync, which reads `/api/admin/plans` — an
   * endpoint gated on a platform capability no subscriber holds. Every customer
   * therefore got a 403, the error was swallowed, and the seeded browser-local
   * names stayed on screen no matter how often the package was renamed.
   */
  const catalogState = useSubscriberPlanCatalog();
  const plans = usePlans();
  const activePlan = useActivePlan();
  const requestSubscription = useBillingStore((s) => s.requestSubscription);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const catalog = useMemo(() => publicPlans(plans), [plans]);

  const onSelect = (plan: SubscriptionPlan): void => {
    setError(null);
    setBusyId(plan.id);
    const res = requestSubscription(plan.id);
    setBusyId(null);
    if (!res.ok || !res.id) {
      setError(res.error ?? 'Could not start the subscription request.');
      return;
    }
    onInvoiceIssued(res.id);
  };

  /*
   * Three different facts, three different answers. Collapsing them into one
   * empty state is how "the platform is unreachable" comes to look like "there
   * is nothing for sale".
   */
  if (catalogState.status === 'loading') {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-slate-500" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading packages…
      </div>
    );
  }

  if (catalogState.status === 'error') {
    // Deliberately NOT a fallback to whatever this browser last held: a stale
    // price on a purchase screen is worse than an honest failure.
    return (
      <EmptyState
        icon={Package}
        title="Packages are unavailable"
        description={`${catalogState.error ?? 'The platform service did not answer.'} Please try again shortly.`}
        action={<Button variant="outline" size="sm" onClick={() => void catalogState.reload()}>Try again</Button>}
      />
    );
  }

  if (catalog.length === 0) {
    return <EmptyState icon={Package} title="No packages available" description="An administrator has not published any packages yet." />;
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {catalog.map((plan) => {
          const info = EDITION_INFO[plan.edition];
          const isCurrent = activePlan?.id === plan.id;
          const rankDelta = activePlan ? EDITION_RANK[plan.edition] - EDITION_RANK[activePlan.edition] : 0;
          const label = !activePlan
            ? 'Select package'
            : isCurrent
              ? 'Renew'
              : rankDelta > 0
                ? 'Upgrade'
                : 'Downgrade';
          return (
            <Card key={plan.id} className={cn('flex flex-col', isCurrent && 'ring-1 ring-brand-400 dark:ring-brand-500/50')}>
              <CardBody className="flex flex-1 flex-col">
                <div className="flex items-center justify-between">
                  <Badge tone={info?.tone ?? 'slate'}>{plan.name}</Badge>
                  {isCurrent && <Badge tone="green"><Check className="h-3 w-3" /> Current</Badge>}
                </div>
                <div className="mt-3">
                  <span className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                    {formatCurrency(plan.priceMonthly, plan.currency)}
                  </span>
                  <span className="text-sm text-slate-400"> / month</span>
                </div>
                <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">{plan.description}</p>
                <ul className="mt-3 space-y-1 text-xs text-slate-500 dark:text-slate-400">
                  <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-emerald-500" /> Up to {plan.userLimit} users</li>
                  <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-emerald-500" /> Up to {plan.entityLimit} {plan.entityLimit === 1 ? 'entity' : 'entities'}</li>
                  {(info?.highlights ?? []).slice(0, 2).map((h) => (
                    <li key={h} className="flex items-center gap-1.5"><Check className="h-3 w-3 text-emerald-500" /> {h}</li>
                  ))}
                </ul>
                <div className="mt-4 flex-1" />
                <Button
                  variant={isCurrent ? 'outline' : 'primary'}
                  size="sm"
                  className="w-full justify-center"
                  disabled={busyId !== null}
                  onClick={() => onSelect(plan)}
                >
                  {busyId === plan.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : rankDelta > 0 && !isCurrent ? (
                    <ArrowUpRight className="h-4 w-4" />
                  ) : rankDelta < 0 && !isCurrent ? (
                    <ArrowDownRight className="h-4 w-4" />
                  ) : null}
                  {label}
                </Button>
              </CardBody>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

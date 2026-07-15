/**
 * Subscription selection. Preselects the plan chosen on the public pricing page
 * (?plan=), lets the user change the plan, add optional modules and extra
 * users/companies, and reviews the live monthly USD total. Confirming drafts the
 * subscription, raises an invoice with a unique payment reference and moves to
 * the bank-remittance payment step.
 */
import { useMemo, useState } from 'react';
import { useMeteringConfigStore } from '@/store/meteringConfigStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useRouterStore } from '@/store/routerStore';
import { priceSubscription, type SubscriptionCart } from '@/lib/onboardingPricing';
import { CenteredCard, Stepper, money } from '@/components/onboarding/OnboardingChrome';
import { ROUTES } from '@/lib/accessControl';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Icon } from '@/components/ui/icons';

export function OnboardingSubscriptionPage() {
  const config = useMeteringConfigStore((s) => s.config);
  const existing = useOrganizationStore((s) => s.subscription);
  const saveDraft = useOrganizationStore((s) => s.saveDraftSubscription);
  const confirm = useOrganizationStore((s) => s.confirmSubscription);
  const navigate = useRouterStore((s) => s.navigate);
  const planFromUrl = useRouterStore((s) => s.query.plan);

  const plans = useMemo(
    () => config.basePlans.filter((p) => p.isActive).sort((a, b) => a.sortOrder - b.sortOrder),
    [config.basePlans],
  );
  const modules = useMemo(
    () => config.optionalModules.filter((m) => m.isActive).sort((a, b) => a.sortOrder - b.sortOrder),
    [config.optionalModules],
  );

  const initialPlan =
    (planFromUrl && plans.some((p) => p.code === planFromUrl) && planFromUrl) ||
    existing?.basePlanCode ||
    plans[0]?.code ||
    'core';

  const [basePlanCode, setBasePlanCode] = useState(initialPlan);
  const [addOns, setAddOns] = useState<string[]>(existing?.addOnModuleCodes ?? []);
  const [extraUsers, setExtraUsers] = useState(existing?.extraUsers ?? 0);
  const [extraCompanies, setExtraCompanies] = useState(existing?.extraCompanies ?? 0);
  const [error, setError] = useState<string | null>(null);

  const cart: SubscriptionCart = { basePlanCode, addOnModuleCodes: addOns, extraUsers, extraCompanies };
  const pricing = useMemo(() => priceSubscription(config, cart), [config, basePlanCode, addOns, extraUsers, extraCompanies]);

  const toggleAddOn = (code: string): void =>
    setAddOns((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));

  const confirmSubscription = (): void => {
    setError(null);
    const draft = saveDraft(cart);
    if (!draft.ok) {
      setError(draft.error ?? 'Could not save your selection.');
      return;
    }
    const res = confirm();
    if (!res.ok) {
      setError(res.error ?? 'Could not confirm your subscription.');
      return;
    }
    navigate(ROUTES.billingPayment);
  };

  const rates = config.overageRates;

  return (
    <CenteredCard title="Choose your subscription" subtitle="Adjust your plan, modules and capacity. Billed monthly in USD." width="xl">
      <Stepper current="Subscription" />
      {error && <Alert variant="error" className="mb-4">{error}</Alert>}

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          {/* Base plan */}
          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">Base plan</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {plans.map((plan) => {
                const selected = plan.code === basePlanCode;
                return (
                  <button
                    key={plan.id}
                    type="button"
                    onClick={() => setBasePlanCode(plan.code)}
                    className={
                      'rounded-xl border p-3 text-left transition-colors ' +
                      (selected
                        ? 'border-brand-500 ring-1 ring-brand-500 bg-brand-50/50 dark:bg-brand-500/10'
                        : 'border-slate-200 hover:border-slate-300 dark:border-slate-700')
                    }
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-slate-900 dark:text-slate-50">{plan.name}</span>
                      {selected && <Icon.Check className="h-4 w-4 text-brand-600" />}
                    </div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {plan.startingAt ? 'from ' : ''}
                      {money(plan.priceMonthly, plan.currency)}/mo · {plan.allowances.users} users · {plan.allowances.companies} co.
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Optional modules */}
          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">Optional modules</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {modules.map((m) => {
                const on = addOns.includes(m.code);
                return (
                  <label
                    key={m.id}
                    className={
                      'flex cursor-pointer items-center justify-between rounded-xl border p-3 transition-colors ' +
                      (on ? 'border-brand-500 bg-brand-50/50 dark:bg-brand-500/10' : 'border-slate-200 dark:border-slate-700')
                    }
                  >
                    <span className="flex items-center gap-2 text-sm text-slate-800 dark:text-slate-100">
                      <input type="checkbox" checked={on} onChange={() => toggleAddOn(m.code)} />
                      {m.name}
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">+{money(m.priceMonthly, m.currency)}</span>
                  </label>
                );
              })}
            </div>
          </section>

          {/* Capacity */}
          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">Extra capacity</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Stepper2 label={`Additional users (+${money(rates.extraUserMonth)}/ea)`} value={extraUsers} onChange={setExtraUsers} />
              <Stepper2 label={`Additional companies (+${money(rates.extraCompanyMonth)}/ea)`} value={extraCompanies} onChange={setExtraCompanies} />
            </div>
          </section>
        </div>

        {/* Order summary */}
        <aside className="h-fit rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/50">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Monthly total</h3>
          <ul className="mt-3 space-y-2 text-xs">
            {pricing.lines.map((line) => (
              <li key={line.key} className="flex items-start justify-between gap-2">
                <span className="text-slate-600 dark:text-slate-300">
                  {line.label}
                  {line.detail && <span className="block text-[11px] text-slate-400">{line.detail}</span>}
                </span>
                <span className="shrink-0 font-medium text-slate-800 dark:text-slate-100">{money(line.amount, pricing.currency)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center justify-between border-t border-slate-200 pt-3 dark:border-slate-700">
            <span className="text-sm font-semibold text-slate-900 dark:text-slate-50">Total</span>
            <span className="text-lg font-bold text-slate-900 dark:text-slate-50">{money(pricing.monthlyTotal, pricing.currency)}<span className="text-xs font-normal text-slate-400">/mo</span></span>
          </div>
          <Button className="mt-4 w-full" onClick={confirmSubscription}>
            Confirm &amp; continue to payment
          </Button>
          <p className="mt-2 text-center text-[11px] text-slate-400">No online payment — you'll pay by bank transfer.</p>
        </aside>
      </div>
    </CenteredCard>
  );
}

/** Small numeric stepper for extra users / companies. */
function Stepper2({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <p className="text-xs text-slate-600 dark:text-slate-300">{label}</p>
      <div className="mt-2 flex items-center gap-3">
        <Button size="icon" variant="outline" onClick={() => onChange(Math.max(0, value - 1))} aria-label="Decrease">
          −
        </Button>
        <span className="w-8 text-center text-sm font-semibold text-slate-900 dark:text-slate-50">{value}</span>
        <Button size="icon" variant="outline" onClick={() => onChange(value + 1)} aria-label="Increase">
          +
        </Button>
      </div>
    </div>
  );
}

/**
 * Subscription selection. Preselects the plan chosen on the public pricing page
 * (?plan=), lets the user change the plan, add optional modules and extra
 * users/companies, and reviews the live monthly USD total. Confirming drafts the
 * subscription, raises an invoice with a unique payment reference and moves to
 * the bank-remittance payment step.
 *
 * ── Organization state ────────────────────────────────────────────────────────
 * This page used to read the local organization object and, finding it empty,
 * declare "Create your organization first." — an accusation it had no evidence
 * for. It now asks the backend on mount and distinguishes FOUR states, because
 * only one of them is a genuine reason to block anybody:
 *
 *   loading → a spinner. Not knowing is not the same as knowing there is none.
 *   present → no warning; confirmation enabled.
 *   absent  → the server said so. This is the only blocking state.
 *   error   → "we could not load it", with a retry — never "you do not have one".
 */
import { useEffect, useMemo, useState } from 'react';
import { useMeteringConfigStore } from '@/store/meteringConfigStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useRouterStore } from '@/store/routerStore';
import { priceSubscription, type SubscriptionCart } from '@/lib/onboardingPricing';
import { CenteredCard, Stepper, money } from '@/components/onboarding/OnboardingChrome';
import { ROUTES } from '@/lib/accessControl';
import {
  requireCurrentOrganizationId,
  useOrganizationAvailability,
  useOrganizationHydrationError,
} from '@/lib/currentOrganization';
import { subscriptionApi } from '@/services/api/authApi';
import { ApiError, isApiConfigured } from '@/services/api/client';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Icon } from '@/components/ui/icons';

export function OnboardingSubscriptionPage() {
  const config = useMeteringConfigStore((s) => s.config);
  const existing = useOrganizationStore((s) => s.subscription);
  const saveDraft = useOrganizationStore((s) => s.saveDraftSubscription);
  const confirm = useOrganizationStore((s) => s.confirmSubscription);
  const hydrate = useOrganizationStore((s) => s.hydrateFromBackend);
  const navigate = useRouterStore((s) => s.navigate);
  const planFromUrl = useRouterStore((s) => s.query.plan);

  const availability = useOrganizationAvailability();
  const hydrationError = useOrganizationHydrationError();
  const [submitting, setSubmitting] = useState(false);

  // Confirm the organization with the backend on mount. Reused when hydration
  // already succeeded (see `hydrateFromBackend`), so arriving straight from the
  // organization step costs no second request.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

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

  /**
   * Tell the backend which package was chosen, so the applicant advances to
   * `package_selected` and the operator's roster reflects reality. Resolves the
   * plan code to the server's plan id — the browser's plan catalogue is a
   * pricing model, not an identifier source.
   */
  const selectPlanOnBackend = async (): Promise<void> => {
    const { plans } = await subscriptionApi.listPublicPlans();
    const plan = plans.find((p) => p.code === basePlanCode);
    if (!plan) {
      throw new Error(`The "${basePlanCode}" package is not available on the LEDGORA service.`);
    }
    await subscriptionApi.selectPlan(plan.id);
  };

  const confirmSubscription = async (): Promise<void> => {
    setError(null);
    setSubmitting(true);
    try {
      // The BACKEND-confirmed id decides, never a local object. If hydration has
      // not settled (or settled on "none" from a mount that raced the request)
      // this asks once more before rejecting anybody.
      const organizationId = await requireCurrentOrganizationId();
      if (!organizationId) {
        setError('Create your organization first.');
        return;
      }

      if (isApiConfigured()) {
        // Server first: nothing navigates until it has accepted the selection.
        await selectPlanOnBackend();
      }

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
      // Straight into the application in Free Preview. The invoice, the bank
      // details and the payment reference stay one click away via the Free
      // Preview banner's "View payment status" — the customer is never held
      // outside Ledgora waiting for a payment to clear.
      navigate(ROUTES.appDashboard);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : 'Could not confirm your subscription.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const rates = config.overageRates;

  return (
    <CenteredCard title="Choose your subscription" subtitle="Adjust your plan, modules and capacity. Billed monthly in USD." width="xl">
      <Stepper current="Subscription" />

      <OrganizationNotice
        availability={availability}
        error={hydrationError}
        onRetry={() => void hydrate({ force: true })}
        onCreate={() => navigate(ROUTES.onboardingOrganization)}
      />

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
          <Button
            className="mt-4 w-full"
            onClick={() => void confirmSubscription()}
            // Disabled only while we are working or while the server has NOT
            // confirmed an organization. A pending lookup blocks the click, but
            // never renders an accusation — see OrganizationNotice.
            disabled={submitting || availability !== 'present'}
          >
            {submitting ? 'Confirming…' : 'Confirm & continue to payment'}
          </Button>
          <p className="mt-2 text-center text-[11px] text-slate-400">No online payment — you'll pay by bank transfer.</p>
        </aside>
      </div>
    </CenteredCard>
  );
}

/**
 * What the page says about the organization, and when.
 *
 * Each state gets its own message, and "Create your organization first." is
 * reachable from exactly one of them: the server having positively answered
 * that this user has none. Neither a pending request nor a failed one may
 * produce it.
 */
function OrganizationNotice({
  availability,
  error,
  onRetry,
  onCreate,
}: {
  availability: 'loading' | 'present' | 'absent' | 'error';
  error: string | null;
  onRetry: () => void;
  onCreate: () => void;
}) {
  if (availability === 'present') return null;

  if (availability === 'loading') {
    return (
      <Alert variant="info" className="mb-4">
        <span data-testid="organization-loading">Loading your organization…</span>
      </Alert>
    );
  }

  if (availability === 'error') {
    return (
      <Alert variant="warning" title="We could not load your organization" className="mb-4">
        <div className="space-y-2">
          <p data-testid="organization-error">
            {error ?? 'We could not load your organization.'} Please retry — your organization has not been lost.
          </p>
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      </Alert>
    );
  }

  return (
    <Alert variant="error" title="Create your organization first." className="mb-4">
      <div className="space-y-2">
        <p data-testid="organization-absent">
          You need an organization before choosing a package.
        </p>
        <Button size="sm" variant="outline" onClick={onCreate}>
          Back to organization setup
        </Button>
      </div>
    </Alert>
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

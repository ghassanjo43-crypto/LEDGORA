/**
 * Selector-safe hooks for the billing module. Every hook returns a stored array
 * (stable reference) or a primitive; derived arrays/objects are computed in
 * useMemo, never inside a zustand selector.
 */
import { useMemo } from 'react';
import type { RenewalReminder, SubscriptionInvoice, SubscriptionPlan } from '@/types/billing';
import { useEntitlementStore } from './entitlementStore';
import { useBillingStore, getActivePlan } from './billingStore';
import { usePlatformCapability } from '@/hooks/usePlatformRole';
import { computeRenewalReminder } from '@/lib/billingCalculations';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function useRenewalReminder(): RenewalReminder | null {
  const subscription = useEntitlementStore((s) => s.subscription);
  const settings = useBillingStore((s) => s.settings);
  return useMemo(
    () => computeRenewalReminder(subscription, settings, todayIso()),
    [subscription, settings],
  );
}

export function usePlans(): SubscriptionPlan[] {
  return useBillingStore((s) => s.plans);
}

export function useInvoices(): SubscriptionInvoice[] {
  return useBillingStore((s) => s.invoices);
}

/** Count of invoices awaiting administrator verification (primitive → safe). */
export function usePendingVerificationCount(): number {
  return useBillingStore((s) => s.invoices.filter((i) => i.status === 'proof-submitted').length);
}

/** The most recent open (issued / proof-submitted / rejected) invoice, if any. */
export function useOpenInvoice(): SubscriptionInvoice | null {
  const invoices = useBillingStore((s) => s.invoices);
  return useMemo(() => {
    const open = invoices.filter(
      (i) => i.status === 'issued' || i.status === 'proof-submitted' || i.status === 'rejected',
    );
    return open.length ? open[open.length - 1]! : null;
  }, [invoices]);
}

export function useActivePlan(): SubscriptionPlan | undefined {
  // depend on activePlanId + plans so the memo refreshes on change
  const activePlanId = useBillingStore((s) => s.activePlanId);
  const plans = useBillingStore((s) => s.plans);
  return useMemo(() => plans.find((p) => p.id === activePlanId), [plans, activePlanId]);
}

export function useIsAdmin(): boolean {
  // Backend-verified in production; locally simulated only in development.
  return usePlatformCapability('verify-payments');
}

export { getActivePlan };

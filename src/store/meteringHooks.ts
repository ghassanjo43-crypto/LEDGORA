/**
 * Selector-safe hooks for usage metering. Hooks return stored arrays (stable
 * references) or primitives; all aggregation happens in useMemo, never inside a
 * zustand selector.
 */
import { useMemo } from 'react';
import type {
  AllowanceLine,
  CommercialBasePlan,
  CostRecovery,
  InfraCostBreakdown,
  OverageStatement,
  UsageSummary,
} from '@/types/metering';
import { useMeteringConfigStore } from './meteringConfigStore';
import { useUsageStore } from './usageStore';
import { useCompanyStore } from './companyStore';
import { usePlatformCapability } from '@/hooks/usePlatformRole';
import {
  buildAllowanceLines,
  computeCostRecovery,
  computeOverage,
  estimateInfraCost,
  periodKeyOf,
  summarizeUsage,
  dayKeyOf,
  thresholdBand,
} from '@/lib/meteringCalculations';

function nowParts(): { period: string; day: string } {
  const iso = new Date().toISOString();
  return { period: periodKeyOf(iso), day: dayKeyOf(iso) };
}

export function useActiveBasePlan(): CommercialBasePlan | undefined {
  const config = useMeteringConfigStore((s) => s.config);
  return useMemo(() => config.basePlans.find((p) => p.id === config.activeBasePlanId), [config]);
}

/** The current-period usage summary for the active organization. */
export function useUsageSummary(period?: string): UsageSummary {
  const events = useUsageStore((s) => s.events);
  const userSeats = useUsageStore((s) => s.userSeats);
  const companies = useCompanyStore((s) => s.companies);
  const { period: current, day } = nowParts();
  const key = period ?? current;
  return useMemo(
    () => summarizeUsage(events, [], 'primary', key, { users: userSeats, companies: companies.length || 1 }, day),
    [events, userSeats, companies.length, key, day],
  );
}

export function useAllowanceLines(period?: string): AllowanceLine[] {
  const summary = useUsageSummary(period);
  const config = useMeteringConfigStore((s) => s.config);
  const orgBundles = useMeteringConfigStore((s) => s.orgBundles);
  const plan = useActiveBasePlan();
  return useMemo(() => {
    if (!plan) return [];
    return buildAllowanceLines(summary, plan.allowances, orgBundles, config.overageRates, config.thresholds, plan.currency);
  }, [summary, plan, orgBundles, config.overageRates, config.thresholds]);
}

export function useOverageStatement(period?: string): OverageStatement {
  const summary = useUsageSummary(period);
  const config = useMeteringConfigStore((s) => s.config);
  const orgBundles = useMeteringConfigStore((s) => s.orgBundles);
  const plan = useActiveBasePlan();
  return useMemo(() => {
    const currency = plan?.currency ?? 'USD';
    if (!plan) return { organizationId: 'primary', period: summary.period, currency, lines: [], total: 0 };
    return computeOverage(summary, plan.allowances, orgBundles, config.overageRates, currency);
  }, [summary, plan, orgBundles, config.overageRates]);
}

export function useInfraCost(period?: string): InfraCostBreakdown {
  const summary = useUsageSummary(period);
  const renderCosts = useMeteringConfigStore((s) => s.config.renderCosts);
  return useMemo(() => estimateInfraCost(summary, renderCosts), [summary, renderCosts]);
}

export function useCostRecovery(period?: string): CostRecovery {
  const summary = useUsageSummary(period);
  const overage = useOverageStatement(period);
  const renderCosts = useMeteringConfigStore((s) => s.config.renderCosts);
  const plan = useActiveBasePlan();
  const moduleRevenue = useMeteringConfigStore((s) => s.config);
  return useMemo(() => {
    const planRevenue =
      (plan?.priceMonthly ?? 0) +
      moduleRevenue.optionalModules
        .filter((m) => moduleRevenue.activeModuleCodes.includes(m.code))
        .reduce((sum, m) => sum + m.priceMonthly, 0);
    return computeCostRecovery(summary, planRevenue, overage, renderCosts, plan?.currency ?? 'USD');
  }, [summary, overage, renderCosts, plan, moduleRevenue]);
}

/** Highest threshold band currently crossed across cost-bearing metrics. */
export function useUsageAlertBand(): { band: string; line: AllowanceLine | null } {
  const lines = useAllowanceLines();
  return useMemo(() => {
    const order = ['ok', 'warn70', 'warn85', 'over100', 'critical120'];
    let worst: AllowanceLine | null = null;
    for (const l of lines) {
      if (worst === null || order.indexOf(l.band) > order.indexOf(worst.band)) worst = l;
    }
    return { band: worst?.band ?? 'ok', line: worst && worst.band !== 'ok' ? worst : null };
  }, [lines]);
}

export function useIsMeteringAdmin(): boolean {
  // Backend-verified in production; locally simulated only in development.
  return usePlatformCapability('manage-metering');
}

export { thresholdBand };

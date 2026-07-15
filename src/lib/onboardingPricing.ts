/**
 * Subscription cart pricing. The monthly USD total is derived entirely from the
 * super-administrator-editable metering configuration (base plan prices,
 * optional module prices and per-seat / per-company overage rates). Nothing here
 * is hard-coded — change the config and the price changes.
 */
import type { MeteringConfig } from '@/types/metering';
import type { CartPricing, SubscriptionLineItem } from '@/types/onboarding';

export interface SubscriptionCart {
  basePlanCode: string;
  addOnModuleCodes: string[];
  extraUsers: number;
  extraCompanies: number;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Build the priced line items and monthly total for a cart against the current
 * metering configuration. Unknown plan/module codes are skipped defensively.
 */
export function priceSubscription(config: MeteringConfig, cart: SubscriptionCart): CartPricing {
  const currency = config.basePlans[0]?.currency ?? 'USD';
  const lines: SubscriptionLineItem[] = [];

  const plan = config.basePlans.find((p) => p.code === cart.basePlanCode && p.isActive);
  if (plan) {
    lines.push({
      key: `plan:${plan.code}`,
      label: plan.name,
      detail: plan.startingAt ? 'Base plan (starting at)' : 'Base plan',
      quantity: 1,
      unitPrice: plan.priceMonthly,
      amount: plan.priceMonthly,
    });
  }

  for (const code of cart.addOnModuleCodes) {
    const mod = config.optionalModules.find((m) => m.code === code && m.isActive);
    if (!mod) continue;
    lines.push({
      key: `module:${mod.code}`,
      label: `${mod.name} module`,
      detail: 'Optional add-on',
      quantity: 1,
      unitPrice: mod.priceMonthly,
      amount: mod.priceMonthly,
    });
  }

  const extraUsers = Math.max(0, Math.floor(cart.extraUsers));
  if (extraUsers > 0) {
    const rate = config.overageRates.extraUserMonth;
    lines.push({
      key: 'extra:users',
      label: 'Additional users',
      detail: `${extraUsers} × ${currency} ${rate}/user`,
      quantity: extraUsers,
      unitPrice: rate,
      amount: round2(extraUsers * rate),
    });
  }

  const extraCompanies = Math.max(0, Math.floor(cart.extraCompanies));
  if (extraCompanies > 0) {
    const rate = config.overageRates.extraCompanyMonth;
    lines.push({
      key: 'extra:companies',
      label: 'Additional companies',
      detail: `${extraCompanies} × ${currency} ${rate}/company`,
      quantity: extraCompanies,
      unitPrice: rate,
      amount: round2(extraCompanies * rate),
    });
  }

  const monthlyTotal = round2(lines.reduce((sum, l) => sum + l.amount, 0));
  return { currency, lines, monthlyTotal };
}

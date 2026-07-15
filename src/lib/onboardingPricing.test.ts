import { describe, it, expect } from 'vitest';
import { priceSubscription } from './onboardingPricing';
import { makeSeedMeteringConfig } from './meteringSeed';

const config = makeSeedMeteringConfig(new Date().toISOString());

describe('priceSubscription', () => {
  it('prices a base plan alone at the plan price', () => {
    const p = priceSubscription(config, { basePlanCode: 'core', addOnModuleCodes: [], extraUsers: 0, extraCompanies: 0 });
    expect(p.monthlyTotal).toBe(39);
    expect(p.lines).toHaveLength(1);
  });

  it('adds optional module prices and extra user/company overage', () => {
    // professional 89 + projects 29 + construction 49 + 2 users*6 + 1 company*20
    const p = priceSubscription(config, {
      basePlanCode: 'professional',
      addOnModuleCodes: ['projects', 'construction'],
      extraUsers: 2,
      extraCompanies: 1,
    });
    expect(p.monthlyTotal).toBe(89 + 29 + 49 + 2 * 6 + 1 * 20);
    const keys = p.lines.map((l) => l.key);
    expect(keys).toContain('module:projects');
    expect(keys).toContain('extra:users');
    expect(keys).toContain('extra:companies');
  });

  it('follows the editable config — a price change changes the total', () => {
    const edited = { ...config, basePlans: config.basePlans.map((b) => (b.code === 'core' ? { ...b, priceMonthly: 49 } : b)) };
    const p = priceSubscription(edited, { basePlanCode: 'core', addOnModuleCodes: [], extraUsers: 0, extraCompanies: 0 });
    expect(p.monthlyTotal).toBe(49);
  });

  it('ignores unknown plan/module codes defensively', () => {
    const p = priceSubscription(config, { basePlanCode: 'nope', addOnModuleCodes: ['ghost'], extraUsers: 0, extraCompanies: 0 });
    expect(p.monthlyTotal).toBe(0);
    expect(p.lines).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import { ALL_EDITIONS, EDITION_MODULES } from './editions';
import { canAccessView, filterNavigationByEntitlements } from './navigation';

describe('Opening Balances navigation entitlement', () => {
  it('is Core accounting in every paid edition', () => {
    for (const edition of ALL_EDITIONS) {
      const modules = EDITION_MODULES[edition];
      const accounting = filterNavigationByEntitlements(modules).find((group) => group.id === 'accounting');
      expect(accounting?.items.some((item) => item.key === 'opening-balances'), edition).toBe(true);
      expect(canAccessView(modules, 'opening-balances'), edition).toBe(true);
    }
  });

  it('is unavailable without the Core accounting entitlement', () => {
    expect(canAccessView([], 'opening-balances')).toBe(false);
  });
});

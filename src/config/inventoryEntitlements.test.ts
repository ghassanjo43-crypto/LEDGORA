import { describe, it, expect } from 'vitest';
import { MODULE_BY_ID } from './modules';
import { EDITION_MODULES } from './editions';
import { filterNavigationByEntitlements, canAccessView, VIEW_MODULE_REQUIREMENTS } from './navigation';
import type { LedgoraModule } from '@/types/entitlements';

const CORE: LedgoraModule[] = [...EDITION_MODULES.core];
const WITH_INVENTORY: LedgoraModule[] = [...EDITION_MODULES.core, 'inventory_basic'];

/* ── Dependencies ─────────────────────────────────────────────────────────── */

describe('inventory entitlement dependencies', () => {
  it('warehouses / inventory_advanced / lot_serial depend on inventory_basic', () => {
    expect(MODULE_BY_ID.warehouses.dependencies).toContain('inventory_basic');
    expect(MODULE_BY_ID.inventory_advanced.dependencies).toContain('inventory_basic');
    expect(MODULE_BY_ID.lot_serial_tracking.dependencies).toContain('inventory_basic');
  });

  it('landed_cost depends on inventory_basic and purchases', () => {
    expect(MODULE_BY_ID.landed_cost.dependencies).toEqual(expect.arrayContaining(['inventory_basic', 'purchases']));
  });

  it('manufacturing_core and construction_materials depend on inventory_basic', () => {
    expect(MODULE_BY_ID.manufacturing_core.dependencies).toContain('inventory_basic');
    expect(MODULE_BY_ID.construction_materials.dependencies).toContain('inventory_basic');
  });

  it('inventory is included in the Manufacturing edition and purchasable independently', () => {
    expect(EDITION_MODULES.manufacturing).toContain('inventory_basic');
    // Core edition does NOT include inventory — it is an optional add-on.
    expect(EDITION_MODULES.core).not.toContain('inventory_basic');
  });
});

/* ── Navigation + route guards ────────────────────────────────────────────── */

describe('inventory navigation & route guards', () => {
  it('hides the Inventory group without inventory_basic', () => {
    const groups = filterNavigationByEntitlements(CORE);
    expect(groups.find((g) => g.id === 'inventory')).toBeUndefined();
  });

  it('shows the Inventory group with inventory_basic', () => {
    const groups = filterNavigationByEntitlements(WITH_INVENTORY);
    const inv = groups.find((g) => g.id === 'inventory');
    expect(inv).toBeDefined();
    expect(inv!.items.map((i) => i.key)).toEqual(
      expect.arrayContaining(['inventory-dashboard', 'inventory-items', 'inventory-warehouses', 'inventory-movements', 'inventory-receipts', 'inventory-reports']),
    );
  });

  it('blocks inventory routes without entitlement and allows them with it', () => {
    expect(canAccessView(CORE, 'inventory-items')).toBe(false);
    expect(canAccessView(CORE, 'inventory-reports')).toBe(false);
    expect(canAccessView(WITH_INVENTORY, 'inventory-items')).toBe(true);
    expect(canAccessView(WITH_INVENTORY, 'inventory-reports')).toBe(true);
    // Every inventory view carries an entitlement requirement (no open routes).
    expect(VIEW_MODULE_REQUIREMENTS['inventory-items']?.requiredModule).toBe('inventory_basic');
  });
});

import { describe, it, expect } from 'vitest';
import { MODULE_BY_ID } from './modules';
import { EDITION_MODULES } from './editions';
import { filterNavigationByEntitlements, canAccessView } from './navigation';
import { validateBom, hasCircularReference } from '@/lib/bomVersioning';
import { canTransition, acceptsProductionActivity } from '@/lib/workOrderLifecycle';
import type { LedgoraModule } from '@/types/entitlements';
import type { BillOfMaterials } from '@/types/manufacturing';

const CORE = [...EDITION_MODULES.core] as LedgoraModule[];
const MFG = [...EDITION_MODULES.manufacturing] as LedgoraModule[];

describe('manufacturing entitlements', () => {
  it('manufacturing_core depends on core_accounting, inventory_basic, warehouses and cost_centers', () => {
    expect(MODULE_BY_ID.manufacturing_core.dependencies).toEqual(expect.arrayContaining(['core_accounting', 'inventory_basic', 'warehouses', 'cost_centers']));
  });
  it('work orders require BOM, routings, work centers, inventory and warehouses', () => {
    expect(MODULE_BY_ID.manufacturing_work_orders.dependencies).toEqual(expect.arrayContaining(['manufacturing_bom', 'manufacturing_routings', 'manufacturing_work_centers', 'inventory_basic', 'warehouses']));
  });
  it('the Manufacturing edition includes inventory + warehouses (dependency of manufacturing)', () => {
    expect(MFG).toContain('manufacturing_core');
    expect(MFG).toContain('inventory_basic');
    expect(MFG).toContain('warehouses');
    expect(CORE).not.toContain('manufacturing_core');
  });
});

describe('manufacturing navigation & route guards', () => {
  it('hides the Manufacturing group without manufacturing_core', () => {
    expect(filterNavigationByEntitlements(CORE).find((g) => g.id === 'manufacturing')).toBeUndefined();
  });
  it('shows the Phase-1 Manufacturing pages with entitlement, and does not expose deferred pages', () => {
    const group = filterNavigationByEntitlements(MFG).find((g) => g.id === 'manufacturing')!;
    const keys = group.items.map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining(['manufacturing-dashboard', 'manufacturing-plants', 'manufacturing-work-orders', 'manufacturing-material-issues', 'manufacturing-reports']));
    expect(keys).not.toContain('manufacturing-mrp');
    expect(keys).not.toContain('manufacturing-quality');
    expect(keys).not.toContain('manufacturing-maintenance');
  });
  it('blocks manufacturing routes without entitlement and allows them with it', () => {
    expect(canAccessView(CORE, 'manufacturing-work-orders')).toBe(false);
    expect(canAccessView(MFG, 'manufacturing-work-orders')).toBe(true);
  });
});

describe('BOM + lifecycle libs', () => {
  const bom = (over: Partial<BillOfMaterials>): BillOfMaterials => ({ id: 'b', entityId: 'primary', code: 'B1', name: 'B', productItemId: 'FG', version: 1, status: 'draft', effectiveFrom: '2026-01-01', outputQuantity: 1, outputUnitId: 'ea', expectedYieldPercent: 100, components: [{ id: 'c1', bomId: 'b', sequence: 1, itemId: 'RM', quantity: 1, unitId: 'ea', quantityPerOutput: 1, isOptional: false }], createdAt: '', updatedAt: '', ...over });

  it('validates BOM shape and rejects a component equal to the product', () => {
    expect(validateBom(bom({})).ok).toBe(true);
    expect(validateBom(bom({ components: [{ id: 'c', bomId: 'b', sequence: 1, itemId: 'FG', quantity: 1, unitId: 'ea', quantityPerOutput: 1, isOptional: false }] })).ok).toBe(false);
  });
  it('detects a circular BOM reference through an approved subassembly', () => {
    const sub = bom({ id: 'sub', productItemId: 'SUB', status: 'approved', components: [{ id: 'x', bomId: 'sub', sequence: 1, itemId: 'FG', quantity: 1, unitId: 'ea', quantityPerOutput: 1, isOptional: false }] });
    const byProduct = new Map([['SUB', sub]]);
    expect(hasCircularReference('FG', [{ itemId: 'SUB' }], byProduct)).toBe(true);
    expect(hasCircularReference('FG', [{ itemId: 'RM' }], new Map())).toBe(false);
  });
  it('enforces the work-order lifecycle transitions', () => {
    expect(canTransition('draft', 'planned')).toBe(true);
    expect(canTransition('draft', 'completed')).toBe(false);
    expect(canTransition('closed', 'released')).toBe(false);
    expect(acceptsProductionActivity('released')).toBe(true);
    expect(acceptsProductionActivity('closed')).toBe(false);
  });
});

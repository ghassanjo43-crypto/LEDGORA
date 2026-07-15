import { describe, it, expect } from 'vitest';
import type { StockMovement } from '@/types/inventory';
import { applyInbound, applyOutbound, replayMovements, currentAverageCost } from './inventoryValuation';
import { getInventoryValue, getQuantityOnHand } from './inventoryBalance';

/* Weighted-average acceptance scenario from the specification (§47). */

describe('weighted-average valuation', () => {
  it('averages two receipts and preserves the average on issue', () => {
    // Receipt 100 @ 10
    let s = applyInbound({ quantity: 0, value: 0, averageCost: 0 }, 100, 10);
    expect(s).toMatchObject({ quantity: 100, value: 1000, averageCost: 10 });
    // Receipt 50 @ 14 → average 11.333333
    s = applyInbound(s, 50, 14);
    expect(s.quantity).toBe(150);
    expect(s.value).toBe(1700);
    expect(s.averageCost).toBeCloseTo(11.333333, 6);
    // Issue 60 → issue value 680, remaining 90 @ 11.333333 = 1020
    const out = applyOutbound(s, 60);
    expect(out.unitCost).toBeCloseTo(11.333333, 6);
    expect(out.totalCost).toBeCloseTo(680, 2);
    expect(out.state.quantity).toBe(90);
    expect(out.state.value).toBeCloseTo(1020, 2);
    expect(out.state.averageCost).toBeCloseTo(11.333333, 6);
  });
});

function mv(partial: Partial<StockMovement> & Pick<StockMovement, 'direction' | 'quantity' | 'unitCostBase' | 'postingDate'>): StockMovement {
  return {
    id: `m_${Math.random()}`,
    entityId: 'primary',
    movementNumber: 'MOV',
    movementType: partial.direction === 'in' ? 'purchase-receipt' : 'sales-delivery',
    movementDate: partial.postingDate,
    itemId: 'i1',
    warehouseId: 'w1',
    baseUnitId: 'ea',
    totalCostBase: partial.quantity * partial.unitCostBase,
    sourceDocumentType: 'goods-receipt',
    sourceDocumentId: 'd',
    itemSnapshot: { code: 'I1', name: 'Item', itemType: 'inventory', baseUnitCode: 'EA' },
    warehouseSnapshot: { code: 'W1', name: 'WH' },
    accountSnapshot: { inventoryAccountId: '1213' },
    status: 'posted',
    createdAt: `${partial.postingDate}T00:00:00Z`,
    ...partial,
  };
}

describe('movement replay + preserved history', () => {
  it('a later receipt never rewrites an earlier issue cost', () => {
    const movements: StockMovement[] = [
      mv({ direction: 'in', quantity: 100, unitCostBase: 10, postingDate: '2026-01-01' }),
      mv({ direction: 'out', quantity: 60, unitCostBase: 10, postingDate: '2026-01-02' }), // issued at the-then average 10
      mv({ direction: 'in', quantity: 50, unitCostBase: 20, postingDate: '2026-01-03' }),
    ];
    // The recorded issue cost stays 10 (history preserved); state advances.
    expect(movements[1]!.unitCostBase).toBe(10);
    const state = replayMovements(movements);
    // 40 @ 10 (400) + 50 @ 20 (1000) = 90 units, 1400 → avg 15.5556
    expect(state.quantity).toBe(90);
    expect(state.value).toBeCloseTo(1400, 2);
    expect(state.averageCost).toBeCloseTo(15.555556, 6);
  });

  it('derives quantity and value as-of a date and ignores reversed movements', () => {
    const movements: StockMovement[] = [
      mv({ direction: 'in', quantity: 100, unitCostBase: 10, postingDate: '2026-01-01' }),
      mv({ direction: 'in', quantity: 50, unitCostBase: 14, postingDate: '2026-02-01' }),
    ];
    expect(getQuantityOnHand(movements, { entityId: 'primary', itemId: 'i1', asOfDate: '2026-01-15' })).toBe(100);
    expect(getInventoryValue(movements, { entityId: 'primary', itemId: 'i1', asOfDate: '2026-01-15' })).toBe(1000);
    expect(currentAverageCost(movements)).toBeCloseTo(11.333333, 6);
    // Reverse the first receipt → excluded from the running state.
    movements[0]!.status = 'reversed';
    expect(getQuantityOnHand(movements, { entityId: 'primary', itemId: 'i1' })).toBe(50);
  });
});

import { describe, expect, it } from 'vitest';
import type { InventoryItem, StockMovement, Warehouse } from '@/types/inventory';
import { movementItemIdentity, movementLocations, movementMatches, movementReference, movementTypeLabel, signedMovementQuantity } from './stockMovementPresentation';

const entity = 'primary';
const item = { id: 'item-1', entityId: entity, code: 'pop99', name: 'Cement', baseUnitId: 'uom-bag', status: 'active' } as InventoryItem;
const warehouses = [
  { id: 'from', entityId: entity, code: 'FROM', name: 'Source' },
  { id: 'to', entityId: entity, code: 'TO', name: 'Destination' },
] as Warehouse[];

function movement(over: Partial<StockMovement> = {}): StockMovement {
  return {
    id: 'movement-1', entityId: entity, movementNumber: 'MOV-1', movementType: 'purchase-receipt', movementDate: '2026-08-01', postingDate: '2026-08-01',
    itemId: item.id, warehouseId: 'to', direction: 'in', quantity: 10, baseUnitId: 'uom-bag', unitCostBase: 7, totalCostBase: 70,
    sourceDocumentType: 'goods-receipt', sourceDocumentId: 'doc-1', itemSnapshot: { code: 'pop99', name: 'Cement', itemType: 'inventory', baseUnitCode: 'BAG' },
    warehouseSnapshot: { code: 'TO', name: 'Destination' }, accountSnapshot: {}, status: 'posted', createdAt: '2026-08-01T00:00:00Z', ...over,
  } as StockMovement;
}

describe('stock movement historical presentation', () => {
  it('uses the stored code/name/unit snapshot for a receipt even after the item changes', () => {
    const identity = movementItemIdentity(movement(), [{ ...item, code: 'NEW', name: 'Renamed', status: 'archived' }], [], entity);
    expect(identity).toMatchObject({ label: 'pop99 — Cement', unit: 'BAG', status: 'archived' });
    expect(movementLocations(movement(), [], warehouses, entity)).toEqual({ from: '—', to: 'TO — Destination' });
    expect(signedMovementQuantity(movement())).toBe(10);
  });

  it('shows an issue from its source warehouse with a negative quantity', () => {
    const issue = movement({ movementType: 'sales-delivery', direction: 'out', warehouseId: 'from', warehouseSnapshot: { code: 'FROM', name: 'Source' } });
    expect(movementLocations(issue, [], warehouses, entity)).toEqual({ from: 'FROM — Source', to: '—' });
    expect(signedMovementQuantity(issue)).toBe(-10);
  });

  it('shows both warehouses for each side of a transfer', () => {
    const out = movement({ id: 'out', movementType: 'warehouse-transfer-out', sourceDocumentType: 'transfer', direction: 'out', warehouseId: 'from', warehouseSnapshot: { code: 'FROM', name: 'Source' } });
    const inbound = movement({ id: 'in', movementType: 'warehouse-transfer-in', sourceDocumentType: 'transfer', direction: 'in', warehouseId: 'to' });
    expect(movementLocations(out, [out, inbound], warehouses, entity)).toEqual({ from: 'FROM — Source', to: 'TO — Destination' });
    expect(movementLocations(inbound, [out, inbound], warehouses, entity)).toEqual({ from: 'FROM — Source', to: 'TO — Destination' });
  });

  it('clearly labels adjustment increases and decreases', () => {
    expect(movementTypeLabel(movement({ movementType: 'stock-adjustment-in' }))).toBe('Adjustment increase');
    expect(movementTypeLabel(movement({ movementType: 'stock-adjustment-out' }))).toBe('Adjustment decrease');
  });

  it('never resolves an item from another entity and safely identifies a missing reference', () => {
    const old = movement({ itemSnapshot: undefined as never });
    const identity = movementItemIdentity(old, [{ ...item, entityId: 'other', code: 'SECRET', name: 'Other tenant item' }], [], entity);
    expect(identity.label).toBe('Unavailable item — item-1');
    expect(identity.label).not.toContain('SECRET');
  });

  it('filters by item and searches snapshots and entity-scoped document references', () => {
    const current = movement();
    const identity = movementItemIdentity(current, [item], [], entity);
    const reference = movementReference(current, [{ id: 'doc-1', entityId: entity, number: 'GRN-1', reference: 'SUP-778' }, { id: 'doc-1', entityId: 'other', number: 'LEAK', reference: 'LEAK' }], entity);
    expect(reference).toBe('SUP-778');
    expect(movementMatches(current, identity, reference, { entityId: entity, itemId: item.id, search: 'cement' })).toBe(true);
    expect(movementMatches(current, identity, reference, { entityId: entity, search: 'SUP-778' })).toBe(true);
    expect(movementMatches(current, identity, reference, { entityId: entity, itemId: 'other-item' })).toBe(false);
  });

  it('does not mutate stored quantities or valuation values', () => {
    const current = movement({ quantity: 12.5, unitCostBase: 3.25, totalCostBase: 40.625 });
    const before = structuredClone(current);
    signedMovementQuantity(current);
    movementItemIdentity(current, [item], [], entity);
    expect(current).toEqual(before);
    expect(current.quantity).toBe(12.5);
    expect(current.totalCostBase).toBe(40.625);
  });
});

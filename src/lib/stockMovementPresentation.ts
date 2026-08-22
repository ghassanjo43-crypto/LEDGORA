import type { InventoryItem, StockMovement, UnitOfMeasure, Warehouse } from '@/types/inventory';

export interface MovementItemIdentity { code?: string; name?: string; label: string; unit: string; status?: InventoryItem['status']; unavailable: boolean }
export interface MovementLocationIdentity { from: string; to: string }
export interface MovementRegisterFilter { entityId: string; itemId?: string; movementType?: StockMovement['movementType']; warehouseId?: string; dateFrom?: string; dateTo?: string; reference?: string; search?: string }
export interface MovementDocumentIdentity { id: string; entityId: string; number: string; reference: string }

export function movementItemIdentity(movement: StockMovement, items: InventoryItem[], units: UnitOfMeasure[], entityId: string): MovementItemIdentity {
  const item = items.find((candidate) => candidate.entityId === entityId && candidate.id === movement.itemId);
  const code = movement.itemSnapshot?.code || item?.code;
  const name = movement.itemSnapshot?.name || item?.name;
  const unit = movement.itemSnapshot?.baseUnitCode || units.find((candidate) => candidate.entityId === entityId && candidate.id === (item?.baseUnitId ?? movement.baseUnitId))?.code || '';
  if (!code && !name) return { label: `Unavailable item — ${movement.itemId}`, unit, unavailable: true };
  return { code, name, label: [code, name].filter(Boolean).join(' — '), unit, status: item?.status, unavailable: false };
}

function warehouseLabel(movement: StockMovement, warehouses: Warehouse[], entityId: string): string {
  if (movement.warehouseSnapshot?.code || movement.warehouseSnapshot?.name) return [movement.warehouseSnapshot.code, movement.warehouseSnapshot.name].filter(Boolean).join(' — ');
  const warehouse = warehouses.find((candidate) => candidate.entityId === entityId && candidate.id === movement.warehouseId);
  return warehouse ? `${warehouse.code} — ${warehouse.name}` : `Unavailable warehouse — ${movement.warehouseId}`;
}

export function movementLocations(movement: StockMovement, movements: StockMovement[], warehouses: Warehouse[], entityId: string): MovementLocationIdentity {
  const here = warehouseLabel(movement, warehouses, entityId);
  if (movement.sourceDocumentType === 'transfer') {
    const pair = movements.find((candidate) => candidate.entityId === entityId && candidate.id !== movement.id && candidate.sourceDocumentId === movement.sourceDocumentId && candidate.itemId === movement.itemId && candidate.direction !== movement.direction);
    const there = pair ? warehouseLabel(pair, warehouses, entityId) : 'Unavailable warehouse';
    return movement.direction === 'out' ? { from: here, to: there } : { from: there, to: here };
  }
  return movement.direction === 'in' ? { from: '—', to: here } : { from: here, to: '—' };
}

export function movementReference(movement: StockMovement, documents: MovementDocumentIdentity[], entityId: string): string {
  const document = documents.find((candidate) => candidate.entityId === entityId && candidate.id === movement.sourceDocumentId);
  return document?.reference?.trim() || document?.number || movement.movementNumber;
}

export function signedMovementQuantity(movement: StockMovement): number { return movement.direction === 'in' ? movement.quantity : -movement.quantity; }
export function movementTypeLabel(movement: Pick<StockMovement, 'movementType'>): string {
  if (movement.movementType === 'stock-adjustment-in') return 'Adjustment increase';
  if (movement.movementType === 'stock-adjustment-out') return 'Adjustment decrease';
  return movement.movementType.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

export function movementMatches(movement: StockMovement, identity: MovementItemIdentity, reference: string, filter: MovementRegisterFilter): boolean {
  if (movement.entityId !== filter.entityId) return false;
  if (filter.itemId && movement.itemId !== filter.itemId) return false;
  if (filter.movementType && movement.movementType !== filter.movementType) return false;
  if (filter.warehouseId && movement.warehouseId !== filter.warehouseId) return false;
  if (filter.dateFrom && movement.postingDate < filter.dateFrom) return false;
  if (filter.dateTo && movement.postingDate > filter.dateTo) return false;
  if (filter.reference && !reference.toLowerCase().includes(filter.reference.trim().toLowerCase())) return false;
  const search = filter.search?.trim().toLowerCase();
  return !search || `${identity.code ?? ''} ${identity.name ?? ''} ${reference} ${movement.movementNumber}`.toLowerCase().includes(search);
}

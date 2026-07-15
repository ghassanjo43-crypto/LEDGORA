/**
 * Inventory reversal. A reversal creates an opposite stock movement at the
 * ORIGINAL cost (never the current average) and reverses the linked journal.
 * Original and reversal are cross-linked; nothing is edited in place.
 *
 * A reversal is blocked when it would be invalid — e.g. reversing a receipt
 * after the stock has been consumed would drive on-hand negative under the
 * block policy. Such cases require a controlled return/correction instead.
 */
import type { StockMovement } from '@/types/inventory';
import { getQuantityOnHand } from './inventoryBalance';

const OPPOSITE_TYPE: Partial<Record<StockMovement['movementType'], StockMovement['movementType']>> = {
  'opening-balance': 'stock-adjustment-out',
  'purchase-receipt': 'purchase-return',
  'purchase-return': 'purchase-receipt',
  'sales-delivery': 'sales-return',
  'sales-return': 'sales-delivery',
  'warehouse-transfer-in': 'warehouse-transfer-out',
  'warehouse-transfer-out': 'warehouse-transfer-in',
  'stock-adjustment-in': 'stock-adjustment-out',
  'stock-adjustment-out': 'stock-adjustment-in',
  'stock-count-in': 'stock-count-out',
  'stock-count-out': 'stock-count-in',
  'project-material-issue': 'project-material-return',
  'project-material-return': 'project-material-issue',
};

export interface ReversalCheck {
  ok: boolean;
  error?: string;
}

/**
 * Can this posted inbound movement be reversed? Reversing an inbound removes
 * `quantity` from the warehouse; if less than that is on hand, stock has been
 * consumed and the reversal is refused (unless negative stock is permitted).
 */
export function canReverseMovement(
  movement: StockMovement,
  allMovements: StockMovement[],
  allowNegative: boolean,
): ReversalCheck {
  if (movement.status === 'reversed') return { ok: false, error: 'Movement is already reversed.' };
  if (movement.direction === 'in' && !allowNegative) {
    const onHand = getQuantityOnHand(allMovements, {
      entityId: movement.entityId,
      itemId: movement.itemId,
      warehouseId: movement.warehouseId,
    });
    if (onHand + 1e-9 < movement.quantity) {
      return {
        ok: false,
        error: `Cannot reverse: only ${onHand} of "${movement.itemSnapshot.code}" remain on hand but the movement added ${movement.quantity}. Some stock has been consumed — use a return/correction instead.`,
      };
    }
  }
  return { ok: true };
}

/** The opposite movement (minus identity/number), at the original cost. */
export function buildReversalMovement(movement: StockMovement): Omit<StockMovement, 'id' | 'movementNumber' | 'createdAt'> {
  return {
    entityId: movement.entityId,
    movementType: OPPOSITE_TYPE[movement.movementType] ?? (movement.direction === 'in' ? 'stock-adjustment-out' : 'stock-adjustment-in'),
    movementDate: new Date().toISOString().slice(0, 10),
    postingDate: new Date().toISOString().slice(0, 10),
    itemId: movement.itemId,
    warehouseId: movement.warehouseId,
    direction: movement.direction === 'in' ? 'out' : 'in',
    quantity: movement.quantity,
    baseUnitId: movement.baseUnitId,
    unitCostBase: movement.unitCostBase, // ORIGINAL cost — never recomputed
    totalCostBase: movement.totalCostBase,
    documentCurrency: movement.documentCurrency,
    documentUnitCost: movement.documentUnitCost,
    exchangeRate: movement.exchangeRate,
    projectId: movement.projectId,
    costCenterId: movement.costCenterId,
    sourceDocumentType: movement.sourceDocumentType,
    sourceDocumentId: movement.sourceDocumentId,
    sourceLineId: movement.sourceLineId,
    itemSnapshot: movement.itemSnapshot,
    warehouseSnapshot: movement.warehouseSnapshot,
    accountSnapshot: movement.accountSnapshot,
    status: 'posted',
    reversalOfMovementId: movement.id,
  };
}

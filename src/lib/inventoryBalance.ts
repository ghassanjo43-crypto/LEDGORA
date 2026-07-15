/**
 * Inventory balance service. Every balance is DERIVED from the posted
 * stock-movement ledger — never read from a stored quantity-on-hand field.
 *
 * Weighted-average COST is maintained per item (company-wide), which keeps
 * warehouse transfers cost-neutral (same cost on both sides, no P&L). QUANTITY
 * is tracked per item and per item+warehouse so negative-stock can be enforced
 * at the warehouse that issues stock.
 */
import type { InventoryBalance, StockMovement } from '@/types/inventory';
import { replayMovements, type ValuationState } from './inventoryValuation';

export interface BalanceQuery {
  entityId: string;
  itemId: string;
  warehouseId?: string;
  /** Inclusive as-of date (yyyy-mm-dd). Defaults to "all posted". */
  asOfDate?: string;
}

function matches(m: StockMovement, q: { entityId: string; itemId: string; asOfDate?: string }): boolean {
  if (m.entityId !== q.entityId) return false;
  if (m.itemId !== q.itemId) return false;
  if (q.asOfDate && m.postingDate > q.asOfDate) return false;
  return true;
}

/** Company-wide valuation state for one item (drives average cost). */
export function getItemState(movements: StockMovement[], q: BalanceQuery): ValuationState {
  return replayMovements(movements.filter((m) => matches(m, q)));
}

/** Signed on-hand quantity for an item, optionally scoped to one warehouse. */
export function getQuantityOnHand(movements: StockMovement[], q: BalanceQuery): number {
  let qty = 0;
  for (const m of movements) {
    if (m.status === 'reversed') continue;
    if (!matches(m, q)) continue;
    if (q.warehouseId && m.warehouseId !== q.warehouseId) continue;
    qty += m.direction === 'in' ? m.quantity : -m.quantity;
  }
  return round6(qty);
}

/** Company-wide average unit cost for an item (weighted-average). */
export function getAverageUnitCost(movements: StockMovement[], q: BalanceQuery): number {
  return getItemState(movements, { entityId: q.entityId, itemId: q.itemId, asOfDate: q.asOfDate }).averageCost;
}

/** Inventory value = on-hand quantity × company-wide average cost. */
export function getInventoryValue(movements: StockMovement[], q: BalanceQuery): number {
  if (!q.warehouseId) {
    // Company-wide value is tracked directly by the valuation engine.
    return round2(getItemState(movements, q).value);
  }
  const avg = getAverageUnitCost(movements, q);
  return round2(getQuantityOnHand(movements, q) * avg);
}

/** Phase 1: available = on-hand (no reservations yet). */
export function getAvailableQuantity(movements: StockMovement[], q: BalanceQuery): number {
  return getQuantityOnHand(movements, q);
}

/** Full derived balance record. */
export function getInventoryBalance(movements: StockMovement[], q: BalanceQuery): InventoryBalance {
  const quantityOnHand = getQuantityOnHand(movements, q);
  const averageUnitCost = getAverageUnitCost(movements, q);
  const inventoryValue = getInventoryValue(movements, q);
  return {
    entityId: q.entityId,
    itemId: q.itemId,
    warehouseId: q.warehouseId,
    quantityOnHand,
    reservedQuantity: 0,
    availableQuantity: quantityOnHand,
    averageUnitCost,
    inventoryValue,
    asOfDate: q.asOfDate ?? new Date().toISOString().slice(0, 10),
  };
}

/** Total inventory value for an entity across all items (subledger total). */
export function getSubledgerValue(movements: StockMovement[], entityId: string, asOfDate?: string): number {
  const items = new Set(movements.filter((m) => m.entityId === entityId).map((m) => m.itemId));
  let total = 0;
  for (const itemId of items) {
    total += getInventoryValue(movements, { entityId, itemId, asOfDate });
  }
  return round2(total);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function round6(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}

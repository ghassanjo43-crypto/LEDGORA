/**
 * Inventory valuation engine — weighted-average cost (the required Phase 1
 * method).
 *
 * The running average is recomputed on every inbound movement; outbound
 * movements are costed at the average prevailing AT THE TIME THEY POST. A later
 * receipt never rewrites the cost of an already-posted issue, and a reversal
 * always uses the ORIGINAL movement cost (carried on the movement), never the
 * current average.
 *
 * All amounts are in the entity base currency. Quantity and value are derived
 * purely from the posted movement ledger — nothing is stored as authoritative.
 */
import type { StockMovement } from '@/types/inventory';

/** A running position for one item (optionally within one warehouse). */
export interface ValuationState {
  quantity: number;
  value: number;
  averageCost: number;
}

export const EMPTY_STATE: ValuationState = { quantity: 0, value: 0, averageCost: 0 };

function round(n: number, dp = 6): number {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}

// Internal running-state precision. Kept high so the average is not degraded by
// premature rounding (the spec requires the average to survive issues exactly);
// persisted movement costs are rounded to 6dp separately in posting.
const RS = 10;

/** Apply an inbound movement to a running state, returning the new state. */
export function applyInbound(state: ValuationState, quantity: number, unitCost: number): ValuationState {
  const qty = round(state.quantity + quantity, RS);
  const value = round(state.value + quantity * unitCost, RS);
  return { quantity: qty, value, averageCost: qty !== 0 ? round(value / qty, RS) : 0 };
}

/**
 * Apply an outbound movement at the CURRENT average cost. Returns the new state
 * and the cost that was applied to the issue (so the caller can post COGS and
 * persist it on the movement).
 */
export function applyOutbound(
  state: ValuationState,
  quantity: number,
  /** Optional explicit cost (e.g. a return at original issue cost). */
  explicitUnitCost?: number,
): { state: ValuationState; unitCost: number; totalCost: number } {
  const unitCost = explicitUnitCost ?? state.averageCost;
  const totalCost = round(quantity * unitCost, RS);
  const qty = round(state.quantity - quantity, RS);
  const value = round(state.value - totalCost, RS);
  // Weighted-average: the average is preserved on issue.
  const averageCost = qty > 0 ? round(value / qty, RS) : state.averageCost;
  return { state: { quantity: qty, value: qty === 0 ? 0 : value, averageCost }, unitCost, totalCost };
}

/**
 * Replay a chronologically-ordered list of POSTED movements into a running
 * valuation state. Reversed movements are ignored. Movements that already carry
 * a persisted `unitCostBase` (outbound) use that persisted cost so history is
 * never rewritten; only the running state is advanced.
 */
export function replayMovements(movements: StockMovement[]): ValuationState {
  let state = EMPTY_STATE;
  for (const m of ordered(movements)) {
    if (m.status === 'reversed') continue;
    if (m.direction === 'in') {
      state = applyInbound(state, m.quantity, m.unitCostBase);
    } else {
      // Use the movement's own recorded cost (preserves history / reversals).
      const res = applyOutbound(state, m.quantity, m.unitCostBase);
      state = res.state;
    }
  }
  return state;
}

/**
 * The average cost that a NEW outbound movement would use right now, given the
 * prior posted movements. Used by posting to cost issues/deliveries.
 */
export function currentAverageCost(movements: StockMovement[]): number {
  return replayMovements(movements).averageCost;
}

/** Chronological sort: postingDate, then creation order (createdAt), then id. */
export function ordered(movements: StockMovement[]): StockMovement[] {
  return [...movements].sort((a, b) => {
    if (a.postingDate !== b.postingDate) return a.postingDate < b.postingDate ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export { round as roundCost };

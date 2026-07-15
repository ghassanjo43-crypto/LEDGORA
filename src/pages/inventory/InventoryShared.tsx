/**
 * Shared inventory UI helpers: money formatting, item/warehouse option builders,
 * a derived-balances hook and the stock-movement ledger table. All derivations
 * happen in useMemo over stored arrays so selectors stay stable.
 */
import { useMemo } from 'react';
import { useInventoryStore } from '@/store/inventoryStore';
import { useStore } from '@/store/useStore';
import { ENTITY } from '@/lib/inventorySeed';
import { getInventoryBalance, getSubledgerValue } from '@/lib/inventoryBalance';
import { ordered } from '@/lib/inventoryValuation';
import type { StockMovement } from '@/types/inventory';

export function money(n: number, currency?: string): string {
  const cur = currency ?? useStore.getState().settings.baseCurrency ?? 'USD';
  return `${cur} ${(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function qty(n: number): string {
  return (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

/** Active (non-archived) item options. */
export function useItemOptions(onlyTracked = false) {
  const items = useInventoryStore((s) => s.items);
  return useMemo(
    () =>
      items
        .filter((i) => i.status !== 'archived' && (!onlyTracked || (i.itemType !== 'service' && i.itemType !== 'non-inventory' && i.isInventoryTracked)))
        .map((i) => ({ value: i.id, label: `${i.code} — ${i.name}` })),
    [items, onlyTracked],
  );
}

export function useWarehouseOptions() {
  const warehouses = useInventoryStore((s) => s.warehouses);
  return useMemo(
    () => warehouses.filter((w) => w.status === 'active').map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` })),
    [warehouses],
  );
}

/** Derived per-item balance rows (qty on hand, average cost, value). */
export function useItemBalances() {
  const items = useInventoryStore((s) => s.items);
  const movements = useInventoryStore((s) => s.movements);
  return useMemo(() => {
    return items.map((item) => {
      const bal = getInventoryBalance(movements, { entityId: ENTITY, itemId: item.id });
      return { item, ...bal };
    });
  }, [items, movements]);
}

export function useSubledgerValue(): number {
  const movements = useInventoryStore((s) => s.movements);
  return useMemo(() => getSubledgerValue(movements, ENTITY), [movements]);
}

/** Movement ledger rows with running quantity + value per item. */
export interface LedgerRow {
  movement: StockMovement;
  runningQty: number;
  runningValue: number;
}

export function useMovementLedger(filter?: { itemId?: string; warehouseId?: string }): LedgerRow[] {
  const movements = useInventoryStore((s) => s.movements);
  return useMemo(() => {
    const sorted = ordered(movements.filter((m) => (!filter?.itemId || m.itemId === filter.itemId) && (!filter?.warehouseId || m.warehouseId === filter.warehouseId)));
    const runQty = new Map<string, number>();
    const runVal = new Map<string, number>();
    const rows: LedgerRow[] = [];
    for (const m of sorted) {
      if (m.status === 'reversed') {
        rows.push({ movement: m, runningQty: runQty.get(m.itemId) ?? 0, runningValue: runVal.get(m.itemId) ?? 0 });
        continue;
      }
      const dq = m.direction === 'in' ? m.quantity : -m.quantity;
      const dv = m.direction === 'in' ? m.totalCostBase : -m.totalCostBase;
      runQty.set(m.itemId, (runQty.get(m.itemId) ?? 0) + dq);
      runVal.set(m.itemId, Math.round(((runVal.get(m.itemId) ?? 0) + dv) * 100) / 100);
      rows.push({ movement: m, runningQty: runQty.get(m.itemId)!, runningValue: runVal.get(m.itemId)! });
    }
    return rows.reverse();
  }, [movements, filter?.itemId, filter?.warehouseId]);
}

/** CSV export of the movement ledger (spec §38). */
export function movementsToCsv(rows: LedgerRow[]): string {
  const header = ['Date', 'Movement', 'Source', 'Type', 'Item', 'Warehouse', 'In', 'Out', 'RunningQty', 'UnitCost', 'InValue', 'OutValue', 'RunningValue', 'Journal'];
  const lines = rows.map((r) => {
    const m = r.movement;
    return [
      m.postingDate, m.movementNumber, m.sourceDocumentType, m.movementType, m.itemSnapshot.code, m.warehouseSnapshot.code,
      m.direction === 'in' ? m.quantity : '', m.direction === 'out' ? m.quantity : '', r.runningQty,
      m.unitCostBase, m.direction === 'in' ? m.totalCostBase : '', m.direction === 'out' ? m.totalCostBase : '', r.runningValue,
      m.journalEntryId ?? '',
    ].join(',');
  });
  return [header.join(','), ...lines].join('\n');
}

/** Trigger a browser CSV download. */
export function downloadCsv(fileName: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName; a.click();
  URL.revokeObjectURL(url);
}

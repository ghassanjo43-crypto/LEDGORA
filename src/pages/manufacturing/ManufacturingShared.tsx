/**
 * Shared helpers for the manufacturing pages: money/qty formatting, item and
 * work-order lookups, and WIP derivation. All derivations run in useMemo over
 * stored arrays so selectors stay stable.
 */
import { useMemo } from 'react';
import { useManufacturingStore } from '@/store/manufacturingStore';
import { useInventoryStore } from '@/store/inventoryStore';
import { useStore } from '@/store/useStore';
import { calculateWorkOrderWip, calculateActualWorkOrderCost, calculateVariance } from '@/lib/manufacturingCosting';

export function money(n: number): string {
  const cur = useStore.getState().settings.baseCurrency ?? 'USD';
  return `${cur} ${(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function qty(n: number): string {
  return (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

export function useItemName() {
  const items = useInventoryStore((s) => s.items);
  return useMemo(() => {
    const map = new Map(items.map((i) => [i.id, `${i.code} — ${i.name}`]));
    return (id: string) => map.get(id) ?? id;
  }, [items]);
}

/** Per-work-order derived WIP / actual cost / variance. */
export function useWorkOrderMetrics(workOrderId: string) {
  const store = useManufacturingStore((s) => s);
  return useMemo(() => {
    const activity = {
      issues: store.materialIssues.filter((d) => d.workOrderId === workOrderId),
      returns: store.materialReturns.filter((d) => d.workOrderId === workOrderId),
      receipts: store.productionReceipts.filter((d) => d.workOrderId === workOrderId),
      operationCosts: store.operationCosts.filter((d) => d.workOrderId === workOrderId),
      scraps: store.scraps.filter((d) => d.workOrderId === workOrderId),
    };
    const wo = store.workOrders.find((w) => w.id === workOrderId);
    const wip = calculateWorkOrderWip(workOrderId, activity);
    const actual = calculateActualWorkOrderCost(workOrderId, activity);
    const variance = wo ? calculateVariance(wo.standardCostSnapshot.unitCost, wo.standardCostSnapshot, actual) : undefined;
    return { wip, actual, variance };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workOrderId, store.materialIssues, store.materialReturns, store.productionReceipts, store.operationCosts, store.scraps, store.workOrders]);
}

const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'slate' | 'indigo'> = {
  draft: 'slate', planned: 'indigo', released: 'indigo', 'in-progress': 'amber',
  'partially-completed': 'amber', completed: 'green', closed: 'green', 'on-hold': 'amber', cancelled: 'red',
};
export function statusTone(status: string): 'green' | 'amber' | 'red' | 'slate' | 'indigo' {
  return STATUS_TONE[status] ?? 'slate';
}

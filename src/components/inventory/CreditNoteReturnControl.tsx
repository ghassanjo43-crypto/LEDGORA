/**
 * Per-line "return to inventory" control for the credit-note editor (gated by
 * entitlement). Toggling it links the credit line to a stock item + warehouse
 * and resolves the original issue cost (from the original invoice line, falling
 * back to the item's current average) so the physical return posts a movement
 * at the correct cost and the inventory-return journal balances.
 */
import { useMemo } from 'react';
import type { CreditNoteLine } from '@/types/creditNote';
import { useInventoryStore } from '@/store/inventoryStore';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useStore } from '@/store/useStore';
import { resolveInventoryAccounts } from '@/lib/inventoryAccounts';
import { getInventoryBalance } from '@/lib/inventoryBalance';
import { ENTITY } from '@/lib/inventorySeed';
import { Select } from '@/components/ui/Select';

export function CreditNoteReturnControl({
  line,
  originalInvoiceId,
  disabled,
  onChange,
}: {
  line: CreditNoteLine;
  originalInvoiceId?: string;
  disabled?: boolean;
  onChange: (patch: Partial<CreditNoteLine>) => void;
}) {
  const items = useInventoryStore((s) => s.items);
  const warehouses = useInventoryStore((s) => s.warehouses);
  const movements = useInventoryStore((s) => s.movements);

  const itemOptions = useMemo(() => [{ value: '', label: 'No stock item' }, ...items.filter((i) => i.status !== 'archived' && i.itemType !== 'service' && i.itemType !== 'non-inventory').map((i) => ({ value: i.id, label: `${i.code} — ${i.name}` }))], [items]);
  const warehouseOptions = useMemo(() => warehouses.filter((w) => w.status === 'active').map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` })), [warehouses]);

  /** Original issue cost per unit: from the original invoice line, else average. */
  const originalUnitCost = (itemId: string): number => {
    if (originalInvoiceId && line.originalInvoiceLineId) {
      const inv = useInvoiceStore.getState().getInvoice(originalInvoiceId);
      const origLine = inv?.lines.find((l) => l.id === line.originalInvoiceLineId);
      if (origLine?.issuedUnitCost != null) return origLine.issuedUnitCost;
    }
    return getInventoryBalance(movements, { entityId: ENTITY, itemId }).averageUnitCost;
  };

  const pickItem = (itemId: string): void => {
    if (!itemId) {
      onChange({ returnToInventory: false, inventoryItemId: undefined, returnWarehouseId: undefined, costAmount: 0 });
      return;
    }
    const st = useInventoryStore.getState();
    const item = st.items.find((it) => it.id === itemId);
    const category = item ? st.categories.find((c) => c.id === item.categoryId) : undefined;
    const acc = item ? resolveInventoryAccounts({ accounts: useStore.getState().accounts, item, category, settings: st.settings }) : undefined;
    const unitCost = originalUnitCost(itemId);
    onChange({
      returnToInventory: true,
      inventoryItemId: itemId,
      returnWarehouseId: line.returnWarehouseId || warehouseOptions[0]?.value,
      inventoryAccountId: acc?.inventory,
      costOfGoodsSoldAccountId: acc?.cogs,
      costAmount: Math.round(unitCost * (line.quantity || 0) * 100) / 100,
    });
  };

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Return to stock</span>
      <div className="w-48"><Select options={itemOptions} value={line.inventoryItemId ?? ''} disabled={disabled} onChange={(e) => pickItem(e.target.value)} /></div>
      {line.inventoryItemId && (
        <div className="w-40"><Select options={warehouseOptions} value={line.returnWarehouseId ?? warehouseOptions[0]?.value ?? ''} disabled={disabled} onChange={(e) => onChange({ returnWarehouseId: e.target.value })} /></div>
      )}
    </div>
  );
}

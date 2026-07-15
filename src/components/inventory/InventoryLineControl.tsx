/**
 * Compact per-line inventory control shared by the invoice and bill editors.
 * Lets the user link a document line to a stock item + warehouse and toggle
 * fulfilment (issue-on-invoice / receive-on-bill). It emits a normalized patch;
 * each editor translates it to its own line fields.
 *
 * Rendered only when the organization is entitled to inventory — non-inventory
 * organizations never see item or warehouse fields.
 */
import { useMemo } from 'react';
import { useInventoryStore } from '@/store/inventoryStore';
import { Select } from '@/components/ui/Select';

export interface InventoryLinePatch {
  itemId?: string;
  warehouseId?: string;
  enabled: boolean;
}

export function InventoryLineControl({
  mode,
  itemId,
  warehouseId,
  enabled,
  disabled,
  onChange,
}: {
  mode: 'issue' | 'receive';
  itemId?: string;
  warehouseId?: string;
  enabled: boolean;
  disabled?: boolean;
  onChange: (patch: InventoryLinePatch) => void;
}) {
  const items = useInventoryStore((s) => s.items);
  const warehouses = useInventoryStore((s) => s.warehouses);

  const itemOptions = useMemo(
    () => [
      { value: '', label: 'No stock item' },
      ...items
        .filter((i) => i.status !== 'archived' && i.itemType !== 'service' && i.itemType !== 'non-inventory' && i.isInventoryTracked)
        .map((i) => ({ value: i.id, label: `${i.code} — ${i.name}` })),
    ],
    [items],
  );
  const warehouseOptions = useMemo(
    () => warehouses.filter((w) => w.status === 'active').map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` })),
    [warehouses],
  );

  const label = mode === 'issue' ? 'Issue from stock' : 'Receive to stock';

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      <div className="w-48">
        <Select
          options={itemOptions}
          value={itemId ?? ''}
          disabled={disabled}
          onChange={(e) => {
            const id = e.target.value || undefined;
            onChange({ itemId: id, warehouseId: id ? warehouseId ?? warehouseOptions[0]?.value : undefined, enabled: !!id });
          }}
        />
      </div>
      {itemId && (
        <div className="w-40">
          <Select
            options={warehouseOptions}
            value={warehouseId ?? warehouseOptions[0]?.value ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ itemId, warehouseId: e.target.value, enabled: enabled || !!itemId })}
          />
        </div>
      )}
    </div>
  );
}

import { useMemo } from 'react';
import { Select } from '@/components/ui/Select';
import { ENTITY } from '@/lib/inventorySeed';
import { activePurchaseItems, activeSalesItems } from '@/lib/itemCatalogue';
import { useInventoryStore } from '@/store/inventoryStore';

export function ItemSelector({ mode, value, disabled, onChange }: {
  mode: 'sales' | 'purchase'; value?: string; disabled?: boolean; onChange: (itemId?: string) => void;
}) {
  const items = useInventoryStore((state) => state.items);
  const options = useMemo(() => {
    const available = mode === 'sales' ? activeSalesItems(items, ENTITY) : activePurchaseItems(items, ENTITY);
    return [{ value: '', label: 'Manual line' }, ...available.map((item) => ({ value: item.id, label: `${item.code} — ${item.name}` }))];
  }, [items, mode]);
  return <Select value={value ?? ''} options={options} disabled={disabled} onChange={(event) => onChange(event.target.value || undefined)} />;
}

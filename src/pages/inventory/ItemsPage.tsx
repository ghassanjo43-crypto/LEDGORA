import { useMemo, useState } from 'react';
import { useInventoryStore } from '@/store/inventoryStore';
import { useStore } from '@/store/useStore';
import { useTaxCodeStore } from '@/store/taxCodeStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useHasModule } from '@/store/entitlementHooks';
import type { InventoryItem } from '@/types/inventory';
import { ENTITY } from '@/lib/inventorySeed';
import { getInventoryBalance } from '@/lib/inventoryBalance';
import { itemClassification, validateItemAccountMappings } from '@/lib/itemCatalogue';
import { postingAccountOptions } from '@/lib/accountEligibility';
import { generateId } from '@/lib/utils';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Alert } from '@/components/ui/Alert';
import { Drawer } from '@/components/ui/Drawer';
import { money, qty } from './InventoryShared';

function blankItem(baseUnitId: string): InventoryItem {
  return {
    id: generateId('item'), entityId: ENTITY, code: '', name: '', itemType: 'non-inventory', baseUnitId,
    isInventoryTracked: false, isPurchasable: true, isSellable: true, isManufacturable: false,
    trackingMode: 'none', valuationMethod: 'weighted-average', status: 'active', createdAt: '', updatedAt: '',
  };
}

export function ItemsPage() {
  const items = useInventoryStore((s) => s.items);
  const units = useInventoryStore((s) => s.units);
  const categories = useInventoryStore((s) => s.categories);
  const movements = useInventoryStore((s) => s.movements);
  const saveItem = useInventoryStore((s) => s.saveItem);
  const archiveItem = useInventoryStore((s) => s.archiveItem);
  const accounts = useStore((s) => s.accounts);
  const taxCodes = useTaxCodeStore((s) => s.taxCodes);
  const entities = useEntityStore((s) => s.entities);
  const hasInventory = useHasModule('inventory_basic');
  const [editing, setEditing] = useState<InventoryItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => items.filter((item) => item.entityId === ENTITY).map((item) => ({ item, bal: getInventoryBalance(movements, { entityId: ENTITY, itemId: item.id }) })), [items, movements]);
  const unitOptions = units.filter((unit) => unit.status === 'active').map((unit) => ({ value: unit.id, label: `${unit.code} — ${unit.name}` }));
  const categoryOptions = [{ value: '', label: 'None' }, ...categories.filter((category) => category.status === 'active').map((category) => ({ value: category.id, label: category.name }))];
  const accountOptions = (purpose: Parameters<typeof postingAccountOptions>[0]['purpose']) => postingAccountOptions({ accounts, purpose }, 'Use account defaults');
  const taxOptions = [{ value: '', label: 'No default tax' }, ...taxCodes.filter((tax) => tax.status === 'active').map((tax) => ({ value: tax.id, label: `${tax.code} — ${tax.name}` }))];
  const supplierOptions = [{ value: '', label: 'No preferred supplier' }, ...entities.filter((entity) => entity.entityType === 'supplier' || entity.entityType === 'both').map((entity) => ({ value: entity.id, label: entity.legalName }))];
  const currentMappingIssues = editing ? validateItemAccountMappings(editing, accounts) : [];

  const save = (): void => {
    if (!editing) return;
    const mappingIssues = validateItemAccountMappings(editing, accounts);
    if (mappingIssues.length) { setError(mappingIssues.map((issue) => issue.message).join(' ')); return; }
    const res = saveItem(editing);
    if (!res.ok) { setError(res.error ?? 'Could not save item.'); return; }
    setEditing(null); setError(null);
  };
  const set = <K extends keyof InventoryItem>(key: K, value: InventoryItem[K]): void => setEditing((item) => item ? { ...item, [key]: value } : item);

  return <div className="space-y-4">
    <div className="flex items-center justify-between">
      <p className="max-w-2xl text-sm text-slate-500">Products and services shared by sales and purchasing. Prices and descriptions are copied into document lines as editable snapshots; changing an item never changes previous transactions.</p>
      <Button onClick={() => { setError(null); setEditing(blankItem(units[0]?.id ?? '')); }}>New item</Button>
    </div>
    <Card className="overflow-hidden"><div className="overflow-x-auto"><table className="w-full text-sm">
      <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50"><tr><th className="px-4 py-2 text-left">Code</th><th className="px-4 py-2 text-left">Name</th><th className="px-4 py-2 text-left">Kind</th><th className="px-4 py-2 text-right">Selling price</th><th className="px-4 py-2 text-right">Purchase price</th><th className="px-4 py-2 text-left">Status</th>{hasInventory && <><th className="px-4 py-2 text-right">On hand</th><th className="px-4 py-2 text-right">Stock value</th></>}<th /></tr></thead>
      <tbody>{rows.map(({ item, bal }) => <tr key={item.id} className="border-t border-slate-100 dark:border-slate-800">
        <td className="px-4 py-2 font-medium">{item.code}</td><td className="px-4 py-2">{item.name}</td><td className="px-4 py-2"><Badge tone="slate">{itemClassification(item)}</Badge>{item.isInventoryTracked && <Badge tone="blue">stock tracked</Badge>}</td>
        <td className="px-4 py-2 text-right">{item.isSellable ? money(item.defaultSellingPrice ?? 0) : '—'}</td><td className="px-4 py-2 text-right">{item.isPurchasable ? money(item.defaultPurchasePrice ?? item.standardCost ?? 0) : '—'}</td><td className="px-4 py-2"><Badge tone={item.status === 'active' ? 'green' : item.status === 'archived' ? 'red' : 'slate'}>{item.status}</Badge></td>
        {hasInventory && <><td className="px-4 py-2 text-right">{item.isInventoryTracked ? qty(bal.quantityOnHand) : '—'}</td><td className="px-4 py-2 text-right">{item.isInventoryTracked ? money(bal.inventoryValue) : '—'}</td></>}
        <td className="whitespace-nowrap px-4 py-2 text-right"><Button size="sm" variant="ghost" onClick={() => { setError(null); setEditing({ ...item }); }}>Edit</Button>{item.status !== 'archived' && <Button size="sm" variant="ghost" onClick={() => archiveItem(item.id)}>Archive</Button>}</td>
      </tr>)}{rows.length === 0 && <tr><td colSpan={hasInventory ? 9 : 7} className="px-4 py-8 text-center text-slate-400">No items yet.</td></tr>}</tbody>
    </table></div></Card>

    <Drawer open={!!editing} onClose={() => setEditing(null)} title={editing?.code ? `Edit ${editing.code}` : 'New item'} description="Maintain reusable sales, purchasing and inventory defaults" widthClassName="max-w-4xl"
      footer={editing && <div className="flex w-full flex-wrap items-center justify-between gap-3"><p className="text-xs text-slate-500">Changes apply to future document lines only.</p><div className="flex gap-2"><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={save}>Save item</Button></div></div>}>
      {editing && <div className="mx-auto max-w-3xl space-y-6">{error && <Alert variant="error">{error}</Alert>}
        {currentMappingIssues.length > 0 && <Alert variant="warning">This item requires attention before it can be saved or used for a new posting. {currentMappingIssues.map((issue) => issue.message).join(' ')}</Alert>}
        <section aria-labelledby="item-details-heading" className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-5"><h3 id="item-details-heading" className="text-xs font-semibold uppercase tracking-wide text-slate-500">Item details</h3><div className="grid gap-4 sm:grid-cols-2">
          <Field label="Item code / SKU" required><Input value={editing.code} onChange={(e) => set('code', e.target.value)} /></Field><Field label="Primary name" required><Input value={editing.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Secondary-language name"><Input value={editing.nameSecondary ?? ''} onChange={(e) => set('nameSecondary', e.target.value || undefined)} /></Field><Field label="Product or service"><Select value={itemClassification(editing)} options={[{ value: 'product', label: 'Product' }, { value: 'service', label: 'Service' }]} onChange={(e) => { const service = e.target.value === 'service'; setEditing({ ...editing, itemType: service ? 'service' : 'non-inventory', isInventoryTracked: service ? false : editing.isInventoryTracked }); }} /></Field>
          <Field label="Unit of measure"><Select value={editing.baseUnitId} options={unitOptions} onChange={(e) => set('baseUnitId', e.target.value)} /></Field><Field label="Category"><Select value={editing.categoryId ?? ''} options={categoryOptions} onChange={(e) => set('categoryId', e.target.value || undefined)} /></Field>
          <Field label="GTIN / barcode"><Input value={editing.gtin ?? ''} onChange={(e) => set('gtin', e.target.value || undefined)} /></Field><Field label="Status"><Select value={editing.status} options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'archived', label: 'Archived' }]} onChange={(e) => set('status', e.target.value as InventoryItem['status'])} /></Field>
          <Field label="Image reference"><Input value={editing.imageRef ?? ''} onChange={(e) => set('imageRef', e.target.value || undefined)} /></Field>
        </div><Field label="General description"><Input value={editing.description ?? ''} onChange={(e) => set('description', e.target.value || undefined)} /></Field></section>

        <section aria-labelledby="sales-information-heading" className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-5"><h3 id="sales-information-heading" className="text-xs font-semibold uppercase tracking-wide text-slate-500">Sales information</h3><label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={editing.isSellable} onChange={(e) => set('isSellable', e.target.checked)} />I sell this item</label>{editing.isSellable && <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Default selling price"><Input type="number" min="0" value={editing.defaultSellingPrice ?? 0} onChange={(e) => set('defaultSellingPrice', Number(e.target.value))} /></Field><Field label="Revenue account"><Select value={editing.salesAccountId ?? ''} options={accountOptions('revenue')} onChange={(e) => set('salesAccountId', e.target.value || undefined)} /></Field>
          <Field label="Sales tax code"><Select value={editing.salesTaxCodeId ?? ''} options={taxOptions} onChange={(e) => set('salesTaxCodeId', e.target.value || undefined)} /></Field><Field label="Sales description"><Input value={editing.salesDescription ?? ''} onChange={(e) => set('salesDescription', e.target.value || undefined)} /></Field>
        </div>}</section>

        <section aria-labelledby="purchase-information-heading" className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-5"><h3 id="purchase-information-heading" className="text-xs font-semibold uppercase tracking-wide text-slate-500">Purchase information</h3><label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={editing.isPurchasable} onChange={(e) => set('isPurchasable', e.target.checked)} />I purchase this item</label>{editing.isPurchasable && <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Default purchase price"><Input type="number" min="0" value={editing.defaultPurchasePrice ?? editing.standardCost ?? 0} onChange={(e) => set('defaultPurchasePrice', Number(e.target.value))} /></Field><Field label="Expense account"><Select value={editing.purchaseAccountId ?? ''} options={accountOptions('purchase-expense')} onChange={(e) => set('purchaseAccountId', e.target.value || undefined)} /></Field>
          <Field label="Purchase tax code"><Select value={editing.purchaseTaxCodeId ?? ''} options={taxOptions} onChange={(e) => set('purchaseTaxCodeId', e.target.value || undefined)} /></Field><Field label="Preferred supplier"><Select value={editing.defaultSupplierId ?? ''} options={supplierOptions} onChange={(e) => set('defaultSupplierId', e.target.value || undefined)} /></Field><Field label="Purchase description"><Input value={editing.purchaseDescription ?? ''} onChange={(e) => set('purchaseDescription', e.target.value || undefined)} /></Field>
        </div>}</section>

        {hasInventory && itemClassification(editing) === 'product' && <section aria-labelledby="inventory-settings-heading" className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-5"><h3 id="inventory-settings-heading" className="text-xs font-semibold uppercase tracking-wide text-slate-500">Inventory settings</h3><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editing.isInventoryTracked} onChange={(e) => setEditing({ ...editing, isInventoryTracked: e.target.checked, itemType: e.target.checked && editing.itemType === 'non-inventory' ? 'inventory' : editing.itemType })} />Track inventory for this product</label>{editing.isInventoryTracked && <><div className="grid gap-4 sm:grid-cols-2"><Field label="Valuation method"><Select value={editing.valuationMethod} options={[{ value: 'weighted-average', label: 'Weighted average' }, { value: 'standard', label: 'Standard' }]} onChange={(e) => set('valuationMethod', e.target.value as InventoryItem['valuationMethod'])} /></Field><Field label="Tracking mode"><Select value={editing.trackingMode} options={[{ value: 'none', label: 'None' }, { value: 'lot', label: 'Lot' }, { value: 'serial', label: 'Serial' }]} onChange={(e) => set('trackingMode', e.target.value as InventoryItem['trackingMode'])} /></Field><Field label="Inventory asset account"><Select value={editing.inventoryAccountId ?? ''} options={accountOptions('inventory-asset')} onChange={(e) => set('inventoryAccountId', e.target.value || undefined)} /></Field><Field label="COGS account"><Select value={editing.costOfGoodsSoldAccountId ?? ''} options={accountOptions('cogs')} onChange={(e) => set('costOfGoodsSoldAccountId', e.target.value || undefined)} /></Field></div><div className="border-t border-slate-100 pt-4 dark:border-slate-800"><h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Reorder settings</h4><div className="grid gap-4 sm:grid-cols-2"><Field label="Reorder level"><Input type="number" min="0" value={editing.reorderLevel ?? 0} onChange={(e) => set('reorderLevel', Number(e.target.value))} /></Field><Field label="Reorder quantity"><Input type="number" min="0" value={editing.reorderQuantity ?? 0} onChange={(e) => set('reorderQuantity', Number(e.target.value))} /></Field></div></div></>}</section>}
        <Alert variant="info">Selling and purchase prices are defaults for new document lines. They do not change previous transactions and purchase price is not an inventory valuation or COGS source.</Alert>
      </div>}
    </Drawer>
  </div>;
}

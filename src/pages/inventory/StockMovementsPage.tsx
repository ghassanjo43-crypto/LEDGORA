import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { useInventoryStore } from '@/store/inventoryStore';
import { ENTITY } from '@/lib/inventorySeed';
import type { StockMovement } from '@/types/inventory';
import { movementItemIdentity, movementLocations, movementMatches, movementReference, movementTypeLabel, signedMovementQuantity } from '@/lib/stockMovementPresentation';
import { money, qty, useMovementLedger, movementsToCsv, downloadCsv } from './InventoryShared';
import { useStockDocuments } from '@/services/inventory/useStock';
import { stockActions } from '@/services/inventory/inventoryActions';
import { Alert } from '@/components/ui/Alert';

/**
 * The immutable movement ledger, from whichever engine holds it.
 *
 * On server books the browser store is not read at all: `useMovementLedger`
 * returns nothing there, and this renders the SERVER's documents instead. A
 * durable subscriber looking at demo movements would be reading another
 * ledger's history under their own company's name.
 */
function DurableMovements() {
  const { documents, loading, error } = useStockDocuments();
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [reason, setReason] = useState('');
  const [reversing, setReversing] = useState<string | null>(null);

  const reverse = async (id: string, version: number): Promise<void> => {
    setBusy(id);
    try {
      const res = await stockActions().reverse(id, version, reason);
      /* The SERVER's words: consumed stock, a locked period and a stale version
       * each say something different. */
      setMsg(res.ok
        ? { tone: 'success', text: `Reversed as ${res.documentNumber}.` }
        : { tone: 'error', text: res.error ?? 'Could not reverse.' });
      if (res.ok) { setReversing(null); setReason(''); }
    } finally {
      setBusy('');
    }
  };

  return <div className="space-y-4">
    {error && <Alert variant="error">{error}</Alert>}
    {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}
    <Card className="overflow-x-auto"><table className="w-full min-w-[1100px] text-sm">
      <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50"><tr>
        {['Date', 'Document', 'Type', 'Item', 'Warehouse', 'Quantity', 'Unit cost', 'Value', 'Status', ''].map((heading) => (
          <th key={heading} className={'px-3 py-2 ' + (['Quantity', 'Unit cost', 'Value'].includes(heading) ? 'text-right' : 'text-left')}>{heading}</th>
        ))}
      </tr></thead>
      <tbody>
        {documents.flatMap((document) => document.movements.map((movement) => (
          <tr
            key={movement.id}
            className={'border-t border-slate-100 dark:border-slate-800 ' + (movement.status === 'reversed' ? 'text-slate-400 line-through' : '')}
          >
            <td className="px-3 py-2">{movement.postingDate}</td>
            <td className="px-3 py-2">
              <span className="font-medium">{document.documentNumber}</span>
              <span className="block text-xs text-slate-400">{document.reference || document.kind}</span>
            </td>
            <td className="px-3 py-2">
              <Badge tone={movement.direction === 'in' ? 'green' : 'amber'}>{movement.movementType}</Badge>
            </td>
            <td className="px-3 py-2"><span className="font-medium">{movement.itemCode}</span> — {movement.itemName}</td>
            <td className="px-3 py-2">{movement.warehouseCode}</td>
            <td className={'px-3 py-2 text-right font-mono ' + (movement.direction === 'in' ? 'text-emerald-600' : 'text-amber-700')}>
              {movement.direction === 'in' ? '' : '−'}{movement.quantity} {movement.baseUnitCode}
            </td>
            <td className="px-3 py-2 text-right font-mono">{money(Number(movement.unitCost))}</td>
            <td className="px-3 py-2 text-right font-mono">{money(Number(movement.totalCost))}</td>
            <td className="px-3 py-2"><Badge tone={movement.status === 'posted' ? 'green' : 'slate'}>{movement.status}</Badge></td>
            <td className="px-3 py-2 text-right">
              {movement.lineNumber === 1 && document.status === 'posted' && (
                <Button size="sm" variant="ghost" disabled={busy === document.id} onClick={() => setReversing(document.id)}>
                  Reverse
                </Button>
              )}
            </td>
          </tr>
        )))}
        {documents.length === 0 && (
          <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-400">
            {loading ? 'Loading…' : 'No stock movements.'}
          </td></tr>
        )}
      </tbody>
    </table></Card>

    {reversing && (
      <Card className="space-y-3 p-4">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Reversing restores the quantity and the value exactly, at the original cost, and withdraws
          the journal. Nothing is deleted — both the original and its reversal stay on the record.
        </p>
        <label className="text-xs text-slate-500" htmlFor="reverse-reason">Reason (at least five characters)</label>
        <Input id="reverse-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => { setReversing(null); setReason(''); }}>Cancel</Button>
          <Button
            disabled={busy === reversing}
            onClick={() => {
              const document = documents.find((d) => d.id === reversing);
              if (document) void reverse(document.id, document.version);
            }}
          >
            Reverse document
          </Button>
        </div>
      </Card>
    )}
  </div>;
}

export function StockMovementsPage() {
  const items = useInventoryStore((state) => state.items);
  const units = useInventoryStore((state) => state.units);
  const warehouses = useInventoryStore((state) => state.warehouses);
  const movements = useInventoryStore((state) => state.movements);
  const documents = useInventoryStore((state) => state.documents);
  const [itemId, setItemId] = useState('');
  const [movementType, setMovementType] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [reference, setReference] = useState('');
  const [search, setSearch] = useState('');
  const ledger = useMovementLedger();
  const { serverBacked } = useStockDocuments();

  /* Server books get the server's ledger; the browser store is not read. */
  if (serverBacked) return <DurableMovements />;

  const itemOptions = useMemo(() => Array.from(new Set(movements.filter((movement) => movement.entityId === ENTITY).map((movement) => movement.itemId))).map((id) => {
    const movement = movements.find((candidate) => candidate.entityId === ENTITY && candidate.itemId === id)!;
    return { value: id, label: movementItemIdentity(movement, items, units, ENTITY).label };
  }).sort((a, b) => a.label.localeCompare(b.label)), [items, movements, units]);
  const warehouseOptions = useMemo(() => warehouses.filter((warehouse) => warehouse.entityId === ENTITY).map((warehouse) => ({ value: warehouse.id, label: `${warehouse.code} — ${warehouse.name}` })), [warehouses]);
  const movementTypeOptions = useMemo(() => Array.from(new Set(movements.filter((movement) => movement.entityId === ENTITY).map((movement) => movement.movementType))).sort().map((value) => ({ value, label: movementTypeLabel({ movementType: value }) })), [movements]);
  const rows = useMemo(() => ledger.filter(({ movement }) => {
    const identity = movementItemIdentity(movement, items, units, ENTITY);
    const ref = movementReference(movement, documents, ENTITY);
    return movementMatches(movement, identity, ref, { entityId: ENTITY, itemId: itemId || undefined, movementType: (movementType || undefined) as StockMovement['movementType'] | undefined, warehouseId: warehouseId || undefined, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined, reference: reference || undefined, search: search || undefined });
  }), [dateFrom, dateTo, documents, itemId, items, ledger, movementType, reference, search, units, warehouseId]);

  return <div className="space-y-4">
    <Card className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
      <label className="text-xs text-slate-500">Item<Select aria-label="Item" options={[{ value: '', label: 'All items' }, ...itemOptions]} value={itemId} onChange={(event) => setItemId(event.target.value)} /></label>
      <label className="text-xs text-slate-500">Movement type<Select aria-label="Movement type" options={[{ value: '', label: 'All movement types' }, ...movementTypeOptions]} value={movementType} onChange={(event) => setMovementType(event.target.value)} /></label>
      <label className="text-xs text-slate-500">Warehouse<Select aria-label="Warehouse" options={[{ value: '', label: 'All warehouses' }, ...warehouseOptions]} value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)} /></label>
      <label className="text-xs text-slate-500">Reference<Input aria-label="Reference" value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Document reference" /></label>
      <label className="text-xs text-slate-500">From date<Input aria-label="From date" type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label>
      <label className="text-xs text-slate-500">To date<Input aria-label="To date" type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label>
      <label className="text-xs text-slate-500 sm:col-span-2">Search<Input aria-label="Search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Item code, item name or movement reference" /></label>
      <div className="flex items-end justify-end sm:col-span-2 lg:col-span-4"><Button variant="outline" onClick={() => downloadCsv('stock-movements.csv', movementsToCsv(rows))}>Export CSV</Button></div>
    </Card>
    <Card className="overflow-x-auto"><table className="w-full min-w-[1450px] text-sm">
      <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50"><tr>{['Date', 'Reference', 'Movement type', 'Item', 'From warehouse', 'To warehouse', 'Quantity', 'Unit', 'Unit cost', 'Movement value', 'Run qty', 'Run value', 'Status'].map((heading) => <th key={heading} className={'px-3 py-2 ' + (['Quantity', 'Unit cost', 'Movement value', 'Run qty', 'Run value'].includes(heading) ? 'text-right' : 'text-left')}>{heading}</th>)}</tr></thead>
      <tbody>{rows.map((row) => {
        const movement = row.movement;
        const identity = movementItemIdentity(movement, items, units, ENTITY);
        const locations = movementLocations(movement, movements, warehouses, ENTITY);
        return <tr key={movement.id} className={'border-t border-slate-100 dark:border-slate-800 ' + (movement.status === 'reversed' ? 'text-slate-400 line-through' : '')}>
          <td className="px-3 py-2">{movement.postingDate}</td>
          <td className="px-3 py-2"><span className="font-medium">{movementReference(movement, documents, ENTITY)}</span><span className="block text-xs text-slate-400">{movement.movementNumber}</span></td>
          <td className="px-3 py-2"><Badge tone={movement.direction === 'in' ? 'green' : 'amber'}>{movementTypeLabel(movement)}</Badge></td>
          <td className="px-3 py-2"><span className="font-medium">{identity.label}</span>{identity.status && identity.status !== 'active' && <Badge className="ml-2" tone="slate">{identity.status}</Badge>}</td>
          <td className="px-3 py-2">{locations.from}</td><td className="px-3 py-2">{locations.to}</td>
          <td className={'px-3 py-2 text-right font-mono ' + (movement.direction === 'in' ? 'text-emerald-600' : 'text-amber-700')}>{qty(signedMovementQuantity(movement))}</td>
          <td className="px-3 py-2">{identity.unit || '—'}</td><td className="px-3 py-2 text-right font-mono">{money(movement.unitCostBase)}</td>
          <td className="px-3 py-2 text-right font-mono">{money(movement.direction === 'in' ? movement.totalCostBase : -movement.totalCostBase)}</td>
          <td className="px-3 py-2 text-right font-mono">{qty(row.runningQty)}</td><td className="px-3 py-2 text-right font-mono">{money(row.runningValue)}</td>
          <td className="px-3 py-2"><Badge tone={movement.status === 'posted' ? 'green' : 'slate'}>{movement.status}</Badge></td>
        </tr>;
      })}{rows.length === 0 && <tr><td colSpan={13} className="px-4 py-8 text-center text-slate-400">No stock movements.</td></tr>}</tbody>
    </table></Card>
  </div>;
}

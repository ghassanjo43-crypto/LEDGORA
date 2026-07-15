import { useMemo, useState } from 'react';
import { ReceiptText } from 'lucide-react';
import type { Bill } from '@/types/bill';
import { useStore } from '@/store/useStore';
import { useBillStore } from '@/store/billStore';
import { useInventoryStore } from '@/store/inventoryStore';
import { useHasModule } from '@/store/entitlementHooks';
import { resolveInventoryAccounts } from '@/lib/inventoryAccounts';
import { formatCurrency } from '@/lib/money';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { AccountSelect } from '@/components/journal/AccountSelect';
import { useToast } from '@/components/ui/Toast';

/** Raise a supplier credit against a bill (Dr trade payables / Cr expense + input tax). */
export function BillSupplierCreditDialog({ bill, onClose }: { bill: Bill; onClose: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const createSupplierCredit = useBillStore((s) => s.createSupplierCredit);
  const { notify } = useToast();

  const [netAmount, setNetAmount] = useState(0);
  const [taxAmount, setTaxAmount] = useState(0);
  const [creditAccountId, setCreditAccountId] = useState(bill.lines[0]?.accountId ?? '');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  // Optional physical return to inventory (gated by entitlement).
  const showInventory = useHasModule('inventory_basic');
  const items = useInventoryStore((s) => s.items);
  const warehouses = useInventoryStore((s) => s.warehouses);
  const [returnInventory, setReturnInventory] = useState(false);
  const [returnItemId, setReturnItemId] = useState('');
  const [returnWarehouseId, setReturnWarehouseId] = useState('');
  const [returnQuantity, setReturnQuantity] = useState(0);
  const [returnUnitCost, setReturnUnitCost] = useState(0);
  const itemOptions = useMemo(() => [{ value: '', label: 'Select item' }, ...items.filter((i) => i.status !== 'archived' && i.itemType !== 'service' && i.itemType !== 'non-inventory').map((i) => ({ value: i.id, label: `${i.code} — ${i.name}` }))], [items]);
  const warehouseOptions = useMemo(() => warehouses.filter((w) => w.status === 'active').map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` })), [warehouses]);

  const money = (n: number): string => formatCurrency(n, bill.currency);
  const total = Math.round((Number(netAmount) + Number(taxAmount)) * 100) / 100;

  const pickReturnItem = (id: string): void => {
    setReturnItemId(id);
    if (!id) return;
    setReturnWarehouseId((w) => w || warehouseOptions[0]?.value || '');
    // Credit reverses the inventory account so the SC journal credits inventory.
    const st = useInventoryStore.getState();
    const item = st.items.find((it) => it.id === id);
    const category = item ? st.categories.find((c) => c.id === item.categoryId) : undefined;
    const invAcc = item ? resolveInventoryAccounts({ accounts, item, category, settings: st.settings }).inventory : undefined;
    if (invAcc) setCreditAccountId(invAcc);
  };

  const submit = (): void => {
    const res = createSupplierCredit(bill.id, {
      netAmount: Number(netAmount), taxAmount: Number(taxAmount), creditAccountId, reason, date,
      ...(returnInventory && returnItemId ? { returnInventory: true, returnItemId, returnWarehouseId, returnQuantity: Number(returnQuantity), returnUnitCost: Number(returnUnitCost) } : {}),
    });
    if (res.ok) { notify('Supplier credit posted.', 'success'); onClose(); } else notify(res.error ?? 'Could not create the supplier credit.', 'error');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-800 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold">Supplier credit — {bill.billNumber}</h2>
        <p className="mt-0.5 text-xs text-slate-500">Balance due {money(bill.balanceDue)}. Posts Dr trade payables / Cr expense + input tax, reducing the balance.</p>
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-slate-500">Net amount<Input type="number" step="0.01" value={netAmount} onChange={(e) => setNetAmount(Number(e.target.value))} className="mt-1" /></label>
            <label className="block text-xs text-slate-500">Input tax<Input type="number" step="0.01" value={taxAmount} onChange={(e) => setTaxAmount(Number(e.target.value))} className="mt-1" /></label>
          </div>
          <label className="block text-xs text-slate-500">Reverses account<div className="mt-1"><AccountSelect value={creditAccountId} accounts={accounts} onChange={(a) => setCreditAccountId(a.id)} /></div></label>
          <label className="block text-xs text-slate-500">Date<Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1" /></label>
          <label className="block text-xs text-slate-500">Reason<Input value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1" placeholder="Return / overcharge / etc." /></label>

          {showInventory && (
            <div className="rounded-lg border border-slate-200 p-2.5 dark:border-slate-700">
              <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={returnInventory} onChange={(e) => setReturnInventory(e.target.checked)} /> Return goods to inventory
              </label>
              {returnInventory && (
                <div className="mt-2 space-y-2">
                  <Select options={itemOptions} value={returnItemId} onChange={(e) => pickReturnItem(e.target.value)} />
                  <div className="grid grid-cols-3 gap-2">
                    <Select options={warehouseOptions} value={returnWarehouseId} onChange={(e) => setReturnWarehouseId(e.target.value)} />
                    <Input type="number" step="0.01" placeholder="Qty" value={returnQuantity || ''} onChange={(e) => setReturnQuantity(Number(e.target.value))} />
                    <Input type="number" step="0.01" placeholder="Unit cost" value={returnUnitCost || ''} onChange={(e) => setReturnUnitCost(Number(e.target.value))} />
                  </div>
                  <p className="text-[11px] text-slate-400">Records an outbound stock movement at the original receipt cost, linked to this credit's journal.</p>
                </div>
              )}
            </div>
          )}

          <p className="text-xs text-slate-500">Total credit: <span className="font-mono font-semibold">{money(total)}</span></p>
        </div>
        <div className="mt-4 flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!creditAccountId || total <= 0} onClick={submit}><ReceiptText className="h-4 w-4" /> Post credit</Button></div>
      </div>
    </div>
  );
}

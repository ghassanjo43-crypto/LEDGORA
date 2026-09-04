/**
 * Physical stock counts.
 *
 * ── Two engines, one screen ──────────────────────────────────────────────────
 * On durable books every figure here comes from the server and the count posts
 * through the gateway. Free Demo keeps its own disposable posting path
 * untouched.
 *
 * ── Why the expected quantity is only ever DISPLAYED ─────────────────────────
 * On server books the number shown beside each item is a convenience, not the
 * figure the variance is computed from. The server reads the book quantity
 * itself, inside the transaction that posts the adjustment, under the item
 * locks — so a sale that lands between opening this screen and pressing Post is
 * counted by the server rather than lost. What this screen sends is the counted
 * quantity and nothing else.
 *
 * That is also why the sheet is entered and posted in one go: there is no
 * saved, half-finished count, because a count that stayed open would need a
 * rule for what happens to movements inside it, and this product has never
 * stated one.
 */
import { useEffect, useMemo, useState } from 'react';
import { useInventoryStore } from '@/store/inventoryStore';
import { getInventoryBalance } from '@/lib/inventoryBalance';
import { ENTITY } from '@/lib/inventorySeed';
import { generateId } from '@/lib/utils';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { money, qty, useWarehouseOptions } from './InventoryShared';
import { useInventoryMasterData } from '@/services/inventory/useInventoryMasterData';
import {
  inventoryIsServerAuthoritative, useServerCounts, useServerStock,
  loadStockCounts, loadStockPositions, countGateway, newIdempotencyKey,
} from '@/services/inventory/inventoryBackend';

interface CountLine {
  id: string;
  itemId: string;
  code: string;
  /** What the books say. Displayed; on server books never sent. */
  systemQuantity: string;
  frozenUnitCost: number;
  counted: string;
}

export function StockCountsPage() {
  const serverBacked = inventoryIsServerAuthoritative();
  const warehouses = useWarehouseOptions();
  const { items } = useInventoryMasterData();
  const movements = useInventoryStore((s) => s.movements);
  const documents = useInventoryStore((s) => s.documents);
  const postStockCount = useInventoryStore((s) => s.postStockCount);

  const serverCounts = useServerCounts((s) => s.counts);
  const countState = useServerCounts((s) => s.state);
  const countError = useServerCounts((s) => s.error);
  const onHand = useServerStock((s) => s.onHand);

  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.value ?? '');
  const [sheet, setSheet] = useState<CountLine[] | null>(null);
  const [reason, setReason] = useState('Physical stock count');
  /* Minted for the ATTEMPT, so a retry of the same sheet carries the same key
   * and cannot count the warehouse twice. */
  const [attemptKey, setAttemptKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    if (serverBacked) { void loadStockCounts(); void loadStockPositions(); }
  }, [serverBacked]);

  useEffect(() => {
    if (!warehouseId && warehouses[0]) setWarehouseId(warehouses[0].value);
  }, [warehouses, warehouseId]);

  const countable = useMemo(
    () => items.filter((i) => i.status === 'active' && i.isInventoryTracked
      && i.itemType !== 'service' && i.itemType !== 'non-inventory'),
    [items],
  );

  const startCount = (): void => {
    const lines: CountLine[] = countable.map((item) => {
      if (serverBacked) {
        const row = onHand.find((r) => r.itemId === item.id && r.warehouseId === warehouseId);
        return {
          id: generateId('c'), itemId: item.id, code: `${item.code} — ${item.name}`,
          systemQuantity: row?.quantity ?? '0', frozenUnitCost: 0,
          counted: row?.quantity ?? '0',
        };
      }
      const balance = getInventoryBalance(movements, {
        entityId: ENTITY, itemId: item.id, warehouseId,
      });
      return {
        id: generateId('c'), itemId: item.id, code: `${item.code} — ${item.name}`,
        systemQuantity: String(balance.quantityOnHand),
        frozenUnitCost: balance.averageUnitCost,
        counted: String(balance.quantityOnHand),
      };
    });
    setSheet(lines);
    setAttemptKey(newIdempotencyKey());
    setMsg({
      tone: 'success',
      text: serverBacked
        ? 'Enter what is on the shelves. The books are re-read when you post, so anything that '
          + 'moves in the meantime is counted rather than lost.'
        : 'System quantities frozen. Enter counted quantities and post variances.',
    });
  };

  const post = async (): Promise<void> => {
    if (!sheet) return;

    if (serverBacked) {
      if (!reason.trim()) { setMsg({ tone: 'error', text: 'Say what this count was.' }); return; }
      setBusy(true);
      try {
        const { count } = await countGateway.post({
          warehouseId,
          countDate: new Date().toISOString().slice(0, 10),
          reason: reason.trim(),
          idempotencyKey: attemptKey,
          /* The counted figure ONLY. No expected quantity, no variance, no cost
           * and no account: the server decides every one of those. */
          lines: sheet.map((line) => ({ itemId: line.itemId, countedQuantity: line.counted })),
        });
        const moved = count.lines.filter((l) => l.varianceQuantity !== '0').length;
        setMsg({
          tone: 'success',
          text: moved === 0
            ? `${count.countNumber} recorded. Everything agreed with the books, so nothing was posted.`
            : `${count.countNumber} posted ${moved} variance(s) through the General Journal.`,
        });
        setSheet(null);
      } catch (error) {
        setMsg({
          tone: 'error',
          text: error instanceof Error ? error.message : 'The count could not be posted.',
        });
      } finally {
        setBusy(false);
      }
      return;
    }

    const res = postStockCount({
      date: new Date().toISOString().slice(0, 10), reference: '', warehouseId,
      lines: sheet.map((l) => ({
        id: l.id, itemId: l.itemId, warehouseId,
        systemQuantity: Number(l.systemQuantity),
        countedQuantity: Number(l.counted),
        frozenUnitCost: l.frozenUnitCost,
      })),
    });
    if (!res.ok) { setMsg({ tone: 'error', text: res.error ?? 'No variance to post.' }); return; }
    setMsg({ tone: 'success', text: 'Variances posted through the General Journal.' });
    setSheet(null);
  };

  const localRegister = useMemo(
    () => documents.filter((d) => d.kind === 'count').slice(-10).reverse(),
    [documents],
  );

  const variance = (line: CountLine): string => {
    const difference = Number(line.counted || '0') - Number(line.systemQuantity || '0');
    return Number.isFinite(difference) ? qty(difference) : '—';
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Stock Count</h2>
      {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}

      {serverBacked && countState === 'unavailable' && (
        <Alert variant="error">
          {countError ?? 'Stock counts could not be loaded from the server.'}
        </Alert>
      )}

      {serverBacked && countable.length === 0 && countState !== 'loading' && (
        <Alert variant="info">
          There are no stock-tracked items to count yet. Create an item with a base unit and an
          inventory account first.
        </Alert>
      )}

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div className="w-64">
          <label className="text-xs text-slate-500" htmlFor="count-warehouse">Warehouse</label>
          <Select
            id="count-warehouse"
            aria-label="Warehouse"
            options={warehouses}
            value={warehouseId}
            onChange={(e) => { setWarehouseId(e.target.value); setSheet(null); }}
          />
        </div>
        {serverBacked && (
          <div className="w-72">
            <label className="text-xs text-slate-500" htmlFor="count-reason">Reason</label>
            <Input
              id="count-reason"
              aria-label="Reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        )}
        <Button variant="outline" onClick={startCount} disabled={busy || !warehouseId}>
          {serverBacked ? 'Start count' : 'Start count (freeze)'}
        </Button>
        {sheet && (
          <Button onClick={() => { void post(); }} disabled={busy}>
            {busy ? 'Posting…' : 'Post variances'}
          </Button>
        )}
      </Card>

      {sheet && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
                <tr>
                  <th className="px-4 py-2 text-left">Item</th>
                  <th className="px-4 py-2 text-right">Books</th>
                  <th className="px-4 py-2 text-right">Counted</th>
                  <th className="px-4 py-2 text-right">Variance</th>
                  {!serverBacked && <th className="px-4 py-2 text-right">Cost</th>}
                </tr>
              </thead>
              <tbody>
                {sheet.map((line, index) => (
                  <tr key={line.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-4 py-2">{line.code}</td>
                    <td className="px-4 py-2 text-right text-slate-500">{line.systemQuantity}</td>
                    <td className="px-4 py-2 text-right">
                      <Input
                        type="number"
                        min="0"
                        aria-label={`Counted quantity for ${line.code}`}
                        className="h-8 w-24 text-right"
                        value={line.counted}
                        onChange={(e) => setSheet((f) => f!.map((x, i) => (
                          i === index ? { ...x, counted: e.target.value } : x
                        )))}
                      />
                    </td>
                    <td className="px-4 py-2 text-right font-medium">{variance(line)}</td>
                    {!serverBacked && (
                      <td className="px-4 py-2 text-right text-slate-500">
                        {money(line.frozenUnitCost)}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {serverBacked && (
            <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500 dark:border-slate-800">
              The books column is what the server held when this sheet opened. It is re-read at
              posting, and the variance is measured against that.
            </p>
          )}
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="border-b border-slate-200 px-4 py-2 text-xs font-semibold uppercase text-slate-500 dark:border-slate-800">
          Count register
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {serverBacked
                ? serverCounts.map((count) => (
                  <tr key={count.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-4 py-2 font-medium">{count.countNumber}</td>
                    <td className="px-4 py-2 text-slate-500">{count.countDate}</td>
                    <td className="px-4 py-2 text-slate-500">{count.warehouseCode}</td>
                    <td className="px-4 py-2 text-right text-slate-500">
                      {count.lines.filter((l) => l.varianceQuantity !== '0').length} variance(s)
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Badge tone={count.status === 'reversed' ? 'red' : 'green'}>
                        {count.status}
                      </Badge>
                    </td>
                  </tr>
                ))
                : localRegister.map((d) => (
                  <tr key={d.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-4 py-2 font-medium">{d.number}</td>
                    <td className="px-4 py-2 text-slate-500">{d.date}</td>
                    <td className="px-4 py-2 text-right">{money(d.total)}</td>
                    <td className="px-4 py-2 text-right">
                      <Badge tone={d.status === 'reversed' ? 'red' : 'green'}>{d.status}</Badge>
                    </td>
                  </tr>
                ))}
              {serverBacked && countState === 'loading' && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-400">Loading…</td></tr>
              )}
              {((serverBacked && countState === 'ready' && serverCounts.length === 0)
                || (!serverBacked && localRegister.length === 0)) && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-slate-400">No counts yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

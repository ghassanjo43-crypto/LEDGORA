/**
 * Shared inventory UI helpers: money formatting, item/warehouse option builders,
 * a derived-balances hook and the stock-movement ledger table. All derivations
 * happen in useMemo over stored arrays so selectors stay stable.
 */
import { useMemo } from 'react';
import { useInventoryStore } from '@/store/inventoryStore';
import { useStore } from '@/store/useStore';
import { useInventoryMasterData } from '@/services/inventory/useInventoryMasterData';
import { useStock } from '@/services/inventory/useStock';
import { useServerStock, inventoryIsServerAuthoritative } from '@/services/inventory/inventoryBackend';
import { useJournalStore } from '@/store/journalStore';
import { buildInventoryReconciliation } from '@/lib/inventoryReconciliation';
import { ENTITY } from '@/lib/inventorySeed';
import { getInventoryBalance, getSubledgerValue } from '@/lib/inventoryBalance';
import { ordered } from '@/lib/inventoryValuation';
import type { StockMovement } from '@/types/inventory';
import { roundToCompanyPrecision } from '@/lib/monetaryPrecision';
import { companyMonetaryDecimals } from '@/lib/monetaryPrecision';

export function money(n: number, currency?: string): string {
  const cur = currency ?? useStore.getState().settings.baseCurrency ?? 'USD';
  const d = companyMonetaryDecimals();
  return `${cur} ${(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

export function qty(n: number): string {
  return (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

/** Active (non-archived) item options. */
/**
 * The items a movement may name.
 *
 * Reads whichever register this workspace actually uses. A durable subscriber
 * offered browser items would be picking from a catalogue the server has never
 * seen, and every selection would end in a refusal — or worse, in a movement
 * against the wrong company's product.
 *
 * `entityId` is only meaningful in the browser model; server items carry an
 * empty one, so the filter applies to the demo engine alone.
 */
export function useItemOptions(onlyTracked = false) {
  const { items, serverBacked } = useInventoryMasterData();
  return useMemo(
    () =>
      items
        .filter((i) => (serverBacked || i.entityId === ENTITY)
          && i.status !== 'archived'
          && (!onlyTracked || (i.itemType !== 'service' && i.itemType !== 'non-inventory' && i.isInventoryTracked)))
        .map((i) => ({ value: i.id, label: `${i.code} — ${i.name}` })),
    [items, serverBacked, onlyTracked],
  );
}

export function useWarehouseOptions() {
  const { warehouses, serverBacked } = useInventoryMasterData();
  return useMemo(
    () => warehouses
      .filter((w) => (serverBacked || w.entityId === ENTITY) && w.status === 'active')
      .map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` })),
    [warehouses, serverBacked],
  );
}

/**
 * Per-item quantity, average cost and value.
 *
 * On server books these come from the LEDGER's own valuation, never from the
 * browser movement store — which still holds demo movements and would put a
 * quantity on screen that the books have never seen.
 */
export function useItemBalances() {
  const { items, serverBacked } = useInventoryMasterData();
  const movements = useInventoryStore((s) => s.movements);
  const valuation = useServerStock((s) => s.valuation);

  return useMemo(() => {
    if (serverBacked) {
      const byItem = new Map(valuation.map((row) => [row.itemId, row]));
      return items.map((item) => {
        const row = byItem.get(item.id);
        return {
          item,
          quantityOnHand: Number(row?.quantity ?? 0),
          reservedQuantity: 0,
          availableQuantity: Number(row?.quantity ?? 0),
          averageUnitCost: Number(row?.averageCost ?? 0),
          inventoryValue: Number(row?.value ?? 0),
        };
      });
    }
    return items.map((item) => ({
      item,
      ...getInventoryBalance(movements, { entityId: ENTITY, itemId: item.id }),
    }));
  }, [items, serverBacked, valuation, movements]);
}

export function useSubledgerValue(): number {
  const stock = useStock();
  const movements = useInventoryStore((s) => s.movements);
  return useMemo(
    () => (stock.serverBacked ? stock.totalValue : getSubledgerValue(movements, ENTITY)),
    [stock.serverBacked, stock.totalValue, movements],
  );
}

/** Movement ledger rows with running quantity + value per item. */
export interface LedgerRow {
  movement: StockMovement;
  runningQty: number;
  runningValue: number;
}

/**
 * The movement ledger, as rows with a running position.
 *
 * On server books this reads the SERVER's documents; the browser store is not
 * consulted at all. `StockMovementsPage` renders the server shape directly, so
 * this hook stays the demo engine's — and returns nothing on server books
 * rather than quietly showing another engine's history.
 */
export function useMovementLedger(filter?: { itemId?: string; warehouseId?: string }): LedgerRow[] {
  const movements = useInventoryStore((s) => s.movements);
  const serverBacked = inventoryIsServerAuthoritative();
  return useMemo(() => {
    if (serverBacked) return [];
    const sorted = ordered(movements.filter((m) => m.entityId === ENTITY && (!filter?.itemId || m.itemId === filter.itemId) && (!filter?.warehouseId || m.warehouseId === filter.warehouseId)));
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
      runVal.set(m.itemId, roundToCompanyPrecision((runVal.get(m.itemId) ?? 0) + dv));
      rows.push({ movement: m, runningQty: runQty.get(m.itemId)!, runningValue: runVal.get(m.itemId)! });
    }
    return rows.reverse();
  }, [movements, serverBacked, filter?.itemId, filter?.warehouseId]);
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

/* ══ Subledger-to-ledger reconciliation ═════════════════════════════════════ */

export interface ReconciliationView {
  serverBacked: boolean;
  /** Null when the server could not answer — never a browser figure instead. */
  balanced: boolean | null;
  /** Totals across every inventory control account. */
  subledgerValue: number;
  glBalance: number;
  difference: number;
  rows: Array<{
    accountId: string;
    label: string;
    subledgerValue: number;
    glBalance: number;
    difference: number;
  }>;
}

/**
 * Does the stock subledger agree with the general ledger?
 *
 * On server books BOTH sides are computed by the server from the same posted
 * figures, so the expected answer is exact equality and a difference means
 * something is genuinely wrong. Free Demo keeps the browser reconciliation over
 * its own movements and journal entries.
 */
export function useReconciliation(asOfDate?: string): ReconciliationView {
  const serverBacked = inventoryIsServerAuthoritative();
  const reconciliation = useServerStock((s) => s.reconciliation);
  const movements = useInventoryStore((s) => s.movements);
  const entries = useJournalStore((s) => s.entries);

  return useMemo(() => {
    if (serverBacked) {
      const rows = (reconciliation?.rows ?? []);
      const total = (pick: (row: typeof rows[number]) => string): number =>
        rows.reduce((sum, row) => sum + Number(pick(row)), 0);
      return {
        serverBacked: true,
        balanced: reconciliation?.balanced ?? null,
        subledgerValue: total((row) => row.subledgerValue),
        glBalance: total((row) => row.generalLedgerBalance),
        difference: total((row) => row.difference),
        rows: rows.map((row) => ({
          accountId: row.accountId,
          label: `${row.accountCode} — ${row.accountName}`,
          subledgerValue: Number(row.subledgerValue),
          glBalance: Number(row.generalLedgerBalance),
          difference: Number(row.difference),
        })),
      };
    }

    const local = buildInventoryReconciliation({
      entityId: ENTITY, movements, journalEntries: entries, asOfDate: asOfDate || undefined,
    });
    return {
      serverBacked: false,
      balanced: local.balanced,
      subledgerValue: local.subledgerValue,
      glBalance: local.glBalance,
      difference: local.difference,
      rows: local.byAccount.map((row) => ({
        accountId: row.accountId,
        label: row.accountId,
        subledgerValue: row.subledgerValue,
        glBalance: row.glBalance,
        difference: row.difference,
      })),
    };
  }, [serverBacked, reconciliation, movements, entries, asOfDate]);
}

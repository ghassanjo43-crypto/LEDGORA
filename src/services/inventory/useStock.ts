/**
 * The one place a screen asks what is in the warehouse.
 *
 * ══ A durable subscriber never sees a browser quantity ═══════════════════════
 *
 * This is the whole point of the hook. `inventoryStore` still holds movements
 * for Free Demo, and reading them on server books would put a number on screen
 * that the ledger has never seen — one a bookkeeper could act on, issuing stock
 * that is not there. So on server books the browser store is not consulted at
 * all, and when the server cannot answer the screen shows nothing and says so.
 */
import { useEffect, useMemo } from 'react';
import type { StockMovement } from '@/types/inventory';
import { useInventoryStore } from '@/store/inventoryStore';
import { getInventoryBalance } from '@/lib/inventoryBalance';
import { ENTITY } from '@/lib/inventorySeed';
import {
  useServerStock,
  inventoryIsServerAuthoritative,
  loadStockDocuments,
  loadStockPositions,
} from './inventoryBackend';

export interface StockPosition {
  itemId: string;
  itemCode: string;
  itemName: string;
  warehouseId: string;
  warehouseCode: string;
  baseUnitCode: string;
  quantity: number;
  value: number;
}

export interface StockView {
  /** True when these figures came from the server ledger. */
  serverBacked: boolean;
  loading: boolean;
  /** True when the server could not answer. Figures are EMPTY, never stale. */
  unavailable: boolean;
  positions: StockPosition[];
  totalValue: number;
  /** Whether the subledger agrees with the general ledger; null when unknown. */
  balanced: boolean | null;
  /** Browser movements a durable subscriber still has, counted not imported. */
  strandedMovements: number;
}

export function useStock(): StockView {
  const serverBacked = inventoryIsServerAuthoritative();
  const stock = useServerStock();
  const localMovements = useInventoryStore((s) => s.movements);
  const localItems = useInventoryStore((s) => s.items);
  const localWarehouses = useInventoryStore((s) => s.warehouses);

  useEffect(() => {
    if (serverBacked && stock.onHandState === 'idle') void loadStockPositions();
  }, [serverBacked, stock.onHandState]);

  const positions = useMemo<StockPosition[]>(() => {
    if (serverBacked) {
      return stock.onHand.map((row) => ({
        itemId: row.itemId,
        itemCode: row.itemCode,
        itemName: row.itemName,
        warehouseId: row.warehouseId,
        warehouseCode: row.warehouseCode,
        baseUnitCode: row.baseUnitCode,
        quantity: Number(row.quantity),
        value: Number(row.value),
      }));
    }

    /* Free Demo: derived from the browser movement ledger, as before. */
    const rows: StockPosition[] = [];
    for (const item of localItems) {
      for (const warehouse of localWarehouses) {
        const balance = getInventoryBalance(localMovements as StockMovement[], {
          entityId: ENTITY, itemId: item.id, warehouseId: warehouse.id,
        });
        if (balance.quantityOnHand === 0) continue;
        rows.push({
          itemId: item.id,
          itemCode: item.code,
          itemName: item.name,
          warehouseId: warehouse.id,
          warehouseCode: warehouse.code,
          baseUnitCode: '',
          quantity: balance.quantityOnHand,
          value: balance.inventoryValue,
        });
      }
    }
    return rows;
  }, [serverBacked, stock.onHand, localItems, localWarehouses, localMovements]);

  return {
    serverBacked,
    loading: serverBacked && stock.onHandState === 'loading',
    unavailable: serverBacked && stock.onHandState === 'unavailable',
    positions,
    totalValue: serverBacked
      ? stock.valuation.reduce((sum, row) => sum + Number(row.value), 0)
      : positions.reduce((sum, row) => sum + row.value, 0),
    balanced: serverBacked ? (stock.reconciliation?.balanced ?? null) : null,
    /*
     * A CENSUS, not a migration. Movements left in this browser cannot be
     * imported: the server would have to decide which account each posted
     * through, at what cost, on whose authority, and whether its journal
     * already exists. Every one of those would invent accounting.
     */
    strandedMovements: serverBacked ? localMovements.length : 0,
  };
}

/** The stock documents this company has posted. */
export function useStockDocuments(kind?: 'receipt' | 'issue' | 'transfer' | 'adjustment') {
  const serverBacked = inventoryIsServerAuthoritative();
  const stock = useServerStock();
  const localDocuments = useInventoryStore((s) => s.documents);

  useEffect(() => {
    if (serverBacked && stock.documentState === 'idle') void loadStockDocuments({ kind });
  }, [serverBacked, stock.documentState, kind]);

  return {
    serverBacked,
    loading: serverBacked && stock.documentState === 'loading',
    error: serverBacked ? stock.documentError : null,
    documents: serverBacked
      ? (kind ? stock.documents.filter((d) => d.kind === kind) : stock.documents)
      : [],
    localDocuments: serverBacked ? [] : localDocuments,
  };
}

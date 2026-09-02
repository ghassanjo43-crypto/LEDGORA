/**
 * The one place a screen asks what this company sells and where it keeps it.
 *
 * Durable subscribers get the server registers; Free Demo gets the local
 * `inventoryStore`. Screens do not branch on the engine themselves — a screen
 * that decided for itself is a screen that gets forgotten when the next domain
 * migrates.
 *
 * Server records are mapped into the `InventoryItem`, `Warehouse` and
 * `UnitOfMeasure` shapes every existing list, form and selector already
 * consumes. That mapping is what keeps this slice small: nothing downstream has
 * to learn a second item type, and the fields I1 does not hold are left at
 * their empty defaults rather than invented.
 */
import { useEffect, useMemo } from 'react';
import type { InventoryItem, UnitOfMeasure, Warehouse } from '@/types/inventory';
import type { ServerItem, ServerUnit, ServerWarehouse } from '@/services/api/inventoryApi';
import { useInventoryStore } from '@/store/inventoryStore';
import {
  useServerInventory,
  inventoryIsServerAuthoritative,
  loadInventoryMasterData,
} from './inventoryBackend';

/**
 * A server item as the existing screens expect to see it.
 *
 * ══ What is deliberately empty ═══════════════════════════════════════════════
 *
 * Categories, preferred suppliers, reorder points, lead times, manufacturing
 * hints and every warehouse default are absent because the server holds none of
 * them. A plausible-looking value here would be this mapper inventing master
 * data the server refused to record.
 *
 * Prices come back as exact decimal STRINGS and are converted to `number` only
 * here, at the edge, because the browser `InventoryItem` type has always used
 * numbers for them. They are defaults a form copies onto a line; no posted
 * figure is ever derived from them.
 */
export function toBrowserItem(item: ServerItem): InventoryItem {
  return {
    id: item.id,
    entityId: '',
    code: item.itemCode,
    name: item.name,
    nameSecondary: item.nameSecondary || undefined,
    description: item.description || undefined,
    gtin: item.barcode ?? undefined,
    itemType: item.itemType,
    baseUnitId: item.baseUnitId,
    isInventoryTracked: item.isInventoryTracked,
    isPurchasable: item.isPurchasable,
    isSellable: item.isSellable,
    /* No server concept: manufacturing has not migrated. */
    isManufacturable: false,
    trackingMode: item.trackingMode,
    valuationMethod: item.valuationMethod,
    standardCost: item.standardCost === null ? undefined : Number(item.standardCost),
    defaultSellingPrice:
      item.defaultSellingPrice === null ? undefined : Number(item.defaultSellingPrice),
    defaultPurchasePrice:
      item.defaultPurchasePrice === null ? undefined : Number(item.defaultPurchasePrice),
    salesDescription: item.salesDescription || undefined,
    purchaseDescription: item.purchaseDescription || undefined,
    salesTaxCodeId: item.salesTaxCodeId ?? undefined,
    purchaseTaxCodeId: item.purchaseTaxCodeId ?? undefined,
    inventoryAccountId: item.inventoryAccountId ?? undefined,
    costOfGoodsSoldAccountId: item.cogsAccountId ?? undefined,
    salesAccountId: item.salesAccountId ?? undefined,
    purchaseAccountId: item.purchaseAccountId ?? undefined,
    inventoryAdjustmentAccountId: item.inventoryAdjustmentAccountId ?? undefined,
    status: item.status,
    createdAt: item.createdAt ?? '',
    updatedAt: item.updatedAt ?? '',
  } as InventoryItem;
}

export function toBrowserWarehouse(warehouse: ServerWarehouse): Warehouse {
  return {
    id: warehouse.id,
    entityId: '',
    code: warehouse.code,
    name: warehouse.name,
    description: warehouse.description || undefined,
    type: warehouse.warehouseType as Warehouse['type'],
    location: warehouse.location || undefined,
    status: warehouse.status,
    createdAt: warehouse.createdAt ?? '',
    updatedAt: warehouse.updatedAt ?? '',
  } as Warehouse;
}

export function toBrowserUnit(unit: ServerUnit): UnitOfMeasure {
  return {
    id: unit.id,
    entityId: '',
    code: unit.code,
    name: unit.name,
    symbol: unit.symbol,
    category: unit.category as UnitOfMeasure['category'],
    decimalPlaces: unit.decimalPlaces,
    status: unit.status === 'archived' ? 'inactive' : unit.status,
  } as UnitOfMeasure;
}

export interface InventoryMasterDataView {
  items: InventoryItem[];
  warehouses: Warehouse[];
  units: UnitOfMeasure[];
  /** True when these came from the server rather than the browser. */
  serverBacked: boolean;
  loading: boolean;
  error: string | null;
  /** How many records remain in this browser but not in the books. */
  strandedItems: number;
  strandedWarehouses: number;
  strandedUnits: number;
  /** The server's own word: no conversion factor exists between units. */
  conversionsSupported: boolean;
}

export function useInventoryMasterData(): InventoryMasterDataView {
  const serverBacked = inventoryIsServerAuthoritative();
  const register = useServerInventory();
  const localItems = useInventoryStore((s) => s.items);
  const localWarehouses = useInventoryStore((s) => s.warehouses);
  const localUnits = useInventoryStore((s) => s.units);

  /* One load per mount for a durable workspace; the gateways re-read after
   * every write, so nothing else needs to ask. */
  useEffect(() => {
    if (serverBacked && register.itemState === 'idle') void loadInventoryMasterData();
  }, [serverBacked, register.itemState]);

  const items = useMemo(
    () => (serverBacked ? register.items.map(toBrowserItem) : localItems),
    [serverBacked, register.items, localItems],
  );
  const warehouses = useMemo(
    () => (serverBacked ? register.warehouses.map(toBrowserWarehouse) : localWarehouses),
    [serverBacked, register.warehouses, localWarehouses],
  );
  const units = useMemo(
    () => (serverBacked ? register.units.map(toBrowserUnit) : localUnits),
    [serverBacked, register.units, localUnits],
  );

  return {
    items,
    warehouses,
    units,
    serverBacked,
    loading: serverBacked
      && (register.itemState === 'loading' || register.warehouseState === 'loading'),
    error: serverBacked ? (register.itemError ?? register.warehouseError) : null,
    /*
     * A CENSUS, not a migration. Records left in this browser cannot be
     * imported automatically: the server would have to decide which account,
     * which tax code and which unit each one means, and those ids came from a
     * catalogue it never held. Every guess would invent master data.
     */
    strandedItems: serverBacked ? localItems.length : 0,
    strandedWarehouses: serverBacked ? localWarehouses.length : 0,
    strandedUnits: serverBacked ? localUnits.length : 0,
    conversionsSupported: serverBacked ? register.conversionsSupported : false,
  };
}

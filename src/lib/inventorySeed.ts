/**
 * Edition-specific inventory seed. Provides sensible starting master data so the
 * module is immediately usable; the super administrator / user edits everything
 * afterwards. Seeds carry stable ids for deterministic tests.
 *
 * Phase 1 inventory is single-entity — everything is stamped with ENTITY.
 */
import type { LedgoraEdition } from '@/types/entitlements';
import type {
  InventoryItem,
  InventorySettings,
  ItemCategory,
  UnitOfMeasure,
  Warehouse,
} from '@/types/inventory';

export const ENTITY = 'primary';

const now = '2026-01-01T00:00:00.000Z';

export function makeSeedUnits(): UnitOfMeasure[] {
  const u = (id: string, code: string, name: string, symbol: string, category: UnitOfMeasure['category'], dp = 0): UnitOfMeasure => ({
    id, entityId: ENTITY, code, name, symbol, category, decimalPlaces: dp, status: 'active',
  });
  return [
    u('uom_ea', 'EA', 'Each', 'ea', 'quantity', 0),
    u('uom_box', 'BOX', 'Box', 'box', 'quantity', 0),
    u('uom_kg', 'KG', 'Kilogram', 'kg', 'weight', 3),
    u('uom_g', 'G', 'Gram', 'g', 'weight', 0),
    u('uom_l', 'L', 'Litre', 'L', 'volume', 3),
    u('uom_m', 'M', 'Metre', 'm', 'length', 2),
    u('uom_m2', 'M2', 'Square metre', 'm²', 'area', 2),
    u('uom_m3', 'M3', 'Cubic metre', 'm³', 'volume', 2),
    u('uom_hour', 'HOUR', 'Hour', 'h', 'time', 2),
  ];
}

export function makeSeedCategories(): ItemCategory[] {
  return [
    { id: 'cat_goods', entityId: ENTITY, code: 'GOODS', name: 'Goods for resale', status: 'active' },
    { id: 'cat_raw', entityId: ENTITY, code: 'RAW', name: 'Raw materials', status: 'active' },
    { id: 'cat_fg', entityId: ENTITY, code: 'FG', name: 'Finished goods', status: 'active' },
  ];
}

function item(partial: Partial<InventoryItem> & Pick<InventoryItem, 'id' | 'code' | 'name' | 'itemType'>): InventoryItem {
  return {
    entityId: ENTITY,
    baseUnitId: 'uom_ea',
    isInventoryTracked: true,
    isPurchasable: true,
    isSellable: true,
    isManufacturable: false,
    trackingMode: 'none',
    valuationMethod: 'weighted-average',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

function warehouse(id: string, code: string, name: string, type: Warehouse['type']): Warehouse {
  return { id, entityId: ENTITY, code, name, type, status: 'active', createdAt: now, updatedAt: now };
}

export function makeSeedSettings(): InventorySettings {
  return {
    entityId: ENTITY,
    enabled: true,
    defaultValuationMethod: 'weighted-average',
    negativeStockPolicy: 'block',
    salesRecognitionMode: 'on-invoice',
    purchaseRecognitionMode: 'on-bill',
    useGrni: false,
  };
}

export interface InventorySeed {
  units: UnitOfMeasure[];
  categories: ItemCategory[];
  items: InventoryItem[];
  warehouses: Warehouse[];
  settings: InventorySettings;
}

/** Build the seed appropriate to the organization's edition. */
export function makeInventorySeed(edition: LedgoraEdition): InventorySeed {
  const base: InventorySeed = {
    units: makeSeedUnits(),
    categories: makeSeedCategories(),
    settings: makeSeedSettings(),
    items: [item({ id: 'item_goods', code: 'GOODS-001', name: 'Trading goods', itemType: 'inventory', categoryId: 'cat_goods' })],
    warehouses: [warehouse('wh_main', 'MAIN', 'Main warehouse', 'main')],
  };

  if (edition === 'manufacturing') {
    base.items.push(
      item({ id: 'item_rm', code: 'RM-001', name: 'Steel sheet', itemType: 'raw-material', categoryId: 'cat_raw', baseUnitId: 'uom_kg', isSellable: false }),
      item({ id: 'item_fg', code: 'FG-100', name: 'Finished widget', itemType: 'finished-good', categoryId: 'cat_fg', isPurchasable: false, isManufacturable: true }),
    );
    base.warehouses.push(
      warehouse('wh_raw', 'RAW', 'Raw material store', 'raw-material'),
      warehouse('wh_fg', 'FG', 'Finished goods store', 'finished-goods'),
    );
  } else if (edition === 'construction') {
    base.items.push(item({ id: 'item_mat', code: 'MAT-001', name: 'Cement bags', itemType: 'consumable', categoryId: 'cat_raw', baseUnitId: 'uom_box', isSellable: false }));
    base.warehouses.push(warehouse('wh_site', 'SITE-A', 'Site A store', 'site'));
  }

  return base;
}

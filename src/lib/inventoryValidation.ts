/**
 * Inventory validation. Pure predicate helpers shared by the store actions,
 * posting orchestration and UI so a rule is enforced in exactly one place.
 */
import type { Account } from '@/types';
import type {
  InventoryItem,
  InventorySettings,
  NegativeStockPolicy,
  StockMovement,
  Warehouse,
} from '@/types/inventory';
import { getQuantityOnHand } from './inventoryBalance';
import { resolveAccount } from './inventoryAccounts';

export interface ValidationResult {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
}

const OK: ValidationResult = { ok: true };

/** True when an item is stock-tracked (drives whether movements are created). */
export function isStockTracked(item: Pick<InventoryItem, 'itemType' | 'isInventoryTracked'>): boolean {
  if (item.itemType === 'service' || item.itemType === 'non-inventory') return false;
  return item.isInventoryTracked;
}

export function validateInventoryItem(
  item: Pick<InventoryItem, 'id' | 'code' | 'name' | 'baseUnitId'>,
  existing: InventoryItem[],
): ValidationResult {
  const fieldErrors: Record<string, string> = {};
  if (!item.code.trim()) fieldErrors.code = 'Item code is required.';
  if (!item.name.trim()) fieldErrors.name = 'Item name is required.';
  if (!item.baseUnitId) fieldErrors.baseUnitId = 'A base unit is required.';
  if (existing.some((i) => i.id !== item.id && i.code.trim().toLowerCase() === item.code.trim().toLowerCase())) {
    fieldErrors.code = `Item code "${item.code}" already exists.`;
  }
  return Object.keys(fieldErrors).length ? { ok: false, error: 'Please fix the highlighted fields.', fieldErrors } : OK;
}

/** A stock-tracked item must resolve an inventory account and, if sellable, COGS. */
export function validateInventoryAccountMappings(
  item: InventoryItem,
  accounts: Account[],
  ctx: { category?: import('@/types/inventory').ItemCategory; settings?: InventorySettings } = {},
): ValidationResult {
  if (!isStockTracked(item)) return OK;
  const inv = resolveAccount('inventory', { accounts, item, ...ctx });
  if (!inv) return { ok: false, error: `Item "${item.code}" has no inventory account and none could be resolved.` };
  if (item.isSellable) {
    const cogs = resolveAccount('cogs', { accounts, item, ...ctx });
    if (!cogs) return { ok: false, error: `Sellable item "${item.code}" has no cost-of-goods-sold account.` };
  }
  return OK;
}

export function validateWarehouse(
  wh: Pick<Warehouse, 'id' | 'code' | 'name'>,
  existing: Warehouse[],
): ValidationResult {
  const fieldErrors: Record<string, string> = {};
  if (!wh.code.trim()) fieldErrors.code = 'Warehouse code is required.';
  if (!wh.name.trim()) fieldErrors.name = 'Warehouse name is required.';
  if (existing.some((w) => w.id !== wh.id && w.code.trim().toLowerCase() === wh.code.trim().toLowerCase())) {
    fieldErrors.code = `Warehouse code "${wh.code}" already exists.`;
  }
  return Object.keys(fieldErrors).length ? { ok: false, error: 'Please fix the highlighted fields.', fieldErrors } : OK;
}

export function effectiveNegativePolicy(
  settings: Pick<InventorySettings, 'negativeStockPolicy'>,
  warehouse?: Pick<Warehouse, 'allowNegativeStock'>,
  item?: Pick<InventoryItem, 'allowNegativeStock'>,
): NegativeStockPolicy {
  if (warehouse?.allowNegativeStock || item?.allowNegativeStock) return 'allow';
  return settings.negativeStockPolicy;
}

/**
 * Ensure an outbound quantity is permitted given the negative-stock policy.
 * Under `block`, on-hand at the issuing warehouse must cover the quantity.
 */
export function validateAvailableStock(input: {
  movements: StockMovement[];
  entityId: string;
  itemId: string;
  warehouseId: string;
  quantity: number;
  policy: NegativeStockPolicy;
}): ValidationResult {
  if (input.quantity <= 0) return { ok: false, error: 'Quantity must be greater than zero.' };
  if (input.policy === 'allow') return OK;
  const onHand = getQuantityOnHand(input.movements, {
    entityId: input.entityId,
    itemId: input.itemId,
    warehouseId: input.warehouseId,
  });
  if (input.quantity > onHand + 1e-9) {
    if (input.policy === 'block') {
      return { ok: false, error: `Insufficient stock: ${onHand} available, ${input.quantity} requested.` };
    }
    // 'warn' still permits posting (surfaced to the UI, not blocked here).
  }
  return OK;
}

/** Changing valuation method is blocked once movements exist for the item. */
export function canChangeValuationMethod(itemId: string, movements: StockMovement[]): boolean {
  return !movements.some((m) => m.itemId === itemId && m.status !== 'reversed');
}

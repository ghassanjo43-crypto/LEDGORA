/**
 * Item and warehouse writes: the server for a durable subscriber, the local
 * store for Free Demo, and never both.
 *
 * ══ Why the screens call this and not a store ════════════════════════════════
 *
 * The same seam the Purchasing cutover established. A page that branched on the
 * engine itself would be a page somebody forgets when the next domain migrates,
 * and the failure mode is silent: a durable subscriber's catalogue written into
 * browser storage looks saved and is not.
 *
 * ══ What the durable path deliberately drops ═════════════════════════════════
 *
 * `toItemWriteInput` copies the code, barcode, names, description, type,
 * tracking, base unit, prices, tax codes and account mappings. It does not copy
 * categories, preferred suppliers, reorder points, safety stock, lead times,
 * default warehouses, batch sizes or any manufacturing hint — not because it is
 * careful, but because they are not in the object it builds. A durable item
 * therefore cannot carry a field the server refuses, even if a form is later
 * given one by mistake.
 *
 * ══ There is no delete ═══════════════════════════════════════════════════════
 *
 * Items and warehouses are archived. A document that has already been issued
 * names its item, and removing the row would leave that document pointing at
 * nothing. The absence of a delete here is the refusal expressed as a shape.
 */
import type { InventoryItem, Warehouse } from '@/types/inventory';
import type { ItemWriteInput, WarehouseWriteInput } from '@/services/api/inventoryApi';
import { useInventoryStore } from '@/store/inventoryStore';
import {
  itemGateway,
  warehouseGateway,
  inventoryIsServerAuthoritative,
  serverItemById,
  serverWarehouseById,
  stockGateway,
} from './inventoryBackend';

export interface InventoryActionResult {
  ok: boolean;
  error?: string;
  id?: string;
  /** True when the server refused because somebody else edited first. */
  conflict?: boolean;
  /** True when a code or barcode is already taken. */
  duplicate?: boolean;
  fieldErrors?: Record<string, string>;
}

const GONE = 'That record is no longer in these books. Reload and try again.';

/**
 * The server's own words, kept.
 *
 * A duplicate code, a stale version, a wrong-direction tax code and an
 * ineligible account say different things, and a generic message would hide
 * which. The only interpretation added is a flag for the two cases a screen
 * must react to differently.
 */
function asResult(cause: unknown): InventoryActionResult {
  const message = cause instanceof Error ? cause.message : 'Could not save this record.';
  const details = (cause as { details?: { fieldErrors?: Record<string, string> } })?.details;
  return {
    ok: false,
    error: message,
    conflict: /changed by another user|reload/i.test(message),
    duplicate: /already used/i.test(message),
    fieldErrors: details?.fieldErrors,
  };
}

/** What the screen collects, in the browser's own shape. */
export type ItemDraft = Partial<InventoryItem> & Pick<InventoryItem, 'code' | 'name' | 'itemType' | 'baseUnitId'>;
export type WarehouseDraft = Partial<Warehouse> & Pick<Warehouse, 'code' | 'name'>;

/**
 * A browser number to an exact decimal string, or nothing.
 *
 * Fixed notation, never exponential: `1e-7` is not a decimal the server
 * accepts, and `toString()` produces one for small numbers.
 */
const DECIMAL = (value: number | undefined | null): string | null => {
  if (value === undefined || value === null || Number.isNaN(value)) return null;
  return Number(value).toFixed(10).replace(/0+$/, '').replace(/\.$/, '') || '0';
};

export function toItemWriteInput(draft: ItemDraft): ItemWriteInput {
  return {
    itemCode: draft.code,
    barcode: draft.gtin?.trim() ? draft.gtin.trim() : null,
    name: draft.name,
    nameSecondary: draft.nameSecondary,
    description: draft.description,
    itemType: draft.itemType,
    /* The server refuses a tracked service outright; sending the honest value
     * lets it say so rather than having the browser quietly correct it. */
    isInventoryTracked: Boolean(draft.isInventoryTracked),
    isPurchasable: draft.isPurchasable ?? true,
    isSellable: draft.isSellable ?? true,
    trackingMode: draft.trackingMode ?? 'none',
    valuationMethod: draft.valuationMethod ?? 'weighted-average',
    baseUnitId: draft.baseUnitId,
    defaultSellingPrice: DECIMAL(draft.defaultSellingPrice),
    defaultPurchasePrice: DECIMAL(draft.defaultPurchasePrice),
    standardCost: DECIMAL(draft.standardCost),
    salesDescription: draft.salesDescription,
    purchaseDescription: draft.purchaseDescription,
    salesTaxCodeId: draft.salesTaxCodeId ?? null,
    purchaseTaxCodeId: draft.purchaseTaxCodeId ?? null,
    inventoryAccountId: draft.inventoryAccountId ?? null,
    cogsAccountId: draft.costOfGoodsSoldAccountId ?? null,
    salesAccountId: draft.salesAccountId ?? null,
    purchaseAccountId: draft.purchaseAccountId ?? null,
    inventoryAdjustmentAccountId: draft.inventoryAdjustmentAccountId ?? null,
  };
}

export function toWarehouseWriteInput(draft: WarehouseDraft): WarehouseWriteInput {
  return {
    code: draft.code,
    name: draft.name,
    description: draft.description,
    warehouseType: draft.type ?? 'main',
    location: draft.location,
  };
}

export interface InventoryActions {
  /** True when these actions go to the server. */
  serverBacked: boolean;
  saveItem: (draft: ItemDraft) => Promise<InventoryActionResult>;
  setItemArchived: (id: string, archived: boolean) => Promise<InventoryActionResult>;
  saveWarehouse: (draft: WarehouseDraft) => Promise<InventoryActionResult>;
  setWarehouseArchived: (id: string, archived: boolean) => Promise<InventoryActionResult>;
  /** False in durable mode: categories have no server register yet. */
  canEditCategories: boolean;
}

export function inventoryActions(): InventoryActions {
  if (!inventoryIsServerAuthoritative()) {
    /* Free Demo: the local store, exactly as before this slice. */
    const store = useInventoryStore.getState();
    return {
      serverBacked: false,
      saveItem: async (draft) => store.saveItem(draft as InventoryItem),
      setItemArchived: async (id, archived) =>
        (archived
          ? store.archiveItem(id)
          : store.saveItem({ ...store.items.find((i) => i.id === id)!, status: 'active' })),
      saveWarehouse: async (draft) => store.saveWarehouse(draft as Warehouse),
      setWarehouseArchived: async (id, archived) => {
        const warehouse = store.warehouses.find((w) => w.id === id);
        if (!warehouse) return { ok: false, error: GONE };
        return store.saveWarehouse({ ...warehouse, status: archived ? 'archived' : 'active' });
      },
      canEditCategories: true,
    };
  }

  return {
    serverBacked: true,

    /*
     * Create or update, chosen by whether the SERVER already holds the id. A
     * draft carrying an id the register does not have is a new record — which
     * is what a blank form produces — rather than an edit of something missing.
     */
    saveItem: async (draft) => {
      const existing = draft.id ? serverItemById(draft.id) : undefined;
      try {
        const saved = existing
          ? await itemGateway.update(existing.id, existing.version, toItemWriteInput(draft))
          : await itemGateway.create(toItemWriteInput(draft));
        return { ok: true, id: saved.id };
      } catch (cause) {
        return asResult(cause);
      }
    },

    /*
     * The version comes from the cached SERVER row, not from the form. A form
     * that carried its own version would happily send back the one it was
     * opened with after somebody else had saved, which is the merge this
     * refuses.
     */
    setItemArchived: async (id, archived) => {
      const current = serverItemById(id);
      if (!current) return { ok: false, error: GONE };
      try {
        const changed = await itemGateway.setArchived(id, current.version, archived);
        return { ok: true, id: changed.id };
      } catch (cause) {
        return asResult(cause);
      }
    },

    saveWarehouse: async (draft) => {
      const existing = draft.id ? serverWarehouseById(draft.id) : undefined;
      try {
        const saved = existing
          ? await warehouseGateway.update(
            existing.id, existing.version, toWarehouseWriteInput(draft),
          )
          : await warehouseGateway.create(toWarehouseWriteInput(draft));
        return { ok: true, id: saved.id };
      } catch (cause) {
        return asResult(cause);
      }
    },

    setWarehouseArchived: async (id, archived) => {
      const current = serverWarehouseById(id);
      if (!current) return { ok: false, error: GONE };
      try {
        const changed = await warehouseGateway.setArchived(id, current.version, archived);
        return { ok: true, id: changed.id };
      } catch (cause) {
        return asResult(cause);
      }
    },

    canEditCategories: false,
  };
}

/* ══ I2 — posting and reversing stock ══════════════════════════════════════ */

export interface StockActionResult extends InventoryActionResult {
  documentNumber?: string;
  /** False when an idempotent retry found the document it had already made. */
  created?: boolean;
}

export interface StockDocumentDraft {
  kind: 'receipt' | 'issue' | 'transfer' | 'adjustment';
  movementDate: string;
  reference?: string;
  memo?: string;
  reason?: string;
  sourceWarehouseId?: string;
  destinationWarehouseId?: string;
  lines: Array<{
    itemId: string;
    warehouseId?: string;
    /** An exact decimal STRING. Never a browser number. */
    quantity: string;
    unitCost?: string | null;
    expenseAccountId?: string | null;
    direction?: 'in' | 'out';
  }>;
}

export interface StockActions {
  serverBacked: boolean;
  /**
   * Post one stock document.
   *
   * `idempotencyKey` belongs to the ATTEMPT, not to the call: a retry of the
   * same attempt must send the same key, which is why the caller mints it and
   * this does not.
   */
  post: (draft: StockDocumentDraft, idempotencyKey: string) => Promise<StockActionResult>;
  reverse: (id: string, expectedVersion: number, reason: string) => Promise<StockActionResult>;
  /** False in durable mode: neither has a server workflow. See the constants. */
  canCount: boolean;
  canOpenBalances: boolean;
}

export function stockActions(): StockActions {
  if (!inventoryIsServerAuthoritative()) {
    /*
     * Free Demo keeps the browser posting engine untouched. It is reached
     * through the store's own document actions, which the demo pages already
     * call — this seam exists so a DURABLE screen never has to know that.
     */
    return {
      serverBacked: false,
      post: async () => ({
        ok: false,
        error: 'Free Demo posts stock through the browser engine, not this gateway.',
      }),
      reverse: async () => ({
        ok: false,
        error: 'Free Demo reverses stock through the browser engine, not this gateway.',
      }),
      canCount: true,
      canOpenBalances: true,
    };
  }

  return {
    serverBacked: true,

    post: async (draft, idempotencyKey) => {
      try {
        const { document, created } = await stockGateway.post({ ...draft, idempotencyKey });
        return {
          ok: true, id: document.id, documentNumber: document.documentNumber, created,
        };
      } catch (cause) {
        return asResult(cause);
      }
    },

    reverse: async (id, expectedVersion, reason) => {
      try {
        const reversed = await stockGateway.reverse(id, expectedVersion, reason);
        return { ok: true, id: reversed.id, documentNumber: reversed.documentNumber };
      } catch (cause) {
        return asResult(cause);
      }
    },

    canCount: false,
    canOpenBalances: false,
  };
}

/**
 * Where the item, unit and warehouse registers actually live.
 *
 * ══ Two engines, and only two ════════════════════════════════════════════════
 *
 * A durable subscriber's catalogue is on the server; Free Demo keeps the local
 * `inventoryStore`, which is disposable by design. One workspace cannot split
 * its books from its catalogue, so the verdict comes from `booksEngine` and
 * nothing here decides it independently.
 *
 * ══ Why there is no quantity in this file ════════════════════════════════════
 *
 * I1 is master data. There is no balance to cache, no valuation to hold and no
 * movement to replay — those arrive with the movement ledger. A cache of a
 * quantity would be the first of the two answers this architecture exists to
 * avoid having.
 *
 * ══ Why writes re-read ═══════════════════════════════════════════════════════
 *
 * Every write goes to the server and then re-lists, rather than patching the
 * cache with what was sent. The server bumps the version, trims the strings and
 * may normalise a decimal; echoing the request would leave the screen
 * disagreeing with the register on the very next save.
 */
import { create } from 'zustand';
import { booksEngine } from '@/services/books/booksEngine';
import { booksGeneration, isCurrentGeneration } from '@/services/books/booksGenerationCounter';
import {
  itemsApi,
  warehousesApi,
  unitsApi,
  type ServerItem,
  type ServerUnit,
  type ServerWarehouse,
  type ItemWriteInput,
  type WarehouseWriteInput,
} from '@/services/api/inventoryApi';

export type InventoryBackend = 'browser' | 'server';

export function inventoryBackend(): InventoryBackend {
  return booksEngine() === 'server' ? 'server' : 'browser';
}

export function inventoryIsServerAuthoritative(): boolean {
  return inventoryBackend() === 'server';
}

export type RegisterState = 'idle' | 'loading' | 'ready' | 'unavailable';

interface InventoryStoreShape {
  itemState: RegisterState;
  items: ServerItem[];
  itemError: string | null;
  itemSearch: string;

  warehouseState: RegisterState;
  warehouses: ServerWarehouse[];
  warehouseError: string | null;
  warehouseSearch: string;

  units: ServerUnit[];
  unitState: RegisterState;
  /** The server's own word on conversions. Never assumed by a screen. */
  conversionsSupported: boolean;
  conversionNote: string;
}

export const useServerInventory = create<InventoryStoreShape>(() => ({
  itemState: 'idle',
  items: [],
  itemError: null,
  itemSearch: '',
  warehouseState: 'idle',
  warehouses: [],
  warehouseError: null,
  warehouseSearch: '',
  units: [],
  unitState: 'idle',
  conversionsSupported: false,
  conversionNote: '',
}));

/**
 * Empty every register, synchronously.
 *
 * Called on a company change BEFORE anything is fetched: a bookkeeper spending
 * the loading interval looking at the previous company's catalogue is how
 * somebody prices the wrong product.
 */
export function clearInventoryCache(): void {
  useServerInventory.setState({
    itemState: 'idle', items: [], itemError: null, itemSearch: '',
    warehouseState: 'idle', warehouses: [], warehouseError: null, warehouseSearch: '',
    units: [], unitState: 'idle', conversionsSupported: false, conversionNote: '',
  });
}

/**
 * A response is applied only if the books generation that issued it is still
 * current — the company can change at any await, and a late answer would list
 * one company's catalogue under another company's name.
 */
export async function loadItems(options: { search?: string } = {}): Promise<void> {
  if (!inventoryIsServerAuthoritative()) return;

  const generation = booksGeneration();
  const search = options.search ?? '';
  useServerInventory.setState({ itemState: 'loading', itemError: null, itemSearch: search });

  try {
    const items = await itemsApi.list({ search: search || undefined, limit: 200 });
    if (!isCurrentGeneration(generation)) return;
    useServerInventory.setState({ itemState: 'ready', items, itemError: null, itemSearch: search });
  } catch (cause) {
    if (!isCurrentGeneration(generation)) return;
    useServerInventory.setState({
      itemState: 'unavailable',
      itemError: cause instanceof Error ? cause.message : 'Could not load the item catalogue.',
    });
  }
}

export async function loadWarehouses(options: { search?: string } = {}): Promise<void> {
  if (!inventoryIsServerAuthoritative()) return;

  const generation = booksGeneration();
  const search = options.search ?? '';
  useServerInventory.setState({
    warehouseState: 'loading', warehouseError: null, warehouseSearch: search,
  });

  try {
    const warehouses = await warehousesApi.list({ search: search || undefined, limit: 200 });
    if (!isCurrentGeneration(generation)) return;
    useServerInventory.setState({
      warehouseState: 'ready', warehouses, warehouseError: null, warehouseSearch: search,
    });
  } catch (cause) {
    if (!isCurrentGeneration(generation)) return;
    useServerInventory.setState({
      warehouseState: 'unavailable',
      warehouseError: cause instanceof Error ? cause.message : 'Could not load warehouses.',
    });
  }
}

export async function loadUnits(): Promise<void> {
  if (!inventoryIsServerAuthoritative()) return;

  const generation = booksGeneration();
  useServerInventory.setState({ unitState: 'loading' });

  try {
    const answer = await unitsApi.list();
    if (!isCurrentGeneration(generation)) return;
    useServerInventory.setState({
      unitState: 'ready',
      units: answer.units,
      conversionsSupported: answer.conversionsSupported,
      conversionNote: answer.note,
    });
  } catch {
    if (!isCurrentGeneration(generation)) return;
    useServerInventory.setState({ unitState: 'unavailable' });
  }
}

/** Everything a durable Items or Warehouses screen needs, in one call. */
export async function loadInventoryMasterData(): Promise<void> {
  if (!inventoryIsServerAuthoritative()) return;
  await Promise.all([loadUnits(), loadItems(), loadWarehouses()]);
}

export const itemGateway = {
  create: async (input: ItemWriteInput): Promise<ServerItem> => {
    const created = await itemsApi.create(input);
    await loadItems({ search: useServerInventory.getState().itemSearch });
    return created;
  },

  update: async (
    id: string, expectedVersion: number, input: ItemWriteInput,
  ): Promise<ServerItem> => {
    const updated = await itemsApi.update(id, expectedVersion, input);
    await loadItems({ search: useServerInventory.getState().itemSearch });
    return updated;
  },

  setArchived: async (
    id: string, expectedVersion: number, archived: boolean,
  ): Promise<ServerItem> => {
    const changed = await itemsApi.setArchived(id, expectedVersion, archived);
    await loadItems({ search: useServerInventory.getState().itemSearch });
    return changed;
  },
};

export const warehouseGateway = {
  create: async (input: WarehouseWriteInput): Promise<ServerWarehouse> => {
    const created = await warehousesApi.create(input);
    await loadWarehouses({ search: useServerInventory.getState().warehouseSearch });
    return created;
  },

  update: async (
    id: string, expectedVersion: number, input: WarehouseWriteInput,
  ): Promise<ServerWarehouse> => {
    const updated = await warehousesApi.update(id, expectedVersion, input);
    await loadWarehouses({ search: useServerInventory.getState().warehouseSearch });
    return updated;
  },

  setArchived: async (
    id: string, expectedVersion: number, archived: boolean,
  ): Promise<ServerWarehouse> => {
    const changed = await warehousesApi.setArchived(id, expectedVersion, archived);
    await loadWarehouses({ search: useServerInventory.getState().warehouseSearch });
    return changed;
  },
};

export function serverItemById(id: string): ServerItem | undefined {
  return useServerInventory.getState().items.find((item) => item.id === id);
}

export function serverWarehouseById(id: string): ServerWarehouse | undefined {
  return useServerInventory.getState().warehouses.find((warehouse) => warehouse.id === id);
}

/* ── What I1 deliberately does not offer ──────────────────────────────────── */

export const STOCK_UNSUPPORTED =
  'Stock quantities are not available yet. This slice records what the business buys and sells — '
  + 'the items, the units and the warehouses — and nothing about how much of anything is on hand. '
  + 'Receipts, issues, transfers, adjustments and valuation arrive with the movement ledger.';

export const CATEGORIES_UNSUPPORTED =
  'Item categories are not held on the server yet. They carry account defaults that sit between an '
  + 'item and the company profile, and nothing posts through that chain until stock moves — so the '
  + 'layer arrives with the movements that need it.';

export const IMPORT_REQUIRED =
  'Items in this browser cannot be imported automatically. The server would have to decide which '
  + 'account, which tax code and which unit each one means, and those ids came from a catalogue it '
  + 'never held. Re-enter the ones you still need; nothing here has been deleted.';

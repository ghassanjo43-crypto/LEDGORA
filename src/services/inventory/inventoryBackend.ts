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
  stockApi,
  type ServerStockDocument,
  type StockDocumentInput,
  type StockDocumentKind,
  type StockOnHandRow,
  type ValuationRow,
  type ReconciliationRow,
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

/* ══ I2 — the movement ledger, on the server ════════════════════════════════
 *
 * There is no browser fallback here on purpose. A durable subscriber whose
 * quantities came from `inventoryStore` would be reading a number the books
 * have never seen, and the moment they acted on it — issuing stock that is not
 * there, or trusting a valuation — the mistake would already be in the ledger.
 * When the server cannot answer, these read EMPTY and the screen says so.
 */

interface StockStoreShape {
  documentState: RegisterState;
  documents: ServerStockDocument[];
  documentError: string | null;

  onHandState: RegisterState;
  onHand: StockOnHandRow[];

  valuationState: RegisterState;
  valuation: ValuationRow[];
  valuationTotal: string;

  reconciliation: { rows: ReconciliationRow[]; balanced: boolean } | null;
}

export const useServerStock = create<StockStoreShape>(() => ({
  documentState: 'idle',
  documents: [],
  documentError: null,
  onHandState: 'idle',
  onHand: [],
  valuationState: 'idle',
  valuation: [],
  valuationTotal: '0',
  reconciliation: null,
}));

export function clearStockCache(): void {
  useServerStock.setState({
    documentState: 'idle', documents: [], documentError: null,
    onHandState: 'idle', onHand: [],
    valuationState: 'idle', valuation: [], valuationTotal: '0',
    reconciliation: null,
  });
}

export async function loadStockDocuments(
  options: { kind?: StockDocumentKind } = {},
): Promise<void> {
  if (!inventoryIsServerAuthoritative()) return;
  const generation = booksGeneration();
  useServerStock.setState({ documentState: 'loading', documentError: null });
  try {
    const documents = await stockApi.listDocuments({ kind: options.kind, limit: 100 });
    if (!isCurrentGeneration(generation)) return;
    useServerStock.setState({ documentState: 'ready', documents, documentError: null });
  } catch (cause) {
    if (!isCurrentGeneration(generation)) return;
    useServerStock.setState({
      documentState: 'unavailable',
      documents: [],
      documentError: cause instanceof Error ? cause.message : 'Could not load stock documents.',
    });
  }
}

export async function loadStockPositions(): Promise<void> {
  if (!inventoryIsServerAuthoritative()) return;
  const generation = booksGeneration();
  useServerStock.setState({ onHandState: 'loading', valuationState: 'loading' });
  try {
    const [onHand, valuation, reconciliation] = await Promise.all([
      stockApi.stockOnHand(),
      stockApi.valuation(),
      stockApi.reconciliation(),
    ]);
    if (!isCurrentGeneration(generation)) return;
    useServerStock.setState({
      onHandState: 'ready',
      onHand,
      valuationState: 'ready',
      valuation: valuation.rows,
      valuationTotal: valuation.totalValue,
      reconciliation: { rows: reconciliation.rows, balanced: reconciliation.balanced },
    });
  } catch {
    if (!isCurrentGeneration(generation)) return;
    /* Empty, never stale and never a browser figure. */
    useServerStock.setState({
      onHandState: 'unavailable', onHand: [],
      valuationState: 'unavailable', valuation: [], valuationTotal: '0',
      reconciliation: null,
    });
  }
}

export const stockGateway = {
  post: async (
    input: StockDocumentInput,
  ): Promise<{ document: ServerStockDocument; created: boolean }> => {
    const answer = await stockApi.post(input);
    await Promise.all([loadStockDocuments(), loadStockPositions()]);
    return answer;
  },

  reverse: async (
    id: string, expectedVersion: number, reason: string,
  ): Promise<ServerStockDocument> => {
    const reversed = await stockApi.reverse(id, expectedVersion, reason);
    await Promise.all([loadStockDocuments(), loadStockPositions()]);
    return reversed;
  },

  stockCard: (itemId: string) => stockApi.stockCard(itemId),
};

/**
 * A fresh idempotency key for one attempt at one document.
 *
 * Minted where the user presses the button, not inside the gateway: a retry of
 * the SAME attempt must carry the SAME key, and a gateway that generated one
 * per call would make every retry a new document — which is the failure the key
 * exists to prevent.
 */
export function newIdempotencyKey(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export const COUNTS_UNSUPPORTED =
  'Stock counts are not available yet. Counting is a controlled document with its own variance '
  + 'posting and a freeze on the quantities while it is open, and none of that exists on the '
  + 'server. Record the difference as an adjustment with a reason in the meantime.';

export const OPENING_UNSUPPORTED =
  'Opening stock balances are not available yet. The controlled opening-balance workflow posts '
  + 'ledger lines and knows nothing about items or warehouses, so an opening quantity here would '
  + 'have no agreed counterpart in the books. Receive the stock instead.';

// @vitest-environment happy-dom
/**
 * The Inventory master-data screens a durable subscriber actually uses.
 *
 * ══ Why these go through `fetch` ═════════════════════════════════════════════
 *
 * A gateway test proves the adapter; it does not prove a durable subscriber can
 * keep a catalogue. So these render the REAL pages, click the REAL buttons and
 * fill in the REAL drawers, and everything below them — the page handler, the
 * actions layer, the gateway, the API client, the URL, the method, the body and
 * the error mapping — runs unmocked against an in-memory server standing at the
 * `fetch` boundary.
 *
 * ══ And what they prove is NOT there ═════════════════════════════════════════
 *
 * No quantity, no stock column, no valuation. Creating an item must not make a
 * stocked transaction available anywhere, and clearing browser storage must not
 * touch a durable catalogue.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

const engine = vi.hoisted(() => ({ current: 'server' as 'server' | 'demo' }));
vi.mock('@/services/books/booksEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/books/booksEngine')>()),
  booksEngine: () => engine.current,
}));

vi.mock('@/services/api/taxCodesApi', () => ({
  taxCodesApi: { list: vi.fn(async () => []) },
}));

import { ItemsPage } from './inventory/ItemsPage';
import { WarehousesPage } from './inventory/WarehousesPage';
import { useInventoryStore } from '@/store/inventoryStore';
import { useStore } from '@/store/useStore';
import { makeInventorySeed } from '@/lib/inventorySeed';
import { clearInventoryCache, useServerInventory } from '@/services/inventory/inventoryBackend';
import { server, resetServer, install } from './__fixtures__/inventoryFakeServer';

const realFetch = globalThis.fetch;

beforeEach(() => {
  engine.current = 'server';
  /* The suite is hermetic by default (`VITE_API_URL: ''`), which makes the
   * client refuse before it reaches `fetch`. These tests are about the request
   * actually travelling, so they configure a base the fake server answers. */
  vi.stubEnv('VITE_API_URL', 'http://localhost:3000');
  resetServer();
  install();
  clearInventoryCache();
  useInventoryStore.getState().resetToDefault();
  useStore.setState({ accounts: [] } as never);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

/** Wait for the register to finish its first load. */
async function ready(): Promise<void> {
  await waitFor(() => expect(useServerInventory.getState().itemState).toBe('ready'));
}

async function openNewItem(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /New item/i }));
  await screen.findByLabelText(/Item code \/ SKU/i);
}

function fill(label: RegExp, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/* ══ Items ═════════════════════════════════════════════════════════════════ */

describe('a durable subscriber keeps a catalogue through the screen', () => {
  it('creates an item on the SERVER, not in the browser', async () => {
    render(<ItemsPage />);
    await ready();

    await openNewItem();
    fill(/Item code \/ SKU/i, 'SKU-001');
    fill(/Primary name/i, 'Trading goods');
    fireEvent.click(screen.getByRole('button', { name: /Save item/i }));

    await waitFor(() => expect(server.items).toHaveLength(1));
    expect(server.items[0]!.itemCode).toBe('SKU-001');
    expect(server.calls.some((c) => c.method === 'POST' && c.path === '/api/inventory/items'))
      .toBe(true);

    /* And nothing went into the browser store. */
    expect(useInventoryStore.getState().items).toHaveLength(0);
    expect(await screen.findByText('SKU-001')).toBeTruthy();
  });

  it('edits it, carrying the version the server last returned', async () => {
    server.items.push({
      id: 'item-1', itemCode: 'SKU-001', barcode: null, name: 'Original', nameSecondary: '',
      description: '', itemType: 'non-inventory', isInventoryTracked: false, isPurchasable: true,
      isSellable: true, trackingMode: 'none', valuationMethod: 'weighted-average',
      baseUnitId: 'unit-1', baseUnitCode: 'EA', baseUnitDecimalPlaces: 0,
      defaultSellingPrice: null, defaultPurchasePrice: null, standardCost: null,
      salesDescription: '', purchaseDescription: '', salesTaxCodeId: null, purchaseTaxCodeId: null,
      inventoryAccountId: null, cogsAccountId: null, salesAccountId: null, purchaseAccountId: null,
      inventoryAdjustmentAccountId: null, status: 'active', version: 3,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });

    render(<ItemsPage />);
    await ready();

    fireEvent.click(await screen.findByRole('button', { name: /^Edit$/i }));
    fill(/Primary name/i, 'Renamed');
    fireEvent.click(screen.getByRole('button', { name: /Save item/i }));

    await waitFor(() => expect(server.items[0]!.name).toBe('Renamed'));
    /* Version 3 went out and 4 came back — the form never invented its own. */
    expect(server.items[0]!.version).toBe(4);
  });

  it('shows the SERVER’s duplicate-code refusal, in its own words', async () => {
    render(<ItemsPage />);
    await ready();

    await openNewItem();
    fill(/Item code \/ SKU/i, 'SKU-001');
    fill(/Primary name/i, 'First');
    fireEvent.click(screen.getByRole('button', { name: /Save item/i }));
    await waitFor(() => expect(server.items).toHaveLength(1));

    await openNewItem();
    fill(/Item code \/ SKU/i, 'sku-001');
    fill(/Primary name/i, 'Second');
    fireEvent.click(screen.getByRole('button', { name: /Save item/i }));

    expect(await screen.findByText(/already used in these books/i)).toBeTruthy();
    expect(server.items).toHaveLength(1);
  });

  it('archives and reactivates through the server', async () => {
    render(<ItemsPage />);
    await ready();

    await openNewItem();
    fill(/Item code \/ SKU/i, 'SKU-9');
    fill(/Primary name/i, 'Disposable');
    fireEvent.click(screen.getByRole('button', { name: /Save item/i }));
    await waitFor(() => expect(server.items).toHaveLength(1));

    fireEvent.click(await screen.findByRole('button', { name: /^Archive$/i }));
    await waitFor(() => expect(server.items[0]!.status).toBe('archived'));
    /* Archiving is never deletion: the row and its identity survive. */
    expect(server.items).toHaveLength(1);

    fireEvent.click(await screen.findByRole('button', { name: /^Reactivate$/i }));
    await waitFor(() => expect(server.items[0]!.status).toBe('active'));
  });

  it('searches the SERVER rather than filtering a stale page', async () => {
    render(<ItemsPage />);
    await ready();

    for (const [code, name] of [['AAA-1', 'Alpha'], ['BBB-2', 'Beta']] as const) {
      await openNewItem();
      fill(/Item code \/ SKU/i, code);
      fill(/Primary name/i, name);
      fireEvent.click(screen.getByRole('button', { name: /Save item/i }));
      await waitFor(() => expect(screen.queryByLabelText(/Item code \/ SKU/i)).toBeNull());
    }
    await waitFor(() => expect(server.items).toHaveLength(2));

    server.calls.length = 0;
    fireEvent.change(screen.getByLabelText(/Search items/i), { target: { value: 'Alpha' } });

    /* The request carried the term — the page did not merely hide a row it
     * already had, which would silently miss anything past the first page. */
    await waitFor(() => expect(
      server.calls.some((c) => c.method === 'GET' && c.path === '/api/inventory/items'),
    ).toBe(true));
    await waitFor(() => expect(screen.queryByText('BBB-2')).toBeNull());
    expect(screen.getByText('AAA-1')).toBeTruthy();
  });
});

/* ══ Warehouses ════════════════════════════════════════════════════════════ */

describe('a durable subscriber keeps warehouses through the screen', () => {
  it('creates one on the SERVER', async () => {
    render(<WarehousesPage />);
    await waitFor(() => expect(useServerInventory.getState().warehouseState).toBe('ready'));

    fireEvent.click(screen.getByRole('button', { name: /New warehouse/i }));
    fireEvent.change(await screen.findByLabelText(/Warehouse code/i), { target: { value: 'MAIN' } });
    fireEvent.change(screen.getByLabelText(/Warehouse name/i), { target: { value: 'Main store' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(server.warehouses).toHaveLength(1));
    expect(server.warehouses[0]!.code).toBe('MAIN');
    expect(useInventoryStore.getState().warehouses.some((w) => w.code === 'MAIN')).toBe(false);
  });

  it('offers ARCHIVE rather than delete, and shows the default refusal verbatim', async () => {
    render(<WarehousesPage />);
    await waitFor(() => expect(useServerInventory.getState().warehouseState).toBe('ready'));

    fireEvent.click(screen.getByRole('button', { name: /New warehouse/i }));
    fireEvent.change(await screen.findByLabelText(/Warehouse code/i), { target: { value: 'MAIN' } });
    fireEvent.change(screen.getByLabelText(/Warehouse name/i), { target: { value: 'Main store' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(server.warehouses).toHaveLength(1));

    /* No delete on server books — a document will name this warehouse. */
    expect(screen.queryByRole('button', { name: /^Delete$/i })).toBeNull();

    server.defaultWarehouseId = server.warehouses[0]!.id;
    fireEvent.click(await screen.findByRole('button', { name: /^Archive$/i }));

    expect(await screen.findByText(/is this company's default/i)).toBeTruthy();
    expect(server.warehouses[0]!.status).toBe('active');
  });
});

/* ══ The boundary ══════════════════════════════════════════════════════════ */

describe('what I1 deliberately does not show', () => {
  it('shows no stock columns on server books', async () => {
    render(<ItemsPage />);
    await ready();
    expect(screen.queryByText(/On hand/i)).toBeNull();
    expect(screen.queryByText(/Stock value/i)).toBeNull();
  });

  it('asks the server for no quantity, movement or valuation route', async () => {
    render(<ItemsPage />);
    await ready();
    await openNewItem();
    fill(/Item code \/ SKU/i, 'SKU-1');
    fill(/Primary name/i, 'Anything');
    fireEvent.click(screen.getByRole('button', { name: /Save item/i }));
    await waitFor(() => expect(server.items).toHaveLength(1));

    const forbidden = /movement|stock|quantity|valuation|receipt|issue|transfer|adjustment/i;
    const offenders = server.calls.filter((c) => forbidden.test(c.path));
    expect(offenders).toEqual([]);
  });

  it('counts stranded browser items instead of importing them', async () => {
    const seed = makeInventorySeed('manufacturing');
    useInventoryStore.setState({ ...seed, movements: [], documents: [], seeded: true } as never);

    render(<ItemsPage />);
    await ready();

    expect(await screen.findByText(/remain in this browser/i)).toBeTruthy();
    /* Counted, never sent: nothing was posted to the item register. */
    expect(server.items).toHaveLength(0);
    expect(server.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('loses nothing when browser storage is cleared: the catalogue is on the server', async () => {
    render(<ItemsPage />);
    await ready();

    await openNewItem();
    fill(/Item code \/ SKU/i, 'DURABLE-1');
    fill(/Primary name/i, 'Survives');
    fireEvent.click(screen.getByRole('button', { name: /Save item/i }));
    await waitFor(() => expect(server.items).toHaveLength(1));

    cleanup();
    /* Everything this browser held, gone. */
    useInventoryStore.getState().resetToDefault();
    useInventoryStore.setState({ items: [], warehouses: [], units: [] } as never);
    clearInventoryCache();
    localStorage.clear();

    render(<ItemsPage />);
    await ready();
    expect(await screen.findByText('DURABLE-1')).toBeTruthy();
  });
});

/* ══ Free Demo keeps its own disposable behaviour ══════════════════════════ */

describe('Free Demo', () => {
  beforeEach(() => {
    engine.current = 'demo';
    const seed = makeInventorySeed('manufacturing');
    useInventoryStore.setState({ ...seed, movements: [], documents: [], seeded: true } as never);
  });

  it('creates an item in the BROWSER, and asks the server for nothing', async () => {
    render(<ItemsPage />);

    await openNewItem();
    fill(/Item code \/ SKU/i, 'DEMO-1');
    fill(/Primary name/i, 'Demo good');
    fireEvent.click(screen.getByRole('button', { name: /Save item/i }));

    await waitFor(() =>
      expect(useInventoryStore.getState().items.some((i) => i.code === 'DEMO-1')).toBe(true));
    expect(server.items).toHaveLength(0);
    expect(server.calls).toEqual([]);
  });

  it('still offers Delete on a warehouse, which only the demo engine can do', async () => {
    render(<WarehousesPage />);
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('button', { name: /^Delete$/i }).length).toBeGreaterThan(0);
    expect(server.calls).toEqual([]);
  });

  it('keeps its category field, which has no server register', async () => {
    render(<ItemsPage />);
    await openNewItem();
    expect(screen.getByLabelText(/Category/i)).toBeTruthy();
  });
});

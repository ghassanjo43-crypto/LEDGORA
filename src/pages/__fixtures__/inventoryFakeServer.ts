/**
 * An in-memory Inventory master-data server, standing where `fetch` does.
 *
 * ══ Why a fake at the network boundary rather than a mocked module ═══════════
 *
 * The point of the I1 cutover tests is that a durable subscriber's clicks reach
 * the server. Mocking `itemsApi` would leave the URL, the method, the body
 * shape and the error mapping untested — exactly the layer that decides whether
 * a catalogue is durable or is quietly going into browser storage. So the real
 * client runs, and this answers it.
 *
 * ══ It enforces the real rules, in the real words ════════════════════════════
 *
 * Case-insensitive code and barcode uniqueness, optimistic versions, a service
 * that cannot be stock, and the refusal to archive the company's default
 * warehouse. The sentences are the server's own, so a screen that garbled or
 * replaced one fails the test that reads it.
 *
 * There is NO quantity endpoint here, because there is none there.
 */

type Json = Record<string, unknown>;

interface FakeItem {
  id: string;
  itemCode: string;
  barcode: string | null;
  name: string;
  nameSecondary: string;
  description: string;
  itemType: string;
  isInventoryTracked: boolean;
  isPurchasable: boolean;
  isSellable: boolean;
  trackingMode: string;
  valuationMethod: string;
  baseUnitId: string;
  baseUnitCode: string;
  baseUnitDecimalPlaces: number;
  defaultSellingPrice: string | null;
  defaultPurchasePrice: string | null;
  standardCost: string | null;
  salesDescription: string;
  purchaseDescription: string;
  salesTaxCodeId: string | null;
  purchaseTaxCodeId: string | null;
  inventoryAccountId: string | null;
  cogsAccountId: string | null;
  salesAccountId: string | null;
  purchaseAccountId: string | null;
  inventoryAdjustmentAccountId: string | null;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface FakeWarehouse {
  id: string;
  code: string;
  name: string;
  description: string;
  warehouseType: string;
  location: string;
  status: string;
  isDefault: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface FakeUnit {
  id: string;
  code: string;
  name: string;
  symbol: string;
  category: string;
  decimalPlaces: number;
  status: string;
  isSystem: boolean;
  version: number;
}

const NOW = '2026-01-01T00:00:00.000Z';

const SEED_UNITS: FakeUnit[] = [
  ['EA', 'Each', 'ea', 'quantity', 0],
  ['BOX', 'Box', 'box', 'quantity', 0],
  ['KG', 'Kilogram', 'kg', 'weight', 3],
  ['HOUR', 'Hour', 'h', 'time', 2],
].map(([code, name, symbol, category, dp], index) => ({
  id: `unit-${index + 1}`,
  code: code as string,
  name: name as string,
  symbol: symbol as string,
  category: category as string,
  decimalPlaces: dp as number,
  status: 'active',
  isSystem: true,
  version: 1,
}));

export const server = {
  items: [] as FakeItem[],
  warehouses: [] as FakeWarehouse[],
  units: [...SEED_UNITS] as FakeUnit[],
  defaultWarehouseId: null as string | null,
  /** Every request this fake answered, so a test can assert what was called. */
  calls: [] as Array<{ method: string; path: string }>,
  nextId: 1,
};

export function resetServer(): void {
  server.items = [];
  server.warehouses = [];
  server.units = [...SEED_UNITS];
  server.defaultWarehouseId = null;
  server.calls = [];
  server.nextId = 1;
}

const id = (prefix: string): string => `${prefix}-${server.nextId++}`;

/** The exact-decimal shape the real server returns: text, never a float. */
const decimal = (value: unknown): string | null => {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  const [whole, fraction = ''] = text.split('.');
  return `${whole}.${fraction.padEnd(10, '0').slice(0, 10)}`;
};

const ok = (body: Json, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fail = (status: number, code: string, message: string, fieldErrors?: Json): Response =>
  new Response(
    JSON.stringify({ error: { code, message, details: fieldErrors ? { fieldErrors } : undefined } }),
    { status, headers: { 'content-type': 'application/json' } },
  );

const sameCode = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

function itemView(item: FakeItem): FakeItem {
  const unit = server.units.find((u) => u.id === item.baseUnitId);
  return {
    ...item,
    baseUnitCode: unit?.code ?? '',
    baseUnitDecimalPlaces: unit?.decimalPlaces ?? 0,
  };
}

function writeItem(body: Json, existing?: FakeItem): FakeItem | Response {
  const itemCode = String(body.itemCode ?? '').trim();
  const barcode = body.barcode ? String(body.barcode).trim() : null;
  const itemType = String(body.itemType ?? 'non-inventory');

  if (!itemCode) {
    return fail(400, 'validation_error', 'Check the item details and try again.',
      { itemCode: 'An item code is required.' });
  }
  /* A service is never stock — the constraint the real database enforces. */
  if (['service', 'non-inventory'].includes(itemType) && body.isInventoryTracked) {
    return fail(400, 'validation_error', 'Check the item details and try again.',
      { isInventoryTracked: `A ${itemType} item cannot be inventory tracked — it has no stock to track.` });
  }
  if (body.isSellable === false && body.isPurchasable === false) {
    return fail(400, 'validation_error', 'Check the item details and try again.',
      { isSellable: 'An item must be sellable, purchasable, or both.' });
  }

  const clash = server.items.find((i) => i.id !== existing?.id && sameCode(i.itemCode, itemCode));
  if (clash) return fail(409, 'conflict', 'That item code is already used in these books.');

  if (barcode) {
    const barClash = server.items.find(
      (i) => i.id !== existing?.id && i.barcode && sameCode(i.barcode, barcode),
    );
    if (barClash) {
      return fail(409, 'conflict', 'That barcode is already used by another item in these books.');
    }
  }

  const unit = server.units.find((u) => u.id === body.baseUnitId);
  if (!unit) {
    return fail(400, 'validation_error', 'That unit of measure does not exist in these books.',
      { baseUnitId: 'Choose a unit from this company.' });
  }

  return {
    id: existing?.id ?? id('item'),
    itemCode,
    barcode,
    name: String(body.name ?? ''),
    nameSecondary: String(body.nameSecondary ?? ''),
    description: String(body.description ?? ''),
    itemType,
    isInventoryTracked: ['service', 'non-inventory'].includes(itemType)
      ? false
      : Boolean(body.isInventoryTracked),
    isPurchasable: body.isPurchasable !== false,
    isSellable: body.isSellable !== false,
    trackingMode: String(body.trackingMode ?? 'none'),
    valuationMethod: String(body.valuationMethod ?? 'weighted-average'),
    baseUnitId: unit.id,
    baseUnitCode: unit.code,
    baseUnitDecimalPlaces: unit.decimalPlaces,
    defaultSellingPrice: decimal(body.defaultSellingPrice),
    defaultPurchasePrice: decimal(body.defaultPurchasePrice),
    standardCost: decimal(body.standardCost),
    salesDescription: String(body.salesDescription ?? ''),
    purchaseDescription: String(body.purchaseDescription ?? ''),
    salesTaxCodeId: (body.salesTaxCodeId as string) ?? null,
    purchaseTaxCodeId: (body.purchaseTaxCodeId as string) ?? null,
    inventoryAccountId: (body.inventoryAccountId as string) ?? null,
    cogsAccountId: (body.cogsAccountId as string) ?? null,
    salesAccountId: (body.salesAccountId as string) ?? null,
    purchaseAccountId: (body.purchaseAccountId as string) ?? null,
    inventoryAdjustmentAccountId: (body.inventoryAdjustmentAccountId as string) ?? null,
    status: existing?.status ?? 'active',
    version: existing ? existing.version + 1 : 1,
    createdAt: existing?.createdAt ?? NOW,
    updatedAt: NOW,
  };
}

const STALE =
  'This record was changed by another user while you were editing it. Reload and try again so you '
  + 'do not overwrite their change.';

export function install(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://server.test');
    const path = url.pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body: Json = init?.body ? JSON.parse(String(init.body)) : {};
    server.calls.push({ method, path });

    /* ── Units ─────────────────────────────────────────────────────────── */
    if (path === '/api/inventory/units' && method === 'GET') {
      return ok({
        units: server.units,
        conversionsSupported: false,
        conversionNote: 'Unit conversions are not available.',
      });
    }

    /* ── Items ─────────────────────────────────────────────────────────── */
    if (path === '/api/inventory/items' && method === 'GET') {
      const search = (url.searchParams.get('search') ?? '').toLowerCase();
      const matched = search
        ? server.items.filter((i) => i.itemCode.toLowerCase().includes(search)
          || i.name.toLowerCase().includes(search)
          || (i.barcode ?? '').toLowerCase().includes(search))
        : server.items;
      return ok({ items: matched.map(itemView) });
    }

    if (path === '/api/inventory/items' && method === 'POST') {
      const made = writeItem(body);
      if (made instanceof Response) return made;
      server.items.push(made);
      return ok({ item: itemView(made) }, 201);
    }

    const itemMatch = /^\/api\/inventory\/items\/([^/]+)(\/(archive|history))?$/.exec(path);
    if (itemMatch) {
      const found = server.items.find((i) => i.id === itemMatch[1]);
      if (!found) return fail(404, 'not_found', 'Item not found.');
      const action = itemMatch[3];

      if (method === 'GET' && !action) return ok({ item: itemView(found) });
      if (method === 'GET' && action === 'history') return ok({ events: [] });

      if (method === 'PATCH' && !action) {
        if (Number(body.expectedVersion) !== found.version) return fail(409, 'conflict', STALE);
        const made = writeItem(body, found);
        if (made instanceof Response) return made;
        server.items = server.items.map((i) => (i.id === found.id ? made : i));
        return ok({ item: itemView(made) });
      }

      if (method === 'POST' && action === 'archive') {
        if (Number(body.expectedVersion) !== found.version) return fail(409, 'conflict', STALE);
        const next = {
          ...found,
          status: body.archived ? 'archived' : 'active',
          version: found.version + 1,
        };
        server.items = server.items.map((i) => (i.id === found.id ? next : i));
        return ok({ item: itemView(next) });
      }
    }

    /* ── Warehouses ────────────────────────────────────────────────────── */
    if (path === '/api/inventory/warehouses' && method === 'GET') {
      const search = (url.searchParams.get('search') ?? '').toLowerCase();
      const matched = search
        ? server.warehouses.filter((w) => w.code.toLowerCase().includes(search)
          || w.name.toLowerCase().includes(search)
          || w.location.toLowerCase().includes(search))
        : server.warehouses;
      return ok({
        warehouses: matched.map((w) => ({ ...w, isDefault: w.id === server.defaultWarehouseId })),
      });
    }

    if (path === '/api/inventory/warehouses' && method === 'POST') {
      const code = String(body.code ?? '').trim();
      if (!code) {
        return fail(400, 'validation_error', 'Check the warehouse details and try again.',
          { code: 'A warehouse code is required.' });
      }
      if (server.warehouses.some((w) => sameCode(w.code, code))) {
        return fail(409, 'conflict', 'That warehouse code is already used in these books.');
      }
      const made: FakeWarehouse = {
        id: id('wh'),
        code,
        name: String(body.name ?? ''),
        description: String(body.description ?? ''),
        warehouseType: String(body.warehouseType ?? 'main'),
        location: String(body.location ?? ''),
        status: 'active',
        isDefault: false,
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      server.warehouses.push(made);
      return ok({ warehouse: made }, 201);
    }

    const whMatch = /^\/api\/inventory\/warehouses\/([^/]+)(\/(archive|history))?$/.exec(path);
    if (whMatch) {
      const found = server.warehouses.find((w) => w.id === whMatch[1]);
      if (!found) return fail(404, 'not_found', 'Warehouse not found.');
      const action = whMatch[3];

      if (method === 'GET' && !action) return ok({ warehouse: found });
      if (method === 'GET' && action === 'history') return ok({ events: [] });

      if (method === 'PATCH' && !action) {
        if (Number(body.expectedVersion) !== found.version) return fail(409, 'conflict', STALE);
        const code = String(body.code ?? '').trim();
        if (server.warehouses.some((w) => w.id !== found.id && sameCode(w.code, code))) {
          return fail(409, 'conflict', 'That warehouse code is already used in these books.');
        }
        const next = {
          ...found,
          code,
          name: String(body.name ?? ''),
          description: String(body.description ?? ''),
          warehouseType: String(body.warehouseType ?? 'main'),
          location: String(body.location ?? ''),
          version: found.version + 1,
        };
        server.warehouses = server.warehouses.map((w) => (w.id === found.id ? next : w));
        return ok({ warehouse: next });
      }

      if (method === 'POST' && action === 'archive') {
        if (Number(body.expectedVersion) !== found.version) return fail(409, 'conflict', STALE);
        if (body.archived && server.defaultWarehouseId === found.id) {
          return fail(
            400, 'validation_error',
            `Warehouse ${found.code} is this company's default and cannot be archived while it is. `
            + 'Point the default at another warehouse first, or clear it.',
          );
        }
        const next = {
          ...found,
          status: body.archived ? 'archived' : 'active',
          version: found.version + 1,
        };
        server.warehouses = server.warehouses.map((w) => (w.id === found.id ? next : w));
        return ok({ warehouse: next });
      }
    }

    /* ── The accounting profile ────────────────────────────────────────── */
    if (path === '/api/inventory/settings' && method === 'GET') {
      return ok({
        settings: {
          defaultValuationMethod: 'weighted-average',
          defaultWarehouseId: server.defaultWarehouseId,
          defaultInventoryAccountId: null,
          defaultCogsAccountId: null,
          defaultSalesAccountId: null,
          defaultPurchaseAccountId: null,
          inventoryGainAccountId: null,
          inventoryLossAccountId: null,
          stockInTransitAccountId: null,
          version: 0,
        },
      });
    }

    /* Anything else is a route this slice does not have. */
    return fail(404, 'not_found', `No route for ${method} ${path}`);
  }) as typeof fetch;
}

/**
 * An in-memory stock server, standing where `fetch` does.
 *
 * The cutover tests are about the request actually travelling: the URL, the
 * method, the body, the idempotency key and the error mapping all run unmocked
 * against this. It enforces the rules that matter to a screen — insufficient
 * stock is refused in the server's own words, a transfer posts two legs and no
 * journal, and a repeated idempotency key returns the document it already made.
 */

type Json = Record<string, unknown>;

interface FakeMovement {
  id: string;
  lineNumber: number;
  movementType: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  warehouseId: string;
  warehouseCode: string;
  baseUnitId: string;
  baseUnitCode: string;
  direction: 'in' | 'out';
  quantity: string;
  unitCost: string;
  totalCost: string;
  inventoryAccountId: string;
  offsetAccountId: string | null;
  movementDate: string;
  postingDate: string;
  status: string;
  reversalOfMovementId: string | null;
  reversedByMovementId: string | null;
}

interface FakeDocument {
  id: string;
  documentNumber: string;
  kind: string;
  movementDate: string;
  postingDate: string;
  reference: string;
  memo: string;
  reason: string;
  status: string;
  journalEntryId: string | null;
  reversalOfDocumentId: string | null;
  reversedByDocumentId: string | null;
  reversalReason: string;
  version: number;
  createdAt: string | null;
  movements: FakeMovement[];
}

interface FakeCountLine {
  id: string; lineNumber: number; itemId: string; itemCode: string; itemName: string;
  baseUnitCode: string; expectedQuantity: string; countedQuantity: string;
  varianceQuantity: string; unitCost: string; varianceValue: string; note: string;
}

interface FakeCount {
  id: string; countNumber: string; status: 'posted' | 'reversed';
  warehouseId: string; warehouseCode: string; countDate: string; postingDate: string;
  memo: string; adjustmentDocumentId: string | null; adjustmentDocumentNumber: string | null;
  journalEntryId: string | null; reversalReason: string; version: number;
  createdAt: string | null; idempotencyKey: string; lines: FakeCountLine[];
}

const UNITS = [
  { id: 'unit-1', code: 'EA', name: 'Each', symbol: 'ea', category: 'quantity', decimalPlaces: 0, status: 'active', isSystem: true, version: 1 },
];

const ITEMS = [
  {
    id: 'item-1', itemCode: 'SKU-1', barcode: null, name: 'Widget', nameSecondary: '',
    description: '', itemType: 'inventory', isInventoryTracked: true, isPurchasable: true,
    isSellable: true, trackingMode: 'none', valuationMethod: 'weighted-average',
    baseUnitId: 'unit-1', baseUnitCode: 'EA', baseUnitDecimalPlaces: 0,
    defaultSellingPrice: null, defaultPurchasePrice: null, standardCost: null,
    salesDescription: '', purchaseDescription: '', salesTaxCodeId: null, purchaseTaxCodeId: null,
    inventoryAccountId: 'acct-stock', cogsAccountId: null, salesAccountId: null,
    purchaseAccountId: null, inventoryAdjustmentAccountId: null, status: 'active',
    version: 1, createdAt: null, updatedAt: null,
  },
];

const WAREHOUSES = [
  { id: 'wh-1', code: 'MAIN', name: 'Main store', description: '', warehouseType: 'main', location: '', status: 'active', isDefault: false, version: 1, createdAt: null, updatedAt: null },
  { id: 'wh-2', code: 'SPARE', name: 'Spare store', description: '', warehouseType: 'main', location: '', status: 'active', isDefault: false, version: 1, createdAt: null, updatedAt: null },
];

export const server = {
  documents: [] as FakeDocument[],
  counts: [] as FakeCount[],
  calls: [] as Array<{ method: string; path: string }>,
  postedKeys: [] as string[],
  /** Makes the next POST fail at the transport, so a retry can be observed. */
  failNextPost: false,
  /** Makes every read fail, so "empty, never stale" can be observed. */
  failReads: false,
  nextId: 1,
};

export function resetServer(): void {
  server.documents = [];
  server.counts = [];
  server.calls = [];
  server.postedKeys = [];
  server.failNextPost = false;
  server.failReads = false;
  server.nextId = 1;
}

const ok = (body: Json, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fail = (status: number, code: string, message: string): Response =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status, headers: { 'content-type': 'application/json' },
  });

/** On-hand for an item, from the posted movements — exactly as the server does. */
function onHand(itemId: string, warehouseId?: string): number {
  return server.documents
    .flatMap((document) => document.movements)
    .filter((movement) => movement.status === 'posted'
      && movement.itemId === itemId
      && (!warehouseId || movement.warehouseId === warehouseId))
    .reduce((sum, movement) => sum
      + (movement.direction === 'in' ? Number(movement.quantity) : -Number(movement.quantity)), 0);
}

function value(itemId: string): number {
  return server.documents
    .flatMap((document) => document.movements)
    .filter((movement) => movement.status === 'posted' && movement.itemId === itemId)
    .reduce((sum, movement) => sum
      + (movement.direction === 'in' ? Number(movement.totalCost) : -Number(movement.totalCost)), 0);
}

const NEGATIVE =
  'This would leave less than nothing in the warehouse. Negative stock is not permitted.';

function postDocument(body: Json): Response {
  const key = String(body.idempotencyKey ?? '');
  server.postedKeys.push(key);

  const already = server.documents.find((d) => d.reference === `key:${key}` || d.memo === `key:${key}`);
  if (already) return ok({ document: already, created: false });

  const kind = String(body.kind);
  const lines = (body.lines ?? []) as Array<Json>;
  const movements: FakeMovement[] = [];
  let lineNumber = 0;

  for (const line of lines) {
    const itemId = String(line.itemId);
    const item = ITEMS.find((i) => i.id === itemId);
    if (!item) return fail(400, 'validation_error', 'That item is not in this company’s catalogue.');
    const quantity = String(line.quantity);

    const add = (direction: 'in' | 'out', movementType: string, warehouseId: string, unitCost: string): void => {
      lineNumber += 1;
      const warehouse = WAREHOUSES.find((w) => w.id === warehouseId)!;
      movements.push({
        id: `mv-${server.nextId++}`,
        lineNumber,
        movementType,
        itemId,
        itemCode: item.itemCode,
        itemName: item.name,
        warehouseId,
        warehouseCode: warehouse?.code ?? '',
        baseUnitId: item.baseUnitId,
        baseUnitCode: 'EA',
        direction,
        quantity,
        unitCost,
        totalCost: (Number(quantity) * Number(unitCost)).toFixed(3),
        inventoryAccountId: 'acct-stock',
        offsetAccountId: kind === 'transfer' ? null : 'acct-offset',
        movementDate: String(body.movementDate),
        postingDate: String(body.postingDate ?? body.movementDate),
        status: 'posted',
        reversalOfMovementId: null,
        reversedByMovementId: null,
      });
    };

    if (kind === 'receipt') {
      add('in', 'receipt', String(line.warehouseId), String(line.unitCost ?? '0'));
    } else if (kind === 'issue') {
      const warehouseId = String(line.warehouseId);
      if (onHand(itemId, warehouseId) < Number(quantity)) {
        return fail(400, 'validation_error', NEGATIVE);
      }
      const available = onHand(itemId);
      const unit = available > 0 ? (value(itemId) / available).toFixed(3) : '0';
      add('out', 'issue', warehouseId, unit);
    } else if (kind === 'transfer') {
      const source = String(body.sourceWarehouseId);
      if (onHand(itemId, source) < Number(quantity)) {
        return fail(400, 'validation_error', NEGATIVE);
      }
      const available = onHand(itemId);
      const unit = available > 0 ? (value(itemId) / available).toFixed(3) : '0';
      add('out', 'transfer-out', source, unit);
      add('in', 'transfer-in', String(body.destinationWarehouseId), unit);
    } else {
      const direction = line.direction === 'out' ? 'out' : 'in';
      if (direction === 'out' && onHand(itemId, String(line.warehouseId)) < Number(quantity)) {
        return fail(400, 'validation_error', NEGATIVE);
      }
      add(direction, `adjustment-${direction}`, String(line.warehouseId), String(line.unitCost ?? '1.000'));
    }
  }

  const prefix = kind === 'receipt' ? 'GRN' : kind === 'issue' ? 'GIN' : kind === 'transfer' ? 'TRF' : 'ADJ';
  const document: FakeDocument = {
    id: `doc-${server.nextId++}`,
    documentNumber: `${prefix}-2026-${String(server.documents.length + 1).padStart(4, '0')}`,
    kind,
    movementDate: String(body.movementDate),
    postingDate: String(body.postingDate ?? body.movementDate),
    reference: `key:${key}`,
    memo: '',
    reason: String(body.reason ?? ''),
    status: 'posted',
    journalEntryId: kind === 'transfer' ? null : `journal-${server.nextId++}`,
    reversalOfDocumentId: null,
    reversedByDocumentId: null,
    reversalReason: '',
    version: 1,
    createdAt: null,
    movements,
  };
  server.documents.unshift(document);
  return ok({ document, created: true }, 201);
}

/**
 * A counted sheet, settled the way the server settles one.
 *
 * The expected quantity is derived HERE from the movements this fake holds —
 * never read from the request — because that is the property the cutover test
 * is proving: the screen sends counted figures and nothing else.
 */
function postCount(body: Json): Response {
  const key = String(body.idempotencyKey ?? '');
  server.postedKeys.push(key);
  const existing = server.counts.find((c) => c.idempotencyKey === key);
  if (existing) return ok({ count: existing, created: false }, 200);

  const lines = (body.lines as Json[] ?? []).map((line, index) => {
    const itemId = String(line.itemId);
    const item = ITEMS.find((i) => i.id === itemId);
    const expected = onHand(itemId);
    const counted = Number(line.countedQuantity);
    const variance = counted - expected;
    return {
      id: `cl-${server.counts.length}-${index}`,
      lineNumber: index + 1,
      itemId,
      itemCode: item?.itemCode ?? '',
      itemName: item?.name ?? '',
      baseUnitCode: 'EA',
      expectedQuantity: String(expected),
      countedQuantity: String(counted),
      varianceQuantity: String(variance),
      unitCost: '0',
      varianceValue: '0',
      note: '',
    };
  });

  /*
   * Each variance becomes an adjustment DOCUMENT, exactly as the real server
   * settles one — so on-hand and valuation read it the same way, and the test
   * is exercising the same shape the books produce.
   */
  const moved = lines.filter((line) => Number(line.varianceQuantity) !== 0);
  if (moved.length > 0) {
    server.documents.unshift({
      id: `count-adj-${server.counts.length + 1}`,
      documentNumber: `ADJ-COUNT-${server.counts.length + 1}`,
      kind: 'adjustment',
      movementDate: String(body.countDate ?? '2026-03-10'),
      postingDate: String(body.countDate ?? '2026-03-10'),
      reference: '',
      memo: 'Stock count',
      reason: String(body.reason ?? ''),
      status: 'posted',
      journalEntryId: null,
      reversalOfDocumentId: null,
      reversedByDocumentId: null,
      reversalReason: '',
      version: 1,
      createdAt: null,
      movements: moved.map((line, index) => ({
        id: `count-mv-${server.counts.length}-${index}`,
        lineNumber: index + 1,
        movementType: Number(line.varianceQuantity) > 0 ? 'adjustment-in' : 'adjustment-out',
        itemId: line.itemId,
        itemCode: line.itemCode,
        itemName: line.itemName,
        warehouseId: String(body.warehouseId ?? 'wh-1'),
        warehouseCode: 'MAIN',
        baseUnitId: 'unit-1',
        baseUnitCode: 'EA',
        direction: Number(line.varianceQuantity) > 0 ? 'in' : 'out',
        quantity: String(Math.abs(Number(line.varianceQuantity))),
        unitCost: '0',
        totalCost: '0',
        inventoryAccountId: 'acct-stock',
        offsetAccountId: null,
        movementDate: String(body.countDate ?? '2026-03-10'),
        postingDate: String(body.countDate ?? '2026-03-10'),
        status: 'posted',
        reversalOfMovementId: null,
        reversedByMovementId: null,
      })) as never,
    });
  }

  const count = {
    id: `count-${server.counts.length + 1}`,
    countNumber: `SC-2026-000${server.counts.length + 1}`,
    status: 'posted' as const,
    warehouseId: String(body.warehouseId ?? 'wh-1'),
    warehouseCode: 'MAIN',
    countDate: String(body.countDate ?? '2026-03-10'),
    postingDate: String(body.countDate ?? '2026-03-10'),
    memo: '',
    adjustmentDocumentId: null,
    adjustmentDocumentNumber: null,
    journalEntryId: null,
    reversalReason: '',
    version: 1,
    createdAt: null,
    idempotencyKey: key,
    lines,
  };
  server.counts.unshift(count);
  return ok({ count, created: true }, 201);
}

/** Put stock on the shelf, so a count has something to disagree with. */
export function seedReceipt(quantity: number, unitCost = 5): void {
  server.documents.unshift({
    id: `seed-${server.documents.length + 1}`,
    documentNumber: `GRN-SEED-${server.documents.length + 1}`,
    kind: 'receipt',
    movementDate: '2026-03-01',
    postingDate: '2026-03-01',
    reference: '',
    memo: '',
    reason: '',
    status: 'posted',
    journalEntryId: null,
    reversalOfDocumentId: null,
    reversedByDocumentId: null,
    reversalReason: '',
    version: 1,
    createdAt: null,
    movements: [{
      id: `seed-mv-${server.documents.length + 1}`,
      lineNumber: 1,
      movementType: 'receipt',
      itemId: 'item-1',
      itemCode: 'SKU-1',
      itemName: 'Widget',
      warehouseId: 'wh-1',
      warehouseCode: 'MAIN',
      baseUnitId: 'unit-1',
      baseUnitCode: 'EA',
      direction: 'in',
      quantity: String(quantity),
      unitCost: String(unitCost),
      totalCost: String(quantity * unitCost),
      inventoryAccountId: 'acct-stock',
      offsetAccountId: 'acct-offset',
      movementDate: '2026-03-01',
      postingDate: '2026-03-01',
      status: 'posted',
      reversalOfMovementId: null,
      reversedByMovementId: null,
    }] as never,
  });
}

export function install(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://server.test');
    const path = url.pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body: Json = init?.body ? JSON.parse(String(init.body)) : {};
    server.calls.push({ method, path });

    if (path === '/api/inventory/units' && method === 'GET') {
      return ok({ units: UNITS, conversionsSupported: false, conversionNote: 'Not available.' });
    }
    if (path === '/api/inventory/items' && method === 'GET') return ok({ items: ITEMS });
    if (path === '/api/inventory/warehouses' && method === 'GET') {
      return ok({ warehouses: WAREHOUSES });
    }

    if (path === '/api/inventory/documents' && method === 'GET') {
      if (server.failReads) return fail(503, 'unavailable', 'The books are not reachable.');
      const kind = url.searchParams.get('kind');
      return ok({
        documents: kind ? server.documents.filter((d) => d.kind === kind) : server.documents,
      });
    }

    if (path === '/api/inventory/documents' && method === 'POST') {
      if (server.failNextPost) {
        server.failNextPost = false;
        /* Recorded first: the key must be visible even on a failed attempt, so
         * the test can prove the retry reuses it. */
        server.postedKeys.push(String(body.idempotencyKey ?? ''));
        return fail(503, 'unavailable', 'Could not reach the books. Try again.');
      }
      return postDocument(body);
    }

    if (path === '/api/inventory/stock-on-hand' && method === 'GET') {
      if (server.failReads) return fail(503, 'unavailable', 'The books are not reachable.');
      const rows = ITEMS.map((item) => ({
        itemId: item.id, itemCode: item.itemCode, itemName: item.name,
        warehouseId: 'wh-1', warehouseCode: 'MAIN', baseUnitCode: 'EA',
        quantity: String(onHand(item.id)), value: String(value(item.id)),
      })).filter((row) => Number(row.quantity) !== 0);
      return ok({ rows });
    }

    if (path === '/api/inventory/valuation' && method === 'GET') {
      if (server.failReads) return fail(503, 'unavailable', 'The books are not reachable.');
      const rows = ITEMS.map((item) => ({
        itemId: item.id, itemCode: item.itemCode, itemName: item.name, baseUnitCode: 'EA',
        quantity: String(onHand(item.id)), value: String(value(item.id)),
        averageCost: onHand(item.id) ? String(value(item.id) / onHand(item.id)) : null,
        inventoryAccountId: 'acct-stock',
      })).filter((row) => Number(row.quantity) !== 0);
      return ok({ rows, totalValue: String(rows.reduce((s, r) => s + Number(r.value), 0)) });
    }

    if (path === '/api/inventory/reconciliation' && method === 'GET') {
      if (server.failReads) return fail(503, 'unavailable', 'The books are not reachable.');
      return ok({
        asOfDate: null, rows: [], balanced: true,
        totals: { subledgerValue: '0', generalLedgerBalance: '0', difference: '0' },
        exceptions: [],
      });
    }

    if (path === '/api/inventory/counts' && method === 'GET') {
      if (server.failReads) return fail(503, 'unavailable', 'The books are not reachable.');
      return ok({ counts: server.counts });
    }

    if (path === '/api/inventory/counts' && method === 'POST') {
      if (server.failNextPost) {
        server.failNextPost = false;
        server.postedKeys.push(String(body.idempotencyKey ?? ''));
        return fail(503, 'unavailable', 'Could not reach the books. Try again.');
      }
      return postCount(body);
    }

    if (path === '/api/inventory/settings' && method === 'GET') {
      return ok({
        settings: {
          defaultValuationMethod: 'weighted-average', defaultWarehouseId: null,
          defaultInventoryAccountId: 'acct-stock', defaultCogsAccountId: null,
          defaultSalesAccountId: null, defaultPurchaseAccountId: null,
          goodsReceivedNotInvoicedAccountId: 'acct-offset',
          inventoryGainAccountId: null, inventoryLossAccountId: null,
          stockInTransitAccountId: null, version: 1,
        },
      });
    }

    const reverse = /^\/api\/inventory\/documents\/([^/]+)\/reverse$/.exec(path);
    if (reverse && method === 'POST') {
      const original = server.documents.find((d) => d.id === reverse[1]);
      if (!original) return fail(404, 'not_found', 'Stock document not found.');
      if (original.status === 'reversed') {
        return fail(409, 'conflict', 'That document has already been reversed.');
      }
      original.status = 'reversed';
      for (const movement of original.movements) movement.status = 'reversed';
      const counter: FakeDocument = {
        ...original,
        id: `doc-${server.nextId++}`,
        documentNumber: `${original.documentNumber}-R`,
        status: 'reversed',
        reversalOfDocumentId: original.id,
        movements: original.movements.map((movement) => ({
          ...movement,
          id: `mv-${server.nextId++}`,
          direction: movement.direction === 'in' ? 'out' : 'in',
          status: 'reversed',
          reversalOfMovementId: movement.id,
        })),
      };
      server.documents.unshift(counter);
      return ok({ document: counter });
    }

    return fail(404, 'not_found', `No route for ${method} ${path}`);
  }) as typeof fetch;
}

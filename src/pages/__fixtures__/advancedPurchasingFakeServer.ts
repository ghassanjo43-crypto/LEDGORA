/**
 * An in-memory Advanced Purchasing server, standing where `fetch` does.
 *
 * ══ Why a fake at the network boundary rather than a mocked module ═══════════
 *
 * The claim these tests exist to prove is that a durable subscriber's clicks
 * REACH the server: the URL, the method, the body shape, the idempotency key
 * and the error mapping. Mocking `purchasingApi` would leave every one of those
 * untested — exactly the layer a browser fallback would slip back into.
 *
 * ══ It enforces the rules that matter to a screen ════════════════════════════
 *
 * A receipt cannot exceed a line's outstanding quantity, and the refusal is in
 * the server's own words; a repeated idempotency key answers with the receipt
 * it already made rather than a second one; a receipt line may only name an
 * order line, and a cost sent with it is refused. The arithmetic is
 * deliberately ordinary — `server/tests/advancedPurchasing.test.ts` proves the
 * exact-decimal maths against a real PostgreSQL — so what is proved here is the
 * wiring.
 */

type Json = Record<string, unknown>;

interface FakeOrderLine {
  id: string;
  lineNumber: number;
  itemId: string;
  itemCode: string;
  itemName: string;
  baseUnitId: string;
  baseUnitCode: string;
  warehouseId: string;
  warehouseCode: string;
  description: string;
  orderedQuantity: string;
  unitPrice: string;
  discountType: string | null;
  discountValue: string;
  discountAmount: string;
  lineSubtotal: string;
  lineNet: string;
  taxCodeId: string | null;
  estimatedTaxRate: string;
  estimatedTaxCategory: string | null;
  estimatedTaxMethod: string | null;
  estimatedTaxAmount: string;
  netAmount: string;
  grossAmount: string;
  receivedQuantity: string;
  remainingQuantity: string;
  receivedValue: string;
}

interface FakeOrder {
  id: string;
  orderNumber: string;
  supplierId: string;
  supplierName: string;
  orderDate: string;
  expectedDate: string | null;
  status: string;
  currency: string;
  supplierReference: string;
  memo: string;
  subtotal: string;
  discountTotal: string;
  estimatedTaxTotal: string;
  total: string;
  approvedAt: string | null;
  issuedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  closureReason: string;
  version: number;
  createdAt: string | null;
  lines: FakeOrderLine[];
}

interface FakeReceiptLine {
  id: string;
  lineNumber: number;
  orderLineId: string;
  orderLineNumber: number | null;
  itemId: string;
  itemCode: string;
  itemName: string;
  baseUnitId: string;
  baseUnitCode: string;
  warehouseId: string;
  warehouseCode: string;
  receivedQuantity: string;
  unitCost: string;
  totalCost: string;
  movementId: string | null;
}

interface FakeReceipt {
  id: string;
  receiptNumber: string;
  orderId: string;
  orderNumber: string;
  supplierId: string;
  supplierName: string;
  receiptDate: string;
  postingDate: string;
  deliveryNoteReference: string;
  memo: string;
  status: 'posted' | 'reversed';
  totalValue: string;
  inventoryDocumentId: string | null;
  inventoryDocumentNumber: string | null;
  journalEntryId: string | null;
  reversalDocumentId: string | null;
  reversalReason: string;
  reversedAt: string | null;
  matched: false;
  version: number;
  createdAt: string | null;
  idempotencyKey: string;
  lines: FakeReceiptLine[];
}

const UNITS = [
  {
    id: 'unit-1', code: 'EA', name: 'Each', symbol: 'ea', category: 'quantity',
    decimalPlaces: 0, status: 'active', isSystem: true, version: 1,
  },
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
  {
    id: 'wh-1', code: 'MAIN', name: 'Main store', description: '', warehouseType: 'main',
    location: '', status: 'active', isDefault: false, version: 1, createdAt: null, updatedAt: null,
  },
];

const SUPPLIERS = [
  {
    id: 'sup-1', partyCode: 'ACME', legalName: 'Acme Supplies', tradingName: '',
    isCustomer: false, isSupplier: true,
    contactPerson: '', jobTitle: '', email: '', phone: '', mobile: '', website: '',
    taxRegistrationNumber: '', commercialRegistrationNumber: '', paymentTerms: 'net_30',
    defaultCurrency: 'JOD', bankName: '', bankAccountName: '', iban: '', swiftCode: '',
    notes: '', status: 'active', version: 1,
    addresses: [], customer: null,
    supplier: {
      supplierCategory: '', defaultPayableAccountId: 'acct-payable',
      defaultExpenseAccountId: null, supplierPaymentTerms: 'net_30',
      withholdingTaxApplicable: false, preferredPaymentMethod: 'bank_transfer',
    },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

export const server = {
  orders: [] as FakeOrder[],
  receipts: [] as FakeReceipt[],
  calls: [] as Array<{ method: string; path: string; body: Json }>,
  /** Makes every read fail, so "empty, never stale" can be observed. */
  failReads: false,
  nextId: 1,
};

export function resetServer(): void {
  server.orders = [];
  server.receipts = [];
  server.calls = [];
  server.failReads = false;
  server.nextId = 1;
}

const id = (prefix: string): string => `${prefix}-${server.nextId++}`;

const ok = (body: Json, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fail = (status: number, code: string, message: string): Response =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status, headers: { 'content-type': 'application/json' },
  });

const money = (value: number): string => value.toFixed(3);

/** Received so far on one order line, from POSTED receipts — as the server does. */
function receivedOn(orderLineId: string): { quantity: number; value: number } {
  return server.receipts
    .filter((receipt) => receipt.status === 'posted')
    .flatMap((receipt) => receipt.lines)
    .filter((line) => line.orderLineId === orderLineId)
    .reduce(
      (sum, line) => ({
        quantity: sum.quantity + Number(line.receivedQuantity),
        value: sum.value + Number(line.totalCost),
      }),
      { quantity: 0, value: 0 },
    );
}

/** The derived quantities, recomputed on every read exactly as the server does. */
function hydrate(order: FakeOrder): FakeOrder {
  return {
    ...order,
    lines: order.lines.map((line) => {
      const got = receivedOn(line.id);
      return {
        ...line,
        receivedQuantity: money(got.quantity),
        remainingQuantity: money(Math.max(Number(line.orderedQuantity) - got.quantity, 0)),
        receivedValue: money(got.value),
      };
    }),
  };
}

function refreshStatus(order: FakeOrder): void {
  if (['draft', 'approved', 'closed', 'cancelled'].includes(order.status)) return;
  const totals = order.lines.map((line) => ({
    ordered: Number(line.orderedQuantity),
    got: receivedOn(line.id).quantity,
  }));
  const anything = totals.some((t) => t.got > 0);
  const everything = totals.every((t) => t.got >= t.ordered);
  order.status = !anything ? 'issued' : everything ? 'received' : 'partially_received';
}

function createOrder(body: Json): FakeOrder {
  const lines = (body.lines as Json[]).map((line, index) => {
    const quantity = Number(line.quantity);
    const price = Number(line.unitPrice);
    const gross = quantity * price;
    const discount = line.discountType === 'percentage'
      ? (gross * Number(line.discountValue ?? 0)) / 100
      : Number(line.discountValue ?? 0);
    const net = gross - Math.min(discount, gross);
    return {
      id: id('pol'),
      lineNumber: index + 1,
      itemId: String(line.itemId),
      itemCode: 'SKU-1',
      itemName: 'Widget',
      baseUnitId: 'unit-1',
      baseUnitCode: 'EA',
      warehouseId: String(line.warehouseId),
      warehouseCode: 'MAIN',
      description: String(line.description ?? ''),
      orderedQuantity: money(quantity),
      unitPrice: money(price),
      discountType: (line.discountType as string | null) ?? null,
      discountValue: money(Number(line.discountValue ?? 0)),
      discountAmount: money(Math.min(discount, gross)),
      lineSubtotal: money(gross),
      lineNet: money(net),
      taxCodeId: (line.taxCodeId as string | null) ?? null,
      estimatedTaxRate: '0.000',
      estimatedTaxCategory: null,
      estimatedTaxMethod: null,
      estimatedTaxAmount: '0.000',
      netAmount: money(net),
      grossAmount: money(net),
      receivedQuantity: '0.000',
      remainingQuantity: money(quantity),
      receivedValue: '0.000',
    };
  });

  const total = lines.reduce((sum, line) => sum + Number(line.netAmount), 0);
  const order: FakeOrder = {
    id: id('po'),
    orderNumber: `PO-2026-${String(server.orders.length + 1).padStart(4, '0')}`,
    supplierId: String(body.supplierId),
    supplierName: 'Acme Supplies',
    orderDate: String(body.orderDate),
    expectedDate: (body.expectedDate as string | null) ?? null,
    status: 'draft',
    currency: 'JOD',
    supplierReference: String(body.supplierReference ?? ''),
    memo: String(body.memo ?? ''),
    subtotal: money(lines.reduce((sum, line) => sum + Number(line.lineSubtotal), 0)),
    discountTotal: money(lines.reduce((sum, line) => sum + Number(line.discountAmount), 0)),
    estimatedTaxTotal: '0.000',
    total: money(total),
    approvedAt: null,
    issuedAt: null,
    closedAt: null,
    cancelledAt: null,
    closureReason: '',
    version: 1,
    createdAt: null,
    lines,
  };
  server.orders.push(order);
  return order;
}

export function seedIssuedOrder(quantity = '10', unitPrice = '5.000'): FakeOrder {
  const order = createOrder({
    supplierId: 'sup-1',
    orderDate: '2026-03-01',
    lines: [{ itemId: 'item-1', warehouseId: 'wh-1', quantity, unitPrice }],
  });
  order.status = 'issued';
  order.approvedAt = '2026-03-01T00:00:00.000Z';
  order.issuedAt = '2026-03-01T00:00:00.000Z';
  order.version = 3;
  return order;
}

/* ── The refusals, in the server's own words ───────────────────────────────── */

const OVER_RECEIPT = (remaining: number): string =>
  `That would exceed what is still outstanding on the order line, which is ${remaining}. There is `
  + 'no over-receipt tolerance in this product — a delivery larger than the order is a commercial '
  + 'change, and amending the order is what records that decision.';

const CLIENT_COST =
  'A goods receipt may not carry a unit cost: every commercial fact on a receipt is derived from '
  + 'the purchase order line it names, inside the posting transaction, so the person counting boxes '
  + 'cannot also decide the price. Nothing has been saved.';

export function install(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://server.test');
    const path = url.pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body: Json = init?.body ? JSON.parse(String(init.body)) : {};
    server.calls.push({ method, path, body });

    /* ── Master data the screens pick from ──────────────────────────────── */
    if (path === '/api/inventory/units' && method === 'GET') {
      return ok({ units: UNITS, conversionsSupported: false, conversionNote: 'Not available.' });
    }
    if (path === '/api/inventory/items' && method === 'GET') return ok({ items: ITEMS });
    if (path === '/api/inventory/warehouses' && method === 'GET') {
      return ok({ warehouses: WAREHOUSES });
    }
    if (path === '/api/vendors' && method === 'GET') {
      return ok({ parties: SUPPLIERS, nextCursor: null });
    }
    if (path === '/api/vendors/count' && method === 'GET') {
      return ok({ count: SUPPLIERS.length });
    }
    if (path === '/api/tax-codes' && method === 'GET') return ok({ taxCodes: [] });

    /* ── Purchase orders ────────────────────────────────────────────────── */
    if (path === '/api/purchasing/orders' && method === 'GET') {
      if (server.failReads) return fail(503, 'unavailable', 'The books are not reachable.');
      return ok({ orders: server.orders.map(hydrate) });
    }
    if (path === '/api/purchasing/orders/open-lines' && method === 'GET') {
      if (server.failReads) return fail(503, 'unavailable', 'The books are not reachable.');
      const lines = server.orders
        .filter((order) => order.status === 'issued' || order.status === 'partially_received')
        .flatMap((order) => hydrate(order).lines
          .filter((line) => Number(line.remainingQuantity) > 0)
          .map((line) => ({
            orderId: order.id,
            orderNumber: order.orderNumber,
            orderDate: order.orderDate,
            expectedDate: order.expectedDate,
            status: order.status,
            supplierId: order.supplierId,
            supplierName: order.supplierName,
            orderLineId: line.id,
            lineNumber: line.lineNumber,
            itemId: line.itemId,
            itemCode: line.itemCode,
            itemName: line.itemName,
            baseUnitCode: line.baseUnitCode,
            warehouseId: line.warehouseId,
            warehouseCode: line.warehouseCode,
            orderedQuantity: line.orderedQuantity,
            receivedQuantity: line.receivedQuantity,
            remainingQuantity: line.remainingQuantity,
            netAmount: line.netAmount,
            receivedValue: line.receivedValue,
            remainingValue: money(Number(line.netAmount) - Number(line.receivedValue)),
          })));
      return ok({ lines });
    }
    if (path === '/api/purchasing/orders' && method === 'POST') {
      /* Amounts, numbers and statuses are the server's. */
      for (const forbidden of ['total', 'orderNumber', 'status']) {
        if (body[forbidden] !== undefined) {
          return fail(400, 'validation_error', `A purchase order may not carry a ${forbidden}.`);
        }
      }
      return ok({ order: hydrate(createOrder(body)) }, 201);
    }

    const orderAction = /^\/api\/purchasing\/orders\/([^/]+)\/(approve|issue|close|cancel)$/
      .exec(path);
    if (orderAction && method === 'POST') {
      const order = server.orders.find((o) => o.id === orderAction[1]);
      if (!order) return fail(404, 'not_found', 'Purchase order not found.');
      if (order.version !== body.expectedVersion) {
        return fail(409, 'conflict', 'This purchase order was changed by another user.');
      }
      const next = orderAction[2];
      if (next === 'approve') { order.status = 'approved'; order.approvedAt = 'now'; }
      if (next === 'issue') { order.status = 'issued'; order.issuedAt = 'now'; }
      if (next === 'close') { order.status = 'closed'; order.closureReason = String(body.reason); }
      if (next === 'cancel') {
        order.status = 'cancelled'; order.closureReason = String(body.reason);
      }
      order.version += 1;
      return ok({ order: hydrate(order) });
    }

    /* ── Goods receipts ─────────────────────────────────────────────────── */
    if (path === '/api/purchasing/receipts' && method === 'GET') {
      if (server.failReads) return fail(503, 'unavailable', 'The books are not reachable.');
      return ok({
        receipts: server.receipts,
        matchingSupported: false,
        matchingNote: 'Matching a receipt to a supplier invoice is not implemented.',
      });
    }

    if (path === '/api/purchasing/receipts' && method === 'POST') {
      const lines = (body.lines ?? []) as Json[];
      for (const line of lines) {
        if (line.unitCost !== undefined || line.totalCost !== undefined) {
          return fail(400, 'validation_error', CLIENT_COST);
        }
      }

      /* A retry finds what it already made rather than making a second one. */
      const existing = server.receipts.find((r) => r.idempotencyKey === body.idempotencyKey);
      if (existing) return ok({ receipt: existing, created: false });

      const order = server.orders.find((o) => o.id === body.orderId);
      if (!order) return fail(400, 'validation_error', 'That purchase order is not in these books.');

      const planned: FakeReceiptLine[] = [];
      let totalValue = 0;
      for (const [index, line] of lines.entries()) {
        const orderLine = order.lines.find((l) => l.id === line.orderLineId);
        if (!orderLine) {
          return fail(400, 'validation_error',
            'That order line does not belong to this purchase order.');
        }
        const got = receivedOn(orderLine.id);
        const remaining = Number(orderLine.orderedQuantity) - got.quantity;
        const quantity = Number(line.quantity);
        if (quantity > remaining) return fail(400, 'validation_error', OVER_RECEIPT(remaining));

        /* The value comes from the ORDER, and the last receipt takes the rest. */
        const value = quantity === remaining
          ? Number(orderLine.netAmount) - got.value
          : (Number(orderLine.netAmount) * quantity) / Number(orderLine.orderedQuantity);
        totalValue += value;

        planned.push({
          id: id('grl'),
          lineNumber: index + 1,
          orderLineId: orderLine.id,
          orderLineNumber: orderLine.lineNumber,
          itemId: orderLine.itemId,
          itemCode: orderLine.itemCode,
          itemName: orderLine.itemName,
          baseUnitId: orderLine.baseUnitId,
          baseUnitCode: orderLine.baseUnitCode,
          warehouseId: orderLine.warehouseId,
          warehouseCode: orderLine.warehouseCode,
          receivedQuantity: money(quantity),
          unitCost: money(value / quantity),
          totalCost: money(value),
          movementId: id('mv'),
        });
      }

      const receipt: FakeReceipt = {
        id: id('gr'),
        receiptNumber: `GR-2026-${String(server.receipts.length + 1).padStart(4, '0')}`,
        orderId: order.id,
        orderNumber: order.orderNumber,
        supplierId: order.supplierId,
        supplierName: order.supplierName,
        receiptDate: String(body.receiptDate),
        postingDate: String(body.postingDate ?? body.receiptDate),
        deliveryNoteReference: String(body.deliveryNoteReference ?? ''),
        memo: String(body.memo ?? ''),
        status: 'posted',
        totalValue: money(totalValue),
        inventoryDocumentId: id('doc'),
        inventoryDocumentNumber: 'PRC-2026-0001',
        journalEntryId: id('je'),
        reversalDocumentId: null,
        reversalReason: '',
        reversedAt: null,
        matched: false,
        version: 1,
        createdAt: null,
        idempotencyKey: String(body.idempotencyKey),
        lines: planned,
      };
      server.receipts.push(receipt);
      refreshStatus(order);
      return ok({ receipt, created: true }, 201);
    }

    const reversal = /^\/api\/purchasing\/receipts\/([^/]+)\/reverse$/.exec(path);
    if (reversal && method === 'POST') {
      const receipt = server.receipts.find((r) => r.id === reversal[1]);
      if (!receipt) return fail(404, 'not_found', 'Goods receipt not found.');
      if (receipt.status === 'reversed') {
        return fail(409, 'conflict', 'This goods receipt has already been reversed.');
      }
      if (receipt.version !== body.expectedVersion) {
        return fail(409, 'conflict', 'This goods receipt was changed by another user.');
      }
      receipt.status = 'reversed';
      receipt.reversalReason = String(body.reason);
      receipt.reversalDocumentId = id('doc');
      receipt.reversedAt = 'now';
      receipt.version += 1;
      const order = server.orders.find((o) => o.id === receipt.orderId);
      if (order) refreshStatus(order);
      return ok({ receipt });
    }

    /* ── Received not invoiced ──────────────────────────────────────────── */
    if (path === '/api/purchasing/grni' && method === 'GET') {
      if (server.failReads) return fail(503, 'unavailable', 'The books are not reachable.');
      const rows = server.receipts
        .filter((receipt) => receipt.status === 'posted')
        .flatMap((receipt) => receipt.lines.map((line) => ({
          documentId: receipt.inventoryDocumentId!,
          documentNumber: receipt.inventoryDocumentNumber!,
          documentKind: 'purchase-receipt',
          postingDate: receipt.postingDate,
          receiptId: receipt.id,
          receiptNumber: receipt.receiptNumber,
          orderId: receipt.orderId,
          orderNumber: receipt.orderNumber,
          supplierId: receipt.supplierId,
          supplierName: receipt.supplierName,
          itemId: line.itemId,
          itemCode: line.itemCode,
          itemName: line.itemName,
          warehouseId: line.warehouseId,
          warehouseCode: line.warehouseCode,
          accountId: 'acct-grni',
          accountCode: '2150',
          accountName: 'Goods received not invoiced',
          quantity: line.receivedQuantity,
          value: line.totalCost,
          matched: false,
        })));
      const total = rows.reduce((sum, row) => sum + Number(row.value), 0);
      return ok({
        asOfDate: url.searchParams.get('asOfDate'),
        rows,
        total: money(total),
        generalLedgerBalance: money(total),
        difference: '0.000',
        balanced: true,
        matchingImplemented: false,
      });
    }

    return fail(404, 'not_found', `No fake route for ${method} ${path}`);
  }) as typeof fetch;
}

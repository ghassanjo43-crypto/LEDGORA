/**
 * Inventory I1 — master data endpoints.
 *
 * ══ Two gates, because the product sells them separately ═════════════════════
 *
 * The ITEM catalogue is shared master data. The navigation puts Items in Master
 * Data rather than in the Inventory group, `VIEW_MODULE_REQUIREMENTS` gives it
 * no module requirement, and a test asserts a Core subscriber can reach it —
 * which is right, because you cannot raise an invoice line from a catalogue you
 * cannot open. So items are gated by `items`, whose module is `invoicing`,
 * exactly as customers and vendors are.
 *
 * WAREHOUSES, UNIT MANAGEMENT and the accounting profile are Inventory. Both
 * layers already agree on that, so they keep the existing `inventory` subject
 * and its `inventory_basic` module.
 *
 * Reading units is deliberately on the ITEM gate: an item requires a base unit,
 * so a subscriber who may keep a catalogue must be able to see the units it is
 * measured in. Creating and archiving units is Inventory.
 *
 * ══ Nothing here moves stock ═════════════════════════════════════════════════
 *
 * There is no receipt, issue, transfer, adjustment, count or valuation endpoint,
 * and no route that accepts a quantity. Invoices and bills go on refusing
 * stocked lines by the shape of the line; creating an item does not change that
 * and is not meant to.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errors } from '../lib/errors.js';
import { requireOwnOrganizationPermission } from '../guards/permissions.js';
import { requireCompanyScope, companyOf } from '../guards/companyScope.js';
import type { InventoryActor } from '../services/inventory/inventoryCore.js';
import * as items from '../services/inventory/itemService.js';
import * as warehouses from '../services/inventory/warehouseService.js';
import * as units from '../services/inventory/unitService.js';
import * as settings from '../services/inventory/settingsService.js';
import * as stock from '../services/inventory/stockDocumentService.js';
import * as reports from '../services/inventory/stockReportService.js';

const uuid = z.string().uuid();
const optionalUuid = uuid.nullish();
/** Money arrives as text so an exact decimal never passes through a float. */
const decimalText = z.string().max(40).nullish();

const itemSchema = z.object({
  itemCode: z.string().min(1).max(60),
  barcode: z.string().max(60).nullish(),
  name: z.string().min(1).max(200),
  nameSecondary: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  itemType: z.enum(items.ITEM_TYPES),
  isInventoryTracked: z.boolean().optional(),
  isPurchasable: z.boolean().optional(),
  isSellable: z.boolean().optional(),
  trackingMode: z.enum(['none', 'lot', 'serial']).optional(),
  valuationMethod: z.enum(['weighted-average', 'standard', 'fifo']).optional(),
  baseUnitId: uuid,
  defaultSellingPrice: decimalText,
  defaultPurchasePrice: decimalText,
  standardCost: decimalText,
  salesDescription: z.string().max(2000).optional(),
  purchaseDescription: z.string().max(2000).optional(),
  salesTaxCodeId: optionalUuid,
  purchaseTaxCodeId: optionalUuid,
  inventoryAccountId: optionalUuid,
  cogsAccountId: optionalUuid,
  salesAccountId: optionalUuid,
  purchaseAccountId: optionalUuid,
  inventoryAdjustmentAccountId: optionalUuid,
}).strict();

const warehouseSchema = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  warehouseType: z.enum(warehouses.WAREHOUSE_TYPES).optional(),
  location: z.string().max(500).optional(),
}).strict();

const unitSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(120),
  symbol: z.string().max(20).optional(),
  category: z.enum(units.UNIT_CATEGORIES).optional(),
  decimalPlaces: z.number().int().min(0).max(6).optional(),
}).strict();

/*
 * Money and quantity arrive as TEXT and stay text. A JSON number has already
 * lost the third decimal place by the time it reaches here, and a quantity is
 * as exact a figure as an amount.
 */
const decimalString = z.string().regex(/^\d+(\.\d+)?$/, 'Enter a plain positive decimal.').max(40);

const lineSchema = z.object({
  itemId: uuid,
  warehouseId: uuid.optional(),
  quantity: decimalString,
  unitCost: decimalString.nullish(),
  expenseAccountId: optionalUuid,
  direction: z.enum(['in', 'out']).optional(),
}).strict();

/**
 * The document body.
 *
 * `.strict()` is doing real work: a caller sending a lot, a serial, a bin, an
 * alternate unit, a currency or a bill reference is refused by name rather than
 * having the field quietly dropped, which is how a client comes to believe this
 * slice tracks something it does not.
 */
const documentSchema = z.object({
  kind: z.enum(['receipt', 'issue', 'transfer', 'adjustment']),
  movementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  postingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reference: z.string().max(120).optional(),
  memo: z.string().max(2000).optional(),
  reason: z.string().max(500).optional(),
  idempotencyKey: z.string().min(1).max(128),
  sourceWarehouseId: uuid.optional(),
  destinationWarehouseId: uuid.optional(),
  lines: z.array(lineSchema).min(1).max(200),
}).strict();

const reverseStockSchema = z.object({
  expectedVersion: z.number().int().min(1),
  reason: z.string().min(1).max(500),
}).strict();

const settingsSchema = z.object({
  defaultValuationMethod: z.enum(['weighted-average', 'standard']).optional(),
  defaultWarehouseId: optionalUuid,
  defaultInventoryAccountId: optionalUuid,
  defaultCogsAccountId: optionalUuid,
  defaultSalesAccountId: optionalUuid,
  defaultPurchaseAccountId: optionalUuid,
  goodsReceivedNotInvoicedAccountId: optionalUuid,
  inventoryGainAccountId: optionalUuid,
  inventoryLossAccountId: optionalUuid,
  stockInTransitAccountId: optionalUuid,
}).strict();

const versioned = z.object({ expectedVersion: z.number().int().min(0) });
const archiveSchema = versioned.extend({ archived: z.boolean() });

const listItemsSchema = z.object({
  status: z.enum(['active', 'inactive', 'archived']).optional(),
  itemType: z.enum(items.ITEM_TYPES).optional(),
  tracked: z.enum(['true', 'false']).optional(),
  search: z.string().max(200).optional(),
  limit: z.string().regex(/^\d{1,3}$/).optional(),
});

const listWarehousesSchema = z.object({
  status: z.enum(['active', 'inactive', 'archived']).optional(),
  search: z.string().max(200).optional(),
  limit: z.string().regex(/^\d{1,3}$/).optional(),
});

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of result.error.issues) {
      fieldErrors[issue.path.join('.') || 'form'] ??= issue.message;
    }
    throw errors.validation('Check the details and try again.', { fieldErrors });
  }
  return result.data;
}

function actorOf(request: FastifyRequest): InventoryActor {
  if (!request.permissions) throw errors.forbidden('You do not have access to this organization.');
  return {
    organizationId: request.permissions.organizationId,
    companyId: companyOf(request).id,
    userId: request.principal!.user.id,
    name: request.principal!.user.full_name,
    requestId: request.id,
  };
}

const idOf = (request: FastifyRequest): string => {
  const { id } = request.params as { id?: string };
  if (!id) throw errors.validation('An identifier is required.');
  return id;
};

export async function inventoryRoutes(app: FastifyInstance): Promise<void> {
  /* The shared catalogue: same gate as customers and vendors. */
  const viewItems = requireOwnOrganizationPermission('items', 'view');
  const createItems = requireOwnOrganizationPermission('items', 'create');
  const editItems = requireOwnOrganizationPermission('items', 'edit');

  /* Inventory proper. */
  const viewInventory = requireOwnOrganizationPermission('inventory', 'view');
  const createInventory = requireOwnOrganizationPermission('inventory', 'create');
  const editInventory = requireOwnOrganizationPermission('inventory', 'edit');

  const onBooks = (
    ...guards: Array<ReturnType<typeof requireOwnOrganizationPermission>>
  ) => [...guards, requireCompanyScope];

  /* ── Items ──────────────────────────────────────────────────────────────── */

  app.get('/api/inventory/items', { preHandler: onBooks(viewItems) }, async (request, reply) => {
    const query = parse(listItemsSchema, request.query);
    return reply.send({
      items: await items.listItems(app.db, actorOf(request), {
        status: query.status,
        itemType: query.itemType,
        tracked: query.tracked === undefined ? undefined : query.tracked === 'true',
        search: query.search,
        limit: query.limit ? Number(query.limit) : undefined,
      }),
    });
  });

  app.get('/api/inventory/items/:id', { preHandler: onBooks(viewItems) }, async (request, reply) =>
    reply.send({ item: await items.getItem(app.db, actorOf(request), idOf(request)) }));

  app.get(
    '/api/inventory/items/:id/history',
    { preHandler: onBooks(viewItems) },
    async (request, reply) =>
      reply.send({ events: await items.itemHistory(app.db, actorOf(request), idOf(request)) }),
  );

  app.post('/api/inventory/items', { preHandler: onBooks(createItems) }, async (request, reply) => {
    const body = parse(itemSchema, request.body ?? {});
    const created = await items.createItem(app.db, actorOf(request), body);
    return reply.code(201).send({ item: created });
  });

  app.patch('/api/inventory/items/:id', { preHandler: onBooks(editItems) }, async (request, reply) => {
    const body = parse(itemSchema.merge(versioned), request.body ?? {});
    const { expectedVersion, ...input } = body;
    return reply.send({
      item: await items.updateItem(
        app.db, actorOf(request), idOf(request), expectedVersion, input,
      ),
    });
  });

  /*
   * Archive and reactivate, never delete. An item is named by documents that
   * have already been issued; removing the row would leave them pointing at
   * nothing, which is the exact state migration 037 refuses to create.
   */
  app.post(
    '/api/inventory/items/:id/archive',
    { preHandler: onBooks(editItems) },
    async (request, reply) => {
      const body = parse(archiveSchema, request.body ?? {});
      return reply.send({
        item: await items.setItemArchived(
          app.db, actorOf(request), idOf(request), body.expectedVersion, body.archived,
        ),
      });
    },
  );

  /* ── Units ──────────────────────────────────────────────────────────────── */

  /* Readable on the ITEM gate: an item must name a base unit. */
  app.get('/api/inventory/units', { preHandler: onBooks(viewItems) }, async (request, reply) =>
    reply.send({
      units: await units.listUnits(app.db, actorOf(request), {
        status: (request.query as { status?: string }).status,
        search: (request.query as { search?: string }).search,
      }),
      /* Said in the payload so a client cannot quietly assume conversions. */
      conversionsSupported: false,
      conversionNote: units.CONVERSION_DEFERRED,
    }));

  app.post('/api/inventory/units', { preHandler: onBooks(createInventory) }, async (request, reply) => {
    const body = parse(unitSchema, request.body ?? {});
    return reply.code(201).send({ unit: await units.createUnit(app.db, actorOf(request), body) });
  });

  app.patch('/api/inventory/units/:id', { preHandler: onBooks(editInventory) }, async (request, reply) => {
    const body = parse(unitSchema.merge(versioned), request.body ?? {});
    const { expectedVersion, ...input } = body;
    return reply.send({
      unit: await units.updateUnit(app.db, actorOf(request), idOf(request), expectedVersion, input),
    });
  });

  app.post(
    '/api/inventory/units/:id/archive',
    { preHandler: onBooks(editInventory) },
    async (request, reply) => {
      const body = parse(archiveSchema, request.body ?? {});
      return reply.send({
        unit: await units.setUnitArchived(
          app.db, actorOf(request), idOf(request), body.expectedVersion, body.archived,
        ),
      });
    },
  );

  /* ── Warehouses ─────────────────────────────────────────────────────────── */

  app.get('/api/inventory/warehouses', { preHandler: onBooks(viewInventory) }, async (request, reply) => {
    const query = parse(listWarehousesSchema, request.query);
    return reply.send({
      warehouses: await warehouses.listWarehouses(app.db, actorOf(request), {
        status: query.status,
        search: query.search,
        limit: query.limit ? Number(query.limit) : undefined,
      }),
    });
  });

  app.get(
    '/api/inventory/warehouses/:id',
    { preHandler: onBooks(viewInventory) },
    async (request, reply) =>
      reply.send({
        warehouse: await warehouses.getWarehouse(app.db, actorOf(request), idOf(request)),
      }),
  );

  app.get(
    '/api/inventory/warehouses/:id/history',
    { preHandler: onBooks(viewInventory) },
    async (request, reply) =>
      reply.send({
        events: await warehouses.warehouseHistory(app.db, actorOf(request), idOf(request)),
      }),
  );

  app.post(
    '/api/inventory/warehouses',
    { preHandler: onBooks(createInventory) },
    async (request, reply) => {
      const body = parse(warehouseSchema, request.body ?? {});
      const created = await warehouses.createWarehouse(app.db, actorOf(request), body);
      return reply.code(201).send({ warehouse: created });
    },
  );

  app.patch(
    '/api/inventory/warehouses/:id',
    { preHandler: onBooks(editInventory) },
    async (request, reply) => {
      const body = parse(warehouseSchema.merge(versioned), request.body ?? {});
      const { expectedVersion, ...input } = body;
      return reply.send({
        warehouse: await warehouses.updateWarehouse(
          app.db, actorOf(request), idOf(request), expectedVersion, input,
        ),
      });
    },
  );

  app.post(
    '/api/inventory/warehouses/:id/archive',
    { preHandler: onBooks(editInventory) },
    async (request, reply) => {
      const body = parse(archiveSchema, request.body ?? {});
      return reply.send({
        warehouse: await warehouses.setWarehouseArchived(
          app.db, actorOf(request), idOf(request), body.expectedVersion, body.archived,
        ),
      });
    },
  );

  /* -- Stock documents ---------------------------------------------------- */

  /*
   * Posting moves the LEDGER, so it needs `post` rather than `edit` -- the same
   * separation the general journal, invoices and bills already make. Reversing
   * is the same class of act as voiding.
   */
  const postStock = requireOwnOrganizationPermission('inventory', 'post');
  const voidStock = requireOwnOrganizationPermission('inventory', 'void');

  app.get('/api/inventory/documents', { preHandler: onBooks(viewInventory) }, async (request, reply) => {
    const query = request.query as { kind?: string; status?: string; search?: string; limit?: string };
    return reply.send({
      documents: await stock.listDocuments(app.db, actorOf(request), {
        kind: query.kind as stock.DocumentKind | undefined,
        status: query.status as 'posted' | 'reversed' | undefined,
        search: query.search,
        limit: query.limit ? Number(query.limit) : undefined,
      }),
    });
  });

  app.get(
    '/api/inventory/documents/:id',
    { preHandler: onBooks(viewInventory) },
    async (request, reply) =>
      reply.send({ document: await stock.getDocument(app.db, actorOf(request), idOf(request)) }),
  );

  app.post('/api/inventory/documents', { preHandler: onBooks(postStock) }, async (request, reply) => {
    const body = parse(documentSchema, request.body ?? {});
    const { document, created } = await stock.postDocument(app.db, actorOf(request), body);
    /*
     * 200 rather than 201 when the key had already posted: the caller's retry
     * succeeded, and reporting it as a fresh creation would have them believe
     * they now hold two documents.
     */
    return reply.code(created ? 201 : 200).send({ document, created });
  });

  app.post(
    '/api/inventory/documents/:id/reverse',
    { preHandler: onBooks(voidStock) },
    async (request, reply) => {
      const body = parse(reverseStockSchema, request.body ?? {});
      return reply.send({
        document: await stock.reverseDocument(
          app.db, actorOf(request), idOf(request), body.expectedVersion, body.reason,
        ),
      });
    },
  );

  /* -- Reads derived from the ledger, never from a cache ------------------- */

  app.get('/api/inventory/stock-on-hand', { preHandler: onBooks(viewInventory) }, async (request, reply) => {
    const query = request.query as {
      itemId?: string; warehouseId?: string; asOfDate?: string; includeEmpty?: string;
    };
    return reply.send({
      rows: await reports.stockOnHand(app.db, actorOf(request), {
        itemId: query.itemId,
        warehouseId: query.warehouseId,
        asOfDate: query.asOfDate,
        includeEmpty: query.includeEmpty === 'true',
      }),
    });
  });

  app.get('/api/inventory/valuation', { preHandler: onBooks(viewInventory) }, async (request, reply) => {
    const query = request.query as { asOfDate?: string };
    return reply.send(await reports.valuation(app.db, actorOf(request), { asOfDate: query.asOfDate }));
  });

  app.get(
    '/api/inventory/items/:id/stock-card',
    { preHandler: onBooks(viewInventory) },
    async (request, reply) => {
      const query = request.query as { warehouseId?: string; from?: string; to?: string };
      return reply.send({
        entries: await reports.stockCard(app.db, actorOf(request), idOf(request), query),
      });
    },
  );

  app.get('/api/inventory/reconciliation', { preHandler: onBooks(viewInventory) }, async (request, reply) => {
    const query = request.query as { asOfDate?: string };
    return reply.send(await reports.reconcile(app.db, actorOf(request), { asOfDate: query.asOfDate }));
  });

  /* -- The accounting profile --------------------------------------------- */

  app.get('/api/inventory/settings', { preHandler: onBooks(viewInventory) }, async (request, reply) =>
    reply.send({ settings: await settings.getSettings(app.db, actorOf(request)) }));

  app.patch(
    '/api/inventory/settings',
    { preHandler: onBooks(editInventory) },
    async (request, reply) => {
      const body = parse(settingsSchema.merge(versioned), request.body ?? {});
      const { expectedVersion, ...input } = body;
      return reply.send({
        settings: await settings.updateSettings(app.db, actorOf(request), expectedVersion, input),
      });
    },
  );
}

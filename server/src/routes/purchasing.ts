/**
 * Advanced Purchasing AP1 — purchase orders, goods receipts and the
 * received-not-invoiced schedule.
 *
 * ══ Three gates on every route, in this order ════════════════════════════════
 *
 *  1. `requireOwnOrganizationPermission` derives the organization from the
 *     CALLER'S OWN membership — never from the request — and resolves the
 *     permission through the one resolver, which applies the tenant's
 *     entitlement above every user rule. A tenant without `inventory_advanced`
 *     is refused here, whatever their role says.
 *  2. `requireCompanyScope` settles WHICH of the caller's own companies the
 *     request concerns, from the company-reference header.
 *  3. The durable-write guard, registered globally, refuses every mutation from
 *     an organization whose subscription is not active.
 *
 * Page visibility is not one of them, and never stands in for one of them.
 *
 * ══ Why every schema is `.strict()` ══════════════════════════════════════════
 *
 * A caller that sends a unit cost, a total, a match state, a lot, a project or
 * a purchase-order reference on a bill is refused by NAME rather than having
 * the field quietly dropped. Silently discarding a field is how a client comes
 * to believe this slice tracks something it does not — and then acts on it.
 *
 * ══ Where the goods receipt is NOT ═══════════════════════════════════════════
 *
 * There is no `/api/inventory/goods-receipts`. A receipt is a purchasing
 * document that happens to move stock, and it lives beside the order that
 * authorises it. A second path onto the same records would be a second place
 * for its rules to drift.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errors } from '../lib/errors.js';
import { requireOwnOrganizationPermission } from '../guards/permissions.js';
import { requireCompanyScope, companyOf } from '../guards/companyScope.js';
import type { InventoryActor } from '../services/inventory/inventoryCore.js';
import * as orders from '../services/purchasing/purchaseOrderService.js';
import * as receipts from '../services/purchasing/goodsReceiptService.js';
import * as matching from '../services/purchasing/receiptMatching.js';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format yyyy-mm-dd.');
/* Money and quantity arrive as TEXT and stay text: a JSON number has already
 * lost the third decimal place by the time it reaches here. */
const decimalString = z.string().regex(/^\d+(\.\d+)?$/, 'Enter a plain positive decimal.').max(40);

const orderLineSchema = z.object({
  itemId: uuid,
  warehouseId: uuid,
  description: z.string().max(2000).optional(),
  quantity: decimalString,
  unitPrice: decimalString,
  discountType: z.enum(['percentage', 'amount']).nullish(),
  discountValue: decimalString.nullish(),
  /* The tax CODE, and nothing else about the tax. */
  taxCodeId: uuid.nullish(),
}).strict();

const orderSchema = z.object({
  supplierId: uuid,
  orderDate: isoDate,
  expectedDate: isoDate.nullish(),
  supplierReference: z.string().max(120).optional(),
  memo: z.string().max(2000).optional(),
  currency: z.string().max(10).optional(),
  lines: z.array(orderLineSchema).min(1).max(200),
}).strict();

const versioned = z.object({ expectedVersion: z.number().int().min(0) }).strict();
const withReason = versioned.extend({ reason: z.string().min(1).max(500) }).strict();

/**
 * A receipt line names an order line and a quantity. That is the whole shape.
 *
 * `.strict()` is doing the real work here: an item, a warehouse, a unit cost, a
 * remaining quantity or a match state arriving with the request is rejected
 * outright rather than dropped, because a client that could send any of them
 * could decide what its own stock is worth.
 */
const receiptLineSchema = z.object({
  orderLineId: uuid,
  quantity: decimalString,
}).strict();

const receiptSchema = z.object({
  orderId: uuid,
  receiptDate: isoDate,
  postingDate: isoDate.optional(),
  deliveryNoteReference: z.string().max(120).optional(),
  memo: z.string().max(2000).optional(),
  idempotencyKey: z.string().min(1).max(128),
  lines: z.array(receiptLineSchema).min(1).max(200),
}).strict();

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

export async function purchasingRoutes(app: FastifyInstance): Promise<void> {
  const viewOrders = requireOwnOrganizationPermission('purchase_orders', 'view');
  const createOrders = requireOwnOrganizationPermission('purchase_orders', 'create');
  const editOrders = requireOwnOrganizationPermission('purchase_orders', 'edit');
  /* Approving and issuing are one authority: committing the business outward. */
  const approveOrders = requireOwnOrganizationPermission('purchase_orders', 'approve');
  /* Closing and cancelling abandon a commitment — the same class as voiding. */
  const voidOrders = requireOwnOrganizationPermission('purchase_orders', 'void');

  const viewReceipts = requireOwnOrganizationPermission('goods_receipts', 'view');
  /* Receiving IS posting: a receipt is captured and posted in one call. */
  const postReceipts = requireOwnOrganizationPermission('goods_receipts', 'post');
  const voidReceipts = requireOwnOrganizationPermission('goods_receipts', 'void');

  const viewGrni = requireOwnOrganizationPermission('received_not_invoiced', 'view');
  /* Matching decides which accrual an invoice takes away: its own authority. */
  const viewMatching = requireOwnOrganizationPermission('receipt_matching', 'view');

  const onBooks = (
    ...guards: Array<ReturnType<typeof requireOwnOrganizationPermission>>
  ) => [...guards, requireCompanyScope];

  /* ── Purchase orders ────────────────────────────────────────────────────── */

  app.get('/api/purchasing/orders', { preHandler: onBooks(viewOrders) }, async (request, reply) => {
    const query = request.query as {
      status?: string; supplierId?: string; open?: string; search?: string; limit?: string;
    };
    return reply.send({
      orders: await orders.listOrders(app.db, actorOf(request), {
        status: query.status as orders.OrderStatus | undefined,
        supplierId: query.supplierId,
        open: query.open === 'true',
        search: query.search,
        limit: query.limit ? Number(query.limit) : undefined,
      }),
    });
  });

  /*
   * The open book: every order line with something still to come, derived from
   * the orders and the receipts at the moment of asking. There is no stored
   * open quantity that could be stale.
   */
  app.get(
    '/api/purchasing/orders/open-lines',
    { preHandler: onBooks(viewOrders) },
    async (request, reply) => {
      const query = request.query as { supplierId?: string; itemId?: string; warehouseId?: string };
      return reply.send({ lines: await orders.openOrderLines(app.db, actorOf(request), query) });
    },
  );

  app.get(
    '/api/purchasing/orders/:id',
    { preHandler: onBooks(viewOrders) },
    async (request, reply) =>
      reply.send({ order: await orders.getOrder(app.db, actorOf(request), idOf(request)) }),
  );

  app.get(
    '/api/purchasing/orders/:id/history',
    { preHandler: onBooks(viewOrders) },
    async (request, reply) =>
      reply.send({ events: await orders.orderHistory(app.db, actorOf(request), idOf(request)) }),
  );

  app.post('/api/purchasing/orders', { preHandler: onBooks(createOrders) }, async (request, reply) => {
    const body = parse(orderSchema, request.body ?? {});
    const created = await orders.createOrder(app.db, actorOf(request), body);
    return reply.code(201).send({ order: created });
  });

  app.patch(
    '/api/purchasing/orders/:id',
    { preHandler: onBooks(editOrders) },
    async (request, reply) => {
      const body = parse(orderSchema.merge(versioned), request.body ?? {});
      const { expectedVersion, ...input } = body;
      return reply.send({
        order: await orders.updateOrder(
          app.db, actorOf(request), idOf(request), expectedVersion, input,
        ),
      });
    },
  );

  app.post(
    '/api/purchasing/orders/:id/approve',
    { preHandler: onBooks(approveOrders) },
    async (request, reply) => {
      const body = parse(versioned, request.body ?? {});
      return reply.send({
        order: await orders.approveOrder(
          app.db, actorOf(request), idOf(request), body.expectedVersion,
        ),
      });
    },
  );

  app.post(
    '/api/purchasing/orders/:id/issue',
    { preHandler: onBooks(approveOrders) },
    async (request, reply) => {
      const body = parse(versioned, request.body ?? {});
      return reply.send({
        order: await orders.issueOrder(
          app.db, actorOf(request), idOf(request), body.expectedVersion,
        ),
      });
    },
  );

  app.post(
    '/api/purchasing/orders/:id/close',
    { preHandler: onBooks(voidOrders) },
    async (request, reply) => {
      const body = parse(withReason, request.body ?? {});
      return reply.send({
        order: await orders.closeOrder(
          app.db, actorOf(request), idOf(request), body.expectedVersion, body.reason,
        ),
      });
    },
  );

  app.post(
    '/api/purchasing/orders/:id/cancel',
    { preHandler: onBooks(voidOrders) },
    async (request, reply) => {
      const body = parse(withReason, request.body ?? {});
      return reply.send({
        order: await orders.cancelOrder(
          app.db, actorOf(request), idOf(request), body.expectedVersion, body.reason,
        ),
      });
    },
  );

  /* ── Goods receipts ─────────────────────────────────────────────────────── */

  app.get(
    '/api/purchasing/receipts',
    { preHandler: onBooks(viewReceipts) },
    async (request, reply) => {
      const query = request.query as {
        orderId?: string; supplierId?: string; status?: string;
        awaitingInvoice?: string; limit?: string;
      };
      return reply.send({
        receipts: await receipts.listReceipts(app.db, actorOf(request), {
          orderId: query.orderId,
          supplierId: query.supplierId,
          status: query.status as receipts.ReceiptStatus | undefined,
          awaitingInvoice: query.awaitingInvoice === 'true',
          limit: query.limit ? Number(query.limit) : undefined,
        }),
        /*
         * Said in the payload rather than assumed by a screen: matching exists,
         * it is exact, and what it still refuses is named in the note.
         */
        matchingSupported: true,
        matchingNote: receipts.MATCHING_DEFERRED,
      });
    },
  );

  app.get(
    '/api/purchasing/receipts/:id',
    { preHandler: onBooks(viewReceipts) },
    async (request, reply) =>
      reply.send({ receipt: await receipts.getReceipt(app.db, actorOf(request), idOf(request)) }),
  );

  app.get(
    '/api/purchasing/receipts/:id/history',
    { preHandler: onBooks(viewReceipts) },
    async (request, reply) =>
      reply.send({ events: await receipts.receiptHistory(app.db, actorOf(request), idOf(request)) }),
  );

  app.post(
    '/api/purchasing/receipts',
    { preHandler: onBooks(postReceipts) },
    async (request, reply) => {
      const body = parse(receiptSchema, request.body ?? {});
      const { receipt, created } = await receipts.postReceipt(app.db, actorOf(request), body);
      /*
       * 200 rather than 201 when the key had already posted: the caller's retry
       * succeeded, and reporting it as a fresh creation would have them believe
       * the delivery had been received twice.
       */
      return reply.code(created ? 201 : 200).send({ receipt, created });
    },
  );

  app.post(
    '/api/purchasing/receipts/:id/reverse',
    { preHandler: onBooks(voidReceipts) },
    async (request, reply) => {
      const body = parse(withReason, request.body ?? {});
      return reply.send({
        receipt: await receipts.reverseReceipt(
          app.db, actorOf(request), idOf(request), body.expectedVersion, body.reason,
        ),
      });
    },
  );

  /* ── Receipt matching ───────────────────────────────────────────────────── */

  /*
   * The receipt lines a supplier bill may still settle, with what each one has
   * left. Derived from the receipts and the ACTIVE clearings at the moment of
   * asking — there is no stored open quantity to go stale, and a screen that
   * showed one could offer capacity another bill had already taken.
   */
  app.get(
    '/api/purchasing/matching/eligible',
    { preHandler: onBooks(viewMatching) },
    async (request, reply) => {
      const query = request.query as { supplierId?: string; orderId?: string; receiptId?: string };
      return reply.send({
        lines: await matching.eligibleReceiptLines(app.db, actorOf(request), query),
        /*
         * The rule, in the payload, so a screen states it rather than a user
         * discovering it when a bill is refused.
         */
        exactValueRequired: true,
        varianceNote: matching.VARIANCE_DEFERRED,
      });
    },
  );

  app.get(
    '/api/purchasing/matching/history',
    { preHandler: onBooks(viewMatching) },
    async (request, reply) => {
      const query = request.query as {
        supplierId?: string; receiptId?: string; billId?: string;
        status?: string; limit?: string;
      };
      return reply.send({
        matches: await matching.matchHistory(app.db, actorOf(request), {
          supplierId: query.supplierId,
          receiptId: query.receiptId,
          billId: query.billId,
          status: query.status as 'active' | 'reversed' | undefined,
          limit: query.limit ? Number(query.limit) : undefined,
        }),
      });
    },
  );

  /* ── Received not invoiced ──────────────────────────────────────────────── */

  app.get('/api/purchasing/grni/aging', { preHandler: onBooks(viewGrni) }, async (request, reply) => {
    const query = request.query as { asOfDate?: string };
    return reply.send(await matching.grniAging(app.db, actorOf(request), query));
  });

  app.get('/api/purchasing/grni', { preHandler: onBooks(viewGrni) }, async (request, reply) => {
    const query = request.query as { asOfDate?: string; supplierId?: string; itemId?: string };
    return reply.send(await receipts.grniSchedule(app.db, actorOf(request), query));
  });
}

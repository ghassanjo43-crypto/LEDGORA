/**
 * Supplier bills over HTTP.
 *
 * ══ What the client may not decide ═══════════════════════════════════════════
 *
 * Organization comes from the caller's membership, company from the selector
 * header resolved by `requireCompanyScope`, and the actor from the session.
 * None is read from a body, so a request cannot name another tenant's books
 * however it is shaped.
 *
 * Neither is the bill number, the status, the totals, the payable account or
 * any tax figure — each has its own refusal in `billService`, because a field
 * that arrives and is quietly ignored is worse than one that is rejected.
 *
 * ══ Separate permissions for separate acts ═══════════════════════════════════
 *
 * `bills.create/edit` author a draft; `bills.post` changes the LEDGER;
 * `bills.void` reverses a posted document; `bills.delete` removes a draft that
 * never reached the books. They are distinct because the harm they can do is
 * distinct, and the existing catalogue already separates them.
 *
 * ══ Durable writes need an active subscription ═══════════════════════════════
 *
 * Not asserted here. `enforcePersistenceEntitlement` is a global hook refusing
 * every mutating method outside the subscription-lifecycle allow-list, so
 * `/api/bills` is protected the day it is written rather than the day somebody
 * remembers to add it. Reads are never blocked.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errors } from '../lib/errors.js';
import { requireOwnOrganizationPermission } from '../guards/permissions.js';
import { requireCompanyScope, companyOf } from '../guards/companyScope.js';
import type { AccountingActor } from '../services/accounting/audit.js';
import * as bills from '../services/purchasing/billService.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format yyyy-mm-dd.');
/** Money and quantities are STRINGS. A JSON number is a double. */
const decimal = z.string().max(40);

/*
 * The line schema is deliberately PERMISSIVE about unknown keys — `passthrough`
 * — so a tax code or a warehouse arriving from an older client reaches the
 * service and is REFUSED BY NAME there. Stripping them here would silently
 * discard exactly what the boundary exists to reject.
 */
const lineSchema = z.object({
  description: z.string().max(500).optional(),
  /*
   * Optional, because two kinds of line have their account DERIVED rather than
   * chosen: a stocked line posts to the item's own inventory account, and a
   * receipt-matched line to the goods-received-not-invoiced account its receipt
   * credited. The service still requires one from every other line.
   */
  accountId: z.string().uuid().optional(),
  /** The AP1 goods-receipt line this line settles, and how much of it. */
  receiptLineId: z.string().uuid().nullable().optional(),
  matchedQuantity: decimal.nullable().optional(),
  quantity: decimal.optional(),
  unit: z.string().max(40).optional(),
  unitPrice: decimal.optional(),
  discountType: z.enum(['percentage', 'amount']).nullable().optional(),
  discountValue: decimal.nullable().optional(),
  /*
   * The tax CODE, and nothing else about the tax.
   *
   * There is deliberately no rate, amount, base, category, method,
   * recoverability or snapshot here — every one is refused by the service, and
   * `passthrough` is what lets an older client's attempt REACH that refusal
   * instead of being silently stripped.
   */
  taxCodeId: z.string().uuid().nullable().optional(),
}).passthrough();

const billBody = {
  /*
   * Stated by the caller and CHECKED against the lines by the service, which
   * refuses a disagreement. Optional, so an existing client keeps working and
   * the derivation stays the authority either way.
   */
  workflow: z.enum(['expense', 'stocked-direct', 'receipt-matched']).optional(),
  supplierInvoiceNumber: z.string().max(120).optional(),
  billDate: isoDate,
  postingDate: isoDate.optional(),
  dueDate: isoDate,
  memo: z.string().max(4000).optional(),
  currency: z.string().max(10).optional(),
  lines: z.array(lineSchema).min(1).max(200),
};

const createSchema = z.object({
  issuingEntityId: z.string().min(1).max(120),
  supplierId: z.string().uuid(),
  ...billBody,
}).passthrough();

const updateSchema = z.object({
  expectedVersion: z.number().int().min(1),
  supplierId: z.string().uuid().optional(),
  ...billBody,
}).passthrough();

const versionSchema = z.object({ expectedVersion: z.number().int().min(1) });

const postSchema = z.object({
  expectedVersion: z.number().int().min(1),
  /**
   * An explicit acknowledgement that the supplier's reference is already on a
   * posted bill. The audited behaviour refuses the duplicate and allows this
   * override, so it is a deliberate flag rather than a silent default.
   */
  overrideDuplicate: z.boolean().optional(),
});

const reverseSchema = z.object({
  expectedVersion: z.number().int().min(1),
  reason: z.string().min(1).max(500),
});

const listSchema = z.object({
  status: z.enum(['draft', 'posted', 'reversed']).optional(),
  supplierId: z.string().uuid().optional(),
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
    throw errors.validation('Check the bill details and try again.', { fieldErrors });
  }
  return result.data;
}

function actorOf(request: FastifyRequest): AccountingActor {
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

export async function billRoutes(app: FastifyInstance): Promise<void> {
  const viewBills = requireOwnOrganizationPermission('bills', 'view');
  const createBills = requireOwnOrganizationPermission('bills', 'create');
  const editBills = requireOwnOrganizationPermission('bills', 'edit');
  /* Posting changes the LEDGER, so it needs `post` rather than `edit` — the
   * same separation the general journal and sales invoices already make. */
  const postBills = requireOwnOrganizationPermission('bills', 'post');
  /* Reversing a posted document is the same class of act as voiding one. */
  const voidBills = requireOwnOrganizationPermission('bills', 'void');
  const deleteBills = requireOwnOrganizationPermission('bills', 'delete');

  const onBooks = (
    ...guards: Array<ReturnType<typeof requireOwnOrganizationPermission>>
  ) => [...guards, requireCompanyScope];

  /*
   * Naming goods receipts on a bill needs its own authority, checked here
   * rather than in a preHandler because whether a bill matches anything is a
   * property of its BODY, not of its route. Writing a bill and deciding which
   * accrual it takes away are different acts: a wrong match clears goods the
   * supplier never sent, and the payable then settles an accrual that should
   * still be open.
   */
  const assertMayMatch = (request: FastifyRequest, body: { lines?: unknown[] }): void => {
    const matches = (body.lines ?? []).some(
      (line) => Boolean((line as { receiptLineId?: string | null }).receiptLineId),
    );
    if (!matches) return;
    const effective = request.permissions;
    if (!effective?.allowedKeys.includes('receipt_matching:post')) {
      throw errors.forbidden(
        'You may write a bill but not match it to goods receipts. Matching decides which '
        + 'goods-received accrual an invoice clears, which is a separate authority.',
      );
    }
  };

  app.get('/api/bills', { preHandler: onBooks(viewBills) }, async (request, reply) => {
    const query = parse(listSchema, request.query);
    return reply.send({
      bills: await bills.listBills(app.db, actorOf(request), {
        status: query.status,
        supplierId: query.supplierId,
        search: query.search,
        limit: query.limit ? Number(query.limit) : undefined,
      }),
    });
  });

  app.get('/api/bills/:id', { preHandler: onBooks(viewBills) }, async (request, reply) =>
    reply.send({ bill: await bills.getBill(app.db, actorOf(request), idOf(request)) }));

  app.get('/api/bills/:id/history', { preHandler: onBooks(viewBills) }, async (request, reply) =>
    reply.send({ events: await bills.billHistory(app.db, actorOf(request), idOf(request)) }));

  app.post('/api/bills', { preHandler: onBooks(createBills) }, async (request, reply) => {
    const body = parse(createSchema, request.body ?? {});
    assertMayMatch(request, body as { lines?: unknown[] });
    return reply.code(201).send({
      bill: await bills.createDraft(app.db, actorOf(request), body as never),
    });
  });

  app.patch('/api/bills/:id', { preHandler: onBooks(editBills) }, async (request, reply) => {
    const body = parse(updateSchema, request.body ?? {});
    assertMayMatch(request, body as { lines?: unknown[] });
    return reply.send({
      bill: await bills.updateDraft(app.db, actorOf(request), idOf(request), body as never, {
        expectedVersion: body.expectedVersion,
      }),
    });
  });

  /**
   * Delete a DRAFT.
   *
   * A posted bill has no delete path at all: it leaves the books by being
   * reversed, which keeps both entries visible. Deleting one would leave a
   * journal no document explains.
   */
  app.delete('/api/bills/:id', { preHandler: onBooks(deleteBills) }, async (request, reply) => {
    const body = parse(versionSchema, request.body ?? {});
    await bills.deleteDraft(app.db, actorOf(request), idOf(request), {
      expectedVersion: body.expectedVersion,
    });
    return reply.code(204).send();
  });

  /**
   * Post the bill: the transition that creates the accounting entry.
   *
   *     Dr each line's net → its own expense or asset account
   *         Cr the supplier's payable → the bill total
   */
  app.post('/api/bills/:id/post', { preHandler: onBooks(postBills) }, async (request, reply) => {
    const body = parse(postSchema, request.body ?? {});
    return reply.send({
      bill: await bills.postBill(app.db, actorOf(request), idOf(request), {
        expectedVersion: body.expectedVersion,
        overrideDuplicate: body.overrideDuplicate,
      }),
    });
  });

  /** Reverse a posted bill. The original entry and bill both stay as they were. */
  app.post('/api/bills/:id/reverse', { preHandler: onBooks(voidBills) }, async (request, reply) => {
    const body = parse(reverseSchema, request.body ?? {});
    return reply.send({
      bill: await bills.reverseBill(app.db, actorOf(request), idOf(request), {
        expectedVersion: body.expectedVersion,
        reason: body.reason,
      }),
    });
  });
}

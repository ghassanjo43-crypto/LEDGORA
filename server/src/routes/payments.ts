/**
 * Supplier payments over HTTP.
 *
 * ══ What the client may not decide ═══════════════════════════════════════════
 *
 * Organization comes from the caller's membership, company from the selector
 * header resolved by `requireCompanyScope`, and the actor from the session.
 * None is read from a body, so a request cannot name another tenant's books
 * however it is shaped.
 *
 * Neither is the payment number, the status, the payable account, nor any
 * unapplied balance — each has its own refusal in `paymentService`, and every
 * body schema is `passthrough` precisely so an older client's attempt REACHES
 * that refusal instead of being silently stripped.
 *
 * ══ Separate permissions for separate acts ═══════════════════════════════════
 *
 * `payments.create/edit` author a draft; `payments.post` puts money out of the
 * bank and clears a liability; `payments.void` reverses it; `payments.delete`
 * removes a draft that never reached the books.
 *
 * REALLOCATION sits on `payments.post`, not on `payments.amend`. It changes
 * nothing the supplier was told — the amount, the date and the bank entry are
 * untouched — and only restates which posted bills the same money settled. So
 * the authority it needs is the one that could have posted those allocations in
 * the first place, and requiring an Organization Admin for a routine subledger
 * correction would put ordinary bookkeeping out of the bookkeeper's reach.
 * (`payments` does not carry `amend` in the catalogue for the same reason.)
 *
 * ══ Durable writes need an active subscription ═══════════════════════════════
 *
 * Not asserted here. `enforcePersistenceEntitlement` is a global hook refusing
 * every mutating method outside the subscription-lifecycle allow-list, so
 * `/api/payments` is protected the day it is written rather than the day
 * somebody remembers to add it. Reads are never blocked.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errors } from '../lib/errors.js';
import { requireOwnOrganizationPermission } from '../guards/permissions.js';
import { requireCompanyScope, companyOf } from '../guards/companyScope.js';
import type { AccountingActor } from '../services/accounting/audit.js';
import * as payments from '../services/purchasing/paymentService.js';
import * as payables from '../services/purchasing/payablesReportService.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format yyyy-mm-dd.');
/** Money is a STRING. A JSON number is a double. */
const decimal = z.string().max(40);

const allocationSchema = z.object({
  billId: z.string().uuid(),
  amount: decimal,
}).passthrough();

const paymentBody = {
  paymentDate: isoDate,
  amount: decimal,
  method: z.string().max(60).optional(),
  reference: z.string().max(120).optional(),
  memo: z.string().max(4000).optional(),
  currency: z.string().max(10).optional(),
  cashAccountId: z.string().uuid().optional(),
};

const createSchema = z.object({
  issuingEntityId: z.string().min(1).max(120),
  supplierId: z.string().uuid(),
  ...paymentBody,
}).passthrough();

const updateSchema = z.object({
  expectedVersion: z.number().int().min(1),
  supplierId: z.string().uuid().optional(),
  ...paymentBody,
}).passthrough();

const versionSchema = z.object({ expectedVersion: z.number().int().min(1) });

/**
 * Allocations are REQUIRED on both posting and reallocation.
 *
 * `min(1)` here and a full-total check in the service: a posted payment names
 * the bills it settled, and an empty array would be a request for unapplied
 * cash the product has no account for.
 */
const allocatingSchema = z.object({
  expectedVersion: z.number().int().min(1),
  allocations: z.array(allocationSchema).min(1).max(200),
}).passthrough();

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

const statementSchema = z.object({
  supplierId: z.string().uuid(),
  periodStart: isoDate.optional(),
  periodEnd: isoDate.optional(),
});

const payablesSchema = z.object({
  asOfDate: isoDate.optional(),
  supplierId: z.string().uuid().optional(),
});

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of result.error.issues) {
      fieldErrors[issue.path.join('.') || 'form'] ??= issue.message;
    }
    throw errors.validation('Check the payment details and try again.', { fieldErrors });
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

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  const viewPayments = requireOwnOrganizationPermission('payments', 'view');
  const createPayments = requireOwnOrganizationPermission('payments', 'create');
  const editPayments = requireOwnOrganizationPermission('payments', 'edit');
  const postPayments = requireOwnOrganizationPermission('payments', 'post');
  const voidPayments = requireOwnOrganizationPermission('payments', 'void');
  const deletePayments = requireOwnOrganizationPermission('payments', 'delete');
  /* Reading what is owed is a BILLS question, not a payments one: the statement
   * and the ageing are built from bills, and someone who may not see payments
   * may still legitimately need the balance. */
  const viewBills = requireOwnOrganizationPermission('bills', 'view');

  const onBooks = (
    ...guards: Array<ReturnType<typeof requireOwnOrganizationPermission>>
  ) => [...guards, requireCompanyScope];

  app.get('/api/payments', { preHandler: onBooks(viewPayments) }, async (request, reply) => {
    const query = parse(listSchema, request.query);
    return reply.send({
      payments: await payments.listPayments(app.db, actorOf(request), {
        status: query.status,
        supplierId: query.supplierId,
        search: query.search,
        limit: query.limit ? Number(query.limit) : undefined,
      }),
    });
  });

  /*
   * Registered BEFORE `/api/payments/:id`, so `payables` and `statement` are not
   * read as payment identifiers.
   */
  app.get('/api/payments/payables', { preHandler: onBooks(viewBills) }, async (request, reply) => {
    const query = parse(payablesSchema, request.query);
    const actor = actorOf(request);
    return reply.send({
      outstanding: await payables.outstandingBills(app.db, actor, query),
      aging: await payables.agedPayables(app.db, actor, query),
    });
  });

  app.get('/api/payments/statement', { preHandler: onBooks(viewBills) }, async (request, reply) => {
    const query = parse(statementSchema, request.query);
    return reply.send({
      statement: await payables.supplierStatement(app.db, actorOf(request), query),
    });
  });

  app.get('/api/payments/:id', { preHandler: onBooks(viewPayments) }, async (request, reply) =>
    reply.send({ payment: await payments.getPayment(app.db, actorOf(request), idOf(request)) }));

  app.get('/api/payments/:id/history', { preHandler: onBooks(viewPayments) }, async (request, reply) =>
    reply.send({ events: await payments.paymentHistory(app.db, actorOf(request), idOf(request)) }));

  app.post('/api/payments', { preHandler: onBooks(createPayments) }, async (request, reply) => {
    const body = parse(createSchema, request.body ?? {});
    return reply.code(201).send({
      payment: await payments.createDraft(app.db, actorOf(request), body),
    });
  });

  app.patch('/api/payments/:id', { preHandler: onBooks(editPayments) }, async (request, reply) => {
    const body = parse(updateSchema, request.body ?? {});
    return reply.send({
      payment: await payments.updateDraft(app.db, actorOf(request), idOf(request), body, {
        expectedVersion: body.expectedVersion,
      }),
    });
  });

  /**
   * Only a DRAFT is deleted.
   *
   * A posted payment leaves the books by being reversed, which keeps both the
   * bank entry and its reversal visible and reopens the bills it settled.
   * Deleting one would leave cash out of the bank that no document explains.
   */
  app.delete('/api/payments/:id', { preHandler: onBooks(deletePayments) }, async (request, reply) => {
    const body = parse(versionSchema, request.body ?? {});
    await payments.deleteDraft(app.db, actorOf(request), idOf(request), {
      expectedVersion: body.expectedVersion,
    });
    return reply.code(204).send();
  });

  /**
   * Post the payment.
   *
   *     Dr the supplier's payable → the payment amount
   *         Cr the bank or cash account → the payment amount
   *
   * The allocations arrive with the post, because a payment is not postable
   * until it is fully allocated: they are part of the same decision, not a
   * follow-up somebody might forget.
   */
  app.post('/api/payments/:id/post', { preHandler: onBooks(postPayments) }, async (request, reply) => {
    const body = parse(allocatingSchema, request.body ?? {});
    return reply.send({
      payment: await payments.postPayment(
        app.db, actorOf(request), idOf(request),
        { allocations: body.allocations },
        { expectedVersion: body.expectedVersion },
      ),
    });
  });

  /**
   * Replace a posted payment's allocations, atomically.
   *
   * There is no unallocate route. Removing an allocation without replacing it
   * would leave unapplied cash, which the product has no account for — so the
   * only correction is a complete replacement that still totals the payment, or
   * a reversal.
   */
  app.post('/api/payments/:id/reallocate', { preHandler: onBooks(postPayments) }, async (request, reply) => {
    const body = parse(allocatingSchema, request.body ?? {});
    return reply.send({
      payment: await payments.reallocatePayment(
        app.db, actorOf(request), idOf(request),
        { allocations: body.allocations },
        { expectedVersion: body.expectedVersion },
      ),
    });
  });

  /** Reverse a posted payment: the cash comes back, and the bills reopen. */
  app.post('/api/payments/:id/reverse', { preHandler: onBooks(voidPayments) }, async (request, reply) => {
    const body = parse(reverseSchema, request.body ?? {});
    return reply.send({
      payment: await payments.reversePayment(app.db, actorOf(request), idOf(request), {
        expectedVersion: body.expectedVersion,
        reason: body.reason,
      }),
    });
  });
}

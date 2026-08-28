/**
 * Sales-invoice routes.
 *
 * Every one of these is gated by `requireOwnOrganizationPermission`, which
 * derives the organization from the CALLER'S OWN active membership and accepts
 * no identifier from the request. Tenant isolation here is a property of where
 * the value comes from, not of a check somebody has to remember to write — the
 * same reason `routes/accounting.ts` gives for the ledger.
 *
 * The permission subject is `invoices`, which already exists in the catalogue
 * gated on the coarse `invoicing` module. Every commercial package sells that
 * module, and `commercialPackageCatalogue.test.ts` fails if a subject is ever
 * gated on one no package sells — so this cannot become a screen that is
 * visible everywhere and permitted nowhere, the way Fixed Assets did.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { errors } from '../lib/errors.js';
import { requireOwnOrganizationPermission } from '../guards/permissions.js';
import { requireCompanyScope, companyOf } from '../guards/companyScope.js';
import type { AccountingActor } from '../services/accounting/audit.js';
import type { SalesInvoiceStatus } from '../db/schema.js';
import * as invoices from '../services/invoicing/invoiceService.js';
import * as imports from '../services/invoicing/invoiceImportService.js';
import * as settlement from '../services/invoicing/invoiceSettlementService.js';

/**
 * Who is acting, and on whose books.
 *
 * The organization comes from `request.permissions`; the company from
 * `request.company`, resolved by `requireCompanyScope` from the selector header
 * WITHIN that organization. Neither is read from the request payload. A null in
 * either place is a route wiring mistake and throws rather than degrading to
 * organization-wide scope.
 */
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

/**
 * The concurrency token, from the body.
 *
 * Absence is NOT normalised to "whatever is current" — it is passed through as
 * `undefined` so the service refuses it. A caller that has not read the invoice
 * cannot be allowed to overwrite it.
 */
function expectedVersionOf(body: unknown): number | undefined {
  const value = (body as { expectedVersion?: unknown })?.expectedVersion;
  return typeof value === 'number' ? value : undefined;
}

export async function invoiceRoutes(app: FastifyInstance): Promise<void> {
  const viewInvoices = requireOwnOrganizationPermission('invoices', 'view');
  const createInvoices = requireOwnOrganizationPermission('invoices', 'create');
  const editInvoices = requireOwnOrganizationPermission('invoices', 'edit');
  const deleteInvoices = requireOwnOrganizationPermission('invoices', 'delete');
  const postInvoices = requireOwnOrganizationPermission('invoices', 'post');
  const voidInvoices = requireOwnOrganizationPermission('invoices', 'void');

  /**
   * Permission first, company second — see `routes/accounting.ts` for why the
   * order is load-bearing. One helper rather than a repeated pair, because
   * omitting the company guard fails silently rather than loudly.
   */
  const onBooks = (
    ...guards: Array<ReturnType<typeof requireOwnOrganizationPermission>>
  ) => [...guards, requireCompanyScope];

  app.get('/api/invoices', { preHandler: onBooks(viewInvoices) }, async (request, reply) => {
    const { status, customerId } = request.query as { status?: SalesInvoiceStatus; customerId?: string };
    return reply.send({
      invoices: await invoices.listInvoices(app.db, actorOf(request), { status, customerId }),
    });
  });

  app.get('/api/invoices/:id', { preHandler: onBooks(viewInvoices) }, async (request, reply) =>
    reply.send({ invoice: await invoices.getInvoice(app.db, actorOf(request), idOf(request)) }),
  );

  app.get('/api/invoices/:id/history', { preHandler: onBooks(viewInvoices) }, async (request, reply) =>
    reply.send({ history: await invoices.auditHistory(app.db, actorOf(request), idOf(request)) }),
  );

  app.post('/api/invoices', { preHandler: onBooks(createInvoices) }, async (request, reply) =>
    reply.code(201).send({
      invoice: await invoices.createDraft(app.db, actorOf(request), request.body as invoices.InvoiceInput),
    }),
  );

  app.patch('/api/invoices/:id', { preHandler: onBooks(editInvoices) }, async (request, reply) => {
    const body = request.body as invoices.InvoiceInput & { expectedVersion?: number };
    return reply.send({
      invoice: await invoices.updateDraft(app.db, actorOf(request), idOf(request), body, {
        expectedVersion: expectedVersionOf(body),
      }),
    });
  });

  app.delete('/api/invoices/:id', { preHandler: onBooks(deleteInvoices) }, async (request, reply) => {
    const body = (request.body ?? {}) as { expectedVersion?: number };
    await invoices.deleteDraft(app.db, actorOf(request), idOf(request), {
      expectedVersion: expectedVersionOf(body),
    });
    return reply.code(204).send();
  });

  /*
   * Issuing posts to the ledger, so it needs `post` rather than `edit` — the
   * same separation the general journal makes between authoring a draft and
   * making it permanent.
   */
  app.post('/api/invoices/:id/issue', { preHandler: onBooks(postInvoices) }, async (request, reply) => {
    const body = (request.body ?? {}) as {
      expectedVersion?: number;
      receivableAccountId?: string;
      taxAccountId?: string;
      chargesAccountId?: string;
    };
    if (!body.receivableAccountId) {
      throw errors.validation('A receivable account is required to post this invoice.', {
        fieldErrors: { receivableAccountId: 'Choose the account this invoice debits.' },
      });
    }
    return reply.send({
      invoice: await invoices.issueInvoice(
        app.db, actorOf(request), idOf(request),
        { expectedVersion: expectedVersionOf(body) },
        body.receivableAccountId,
        body.taxAccountId,
        body.chargesAccountId,
      ),
    });
  });

  /*
   * Migration from browser storage.
   *
   * Deliberately its own endpoint rather than a flag on create: a migrated
   * invoice keeps its number, keeps its status and posts nothing to the ledger,
   * and none of those are behaviours the ordinary create path should be able to
   * be talked into. Gated on `create` — it writes invoices — and idempotent, so
   * an interrupted migration is resumed by running it again.
   */
  app.post('/api/invoices/import', { preHandler: onBooks(createInvoices) }, async (request, reply) => {
    const body = (request.body ?? {}) as { invoices?: imports.ImportedInvoice[] };
    return reply.send({
      outcome: await imports.importInvoices(app.db, actorOf(request), body.invoices ?? []),
    });
  });

  /*
   * Receipts.
   *
   * Recording one posts to the ledger, so it needs `post` — the same rule
   * issuing follows. Reversing one also posts (a reversing entry), so it needs
   * `void`: undoing a settlement is the same class of act as undoing an
   * invoice, and neither belongs to whoever can merely edit a draft.
   */
  app.get('/api/invoices/:id/payments', { preHandler: onBooks(viewInvoices) }, async (request, reply) =>
    reply.send({ payments: await settlement.listPayments(app.db, actorOf(request), idOf(request)) }),
  );

  app.post('/api/invoices/:id/payments', { preHandler: onBooks(postInvoices) }, async (request, reply) => {
    const body = (request.body ?? {}) as settlement.PaymentInput & { expectedVersion?: number };
    return reply.code(201).send({
      invoice: await settlement.recordPayment(app.db, actorOf(request), idOf(request), body, {
        expectedVersion: expectedVersionOf(body),
      }),
    });
  });

  app.post('/api/invoices/payments/:id/reverse', { preHandler: onBooks(voidInvoices) }, async (request, reply) => {
    const body = (request.body ?? {}) as { expectedVersion?: number; reason?: string };
    return reply.send({
      invoice: await settlement.reversePayment(app.db, actorOf(request), idOf(request), {
        expectedVersion: expectedVersionOf(body),
        reason: body.reason,
      }),
    });
  });

  app.post('/api/invoices/:id/void', { preHandler: onBooks(voidInvoices) }, async (request, reply) => {
    const body = (request.body ?? {}) as { expectedVersion?: number; reason?: string };
    return reply.send({
      invoice: await invoices.voidInvoice(app.db, actorOf(request), idOf(request), {
        expectedVersion: expectedVersionOf(body),
        reason: body.reason,
      }),
    });
  });
}

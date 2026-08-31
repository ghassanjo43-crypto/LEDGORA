/**
 * The supplier directory over HTTP.
 *
 * ══ Why `vendors` and not `suppliers` ════════════════════════════════════════
 *
 * Both words are already in this product and they name the SAME entity: the
 * permission subject is `vendors` ("Supplier master records and statements"),
 * while every screen and type says supplier (`EntityType = 'supplier'`,
 * `SuppliersPage`). `routes/customers.ts` says the vendor route "gets the
 * mirror of this arrangement under `vendors.*`", so the permission id and the
 * path follow that, and the user-facing wording stays "supplier". Consolidating
 * the two would rename either a permission somebody has already granted or a
 * screen somebody already uses, for no gain.
 *
 * ══ What the client may not decide ═══════════════════════════════════════════
 *
 * Organization comes from the caller's membership, company from the selector
 * header resolved by `requireCompanyScope`, and the actor from the session.
 * None is read from a body, so a request cannot name another tenant's books
 * however it is shaped. Status is not writable through create or update either:
 * archiving has its own endpoint and its own audit event.
 *
 * These endpoints write the shared party record plus the SUPPLIER profile. They
 * cannot write a customer field — not because they are careful, but because
 * `supplierService` does not touch the customer profile table at all.
 *
 * ══ Durable writes need an active subscription ═══════════════════════════════
 *
 * Not asserted here. `enforcePersistenceEntitlement` is a global hook refusing
 * every mutating method outside the subscription-lifecycle allow-list, so
 * `/api/vendors` is protected the day it is written rather than the day
 * somebody remembers to add it. Reads are never blocked.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errors } from '../lib/errors.js';
import { requireOwnOrganizationPermission } from '../guards/permissions.js';
import { requireCompanyScope, companyOf } from '../guards/companyScope.js';
import type { PartyActor } from '../services/sales/businessPartyService.js';
import * as suppliers from '../services/purchasing/supplierService.js';

const addressSchema = z.object({
  purpose: z.enum(['billing', 'shipping', 'registered']).optional(),
  isPrimary: z.boolean().optional(),
  addressLine1: z.string().max(200).optional(),
  addressLine2: z.string().max(200).optional(),
  city: z.string().max(120).optional(),
  postalCode: z.string().max(40).optional(),
  country: z.string().max(120).optional(),
});

/**
 * The supplier-role fields.
 *
 * `withholdingTaxApplicable` and `preferredPaymentMethod` are accepted as
 * MASTER DATA. Nothing posts them — there are no bills, no payments and no
 * withholding on the server — and accepting them here promises storage, not a
 * workflow.
 */
const supplierProfileSchema = z.object({
  supplierCategory: z.string().max(120).optional(),
  defaultPayableAccountId: z.string().uuid().nullable().optional(),
  defaultExpenseAccountId: z.string().uuid().nullable().optional(),
  supplierPaymentTerms: z.string().max(60).optional(),
  withholdingTaxApplicable: z.boolean().optional(),
  preferredPaymentMethod: z.string().max(60).optional(),
});

/* Shared identity. Note the absence of status, version, organization, company,
 * actor and every customer-only field: they are not the client's to choose. */
const sharedSchema = {
  tradingName: z.string().max(200).optional(),
  contactPerson: z.string().max(200).optional(),
  jobTitle: z.string().max(120).optional(),
  email: z.string().max(200).optional(),
  phone: z.string().max(60).optional(),
  mobile: z.string().max(60).optional(),
  website: z.string().max(200).optional(),
  taxRegistrationNumber: z.string().max(80).optional(),
  commercialRegistrationNumber: z.string().max(80).optional(),
  paymentTerms: z.string().max(40).optional(),
  defaultCurrency: z.string().max(10).optional(),
  bankName: z.string().max(200).optional(),
  bankAccountName: z.string().max(200).optional(),
  iban: z.string().max(60).optional(),
  swiftCode: z.string().max(30).optional(),
  notes: z.string().max(4000).optional(),
  addresses: z.array(addressSchema).max(20).optional(),
  supplier: supplierProfileSchema.optional(),
};

const createSchema = z.object({
  partyCode: z.string().min(1).max(60),
  legalName: z.string().min(1).max(200),
  ...sharedSchema,
});

const updateSchema = z.object({
  expectedVersion: z.number().int().min(1),
  partyCode: z.string().min(1).max(60).optional(),
  legalName: z.string().min(1).max(200).optional(),
  ...sharedSchema,
});

const archiveSchema = z.object({
  archived: z.boolean(),
  expectedVersion: z.number().int().min(1),
  reason: z.string().max(500).optional(),
});

const grantRoleSchema = z.object({
  expectedVersion: z.number().int().min(1),
  supplier: supplierProfileSchema.optional(),
});

const listSchema = z.object({
  search: z.string().max(200).optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
  limit: z.string().regex(/^\d{1,3}$/).optional(),
  after: z.string().max(60).optional(),
});

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of result.error.issues) {
      fieldErrors[issue.path.join('.') || 'form'] ??= issue.message;
    }
    throw errors.validation('Check the supplier details and try again.', { fieldErrors });
  }
  return result.data;
}

function actorOf(request: FastifyRequest): PartyActor {
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

export async function vendorRoutes(app: FastifyInstance): Promise<void> {
  const viewVendors = requireOwnOrganizationPermission('vendors', 'view');
  const createVendors = requireOwnOrganizationPermission('vendors', 'create');
  const editVendors = requireOwnOrganizationPermission('vendors', 'edit');
  /* Archiving is the nearest thing to removal this directory offers, so it
   * takes the removal permission rather than the editing one. */
  const archiveVendors = requireOwnOrganizationPermission('vendors', 'delete');

  const onBooks = (
    ...guards: Array<ReturnType<typeof requireOwnOrganizationPermission>>
  ) => [...guards, requireCompanyScope];

  app.get('/api/vendors', { preHandler: onBooks(viewVendors) }, async (request, reply) => {
    const query = parse(listSchema, request.query);
    const page = await suppliers.listSuppliers(app.db, actorOf(request), {
      search: query.search,
      includeArchived: query.includeArchived === 'true',
      limit: query.limit ? Number(query.limit) : undefined,
      after: query.after ?? null,
    });
    return reply.send(page);
  });

  /**
   * How many suppliers these books hold.
   *
   * Its own endpoint so a screen can tell "this company has no suppliers yet"
   * apart from "the list failed to load" — the difference between an
   * explanation and an apparently empty directory.
   */
  app.get('/api/vendors/count', { preHandler: onBooks(viewVendors) }, async (request, reply) =>
    reply.send({ count: await suppliers.countSuppliers(app.db, actorOf(request)) }));

  app.get('/api/vendors/:id', { preHandler: onBooks(viewVendors) }, async (request, reply) =>
    reply.send({ supplier: await suppliers.getSupplier(app.db, actorOf(request), idOf(request)) }));

  app.get('/api/vendors/:id/history', { preHandler: onBooks(viewVendors) }, async (request, reply) =>
    reply.send({ events: await suppliers.supplierHistory(app.db, actorOf(request), idOf(request)) }));

  app.post('/api/vendors', { preHandler: onBooks(createVendors) }, async (request, reply) => {
    const body = parse(createSchema, request.body ?? {});
    return reply.code(201).send({
      supplier: await suppliers.createSupplier(app.db, actorOf(request), body),
    });
  });

  app.patch('/api/vendors/:id', { preHandler: onBooks(editVendors) }, async (request, reply) => {
    const body = parse(updateSchema, request.body ?? {});
    return reply.send({
      supplier: await suppliers.updateSupplier(app.db, actorOf(request), idOf(request), body),
    });
  });

  /**
   * Give an existing party the supplier role.
   *
   * One legal party that both sells to us and buys from us is ONE record. The
   * party code and tax number are unique per company, so creating a second
   * record for the same entity is refused anyway; this is the path that does
   * not require inventing a second code.
   */
  app.post('/api/vendors/:id/supplier-role', { preHandler: onBooks(createVendors) }, async (request, reply) => {
    const body = parse(grantRoleSchema, request.body ?? {});
    return reply.send({
      supplier: await suppliers.grantSupplierRole(app.db, actorOf(request), idOf(request), body),
    });
  });

  /**
   * Archive or restore. There is no delete.
   *
   * A supplier named on a document must stay identifiable for as long as the
   * document does, so it leaves circulation by being archived.
   */
  app.post('/api/vendors/:id/archive', { preHandler: onBooks(archiveVendors) }, async (request, reply) => {
    const body = parse(archiveSchema, request.body ?? {});
    return reply.send({
      supplier: await suppliers.setSupplierArchived(app.db, actorOf(request), idOf(request), body),
    });
  });
}

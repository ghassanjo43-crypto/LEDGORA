/**
 * The customer directory over HTTP.
 *
 * ══ One party, one role's route ══════════════════════════════════════════════
 *
 * These endpoints are guarded by `customers.*` and write the shared party record
 * plus the customer profile. They cannot write a supplier field — not because
 * they are careful, but because `businessPartyService` does not touch the
 * supplier profile table at all. The vendor route, when Purchasing arrives, gets
 * the mirror of this arrangement under `vendors.*`.
 *
 * ══ What the client may not decide ═══════════════════════════════════════════
 *
 * Organization comes from the caller's membership, company from the selector
 * header resolved by `requireCompanyScope`, and the actor from the session. None
 * of the three is read from a body, so a request cannot name another tenant's
 * books however it is shaped. Status is not writable either: archiving has its
 * own endpoint and its own audit event.
 *
 * ══ Durable writes need an active subscription ═══════════════════════════════
 *
 * Not asserted here. `enforcePersistenceEntitlement` is a global hook that
 * refuses every mutating method outside the subscription-lifecycle allow-list,
 * so `/api/customers` is protected the day it is written rather than the day
 * somebody remembers to add it. Reads are never blocked.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errors } from '../lib/errors.js';
import { requireOwnOrganizationPermission } from '../guards/permissions.js';
import { requireCompanyScope, companyOf } from '../guards/companyScope.js';
import * as parties from '../services/sales/businessPartyService.js';

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
 * The credit limit is a STRING.
 *
 * A JSON number would be parsed as a double on the way in, which is the float
 * this codebase routes every other monetary value around. The service validates
 * the shape and PostgreSQL stores it as numeric.
 */
const customerProfileSchema = z.object({
  customerCategory: z.string().max(120).optional(),
  creditLimit: z.string().max(40).optional(),
  defaultRevenueAccountId: z.string().uuid().nullable().optional(),
  defaultReceivableAccountId: z.string().uuid().nullable().optional(),
  defaultInvoiceTemplateId: z.string().uuid().nullable().optional(),
  invoiceDeliveryMethod: z.string().max(60).optional(),
  customerPaymentTerms: z.string().max(60).optional(),
});

/* Shared identity. Note the absence of status, version, organization, company,
 * actor and every supplier-only field: they are not the client's to choose. */
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
  customer: customerProfileSchema.optional(),
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
    throw errors.validation('Check the customer details and try again.', { fieldErrors });
  }
  return result.data;
}

function actorOf(request: FastifyRequest): parties.PartyActor {
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

export async function customerRoutes(app: FastifyInstance): Promise<void> {
  const viewCustomers = requireOwnOrganizationPermission('customers', 'view');
  const createCustomers = requireOwnOrganizationPermission('customers', 'create');
  const editCustomers = requireOwnOrganizationPermission('customers', 'edit');
  /* Archiving is the nearest thing to removal this directory offers, so it takes
   * the removal permission rather than the editing one. */
  const archiveCustomers = requireOwnOrganizationPermission('customers', 'delete');

  const onBooks = (
    ...guards: Array<ReturnType<typeof requireOwnOrganizationPermission>>
  ) => [...guards, requireCompanyScope];

  /**
   * The directory, paged.
   *
   * Bounded by construction: a picker asks for a page and a search term, never
   * for a whole tenant's directory, and the cursor is the party code — unique
   * per company, so a page boundary can neither repeat nor skip a row.
   */
  app.get('/api/customers', { preHandler: onBooks(viewCustomers) }, async (request, reply) => {
    const query = parse(listSchema, request.query);
    const result = await parties.listCustomers(app.db, actorOf(request), {
      search: query.search,
      includeArchived: query.includeArchived === 'true',
      limit: query.limit ? Number(query.limit) : undefined,
      after: query.after ?? null,
    });
    return reply.send(result);
  });

  app.get('/api/customers/:id', { preHandler: onBooks(viewCustomers) }, async (request, reply) =>
    reply.send({ customer: await parties.getCustomer(app.db, actorOf(request), idOf(request)) }));

  app.get('/api/customers/:id/history', { preHandler: onBooks(viewCustomers) }, async (request, reply) =>
    reply.send({ events: await parties.customerHistory(app.db, actorOf(request), idOf(request)) }));

  app.post('/api/customers', { preHandler: onBooks(createCustomers) }, async (request, reply) => {
    const body = parse(createSchema, request.body);
    const customer = await parties.createCustomer(app.db, actorOf(request), body);
    return reply.code(201).send({ customer });
  });

  app.patch('/api/customers/:id', { preHandler: onBooks(editCustomers) }, async (request, reply) => {
    const body = parse(updateSchema, request.body);
    const customer = await parties.updateCustomer(app.db, actorOf(request), idOf(request), body);
    return reply.send({ customer });
  });

  /**
   * Archive and restore. There is no DELETE verb on this resource.
   *
   * A party named on an issued invoice must stay identifiable for as long as
   * the invoice does, so removal is not offered — not refused conditionally,
   * not offered. The absence is the guarantee.
   */
  app.post('/api/customers/:id/archive', { preHandler: onBooks(archiveCustomers) }, async (request, reply) => {
    const body = parse(archiveSchema, request.body);
    const customer = await parties.setCustomerArchived(app.db, actorOf(request), idOf(request), body);
    return reply.send({ customer });
  });
}

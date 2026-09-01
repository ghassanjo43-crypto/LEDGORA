/**
 * Sales tax codes over HTTP.
 *
 * ══ What the client may not decide ═══════════════════════════════════════════
 *
 * Organization comes from the caller's membership, company from the selector
 * header resolved by `requireCompanyScope`, and the actor from the session.
 * None is read from a body, so a request cannot name another tenant's books
 * however it is shaped — which is what makes "use another company's tax code"
 * a lookup that finds nothing rather than a check somebody could forget.
 *
 * Status is not writable through the editing routes either: activating,
 * deactivating and archiving each have their own endpoint and their own audit
 * event, because archiving a code that invoices already name is a different act
 * from renaming one.
 *
 * ══ Durable writes need an active subscription ═══════════════════════════════
 *
 * Not asserted here. `enforcePersistenceEntitlement` is a global hook refusing
 * every mutating method outside the subscription-lifecycle allow-list, so these
 * routes are covered the day they are written rather than the day somebody
 * remembers to add them. Reads are never blocked.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errors } from '../lib/errors.js';
import { requireOwnOrganizationPermission } from '../guards/permissions.js';
import { requireCompanyScope, companyOf } from '../guards/companyScope.js';
import type { AccountingActor } from '../services/accounting/audit.js';
import * as taxCodes from '../services/invoicing/taxCodeService.js';

/**
 * A rate is a STRING.
 *
 * A JSON number arrives as a double, and this is the one figure a tax authority
 * will hold a copy of. It stays text from the client to PostgreSQL's numeric,
 * never passing through a float on the way.
 */
const rateSchema = z.string().max(20);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format yyyy-mm-dd.');

/*
 * Category and method are plain strings rather than enums HERE on purpose.
 * A zod enum would reject "reverse-charge" with "invalid enum value", which
 * tells a bookkeeper nothing; the service refuses each unsupported value by
 * name and says why it is absent and what would bring it.
 */
const createSchema = z.object({
  code: z.string().min(1).max(60),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  category: z.string().max(40),
  calculationMethod: z.string().max(40),
  /*
   * Which documents the code may be used on (§3). A plain string, like category
   * and method, so an unsupported value — a withholding direction — is refused
   * by name rather than as "invalid enum value".
   */
  direction: z.string().max(40).optional(),
  rate: rateSchema.optional(),
  outputTaxAccountId: z.string().uuid().nullable().optional(),
  inputTaxAccountId: z.string().uuid().nullable().optional(),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullable().optional(),
});

const updateSchema = z.object({
  expectedVersion: z.number().int().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  category: z.string().max(40).optional(),
  calculationMethod: z.string().max(40).optional(),
  /* Accepted so a mismatch is REFUSED by name; direction is immutable. */
  direction: z.string().max(40).optional(),
  outputTaxAccountId: z.string().uuid().nullable().optional(),
  inputTaxAccountId: z.string().uuid().nullable().optional(),
  effectiveTo: isoDate.nullable().optional(),
});

const statusSchema = z.object({
  expectedVersion: z.number().int().min(1),
  status: z.enum(['active', 'inactive', 'archived']),
});

const rateVersionSchema = z.object({
  expectedVersion: z.number().int().min(1),
  rate: rateSchema.optional(),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullable().optional(),
  outputTaxAccountId: z.string().uuid().nullable().optional(),
  /** A per-version override, exactly as the output account has. */
  inputTaxAccountId: z.string().uuid().nullable().optional(),
});

const listSchema = z.object({
  includeArchived: z.enum(['true', 'false']).optional(),
});

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of result.error.issues) {
      fieldErrors[issue.path.join('.') || 'form'] ??= issue.message;
    }
    throw errors.validation('Check the tax code details and try again.', { fieldErrors });
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

export async function taxCodeRoutes(app: FastifyInstance): Promise<void> {
  const viewTax = requireOwnOrganizationPermission('tax', 'view');
  const createTax = requireOwnOrganizationPermission('tax', 'create');
  const editTax = requireOwnOrganizationPermission('tax', 'edit');
  /* Archiving is the nearest thing to removal a code that invoices name allows. */
  const removeTax = requireOwnOrganizationPermission('tax', 'delete');

  const onBooks = (
    ...guards: Array<ReturnType<typeof requireOwnOrganizationPermission>>
  ) => [...guards, requireCompanyScope];

  app.get('/api/tax-codes', { preHandler: onBooks(viewTax) }, async (request, reply) => {
    const query = parse(listSchema, request.query);
    return reply.send({
      taxCodes: await taxCodes.listTaxCodes(app.db, actorOf(request), {
        includeArchived: query.includeArchived === 'true',
      }),
    });
  });

  app.get('/api/tax-codes/:id', { preHandler: onBooks(viewTax) }, async (request, reply) =>
    reply.send({ taxCode: await taxCodes.getTaxCode(app.db, actorOf(request), idOf(request)) }));

  app.get('/api/tax-codes/:id/history', { preHandler: onBooks(viewTax) }, async (request, reply) =>
    reply.send({ events: await taxCodes.taxCodeHistory(app.db, actorOf(request), idOf(request)) }));

  app.post('/api/tax-codes', { preHandler: onBooks(createTax) }, async (request, reply) => {
    const body = parse(createSchema, request.body ?? {});
    return reply.code(201).send({
      taxCode: await taxCodes.createTaxCode(app.db, actorOf(request), body),
    });
  });

  app.patch('/api/tax-codes/:id', { preHandler: onBooks(editTax) }, async (request, reply) => {
    const body = parse(updateSchema, request.body ?? {});
    return reply.send({
      taxCode: await taxCodes.updateTaxCode(app.db, actorOf(request), idOf(request), body),
    });
  });

  /**
   * A new effective-dated rate.
   *
   * Its own endpoint rather than a field on the update, because adding a rate
   * is not an edit: it leaves every previous rate in place, and the invoices
   * issued under them keep charging what they charged.
   */
  app.post('/api/tax-codes/:id/rates', { preHandler: onBooks(editTax) }, async (request, reply) => {
    const body = parse(rateVersionSchema, request.body ?? {});
    return reply.code(201).send({
      taxCode: await taxCodes.addRateVersion(app.db, actorOf(request), idOf(request), body),
    });
  });

  app.post('/api/tax-codes/:id/status', { preHandler: onBooks(removeTax) }, async (request, reply) => {
    const body = parse(statusSchema, request.body ?? {});
    return reply.send({
      taxCode: await taxCodes.setTaxCodeStatus(
        app.db, actorOf(request), idOf(request), body.status, body.expectedVersion,
      ),
    });
  });
}

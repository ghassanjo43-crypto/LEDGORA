/**
 * The financial-report surface: one endpoint, one snapshot.
 *
 * Every statement a reader compares against another comes from the same
 * request, and therefore the same PostgreSQL snapshot. Splitting them across
 * endpoints would let a posting land between two of them, and the balance sheet
 * would disagree with the trial balance that supposedly produced it.
 *
 * The general ledger stays separate and paginated (a later slice) precisely
 * because it is detail rather than a statement — its totals will be computed
 * server-side over the whole range, never from the pages a client happened to
 * fetch.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errors } from '../lib/errors.js';
import { requireOwnOrganizationPermission } from '../guards/permissions.js';
import { requireCompanyScope, companyOf } from '../guards/companyScope.js';
import { buildReportBundle } from '../services/accounting/reportService.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z.object({
  asOf: z.string().regex(DATE),
  from: z.string().regex(DATE),
  to: z.string().regex(DATE),
  comparativeFrom: z.string().regex(DATE).optional(),
  comparativeTo: z.string().regex(DATE).optional(),
  comparativeAsOf: z.string().regex(DATE).optional(),
});

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of result.error.issues) {
      fieldErrors[issue.path.join('.') || 'form'] ??= issue.message;
    }
    throw errors.validation('Provide a valid as-of date and reporting period.', { fieldErrors });
  }
  return result.data;
}

function scopeOf(request: FastifyRequest) {
  if (!request.permissions) throw errors.forbidden('You do not have access to this organization.');
  return {
    organizationId: request.permissions.organizationId,
    companyId: companyOf(request).id,
  };
}

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Trial balance, income statement, balance sheet and cash flow, together.
   *
   * Guarded by `financial_statements.view` and company scope. Reading is not a
   * durable write, so a lapsed subscriber may still look at their own books —
   * the entitlement gate applies to mutation, and nothing here mutates.
   */
  app.get('/api/accounting/reports/bundle', {
    preHandler: [
      requireOwnOrganizationPermission('financial_statements', 'view'),
      requireCompanyScope,
    ],
  }, async (request) => {
    const query = parse(querySchema, request.query);
    const { organizationId, companyId } = scopeOf(request);

    /*
     * A comparative needs all three of its dates or none. Accepting two would
     * mean inventing the third, and a comparative column struck on a date
     * nobody asked for is worse than no comparative at all.
     */
    const parts = [query.comparativeFrom, query.comparativeTo, query.comparativeAsOf];
    const supplied = parts.filter(Boolean).length;
    if (supplied !== 0 && supplied !== 3) {
      throw errors.validation(
        'A comparative period needs its start, end and as-of date together.',
      );
    }

    const bundle = await buildReportBundle(request.server.db, {
      organizationId,
      companyId,
      parameters: {
        asOf: query.asOf,
        from: query.from,
        to: query.to,
        comparative: supplied === 3
          ? {
              from: query.comparativeFrom!,
              to: query.comparativeTo!,
              asOf: query.comparativeAsOf!,
            }
          : null,
      },
    });

    return bundle;
  });
}

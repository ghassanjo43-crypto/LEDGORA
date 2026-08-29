/**
 * The financial-report surface: one endpoint, one snapshot.
 *
 * Every statement a reader compares against another comes from the same
 * request, and therefore the same PostgreSQL snapshot. Splitting them across
 * endpoints would let a posting land between two of them, and the balance sheet
 * would disagree with the trial balance that supposedly produced it.
 *
 * The general ledger, below, stays separate and paginated precisely because it
 * is detail rather than a statement. Its totals are computed by PostgreSQL over
 * the whole range on every request, never from the pages a client happened to
 * fetch — a closing balance that grew as somebody scrolled would be the most
 * quietly wrong thing a ledger could do.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errors } from '../lib/errors.js';
import { requireOwnOrganizationPermission } from '../guards/permissions.js';
import { requireCompanyScope, companyOf } from '../guards/companyScope.js';
import { buildReportBundle } from '../services/accounting/reportService.js';
import { readLedgerPage } from '../services/accounting/ledgerService.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z.object({
  asOf: z.string().regex(DATE),
  from: z.string().regex(DATE),
  to: z.string().regex(DATE),
  comparativeFrom: z.string().regex(DATE).optional(),
  comparativeTo: z.string().regex(DATE).optional(),
  comparativeAsOf: z.string().regex(DATE).optional(),
});

/** How many lines one server-side export page walks at a time. */
const EXPORT_PAGE = 500;
/** The most an export may return before the caller is asked to narrow it. */
const EXPORT_MAX = 20000;

const ledgerQuerySchema = z.object({
  accountId: z.string().min(1),
  from: z.string().regex(DATE),
  to: z.string().regex(DATE),
  cursor: z.string().min(1).optional(),
  limit: z.string().regex(/^\d{1,4}$/).optional(),
});

/** What a caller is told when the bundle's parameters do not parse. */
const BUNDLE_PARAMETERS = 'Provide a valid as-of date and reporting period.';
/**
 * And what a LEDGER caller is told, which is not the same sentence.
 *
 * A ledger has no as-of date. Telling somebody whose account id is missing to
 * provide a valid as-of date sends them to fix a field this request does not
 * have, so each schema carries the message that describes it.
 */
const LEDGER_PARAMETERS = 'Provide a ledger account and a valid period (yyyy-mm-dd).';

function parse<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  message: string = BUNDLE_PARAMETERS,
): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of result.error.issues) {
      fieldErrors[issue.path.join('.') || 'form'] ??= issue.message;
    }
    throw errors.validation(message, { fieldErrors });
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

  /**
   * One account's ledger, one page.
   *
   * ══ Separate from the bundle, and why ═════════════════════════════════════
   *
   * The bundle is four statements from one snapshot. A ledger is detail — tens
   * of thousands of lines for a busy account — so it is paged across separate
   * requests, and separate requests cannot share a transaction. The service
   * says plainly what that does and does not guarantee; nothing here claims a
   * snapshot.
   *
   * ══ `view` here, `export` on the export route ═════════════════════════════
   *
   * The permission model distinguishes them, so this does too. Somebody allowed
   * to read a customer's ledger on screen has not necessarily been trusted to
   * carry the whole of it out of the building in a file.
   */
  app.get('/api/accounting/ledger', {
    preHandler: [
      requireOwnOrganizationPermission('general_ledger', 'view'),
      requireCompanyScope,
    ],
  }, async (request) => {
    const query = parse(ledgerQuerySchema, request.query, LEDGER_PARAMETERS);
    const { organizationId, companyId } = scopeOf(request);
    return readLedgerPage(request.server.db, { organizationId, companyId }, {
      accountId: query.accountId,
      from: query.from,
      to: query.to,
      cursor: query.cursor ?? null,
      limit: query.limit ? Number(query.limit) : undefined,
    });
  });

  /**
   * The whole ledger for export, never the pages a browser happened to load.
   *
   * A file built from what was on screen is a file whose totals depend on how
   * far somebody scrolled. This walks the same keyset ordering server-side to
   * the end of the range and returns every line, so the export and the totals
   * describe the same thing.
   *
   * Guarded by `general_ledger.export`, which is a DIFFERENT action from
   * `view` — that distinction exists in the catalogue and would be pointless if
   * the export route accepted the viewing permission.
   */
  app.get('/api/accounting/ledger/export', {
    preHandler: [
      requireOwnOrganizationPermission('general_ledger', 'export'),
      requireCompanyScope,
    ],
  }, async (request) => {
    const query = parse(ledgerQuerySchema, request.query, LEDGER_PARAMETERS);
    const { organizationId, companyId } = scopeOf(request);

    const first = await readLedgerPage(request.server.db, { organizationId, companyId }, {
      accountId: query.accountId, from: query.from, to: query.to, limit: EXPORT_PAGE,
    });

    const lines = [...first.lines];
    let cursor = first.nextCursor;
    /*
     * Bounded. An unbounded server-side walk is a request that can be made to
     * run for as long as the data allows; a refusal past the cap is honest and
     * the caller can narrow the period.
     */
    while (cursor && lines.length < EXPORT_MAX) {
      const next = await readLedgerPage(request.server.db, { organizationId, companyId }, {
        accountId: query.accountId, from: query.from, to: query.to, cursor, limit: EXPORT_PAGE,
      });
      lines.push(...next.lines);
      cursor = next.nextCursor;
    }

    if (cursor) {
      throw errors.validation(
        `This ledger has more than ${EXPORT_MAX} lines. Export a shorter period.`,
      );
    }

    /* The totals come from the aggregate, not from the rows gathered above. */
    return { ...first, lines, nextCursor: null, complete: true };
  });
}

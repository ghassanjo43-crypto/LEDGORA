/**
 * The selected-company guard.
 *
 * ══ What a company selector is, and what it is not ═══════════════════════════
 *
 * `X-Ledgora-Company-Reference` names WHICH of the caller's own companies a
 * request concerns. That is the entire meaning of the header. It is not a
 * credential, it does not widen access, and it cannot reach outside the
 * organization the caller's membership already established — `resolveCompany`
 * searches only within that organization, so a header naming another tenant's
 * company matches nothing there and is answered exactly as an unknown reference
 * would be.
 *
 * This ordering matters and is the point of the file: authorization first, from
 * the session; selection second, from the header. Reversed — resolving a
 * company from the header and then asking who may see it — the header would be
 * deciding which tenant's data was in play, which is the vulnerability this
 * design exists to make unreachable.
 *
 * ══ Why the SERVER uuid is not accepted ══════════════════════════════════════
 *
 * The header carries the browser's `client_reference`, never `companies.id`.
 * Accepting the server key would make an internal identifier — one that appears
 * in every accounting foreign key, in exports, and in support tickets — into
 * something that behaves like a bearer token. The client reference is
 * meaningful only inside an organization that already contains it.
 *
 * ══ Why refusal reasons are distinguished here but not across tenants ════════
 *
 * `none_registered` and `ambiguous` are facts about the CALLER'S OWN workspace,
 * and the client needs them apart: one means "set up a company", the other
 * means "say which company". Neither tells the caller anything about anybody
 * else. `not_found` deliberately collapses "no such reference" and "somebody
 * else's company" into one answer, because separating those two WOULD.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { errors } from '../lib/errors.js';
import { AppError } from '../lib/errors.js';
import {
  resolveCompany,
  CompanyResolutionError,
  type CompanyView,
} from '../services/companyService.js';

/** The header a client sends to say which of its companies it has open. */
export const COMPANY_REFERENCE_HEADER = 'x-ledgora-company-reference';

declare module 'fastify' {
  interface FastifyRequest {
    /** The company this request is scoped to, once `requireCompanyScope` has run. */
    company: CompanyView | null;
  }
}

/** Register the decorator. Called once from `buildApp`. */
export function decorateCompany(app: {
  decorateRequest(name: string, value: unknown): void;
}): void {
  app.decorateRequest('company', null);
}

/** The raw selector, or null when the client did not send one. */
export function companyReferenceOf(request: FastifyRequest): string | null {
  const raw = request.headers[COMPANY_REFERENCE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Turn a resolution failure into the HTTP answer for it.
 *
 * All three are 400-family rather than 500: none is a server fault, and each
 * has a different thing the client should do about it. The codes are distinct
 * so a screen can react without parsing prose.
 */
function refusalFor(error: CompanyResolutionError): AppError {
  switch (error.failure) {
    case 'not_found':
      /*
       * `not_found`, identically, for a reference that names nothing and for one
       * that names another organization's company. The guard cannot tell them
       * apart because the query never looked outside the caller's organization —
       * the indistinguishability is structural, not a message chosen carefully.
       */
      return errors.notFound('Company');
    case 'none_registered':
      return new AppError('company_not_registered', error.message);
    case 'ambiguous':
      /*
       * Refused rather than guessed. Choosing "the first" or "the most recently
       * used" company here would post real journals into the wrong set of books,
       * silently, and the mistake would surface only at reconciliation.
       */
      return new AppError('company_selection_required', error.message);
  }
}

/**
 * Resolve the selected company onto the request.
 *
 * Runs after a permission guard, whose `request.permissions.organizationId` is
 * the authenticated scope. Refuses if that has not happened — reaching here
 * without it is a route wiring mistake, and the safe response to a wiring
 * mistake is to fail rather than to pick an organization.
 */
export async function requireCompanyScope(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const organizationId = request.permissions?.organizationId;
  if (!organizationId) {
    throw errors.forbidden('You do not have access to this organization.');
  }

  try {
    request.company = await resolveCompany(
      request.server.db,
      organizationId,
      companyReferenceOf(request),
    );
  } catch (error) {
    if (error instanceof CompanyResolutionError) throw refusalFor(error);
    throw error;
  }
}

/**
 * The resolved company, for a handler that has run the guard.
 *
 * Throws rather than returning null: a handler that reads this has already
 * declared it works on one company's books, and continuing without one would
 * mean querying by organization alone — the exact organization-wide fallback
 * that company scoping exists to eliminate.
 */
export function companyOf(request: FastifyRequest): CompanyView {
  if (!request.company) {
    throw errors.forbidden('No company is selected for this request.');
  }
  return request.company;
}

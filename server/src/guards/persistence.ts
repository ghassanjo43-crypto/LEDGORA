/**
 * Durable-write authorization: the server half of Free Preview.
 *
 * Free Preview grants a customer every FEATURE while their payment is verified,
 * and no DURABLE STORAGE. Enforcing that in the browser alone would be theatre —
 * anyone can call the API directly — so this guard is the real boundary: a
 * request that would make a business record permanent is refused unless the
 * organization's subscription is `active`.
 *
 * ── Fail-closed by construction ──────────────────────────────────────────────
 * The classification is a MUTATION-METHOD DEFAULT with a lifecycle allow-list,
 * not a list of protected paths. Any future `POST /api/journal-entries`,
 * `PATCH /api/customers/:id` or `DELETE /api/invoices/:id` is protected the day
 * it is written, with no one having to remember to add it here. Getting that
 * backwards — an allow-list of business paths — is how a new endpoint ships
 * unguarded.
 *
 * ── What stays durable ───────────────────────────────────────────────────────
 * The lifecycle itself must keep writing, or the customer could never pay and
 * the preview would become permanent: authentication, organization onboarding,
 * package selection, invoice retrieval, payment instructions, payment-proof
 * upload, subscription-status reads and account/profile operations. Those are
 * the allow-list below. They are not "business data" — they are the records that
 * turn a preview into a paid subscription.
 *
 * Reads are never blocked. Only durable mutation is.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { errors } from '../lib/errors.js';
import { findMembershipForUser } from '../services/organizationService.js';

/** Methods that can make a record permanent. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Path prefixes whose mutations are subscription-lifecycle operations, always
 * permitted. Order does not matter; a request matches if its path starts with
 * any entry.
 *
 * `/api/admin` is absent from the business-write rule for a different reason:
 * platform operators are staff, are not subscribers, and every admin route
 * already carries its own capability guard. Their writes (activating a
 * subscription, reviewing a proof) must obviously still work.
 */
export const LIFECYCLE_WRITE_PREFIXES: readonly string[] = [
  '/api/auth', // sign in/out, register, password
  '/api/account', // profile + credential operations
  '/api/profile',
  '/api/organizations', // organization onboarding
  '/api/subscriptions', // package selection + confirmation
  '/api/plans', // catalogue
  '/api/invoices', // invoice retrieval + payment-proof upload
  '/api/admin', // platform staff, separately capability-guarded
  '/api/health',
];

export function isLifecycleWrite(path: string): boolean {
  // Compare the path only — a query string must never change the verdict.
  const clean = path.split('?')[0] ?? path;
  return LIFECYCLE_WRITE_PREFIXES.some(
    (prefix) => clean === prefix || clean.startsWith(`${prefix}/`),
  );
}

/**
 * Does this request attempt a durable BUSINESS write? Pure, so the policy is
 * unit-testable without a server.
 */
export function isDurableBusinessWrite(method: string, path: string): boolean {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return false;
  return !isLifecycleWrite(path);
}

/**
 * May this organization write durable business records?
 *
 * Only an `active` subscription may. Every other status — including the preview
 * statuses `pending_payment` / `pending_verification`, and equally `draft`,
 * `past_due`, `suspended`, `cancelled`, `expired`, `rejected` — may not. A
 * customer with no subscription row at all cannot either.
 */
export async function organizationMayPersist(
  db: Kysely<Database>,
  organizationId: string,
): Promise<boolean> {
  const subscription = await db
    .selectFrom('subscriptions')
    .select('status')
    .where('organization_id', '=', organizationId)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return subscription?.status === 'active';
}

/**
 * The global hook. Refuses a durable business write from anyone whose
 * subscription is not active, with the exact documented 403 body.
 *
 * Unauthenticated requests are left alone: the route's own
 * `requireAuthenticatedUser` produces the correct 401, and answering "activate
 * your subscription" to someone who is not even signed in would be misleading.
 */
export async function enforcePersistenceEntitlement(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!isDurableBusinessWrite(request.method, request.url)) return;

  const principal = request.principal;
  if (!principal) return;

  // Platform staff are not subscribers; their access is decided by capability
  // guards on the routes themselves.
  if (principal.platformRoles.length > 0) return;

  const membership = await findMembershipForUser(request.server.db, principal.user.id);
  // No organization means no books to write to — the route's own validation
  // gives a clearer answer than a subscription message would.
  if (!membership) return;

  if (!(await organizationMayPersist(request.server.db, membership.organizationId))) {
    throw errors.persistenceRequiresSubscription();
  }
}

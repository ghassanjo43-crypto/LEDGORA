/**
 * Adopting the browser's company with the server, before any books are read.
 *
 * ══ The defect this exists to close ══════════════════════════════════════════
 *
 * The browser mints its own identifier for a set of books — `co_lx8f2a_9d4kz1`,
 * from `companyStore.ensureInitialized` — and `companySelector` mirrors it into
 * `X-Ledgora-Company-Reference` on every request. The server, meanwhile, knows
 * that organization's books only as the PROVISIONAL row written at onboarding.
 *
 * Nothing connected the two. `resolveCompany` matches a supplied reference
 * exactly and does not fall back to the sole company when one is given — quite
 * deliberately, because a reference that resolved to "whatever you have" would
 * stop being a selector — so every accounting and invoice request answered 404
 * for every subscriber. Worse, the opening-balance screen only issues its
 * requests once a company is open, which is precisely the condition that makes
 * the header carry the unadopted reference: the guard written to avoid
 * confusing errors guaranteed them.
 *
 * The missing step is adoption. `POST /api/organizations/current/companies`
 * claims the provisional row into the browser's reference, keeping the same
 * server id so nothing already posted moves. This module is that step.
 *
 * ══ Why the gate lives in the transport ══════════════════════════════════════
 *
 * "Register before reading the books" could have been a call at the top of each
 * screen. It is here instead, in front of the request itself, for the same
 * reason the selector is: a rule enforced at call sites is a rule that holds
 * until somebody adds a call site. `awaitCompanyRegistration` runs ahead of
 * every accounting and invoice request, so a new page cannot forget it.
 *
 * ══ What it refuses to do ════════════════════════════════════════════════════
 *
 * It never invents or substitutes a reference. If registration has not
 * succeeded, the request does not go out at all — sending it with an unadopted
 * header would produce a 404 that looks like missing data rather than a
 * bootstrap that has not finished. Offline is retryable and stays retryable; a
 * refusal the server means permanently is reported as itself.
 */
import { companiesApi } from './companiesApi';
import { getCompanyReference } from './client';
import { ApiError, isApiConfigured } from './client';
/* The gated-path predicate lives in the transport; re-exported so callers
 * and tests have one place to ask. */
export { requiresCompanyRegistration } from './client';
import { getWorkspaceStorageMode } from '@/lib/workspaceStorage';
import { useCompanyStore } from '@/store/companyStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';

export type RegistrationStatus =
  /** Not attempted, or the preconditions are not met yet. */
  | 'idle'
  /** The server knows this reference. Books may be read. */
  | 'registered'
  /** Transient — offline, or the server could not be reached. Retryable. */
  | 'unavailable'
  /** The server refused for a reason retrying cannot change. */
  | 'refused';

interface Registration {
  status: RegistrationStatus;
  /** The reference this verdict is about; a different one starts over. */
  reference: string;
  message: string | null;
}

let current: Registration = { status: 'idle', reference: '', message: null };
let inFlight: Promise<void> | null = null;

export function registrationState(): Readonly<Registration> {
  /* A copy: a caller inspecting the verdict must not be able to change it. */
  return { ...current };
}

/** Test seam, and the correct response to signing out. */
export function resetCompanyRegistration(): void {
  current = { status: 'idle', reference: '', message: null };
  inFlight = null;
}

/**
 * Whether this browser should be talking to the server about companies at all.
 *
 * `getWorkspaceStorageMode()` is the authoritative answer for Free Demo, Free
 * Preview and anonymous visitors: all three run memory-only, and registering a
 * company is a durable write. Deriving it from the storage mode rather than
 * from a status list means this cannot drift out of step with the rule that
 * governs every other business write.
 *
 * Platform operators are excluded too. They have no books of their own, and an
 * operator inspecting a tenant must not adopt that tenant's company under an
 * identifier their own browser happened to mint.
 */
function subscriberOnConfiguredBackend(): boolean {
  if (!isApiConfigured()) return false;
  if (getWorkspaceStorageMode() !== 'backend') return false;
  const session = useBackendSessionStore.getState();
  /* `ready` with a user is the only state that means "the server confirmed this
   * identity" — `unknown`, `loading` and `unavailable` all mean it has not. */
  if (session.status !== 'ready' || !session.user) return false;
  return session.platformRoles.length === 0;
}

/** The name the server should record. Authoritative, from the hydrated organization. */
function legalNameForRegistration(): string {
  const organization = useOrganizationStore.getState().organization;
  const name = typeof organization?.legalName === 'string' ? organization.legalName.trim() : '';
  if (name) return name;
  /*
   * Fall back to what the browser calls these books, and only then. An empty
   * name is rejected by the server, and inventing a placeholder would write a
   * company called "Untitled" into a customer's registry.
   */
  const { companies, activeCompanyId } = useCompanyStore.getState();
  const open = companies.find((c) => c.id === activeCompanyId);
  const local = open?.settings?.companyName;
  return typeof local === 'string' ? local.trim() : '';
}

/**
 * Adopt the open company, once.
 *
 * Concurrent callers share one attempt: `inFlight` is the whole of the
 * cross-caller coordination, and it is enough because the SERVER call is
 * idempotent — two tabs racing is not a problem the browser has to solve, and
 * `registerCompany` adopts under an advisory lock with a partial unique index
 * behind it. A reload simply repeats a registration the server answers 200.
 */
export async function ensureCompanyRegistered(): Promise<void> {
  const reference = getCompanyReference();

  /* A different company than the one we have a verdict for: start over. */
  if (current.reference !== reference) {
    current = { status: 'idle', reference, message: null };
    inFlight = null;
  }

  if (current.status === 'registered') return;
  if (inFlight) return inFlight;

  if (!reference || !subscriberOnConfiguredBackend()) {
    /*
     * Nothing to do and nothing to report. A demo visitor, a signed-out page or
     * a build with no backend never reaches a gated request in the first place;
     * leaving the state `idle` keeps the gate's message accurate if one does.
     */
    current = { status: 'idle', reference, message: null };
    return;
  }

  const legalName = legalNameForRegistration();
  if (!legalName) {
    /* The organization has not hydrated yet. Retryable, not a failure. */
    current = {
      status: 'unavailable',
      reference,
      message: 'Still loading your organization. Try again in a moment.',
    };
    return;
  }

  const attempt = (async () => {
    try {
      await companiesApi.register({ clientReference: reference, legalName });
      current = { status: 'registered', reference, message: null };
      /*
       * The books are now adopted, so their settings can be read. Hydrated here
       * because this is the first moment both a company and a session exist —
       * and failure is not fatal: the cache keeps its previous answer and the
       * settings screen reports the problem itself.
       */
      void import('../companySettingsSync')
        .then((m) => m.hydrateCompanySettings())
        .catch(() => undefined);
    } catch (error) {
      const api = error instanceof ApiError ? error : null;
      /*
       * A transport failure is transient by definition, and so is anything the
       * server could not answer. Both stay retryable: the next gated request
       * tries again rather than inheriting a verdict from a dropped connection.
       */
      const transient = !api || api.status === 0 || api.status >= 500;
      current = transient
        ? {
            status: 'unavailable',
            reference,
            message: api?.message ?? 'Could not reach the Ledgora service.',
          }
        : {
            /*
             * 4xx: a conflicting legal name, a permission the user does not
             * hold, or a plan that covers no further company. Retrying sends
             * the identical request and gets the identical answer, so it is
             * reported as itself rather than retried behind a spinner.
             */
            status: 'refused',
            reference,
            message: api.message,
          };
    } finally {
      inFlight = null;
    }
  })();

  inFlight = attempt;
  return attempt;
}

/**
 * The gate. Called by `apiRequest` before any accounting or invoice request.
 *
 * Throws rather than letting the request proceed unregistered, because the
 * failure mode it replaces — a 404 from a server that does not recognise the
 * header — is indistinguishable from "you have no data", which is the single
 * most misleading thing this feature could tell a bookkeeper.
 */
export async function awaitCompanyRegistration(): Promise<void> {
  await ensureCompanyRegistered();

  /*
   * No reference means no header, and the server then resolves the
   * organization's sole company itself. Nothing to wait for, and blocking would
   * break a subscriber whose company store has not initialised yet.
   */
  if (!getCompanyReference()) return;

  if (current.status === 'registered') return;

  /*
   * A reference IS set but the server has not adopted it. The request must not
   * go out: an unadopted header answers 404, and "no accounts" is the one thing
   * this must never say to somebody who has accounts. That includes the `idle`
   * case — a memory-only or unauthenticated caller that somehow reached a books
   * request is told plainly rather than shown an empty ledger.
   */
  throw new ApiError(
    0,
    current.status === 'refused' ? 'company_registration_refused' : 'company_registration_pending',
    current.message ?? 'This company is not registered with the Ledgora service yet.',
  );
}

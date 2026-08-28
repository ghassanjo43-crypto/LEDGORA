/**
 * The authoritative company service — a set of books, owned by one tenant.
 *
 * ══ Why this layer exists at all ═════════════════════════════════════════════
 *
 * Migration 022 created `companies` so a bookkeeping language could be made
 * genuinely immutable. This service exists for the larger reason that followed:
 * accounting records are moving out of the browser and into PostgreSQL, and a
 * subscriber organization may keep SEVERAL companies. Organization-only scoping
 * is therefore not isolation — two companies under one subscriber would share a
 * chart of accounts, a journal sequence and a set of reports, which is not a
 * bookkeeping system but a data-loss incident with a user interface.
 *
 * ══ The one rule this file exists to enforce ═════════════════════════════════
 *
 *   A company reference from the browser is a SELECTOR, not authorization.
 *
 * The organization is derived from the caller's authenticated membership. The
 * reference merely says WHICH of that organization's companies to work in, and
 * is resolved against that organization and no other. A caller who sends
 * somebody else's reference does not get somebody else's books; they get the
 * same answer as for a reference that was never issued.
 *
 * ══ Why an unknown company and another tenant's company look identical ═══════
 *
 * `resolveCompany` returns the same `not_found` for "no such company" and "a
 * company belonging to a different organization". Distinguishing them would
 * turn the endpoint into an oracle: a caller could enumerate references and
 * learn which of them name real books belonging to somebody else. That leaks
 * customer lists, and it leaks them to exactly the person who went looking.
 *
 * The server company UUID is likewise never accepted as an input. It is an
 * internal key; treating it as proof of access would make it a bearer token
 * that never expires and that appears in every foreign key in the database.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/schema.js';
import { errors } from '../lib/errors.js';
import { writeAuditLog } from '../lib/audit.js';
import { getEntitlements } from './entitlementService.js';
import { createDefaultSettings } from './companySettingsService.js';

type Executor = Kysely<Database> | Transaction<Database>;

/** The two languages a set of books may be kept in. */
export type BookkeepingLanguage = 'en' | 'ar';

export interface CompanyView {
  /** The server's own key. Returned for display and correlation, never accepted as input. */
  id: string;
  organizationId: string;
  clientReference: string;
  legalName: string;
  bookkeepingLanguage: BookkeepingLanguage | null;
  languageLockedAt: string | null;
  languageSelectedBy: string | null;
  createdAt: string;
  /**
   * NULL means PROVISIONAL — created automatically with the organization and
   * not yet claimed by a client. The first registration adopts this row rather
   * than adding a second one.
   */
  adoptedAt: string | null;
  adoptedBy: string | null;
}

interface CompanyRow {
  id: string;
  organization_id: string;
  client_reference: string;
  legal_name: string;
  bookkeeping_language: string | null;
  language_locked_at: Date | string | null;
  language_selected_by: string | null;
  created_at: Date | string;
  adopted_at: Date | string | null;
  adopted_by: string | null;
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : value;

function toView(row: CompanyRow): CompanyView {
  return {
    id: row.id,
    organizationId: row.organization_id,
    clientReference: row.client_reference,
    legalName: row.legal_name,
    bookkeepingLanguage: (row.bookkeeping_language as BookkeepingLanguage | null) ?? null,
    languageLockedAt: iso(row.language_locked_at),
    languageSelectedBy: row.language_selected_by,
    createdAt: iso(row.created_at)!,
    adoptedAt: iso(row.adopted_at ?? null),
    adoptedBy: row.adopted_by ?? null,
  };
}

/* ══ Reading ═══════════════════════════════════════════════════════════════ */

/** Every company this organization keeps books for, oldest first. */
export async function listCompanies(
  executor: Executor,
  organizationId: string,
): Promise<CompanyView[]> {
  const rows = await executor
    .selectFrom('companies')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .orderBy('created_at', 'asc')
    .execute();
  return (rows as unknown as CompanyRow[]).map(toView);
}

/* ══ Registration ══════════════════════════════════════════════════════════ */

export interface RegisterCompanyInput {
  organizationId: string;
  /** The browser's existing identifier for these books, e.g. `co_lx8f2a_9d4kz1`. */
  clientReference: string;
  legalName: string;
  actorUserId: string;
  /**
   * Whether this organization may hold a PERMANENT company record.
   *
   * Resolved by the route from the server's own subscription row — never from a
   * workspace mode, plan name or anything else the client could assert. Passed
   * in rather than read here for the reason `routes/legal.ts` gives: one
   * authorization decision, made in one place, instead of two that can disagree.
   *
   * Required, not optional. An optional flag defaulting to permissive is a rule
   * that holds only for callers who remembered it.
   */
  mayCreatePermanentCompany: boolean;
  requestId?: string | null;
}

const NAME_CONFLICT = (onFile: string): string =>
  `These books are already registered as "${onFile}". `
  + 'Rename the company deliberately rather than by re-registering it.';

/** The reference the automatic creation writes. `adopted_at` is what makes it provisional. */
export const provisionalReference = (organizationId: string): string =>
  `provisional:${organizationId}`;

export interface RegisterCompanyResult {
  company: CompanyView;
  /** This call established the registration — by adopting or by inserting. */
  created: boolean;
  /** It claimed the organization's provisional row rather than adding one. */
  adopted: boolean;
}

/**
 * Register a company: adopt the organization's provisional books, or add a
 * further set.
 *
 * ══ The invariant ════════════════════════════════════════════════════════════
 *
 *   One real set of books creates exactly one company row.
 *
 * An organization is born with one provisional company, because accounting is
 * company-scoped and a subscriber with nowhere to post is a broken subscriber.
 * The browser separately mints `co_lx8f2a…` for the same books. These are two
 * names for one legal entity, and the whole point of this function is that they
 * converge on ONE row.
 *
 * ══ The order, and why each step is where it is ══════════════════════════════
 *
 *   1. Serialise per organization with an advisory lock. Adoption is a
 *      read-then-write, and two first-time registrations racing would otherwise
 *      both see a provisional row.
 *   2. Exact match on the reference → idempotent replay. This is first because
 *      a retry must never be mistaken for a new registration.
 *   3. Exactly one provisional row → ADOPT it. Same server id, new reference.
 *      The `adopted_at IS NULL` guard on the UPDATE means a second adopter
 *      changes nothing, even if it somehow passed the lock.
 *   4. Otherwise an additional company, subject to the plan's allowance.
 *
 * ══ Why the server id must not move ══════════════════════════════════════════
 *
 * Accounts, journals and invoices may already reference the provisional company
 * — a subscriber can post before their browser ever registers. Adoption changes
 * the row's NAME, never its identity, so nothing has to be repointed and no
 * posted record moves between ledgers.
 */
export async function registerCompany(
  db: Kysely<Database>,
  input: RegisterCompanyInput,
): Promise<RegisterCompanyResult> {
  const clientReference = input.clientReference.trim();
  const legalName = input.legalName.trim();

  if (!clientReference) {
    throw errors.validation('A company reference is required.');
  }
  if (clientReference.length > 128) {
    throw errors.validation('That company reference is too long.');
  }
  /*
   * A client may not send the provisional form. It is the server's own marker
   * for "not yet claimed", and letting a browser claim it by name would make
   * the state settable from outside.
   */
  if (clientReference.startsWith('provisional:')) {
    throw errors.validation('That company reference is reserved.');
  }
  if (!legalName) {
    throw errors.validation('A company legal name is required.');
  }
  if (legalName.length > 200) {
    throw errors.validation('That company legal name is too long.');
  }

  /*
   * Free Preview may explore every feature and store nothing.
   *
   * A company row is the most permanent record Ledgora holds — every account,
   * journal and invoice is scoped to it by foreign key, and the bookkeeping
   * language locked against it can never be changed. Creating or ADOPTING one
   * is therefore a durable write, and refused before the transaction opens so
   * that nothing is inserted and no existing row is touched.
   *
   * Checked here as well as at the route because this function is the
   * authority: a future scheduled job or CLI that reaches it directly is
   * refused by the same rule, not by whichever caller remembered to ask.
   */
  if (!input.mayCreatePermanentCompany) {
    throw errors.persistenceRequiresSubscription();
  }

  const outcome = await db.transaction().execute(async (trx): Promise<
    RegisterCompanyResult & { previousLegalName?: string }
  > => {
    /*
     * One registration at a time per organization. Transaction-scoped, so it is
     * released with the commit and cannot be left held.
     */
    await sql`select pg_advisory_xact_lock(hashtext(${`company_register:${input.organizationId}`}))`
      .execute(trx);

    /* ── 1. A replay of a registration already on file ───────────────────── */
    const existing = (await trx
      .selectFrom('companies')
      .selectAll()
      .where('organization_id', '=', input.organizationId)
      .where('client_reference', '=', clientReference)
      .executeTakeFirst()) as unknown as CompanyRow | undefined;

    if (existing) {
      /*
       * Adopted books, so the name is settled. A different name now is a
       * disagreement about what these books are, not a rename — see the class
       * comment on `NAME_CONFLICT`.
       */
      if (existing.legal_name !== legalName) {
        throw errors.conflict(NAME_CONFLICT(existing.legal_name));
      }
      return { company: toView(existing), created: false, adopted: false };
    }

    /* ── 2. The organization's provisional books, waiting to be claimed ──── */
    const provisional = (await trx
      .selectFrom('companies')
      .selectAll()
      .where('organization_id', '=', input.organizationId)
      .where('adopted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst()) as unknown as CompanyRow | undefined;

    if (provisional) {
      const adopted = (await trx
        .updateTable('companies')
        .set({
          client_reference: clientReference,
          /*
           * The provisional name came from onboarding and the client's may be
           * more precise. Reconciled HERE and only here: this is identity
           * completion, not a rename — nobody has yet agreed what these books
           * are called. Every later disagreement is refused above.
           */
          legal_name: legalName,
          adopted_at: sql`now()`,
          adopted_by: input.actorUserId,
        })
        .where('id', '=', provisional.id)
        .where('organization_id', '=', input.organizationId)
        /*
         * The guard that makes double adoption impossible. A second adopter
         * matches no row and updates nothing, so it cannot rename books that
         * somebody else has already claimed — belt and braces behind the
         * advisory lock and the partial unique index.
         */
        .where('adopted_at', 'is', null)
        .returningAll()
        .executeTakeFirst()) as unknown as CompanyRow | undefined;

      if (!adopted) {
        /*
         * Another session adopted these books first. Usually that is the SAME
         * client retrying — a double-clicked button, or two tabs — so re-read by
         * reference and answer idempotently rather than failing a caller whose
         * request has, in every sense that matters, already succeeded.
         *
         * Only a genuinely different claimant reaches the conflict below.
         */
        const claimed = (await trx
          .selectFrom('companies')
          .selectAll()
          .where('organization_id', '=', input.organizationId)
          .where('client_reference', '=', clientReference)
          .executeTakeFirst()) as unknown as CompanyRow | undefined;

        if (claimed) {
          if (claimed.legal_name !== legalName) {
            throw errors.conflict(NAME_CONFLICT(claimed.legal_name));
          }
          return { company: toView(claimed), created: false, adopted: false };
        }

        throw errors.conflict(
          'These books were claimed by another session. Reload and try again.',
        );
      }

      return {
        company: toView(adopted),
        created: true,
        adopted: true,
        previousLegalName: provisional.legal_name,
      };
    }

    /* ── 3. An additional set of books, against the plan's allowance ─────── */
    const { entityLimit } = await getEntitlements(trx, input.organizationId);
    if (entityLimit !== null) {
      const existingCount = await trx
        .selectFrom('companies')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('organization_id', '=', input.organizationId)
        .executeTakeFirstOrThrow();

      if (Number(existingCount.count) >= entityLimit) {
        /*
         * Refused rather than allowed-and-billed-later. The count includes every
         * registered company, because the server holds no active/archived
         * lifecycle for companies yet — archiving is browser-side only. That
         * makes this conservative: a subscriber who archived a company in the
         * browser is still counted. Refusing is the safe direction; silently
         * exceeding a plan is not. See the report accompanying this change.
         */
        throw errors.conflict(
          `This subscription covers ${entityLimit} ${entityLimit === 1 ? 'company' : 'companies'}. `
          + 'Upgrade the plan to keep books for another company.',
        );
      }
    }

    const inserted = (await trx
      .insertInto('companies')
      .values({
        organization_id: input.organizationId,
        client_reference: clientReference,
        legal_name: legalName,
        /* Registered deliberately by a client, so adopted from birth. */
        adopted_at: sql`now()`,
        adopted_by: input.actorUserId,
      })
      /*
       * Two simultaneous first-time registrations of the same reference both
       * reach here; the unique constraint lets exactly one through, and the
       * loser takes the existing row instead of failing.
       */
      .onConflict((oc) => oc.columns(['organization_id', 'client_reference']).doNothing())
      .returningAll()
      .executeTakeFirst()) as unknown as CompanyRow | undefined;

    if (inserted) {
      /*
       * A further set of books needs its own settings, for the same reason the
       * first one does: a company without a fiscal year or a reporting
       * framework is a company no report can be prepared for. Same transaction,
       * so the pair is never half-created.
       */
      await createDefaultSettings(trx, input.organizationId, inserted.id);
      return { company: toView(inserted), created: true, adopted: false };
    }

    const raced = (await trx
      .selectFrom('companies')
      .selectAll()
      .where('organization_id', '=', input.organizationId)
      .where('client_reference', '=', clientReference)
      .executeTakeFirstOrThrow()) as unknown as CompanyRow;

    if (raced.legal_name !== legalName) {
      throw errors.conflict(NAME_CONFLICT(raced.legal_name));
    }
    return { company: toView(raced), created: false, adopted: false };
  });

  /*
   * Audited only when something happened. A replay that resolved to the row
   * already on file changed nothing, and a trail recording non-events is one
   * nobody can read.
   */
  if (outcome.created) {
    const renamed =
      outcome.adopted
      && outcome.previousLegalName !== undefined
      && outcome.previousLegalName !== outcome.company.legalName;

    await writeAuditLog(db, {
      action: outcome.adopted ? 'company.adopted' : 'company.registered',
      actorUserId: input.actorUserId,
      organizationId: input.organizationId,
      targetType: 'company',
      targetId: outcome.company.id,
      requestId: input.requestId ?? null,
      metadata: {
        clientReference: outcome.company.clientReference,
        legalName: outcome.company.legalName,
        /*
         * Both names, when adoption settled on a different one. The provisional
         * name is otherwise gone, and "what were these books called before
         * anyone claimed them" is exactly the question an audit answers.
         */
        ...(renamed ? { provisionalLegalName: outcome.previousLegalName } : {}),
      },
    });
  }

  return { company: outcome.company, created: outcome.created, adopted: outcome.adopted };
}

/* ══ The bookkeeping language ══════════════════════════════════════════════ */

export interface LockLanguageInput {
  organizationId: string;
  companyId: string;
  language: BookkeepingLanguage;
  actorUserId: string;
  actorName: string;
  /**
   * Whether this organization may hold a PERMANENT record — the same verdict
   * `registerCompany` requires, from the same authoritative subscription row.
   *
   * Locking a language is the least reversible act in the product: migration
   * 022's trigger refuses every later change to it, by any role, through any
   * route, including a direct UPDATE. A preview customer who locked one would
   * be permanently bound by a decision made while exploring.
   */
  mayCreatePermanentCompany: boolean;
  requestId?: string | null;
}

/**
 * Choose the bookkeeping language and lock it, in one act.
 *
 * The choice and the lock are not separable. A company whose language is set
 * but not locked would be a company whose language can still be changed, which
 * is the state migration 022 exists to make unreachable.
 *
 * The database trigger from 022 remains the final boundary: this function
 * refuses a second attempt with a clear message, and if it were ever wrong, or
 * bypassed, or a direct `UPDATE` were run against the table, the trigger still
 * refuses. That redundancy is the design — a service rule cannot promise that
 * no role can change a value, and a trigger can.
 */
export async function lockBookkeepingLanguage(
  db: Kysely<Database>,
  input: LockLanguageInput,
): Promise<CompanyView> {
  if (input.language !== 'en' && input.language !== 'ar') {
    throw errors.validation('Books may be kept in English or Arabic.');
  }

  /*
   * Free Preview may explore every feature and keep none of it — and this is
   * the one act nothing can undo. Refused before the transaction opens, so an
   * organization that is not entitled writes nothing and a company whose
   * language is ALREADY locked is not read, touched or reported on.
   *
   * Ordered ahead of the already-locked check deliberately: a lapsed customer
   * asking again is told about their subscription rather than about a record
   * they can no longer act on either way, and the row stays untouched in both
   * readings.
   */
  if (!input.mayCreatePermanentCompany) {
    throw errors.persistenceRequiresSubscription();
  }

  const company = await db.transaction().execute(async (trx) => {
    const row = (await trx
      .selectFrom('companies')
      .selectAll()
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.companyId)
      .forUpdate()
      .executeTakeFirst()) as unknown as CompanyRow | undefined;

    /* Same answer as a company that does not exist. See the file header. */
    if (!row) throw errors.notFound('Company');

    if (row.language_locked_at) {
      const current = row.bookkeeping_language === 'ar' ? 'Arabic' : 'English';
      throw errors.conflict(
        `These books are kept in ${current}. `
        + 'The bookkeeping language is chosen once and cannot be changed.',
      );
    }

    const updated = (await trx
      .updateTable('companies')
      .set({
        bookkeeping_language: input.language,
        language_locked_at: sql`now()`,
        language_selected_by: input.actorUserId,
      })
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.companyId)
      .returningAll()
      .executeTakeFirstOrThrow()) as unknown as CompanyRow;

    return toView(updated);
  });

  await writeAuditLog(db, {
    action: 'company.language_locked',
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    targetType: 'company',
    targetId: company.id,
    requestId: input.requestId ?? null,
    metadata: {
      clientReference: company.clientReference,
      bookkeepingLanguage: company.bookkeepingLanguage,
      /* Recorded because it can never be superseded by a later value. */
      lockedAt: company.languageLockedAt,
      selectedBy: input.actorName,
    },
  });

  return company;
}

/* ══ Resolution: turning a selector into a scope ═══════════════════════════ */

/**
 * Why a company could not be resolved. Reported distinctly to the CALLER'S OWN
 * organization, where none of it is a secret — "you have no companies" and "you
 * have several, say which" are both facts about the caller's own workspace, and
 * a client that cannot tell them apart cannot show the right screen.
 *
 * The one distinction never drawn is between another tenant's company and a
 * reference that names nothing: both are `not_found`.
 */
export type CompanyResolutionFailure = 'not_found' | 'none_registered' | 'ambiguous';

export class CompanyResolutionError extends Error {
  constructor(readonly failure: CompanyResolutionFailure, message: string) {
    super(message);
    this.name = 'CompanyResolutionError';
  }
}

/**
 * Resolve the selected company for a request.
 *
 * `organizationId` comes from the authenticated membership. `clientReference`
 * comes from the request header and is untrusted — it narrows a search that is
 * already confined to the caller's own organization, and can do nothing else.
 *
 * ══ When the selector is omitted ═════════════════════════════════════════════
 *
 * Old clients, and clients that have not opened a company yet, send nothing.
 * The rules are deliberately asymmetric:
 *
 *   · exactly one company  → resolve to it. There is no ambiguity to protect
 *     against, and refusing would break every single-company subscriber for no
 *     safety gain.
 *   · no companies         → refuse. There are no books to write into, and
 *     inventing one on demand would create a set of books nobody chose.
 *   · several companies    → refuse as ambiguous. This is the important one:
 *     guessing — "the first", "the newest", "the one used last" — would post a
 *     journal into the wrong company's books, and a misposting that the system
 *     chose silently is far worse than an error the user can answer.
 */
export async function resolveCompany(
  executor: Executor,
  organizationId: string,
  clientReference: string | null | undefined,
): Promise<CompanyView> {
  const reference = clientReference?.trim() ?? '';

  if (reference) {
    const row = (await executor
      .selectFrom('companies')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('client_reference', '=', reference)
      .executeTakeFirst()) as unknown as CompanyRow | undefined;

    if (!row) {
      /*
       * Reached both when the reference names nothing and when it names another
       * tenant's company — the query cannot tell them apart, by construction,
       * because it never looks outside the caller's organization.
       */
      throw new CompanyResolutionError(
        'not_found',
        'That company was not found in your organization.',
      );
    }
    return toView(row);
  }

  const rows = (await executor
    .selectFrom('companies')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .orderBy('created_at', 'asc')
    .limit(2)
    .execute()) as unknown as CompanyRow[];

  if (rows.length === 0) {
    throw new CompanyResolutionError(
      'none_registered',
      'No company is registered for this organization yet.',
    );
  }
  if (rows.length > 1) {
    throw new CompanyResolutionError(
      'ambiguous',
      'Several companies are registered. Select which company these records belong to.',
    );
  }
  return toView(rows[0]!);
}

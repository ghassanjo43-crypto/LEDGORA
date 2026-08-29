/**
 * The accounting HTTP surface.
 *
 * ══ What this layer is, and what it deliberately is not ══════════════════════
 *
 * Every rule about the books lives in `services/accounting`. This file does
 * four things and nothing else: authorize, derive the actor, parse the body,
 * and shape the response. No route here decides whether an entry balances,
 * whether a period is closed, or whether a correction is allowed — if it did,
 * that rule would hold only for callers who came through this file, and the
 * services are also called by future scheduled and module-generated postings.
 *
 * ══ Where the organization comes from ════════════════════════════════════════
 *
 * From `requireOwnOrganizationPermission`, which derives it from the caller's
 * own active membership and accepts no identifier from the request. There is
 * consequently no parameter for a modified request to point at another tenant:
 * isolation here is a property of where the value comes from, not of a check
 * somebody has to remember to write. Every service call receives that derived
 * organization inside the actor.
 *
 * ══ Two permissions on one route ═════════════════════════════════════════════
 *
 * Amend and reverse-and-replace carry TWO guards. Amending a posted entry is
 * `edit` plus `post`, because it changes figures that are already in the books —
 * an author who may draft but not post must not reach the same outcome by
 * amending. Reverse-and-replace is `void` plus `create`, for the same reason in
 * the other direction. Fastify runs a preHandler array in order and the first
 * refusal wins.
 *
 * ══ Transaction currency ════════════════════════════════════════════════════
 *
 * No endpoint here takes a currency choice. An ordinary transaction is
 * denominated in the company's own currency — `organizations.base_currency` —
 * at an exchange rate of 1, resolved server-side inside the write transaction.
 *
 * `transactionCurrency` and `exchangeRate` are still ACCEPTED in the body for
 * compatibility, and a value that disagrees with the company is REFUSED with a
 * 400 rather than applied or silently corrected. Omitting both is the
 * recommended contract and is always correct. A JOD company cannot be made to
 * write a USD journal through this API, with or without a user interface.
 *
 * ══ Free Preview ════════════════════════════════════════════════════════════
 *
 * Nothing in this file checks the subscription. `guards/persistence` is a global
 * hook that refuses any mutating request outside the lifecycle allow-list, and
 * `/api/accounting` is not on that list — so every write below is covered the
 * day it is written, without an entry in a list somebody could forget.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { errors } from '../lib/errors.js';
import { requireOwnOrganizationPermission } from '../guards/permissions.js';
import { requireCompanyScope, companyOf } from '../guards/companyScope.js';
import type { AccountingActor } from '../services/accounting/audit.js';
import * as accounts from '../services/accounting/accountService.js';
import * as periods from '../services/accounting/periodService.js';
import * as journals from '../services/accounting/journalService.js';
import * as openingBalances from '../services/accounting/openingBalanceService.js';
import * as sourcePostings from '../services/accounting/sourcePostingService.js';

/**
 * Who is acting, and on whose books.
 *
 * The organization comes from `request.permissions`, which the guard resolved —
 * never from the body. The company comes from `request.company`, which
 * `requireCompanyScope` resolved from the selector header WITHIN that
 * organization. Neither is read from the request payload.
 *
 * A null in either place means a guard did not run, which is a route wiring
 * mistake rather than an authorization decision. Both throw instead of falling
 * back to something permissive: an actor missing its company would scope every
 * query to the organization alone, which is the organization-wide leak this
 * whole change exists to close, arriving silently through a missing preHandler.
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
 * `undefined` so the service refuses it. A caller that has not read the record
 * cannot be allowed to overwrite it, and quietly filling the token in here would
 * turn every mutation into last-write-wins.
 */
function expectedVersionOf(body: unknown): number | undefined {
  const value = (body as { expectedVersion?: unknown })?.expectedVersion;
  return typeof value === 'number' ? value : undefined;
}

export async function accountingRoutes(app: FastifyInstance): Promise<void> {
  /* ── Guards ───────────────────────────────────────────────────────────── */
  const viewAccounts = requireOwnOrganizationPermission('chart_of_accounts', 'view');
  const createAccounts = requireOwnOrganizationPermission('chart_of_accounts', 'create');
  const editAccounts = requireOwnOrganizationPermission('chart_of_accounts', 'edit');
  const deleteAccounts = requireOwnOrganizationPermission('chart_of_accounts', 'delete');

  const viewJournal = requireOwnOrganizationPermission('general_journal', 'view');
  const createJournal = requireOwnOrganizationPermission('general_journal', 'create');
  const editJournal = requireOwnOrganizationPermission('general_journal', 'edit');
  const deleteJournal = requireOwnOrganizationPermission('general_journal', 'delete');
  const postJournal = requireOwnOrganizationPermission('general_journal', 'post');
  const voidJournal = requireOwnOrganizationPermission('general_journal', 'void');
  const viewOpening = requireOwnOrganizationPermission('opening_balances', 'view');
  const createOpening = requireOwnOrganizationPermission('opening_balances', 'create');
  const editOpening = requireOwnOrganizationPermission('opening_balances', 'edit');
  const submitOpening = requireOwnOrganizationPermission('opening_balances', 'submit');
  const approveOpening = requireOwnOrganizationPermission('opening_balances', 'approve');
  const postOpening = requireOwnOrganizationPermission('opening_balances', 'post');
  const reverseOpening = requireOwnOrganizationPermission('opening_balances', 'void');

  /*
   * Periods are read by anyone who may read the journal — the closed months are
   * part of reading the books — but changed only under Organization Settings,
   * because closing a period is an administrative act with company-wide effect
   * rather than a bookkeeping one.
   */
  const manageSettings = requireOwnOrganizationPermission(
    'organization_settings',
    'manage_organization_settings',
  );

  /**
   * Every accounting route runs its permission guard and THEN resolves the
   * company. The order is the point: authorization comes from the session, and
   * only once an organization is established does the selector header say which
   * of that organization's companies is meant. Resolving the company first
   * would let a header decide which tenant's data was in play.
   *
   * Written as one helper rather than repeated per route because the failure of
   * forgetting it is silent — an actor with no company would scope its queries
   * to the organization alone and read every company's books at once.
   */
  const onBooks = (
    ...guards: Array<ReturnType<typeof requireOwnOrganizationPermission>>
  ) => [...guards, requireCompanyScope];

  /* ══ Chart of accounts ═══════════════════════════════════════════════════ */

  app.get('/api/accounting/accounts', { preHandler: onBooks(viewAccounts) }, async (request, reply) => {
    const { includeInactive } = request.query as { includeInactive?: string };
    return reply.send({
      accounts: await accounts.listAccounts(app.db, actorOf(request), {
        includeInactive: includeInactive === 'true',
      }),
    });
  });

  app.get('/api/accounting/accounts/:id', { preHandler: onBooks(viewAccounts) }, async (request, reply) =>
    reply.send({ account: await accounts.getAccount(app.db, actorOf(request), idOf(request)) }),
  );

  app.post('/api/accounting/accounts', { preHandler: onBooks(createAccounts) }, async (request, reply) => {
    const account = await accounts.createAccount(
      app.db,
      actorOf(request),
      request.body as accounts.CreateAccountInput,
    );
    return reply.code(201).send({ account });
  });

  app.patch('/api/accounting/accounts/:id', { preHandler: onBooks(editAccounts) }, async (request, reply) =>
    reply.send({
      account: await accounts.updateAccount(
        app.db,
        actorOf(request),
        idOf(request),
        request.body as accounts.UpdateAccountInput,
      ),
    }),
  );

  /**
   * Set the order of one parent's children in a single atomic request.
   *
   * `parentAccountId: null` means the roots. The whole sequence is sent rather
   * than "move this one up" so the operation is idempotent — a retry after a
   * dropped connection reproduces the same chart instead of performing a second
   * swap. `edit` on the chart of accounts is the right permission: the order is
   * part of how the chart reads, and nothing about a balance changes.
   */
  app.post('/api/accounting/accounts/reorder', { preHandler: onBooks(editAccounts) }, async (request, reply) => {
    const body = (request.body ?? {}) as { parentAccountId?: string | null; orderedIds?: unknown };
    if (!Array.isArray(body.orderedIds) || body.orderedIds.some((id) => typeof id !== 'string')) {
      throw errors.validation('Send the account ids in their intended order.');
    }
    return reply.send({
      accounts: await accounts.reorderAccounts(
        app.db,
        actorOf(request),
        body.parentAccountId ?? null,
        body.orderedIds as string[],
      ),
    });
  });

  /*
   * Refused by the service if the account has ever been posted to. An account
   * carrying history is deactivated, never removed: deleting it would orphan
   * every line that references it and silently change past reports.
   */
  app.delete('/api/accounting/accounts/:id', { preHandler: onBooks(deleteAccounts) }, async (request, reply) => {
    await accounts.deleteAccount(app.db, actorOf(request), idOf(request));
    return reply.code(204).send();
  });

  /* ══ Accounting periods ══════════════════════════════════════════════════ */

  app.get('/api/accounting/periods', { preHandler: onBooks(viewJournal) }, async (request, reply) =>
    reply.send({ periods: await periods.listPeriods(app.db, actorOf(request)) }),
  );

  app.post('/api/accounting/periods', { preHandler: onBooks(manageSettings) }, async (request, reply) => {
    const period = await periods.createPeriod(
      app.db,
      actorOf(request),
      request.body as periods.CreatePeriodInput,
    );
    return reply.code(201).send({ period });
  });

  /* Opening balances: lifecycle metadata wrapped around the authoritative journal. */
  app.get('/api/accounting/opening-balances/current', { preHandler: onBooks(viewOpening) }, async (request, reply) =>
    reply.send({ openingBalance: await openingBalances.getCurrent(app.db, actorOf(request)) }));
  app.get('/api/accounting/opening-balances/accounts', { preHandler: onBooks(viewOpening) }, async (request, reply) =>
    reply.send(await openingBalances.listEligibleAccounts(app.db, actorOf(request))));
  app.get('/api/accounting/opening-balances/:id', { preHandler: onBooks(viewOpening) }, async (request, reply) =>
    reply.send({ openingBalance: await openingBalances.getById(app.db, actorOf(request), idOf(request)) }));
  app.get('/api/accounting/opening-balances/:id/history', { preHandler: onBooks(viewOpening) }, async (request, reply) =>
    reply.send({ history: await openingBalances.auditHistory(app.db, actorOf(request), idOf(request)) }));
  app.post('/api/accounting/opening-balances', { preHandler: onBooks(createOpening) }, async (request, reply) =>
    reply.code(201).send({ openingBalance: await openingBalances.createOrLoadDraft(app.db, actorOf(request), request.body as openingBalances.OpeningBalanceInput) }));
  app.patch('/api/accounting/opening-balances/:id', { preHandler: onBooks(editOpening) }, async (request, reply) => {
    const body = request.body as openingBalances.OpeningBalanceInput & { expectedVersion?: number };
    return reply.send({ openingBalance: await openingBalances.updateDraft(app.db, actorOf(request), idOf(request), body, body.expectedVersion) });
  });
  app.post('/api/accounting/opening-balances/:id/submit', { preHandler: onBooks(submitOpening) }, async (request, reply) => {
    const body = (request.body ?? {}) as { expectedVersion?: number };
    return reply.send({ openingBalance: await openingBalances.submit(app.db, actorOf(request), idOf(request), body.expectedVersion) });
  });
  app.post('/api/accounting/opening-balances/:id/approve', { preHandler: onBooks(approveOpening) }, async (request, reply) => {
    const body = (request.body ?? {}) as { expectedVersion?: number };
    return reply.send({ openingBalance: await openingBalances.approve(app.db, actorOf(request), idOf(request), body.expectedVersion) });
  });
  app.post('/api/accounting/opening-balances/:id/post', { preHandler: onBooks(postOpening) }, async (request, reply) => {
    const body = (request.body ?? {}) as { expectedVersion?: number };
    return reply.send({ openingBalance: await openingBalances.post(app.db, actorOf(request), idOf(request), body.expectedVersion) });
  });
  app.post('/api/accounting/opening-balances/:id/reverse', { preHandler: onBooks(reverseOpening) }, async (request, reply) => {
    const body = (request.body ?? {}) as { expectedVersion?: number; reason?: string };
    return reply.send({ openingBalance: await openingBalances.reverse(app.db, actorOf(request), idOf(request), body.expectedVersion, body.reason) });
  });
  app.post('/api/accounting/opening-balances/:id/replacement', { preHandler: onBooks(reverseOpening, createOpening) }, async (request, reply) =>
    reply.code(201).send({ openingBalance: await openingBalances.createReplacement(app.db, actorOf(request), idOf(request), request.body as openingBalances.OpeningBalanceInput) }));

  /**
   * Change a period — including closing, locking and REOPENING it.
   *
   * Reopening a locked period is the act that makes closed figures movable
   * again. The service demands a reason for it and records the transition in the
   * accounting audit trail; this route only carries the value through.
   */
  app.patch('/api/accounting/periods/:id', { preHandler: onBooks(manageSettings) }, async (request, reply) =>
    reply.send({
      period: await periods.updatePeriod(
        app.db,
        actorOf(request),
        idOf(request),
        request.body as Partial<periods.CreatePeriodInput> & { reason?: string },
      ),
    }),
  );

  /* ══ Journal entries ═════════════════════════════════════════════════════ */

  app.get('/api/accounting/journals', { preHandler: onBooks(viewJournal) }, async (request, reply) => {
    const query = request.query as journals.ListOptions & { limit?: string };
    return reply.send({
      journals: await journals.listJournals(app.db, actorOf(request), {
        status: query.status,
        from: query.from,
        to: query.to,
        limit: query.limit ? Number(query.limit) : undefined,
      }),
    });
  });

  app.get('/api/accounting/journals/:id', { preHandler: onBooks(viewJournal) }, async (request, reply) =>
    reply.send({ journal: await journals.getJournal(app.db, actorOf(request), idOf(request)) }),
  );

  app.get('/api/accounting/journals/:id/history', { preHandler: onBooks(viewJournal) }, async (request, reply) =>
    reply.send({ history: await journals.listJournalHistory(app.db, actorOf(request), idOf(request)) }),
  );

  /**
   * How may this entry be corrected? Asked BEFORE offering the user a choice, so
   * the screen presents the same options the server will actually accept.
   */
  app.get('/api/accounting/journals/:id/amendment', { preHandler: onBooks(viewJournal) }, async (request, reply) =>
    reply.send({ assessment: await journals.assessAmendment(app.db, actorOf(request), idOf(request)) }),
  );

  app.post('/api/accounting/journals', { preHandler: onBooks(createJournal) }, async (request, reply) => {
    const journal = await journals.createDraft(
      app.db,
      actorOf(request),
      request.body as journals.JournalInput,
    );
    return reply.code(201).send({ journal });
  });

  app.patch('/api/accounting/journals/:id', { preHandler: onBooks(editJournal) }, async (request, reply) => {
    const body = request.body as journals.JournalInput & { expectedVersion?: number; reason?: string };
    return reply.send({
      journal: await journals.updateDraft(app.db, actorOf(request), idOf(request), body, {
        expectedVersion: expectedVersionOf(body),
        reason: body.reason,
      }),
    });
  });

  app.delete('/api/accounting/journals/:id', { preHandler: onBooks(deleteJournal) }, async (request, reply) => {
    const body = (request.body ?? {}) as { expectedVersion?: number };
    await journals.deleteDraft(app.db, actorOf(request), idOf(request), {
      expectedVersion: expectedVersionOf(body),
    });
    return reply.code(204).send();
  });

  app.post('/api/accounting/journals/:id/post', { preHandler: onBooks(postJournal) }, async (request, reply) => {
    const body = (request.body ?? {}) as { expectedVersion?: number };
    return reply.send({
      journal: await journals.postJournal(app.db, actorOf(request), idOf(request), {
        expectedVersion: expectedVersionOf(body),
      }),
    });
  });

  /* ── Corrections ──────────────────────────────────────────────────────── */

  /**
   * Amend a posted entry: `edit` AND `post`.
   *
   * The entry is already in the books, so this changes figures somebody has
   * relied on. An author who may draft but not post must not reach that outcome
   * by amending instead.
   */
  app.post(
    '/api/accounting/journals/:id/amend',
    { preHandler: onBooks(editJournal, postJournal) },
    async (request, reply) => {
      const body = request.body as journals.JournalInput & { expectedVersion?: number; reason?: string };
      return reply.send({
        journal: await journals.amendPostedJournal(app.db, actorOf(request), idOf(request), body, {
          expectedVersion: expectedVersionOf(body),
          reason: body.reason,
        }),
      });
    },
  );

  app.post('/api/accounting/journals/:id/reverse', { preHandler: onBooks(voidJournal) }, async (request, reply) => {
    const body = (request.body ?? {}) as { expectedVersion?: number; reason?: string; postingDate?: string };
    const result = await journals.reverseJournal(app.db, actorOf(request), idOf(request), {
      expectedVersion: expectedVersionOf(body),
      reason: body.reason,
      postingDate: body.postingDate,
    });
    return reply.send(result);
  });

  /* ══ Source-document postings ════════════════════════════════════════════
   *
   * A source document does not draft and post; it produces a balanced entry as
   * part of one business action. These routes are that door, and the only one
   * carrying an idempotency guarantee: repeating a posting returns the journal
   * already made rather than writing a second.
   *
   * Guarded by `general_journal.post`, because that is exactly what they do.
   * The document module's own permission is checked by the module; this is the
   * ledger's.
   */

  app.post('/api/accounting/source-postings', { preHandler: onBooks(postJournal) }, async (request, reply) => {
    const body = request.body as sourcePostings.SourcePostingInput;
    const result = await sourcePostings.postSourceJournal(app.db, actorOf(request), body);
    /*
     * 201 for a journal this call created, 200 for one it found. A retry that
     * got 201 the first time and 200 the second has proof it did not double
     * post — which is the whole reason the distinction is returned.
     */
    return reply.code(result.created ? 201 : 200).send(result);
  });

  /** What this document has already posted. The reconcile after a lost answer. */
  app.get('/api/accounting/source-postings', { preHandler: onBooks(viewJournal) }, async (request, reply) => {
    const query = request.query as { sourceType?: string; sourceId?: string; sourceEvent?: string };
    if (!query.sourceType || !query.sourceId) {
      throw errors.validation('Name the source document type and id.');
    }
    if (query.sourceEvent) {
      const journal = await sourcePostings.findSourceJournal(app.db, actorOf(request), {
        sourceType: query.sourceType, sourceId: query.sourceId, sourceEvent: query.sourceEvent,
      });
      return reply.send({ journals: journal ? [journal] : [] });
    }
    return reply.send({
      journals: await sourcePostings.listSourceJournals(app.db, actorOf(request), {
        sourceType: query.sourceType, sourceId: query.sourceId,
      }),
    });
  });

  /** Withdraw a document's posting. `void`, and idempotent. */
  app.post('/api/accounting/source-postings/reverse', { preHandler: onBooks(voidJournal) }, async (request, reply) => {
    const body = (request.body ?? {}) as {
      sourceType?: string; sourceId?: string; sourceEvent?: string;
      reason?: string; postingDate?: string;
    };
    if (!body.sourceType || !body.sourceId || !body.sourceEvent) {
      throw errors.validation('Name the source document type, id and posting event.');
    }
    const result = await sourcePostings.reverseSourceJournal(
      app.db, actorOf(request),
      { sourceType: body.sourceType, sourceId: body.sourceId, sourceEvent: body.sourceEvent },
      { reason: body.reason ?? '', postingDate: body.postingDate },
    );
    return reply.send(result);
  });

  /** Reverse and replace: `void` AND `create`, as one atomic operation. */
  app.post(
    '/api/accounting/journals/:id/reverse-and-replace',
    { preHandler: onBooks(voidJournal, createJournal) },
    async (request, reply) => {
      const body = request.body as journals.JournalInput & {
        expectedVersion?: number;
        reason?: string;
        replacementPostingDate?: string;
      };
      const result = await journals.reverseAndReplace(app.db, actorOf(request), idOf(request), body, {
        expectedVersion: expectedVersionOf(body),
        reason: body.reason,
        postingDate: body.replacementPostingDate,
      });
      return reply.send(result);
    },
  );
}

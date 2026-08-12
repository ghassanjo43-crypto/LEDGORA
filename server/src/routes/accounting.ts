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
import type { AccountingActor } from '../services/accounting/audit.js';
import * as accounts from '../services/accounting/accountService.js';
import * as periods from '../services/accounting/periodService.js';
import * as journals from '../services/accounting/journalService.js';

/**
 * Who is acting.
 *
 * The organization comes from `request.permissions`, which the guard resolved —
 * never from the body. A null there means the guard did not run, which is a
 * programming error rather than an authorization decision, so it throws instead
 * of falling back to something permissive.
 */
function actorOf(request: FastifyRequest): AccountingActor {
  if (!request.permissions) throw errors.forbidden('You do not have access to this organization.');
  return {
    organizationId: request.permissions.organizationId,
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

  /* ══ Chart of accounts ═══════════════════════════════════════════════════ */

  app.get('/api/accounting/accounts', { preHandler: viewAccounts }, async (request, reply) => {
    const { includeInactive } = request.query as { includeInactive?: string };
    return reply.send({
      accounts: await accounts.listAccounts(app.db, actorOf(request), {
        includeInactive: includeInactive === 'true',
      }),
    });
  });

  app.get('/api/accounting/accounts/:id', { preHandler: viewAccounts }, async (request, reply) =>
    reply.send({ account: await accounts.getAccount(app.db, actorOf(request), idOf(request)) }),
  );

  app.post('/api/accounting/accounts', { preHandler: createAccounts }, async (request, reply) => {
    const account = await accounts.createAccount(
      app.db,
      actorOf(request),
      request.body as accounts.CreateAccountInput,
    );
    return reply.code(201).send({ account });
  });

  app.patch('/api/accounting/accounts/:id', { preHandler: editAccounts }, async (request, reply) =>
    reply.send({
      account: await accounts.updateAccount(
        app.db,
        actorOf(request),
        idOf(request),
        request.body as accounts.UpdateAccountInput,
      ),
    }),
  );

  /*
   * Refused by the service if the account has ever been posted to. An account
   * carrying history is deactivated, never removed: deleting it would orphan
   * every line that references it and silently change past reports.
   */
  app.delete('/api/accounting/accounts/:id', { preHandler: deleteAccounts }, async (request, reply) => {
    await accounts.deleteAccount(app.db, actorOf(request), idOf(request));
    return reply.code(204).send();
  });

  /* ══ Accounting periods ══════════════════════════════════════════════════ */

  app.get('/api/accounting/periods', { preHandler: viewJournal }, async (request, reply) =>
    reply.send({ periods: await periods.listPeriods(app.db, actorOf(request)) }),
  );

  app.post('/api/accounting/periods', { preHandler: manageSettings }, async (request, reply) => {
    const period = await periods.createPeriod(
      app.db,
      actorOf(request),
      request.body as periods.CreatePeriodInput,
    );
    return reply.code(201).send({ period });
  });

  /**
   * Change a period — including closing, locking and REOPENING it.
   *
   * Reopening a locked period is the act that makes closed figures movable
   * again. The service demands a reason for it and records the transition in the
   * accounting audit trail; this route only carries the value through.
   */
  app.patch('/api/accounting/periods/:id', { preHandler: manageSettings }, async (request, reply) =>
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

  app.get('/api/accounting/journals', { preHandler: viewJournal }, async (request, reply) => {
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

  app.get('/api/accounting/journals/:id', { preHandler: viewJournal }, async (request, reply) =>
    reply.send({ journal: await journals.getJournal(app.db, actorOf(request), idOf(request)) }),
  );

  app.get('/api/accounting/journals/:id/history', { preHandler: viewJournal }, async (request, reply) =>
    reply.send({ history: await journals.listJournalHistory(app.db, actorOf(request), idOf(request)) }),
  );

  /**
   * How may this entry be corrected? Asked BEFORE offering the user a choice, so
   * the screen presents the same options the server will actually accept.
   */
  app.get('/api/accounting/journals/:id/amendment', { preHandler: viewJournal }, async (request, reply) =>
    reply.send({ assessment: await journals.assessAmendment(app.db, actorOf(request), idOf(request)) }),
  );

  app.post('/api/accounting/journals', { preHandler: createJournal }, async (request, reply) => {
    const journal = await journals.createDraft(
      app.db,
      actorOf(request),
      request.body as journals.JournalInput,
    );
    return reply.code(201).send({ journal });
  });

  app.patch('/api/accounting/journals/:id', { preHandler: editJournal }, async (request, reply) => {
    const body = request.body as journals.JournalInput & { expectedVersion?: number; reason?: string };
    return reply.send({
      journal: await journals.updateDraft(app.db, actorOf(request), idOf(request), body, {
        expectedVersion: expectedVersionOf(body),
        reason: body.reason,
      }),
    });
  });

  app.delete('/api/accounting/journals/:id', { preHandler: deleteJournal }, async (request, reply) => {
    const body = (request.body ?? {}) as { expectedVersion?: number };
    await journals.deleteDraft(app.db, actorOf(request), idOf(request), {
      expectedVersion: expectedVersionOf(body),
    });
    return reply.code(204).send();
  });

  app.post('/api/accounting/journals/:id/post', { preHandler: postJournal }, async (request, reply) => {
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
    { preHandler: [editJournal, postJournal] },
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

  app.post('/api/accounting/journals/:id/reverse', { preHandler: voidJournal }, async (request, reply) => {
    const body = (request.body ?? {}) as { expectedVersion?: number; reason?: string; postingDate?: string };
    const result = await journals.reverseJournal(app.db, actorOf(request), idOf(request), {
      expectedVersion: expectedVersionOf(body),
      reason: body.reason,
      postingDate: body.postingDate,
    });
    return reply.send(result);
  });

  /** Reverse and replace: `void` AND `create`, as one atomic operation. */
  app.post(
    '/api/accounting/journals/:id/reverse-and-replace',
    { preHandler: [voidJournal, createJournal] },
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

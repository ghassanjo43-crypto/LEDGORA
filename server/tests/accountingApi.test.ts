/**
 * Phase A1 — the accounting API, through the real stack.
 *
 * ══ Why these go through HTTP ════════════════════════════════════════════════
 *
 * `accountingService.test.ts` proves the rules; this proves they cannot be
 * reached around. Every request below travels the real hooks, the real session
 * plugin, the real permission resolver and the real error handler — because the
 * question here is not "does the service refuse?" but "does the SERVER refuse,
 * to a caller who never touches the user interface?".
 *
 * That distinction is the whole point of Milestone A1. Ledgora's accounting
 * rules used to be enforced in browser TypeScript, so "the button is disabled"
 * was the entire enforcement. A test that drove the interface would be proving
 * the weaker half.
 *
 * The claims:
 *
 *   authority    each operation demands its own permission, and an author who
 *                may draft cannot post, amend, reverse or delete;
 *   isolation    one tenant's journal is invisible and untouchable to another;
 *   concurrency  a stale edit is answered 409, not silently merged;
 *   preview      an unpaid tenant cannot write durable accounting records;
 *   acceptance   the full A1 walkthrough, in order, each step depending on the
 *                one before it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  authHeaders,
  createTestContext,
  login,
  seedUser,
  type SessionCookies,
  type TestContext,
} from './helpers/testApp.js';

let ctx: TestContext;
let admin: SessionCookies;

beforeEach(async () => {
  ctx = await createTestContext();
  await seedUser(ctx, {
    email: 'super@ledgora.test',
    fullName: 'Platform Super Admin',
    platformRoles: ['super_admin'],
  });
  admin = await login(ctx, 'super@ledgora.test');
});
afterEach(async () => {
  await ctx.close();
});

/* ── Building a tenant ────────────────────────────────────────────────────── */

const PASSWORD = 'Copper-Lantern-64-Wm';

async function planId(code = 'core'): Promise<string> {
  const response = await ctx.app.inject({ method: 'GET', url: '/api/plans/public' });
  return response.json().plans.find((p: { code: string }) => p.code === code).id;
}

/**
 * A subscriber tenant. `paid` decides whether durable business writes are
 * permitted at all — Free Preview grants every feature and no storage.
 */
async function tenant(name: string, options: { paid?: boolean } = {}): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/subscribers',
    headers: authHeaders(admin),
    payload: {
      fullName: `${name} Owner`,
      email: `owner@${name.toLowerCase()}.test`,
      organizationLegalName: `${name} Trading LLC`,
      country: 'JO',
      baseCurrency: 'JOD',
      planId: await planId(),
      onboarding: 'temporary',
      paymentConfirmed: options.paid ?? true,
    },
  });
  expect(created.statusCode).toBe(201);
  return created.json().subscriber.organizationId as string;
}

/** A signed-in member of `organizationId`, holding `role`. */
async function member(
  organizationId: string,
  role: string,
  email: string,
  permissions: Array<{ subject: string; action: string; effect: 'grant' | 'deny' }> = [],
): Promise<SessionCookies> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: authHeaders(admin),
    payload: {
      fullName: `Person ${email}`,
      email,
      organizationId,
      role,
      onboarding: 'invitation',
      permissions,
    },
  });
  expect(created.statusCode).toBe(201);
  const token = created.json().credential.invitationToken as string;
  await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/reset-password',
    payload: { token, newPassword: PASSWORD },
  });
  return login(ctx, email, PASSWORD);
}

type Body = Record<string, unknown>;

const call = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  cookies: SessionCookies,
  payload?: Body,
) => ctx.app.inject({ method, url, headers: authHeaders(cookies), payload });

/** Two accounts, so there is something to post between. */
async function chart(cookies: SessionCookies): Promise<{ cash: string; sales: string }> {
  const cash = await call('POST', '/api/accounting/accounts', cookies, {
    accountCode: '1000', accountName: 'Cash', accountType: 'asset',
  });
  const sales = await call('POST', '/api/accounting/accounts', cookies, {
    accountCode: '4000', accountName: 'Sales', accountType: 'income',
  });
  expect([cash.statusCode, sales.statusCode]).toEqual([201, 201]);
  return { cash: cash.json().account.id, sales: sales.json().account.id };
}

const entry = (cash: string, sales: string, value = '1250.500'): Body => ({
  transactionDate: '2026-08-01',
  description: 'Consulting fee',
  lines: [
    { accountId: cash, debit: value },
    { accountId: sales, credit: value },
  ],
});

/* ══ Authorization ═════════════════════════════════════════════════════════ */

describe('who may do what', () => {
  it('lets an accountant author and post, and stops a standard user at posting', async () => {
    const org = await tenant('Alpha');
    const accountant = await member(org, 'accountant', 'accountant@alpha.test');
    const standard = await member(org, 'member', 'standard@alpha.test');
    const { cash, sales } = await chart(accountant);

    // The Standard User may create a draft — authoring is their role.
    const drafted = await call('POST', '/api/accounting/journals', standard, entry(cash, sales));
    expect(drafted.statusCode).toBe(201);
    const id = drafted.json().journal.id;

    /*
     * …and may not post it. This is the line that used to be drawn by a disabled
     * button. Here the server itself refuses, to a caller who never saw one.
     */
    const refused = await call('POST', `/api/accounting/journals/${id}/post`, standard, {
      expectedVersion: 1,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('forbidden');

    const posted = await call('POST', `/api/accounting/journals/${id}/post`, accountant, {
      expectedVersion: 1,
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json().journal.status).toBe('posted');
  });

  it('refuses a read-only auditor every write, while letting them read everything', async () => {
    const org = await tenant('Beta');
    const accountant = await member(org, 'accountant', 'accountant@beta.test');
    const auditor = await member(org, 'viewer', 'auditor@beta.test');
    const { cash, sales } = await chart(accountant);
    const id = (await call('POST', '/api/accounting/journals', accountant, entry(cash, sales)))
      .json().journal.id;

    expect((await call('GET', '/api/accounting/journals', auditor)).statusCode).toBe(200);
    expect((await call('GET', `/api/accounting/journals/${id}`, auditor)).statusCode).toBe(200);
    expect((await call('GET', `/api/accounting/journals/${id}/history`, auditor)).statusCode).toBe(200);

    for (const [method, url, payload] of [
      ['POST', '/api/accounting/journals', entry(cash, sales)],
      ['PATCH', `/api/accounting/journals/${id}`, { ...entry(cash, sales), expectedVersion: 1 }],
      ['DELETE', `/api/accounting/journals/${id}`, { expectedVersion: 1 }],
      ['POST', `/api/accounting/journals/${id}/post`, { expectedVersion: 1 }],
      ['POST', '/api/accounting/accounts', { accountCode: '9', accountName: 'X', accountType: 'asset' }],
    ] as const) {
      const response = await call(method, url, auditor, payload as Body);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('requires BOTH edit and post to amend a posted entry', async () => {
    const org = await tenant('Gamma');
    const accountant = await member(org, 'accountant', 'accountant@gamma.test');
    /*
     * An author granted `post` but denied `edit`. Amending a posted entry needs
     * both — otherwise each half of the authority could be combined to reach an
     * outcome neither was meant to permit.
     */
    const halfway = await member(org, 'member', 'halfway@gamma.test', [
      { subject: 'general_journal', action: 'post', effect: 'grant' },
      { subject: 'general_journal', action: 'edit', effect: 'deny' },
    ]);

    const { cash, sales } = await chart(accountant);
    const id = (await call('POST', '/api/accounting/journals', accountant, entry(cash, sales)))
      .json().journal.id;
    await call('POST', `/api/accounting/journals/${id}/post`, accountant, { expectedVersion: 1 });

    const amend = await call('POST', `/api/accounting/journals/${id}/amend`, halfway, {
      ...entry(cash, sales, '2000.000'),
      expectedVersion: 2,
      reason: 'Fee was renegotiated',
    });
    expect(amend.statusCode).toBe(403);
  });

  it('keeps period administration out of ordinary bookkeeping', async () => {
    const org = await tenant('Delta');
    const accountant = await member(org, 'accountant', 'accountant@delta.test');
    const owner = await member(org, 'admin', 'admin@delta.test');

    // Reading the calendar is part of reading the books.
    expect((await call('GET', '/api/accounting/periods', accountant)).statusCode).toBe(200);

    // Closing a month is a company-wide administrative act, not a posting.
    const closed = await call('POST', '/api/accounting/periods', accountant, {
      fiscalYear: 2026, periodNumber: 8, startDate: '2026-08-01', endDate: '2026-08-31',
    });
    expect(closed.statusCode).toBe(403);

    const created = await call('POST', '/api/accounting/periods', owner, {
      fiscalYear: 2026, periodNumber: 8, startDate: '2026-08-01', endDate: '2026-08-31',
    });
    expect(created.statusCode).toBe(201);
  });

  it('refuses everything to a caller with no session at all', async () => {
    for (const [method, url] of [
      ['GET', '/api/accounting/journals'],
      ['POST', '/api/accounting/journals'],
      ['GET', '/api/accounting/accounts'],
    ] as const) {
      const response = await ctx.app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

/* ══ Tenant isolation over HTTP ════════════════════════════════════════════ */

describe('tenant isolation', () => {
  it('hides one tenant’s journal from another, as a 404', async () => {
    const alpha = await member(await tenant('Alpha'), 'accountant', 'a@alpha.test');
    const beta = await member(await tenant('Beta'), 'accountant', 'b@beta.test');
    const { cash, sales } = await chart(alpha);
    const id = (await call('POST', '/api/accounting/journals', alpha, entry(cash, sales)))
      .json().journal.id;

    // 404 and not 403: "forbidden" would confirm the identifier belongs to
    // somebody, which is itself a cross-tenant disclosure.
    expect((await call('GET', `/api/accounting/journals/${id}`, beta)).statusCode).toBe(404);
    expect(
      (await call('POST', `/api/accounting/journals/${id}/post`, beta, { expectedVersion: 1 })).statusCode,
    ).toBe(404);
    expect((await call('GET', '/api/accounting/journals', beta)).json().journals).toHaveLength(0);
  });

  it('ignores an organization identifier supplied in the body', async () => {
    const alphaOrg = await tenant('Alpha');
    const betaOrg = await tenant('Beta');
    const beta = await member(betaOrg, 'accountant', 'b@beta.test');
    const { cash, sales } = await chart(beta);

    // There is no parameter for this to point at: the organization comes from
    // the caller's own membership and the body value is not read at all.
    const created = await call('POST', '/api/accounting/journals', beta, {
      ...entry(cash, sales),
      organizationId: alphaOrg,
    });
    expect(created.statusCode).toBe(201);

    const stored = await ctx.db
      .selectFrom('journal_entries')
      .select('organization_id')
      .where('id', '=', created.json().journal.id)
      .executeTakeFirstOrThrow();
    expect(stored.organization_id).toBe(betaOrg);
  });
});

/* ══ Concurrency over HTTP ═════════════════════════════════════════════════ */

describe('concurrent editing', () => {
  it('answers the loser 409 and keeps the winner’s work', async () => {
    const org = await tenant('Alpha');
    const first = await member(org, 'accountant', 'first@alpha.test');
    const second = await member(org, 'accountant', 'second@alpha.test');
    const { cash, sales } = await chart(first);
    const id = (await call('POST', '/api/accounting/journals', first, entry(cash, sales)))
      .json().journal.id;

    // Both loaded version 1.
    const won = await call('PATCH', `/api/accounting/journals/${id}`, first, {
      ...entry(cash, sales, '1500.000'), expectedVersion: 1,
    });
    expect(won.statusCode).toBe(200);

    const lost = await call('PATCH', `/api/accounting/journals/${id}`, second, {
      ...entry(cash, sales, '9999.000'), expectedVersion: 1,
    });
    expect(lost.statusCode).toBe(409);
    expect(lost.json().error.code).toBe('conflict');

    const current = await call('GET', `/api/accounting/journals/${id}`, first);
    expect(current.json().journal.lines[0].debit).toBe('1500.0000000000');
  });

  it('answers 409 when the token is left out entirely', async () => {
    const org = await tenant('Alpha');
    const accountant = await member(org, 'accountant', 'a@alpha.test');
    const { cash, sales } = await chart(accountant);
    const id = (await call('POST', '/api/accounting/journals', accountant, entry(cash, sales)))
      .json().journal.id;

    const response = await call('PATCH', `/api/accounting/journals/${id}`, accountant, entry(cash, sales));
    expect(response.statusCode).toBe(409);
  });
});

/* ══ Free Preview ══════════════════════════════════════════════════════════ */

describe('durable writes and Free Preview', () => {
  it('refuses an unpaid tenant’s accounting writes at the persistence guard', async () => {
    /*
     * Nothing in the accounting routes checks the subscription. The global
     * persistence hook covers every mutating request outside the lifecycle
     * allow-list, and `/api/accounting` is not on that list — so these routes
     * were protected the day they were written, with nobody having to remember
     * to add them anywhere.
     */
    const org = await tenant('Preview', { paid: false });
    const accountant = await member(org, 'accountant', 'a@preview.test');

    for (const [url, payload] of [
      ['/api/accounting/accounts', { accountCode: '1000', accountName: 'Cash', accountType: 'asset' }],
      ['/api/accounting/journals', { transactionDate: '2026-08-01', lines: [] }],
    ] as const) {
      const response = await call('POST', url, accountant, payload as Body);
      expect(response.statusCode, url).toBe(403);
      // The hook runs ahead of the route's own guard, so the answer names the
      // subscription rather than a permission the caller does in fact hold.
      expect(response.json().error.code, url).toBe('subscription_required_for_persistence');
    }
  });

  it('refuses an unpaid tenant’s accounting READS at the entitlement gate', async () => {
    /*
     * A second, independent layer, and worth stating explicitly because it is
     * easy to assume Free Preview means "read-only accounting". It does not: the
     * accounting subject requires the `accounting` module, and an organization
     * without an active subscription holds no entitlement at all — so the
     * permission resolver denies the read before the route is reached.
     *
     * The two layers answer differently on purpose. A refused WRITE names the
     * subscription, because paying fixes it. A refused READ is an ordinary
     * `forbidden`, because it is the same answer any unentitled caller gets.
     */
    const org = await tenant('Preview', { paid: false });
    const accountant = await member(org, 'accountant', 'a@preview.test');

    const read = await call('GET', '/api/accounting/journals', accountant);
    expect(read.statusCode).toBe(403);
    expect(read.json().error.code).toBe('forbidden');
    expect(read.json().error.message).toMatch(/active subscription/i);
  });
});

/* ══ The A1 acceptance walkthrough ═════════════════════════════════════════ */

describe('Milestone A1 acceptance', () => {
  it('walks the whole accounting lifecycle through the API, in order', async () => {
    /* ── 1. A paid tenant, and an accountant who works in it ─────────────── */
    const org = await tenant('Acceptance');
    const accountant = await member(org, 'accountant', 'accountant@acceptance.test');
    const owner = await member(org, 'admin', 'admin@acceptance.test');

    /* ── 2. A chart of accounts ──────────────────────────────────────────── */
    const { cash, sales } = await chart(accountant);
    const listed = await call('GET', '/api/accounting/accounts', accountant);
    expect(listed.json().accounts.map((a: { accountCode: string }) => a.accountCode))
      .toEqual(['1000', '4000']);

    /* ── 3. An accounting period ─────────────────────────────────────────── */
    const period = await call('POST', '/api/accounting/periods', owner, {
      fiscalYear: 2026, periodNumber: 8, startDate: '2026-08-01', endDate: '2026-08-31',
    });
    expect(period.statusCode).toBe(201);
    const periodId = period.json().period.id;

    /* ── 4. A draft, numbered by the server ──────────────────────────────── */
    const drafted = await call('POST', '/api/accounting/journals', accountant, entry(cash, sales));
    expect(drafted.statusCode).toBe(201);
    const journal = drafted.json().journal;
    expect(journal.journalNumber).toBe('JE-000001');
    expect(journal.status).toBe('draft');
    expect(journal.version).toBe(1);
    // Three minor units survive: JOD has three, and 1250.500 is not 1250.50.
    expect(journal.lines[0].debit).toBe('1250.5000000000');

    /* ── 5. An unbalanced edit is refused ────────────────────────────────── */
    const unbalanced = await call('PATCH', `/api/accounting/journals/${journal.id}`, accountant, {
      transactionDate: '2026-08-01',
      lines: [{ accountId: cash, debit: '100.000' }, { accountId: sales, credit: '90.000' }],
      expectedVersion: 1,
    });
    // Saved as a draft — an unfinished entry must be storable.
    expect(unbalanced.statusCode).toBe(200);
    const cannotPost = await call('POST', `/api/accounting/journals/${journal.id}/post`, accountant, {
      expectedVersion: 2,
    });
    expect(cannotPost.statusCode).toBe(400);
    expect(cannotPost.json().error.message).toMatch(/does not balance/i);

    /* ── 6. Corrected, then posted ───────────────────────────────────────── */
    await call('PATCH', `/api/accounting/journals/${journal.id}`, accountant, {
      ...entry(cash, sales), expectedVersion: 2,
    });
    const posted = await call('POST', `/api/accounting/journals/${journal.id}/post`, accountant, {
      expectedVersion: 3,
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json().journal.status).toBe('posted');
    expect(posted.json().journal.postedAt).not.toBeNull();

    /* ── 7. A posted entry cannot be deleted ─────────────────────────────── */
    const deletion = await call('DELETE', `/api/accounting/journals/${journal.id}`, accountant, {
      expectedVersion: 4,
    });
    expect(deletion.statusCode).toBe(409);
    expect(deletion.json().error.message).toMatch(/never deleted/i);

    /* ── 8. The server says how it MAY be corrected ──────────────────────── */
    const assessment = await call('GET', `/api/accounting/journals/${journal.id}/amendment`, accountant);
    expect(assessment.json().assessment.mode).toBe('amend_in_place');
    expect(assessment.json().assessment.reasonRequired).toBe(true);

    /* ── 9. An amendment without a reason is refused ─────────────────────── */
    const noReason = await call('POST', `/api/accounting/journals/${journal.id}/amend`, accountant, {
      ...entry(cash, sales, '1300.000'), expectedVersion: 4,
    });
    expect(noReason.statusCode).toBe(400);

    const amended = await call('POST', `/api/accounting/journals/${journal.id}/amend`, accountant, {
      ...entry(cash, sales, '1300.000'),
      expectedVersion: 4,
      reason: 'Client agreed a revised fee',
    });
    expect(amended.statusCode).toBe(200);
    expect(amended.json().journal.lines[0].debit).toBe('1300.0000000000');

    /* ── 10. The history holds every version ─────────────────────────────── */
    const history = await call('GET', `/api/accounting/journals/${journal.id}/history`, accountant);
    const versions = history.json().history;
    expect(versions.map((v: { version: number }) => v.version)).toEqual([1, 2, 3, 4, 5]);
    expect(versions.at(-1).reason).toBe('Client agreed a revised fee');
    expect(versions.at(-1).actorName).toBe('Person accountant@acceptance.test');
    // The original figure is still recoverable from version 1.
    expect(versions[0].snapshot.lines[0].debit).toBe('1250.5000000000');

    /* ── 11. Reversed and replaced, atomically ───────────────────────────── */
    const replaced = await call(
      'POST', `/api/accounting/journals/${journal.id}/reverse-and-replace`, accountant,
      {
        ...entry(cash, sales, '1400.000'),
        expectedVersion: 5,
        reason: 'Posted against the wrong period entirely',
      },
    );
    expect(replaced.statusCode).toBe(200);
    const { original, reversal, replacement } = replaced.json();
    expect(original.status).toBe('reversed');
    expect(original.reversalEntryId).toBe(reversal.id);
    expect(original.replacementEntryId).toBe(replacement.id);
    expect(reversal.lines.find((l: { accountId: string }) => l.accountId === cash).credit)
      .toBe('1300.0000000000');
    expect(replacement.lines[0].debit).toBe('1400.0000000000');

    /* ── 12. Three entries, and the ledger nets correctly ────────────────── */
    const all = (await call('GET', '/api/accounting/journals', accountant)).json().journals;
    expect(all).toHaveLength(3);
    const cashLines = await ctx.db
      .selectFrom('journal_lines')
      .select(['debit_functional', 'credit_functional'])
      .where('organization_id', '=', org)
      .where('account_id', '=', cash)
      .execute();
    const net = cashLines.reduce(
      (total, l) => total + Number(l.debit_functional) - Number(l.credit_functional),
      0,
    );
    // 1300 posted, 1300 reversed, 1400 replaced.
    expect(net).toBeCloseTo(1400, 6);

    /* ── 13. Locking the period stops everything ─────────────────────────── */
    const locked = await call('PATCH', `/api/accounting/periods/${periodId}`, owner, {
      status: 'locked',
    });
    expect(locked.statusCode).toBe(200);

    const afterLock = await call('POST', '/api/accounting/journals', accountant, entry(cash, sales));
    const lockedPost = await call(
      'POST', `/api/accounting/journals/${afterLock.json().journal.id}/post`, accountant,
      { expectedVersion: 1 },
    );
    expect(lockedPost.statusCode).toBe(409);
    expect(lockedPost.json().error.message).toMatch(/locked/i);

    /* ── 14. Reopening demands a reason, and is audited ──────────────────── */
    const bareReopen = await call('PATCH', `/api/accounting/periods/${periodId}`, owner, {
      status: 'open',
    });
    expect(bareReopen.statusCode).toBe(400);

    const reopened = await call('PATCH', `/api/accounting/periods/${periodId}`, owner, {
      status: 'open',
      reason: 'The auditor identified a misposting in August',
    });
    expect(reopened.statusCode).toBe(200);

    /* ── 15. The accounting audit trail records the whole story ──────────── */
    const events = await ctx.db
      .selectFrom('accounting_audit_events')
      .select(['action', 'actor_name', 'reason'])
      .where('organization_id', '=', org)
      .orderBy('at')
      .execute();
    const actions = events.map((e) => e.action);
    for (const expected of [
      'ACCOUNT_CREATED', 'PERIOD_CREATED', 'JOURNAL_CREATED', 'JOURNAL_UPDATED',
      'JOURNAL_POSTED', 'JOURNAL_AMENDED', 'JOURNAL_REPLACED', 'PERIOD_LOCKED', 'PERIOD_REOPENED',
    ]) {
      expect(actions, expected).toContain(expected);
    }
    // Every event names a person. An audit trail with anonymous entries is a log.
    expect(events.every((e) => e.actor_name.length > 0)).toBe(true);
    expect(events.find((e) => e.action === 'PERIOD_REOPENED')!.reason)
      .toBe('The auditor identified a misposting in August');

    /* ── 16. And none of it is visible to another tenant ─────────────────── */
    const outsider = await member(await tenant('Outsider'), 'accountant', 'x@outsider.test');
    expect((await call('GET', '/api/accounting/journals', outsider)).json().journals).toHaveLength(0);
    expect((await call('GET', '/api/accounting/accounts', outsider)).json().accounts).toHaveLength(0);
    expect((await call('GET', `/api/accounting/journals/${journal.id}`, outsider)).statusCode).toBe(404);
  });
});

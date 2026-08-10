// @vitest-environment happy-dom
/**
 * The Super Admin console panels.
 *
 * What these tests hold the UI to:
 *
 *   tables       search, filters, sorting and pagination reach the SERVER as query
 *                parameters — the console never filters a page of results in the
 *                browser and calls it a filter;
 *   staleness    switching the subscriber scope cannot leave the previous tenant's
 *                members on screen, even when the first response is slower than the
 *                second;
 *   secrecy      a generated credential is shown once, is never re-fetchable, and
 *                the member drawer renders no hash, token or secret;
 *   honesty      "not delivered" is reported as not delivered — never as "email
 *                sent";
 *   scope        the package dialog states that a change affects the whole
 *                organization, and refuses to submit a downgrade until the
 *                consequences have been read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MembersPanel } from './MembersPanel';
import { BackendSubscribersPanel } from './BackendSubscribersPanel';
import { AssignPackageDialog } from './AssignPackageDialog';
import { CredentialResultDialog } from './CredentialResultDialog';
import { useAdminMemberStore, useAdminSubscriberStore } from '@/store/adminConsoleStores';
import type { PlatformCapabilityName } from '@/services/api/adminConsoleApi';

const API = 'https://api.example.test';
const ACME = '11111111-1111-4111-8111-111111111111';
const GLOBEX = '22222222-2222-4222-8222-222222222222';

const SUPER_ADMIN: PlatformCapabilityName[] = [
  'view-admin',
  'subscribers.read',
  'subscribers.create',
  'subscribers.manage',
  'members.read',
  'members.manage',
  'members.reset_password',
  'subscriptions.assign',
];

const SUPPORT: PlatformCapabilityName[] = ['view-admin', 'subscribers.read', 'members.read'];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function member(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    userId: 'usr_1',
    fullName: 'Sam Subscriber',
    email: 'sam@acme.test',
    accountStatus: 'active',
    emailVerified: true,
    mustChangePassword: false,
    locked: false,
    lastLoginAt: '2026-07-01T10:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    // Production is the default everywhere, including in fixtures.
    dataClassification: 'production',
    organizationId: ACME,
    organizationName: 'Acme Holdings Ltd.',
    organizationStatus: 'active',
    organizationRole: 'owner',
    membershipStatus: 'active',
    isOwner: true,
    platformRoles: [],
    organizationCount: 1,
    ...overrides,
  };
}

function memberList(members: Array<Record<string, unknown>>, total = members.length) {
  return {
    members,
    pagination: { limit: 25, offset: 0, count: members.length, total },
    facets: { accountStatus: { active: members.length }, organizationRole: { owner: members.length } },
  };
}

function memberDetail(overrides: Record<string, unknown> = {}) {
  return {
    member: {
      identity: {
        userId: 'usr_1',
        fullName: 'Sam Subscriber',
        email: 'sam@acme.test',
        emailVerified: true,
        emailVerifiedAt: '2026-01-02T00:00:00.000Z',
        accountStatus: 'active',
        registeredAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: '2026-07-01T10:00:00.000Z',
        failedLoginCount: 0,
        locked: false,
        lockedUntil: null,
        platformRoles: [],
      },
      organizations: [
        {
          organizationId: ACME,
          organizationName: 'Acme Holdings Ltd.',
          organizationStatus: 'active',
          role: 'owner',
          isOwner: true,
          membershipStatus: 'active',
          joinedAt: '2026-01-01T00:00:00.000Z',
          primary: true,
        },
      ],
      subscription: {
        organizationId: ACME,
        planId: 'plan_core',
        planCode: 'core',
        planName: 'Core',
        edition: 'core',
        modules: ['accounting', 'invoicing'],
        status: 'active',
        billingCycle: 'monthly',
        activatedAt: '2026-01-05T00:00:00.000Z',
        expiresAt: '2026-08-05T00:00:00.000Z',
        seatsUsed: 2,
        seatLimit: 3,
        entityLimit: 1,
        invoiceStatus: 'paid',
        invoiceNumber: 'SUB-2026-00001',
        invoiceTotal: 49,
        paymentProofStatus: 'approved',
        entitlementActive: true,
      },
      security: {
        activeSessionCount: 2,
        lastSessionAt: '2026-07-02T09:00:00.000Z',
        mustChangePassword: false,
        passwordExpiresAt: null,
        hasPendingResetToken: false,
        recentSecurityActions: [],
      },
      administration: { auditHistory: [], internalNotes: null },
      ...overrides,
    },
  };
}

function subscriber(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ACME,
    legalName: 'Acme Holdings Ltd.',
    tradingName: 'Acme',
    country: 'AE',
    organizationStatus: 'active',
    // Production is the default everywhere, including in fixtures.
    dataClassification: 'production',
    legalHold: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    planId: 'plan_core',
    planCode: 'core',
    planName: 'Core',
    edition: 'core',
    subscriptionId: 'sub_1',
    subscriptionStatus: 'active',
    billingCycle: 'monthly',
    startsAt: '2026-01-05T00:00:00.000Z',
    renewsAt: '2026-08-05T00:00:00.000Z',
    seatsUsed: 2,
    seatLimit: 3,
    entityLimit: 1,
    modules: ['accounting'],
    entitlementActive: true,
    ownerUserId: 'usr_1',
    ownerName: 'Sam Subscriber',
    ownerEmail: 'sam@acme.test',
    memberCount: 2,
    openInvoiceId: null,
    openInvoiceStatus: null,
    pendingProofId: null,
    ...overrides,
  };
}

const PLANS = {
  plans: [
    {
      id: 'plan_core',
      code: 'core',
      name: 'Core',
      description: null,
      edition: 'core',
      currency: 'USD',
      monthlyPrice: 49,
      annualPrice: 490,
      userLimit: 3,
      entityLimit: 1,
      modules: ['accounting', 'invoicing'],
    },
    {
      id: 'plan_ent',
      code: 'enterprise',
      name: 'Enterprise',
      description: null,
      edition: 'enterprise',
      currency: 'USD',
      monthlyPrice: 349,
      annualPrice: 3490,
      userLimit: 100,
      entityLimit: 25,
      modules: ['accounting', 'invoicing', 'manufacturing'],
    },
  ],
};

/** Route-based fetch stub; records every request URL. */
function mockRoutes(routes: Array<[RegExp, (url: string, init?: RequestInit) => Response | Promise<Response>]>) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push(url.replace(API, ''));
    const hit = routes.find(([pattern]) => pattern.test(url));
    if (!hit) return json({ error: { code: 'not_found', message: `no route for ${url}` } }, 404);
    return hit[1](url, init);
  });
  return calls;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', API);
  useAdminMemberStore.getState().clear();
  useAdminSubscriberStore.getState().clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  useAdminMemberStore.getState().clear();
  useAdminSubscriberStore.getState().clear();
});

/* ══ 18: search, filters, sorting, pagination ═════════════════════════════ */

describe('the members table', () => {
  it('sends search, filters, sort and paging to the server', async () => {
    const calls = mockRoutes([[/\/api\/admin\/members/, () => json(memberList([member()], 60))]]);
    render(<MembersPanel capabilities={SUPER_ADMIN} />);

    await screen.findByText('Sam Subscriber');

    // Search is debounced, then sent as a query parameter.
    fireEvent.change(screen.getByLabelText('Search members'), { target: { value: 'sam' } });
    await waitFor(() => expect(calls.some((c) => c.includes('search=sam'))).toBe(true));

    fireEvent.change(screen.getByLabelText('Filter by role'), { target: { value: 'owner' } });
    await waitFor(() => expect(calls.some((c) => c.includes('role=owner'))).toBe(true));

    fireEvent.change(screen.getByLabelText('Filter by account status'), { target: { value: 'disabled' } });
    await waitFor(() => expect(calls.some((c) => c.includes('accountStatus=disabled'))).toBe(true));

    fireEvent.change(screen.getByLabelText('Filter by email verification'), { target: { value: 'unverified' } });
    await waitFor(() => expect(calls.some((c) => c.includes('verification=unverified'))).toBe(true));

    fireEvent.change(screen.getByLabelText('Sort members by'), { target: { value: 'full_name' } });
    await waitFor(() => expect(calls.some((c) => c.includes('sort=full_name'))).toBe(true));

    fireEvent.click(screen.getByLabelText(/^Sort (ascending|descending)$/));
    await waitFor(() => expect(calls.some((c) => c.includes('direction=asc'))).toBe(true));

    // Paging asks the server for the next window, never slices a loaded page.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(calls.some((c) => c.includes('offset=25'))).toBe(true));
  });

  /*
   * The account type of the PERSON, which is what decides whether their login
   * can be deleted alongside a disposable tenant. Production is the default and
   * is deliberately unbadged, so the badge marks the exception rather than
   * labelling every row.
   */
  it('badges a disposable identity and leaves a production identity unbadged', async () => {
    mockRoutes([
      [
        /\/api\/admin\/members/,
        () =>
          json(
            memberList([
              member(),
              member({
                userId: 'usr_2',
                fullName: 'Dev Tester',
                email: 'dev@sandbox.test',
                dataClassification: 'test',
              }),
            ]),
          ),
      ],
    ]);

    render(<MembersPanel capabilities={SUPER_ADMIN} />);

    await screen.findByText('Dev Tester');
    expect(screen.getByTestId('member-classification-usr_2').textContent).toBe('test');
    expect(
      screen.queryByTestId('member-classification-usr_1'),
      'a production identity carries no account-type badge',
    ).toBeNull();
  });

  it('scopes the directory to one subscriber when asked', async () => {
    const calls = mockRoutes([[/\/api\/admin\/members/, () => json(memberList([member()]))]]);
    render(<MembersPanel capabilities={SUPER_ADMIN} organizationId={ACME} organizationName="Acme Holdings Ltd." />);

    await screen.findByText('Sam Subscriber');
    expect(calls.some((c) => c.includes(`organizationId=${ACME}`))).toBe(true);
    expect(screen.getByTestId('members-scope').textContent).toBe('Acme Holdings Ltd.');
  });

  it('shows an empty state rather than a stale one when a filter matches nothing', async () => {
    let empty = false;
    mockRoutes([[/\/api\/admin\/members/, () => json(empty ? memberList([]) : memberList([member()]))]]);
    render(<MembersPanel capabilities={SUPER_ADMIN} />);

    await screen.findByText('Sam Subscriber');
    empty = true;
    fireEvent.change(screen.getByLabelText('Search members'), { target: { value: 'nobody' } });

    await waitFor(() => expect(screen.getByTestId('members-empty')).toBeTruthy());
    expect(screen.queryByText('Sam Subscriber')).toBeNull();
  });
});

/* ══ 19: switching subscribers cannot show stale members ══════════════════ */

describe('switching the subscriber scope', () => {
  it('never renders the previous tenant’s members under the new one', async () => {
    const acmeGate = deferred<Response>();
    mockRoutes([
      [
        /\/api\/admin\/members/,
        (url) => {
          if (url.includes(`organizationId=${ACME}`)) return acmeGate.promise;
          if (url.includes(`organizationId=${GLOBEX}`)) {
            return json(memberList([member({ userId: 'usr_2', fullName: 'Gina Globex', organizationId: GLOBEX, organizationName: 'Globex Industries' })]));
          }
          return json(memberList([]));
        },
      ],
    ]);

    const view = render(
      <MembersPanel capabilities={SUPER_ADMIN} organizationId={ACME} organizationName="Acme Holdings Ltd." />,
    );
    // Acme is still in flight; nothing is on screen yet.
    expect(screen.queryByText('Sam Subscriber')).toBeNull();

    // The operator switches to Globex before Acme answers.
    view.rerender(
      <MembersPanel capabilities={SUPER_ADMIN} organizationId={GLOBEX} organizationName="Globex Industries" />,
    );
    expect(await screen.findByText('Gina Globex')).toBeTruthy();

    // Acme's slow response now lands — and must be discarded.
    acmeGate.resolve(json(memberList([member({ fullName: 'Sam Subscriber' })])));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.queryByText('Sam Subscriber')).toBeNull();
    expect(screen.getByText('Gina Globex')).toBeTruthy();
    expect(screen.getByTestId('members-scope').textContent).toBe('Globex Industries');
  });

  it('drops the open member profile when the scope changes', async () => {
    mockRoutes([
      [/\/api\/admin\/members\/usr_1/, () => json(memberDetail())],
      [/\/api\/admin\/members/, () => json(memberList([member()]))],
    ]);

    const view = render(<MembersPanel capabilities={SUPER_ADMIN} organizationId={ACME} />);
    fireEvent.click(await screen.findByLabelText('View details for Sam Subscriber'));
    expect(await screen.findByTestId('member-detail')).toBeTruthy();

    view.rerender(<MembersPanel capabilities={SUPER_ADMIN} organizationId={GLOBEX} />);
    await waitFor(() => expect(screen.queryByTestId('member-detail')).toBeNull());
  });
});

/* ══ 9: the drawer discloses nothing sensitive ════════════════════════════ */

describe('the member profile', () => {
  it('shows identity, organization, subscription and security without any secret', async () => {
    mockRoutes([
      [/\/api\/admin\/members\/usr_1/, () => json(memberDetail())],
      [/\/api\/admin\/members/, () => json(memberList([member()]))],
    ]);

    render(<MembersPanel capabilities={SUPER_ADMIN} />);
    fireEvent.click(await screen.findByLabelText('View details for Sam Subscriber'));

    const drawer = await screen.findByTestId('member-detail');
    expect(drawer.getAttribute('data-user-id')).toBe('usr_1');
    expect(within(drawer).getByText('sam@acme.test')).toBeTruthy();
    expect(within(drawer).getByText('Acme Holdings Ltd.')).toBeTruthy();
    // Sessions are a count, not a session.
    expect(screen.getByTestId('member-session-count').textContent).toBe('2');
    expect(screen.getByTestId('member-failed-logins').textContent).toBe('0');

    const markup = drawer.innerHTML.toLowerCase();
    // `$argon2` is the hash PREFIX — the drawer may say the word "Argon2id" in
    // its explanatory copy, but an actual digest must never appear.
    for (const marker of ['$argon2', 'password_hash', 'passwordhash', 'token_hash', 'csrf', 'bearer']) {
      expect(markup).not.toContain(marker);
    }
    // And it says plainly that the current password cannot be read.
    expect(within(drawer).getByText(/cannot be read by anyone/i)).toBeTruthy();
  });

  it('states that the package belongs to the organization, not the member', async () => {
    mockRoutes([
      [/\/api\/admin\/members\/usr_1/, () => json(memberDetail())],
      [/\/api\/admin\/members/, () => json(memberList([member()]))],
    ]);

    render(<MembersPanel capabilities={SUPER_ADMIN} />);
    fireEvent.click(await screen.findByLabelText('View details for Sam Subscriber'));

    expect((await screen.findByTestId('member-package-scope')).textContent).toMatch(
      /belongs to the organization, not to this member/i,
    );
  });

  it('offers no credential controls to a support operator', async () => {
    mockRoutes([
      [/\/api\/admin\/members\/usr_1/, () => json(memberDetail())],
      [/\/api\/admin\/members/, () => json(memberList([member()]))],
    ]);

    render(<MembersPanel capabilities={SUPPORT} />);
    fireEvent.click(await screen.findByLabelText('View details for Sam Subscriber'));
    await screen.findByTestId('member-detail');

    // Read-only: no reset, no disable, no session revocation.
    expect(screen.queryByTestId('member-reset-temporary')).toBeNull();
    expect(screen.queryByTestId('member-reset-link')).toBeNull();
    expect(screen.queryByTestId('member-disable')).toBeNull();
    expect(screen.queryByTestId('member-revoke-sessions')).toBeNull();
  });
});

/* ══ 4 & the reset flow ══════════════════════════════════════════════════ */

describe('resetting a password from the console', () => {
  it('requires a reason, shows the credential once, and reports revoked sessions', async () => {
    const calls = mockRoutes([
      [/\/api\/admin\/members\/usr_1\/reset-password/, () =>
        json({
          member: { userId: 'usr_1', email: 'sam@acme.test', fullName: 'Sam Subscriber' },
          mode: 'temporary',
          credential: {
            type: 'temporary_password',
            temporaryPassword: 'Tmp-9xKq2Vn7Wd4B',
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            deliveryStatus: 'unavailable',
            mustChangePassword: true,
            revokedSessions: 3,
            message: 'Temporary password generated for Sam Subscriber. Show it once.',
          },
        }),
      ],
      [/\/api\/admin\/members\/usr_1/, () => json(memberDetail())],
      [/\/api\/admin\/members/, () => json(memberList([member()]))],
    ]);

    render(<MembersPanel capabilities={SUPER_ADMIN} />);
    fireEvent.click(await screen.findByLabelText('View details for Sam Subscriber'));
    fireEvent.click(await screen.findByTestId('member-reset-temporary'));

    // Confirmation is required, and cannot be given without a reason.
    const confirm = await screen.findByTestId('reason-confirm');
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some((c) => c.includes('reset-password'))).toBe(false);

    fireEvent.change(screen.getByTestId('reason-input'), { target: { value: 'Customer called support.' } });
    fireEvent.click(screen.getByTestId('reason-confirm'));

    // Shown exactly once, in the dedicated dialog.
    expect((await screen.findByTestId('credential-value')).textContent).toBe('Tmp-9xKq2Vn7Wd4B');
    expect(screen.getByTestId('credential-revoked').textContent).toBe('3');
    // The reason reached the server.
    const request = calls.find((c) => c.includes('reset-password'));
    expect(request).toBeTruthy();

    // Dismissing it removes the value from the document entirely — but only after
    // the operator confirms they copied it (see the dedicated credential suite).
    fireEvent.click(screen.getByTestId('credential-acknowledge'));
    fireEvent.click(screen.getByTestId('credential-dismiss'));
    await waitFor(() => expect(screen.queryByTestId('credential-value')).toBeNull());
    expect(document.body.innerHTML).not.toContain('Tmp-9xKq2Vn7Wd4B');
  });

  it('never claims an email was sent when it was not', async () => {
    const undelivered =
      'Password reset link could not be sent because email delivery is not configured. Copy the link and give it to the account holder through a channel you trust.';
    mockRoutes([
      [/\/api\/admin\/members\/usr_1\/reset-password/, () =>
        json({
          member: { userId: 'usr_1', email: 'sam@acme.test', fullName: 'Sam Subscriber' },
          mode: 'link',
          credential: {
            type: 'invitation',
            invitationToken: 'tok_abc123',
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            deliveryStatus: 'unavailable',
            mustChangePassword: false,
            revokedSessions: 0,
            message: undelivered,
          },
        }),
      ],
      [/\/api\/admin\/members\/usr_1/, () => json(memberDetail())],
      [/\/api\/admin\/members/, () => json(memberList([member()]))],
    ]);

    render(<MembersPanel capabilities={SUPER_ADMIN} />);
    fireEvent.click(await screen.findByLabelText('View details for Sam Subscriber'));
    fireEvent.click(await screen.findByTestId('member-reset-link'));
    fireEvent.change(await screen.findByTestId('reason-input'), { target: { value: 'Customer prefers email.' } });
    fireEvent.click(screen.getByTestId('reason-confirm'));

    const delivery = await screen.findByTestId('credential-delivery');
    expect(delivery.textContent).toBe(undelivered);
    expect(document.body.textContent).not.toMatch(/email sent/i);
    // The link is offered so the operator can pass it on themselves.
    expect(screen.getByTestId('credential-link').textContent).toContain('tok_abc123');
  });
});

/* ══ 13: downgrade consequences before confirmation ══════════════════════ */

describe('the package assignment dialog', () => {
  const downgrade = {
    assessment: {
      organizationId: ACME,
      direction: 'downgrade',
      isDowngrade: true,
      current: {
        planId: 'plan_ent',
        planCode: 'enterprise',
        planName: 'Enterprise',
        status: 'active',
        modules: ['accounting', 'manufacturing'],
        userLimit: 100,
        entityLimit: 25,
        seatsUsed: 4,
      },
      proposed: {
        planId: 'plan_core',
        planCode: 'core',
        planName: 'Core',
        status: 'active',
        modules: ['accounting', 'invoicing'],
        userLimit: 3,
        entityLimit: 1,
      },
      consequences: [
        {
          code: 'seats_over_limit',
          severity: 'warning',
          message: '4 members occupy seats but the new package allows 3. Nobody is removed automatically.',
        },
        {
          code: 'modules_removed',
          severity: 'warning',
          message: 'These modules will no longer be available: manufacturing. Existing records stay in the database.',
        },
      ],
      membersOverLimit: [
        { userId: 'usr_4', fullName: 'Dana Clerk', email: 'dana@acme.test', role: 'member', joinedAt: '2026-06-01T00:00:00.000Z' },
      ],
      modulesRemoved: ['manufacturing'],
    },
  };

  it('warns that the change is organization-wide', async () => {
    mockRoutes([
      [/\/api\/plans\/public/, () => json(PLANS)],
      [/package-impact/, () => json(downgrade)],
    ]);

    render(
      <AssignPackageDialog
        open
        organizationId={ACME}
        organizationName="Acme Holdings Ltd."
        onClose={() => undefined}
        onAssigned={() => undefined}
      />,
    );

    expect((await screen.findByTestId('assign-package-scope-warning')).textContent).toBe(
      'This changes the subscription for the entire organization, not only this member.',
    );
  });

  it('shows the consequences and the affected members before anything is confirmed', async () => {
    const calls = mockRoutes([
      [/\/api\/plans\/public/, () => json(PLANS)],
      [/package-impact/, () => json(downgrade)],
    ]);

    render(
      <AssignPackageDialog
        open
        organizationId={ACME}
        organizationName="Acme Holdings Ltd."
        onClose={() => undefined}
        onAssigned={() => undefined}
      />,
    );

    const consequences = await screen.findByTestId('assign-package-consequences');
    expect(consequences.textContent).toMatch(/Nobody is removed automatically/);
    expect(consequences.textContent).toMatch(/Existing records stay in the database/);
    // The members that would be over the allowance are named, not counted.
    expect(screen.getByTestId('assign-package-over-limit').textContent).toMatch(/Dana Clerk/);

    // Nothing has been assigned — the preview is a read.
    expect(calls.some((c) => c.includes('assign-package'))).toBe(false);
    expect(calls.some((c) => c.includes('package-impact'))).toBe(true);
  });

  it('refuses to submit a downgrade until the consequences are acknowledged', async () => {
    const calls = mockRoutes([
      [/\/api\/plans\/public/, () => json(PLANS)],
      [/package-impact/, () => json(downgrade)],
      [/assign-package/, () =>
        json({
          organizationId: ACME,
          subscriptionId: 'sub_1',
          status: 'active',
          direction: 'downgrade',
          previousPlanCode: 'enterprise',
          newPlanCode: 'core',
          entitlements: { organizationId: ACME, modules: ['accounting'], active: true },
          historyId: 'hist_1',
          consequences: downgrade.assessment.consequences,
        }),
      ],
    ]);

    render(
      <AssignPackageDialog
        open
        organizationId={ACME}
        organizationName="Acme Holdings Ltd."
        onClose={() => undefined}
        onAssigned={() => undefined}
      />,
    );
    await screen.findByTestId('assign-package-consequences');

    const submit = () => screen.getByTestId('assign-package-submit') as HTMLButtonElement;

    // A reason alone is not enough for a downgrade.
    fireEvent.change(screen.getByTestId('assign-package-reason'), { target: { value: 'Customer scaled back.' } });
    expect(submit().disabled).toBe(true);

    fireEvent.click(screen.getByTestId('assign-package-acknowledge'));
    expect(submit().disabled).toBe(false);

    fireEvent.click(submit());
    await waitFor(() => expect(calls.some((c) => c.includes('assign-package'))).toBe(true));
  });

  it('re-assesses when the proposal changes, and invalidates a prior acknowledgement', async () => {
    const calls = mockRoutes([
      [/\/api\/plans\/public/, () => json(PLANS)],
      [/package-impact/, () => json(downgrade)],
    ]);

    render(
      <AssignPackageDialog
        open
        organizationId={ACME}
        organizationName="Acme Holdings Ltd."
        onClose={() => undefined}
        onAssigned={() => undefined}
      />,
    );
    await screen.findByTestId('assign-package-consequences');

    fireEvent.change(screen.getByTestId('assign-package-reason'), { target: { value: 'Reason.' } });
    fireEvent.click(screen.getByTestId('assign-package-acknowledge'));
    expect((screen.getByTestId('assign-package-submit') as HTMLButtonElement).disabled).toBe(false);

    // Changing the seat override re-assesses, so the earlier acknowledgement no
    // longer describes what is about to happen.
    fireEvent.change(screen.getByLabelText('Seat override'), { target: { value: '1' } });
    await waitFor(() => expect(calls.some((c) => c.includes('seatOverride=1'))).toBe(true));
    await waitFor(() =>
      expect((screen.getByTestId('assign-package-submit') as HTMLButtonElement).disabled).toBe(true),
    );
  });
});

/* ══ The subscriber roster ═══════════════════════════════════════════════ */

describe('the subscribers table', () => {
  it('shows plan, status, renewal, seats and owner, and pages through the server', async () => {
    const calls = mockRoutes([
      [
        /\/api\/admin\/subscribers/,
        () =>
          json({
            subscribers: [subscriber()],
            pagination: { limit: 25, offset: 0, count: 1, total: 40 },
            statusCounts: { all: 40, active: 40 },
          }),
      ],
    ]);

    render(
      <BackendSubscribersPanel
        capabilities={SUPER_ADMIN}
        onAddSubscriber={() => undefined}
        onAssignPackage={() => undefined}
        onViewMembers={() => undefined}
      />,
    );

    const row = await screen.findByTestId('subscriber-row');
    expect(row.getAttribute('data-organization-id')).toBe(ACME);
    expect(within(row).getByText('Acme Holdings Ltd.')).toBeTruthy();
    expect(within(row).getByText('Sam Subscriber')).toBeTruthy();
    expect(within(row).getByText('Core')).toBeTruthy();
    expect(within(row).getByText('2 / 3')).toBeTruthy();
    expect(within(row).getByText('2026-08-05')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Filter by subscription status'), { target: { value: 'suspended' } });
    await waitFor(() => expect(calls.some((c) => c.includes('subscriptionStatus=suspended'))).toBe(true));

    fireEvent.change(screen.getByLabelText('Sort subscribers by'), { target: { value: 'renews_at' } });
    await waitFor(() => expect(calls.some((c) => c.includes('sort=renews_at'))).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(calls.some((c) => c.includes('offset=25'))).toBe(true));
  });

  it('requires a reason before suspending a subscriber', async () => {
    const calls = mockRoutes([
      [/\/api\/admin\/subscribers\/[^/]+\/status/, () =>
        json({
          organizationId: ACME,
          organizationStatus: 'suspended',
          subscriptionStatus: 'suspended',
          entitlements: { organizationId: ACME, active: false, modules: [] },
        }),
      ],
      [
        /\/api\/admin\/subscribers/,
        () =>
          json({
            subscribers: [subscriber()],
            pagination: { limit: 25, offset: 0, count: 1, total: 1 },
            statusCounts: { all: 1 },
          }),
      ],
    ]);

    render(
      <BackendSubscribersPanel
        capabilities={SUPER_ADMIN}
        onAddSubscriber={() => undefined}
        onAssignPackage={() => undefined}
        onViewMembers={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByLabelText('Suspend Acme Holdings Ltd.'));
    const confirm = await screen.findByTestId('reason-confirm');
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    // The dialog explains that nothing is deleted.
    expect(document.body.textContent).toMatch(/Nothing is deleted/i);

    fireEvent.change(screen.getByTestId('reason-input'), { target: { value: 'Payment dispute.' } });
    fireEvent.click(screen.getByTestId('reason-confirm'));

    await waitFor(() => expect(calls.some((c) => c.includes('/status'))).toBe(true));
    expect((await screen.findByTestId('subscribers-notice')).textContent).toMatch(/suspended/);
  });

  it('offers no lifecycle or creation controls to a support operator', async () => {
    mockRoutes([
      [
        /\/api\/admin\/subscribers/,
        () =>
          json({
            subscribers: [subscriber()],
            pagination: { limit: 25, offset: 0, count: 1, total: 1 },
            statusCounts: { all: 1 },
          }),
      ],
    ]);

    render(
      <BackendSubscribersPanel
        capabilities={SUPPORT}
        onAddSubscriber={() => undefined}
        onAssignPackage={() => undefined}
        onViewMembers={() => undefined}
      />,
    );

    await screen.findByTestId('subscriber-row');
    expect(screen.queryByTestId('add-subscriber')).toBeNull();
    expect(screen.queryByLabelText('Suspend Acme Holdings Ltd.')).toBeNull();
    expect(screen.queryByLabelText('Assign package for Acme Holdings Ltd.')).toBeNull();
    // Reading is still available.
    expect(screen.getByLabelText('View members of Acme Holdings Ltd.')).toBeTruthy();
  });

  it('surfaces a failure with a retry rather than an empty table', async () => {
    let fail = true;
    mockRoutes([
      [
        /\/api\/admin\/subscribers/,
        () =>
          fail
            ? json({ error: { code: 'internal_error', message: 'Something went wrong.' } }, 500)
            : json({
                subscribers: [subscriber()],
                pagination: { limit: 25, offset: 0, count: 1, total: 1 },
                statusCounts: { all: 1 },
              }),
      ],
    ]);

    render(
      <BackendSubscribersPanel
        capabilities={SUPER_ADMIN}
        onAddSubscriber={() => undefined}
        onAssignPackage={() => undefined}
        onViewMembers={() => undefined}
      />,
    );

    expect(await screen.findByText('Something went wrong.')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(await screen.findByTestId('subscriber-row')).toBeTruthy();
  });
});

/* ══ The credential dialog in isolation ══════════════════════════════════ */

describe('the credential dialog', () => {
  it('says a temporary password cannot be retrieved again', () => {
    render(
      <CredentialResultDialog
        result={{
          subjectName: 'Sam Subscriber',
          subjectEmail: 'sam@acme.test',
          type: 'temporary_password',
          temporaryPassword: 'Tmp-Value-1234',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          deliveryStatus: 'unavailable',
          message: 'Temporary password generated.',
          mustChangePassword: true,
        }}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText(/can read it back/i)).toBeTruthy();
    expect(screen.getByText(/Must choose a new password/i)).toBeTruthy();
    expect(screen.getByTestId('credential-value').textContent).toBe('Tmp-Value-1234');
  });

  it('renders nothing at all without a result', () => {
    const { container } = render(<CredentialResultDialog result={null} onClose={() => undefined} />);
    expect(container.innerHTML).toBe('');
  });
});

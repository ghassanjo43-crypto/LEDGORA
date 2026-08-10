// @vitest-environment happy-dom
/**
 * The one-time credential handoff, end to end through the console.
 *
 * The defect this suite pins: a subscriber is created successfully and the
 * temporary password is lost somewhere between the API response and the dialog —
 * leaving an account that exists and nobody can sign in to. Because the account
 * already exists, retrying is unsafe, so the credential has exactly one chance to
 * reach the administrator.
 *
 * What is enforced here:
 *
 *   handoff     the complete response reaches the parent, and the dialog opens;
 *   ordering    the creation drawer closing, and the roster refreshing, cannot
 *               destroy the credential — the dialog is a sibling, and capture
 *               happens before both;
 *   durability  the dialog cannot be dismissed by Escape or a backdrop click, and
 *               its close control stays disabled until the operator confirms they
 *               copied the value;
 *   secrecy     the value is never written to localStorage, sessionStorage or any
 *               Zustand store, and is gone from the DOM once dismissed;
 *   honesty     invitation mode reports the real delivery status, and a missing
 *               credential produces an explicit recovery instruction rather than
 *               an unqualified success message.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { SuperAdminConsolePage } from '@/pages/SuperAdminConsolePage';
import { MembersPanel } from '@/components/admin/MembersPanel';
import { CredentialResultDialog } from '@/components/admin/CredentialResultDialog';
import { useSessionStore } from '@/store/sessionStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useAdminMemberStore, useAdminSubscriberStore } from '@/store/adminConsoleStores';
import type { PlatformCapabilityName } from '@/services/api/adminConsoleApi';
import { ROUTES } from '@/lib/accessControl';

const API = 'https://api.example.test';
const ORG = '33333333-3333-4333-8333-333333333333';
const TEMP_PASSWORD = 'Tmp-7hQx4Vn2Wd9B';
const INVITE_TOKEN = 'invite-tok-abc123';

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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
      modules: ['accounting'],
    },
  ],
};

const EMPTY_ROSTER = {
  subscribers: [],
  pagination: { limit: 25, offset: 0, count: 0, total: 0 },
  statusCounts: { all: 0 },
};

function createdSubscriber(credential: unknown) {
  return {
    subscriber: {
      userId: 'usr_new',
      organizationId: ORG,
      email: 'nadia@newco.test',
      fullName: 'Nadia Owner',
      subscriptionId: 'sub_1',
      membershipId: 'mem_1',
      applicationId: 'app_1',
      subscriptionStatus: 'active',
    },
    entitlements: { organizationId: ORG, modules: ['accounting'], active: true },
    ...(credential === undefined ? {} : { credential }),
  };
}

const TEMPORARY_CREDENTIAL = {
  type: 'temporary_password',
  temporaryPassword: TEMP_PASSWORD,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  deliveryStatus: 'unavailable',
  mustChangePassword: true,
  message: 'Temporary password generated. Show it once — it cannot be retrieved again.',
};

const INVITATION_CREDENTIAL = {
  type: 'invitation',
  invitationToken: INVITE_TOKEN,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  deliveryStatus: 'unavailable',
  mustChangePassword: false,
  message: 'Invitation link could not be sent because email delivery is not configured.',
};

/**
 * Console-level fetch stub. `onCreate` decides what the creation call returns, so
 * each test can vary only that.
 */
function mockConsole(options: {
  onCreate: () => Response | Promise<Response>;
  rosterGate?: Promise<Response>;
}) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push(`${method} ${url.replace(API, '')}`);
    if (url.includes('/api/admin/me')) return json({ user: {}, capabilities: SUPER_ADMIN });
    if (url.includes('/api/plans/public')) return json(PLANS);
    if (url.includes('/api/admin/subscribers') && method === 'POST') return options.onCreate();
    if (url.includes('/api/admin/subscribers')) return options.rosterGate ?? json(EMPTY_ROSTER);
    if (url.includes('/api/admin/members')) {
      return json({
        members: [],
        pagination: { limit: 25, offset: 0, count: 0, total: 0 },
        facets: { accountStatus: {}, organizationRole: {} },
      });
    }
    return json({ error: { code: 'not_found', message: `no route ${url}` } }, 404);
  });
  return calls;
}

/** Fill the minimum required fields and submit, in the chosen onboarding mode. */
async function createSubscriber(mode: 'temporary' | 'invite'): Promise<void> {
  fireEvent.click(await screen.findByTestId('console-add-subscriber'));
  await screen.findByLabelText('Base package');
  fireEvent.change(screen.getByPlaceholderText('Nadia Owner'), { target: { value: 'Nadia Owner' } });
  fireEvent.change(screen.getByPlaceholderText('nadia@company.com'), { target: { value: 'nadia@newco.test' } });
  fireEvent.change(screen.getByPlaceholderText('NewCo Trading LLC'), { target: { value: 'NewCo Trading LLC' } });
  fireEvent.change(screen.getByLabelText('Onboarding method'), { target: { value: mode } });
  fireEvent.click(screen.getByTestId('create-subscriber-submit'));
}

function signedInAsOperator(): void {
  useSessionStore.setState({ platformRole: 'super-admin', userName: 'Op' });
  useBackendSessionStore.setState({
    status: 'ready',
    user: {
      id: 'usr_admin',
      email: 'ops@ledgora.com',
      fullName: 'Platform Operator',
      status: 'active',
      emailVerified: true,
      mustChangePassword: false,
      platformRoles: ['super_admin'],
      lastLoginAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    platformRoles: ['super_admin'],
    error: null,
  });
}

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', API);
  localStorage.clear();
  sessionStorage.clear();
  signedInAsOperator();
  useAdminSubscriberStore.getState().clear();
  useAdminMemberStore.getState().clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  useAdminSubscriberStore.getState().clear();
  useAdminMemberStore.getState().clear();
});

/* ══ 1 & 2: the credential reaches the dialog ══════════════════════════════ */

describe('creating a subscriber with a temporary password', () => {
  it('receives the full credential response and opens the dialog', async () => {
    const calls = mockConsole({ onCreate: () => json(createdSubscriber(TEMPORARY_CREDENTIAL), 201) });
    render(<SuperAdminConsolePage />);
    await createSubscriber('temporary');

    // The dialog opened, showing the password and who it is for.
    expect((await screen.findByTestId('credential-value')).textContent).toBe(TEMP_PASSWORD);
    expect(screen.getByTestId('credential-email').textContent).toBe('nadia@newco.test');
    expect(calls.filter((c) => c === 'POST /api/admin/subscribers')).toHaveLength(1);
  });

  it('shows every fact the operator needs to hand the password over', async () => {
    mockConsole({ onCreate: () => json(createdSubscriber(TEMPORARY_CREDENTIAL), 201) });
    render(<SuperAdminConsolePage />);
    await createSubscriber('temporary');
    await screen.findByTestId('credential-value');

    expect(screen.getByTestId('credential-email').textContent).toBe('nadia@newco.test');
    expect(screen.getByLabelText('Copy Temporary password')).toBeTruthy();
    // An absolute timestamp, not only "in an hour".
    expect(screen.getByTestId('credential-expiry').textContent).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    expect(screen.getByTestId('credential-once-warning').textContent).toMatch(/can read it back/i);
    expect(screen.getByTestId('credential-once-warning').textContent).toMatch(/nobody/i);
    expect(screen.getByText('Shown only once')).toBeTruthy();
    expect(screen.getByTestId('credential-force-change').textContent).toMatch(/replace this password/i);
  });

  /* ══ 3: the drawer may close without closing the dialog ═════════════════ */

  it('closes the creation drawer while the credential dialog stays open', async () => {
    mockConsole({ onCreate: () => json(createdSubscriber(TEMPORARY_CREDENTIAL), 201) });
    render(<SuperAdminConsolePage />);
    await createSubscriber('temporary');

    await screen.findByTestId('credential-value');
    // The creation form is gone…
    await waitFor(() => expect(screen.queryByTestId('create-subscriber-submit')).toBeNull());
    // …and the credential is still on screen.
    expect(screen.getByTestId('credential-value').textContent).toBe(TEMP_PASSWORD);
  });

  /* ══ 4: the roster refresh cannot erase it ══════════════════════════════ */

  it('survives the post-create roster refresh, however slow it is', async () => {
    let releaseRoster!: (value: Response) => void;
    const rosterGate = new Promise<Response>((resolve) => {
      releaseRoster = resolve;
    });

    const calls = mockConsole({
      onCreate: () => json(createdSubscriber(TEMPORARY_CREDENTIAL), 201),
      rosterGate,
    });
    render(<SuperAdminConsolePage />);
    await createSubscriber('temporary');

    expect((await screen.findByTestId('credential-value')).textContent).toBe(TEMP_PASSWORD);
    // The refresh was requested AFTER the credential was captured.
    await waitFor(() => expect(calls.some((c) => c.startsWith('GET /api/admin/subscribers'))).toBe(true));

    // The roster now lands, re-rendering the table underneath.
    releaseRoster(json({ ...EMPTY_ROSTER, statusCounts: { all: 1 } }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByTestId('credential-value').textContent).toBe(TEMP_PASSWORD);
  });

  /* ══ 6: never written to browser persistence ════════════════════════════ */

  it('never writes the password to localStorage, sessionStorage or a store', async () => {
    mockConsole({ onCreate: () => json(createdSubscriber(TEMPORARY_CREDENTIAL), 201) });
    render(<SuperAdminConsolePage />);
    await createSubscriber('temporary');
    await screen.findByTestId('credential-value');

    const persisted = [
      JSON.stringify(localStorage),
      JSON.stringify(sessionStorage),
      // Both admin Zustand stores, in full.
      JSON.stringify(useAdminSubscriberStore.getState()),
      JSON.stringify(useAdminMemberStore.getState()),
    ];
    for (const blob of persisted) {
      expect(blob).not.toContain(TEMP_PASSWORD);
    }
    // Every storage key, in case a store persisted under an unexpected name.
    for (const storage of [localStorage, sessionStorage]) {
      for (let i = 0; i < storage.length; i += 1) {
        expect(storage.getItem(storage.key(i)!) ?? '').not.toContain(TEMP_PASSWORD);
      }
    }
  });

  /* ══ 7 & 5: it cannot be dismissed accidentally, and is shown once ══════ */

  it('cannot be dismissed by Escape, a backdrop click, or an unconfirmed close', async () => {
    mockConsole({ onCreate: () => json(createdSubscriber(TEMPORARY_CREDENTIAL), 201) });
    render(<SuperAdminConsolePage />);
    await createSubscriber('temporary');
    const dialog = await screen.findByTestId('credential-dialog');

    // Escape is swallowed.
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('credential-value').textContent).toBe(TEMP_PASSWORD);

    // The backdrop has no dismiss handler.
    const backdrop = dialog.firstElementChild!;
    fireEvent.click(backdrop);
    expect(screen.getByTestId('credential-value').textContent).toBe(TEMP_PASSWORD);

    // And Close is disabled until the operator confirms.
    const close = screen.getByTestId('credential-dismiss') as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    fireEvent.click(close);
    expect(screen.getByTestId('credential-value')).toBeTruthy();
  });

  /* ══ 8: confirming clears it from memory ════════════════════════════════ */

  it('clears the password from memory once the operator confirms they copied it', async () => {
    mockConsole({ onCreate: () => json(createdSubscriber(TEMPORARY_CREDENTIAL), 201) });
    render(<SuperAdminConsolePage />);
    await createSubscriber('temporary');
    await screen.findByTestId('credential-value');

    fireEvent.click(screen.getByTestId('credential-acknowledge'));
    const close = screen.getByTestId('credential-dismiss') as HTMLButtonElement;
    expect(close.disabled).toBe(false);
    fireEvent.click(close);

    // Gone from the dialog, from the document, and not retrievable again.
    await waitFor(() => expect(screen.queryByTestId('credential-dialog')).toBeNull());
    expect(document.body.innerHTML).not.toContain(TEMP_PASSWORD);
    expect(screen.queryByTestId('credential-value')).toBeNull();
  });

  it('re-enables the copy gate for a second credential', async () => {
    // A tick left over from one credential must not let the next be dismissed unread.
    const { rerender } = render(
      <CredentialResultDialog
        result={{
          subjectName: 'First Person',
          subjectEmail: 'first@acme.test',
          type: 'temporary_password',
          temporaryPassword: 'First-Password-11',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          deliveryStatus: 'unavailable',
          mustChangePassword: true,
          message: 'First.',
        }}
        onClose={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId('credential-acknowledge'));
    expect((screen.getByTestId('credential-dismiss') as HTMLButtonElement).disabled).toBe(false);

    rerender(
      <CredentialResultDialog
        result={{
          subjectName: 'Second Person',
          subjectEmail: 'second@acme.test',
          type: 'temporary_password',
          temporaryPassword: 'Second-Password-22',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          deliveryStatus: 'unavailable',
          mustChangePassword: true,
          message: 'Second.',
        }}
        onClose={() => undefined}
      />,
    );
    await waitFor(() =>
      expect((screen.getByTestId('credential-dismiss') as HTMLButtonElement).disabled).toBe(true),
    );
  });
});

/* ══ 9: invitation mode is honest about delivery ═══════════════════════════ */

describe('creating a subscriber with an invitation', () => {
  it('shows the invitation result with its real delivery status', async () => {
    mockConsole({ onCreate: () => json(createdSubscriber(INVITATION_CREDENTIAL), 201) });
    render(<SuperAdminConsolePage />);
    await createSubscriber('invite');

    // The dialog opens for an invitation too — there is always a result to show.
    expect(await screen.findByTestId('credential-dialog')).toBeTruthy();
    expect(screen.getByTestId('credential-link').textContent).toContain(INVITE_TOKEN);
    expect(screen.getByTestId('credential-delivery').textContent).toMatch(/not configured/i);
    expect(screen.getByText(/Not sent — email delivery is not configured/)).toBeTruthy();
    // Never a claim it was emailed.
    expect(document.body.textContent).not.toMatch(/email sent/i);
    expect(document.body.textContent).not.toMatch(/Delivered by email/);
    // No password was issued down this route.
    expect(screen.queryByTestId('credential-value')).toBeNull();
  });

  /**
   * The link must point at the page that actually redeems it.
   *
   * It previously read `/reset-password?token=…`, which no route serves — the
   * redemption page is `ROUTES.acceptInvitation`. An operator copying that
   * handed the recipient a dead URL, and nothing failed loudly enough to say so.
   * Asserting against the ROUTE constant rather than a literal is what keeps the
   * two from drifting apart again.
   */
  it('offers a complete, openable setup link rather than a bare token', async () => {
    mockConsole({ onCreate: () => json(createdSubscriber(INVITATION_CREDENTIAL), 201) });
    render(<SuperAdminConsolePage />);
    await createSubscriber('invite');

    const link = (await screen.findByTestId('credential-link')).textContent ?? '';
    expect(link).toContain(`${ROUTES.acceptInvitation}?token=`);
    expect(link).toContain(encodeURIComponent(INVITE_TOKEN));
    // A path nothing serves would be worse than useless.
    expect(link).not.toContain('/reset-password?token=');
  });

  it('reports a genuine send as delivered', () => {
    render(
      <CredentialResultDialog
        result={{
          subjectName: 'Sent Sam',
          subjectEmail: 'sam@acme.test',
          type: 'invitation',
          invitationToken: 'tok_sent',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          deliveryStatus: 'sent',
          message: 'Invitation emailed.',
        }}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('Delivered by email')).toBeTruthy();
  });

  it('distinguishes a failed delivery from an unconfigured one', () => {
    render(
      <CredentialResultDialog
        result={{
          subjectName: 'Failed Fay',
          subjectEmail: 'fay@acme.test',
          type: 'invitation',
          invitationToken: 'tok_failed',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          deliveryStatus: 'failed',
          message: 'The mail server rejected the message.',
        }}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('Delivery failed')).toBeTruthy();
    expect(screen.queryByText(/Not sent — email delivery is not configured/)).toBeNull();
  });
});

/* ══ 10: a missing credential is never silent success ═════════════════════ */

describe('when creation succeeds but no credential arrives', () => {
  it('shows the explicit recovery instruction instead of unqualified success', async () => {
    mockConsole({ onCreate: () => json(createdSubscriber(undefined), 201) });
    render(<SuperAdminConsolePage />);
    await createSubscriber('temporary');

    const warning = await screen.findByTestId('console-missing-credential');
    expect(warning.textContent).toBe(
      'Subscriber created, but no temporary credential was returned. Generate a new temporary password from the member details.',
    );
    // No credential dialog, and NO success banner.
    expect(screen.queryByTestId('credential-dialog')).toBeNull();
    expect(screen.queryByTestId('console-notice')).toBeNull();
    // The drawer still closed — the subscriber does exist, so retrying is unsafe.
    await waitFor(() => expect(screen.queryByTestId('create-subscriber-submit')).toBeNull());
  });
});

/* ══ 11: reset password uses the same one-time dialog ═════════════════════ */

describe('resetting a password from the member directory', () => {
  function memberRow() {
    return {
      userId: 'usr_1',
      fullName: 'Sam Subscriber',
      email: 'sam@acme.test',
      accountStatus: 'active',
      emailVerified: true,
      mustChangePassword: false,
      locked: false,
      lastLoginAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      organizationId: ORG,
      organizationName: 'Acme Holdings Ltd.',
      organizationStatus: 'active',
      organizationRole: 'owner',
      membershipStatus: 'active',
      isOwner: true,
      platformRoles: [],
      organizationCount: 1,
    };
  }

  function detail() {
    return {
      member: {
        identity: {
          userId: 'usr_1',
          fullName: 'Sam Subscriber',
          email: 'sam@acme.test',
          emailVerified: true,
          emailVerifiedAt: null,
          accountStatus: 'active',
          registeredAt: '2026-01-01T00:00:00.000Z',
          lastLoginAt: null,
          failedLoginCount: 0,
          locked: false,
          lockedUntil: null,
          platformRoles: [],
        },
        organizations: [],
        subscription: null,
        security: {
          activeSessionCount: 2,
          lastSessionAt: null,
          mustChangePassword: false,
          passwordExpiresAt: null,
          hasPendingResetToken: false,
          recentSecurityActions: [],
        },
        administration: { auditHistory: [], internalNotes: null },
      },
    };
  }

  function mockMembers(resetResponse: () => Response) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/reset-password') && method === 'POST') return resetResponse();
      if (url.includes('/api/admin/members/usr_1')) return json(detail());
      if (url.includes('/api/admin/members')) {
        return json({
          members: [memberRow()],
          pagination: { limit: 25, offset: 0, count: 1, total: 1 },
          facets: { accountStatus: { active: 1 }, organizationRole: { owner: 1 } },
        });
      }
      return json({ error: { code: 'not_found', message: `no route ${url}` } }, 404);
    });
  }

  it('opens the same one-time dialog, showing the new password once', async () => {
    mockMembers(() =>
      json({
        member: { userId: 'usr_1', email: 'sam@acme.test', fullName: 'Sam Subscriber' },
        mode: 'temporary',
        credential: { ...TEMPORARY_CREDENTIAL, revokedSessions: 2 },
      }),
    );

    render(<MembersPanel capabilities={SUPER_ADMIN} />);
    fireEvent.click(await screen.findByLabelText('View details for Sam Subscriber'));
    fireEvent.click(await screen.findByTestId('member-reset-temporary'));
    fireEvent.change(await screen.findByTestId('reason-input'), { target: { value: 'Support call.' } });
    fireEvent.click(screen.getByTestId('reason-confirm'));

    expect((await screen.findByTestId('credential-value')).textContent).toBe(TEMP_PASSWORD);
    expect(screen.getByTestId('credential-email').textContent).toBe('sam@acme.test');
    expect(screen.getByTestId('credential-revoked').textContent).toBe('2');

    // Same protection: no accidental dismissal.
    expect((screen.getByTestId('credential-dismiss') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('credential-value').textContent).toBe(TEMP_PASSWORD);

    // And it survives the detail/roster reload the action triggers.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId('credential-value').textContent).toBe(TEMP_PASSWORD);

    fireEvent.click(screen.getByTestId('credential-acknowledge'));
    fireEvent.click(screen.getByTestId('credential-dismiss'));
    await waitFor(() => expect(screen.queryByTestId('credential-dialog')).toBeNull());
    expect(document.body.innerHTML).not.toContain(TEMP_PASSWORD);
  });

  it('warns explicitly when a reset returns no credential', async () => {
    mockMembers(() =>
      json({ member: { userId: 'usr_1', email: 'sam@acme.test', fullName: 'Sam Subscriber' }, mode: 'temporary' }),
    );

    render(<MembersPanel capabilities={SUPER_ADMIN} />);
    fireEvent.click(await screen.findByLabelText('View details for Sam Subscriber'));
    fireEvent.click(await screen.findByTestId('member-reset-temporary'));
    fireEvent.change(await screen.findByTestId('reason-input'), { target: { value: 'Support call.' } });
    fireEvent.click(screen.getByTestId('reason-confirm'));

    expect((await screen.findByTestId('members-missing-credential')).textContent).toMatch(
      /no temporary credential was returned/i,
    );
    expect(screen.queryByTestId('credential-dialog')).toBeNull();
  });

  it('never writes a reset password to browser persistence', async () => {
    mockMembers(() =>
      json({
        member: { userId: 'usr_1', email: 'sam@acme.test', fullName: 'Sam Subscriber' },
        mode: 'temporary',
        credential: TEMPORARY_CREDENTIAL,
      }),
    );

    render(<MembersPanel capabilities={SUPER_ADMIN} />);
    fireEvent.click(await screen.findByLabelText('View details for Sam Subscriber'));
    fireEvent.click(await screen.findByTestId('member-reset-temporary'));
    fireEvent.change(await screen.findByTestId('reason-input'), { target: { value: 'Support call.' } });
    fireEvent.click(screen.getByTestId('reason-confirm'));
    await screen.findByTestId('credential-value');

    expect(JSON.stringify(localStorage)).not.toContain(TEMP_PASSWORD);
    expect(JSON.stringify(sessionStorage)).not.toContain(TEMP_PASSWORD);
    expect(JSON.stringify(useAdminMemberStore.getState())).not.toContain(TEMP_PASSWORD);
  });
});

// @vitest-environment happy-dom
/**
 * Subscriber member and invitation management.
 *
 * What these tests hold the UI to:
 *
 *   authority   management controls appear only for an operator who holds the
 *               authority, and the backend remains the decision-maker;
 *   seats       the server's figures are rendered, never recomputed, and a
 *               concurrent 409 is surfaced with the server's own wording;
 *   honesty     "invitation email sent" appears only for `sent`, and a failed
 *               request never produces a success message;
 *   secrecy     a development-only link is labelled, shown once, cleared on
 *               close, and never written to browser storage;
 *   scope       one subscriber's roster never appears under another's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemberManagementPanel } from './MemberManagementPanel';

const API = 'https://api.example.test';
const ACME = '11111111-1111-4111-8111-111111111111';
const GLOBEX = '22222222-2222-4222-8222-222222222222';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockRoutes(
  routes: Array<[RegExp, (url: string, init?: RequestInit) => Response | Promise<Response>]>,
) {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({
      url: url.replace(API, ''),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
    });
    const hit = routes.find(([pattern]) => pattern.test(url));
    if (!hit) return json({ error: { code: 'not_found', message: `no route for ${url}` } }, 404);
    return hit[1](url, init);
  });
  return calls;
}

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const member = (over: Record<string, unknown> = {}) => ({
  userId: 'usr_active',
  membershipId: 'mem_1',
  email: 'sam@acme.test',
  fullName: 'Sam Member',
  role: 'accountant',
  status: 'active',
  accountStatus: 'active',
  emailVerified: true,
  lastLoginAt: '2026-08-01T09:00:00.000Z',
  joinedAt: '2026-01-05T00:00:00.000Z',
  ...over,
});

const pending = () =>
  member({
    userId: 'usr_pending',
    membershipId: 'mem_2',
    email: 'rami@acme.test',
    fullName: 'Rami Invitee',
    role: 'member',
    status: 'invited',
    emailVerified: false,
    lastLoginAt: null,
  });

const owner = () =>
  member({ userId: 'usr_owner', membershipId: 'mem_0', email: 'owner@acme.test', fullName: 'Olivia Owner', role: 'owner' });

const seats = (over: Record<string, unknown> = {}) => ({
  seats: {
    seatLimit: 3,
    seatsUsed: 2,
    activeMembers: 1,
    pendingInvitations: 1,
    suspendedMembers: 0,
    seatsRemaining: 1,
    atLimit: false,
    ...over,
  },
});

const roster = (members: unknown[], seatLimit: number | null = 3) => ({
  organizationId: ACME,
  members,
  seatsUsed: members.filter((m) => (m as { status: string }).status !== 'suspended').length,
  seatLimit,
  role: 'owner',
});

/** The two reads every panel render performs. */
const readRoutes = (members: unknown[], seatOver: Record<string, unknown> = {}) =>
  [
    [/\/admin\/organizations\/[^/]+\/seats$/, () => json(seats(seatOver))],
    [/\/organizations\/current\/seats/, () => json(seats(seatOver))],
    [/\/organizations\/current\/members/, () => json(roster(members))],
    [/\/admin\/organizations\/[^/]+\/members$/, () => json(roster(members))],
  ] as Array<[RegExp, () => Response]>;

function renderPanel(props: Partial<Record<string, unknown>> = {}) {
  render(
    <MemberManagementPanel
      mode="subscriber"
      organizationId={ACME}
      organizationName="Acme Holdings Ltd."
      canManage
      currentUserId="usr_owner"
      {...(props as object)}
    />,
  );
}

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', API);
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/* ══ Roster, search and filters ══════════════════════════════════════════ */

describe('the member roster', () => {
  it('renders members and pending invitations with their states', async () => {
    mockRoutes(readRoutes([owner(), member(), pending()]));
    renderPanel();

    await screen.findByTestId('member-row-usr_active');
    expect(screen.getByTestId('status-usr_active').textContent).toBe('Active');
    expect(screen.getByTestId('status-usr_pending').textContent).toBe('Invitation pending');
    expect(screen.getByText('rami@acme.test')).toBeTruthy();
  });

  it('filters by search, role and status', async () => {
    mockRoutes(readRoutes([owner(), member(), pending()]));
    renderPanel();
    await screen.findByTestId('member-row-usr_active');

    fireEvent.change(screen.getByTestId('member-search'), { target: { value: 'rami' } });
    expect(screen.queryByTestId('member-row-usr_active')).toBeNull();
    expect(screen.getByTestId('member-row-usr_pending')).toBeTruthy();

    fireEvent.change(screen.getByTestId('member-search'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('member-status-filter'), { target: { value: 'invited' } });
    expect(screen.queryByTestId('member-row-usr_active')).toBeNull();

    fireEvent.change(screen.getByTestId('member-status-filter'), { target: { value: 'all' } });
    fireEvent.change(screen.getByTestId('member-role-filter'), { target: { value: 'accountant' } });
    expect(screen.getByTestId('member-row-usr_active')).toBeTruthy();
    expect(screen.queryByTestId('member-row-usr_pending')).toBeNull();
  });

  it('shows an empty state', async () => {
    mockRoutes(readRoutes([]));
    renderPanel();
    expect((await screen.findByTestId('members-empty')).textContent).toMatch(/No members yet/);
  });

  it('surfaces a failed load rather than an empty roster', async () => {
    mockRoutes([
      [/\/members/, () => json({ error: { code: 'forbidden', message: 'You do not have access.' } }, 403)],
    ]);
    renderPanel();
    expect(await screen.findByText('You do not have access.')).toBeTruthy();
  });
});

/* ══ Authority ═══════════════════════════════════════════════════════════ */

describe('authority', () => {
  it('offers no management controls to an ordinary member', async () => {
    mockRoutes(readRoutes([owner(), member(), pending()]));
    renderPanel({ canManage: false });

    await screen.findByTestId('member-row-usr_active');
    expect(screen.queryByTestId('invite-user')).toBeNull();
    expect(screen.queryByTestId('remove-usr_active')).toBeNull();
    expect(screen.queryByTestId('role-select-usr_active')).toBeNull();
  });

  it('never offers self-management or owner removal', async () => {
    mockRoutes(readRoutes([owner(), member()]));
    renderPanel({ currentUserId: 'usr_active' });
    await screen.findByTestId('member-row-usr_active');

    // Self: no controls — the backend refuses self-promotion.
    expect(screen.queryByTestId('remove-usr_active')).toBeNull();
    expect(within(screen.getByTestId('member-row-usr_active')).getByText('You')).toBeTruthy();

    // Owner: protected, with the reason shown.
    expect(screen.queryByTestId('remove-usr_owner')).toBeNull();
    expect(screen.getByTestId('owner-protected-usr_owner').textContent).toMatch(/transfer ownership/i);
  });
});

/* ══ Seats ═══════════════════════════════════════════════════════════════ */

describe('seat usage', () => {
  it('renders the backend figures, including a per-tenant allowance', async () => {
    mockRoutes(readRoutes([owner(), pending()], { seatLimit: 2, seatsUsed: 2, seatsRemaining: 0, atLimit: true }));
    renderPanel();

    await screen.findByTestId('seat-usage');
    expect(screen.getByTestId('seat-limit').textContent).toBe('2');
    expect(screen.getByTestId('seats-used').textContent).toBe('2');
    // A pending invitation reserves a seat.
    expect(screen.getByTestId('seats-pending').textContent).toBe('1');
    expect(screen.getByTestId('seats-remaining').textContent).toBe('0');
    expect(screen.getByTestId('seat-rule').textContent).toMatch(/each reserve a seat/i);
    expect(screen.getByTestId('seat-limit-reached')).toBeTruthy();
  });

  it('still handles a 409 when another administrator takes the last seat', async () => {
    // The screen shows a seat free, so the button is enabled — and the server
    // refuses anyway. Browser-side availability is never the enforcement.
    mockRoutes([
      ...readRoutes([owner()]),
      [
        /\/users\/invite/,
        () =>
          json(
            {
              error: {
                code: 'conflict',
                message: 'This plan allows 2 users and 2 are in use. Free a seat or upgrade the package to add another.',
              },
            },
            409,
          ),
      ],
    ]);
    renderPanel();

    fireEvent.click(await screen.findByTestId('invite-user'));
    fireEvent.change(screen.getByTestId('invite-name'), { target: { value: 'New Person' } });
    fireEvent.change(screen.getByTestId('invite-email'), { target: { value: 'new@acme.test' } });
    fireEvent.click(screen.getByTestId('invite-submit'));

    expect((await screen.findByTestId('invite-error')).textContent).toMatch(/2 are in use/);
    // No false success anywhere.
    expect(screen.queryByTestId('member-notice')).toBeNull();
  });
});

/* ══ Inviting ════════════════════════════════════════════════════════════ */

describe('inviting a member', () => {
  const inviteRoute = (body: unknown, status = 201): [RegExp, () => Response] => [
    /\/users\/invite/,
    () => json(body, status),
  ];

  const invited = (delivery: string, over: Record<string, unknown> = {}) => ({
    member: pending(),
    expiresAt: '2026-09-01T10:00:00.000Z',
    delivery,
    developmentOnlyLink: false,
    ...over,
  });

  const fill = () => {
    fireEvent.change(screen.getByTestId('invite-name'), { target: { value: 'Rami Invitee' } });
    fireEvent.change(screen.getByTestId('invite-email'), { target: { value: 'rami@acme.test' } });
  };

  it('offers only backend-permitted roles', async () => {
    mockRoutes(readRoutes([owner()]));
    renderPanel();
    fireEvent.click(await screen.findByTestId('invite-user'));

    const options = [...(screen.getByTestId('invite-role') as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(['manager', 'accountant', 'member', 'viewer']);
    // The backend refuses both of these.
    expect(options).not.toContain('owner');
    expect(options).not.toContain('admin');
  });

  it('says an email was sent only when the backend confirms it', async () => {
    mockRoutes([...readRoutes([owner()]), inviteRoute(invited('sent'))]);
    renderPanel();
    fireEvent.click(await screen.findByTestId('invite-user'));
    fill();
    fireEvent.click(screen.getByTestId('invite-submit'));

    expect((await screen.findByTestId('member-notice')).textContent).toBe(
      'Invitation email sent to rami@acme.test.',
    );
  });

  it('does not claim delivery when the transport is unavailable', async () => {
    mockRoutes([...readRoutes([owner()]), inviteRoute(invited('unavailable'))]);
    renderPanel();
    fireEvent.click(await screen.findByTestId('invite-user'));
    fill();
    fireEvent.click(screen.getByTestId('invite-submit'));

    const notice = await screen.findByTestId('member-notice');
    expect(notice.textContent).toMatch(/Invitation created/);
    expect(notice.textContent).toMatch(/not configured/i);
    expect(notice.textContent).not.toMatch(/email sent/i);
  });

  it('reports a delivery failure as recoverable', async () => {
    mockRoutes([...readRoutes([owner()]), inviteRoute(invited('failed'))]);
    renderPanel();
    fireEvent.click(await screen.findByTestId('invite-user'));
    fill();
    fireEvent.click(screen.getByTestId('invite-submit'));

    const notice = await screen.findByTestId('member-notice');
    expect(notice.textContent).toMatch(/could not be delivered/i);
    expect(notice.textContent).toMatch(/resend/i);
    expect(notice.textContent).not.toMatch(/email sent/i);
  });

  it('shows a duplicate-membership refusal from the server', async () => {
    mockRoutes([
      ...readRoutes([owner()]),
      inviteRoute(
        { error: { code: 'conflict', message: 'This person is already a member of this organization.' } },
        409,
      ),
    ]);
    renderPanel();
    fireEvent.click(await screen.findByTestId('invite-user'));
    fill();
    fireEvent.click(screen.getByTestId('invite-submit'));

    expect((await screen.findByTestId('invite-error')).textContent).toMatch(/already a member/i);
  });

  it('prevents a double submission', async () => {
    let release!: (r: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const calls = mockRoutes([...readRoutes([owner()]), [/\/users\/invite/, () => held]]);

    renderPanel();
    fireEvent.click(await screen.findByTestId('invite-user'));
    fill();
    const submit = screen.getByTestId('invite-submit');
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(true));
    expect(calls.filter((c) => c.url.includes('/users/invite'))).toHaveLength(1);
    release(json(invited('sent')));
  });

  /* ── The development-only link ─────────────────────────────────────────── */

  it('never shows a link when the server does not send one', async () => {
    mockRoutes([...readRoutes([owner()]), inviteRoute(invited('sent'))]);
    renderPanel();
    fireEvent.click(await screen.findByTestId('invite-user'));
    fill();
    fireEvent.click(screen.getByTestId('invite-submit'));

    await screen.findByTestId('member-notice');
    // Production behaviour: no token, therefore no link, anywhere.
    expect(screen.queryByTestId('dev-link')).toBeNull();
    expect(document.body.textContent).not.toMatch(/set-password\?token=/);
  });

  it('labels a development link, shows it once, and clears it on close', async () => {
    mockRoutes([
      ...readRoutes([owner()]),
      inviteRoute(
        invited('unavailable', { developmentOnlyLink: true, invitationToken: 'dev-token-value' }),
      ),
    ]);
    renderPanel();
    fireEvent.click(await screen.findByTestId('invite-user'));
    fill();
    fireEvent.click(screen.getByTestId('invite-submit'));

    const panel = await screen.findByTestId('dev-link');
    // Labelled in the heading AND on the badge — both are intended.
    expect(within(panel).getAllByText(/Development only/i).length).toBeGreaterThan(0);
    expect(screen.getByTestId('dev-link-value').textContent).toContain('dev-token-value');

    // Never persisted anywhere.
    const dump = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(dump).not.toContain('dev-token-value');
    expect(window.location.search).not.toContain('dev-token-value');

    // Cleared when the dialog is dismissed — a link must not outlive its dialog.
    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(screen.queryByTestId('dev-link')).toBeNull());
    expect(document.body.textContent).not.toContain('dev-token-value');
  });
});

/* ══ Pending-invitation actions ══════════════════════════════════════════ */

describe('pending invitations', () => {
  it('resends and reports that the previous link is dead', async () => {
    mockRoutes([
      ...readRoutes([owner(), pending()]),
      [
        /\/resend-invitation/,
        () =>
          json({
            member: pending(),
            expiresAt: '2026-09-01T10:00:00.000Z',
            delivery: 'sent',
            developmentOnlyLink: false,
          }),
      ],
    ]);
    renderPanel();

    fireEvent.click(await screen.findByTestId('resend-usr_pending'));
    const notice = await screen.findByTestId('member-notice');
    expect(notice.textContent).toMatch(/Invitation email sent/);
    expect(notice.textContent).toMatch(/earlier link has stopped working/i);
  });

  it('cancels after confirmation and refreshes the seat count', async () => {
    let cancelled = false;
    mockRoutes([
      [/\/organizations\/current\/seats/, () => json(cancelled ? seats({ seatsUsed: 1, pendingInvitations: 0, seatsRemaining: 2 }) : seats())],
      [
        /\/organizations\/current\/members/,
        () => json(roster(cancelled ? [owner()] : [owner(), pending()])),
      ],
      [
        /\/cancel-invitation/,
        () => {
          cancelled = true;
          return json({ cancelled: true });
        },
      ],
    ]);
    renderPanel();

    fireEvent.click(await screen.findByTestId('cancel-invite-usr_pending'));
    // Confirmation is required.
    expect(await screen.findByText(/reserved seat is released/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /cancel invitation/i }));

    await waitFor(() => expect(screen.queryByTestId('member-row-usr_pending')).toBeNull());
    expect(screen.getByTestId('seats-pending').textContent).toBe('0');
    expect(screen.getByTestId('member-notice').textContent).toMatch(/seat released/i);
  });
});

/* ══ Existing member actions ═════════════════════════════════════════════ */

describe('managing an existing member', () => {
  it('changes a role and refreshes from the server', async () => {
    let role = 'accountant';
    mockRoutes([
      [/\/organizations\/current\/seats/, () => json(seats())],
      [/\/organizations\/current\/members/, () => json(roster([owner(), member({ role })]))],
      [
        /\/organizations\/current\/users\/usr_active$/,
        () => {
          role = 'manager';
          return json({ member: member({ role: 'manager' }) });
        },
      ],
    ]);
    renderPanel();

    fireEvent.change(await screen.findByTestId('role-select-usr_active'), {
      target: { value: 'manager' },
    });
    await waitFor(() =>
      expect((screen.getByTestId('role-select-usr_active') as HTMLSelectElement).value).toBe('manager'),
    );
    expect(screen.getByTestId('member-notice').textContent).toMatch(/is now manager/);
  });

  it('suspends after confirmation, explaining the seat and the history', async () => {
    let status = 'active';
    mockRoutes([
      [/\/organizations\/current\/seats/, () => json(seats())],
      [/\/organizations\/current\/members/, () => json(roster([owner(), member({ status })]))],
      [
        /\/organizations\/current\/users\/usr_active$/,
        () => {
          status = 'suspended';
          return json({ member: member({ status: 'suspended' }) });
        },
      ],
    ]);
    renderPanel();

    fireEvent.click(await screen.findByTestId('toggle-status-usr_active'));
    const dialog = await screen.findByText(/seat is released/i);
    // Never implies records are destroyed.
    expect(dialog.textContent).toMatch(/nothing they created is deleted/i);
    fireEvent.click(screen.getByRole('button', { name: /suspend member/i }));

    await waitFor(() => expect(screen.getByTestId('status-usr_active').textContent).toBe('Suspended'));
  });

  it('removes a membership and says it affects this organization only', async () => {
    let removed = false;
    mockRoutes([
      [/\/organizations\/current\/seats/, () => json(seats())],
      [/\/organizations\/current\/members/, () => json(roster(removed ? [owner()] : [owner(), member()]))],
      [
        /\/admin\/organizations\/[^/]+\/members\/usr_active$/,
        () => {
          removed = true;
          return json({ removed: true });
        },
      ],
    ]);
    renderPanel();

    fireEvent.click(await screen.findByTestId('remove-usr_active'));
    const dialog = await screen.findByText(/THIS organization only/i);
    expect(dialog.textContent).toMatch(/removal is not deletion/i);
    fireEvent.click(screen.getByRole('button', { name: /remove from organization/i }));

    await waitFor(() => expect(screen.queryByTestId('member-row-usr_active')).toBeNull());
  });

  it('shows a server refusal instead of a success message', async () => {
    mockRoutes([
      ...readRoutes([owner(), member()]),
      [
        /\/admin\/organizations\/[^/]+\/members\/usr_active$/,
        () =>
          json(
            { error: { code: 'conflict', message: 'The organization must keep at least one active owner.' } },
            409,
          ),
      ],
    ]);
    renderPanel();

    fireEvent.click(await screen.findByTestId('remove-usr_active'));
    fireEvent.click(await screen.findByRole('button', { name: /remove from organization/i }));

    // Shown in the confirmation dialog and in the panel alert — both correct.
    expect((await screen.findAllByText(/must keep at least one active owner/i)).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('member-notice')).toBeNull();
    // Still there — nothing was removed.
    expect(screen.getByTestId('member-row-usr_active')).toBeTruthy();
  });
});

/* ══ Lifecycle ═══════════════════════════════════════════════════════════ */

describe('organization lifecycle', () => {
  for (const status of ['archived', 'pending_deletion']) {
    it(`renders read-only and explains why for a ${status} subscriber`, async () => {
      mockRoutes(readRoutes([owner(), member(), pending()]));
      renderPanel({ organizationStatus: status });

      await screen.findByTestId('member-row-usr_active');
      expect(screen.getByTestId('lifecycle-reason').textContent).toContain(status);
      // No invitation, no reactivation, no removal.
      expect(screen.queryByTestId('invite-user')).toBeNull();
      expect(screen.queryByTestId('toggle-status-usr_active')).toBeNull();
      expect(screen.queryByTestId('remove-usr_active')).toBeNull();
    });
  }

  it('allows management for a SUSPENDED ORGANIZATION, per canonical policy', async () => {
    /*
     * A suspended ORGANIZATION is a live customer with a billing problem, and
     * the canonical backend policy (`INVITABLE_ORGANIZATION_STATUSES`) permits
     * it to keep managing its team. This mirrors the server exactly — it never
     * widens what the server allows.
     */
    mockRoutes(readRoutes([owner(), member()]));
    renderPanel({ organizationStatus: 'suspended' });
    expect(await screen.findByTestId('invite-user')).toBeTruthy();
  });

  it('reactivates a SUSPENDED MEMBER inside an active organization', async () => {
    // The distinction that matters: a suspended member is not a suspended
    // organization, and is reactivatable while the tenant is active.
    let status = 'suspended';
    mockRoutes([
      [/\/organizations\/current\/seats/, () => json(seats())],
      [/\/organizations\/current\/members/, () => json(roster([owner(), member({ status })]))],
      [
        /\/organizations\/current\/users\/usr_active$/,
        () => {
          status = 'active';
          return json({ member: member({ status: 'active' }) });
        },
      ],
    ]);
    renderPanel({ organizationStatus: 'active' });

    expect((await screen.findByTestId('status-usr_active')).textContent).toBe('Suspended');
    const toggle = screen.getByTestId('toggle-status-usr_active');
    expect(toggle.textContent).toBe('Reactivate');

    fireEvent.click(toggle);
    fireEvent.click(await screen.findByRole('button', { name: /reactivate member/i }));

    // The roster is re-read from the server, not patched locally.
    await waitFor(() => expect(screen.getByTestId('status-usr_active').textContent).toBe('Active'));
  });

  it('offers no reactivation for a suspended member in an archived organization', async () => {
    mockRoutes(readRoutes([owner(), member({ status: 'suspended' })]));
    renderPanel({ organizationStatus: 'archived' });
    await screen.findByTestId('member-row-usr_active');
    expect(screen.queryByTestId('toggle-status-usr_active')).toBeNull();
    expect(screen.getByTestId('lifecycle-reason').textContent).toContain('archived');
  });
});

/* ══ Operator mode and tenant scoping ════════════════════════════════════ */

describe('operator mode', () => {
  it('targets the named subscriber explicitly and shows whose members these are', async () => {
    const calls = mockRoutes(readRoutes([owner(), member()]));
    render(
      <MemberManagementPanel
        mode="operator"
        organizationId={GLOBEX}
        organizationName="Globex Corporation"
        canManage
      />,
    );

    await screen.findByTestId('member-row-usr_active');
    expect(screen.getByTestId('managed-organization').textContent).toBe('Globex Corporation');
    // Every request names the subscriber; no "current organization" is used.
    expect(calls.every((c) => !c.url.includes('/organizations/current/'))).toBe(true);
    expect(calls.some((c) => c.url.includes(GLOBEX))).toBe(true);
  });

  it('resends a pending invitation through the organization-targeted route', async () => {
    const calls = mockRoutes([
      ...readRoutes([owner(), pending()]),
      [
        /\/members\/[^/]+\/resend-invitation$/,
        () =>
          json({
            member: pending(),
            expiresAt: '2026-09-01T10:00:00.000Z',
            delivery: 'sent',
            developmentOnlyLink: false,
          }),
      ],
    ]);
    render(
      <MemberManagementPanel mode="operator" organizationId={GLOBEX} organizationName="Globex" canManage />,
    );

    fireEvent.click(await screen.findByTestId('resend-usr_pending'));
    const notice = await screen.findByTestId('member-notice');
    expect(notice.textContent).toMatch(/Invitation email sent/);
    expect(notice.textContent).toMatch(/earlier link has stopped working/i);

    const resend = calls.find((c) => c.url.includes('/resend-invitation'))!;
    // Explicitly targeted; never the caller's "current" organization.
    expect(resend.url).toContain(GLOBEX);
    expect(resend.url).not.toContain('/organizations/current/');
  });

  it('cancels a pending invitation through the organization-targeted route', async () => {
    let cancelled = false;
    const calls = mockRoutes([
      [/\/admin\/organizations\/[^/]+\/seats$/, () => json(seats(cancelled ? { seatsUsed: 1, pendingInvitations: 0, seatsRemaining: 2 } : {}))],
      [
        /\/admin\/organizations\/[^/]+\/members$/,
        () => json(roster(cancelled ? [owner()] : [owner(), pending()])),
      ],
      [
        /\/members\/[^/]+\/cancel-invitation$/,
        () => {
          cancelled = true;
          return json({ cancelled: true });
        },
      ],
    ]);
    render(
      <MemberManagementPanel mode="operator" organizationId={GLOBEX} organizationName="Globex" canManage />,
    );

    fireEvent.click(await screen.findByTestId('cancel-invite-usr_pending'));
    fireEvent.click(await screen.findByRole('button', { name: /cancel invitation/i }));

    await waitFor(() => expect(screen.queryByTestId('member-row-usr_pending')).toBeNull());
    // The released seat is reflected from the backend, not guessed.
    expect(screen.getByTestId('seats-pending').textContent).toBe('0');
    const cancel = calls.find((c) => c.url.includes('/cancel-invitation'))!;
    expect(cancel.url).toContain(GLOBEX);
    expect(cancel.url).not.toContain('/organizations/current/');
  });

  it('reads seat usage from the organization-targeted endpoint', async () => {
    const calls = mockRoutes(
      readRoutes([owner(), pending()], { seatLimit: 5, seatsUsed: 2, pendingInvitations: 1, seatsRemaining: 3 }),
    );
    render(
      <MemberManagementPanel mode="operator" organizationId={GLOBEX} organizationName="Globex" canManage />,
    );

    await screen.findByTestId('seat-usage');
    // Authoritative figures — not decomposed from the roster in the browser.
    expect(screen.getByTestId('seat-limit').textContent).toBe('5');
    expect(screen.getByTestId('seats-remaining').textContent).toBe('3');
    expect(calls.some((c) => c.url === `/api/admin/organizations/${GLOBEX}/seats`)).toBe(true);
  });

  it('never calls a /organizations/current/ endpoint', async () => {
    const calls = mockRoutes(readRoutes([owner(), pending()]));
    render(
      <MemberManagementPanel mode="operator" organizationId={GLOBEX} organizationName="Globex" canManage />,
    );
    await screen.findByTestId('member-row-usr_pending');
    expect(calls.every((c) => !c.url.includes('/organizations/current/'))).toBe(true);
  });

  it('never shows one subscriber’s roster under another', async () => {
    mockRoutes([
      [
        /\/admin\/organizations\/([^/]+)\/members$/,
        (url) =>
          url.includes(ACME)
            ? json(roster([member({ fullName: 'Acme Person', email: 'a@acme.test' })]))
            : json(roster([member({ fullName: 'Globex Person', email: 'g@globex.test' })])),
      ],
    ]);

    const { unmount } = render(
      <MemberManagementPanel mode="operator" organizationId={ACME} organizationName="Acme" canManage />,
    );
    expect(await screen.findByText('Acme Person')).toBeTruthy();
    unmount();

    render(
      <MemberManagementPanel mode="operator" organizationId={GLOBEX} organizationName="Globex" canManage />,
    );
    expect(await screen.findByText('Globex Person')).toBeTruthy();
    expect(screen.queryByText('Acme Person')).toBeNull();
    expect(document.body.textContent).not.toContain('a@acme.test');
  });
});


/* ══ Temporary-password onboarding ═══════════════════════════════════════ */

describe('temporary-password onboarding', () => {
  const TEMP = 'Copper-Lantern-64-Wm';

  const readRoutes = (): Array<[RegExp, () => Response]> => [
    [/\/organizations\/current\/seats/, () => json(seats())],
    [/\/organizations\/current\/members/, () => json(roster([owner(), member()]))],
  ];

  const openDialog = async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId('invite-user'));
  };

  const fillIdentity = () => {
    fireEvent.change(screen.getByTestId('invite-name'), { target: { value: 'Rami Bookkeeper' } });
    fireEvent.change(screen.getByTestId('invite-email'), { target: { value: 'rami@acme.test' } });
  };

  it('offers both methods, with the invitation recommended', async () => {
    mockRoutes(readRoutes());
    await openDialog();

    expect(screen.getByTestId('onboarding-guidance').textContent).toMatch(
      /Invitation link is recommended/i,
    );
    expect((screen.getByTestId('onboarding-invitation') as HTMLInputElement).checked).toBe(true);
    // The password fields only appear once the method is chosen.
    expect(screen.queryByTestId('invite-temp-password')).toBeNull();

    fireEvent.click(screen.getByTestId('onboarding-temporary'));
    expect(screen.getByTestId('invite-temp-password')).toBeTruthy();
    expect(screen.getByTestId('password-requirements').textContent).toMatch(/12 characters/i);
  });

  it('will not submit until the two passwords match', async () => {
    mockRoutes(readRoutes());
    await openDialog();
    fillIdentity();
    fireEvent.click(screen.getByTestId('onboarding-temporary'));

    const submit = () => screen.getByTestId('invite-submit') as HTMLButtonElement;
    fireEvent.change(screen.getByTestId('invite-temp-password'), { target: { value: TEMP } });
    expect(submit().disabled).toBe(true);

    fireEvent.change(screen.getByTestId('invite-temp-confirm'), { target: { value: 'different' } });
    expect(submit().disabled).toBe(true);
    expect(screen.getByText(/two passwords do not match/i)).toBeTruthy();

    fireEvent.change(screen.getByTestId('invite-temp-confirm'), { target: { value: TEMP } });
    expect(submit().disabled).toBe(false);
  });

  it('sends the password to the current-organization endpoint and nowhere else', async () => {
    const calls = mockRoutes([
      ...readRoutes(),
      [
        /\/organizations\/current\/users\/invite/,
        () =>
          json(
            {
              member: member({ userId: 'usr_new', email: 'rami@acme.test', status: 'active' }),
              expiresAt: '2026-09-01T10:00:00.000Z',
              delivery: 'unavailable',
              developmentOnlyLink: false,
              onboarding: 'temporary_password',
              mustChangePassword: true,
            },
            201,
          ),
      ],
    ]);
    await openDialog();
    fillIdentity();
    fireEvent.click(screen.getByTestId('onboarding-temporary'));
    fireEvent.change(screen.getByTestId('invite-temp-password'), { target: { value: TEMP } });
    fireEvent.change(screen.getByTestId('invite-temp-confirm'), { target: { value: TEMP } });
    fireEvent.click(screen.getByTestId('invite-submit'));

    await screen.findByTestId('member-notice');

    const withPassword = calls.filter((c) => c.body.includes(TEMP));
    expect(withPassword).toHaveLength(1);
    expect(withPassword[0]!.url).toBe('/api/organizations/current/users/invite');
    // No organization id is sent — the server derives it from the session.
    expect(withPassword[0]!.body).not.toContain(ACME);
  });

  it('shows the hand-over message and never repeats the password', async () => {
    mockRoutes([
      ...readRoutes(),
      [
        /\/organizations\/current\/users\/invite/,
        () =>
          json(
            {
              member: member({ userId: 'usr_new', email: 'rami@acme.test', status: 'active' }),
              expiresAt: '2026-09-01T10:00:00.000Z',
              delivery: 'unavailable',
              developmentOnlyLink: false,
              onboarding: 'temporary_password',
              mustChangePassword: true,
            },
            201,
          ),
      ],
    ]);
    await openDialog();
    fillIdentity();
    fireEvent.click(screen.getByTestId('onboarding-temporary'));
    fireEvent.change(screen.getByTestId('invite-temp-password'), { target: { value: TEMP } });
    fireEvent.change(screen.getByTestId('invite-temp-confirm'), { target: { value: TEMP } });
    fireEvent.click(screen.getByTestId('invite-submit'));

    const notice = await screen.findByTestId('member-notice');
    expect(notice.textContent).toMatch(/separate secure channel/i);
    expect(notice.textContent).toMatch(/change it at first login/i);
    // Never an email claim, and never the password again.
    expect(notice.textContent).not.toMatch(/email sent/i);
    expect(document.body.textContent).not.toContain(TEMP);
  });

  it('never persists the password anywhere', async () => {
    mockRoutes([
      ...readRoutes(),
      [
        /\/organizations\/current\/users\/invite/,
        () =>
          json(
            {
              member: member({ userId: 'usr_new', status: 'active' }),
              expiresAt: '2026-09-01T10:00:00.000Z',
              delivery: 'unavailable',
              developmentOnlyLink: false,
              onboarding: 'temporary_password',
              mustChangePassword: true,
            },
            201,
          ),
      ],
    ]);
    await openDialog();
    fillIdentity();
    fireEvent.click(screen.getByTestId('onboarding-temporary'));
    fireEvent.change(screen.getByTestId('invite-temp-password'), { target: { value: TEMP } });
    fireEvent.change(screen.getByTestId('invite-temp-confirm'), { target: { value: TEMP } });

    const dump = () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(dump()).not.toContain(TEMP);

    fireEvent.click(screen.getByTestId('invite-submit'));
    await screen.findByTestId('member-notice');
    expect(dump()).not.toContain(TEMP);
    expect(window.location.search).not.toContain(TEMP);
  });

  it('clears the password fields after a failure, keeping the rest', async () => {
    mockRoutes([
      ...readRoutes(),
      [
        /\/organizations\/current\/users\/invite/,
        () =>
          json(
            {
              error: {
                code: 'conflict',
                message:
                  'This email already has a Ledgora account. Send an invitation instead — they will join using their existing password.',
              },
            },
            409,
          ),
      ],
    ]);
    await openDialog();
    fillIdentity();
    fireEvent.click(screen.getByTestId('onboarding-temporary'));
    fireEvent.change(screen.getByTestId('invite-temp-password'), { target: { value: TEMP } });
    fireEvent.change(screen.getByTestId('invite-temp-confirm'), { target: { value: TEMP } });
    fireEvent.click(screen.getByTestId('invite-submit'));

    // The server's own guidance, pointing at the invitation path.
    expect((await screen.findByTestId('invite-error')).textContent).toMatch(/already has a Ledgora account/i);
    expect(screen.getByTestId('invite-error').textContent).toMatch(/invitation/i);

    // Password fields emptied; the identity the operator typed is kept.
    expect((screen.getByTestId('invite-temp-password') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('invite-temp-confirm') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('invite-name') as HTMLInputElement).value).toBe('Rami Bookkeeper');
    // No false success.
    expect(screen.queryByTestId('member-notice')).toBeNull();
  });

  it('clears the password when the dialog is closed', async () => {
    mockRoutes(readRoutes());
    await openDialog();
    fireEvent.click(screen.getByTestId('onboarding-temporary'));
    fireEvent.change(screen.getByTestId('invite-temp-password'), { target: { value: TEMP } });

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByTestId('invite-dialog')).toBeNull());

    // Reopening starts clean — the credential did not survive the dialog.
    fireEvent.click(screen.getByTestId('invite-user'));
    fireEvent.click(screen.getByTestId('onboarding-temporary'));
    expect((screen.getByTestId('invite-temp-password') as HTMLInputElement).value).toBe('');
    expect(document.body.textContent).not.toContain(TEMP);
  });

  it('is not offered to an ordinary member', async () => {
    mockRoutes(readRoutes());
    render(
      <MemberManagementPanel
        mode="subscriber"
        organizationId={ACME}
        organizationName="Acme Holdings Ltd."
        canManage={false}
        currentUserId="usr_other"
      />,
    );
    await screen.findByTestId('member-row-usr_active');
    expect(screen.queryByTestId('invite-user')).toBeNull();
  });
});

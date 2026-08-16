// @vitest-environment happy-dom
/**
 * Who owns user management.
 *
 * ── The correction this suite pins down ──────────────────────────────────────
 * Platform Administration used to carry a global "Add user" button. A member
 * belongs to exactly one subscriber, so "add a user" only means something once
 * you have said WHICH tenant — and answering that with a dropdown in the
 * platform header makes operator-mediated onboarding the normal path. It is not:
 * the subscriber's own Owner or Organization Admin adds their people from inside
 * their workspace, where the organization comes from their authenticated session
 * and cannot be chosen at all.
 *
 * What must remain: "Add subscriber" in the console (creating a TENANT is
 * genuinely platform work), and organization-targeted member support on the
 * subscriber row (clearly secondary, for exceptional administration).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SuperAdminConsolePage } from '@/pages/SuperAdminConsolePage';
import { BackendSubscribersPanel } from '@/components/admin/BackendSubscribersPanel';
import { MemberManagementPanel } from '@/components/members/MemberManagementPanel';
import { NAV_GROUPS } from '@/config/navigation';
import { useSessionStore } from '@/store/sessionStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useAdminSubscriberStore } from '@/store/adminConsoleStores';
import type { PlatformCapabilityName } from '@/services/api/adminConsoleApi';

const API = 'https://api.example.test';
const ACME = '11111111-1111-4111-8111-111111111111';

const SUPER_ADMIN: PlatformCapabilityName[] = [
  'view-admin',
  'subscribers.read',
  'subscribers.create',
  'subscribers.manage',
  'members.read',
  'manage-users',
  'users.create',
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockRoutes(routes: Array<[RegExp, (url: string, init?: RequestInit) => Response]>) {
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

const subscriberRow = () => ({
  organizationId: ACME,
  legalName: 'Acme Holdings Ltd.',
  tradingName: null,
  country: 'AE',
  organizationStatus: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  planId: 'plan_core',
  planCode: 'core',
  planName: 'Core',
  edition: 'core',
  subscriptionId: 'sub_1',
  subscriptionStatus: 'active',
  billingCycle: 'monthly',
  startsAt: null,
  renewsAt: null,
  seatsUsed: 1,
  seatLimit: 3,
  entityLimit: 1,
  modules: [],
  entitlementActive: true,
  ownerUserId: 'usr_owner',
  ownerName: 'Olivia Owner',
  ownerEmail: 'owner@acme.test',
  memberCount: 1,
  openInvoiceId: null,
  openInvoiceStatus: null,
  pendingProofId: null,
});

const member = (over: Record<string, unknown> = {}) => ({
  userId: 'usr_member',
  membershipId: 'mem_1',
  email: 'sam@acme.test',
  fullName: 'Sam Member',
  role: 'accountant',
  status: 'active',
  accountStatus: 'active',
  emailVerified: true,
  lastLoginAt: null,
  joinedAt: '2026-01-05T00:00:00.000Z',
  ...over,
});

const seats = () => ({
  seats: {
    seatLimit: 3,
    seatsUsed: 1,
    activeMembers: 1,
    pendingInvitations: 0,
    suspendedMembers: 0,
    seatsRemaining: 2,
    atLimit: false,
  },
});

const roster = (members: unknown[]) => ({
  organizationId: ACME,
  members,
  seatsUsed: members.length,
  seatLimit: 3,
  role: 'owner',
});

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', API);
  vi.stubEnv('VITE_LEDGORA_DEV_TOOLS', 'true');
  useSessionStore.setState({ platformRole: 'super-admin', userName: 'Operator' });
  // The console renders only for a BACKEND-VERIFIED operator; a browser-set
  // role is deliberately not enough.
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
  useAdminSubscriberStore.getState().clear();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  useAdminSubscriberStore.getState().clear();
  // Return the verified-session store to its default, or a later file inherits
  // an operator identity this one installed.
  useBackendSessionStore.setState({ status: 'unknown', user: null, platformRoles: [], error: null });
  useSessionStore.setState({ platformRole: 'none', userName: 'Visitor' });
});

/**
 * Open the Subscribers tab, where the subscriber controls live.
 *
 * The console opens on the platform OVERVIEW, so a test about the roster's
 * controls selects that tab rather than assuming it is first.
 */
async function openSubscribersTab(): Promise<void> {
  const tab = screen.getAllByRole('tab').find((t) => (t.textContent ?? '').includes('Subscribers'));
  if (tab) fireEvent.click(tab);
  await Promise.resolve();
}

/* ══ Platform Administration ═════════════════════════════════════════════ */

describe('Platform Administration', () => {
  it('no longer offers a global "Add user" control', async () => {
    mockRoutes([
      [/\/api\/admin\/me/, () => json({ capabilities: SUPER_ADMIN })],
      [/\/api\/admin\/subscribers/, () => json({ subscribers: [], pagination: {}, facets: {} })],
      [/\/api\/admin\/applicants/, () => json({ applicants: [], pagination: {}, facets: {} })],
    ]);
    render(<SuperAdminConsolePage />);
    await openSubscribersTab();

    await screen.findByTestId('console-add-subscriber');
    // The control is gone entirely — not merely hidden behind a capability.
    expect(screen.queryByTestId('console-add-user')).toBeNull();
    expect(screen.queryByRole('button', { name: /^add user$/i })).toBeNull();
  });

  it('still offers "Add subscriber", which is genuinely platform work', async () => {
    mockRoutes([
      [/\/api\/admin\/me/, () => json({ capabilities: SUPER_ADMIN })],
      [/\/api\/admin\/subscribers/, () => json({ subscribers: [], pagination: {}, facets: {} })],
      [/\/api\/admin\/applicants/, () => json({ applicants: [], pagination: {}, facets: {} })],
    ]);
    render(<SuperAdminConsolePage />);
    await openSubscribersTab();
    expect(await screen.findByTestId('console-add-subscriber')).toBeTruthy();
  });

  it('keeps organization-targeted member support on the subscriber row', async () => {
    // Secondary and explicitly scoped — not the standard onboarding path.
    mockRoutes([[/\/api\/admin\/subscribers/, () =>
      json({
        subscribers: [subscriberRow()],
        pagination: { limit: 25, offset: 0, count: 1, total: 1 },
        facets: { organizationStatus: {}, subscriptionStatus: {} },
      }),
    ]]);
    render(
      <BackendSubscribersPanel
        capabilities={SUPER_ADMIN}
        onAddSubscriber={vi.fn()}
        onAssignPackage={vi.fn()}
        onViewMembers={vi.fn()}
      />,
    );
    expect(await screen.findByTestId(`manage-members-${ACME}`)).toBeTruthy();
  });
});

/* ══ The subscriber workspace ════════════════════════════════════════════ */

describe('the subscriber sidebar', () => {
  it('names the entry "Users & Roles"', () => {
    const entries = NAV_GROUPS.flatMap((group) => group.items);
    const members = entries.find((item) => item.key === 'members');
    expect(members).toBeTruthy();
    expect(members!.label).toBe('Users & Roles');
    // It belongs to the subscriber workspace, not the platform console.
    expect(members!.platformAdminOnly).toBeFalsy();
  });
});

/* ══ Subscriber invitation ═══════════════════════════════════════════════ */

describe('a subscriber inviting into their own organization', () => {
  const readRoutes = (): Array<[RegExp, () => Response]> => [
    [/\/organizations\/current\/seats/, () => json(seats())],
    [/\/organizations\/current\/members/, () => json(roster([member()]))],
  ];

  const renderSubscriberPanel = () =>
    render(
      <MemberManagementPanel
        mode="subscriber"
        organizationId={ACME}
        organizationName="Acme Holdings Ltd."
        canManage
        currentUserId="usr_owner"
      />,
    );

  it('never asks which organization to invite into', async () => {
    mockRoutes(readRoutes());
    renderSubscriberPanel();
    fireEvent.click(await screen.findByTestId('invite-user'));

    // Full name, email, role — and no organization picker of any kind.
    expect(screen.getByTestId('invite-name')).toBeTruthy();
    expect(screen.getByTestId('invite-email')).toBeTruthy();
    expect(screen.getByTestId('invite-role')).toBeTruthy();
    const dialog = screen.getByTestId('invite-dialog');
    expect(dialog.querySelectorAll('select')).toHaveLength(1); // the role only
    expect(dialog.textContent).not.toMatch(/choose an organization/i);
  });

  it('uses the authenticated current-organization endpoint', async () => {
    const calls = mockRoutes([
      ...readRoutes(),
      [
        /\/organizations\/current\/users\/invite/,
        () =>
          json(
            {
              member: member({ userId: 'usr_new', status: 'invited', email: 'new@acme.test' }),
              expiresAt: '2026-09-01T10:00:00.000Z',
              delivery: 'sent',
              developmentOnlyLink: false,
            },
            201,
          ),
      ],
    ]);
    renderSubscriberPanel();

    fireEvent.click(await screen.findByTestId('invite-user'));
    fireEvent.change(screen.getByTestId('invite-name'), { target: { value: 'New Person' } });
    fireEvent.change(screen.getByTestId('invite-email'), { target: { value: 'new@acme.test' } });
    fireEvent.click(screen.getByTestId('invite-submit'));

    await screen.findByTestId('member-notice');
    const invite = calls.find((c) => c.url.includes('/invite'))!;
    // The organization is derived from the session — no id is sent at all.
    expect(invite.url).toBe('/api/organizations/current/users/invite');
    expect(invite.body).not.toContain(ACME);
    expect(invite.body).not.toContain('organizationId');
  });

  it('offers only roles the invitation route accepts', async () => {
    mockRoutes(readRoutes());
    renderSubscriberPanel();
    fireEvent.click(await screen.findByTestId('invite-user'));

    const options = [...(screen.getByTestId('invite-role') as HTMLSelectElement).options].map((o) => o.value);
    // No platform role, no owner, no admin — the backend refuses all three.
    expect(options).toEqual(['manager', 'accountant', 'member', 'viewer']);
    expect(options).not.toContain('owner');
    expect(options).not.toContain('admin');
    expect(options).not.toContain('super_admin');
  });

  it('reports an existing same-organization membership accurately', async () => {
    mockRoutes([
      ...readRoutes(),
      [
        /\/organizations\/current\/users\/invite/,
        () =>
          json(
            { error: { code: 'conflict', message: 'This person is already a member of this organization.' } },
            409,
          ),
      ],
    ]);
    renderSubscriberPanel();

    fireEvent.click(await screen.findByTestId('invite-user'));
    fireEvent.change(screen.getByTestId('invite-name'), { target: { value: 'Sam Member' } });
    fireEvent.change(screen.getByTestId('invite-email'), { target: { value: 'sam@acme.test' } });
    fireEvent.click(screen.getByTestId('invite-submit'));

    expect((await screen.findByTestId('invite-error')).textContent).toMatch(/already a member/i);
    // No false success.
    expect(screen.queryByTestId('member-notice')).toBeNull();
  });

  it('hides management controls from an ordinary member', async () => {
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
    await screen.findByTestId('member-row-usr_member');
    expect(screen.queryByTestId('invite-user')).toBeNull();
    expect(screen.queryByTestId('remove-usr_member')).toBeNull();
  });
});

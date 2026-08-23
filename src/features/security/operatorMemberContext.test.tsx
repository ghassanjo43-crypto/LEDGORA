// @vitest-environment happy-dom
/**
 * The Members page organization-context defect.
 *
 * Reproduction being pinned: a verified super_admin opens Acme Holdings Ltd.
 * through the console. The operator banner says "Acme Holdings Ltd."; the
 * Members page underneath says "Create your organization first to manage
 * members." Two stores, two different questions:
 *
 *   operatorViewStore.organizationId  → the subscriber being VIEWED  (Acme)
 *   organizationStore.organization    → the ADMINISTRATOR's own org  (null)
 *
 * Both were right. The page was asking the wrong question — a platform operator
 * is deliberately tenantless, and must never be told to create an organization.
 *
 * The rule these tests enforce: ONE resolver answers "which organization is
 * being operated on?", and "create your organization first" is reachable only
 * from a settled SUBSCRIBER lookup that came back empty.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MembersPage } from '@/pages/MembersPage';
import {
  isGenuinelyWithoutOrganization,
  resolveEffectiveOrganization,
  type EffectiveOrganizationInput,
} from '@/lib/effectiveOrganization';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useOperatorViewStore } from '@/store/operatorViewStore';
import { useSessionStore } from '@/store/sessionStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useMemberDirectoryStore } from '@/store/memberDirectoryStore';
import { useViewedOrganizationStore, readEffectiveOrganization } from '@/store/effectiveOrganization';
import { useRouterStore } from '@/store/routerStore';
import { ROUTES } from '@/lib/accessControl';
import type { BackendUser } from '@/services/api/authApi';
import type { Organization, RegisteredUser } from '@/types/onboarding';

const API = 'https://api.example.test';
const ACME = 'org_acme_1';
const GLOBEX = 'org_globex_2';

/** A backend-verified super_admin — the production trust path. */
const ADMIN: BackendUser = {
  id: 'usr_admin_1',
  email: 'ops@ledgora.com',
  fullName: 'Platform Operator',
  status: 'active',
  emailVerified: true,
  mustChangePassword: false,
  platformRoles: ['super_admin'],
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const adminUser: RegisteredUser = {
  id: ADMIN.id,
  fullName: ADMIN.fullName,
  email: ADMIN.email,
  mobile: '',
  country: 'AE',
  passwordHash: '',
  emailVerified: true,
  // The defect in one field: a platform operator has NO organizationId.
  role: 'owner',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const memberPayload = (organizationId: string, legalName: string, people: string[]) => ({
  organizationId,
  organization: { id: organizationId, legalName, status: 'active' },
  members: people.map((name, i) => ({
    userId: `${organizationId}_u${i}`,
    membershipId: `${organizationId}_m${i}`,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.test`,
    fullName: name,
    role: i === 0 ? 'owner' : 'member',
    status: 'active',
    accountStatus: 'active',
    emailVerified: true,
    lastLoginAt: null,
    joinedAt: '2026-01-01T00:00:00.000Z',
  })),
  seatsUsed: people.length,
  seatLimit: 5,
});

/** Route-based fetch stub; records every request path. */
function mockRoutes(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${url.replace(API, '')}`);
    const hit = Object.keys(routes).find((path) => url.includes(path));
    if (!hit) {
      const workspace = url.match(/\/api\/admin\/subscribers\/([^/]+)\/workspace/);
      if (workspace) {
        const organizationId = workspace[1]!;
        return json({
          organizationId,
          workspaceName: organizationId === GLOBEX ? 'Globex LLC' : 'Acme Holdings Ltd.',
          ownerUserId: `${organizationId}_u0`,
        });
      }
      return json({ error: { code: 'not_found', message: 'no route' } }, 404);
    }
    return routes[hit]!(init);
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

/** Sign in the tenantless platform administrator and view a subscriber. */
function operatorViewing(organizationId: string | null, orgName = 'Acme Holdings Ltd.'): void {
  useAuthStore.setState({ users: [adminUser], currentUserId: adminUser.id });
  useBackendSessionStore.setState({ status: 'ready', user: ADMIN, platformRoles: ['super_admin'], error: null });
  // The administrator's OWN organization lookup settled on "none" — correctly.
  useOrganizationStore.setState({
    organization: null,
    hydration: { status: 'ready', confirmedOrganizationId: null, error: null },
  });
  if (organizationId) {
    useOperatorViewStore.getState().enter({ organizationId, orgName });
  }
}

const subscriber: RegisteredUser = {
  id: 'usr_sub_1',
  fullName: 'Sam Subscriber',
  email: 'sam@acme.test',
  mobile: '',
  country: 'AE',
  passwordHash: '',
  emailVerified: true,
  organizationId: ACME,
  role: 'owner',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const acme: Organization = {
  id: ACME,
  ownerUserId: subscriber.id,
  legalName: 'Acme Holdings Ltd.',
  tradingName: 'Acme',
  country: 'AE',
  registrationNumber: '',
  taxNumber: '',
  industry: 'trading',
  baseCurrency: 'AED',
  fiscalYearStart: '01-01',
  booksStartDate: '2026-01-01',
  createdAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubEnv('VITE_API_URL', API);
  useSessionStore.setState({ platformRole: 'none', userName: 'Visitor' });
  useBackendSessionStore.setState({ status: 'unknown', user: null, platformRoles: [], error: null });
  useOperatorViewStore.getState().exit();
  useAuthStore.setState({ users: [], currentUserId: null });
  useOrganizationStore.getState().resetToDefault();
  useMemberDirectoryStore.getState().clear();
  useViewedOrganizationStore.getState().clear();
  useRouterStore.getState().navigate(ROUTES.appDashboard, { replace: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  useOperatorViewStore.getState().exit();
  useMemberDirectoryStore.getState().clear();
  useViewedOrganizationStore.getState().clear();
  useOrganizationStore.getState().resetToDefault();
});

/* ── The pure resolver ───────────────────────────────────────────────────── */

describe('resolveEffectiveOrganization', () => {
  const base: EffectiveOrganizationInput = {
    operatorOverride: 'none',
    isPlatformOperator: false,
    subscriberAvailability: 'present',
    subscriberOrganizationId: ACME,
    subscriberOrganizationName: 'Acme Holdings Ltd.',
    subscriberError: null,
    viewedStatus: 'ready',
    viewedOrganizationId: null,
    viewedOrganizationName: null,
    viewedError: null,
    subscriberCanManage: true,
  };

  it('gives a subscriber their own membership organization', () => {
    const ctx = resolveEffectiveOrganization(base);
    expect(ctx).toMatchObject({ mode: 'subscriber', status: 'ready', organizationId: ACME, canMutate: true });
    expect(isGenuinelyWithoutOrganization(ctx)).toBe(false);
  });

  it('gives an operator in viewing mode the VIEWED organization, not their own', () => {
    const ctx = resolveEffectiveOrganization({
      ...base,
      operatorOverride: 'full_access',
      isPlatformOperator: true,
      // The administrator has none of their own — the whole point.
      subscriberAvailability: 'absent',
      subscriberOrganizationId: null,
      viewedOrganizationId: ACME,
      viewedOrganizationName: 'Acme Holdings Ltd.',
    });
    expect(ctx).toMatchObject({ mode: 'operator', organizationId: ACME, canMutate: true });
    expect(isGenuinelyWithoutOrganization(ctx)).toBe(false);
  });

  it('gives an operator OUTSIDE viewing mode no organization context — and never onboarding', () => {
    const ctx = resolveEffectiveOrganization({
      ...base,
      operatorOverride: 'none',
      isPlatformOperator: true,
      subscriberAvailability: 'absent',
      subscriberOrganizationId: null,
    });
    expect(ctx.mode).toBe('none');
    expect(ctx.organizationId).toBeNull();
    // The message that must never be shown to an administrator.
    expect(isGenuinelyWithoutOrganization(ctx)).toBe(false);
  });

  it('keeps "no organization" honest for a settled subscriber with none', () => {
    const ctx = resolveEffectiveOrganization({
      ...base,
      subscriberAvailability: 'absent',
      subscriberOrganizationId: null,
    });
    expect(isGenuinelyWithoutOrganization(ctx)).toBe(true);
  });

  it('never concludes "none" from a pending or failed lookup', () => {
    for (const availability of ['loading', 'error'] as const) {
      const ctx = resolveEffectiveOrganization({
        ...base,
        subscriberAvailability: availability,
        subscriberOrganizationId: null,
      });
      expect(isGenuinelyWithoutOrganization(ctx)).toBe(false);
    }
  });

  it('makes exact-subscriber view read-only, and full access writable', () => {
    const viewing = { ...base, isPlatformOperator: true, viewedOrganizationId: ACME };
    expect(resolveEffectiveOrganization({ ...viewing, operatorOverride: 'full_access' }).canMutate).toBe(true);
    expect(resolveEffectiveOrganization({ ...viewing, operatorOverride: 'subscriber_view' }).canMutate).toBe(false);
  });

  it('refuses to hand out an id while the viewed organization is unresolved', () => {
    for (const status of ['loading', 'error'] as const) {
      const ctx = resolveEffectiveOrganization({
        ...base,
        operatorOverride: 'full_access',
        isPlatformOperator: true,
        viewedStatus: status,
        viewedOrganizationId: ACME,
      });
      expect(ctx.organizationId).toBeNull();
      expect(ctx.canMutate).toBe(false);
    }
  });
});

/* ── 1–3: the reported defect ────────────────────────────────────────────── */

describe('a tenantless super_admin viewing Acme', () => {
  it('can open Members, and is NOT told to create an organization', async () => {
    operatorViewing(ACME);
    mockRoutes({
      [`/api/admin/organizations/${ACME}/members`]: () =>
        json(memberPayload(ACME, 'Acme Holdings Ltd.', ['Sam Subscriber', 'Dana Clerk'])),
    });

    render(<MembersPage />);

    await waitFor(() => expect(screen.queryByTestId('members-loading')).toBeNull());
    // The defect, gone.
    expect(screen.queryByText(/Create your company workspace first/)).toBeNull();
    expect(await screen.findByTestId('members-operator-context')).toBeTruthy();
  });

  it('loads ACME’s members, not the administrator’s own memberships', async () => {
    operatorViewing(ACME);
    const calls = mockRoutes({
      [`/api/admin/organizations/${ACME}/members`]: () =>
        json(memberPayload(ACME, 'Acme Holdings Ltd.', ['Sam Subscriber', 'Dana Clerk'])),
    });

    render(<MembersPage />);

    expect(await screen.findByText('Sam Subscriber')).toBeTruthy();
    expect(screen.getByText('Dana Clerk')).toBeTruthy();
    // Sourced from the admin-scoped endpoint for the VIEWED organization; the
    // administrator's own `/api/organizations/current` is irrelevant here.
    expect(calls.some((c) => c.includes(`/api/admin/organizations/${ACME}/members`))).toBe(true);
    expect(calls.some((c) => c.includes('/api/organizations/current/members'))).toBe(false);
  });

  it('shows a loading state while the viewed organization resolves', async () => {
    operatorViewing(ACME);
    const gate = deferred<Response>();
    mockRoutes({ [`/api/admin/organizations/${ACME}/members`]: () => gate.promise });

    render(<MembersPage />);

    expect(await screen.findByTestId('members-loading')).toBeTruthy();
    // Never the accusation, while we do not yet know.
    expect(screen.queryByText(/Create your company workspace first/)).toBeNull();

    gate.resolve(json(memberPayload(ACME, 'Acme Holdings Ltd.', ['Sam Subscriber'])));
    await waitFor(() => expect(screen.queryByTestId('members-loading')).toBeNull());
  });

  it('reports a vanished organization as an error, never as "create one"', async () => {
    operatorViewing(ACME);
    mockRoutes({
      [`/api/admin/subscribers/${ACME}/workspace`]: () =>
        json({ error: { code: 'not_found', message: 'Subscriber workspace not found.' } }, 404),
      [`/api/admin/organizations/${ACME}/members`]: () =>
        json({ error: { code: 'not_found', message: 'Organization not found.' } }, 404),
    });

    render(<MembersPage />);

    expect(await screen.findByTestId('members-error')).toBeTruthy();
    expect(screen.getByText(/no longer exists/)).toBeTruthy();
    expect(screen.queryByText(/Create your company workspace first/)).toBeNull();
  });

  it('reports a permission failure as such', async () => {
    operatorViewing(ACME);
    mockRoutes({
      [`/api/admin/subscribers/${ACME}/workspace`]: () =>
        json({ error: { code: 'forbidden', message: 'nope' } }, 403),
      [`/api/admin/organizations/${ACME}/members`]: () =>
        json({ error: { code: 'forbidden', message: 'nope' } }, 403),
    });

    render(<MembersPage />);

    expect(await screen.findByTestId('members-error')).toBeTruthy();
    expect(screen.getByText(/do not have permission/)).toBeTruthy();
  });
});

/* ── 4–5: organization switching ─────────────────────────────────────────── */

describe('switching the viewed organization', () => {
  it('reloads the correct member list', async () => {
    operatorViewing(ACME);
    mockRoutes({
      [`/api/admin/organizations/${ACME}/members`]: () =>
        json(memberPayload(ACME, 'Acme Holdings Ltd.', ['Sam Subscriber'])),
      [`/api/admin/organizations/${GLOBEX}/members`]: () =>
        json(memberPayload(GLOBEX, 'Globex Corp.', ['Ravi Owner'])),
    });

    const view = render(<MembersPage />);
    expect(await screen.findByText('Sam Subscriber')).toBeTruthy();

    // The administrator picks a different subscriber.
    useMemberDirectoryStore.getState().clear();
    useViewedOrganizationStore.getState().clear();
    useOperatorViewStore.getState().enter({ organizationId: GLOBEX, orgName: 'Globex Corp.' });
    view.rerender(<MembersPage />);

    expect(await screen.findByText('Ravi Owner')).toBeTruthy();
    // Acme's people are gone — never shown under Globex.
    expect(screen.queryByText('Sam Subscriber')).toBeNull();
  });

  it('a stale response cannot populate members from the previous organization', async () => {
    // Acme's request is slow; the administrator switches to Globex before it
    // lands. Acme's answer must be discarded, not rendered under Globex.
    const acmeGate = deferred<Response>();
    mockRoutes({
      [`/api/admin/organizations/${ACME}/members`]: () => acmeGate.promise,
      [`/api/admin/organizations/${GLOBEX}/members`]: () =>
        json(memberPayload(GLOBEX, 'Globex Corp.', ['Ravi Owner'])),
    });

    const directory = useMemberDirectoryStore.getState();
    const slow = directory.load({ organizationId: ACME, mode: 'operator' });
    // Switch mid-flight.
    const fast = directory.load({ organizationId: GLOBEX, mode: 'operator' });
    await fast;

    expect(useMemberDirectoryStore.getState().loadedOrganizationId).toBe(GLOBEX);
    expect(useMemberDirectoryStore.getState().members.map((m) => m.fullName)).toEqual(['Ravi Owner']);

    // Acme finally answers — and is ignored.
    acmeGate.resolve(json(memberPayload(ACME, 'Acme Holdings Ltd.', ['Sam Subscriber'])));
    await slow;

    expect(useMemberDirectoryStore.getState().loadedOrganizationId).toBe(GLOBEX);
    expect(useMemberDirectoryStore.getState().members.map((m) => m.fullName)).toEqual(['Ravi Owner']);
  });

  it('clear() invalidates an in-flight response too', async () => {
    const gate = deferred<Response>();
    mockRoutes({ [`/api/admin/organizations/${ACME}/members`]: () => gate.promise });

    const pending = useMemberDirectoryStore.getState().load({ organizationId: ACME, mode: 'operator' });
    useMemberDirectoryStore.getState().clear();
    gate.resolve(json(memberPayload(ACME, 'Acme Holdings Ltd.', ['Sam Subscriber'])));
    await pending;

    expect(useMemberDirectoryStore.getState().members).toEqual([]);
    expect(useMemberDirectoryStore.getState().loadedOrganizationId).toBeNull();
  });

  it('a failed load leaves no roster behind', async () => {
    mockRoutes({
      [`/api/admin/organizations/${ACME}/members`]: () =>
        json(memberPayload(ACME, 'Acme Holdings Ltd.', ['Sam Subscriber'])),
      [`/api/admin/organizations/${GLOBEX}/members`]: () =>
        json({ error: { code: 'internal_error', message: 'boom' } }, 500),
    });

    await useMemberDirectoryStore.getState().load({ organizationId: ACME, mode: 'operator' });
    expect(useMemberDirectoryStore.getState().members).toHaveLength(1);

    await useMemberDirectoryStore.getState().load({ organizationId: GLOBEX, mode: 'operator' });
    expect(useMemberDirectoryStore.getState().status).toBe('error');
    // Showing Acme's people beside a Globex failure would be worse than nothing.
    expect(useMemberDirectoryStore.getState().members).toEqual([]);
  });
});

/* ── 6: the subscriber path is unchanged ─────────────────────────────────── */

describe('an ordinary subscriber', () => {
  it('with no organization still sees the creation message', async () => {
    useAuthStore.setState({ users: [{ ...subscriber, organizationId: undefined }], currentUserId: subscriber.id });
    useOrganizationStore.setState({
      organization: null,
      hydration: { status: 'ready', confirmedOrganizationId: null, error: null },
    });
    mockRoutes({ '/api/organizations/current/members': () => json({ organizationId: null, members: [], seatsUsed: 0, seatLimit: null, role: null }) });

    render(<MembersPage />);

    expect(await screen.findByText('Create your company workspace first to manage members.')).toBeTruthy();
  });

  it('with an organization loads their OWN members through the subscriber endpoint', async () => {
    useAuthStore.setState({ users: [subscriber], currentUserId: subscriber.id });
    useOrganizationStore.setState({
      organization: acme,
      hydration: { status: 'ready', confirmedOrganizationId: ACME, error: null },
    });
    const calls = mockRoutes({
      '/api/organizations/current/members': () =>
        json({ ...memberPayload(ACME, 'Acme Holdings Ltd.', ['Sam Subscriber']), role: 'owner' }),
    });

    render(<MembersPage />);

    expect(await screen.findByText('Sam Subscriber')).toBeTruthy();
    expect(calls.some((c) => c.includes('/api/organizations/current/members'))).toBe(true);
    // A subscriber never touches the admin-scoped route.
    expect(calls.some((c) => c.includes('/api/admin/'))).toBe(false);
    expect(screen.queryByTestId('members-operator-context')).toBeNull();
  });

  it('is never shown the operator context banner', () => {
    useAuthStore.setState({ users: [subscriber], currentUserId: subscriber.id });
    useOrganizationStore.setState({
      organization: acme,
      hydration: { status: 'ready', confirmedOrganizationId: ACME, error: null },
    });
    // A tenant plants operator-view state in sessionStorage. Their effective
    // role is 'none', so the resolver gives them subscriber mode regardless.
    useSessionStore.setState({ platformRole: 'super-admin' });
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);
    useOperatorViewStore.getState().enter({ organizationId: GLOBEX, orgName: 'Globex Corp.' });

    expect(readEffectiveOrganization()).toMatchObject({ mode: 'subscriber', organizationId: ACME });
  });
});

/* ── 7: an operator outside viewing mode ─────────────────────────────────── */

describe('a super_admin outside operator view', () => {
  it('is sent to the admin console, never to organization onboarding', async () => {
    operatorViewing(null); // signed in as the operator, viewing nobody
    mockRoutes({});

    render(<MembersPage />);

    expect(await screen.findByTestId('members-no-selection')).toBeTruthy();
    expect(screen.queryByText(/Create your company workspace first/)).toBeNull();

    const back = screen.getByRole('button', { name: /Back to admin console/ });
    back.click();
    await waitFor(() => expect(useRouterStore.getState().path).toBe(ROUTES.adminConsole));
  });

  it('resolves to mode "none" rather than a subscriber with no organization', () => {
    operatorViewing(null);
    expect(readEffectiveOrganization().mode).toBe('none');
  });
});

/* ── 12: exact-subscriber mode ───────────────────────────────────────────── */

describe('view exactly as subscriber', () => {
  it('shows the subscriber’s real seat limit and disables member mutations', async () => {
    operatorViewing(ACME);
    useOperatorViewStore.getState().setViewAsSubscriber(true);
    mockRoutes({
      [`/api/admin/organizations/${ACME}/members`]: () => json(memberPayload(ACME, 'Acme Holdings Ltd.', ['Sam Subscriber'])),
    });

    render(<MembersPage />);

    // The explicit way back, rather than a silently dead button.
    expect(await screen.findByTestId('members-exact-view-readonly')).toBeTruthy();
    expect(screen.getByText(/Return to administrator view to manage members/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send invite' })).toBeNull();
    // The subscriber's ACTUAL seat allowance, from their subscription.
    expect(await screen.findByText('1 / 5')).toBeTruthy();
  });

  it('still resolves the viewed organization — it is not a lockout', () => {
    operatorViewing(ACME);
    useOperatorViewStore.getState().setViewAsSubscriber(true);
    useViewedOrganizationStore.setState({
      status: 'ready',
      organizationId: ACME,
      organizationName: 'Acme Holdings Ltd.',
      error: null,
    });
    expect(readEffectiveOrganization()).toMatchObject({ mode: 'operator', organizationId: ACME, canMutate: false });
  });
});

/* ── 13: entitlements untouched ──────────────────────────────────────────── */

describe('operator member management leaves the subscription alone', () => {
  it('does not write to the subscriber’s entitlement or organization records', async () => {
    operatorViewing(ACME);
    mockRoutes({
      [`/api/admin/organizations/${ACME}/members`]: () => json(memberPayload(ACME, 'Acme Holdings Ltd.', ['Sam Subscriber'])),
    });

    const orgBefore = useOrganizationStore.getState().organization;
    const subBefore = useOrganizationStore.getState().subscription;

    render(<MembersPage />);
    await waitFor(() => expect(screen.queryByTestId('members-loading')).toBeNull());

    // The administrator is NOT given a membership, and the tenant's records are
    // exactly as they were.
    expect(useOrganizationStore.getState().organization).toBe(orgBefore);
    expect(useOrganizationStore.getState().subscription).toBe(subBefore);
    expect(useAuthStore.getState().users.find((u) => u.id === adminUser.id)?.organizationId).toBeUndefined();
  });
});

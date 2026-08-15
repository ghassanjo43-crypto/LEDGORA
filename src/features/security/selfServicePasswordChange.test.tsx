// @vitest-environment happy-dom
/**
 * Self-service password change, driven through the REAL client stack.
 *
 * Only `fetch` is stubbed. Everything between the rendered form and that call —
 * `ChangePasswordForm`, `authApi`, `apiRequest`, the CSRF header, `ApiError`
 * shaping and the session refresh afterwards — is the production code, so these
 * tests fail if any link in that chain breaks. Asserting "a button exists" would
 * prove none of it.
 *
 * The claims:
 *
 *   identity    the request carries the two passwords and NOTHING that could
 *               name a different user;
 *   parity      a platform super administrator, a subscriber owner and an
 *               ordinary member get the same form on the same route, gated by
 *               being signed in and by nothing else;
 *   validation  a mismatch, a weak password and a reuse of the current one are
 *               each refused BEFORE a request is made;
 *   honesty     a server refusal is reported as a refusal, never as success;
 *   hygiene     on success every field is emptied, and no password reaches the
 *               URL, localStorage or sessionStorage at any point.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { AccountSecurityPanel } from '@/components/account/AccountSecurityPanel';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { ToastProvider } from '@/components/ui/Toast';
import { SuperAdminConsolePage } from '@/pages/SuperAdminConsolePage';
import { isPathAllowed, ROUTES, surfaceOf } from '@/lib/accessControl';
import { ALL_NAV_ITEMS } from '@/config/navigation';
import { useSessionStore } from '@/store/sessionStore';
import { useBillingStore } from '@/store/billingStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import type { BackendPlatformRole, BackendUser } from '@/services/api/authApi';

const API = 'https://api.example.test';

const CURRENT = 'Correct-Horse-9-Battery';
const NEXT = 'Rotated-Secret-42-Ok';

/* ── Personas. The ONLY difference between them is their platform roles. ───── */

const persona = (over: Partial<BackendUser> = {}): BackendUser => ({
  id: 'user-1',
  email: 'ada@example.test',
  fullName: 'Ada Lovelace',
  status: 'active',
  emailVerified: true,
  mustChangePassword: false,
  platformRoles: [],
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const SUPER_ADMIN = persona({
  id: 'user-op',
  email: 'operator@ledgora.test',
  fullName: 'Platform Operator',
  platformRoles: ['super_admin'],
});
const SUBSCRIBER_OWNER = persona({ id: 'user-owner', email: 'owner@newco.test', fullName: 'Owner Person' });
const MEMBER = persona({ id: 'user-member', email: 'member@newco.test', fullName: 'Ordinary Member' });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Route-based fetch stub, matched on a URL fragment. */
function mockRoutes(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const hit = Object.keys(routes).find((path) => url.includes(path));
    if (!hit) return json({ error: { code: 'not_found', message: 'No route.' } }, 404);
    return routes[hit]!(init as RequestInit);
  });
}

/** The routes a successful change touches: the change itself, then the refresh. */
function happyPath(user: BackendUser, changeResponse?: () => Response | Promise<Response>) {
  return mockRoutes({
    '/api/auth/change-password': changeResponse ?? (() => json({ ok: true, platformRoles: user.platformRoles })),
    '/api/auth/session': () => json({ authenticated: true, user, csrfToken: 'csrf-token' }),
    '/api/organizations/current': () => json({ organization: null }),
  });
}

function signedInAs(user: BackendUser): void {
  useBackendSessionStore.setState({
    status: 'ready',
    user,
    platformRoles: user.platformRoles as BackendPlatformRole[],
    error: null,
  });
}

/* ── Form driving helpers ─────────────────────────────────────────────────── */

const currentField = () => screen.getByLabelText(/^current password/i) as HTMLInputElement;
const newField = () => screen.getByLabelText(/^new password/i) as HTMLInputElement;
const confirmField = () => screen.getByLabelText(/^confirm new password/i) as HTMLInputElement;
/** Matches both resting ("Change password") and busy ("Changing password…"). */
const submitButton = () => screen.getByRole('button', { name: /chang(e|ing) password/i });

function fill(values: { current?: string; next?: string; confirm?: string }): void {
  if (values.current !== undefined) fireEvent.change(currentField(), { target: { value: values.current } });
  if (values.next !== undefined) fireEvent.change(newField(), { target: { value: values.next } });
  if (values.confirm !== undefined) fireEvent.change(confirmField(), { target: { value: values.confirm } });
}

/** The parsed body of the change-password call, or null if it never happened. */
function changeRequestBody(spy: ReturnType<typeof mockRoutes>): Record<string, unknown> | null {
  const call = spy.mock.calls.find(([url]) => String(url).includes('/api/auth/change-password'));
  if (!call) return null;
  const init = call[1] as RequestInit | undefined;
  return typeof init?.body === 'string' ? JSON.parse(init.body) : null;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubEnv('VITE_API_URL', API);
  useBackendSessionStore.getState().clear();
  useAuthStore.setState({ users: [], currentUserId: null });
  useOrganizationStore.setState({ organization: null, subscription: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/* ── Parity across the three personas ─────────────────────────────────────── */

describe('every authenticated persona gets the same capability', () => {
  it.each([
    ['super admin', SUPER_ADMIN],
    ['subscriber owner', SUBSCRIBER_OWNER],
    ['ordinary member', MEMBER],
  ])('renders the change-password form for a %s', (_label, user) => {
    signedInAs(user);
    render(<AccountSecurityPanel />);

    expect(currentField()).toBeTruthy();
    expect(newField()).toBeTruthy();
    expect(confirmField()).toBeTruthy();
    expect(submitButton()).toBeTruthy();
    // The panel names the account being changed, so nobody can mistake it for
    // an administrative tool that acts on somebody else.
    expect(screen.getByText(new RegExp(user.email.replace('.', '\\.'), 'i'))).toBeTruthy();
  });

  it.each([
    ['super admin', SUPER_ADMIN],
    ['subscriber owner', SUBSCRIBER_OWNER],
    ['ordinary member', MEMBER],
  ])('lets a %s reach /account/security with no subscription or entitlement', (_label, user) => {
    // The account surface is granted on being SIGNED IN. Not on a plan, not on
    // an organization, and not on any bookkeeping permission.
    expect(surfaceOf(ROUTES.accountSecurity)).toBe('account');
    expect(
      isPathAllowed(
        {
          user: { emailVerified: user.emailVerified },
          hasOrganization: false,
          subscriptionStatus: null,
          platformRole: user.platformRoles.length > 0 ? 'super-admin' : 'none',
        },
        ROUTES.accountSecurity,
      ),
    ).toBe(true);
  });

  it('refuses the account surface to a visitor with no session', () => {
    expect(
      isPathAllowed(
        { user: null, hasOrganization: false, subscriptionStatus: null },
        ROUTES.accountSecurity,
      ),
    ).toBe(false);
  });

  it('stays reachable when the subscription has lapsed — exactly when it matters', () => {
    for (const status of ['expired', 'suspended', 'rejected'] as const) {
      expect(
        isPathAllowed(
          { user: { emailVerified: true }, hasOrganization: true, subscriptionStatus: status },
          ROUTES.accountSecurity,
        ),
      ).toBe(true);
    }
  });
});

/* ── What actually goes over the wire ─────────────────────────────────────── */

describe('the request', () => {
  it('sends only the two passwords — no user id, email or role', async () => {
    signedInAs(MEMBER);
    const spy = happyPath(MEMBER);
    render(<AccountSecurityPanel />);

    fill({ current: CURRENT, next: NEXT, confirm: NEXT });
    fireEvent.click(submitButton());

    await waitFor(() => expect(changeRequestBody(spy)).not.toBeNull());
    const body = changeRequestBody(spy)!;

    expect(body).toEqual({ currentPassword: CURRENT, newPassword: NEXT });
    // Nothing in the payload could ever name a different account.
    expect(Object.keys(body)).toEqual(['currentPassword', 'newPassword']);
    for (const forbidden of ['userId', 'user_id', 'email', 'id', 'role']) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it('posts to the one shared endpoint whichever persona is signed in', async () => {
    for (const user of [SUPER_ADMIN, SUBSCRIBER_OWNER, MEMBER]) {
      signedInAs(user);
      const spy = happyPath(user);
      render(<AccountSecurityPanel />);

      fill({ current: CURRENT, next: NEXT, confirm: NEXT });
      fireEvent.click(submitButton());

      await waitFor(() => expect(changeRequestBody(spy)).not.toBeNull());
      const call = spy.mock.calls.find(([url]) => String(url).includes('/api/auth/change-password'))!;
      expect(String(call[0])).toBe(`${API}/api/auth/change-password`);
      expect((call[1] as RequestInit).method).toBe('POST');
      // The session cookie is what identifies the caller, so it must travel.
      expect((call[1] as RequestInit).credentials).toBe('include');

      cleanup();
      vi.restoreAllMocks();
    }
  });
});

/* ── Client-side validation, before anything is sent ──────────────────────── */

describe('validation refuses a bad change without calling the server', () => {
  beforeEach(() => signedInAs(MEMBER));

  it('reports a confirmation that does not match', async () => {
    const spy = happyPath(MEMBER);
    render(<AccountSecurityPanel />);

    fill({ current: CURRENT, next: NEXT, confirm: 'Different-Secret-42-Ok' });
    fireEvent.click(submitButton());

    expect(await screen.findByText(/do not match/i)).toBeTruthy();
    expect(changeRequestBody(spy)).toBeNull();
  });

  it('lists every policy rule a weak password breaks', async () => {
    const spy = happyPath(MEMBER);
    render(<AccountSecurityPanel />);

    fill({ current: CURRENT, next: 'short', confirm: 'short' });
    fireEvent.click(submitButton());

    const problems = await screen.findByTestId('change-password-problems');
    expect(problems.textContent).toMatch(/at least 12 characters/i);
    expect(problems.textContent).toMatch(/upper and lower case/i);
    expect(problems.textContent).toMatch(/at least one digit/i);
    expect(changeRequestBody(spy)).toBeNull();
  });

  it('refuses a new password identical to the current one', async () => {
    const spy = happyPath(MEMBER);
    render(<AccountSecurityPanel />);

    fill({ current: CURRENT, next: CURRENT, confirm: CURRENT });
    fireEvent.click(submitButton());

    expect(await screen.findByText(/different from your current one/i)).toBeTruthy();
    expect(changeRequestBody(spy)).toBeNull();
  });

  it('refuses a password containing the account name or address', async () => {
    const spy = happyPath(MEMBER);
    render(<AccountSecurityPanel />);

    // MEMBER is "Ordinary Member" at member@newco.test.
    fill({ current: CURRENT, next: 'Ordinary-Pass-42', confirm: 'Ordinary-Pass-42' });
    fireEvent.click(submitButton());

    const problems = await screen.findByTestId('change-password-problems');
    expect(problems.textContent).toMatch(/must not contain your name/i);
    expect(changeRequestBody(spy)).toBeNull();
  });
});

/* ── Server responses ─────────────────────────────────────────────────────── */

describe('the response', () => {
  it('confirms success and empties every password field', async () => {
    signedInAs(MEMBER);
    happyPath(MEMBER);
    render(<AccountSecurityPanel />);

    fill({ current: CURRENT, next: NEXT, confirm: NEXT });
    fireEvent.click(submitButton());

    expect(await screen.findByTestId('change-password-success')).toBeTruthy();

    // Nothing is left on screen for the next person at this desk to read.
    await waitFor(() => {
      expect(currentField().value).toBe('');
      expect(newField().value).toBe('');
      expect(confirmField().value).toBe('');
    });
    // …and the fields are masked again, whatever the reveal toggles were set to.
    expect(currentField().type).toBe('password');
    expect(newField().type).toBe('password');
    expect(confirmField().type).toBe('password');
  });

  it('reports an incorrect current password and does not claim success', async () => {
    signedInAs(MEMBER);
    happyPath(MEMBER, () =>
      json({ error: { code: 'invalid_credentials', message: 'Incorrect email or password.' } }, 401),
    );
    render(<AccountSecurityPanel />);

    fill({ current: 'Wrong-Password-11', next: NEXT, confirm: NEXT });
    fireEvent.click(submitButton());

    expect(await screen.findByTestId('change-password-error')).toBeTruthy();
    expect(screen.getByTestId('change-password-error').textContent).toMatch(/not correct/i);
    expect(screen.queryByTestId('change-password-success')).toBeNull();
    // The new password is kept so the user can retry after fixing the first
    // field — retyping a long password you got right is its own hazard.
    expect(newField().value).toBe(NEXT);
  });

  it('shows the policy problems the SERVER reports, even when the client saw none', async () => {
    signedInAs(MEMBER);
    happyPath(MEMBER, () =>
      json(
        {
          error: {
            code: 'password_policy',
            message: 'Password does not meet the policy.',
            details: { problems: ['That password is too common.'] },
          },
        },
        400,
      ),
    );
    render(<AccountSecurityPanel />);

    // Passes every local rule; only the server's blocklist knows better.
    fill({ current: CURRENT, next: 'Passw0rdPassw0rd', confirm: 'Passw0rdPassw0rd' });
    fireEvent.click(submitButton());

    const problems = await screen.findByTestId('change-password-problems');
    expect(problems.textContent).toMatch(/too common/i);
    expect(screen.queryByTestId('change-password-success')).toBeNull();
  });

  it('disables the submit button while the change is in flight', async () => {
    signedInAs(MEMBER);
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    happyPath(MEMBER, async () => {
      await pending;
      return json({ ok: true, platformRoles: [] });
    });
    render(<AccountSecurityPanel />);

    fill({ current: CURRENT, next: NEXT, confirm: NEXT });
    fireEvent.click(submitButton());

    await waitFor(() => expect((submitButton() as HTMLButtonElement).disabled).toBe(true));

    release!();
    await waitFor(() => expect((submitButton() as HTMLButtonElement).disabled).toBe(false));
    expect(await screen.findByTestId('change-password-success')).toBeTruthy();
  });
});

/* ── Hygiene ──────────────────────────────────────────────────────────────── */

describe('no password escapes the form', () => {
  const storageValues = (): string => {
    const dump: string[] = [];
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key) dump.push(key, store.getItem(key) ?? '');
      }
    }
    return dump.join(' ');
  };

  it('writes neither password to localStorage, sessionStorage or the URL', async () => {
    signedInAs(MEMBER);
    happyPath(MEMBER);
    render(<AccountSecurityPanel />);

    fill({ current: CURRENT, next: NEXT, confirm: NEXT });

    // Typed but not yet submitted: the values exist only in React state.
    expect(storageValues()).not.toContain(CURRENT);
    expect(storageValues()).not.toContain(NEXT);

    fireEvent.click(submitButton());
    await screen.findByTestId('change-password-success');

    // After a full round trip, including the session refresh that repopulates
    // the local mirror, neither password is anywhere persistent.
    const dump = storageValues();
    expect(dump).not.toContain(CURRENT);
    expect(dump).not.toContain(NEXT);
    expect(window.location.href).not.toContain(CURRENT);
    expect(window.location.href).not.toContain(NEXT);
    expect(window.location.search).toBe('');
  });

  it('never puts a password in a GET query string', async () => {
    signedInAs(MEMBER);
    const spy = happyPath(MEMBER);
    render(<AccountSecurityPanel />);

    fill({ current: CURRENT, next: NEXT, confirm: NEXT });
    fireEvent.click(submitButton());
    await screen.findByTestId('change-password-success');

    for (const [url] of spy.mock.calls) {
      expect(String(url)).not.toContain(CURRENT);
      expect(String(url)).not.toContain(NEXT);
    }
  });
});

/* ── The in-app settings surface ──────────────────────────────────────────── */

describe('Settings → Security', () => {
  const openSecurityTab = (): void => {
    const tab = screen.getAllByRole('tab').find((t) => (t.textContent ?? '').includes('Security'));
    expect(tab).toBeTruthy();
    fireEvent.click(tab!);
  };

  it.each([
    ['subscriber owner', SUBSCRIBER_OWNER],
    ['ordinary member', MEMBER],
  ])('exposes the change-password form to a %s inside the application', (_label, user) => {
    signedInAs(user);
    happyPath(user);

    render(
      <ToastProvider>
        <SettingsPanel />
      </ToastProvider>,
    );

    openSecurityTab();

    expect(currentField()).toBeTruthy();
    expect(newField()).toBeTruthy();
    expect(confirmField()).toBeTruthy();
  });

  it('keeps the security section free of any module or bookkeeping requirement', () => {
    /*
     * The Settings view carries no `requiredModule` in the navigation config, so
     * the tab it hosts cannot be hidden by an entitlement. Pinning that here
     * means adding a module requirement to Settings later fails this test rather
     * than silently locking somebody out of their own password.
     */
    const settings = ALL_NAV_ITEMS.find((item) => item.key === 'settings');
    expect(settings).toBeTruthy();
    expect(settings?.requiredModule).toBeUndefined();
    expect(settings?.requiredAnyModules).toBeUndefined();
    expect(settings?.requiredAllModules).toBeUndefined();
  });

  it('offers no company Save/Cancel footer on the Security tab', () => {
    signedInAs(MEMBER);
    happyPath(MEMBER);

    render(
      <ToastProvider>
        <SettingsPanel />
      </ToastProvider>,
    );

    openSecurityTab();

    // The company draft footer belongs to the company tabs; showing it here
    // would imply a password is saved by the same button as an address.
    expect(screen.queryByRole('button', { name: /^save changes$/i })).toBeNull();
  });
});

/* ── The platform console surface ─────────────────────────────────────────── */

describe('platform console → My account', () => {
  it('lets a verified super administrator change their password without leaving the console', async () => {
    signedInAs(SUPER_ADMIN);
    useSessionStore.setState({ platformRole: 'super-admin', userName: 'Platform Operator' });
    useBillingStore.getState().ensureSeeded();
    const spy = happyPath(SUPER_ADMIN);

    render(<SuperAdminConsolePage />);

    const tab = screen.getAllByRole('tab').find((t) => (t.textContent ?? '').includes('My account'));
    expect(tab).toBeTruthy();
    fireEvent.click(tab!);

    fill({ current: CURRENT, next: NEXT, confirm: NEXT });
    fireEvent.click(submitButton());

    expect(await screen.findByTestId('change-password-success')).toBeTruthy();

    // The SAME endpoint and the SAME payload as every other persona — being a
    // platform operator confers no separate password mechanism.
    expect(changeRequestBody(spy)).toEqual({ currentPassword: CURRENT, newPassword: NEXT });

    // Still in the console: the operator was not bounced into the subscriber
    // application, which is the surface they have no subscription for.
    expect(screen.getByText(/acting as the Ledgora platform super-administrator/i)).toBeTruthy();
  });
});

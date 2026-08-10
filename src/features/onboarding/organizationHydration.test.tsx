// @vitest-environment happy-dom
/**
 * The false "Create your organization first." blocker.
 *
 * Reproduction being pinned: a user registers, creates an organization, and is
 * shown a red alert on /onboarding/subscription telling them to create the
 * organization they just created. Two state sources disagreed — a positional
 * progress indicator that always drew earlier steps as complete, and a local
 * store object that the backend mirror had silently failed to populate.
 *
 * The rule these tests enforce: NOT KNOWING IS NOT THE SAME AS KNOWING THERE IS
 * NONE. Only a backend that positively answers "no organization" may block
 * anybody. A pending request shows a spinner; a failed one offers a retry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { OnboardingSubscriptionPage } from '@/pages/onboarding/OnboardingSubscriptionPage';
import { OnboardingOrganizationPage } from '@/pages/onboarding/OnboardingOrganizationPage';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useRouterStore } from '@/store/routerStore';
import { useMeteringConfigStore } from '@/store/meteringConfigStore';
import { requireCurrentOrganizationId } from '@/lib/currentOrganization';
import { clearLocalSession } from '@/services/sessionMirror';
import { ROUTES } from '@/lib/accessControl';

const API = 'https://api.example.test';

/** What `GET /api/organizations/current` returns for a real tenant. */
const backendOrganization = (over: Record<string, unknown> = {}) => ({
  id: 'org-backend-1',
  legalName: 'Acme Holdings Ltd.',
  tradingName: 'Acme',
  country: 'AE',
  registrationNumber: 'CR-000001',
  taxNumber: 'TRN-1',
  industry: 'general',
  baseCurrency: 'USD',
  fiscalYearStart: '01-01',
  booksStartDate: '2026-01-01',
  status: 'active',
  createdAt: '2026-07-20T00:00:00.000Z',
  ownerUserId: 'user-1',
  role: 'owner',
  ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Route-based fetch stub; records every request for ordering assertions. */
function mockRoutes(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${url.replace(API, '')}`);
    const hit = Object.keys(routes).find((path) => url.includes(path));
    if (!hit) return json({ error: { code: 'not_found', message: 'no route' } }, 404);
    return routes[hit]!(init);
  });
  return calls;
}

/** A deferred response, so "still loading" is an observable state. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function signedIn(): void {
  useAuthStore.setState({
    users: [
      {
        id: 'user-1',
        fullName: 'Jane Owner',
        email: 'jane@acme.test',
        mobile: '',
        country: 'AE',
        passwordHash: '',
        emailVerified: false, // self-registered: verify-email is still a 501 seam
        role: 'owner',
        createdAt: '2026-07-20T00:00:00.000Z',
      },
    ],
    currentUserId: 'user-1',
  });
}

const renderSubscriptionPage = () => render(<OnboardingSubscriptionPage />);
const renderOrganizationPage = () => render(<OnboardingOrganizationPage />);

/** Fill the organization form with valid values. */
function fillOrganizationForm(): void {
  fireEvent.change(screen.getByPlaceholderText('Acme Holdings Ltd.'), {
    target: { value: 'Acme Holdings Ltd.' },
  });
  const selects = screen.getAllByRole('combobox');
  fireEvent.change(selects[0]!, { target: { value: 'AE' } });
}

beforeEach(() => {
  // No `vi.resetModules()`: the pages are imported statically so they share the
  // exact store instance these assertions read. `isApiConfigured()` is
  // evaluated per call, so the env stub below still takes effect.
  localStorage.clear();
  sessionStorage.clear();
  vi.stubEnv('VITE_API_URL', API);
  useOrganizationStore.getState().resetToDefault();
  useMeteringConfigStore.getState().resetToDefault();
  useAuthStore.setState({ users: [], currentUserId: null });
  useRouterStore.getState().navigate(ROUTES.onboardingSubscription, { replace: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  useOrganizationStore.getState().resetToDefault();
});

/* ── The reported bug ─────────────────────────────────────────────────────── */

describe('the subscription page on mount', () => {
  it('shows no false warning when the backend has an organization', async () => {
    signedIn();
    mockRoutes({ '/api/organizations/current': () => json({ organization: backendOrganization() }) });

    await renderSubscriptionPage();

    await waitFor(() => expect(screen.queryByTestId('organization-loading')).toBeNull());
    expect(screen.queryByTestId('organization-absent')).toBeNull();
    expect(screen.queryByText(/Create your organization first/)).toBeNull();
    expect(screen.getByRole('button', { name: /Confirm & continue to payment/ })).not.toHaveProperty('disabled', true);
  });

  it('hydrates the organization from the backend, keeping the SERVER id', async () => {
    signedIn();
    mockRoutes({ '/api/organizations/current': () => json({ organization: backendOrganization() }) });

    await renderSubscriptionPage();

    await waitFor(() => expect(useOrganizationStore.getState().organization?.id).toBe('org-backend-1'));
    expect(useOrganizationStore.getState().hydration).toMatchObject({
      status: 'ready',
      confirmedOrganizationId: 'org-backend-1',
    });
  });

  it('hydrates an account whose email is unverified — the case that used to fail', async () => {
    // The local mutator this used to go through refuses when `emailVerified` is
    // false, and its refusal was discarded, leaving the store empty while the
    // backend held a perfectly good organization. That is the reported bug.
    signedIn();
    expect(useAuthStore.getState().users[0]!.emailVerified).toBe(false);
    mockRoutes({ '/api/organizations/current': () => json({ organization: backendOrganization() }) });

    await renderSubscriptionPage();

    await waitFor(() => expect(screen.queryByTestId('organization-loading')).toBeNull());
    expect(useOrganizationStore.getState().organization?.id).toBe('org-backend-1');
    expect(screen.queryByTestId('organization-absent')).toBeNull();
  });

  it('shows a loading state — not the warning — while hydration is in flight', async () => {
    signedIn();
    const gate = deferred<Response>();
    mockRoutes({ '/api/organizations/current': () => gate.promise });

    await renderSubscriptionPage();

    expect(await screen.findByTestId('organization-loading')).toBeTruthy();
    expect(screen.queryByTestId('organization-absent')).toBeNull();
    expect(screen.queryByText(/Create your organization first/)).toBeNull();

    gate.resolve(json({ organization: backendOrganization() }));
    await waitFor(() => expect(screen.queryByTestId('organization-loading')).toBeNull());
    expect(screen.queryByTestId('organization-absent')).toBeNull();
  });

  it('blocks only when the backend confirms there is genuinely no organization', async () => {
    signedIn();
    mockRoutes({ '/api/organizations/current': () => json({ organization: null }) });

    await renderSubscriptionPage();

    expect(await screen.findByTestId('organization-absent')).toBeTruthy();
    expect(screen.getByText(/Create your organization first/)).toBeTruthy();
    // And offers the way out.
    fireEvent.click(screen.getByRole('button', { name: /Back to organization setup/ }));
    expect(useRouterStore.getState().path).toBe(ROUTES.onboardingOrganization);
  });

  it('reports a failed lookup as a failure, never as a missing organization', async () => {
    signedIn();
    mockRoutes({
      '/api/organizations/current': () => json({ error: { code: 'internal_error', message: 'Upstream is down.' } }, 500),
    });

    await renderSubscriptionPage();

    expect(await screen.findByTestId('organization-error')).toBeTruthy();
    expect(screen.queryByTestId('organization-absent')).toBeNull();
    expect(screen.queryByText(/Create your organization first/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('recovers on retry after a failed lookup', async () => {
    signedIn();
    let attempt = 0;
    mockRoutes({
      '/api/organizations/current': () => {
        attempt += 1;
        return attempt === 1
          ? json({ error: { code: 'internal_error', message: 'Upstream is down.' } }, 500)
          : json({ organization: backendOrganization() });
      },
    });

    await renderSubscriptionPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.queryByTestId('organization-error')).toBeNull());
    expect(useOrganizationStore.getState().organization?.id).toBe('org-backend-1');
  });

  it('issues one request when several consumers hydrate at once', async () => {
    signedIn();
    const calls = mockRoutes({ '/api/organizations/current': () => json({ organization: backendOrganization() }) });

    await renderSubscriptionPage();
    await waitFor(() => expect(useOrganizationStore.getState().hydration.status).toBe('ready'));

    expect(calls.filter((c) => c.includes('/api/organizations/current'))).toHaveLength(1);
  });
});

/* ── Creation stores before it navigates ──────────────────────────────────── */

describe('creating the organization', () => {
  it('stores the backend organization BEFORE navigating to the subscription step', async () => {
    signedIn();
    let organizationAtNavigation: string | null | undefined;
    const unsubscribe = useRouterStore.subscribe((state) => {
      if (state.path === ROUTES.onboardingSubscription) {
        organizationAtNavigation = useOrganizationStore.getState().hydration.confirmedOrganizationId;
      }
    });
    useRouterStore.getState().navigate(ROUTES.onboardingOrganization, { replace: true });

    mockRoutes({
      '/api/organizations': () => json({ organizationId: 'org-backend-1', organization: backendOrganization() }, 201),
    });

    await renderOrganizationPage();
    fillOrganizationForm();
    fireEvent.click(screen.getByRole('button', { name: /Continue to subscription/ }));

    await waitFor(() => expect(useRouterStore.getState().path).toBe(ROUTES.onboardingSubscription));
    unsubscribe();
    // The store already held the confirmed organization at the moment of the
    // navigation — not a tick later.
    expect(organizationAtNavigation).toBe('org-backend-1');
  });

  it('does not navigate when creation fails', async () => {
    signedIn();
    useRouterStore.getState().navigate(ROUTES.onboardingOrganization, { replace: true });
    mockRoutes({
      '/api/organizations': () => json({ error: { code: 'validation_error', message: 'Country is required.' } }, 400),
    });

    await renderOrganizationPage();
    fillOrganizationForm();
    fireEvent.click(screen.getByRole('button', { name: /Continue to subscription/ }));

    expect(await screen.findByText('Country is required.')).toBeTruthy();
    expect(useRouterStore.getState().path).toBe(ROUTES.onboardingOrganization);
  });

  it('adopts the existing organization on 409 instead of creating a duplicate', async () => {
    signedIn();
    useRouterStore.getState().navigate(ROUTES.onboardingOrganization, { replace: true });
    const calls = mockRoutes({
      '/api/organizations/current': () => json({ organization: backendOrganization() }),
      '/api/organizations': () =>
        json({ error: { code: 'conflict', message: 'You already belong to an organization.' } }, 409),
    });

    await renderOrganizationPage();
    fillOrganizationForm();
    fireEvent.click(screen.getByRole('button', { name: /Continue to subscription/ }));

    await waitFor(() => expect(useRouterStore.getState().path).toBe(ROUTES.onboardingSubscription));
    expect(useOrganizationStore.getState().organization?.id).toBe('org-backend-1');
    // Exactly one creation attempt — the conflict was resolved by adopting.
    expect(calls.filter((c) => c === 'POST /api/organizations')).toHaveLength(1);
  });
});

/* ── Confirmation uses the backend id ─────────────────────────────────────── */

describe('confirm & continue to payment', () => {
  const plans = [{ id: 'plan-uuid-core', code: 'core', name: 'Core', currency: 'USD', monthlyPrice: 49, modules: [] }];

  it('selects the plan against the backend-confirmed organization, then navigates', async () => {
    signedIn();
    const calls = mockRoutes({
      '/api/organizations/current': () => json({ organization: backendOrganization() }),
      '/api/plans/public': () => json({ plans }),
      '/api/subscriptions': () => json({ subscriptionId: 'sub-1', status: 'draft' }, 201),
    });

    await renderSubscriptionPage();
    await waitFor(() => expect(screen.queryByTestId('organization-loading')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /Confirm & continue to payment/ }));

    // Confirmation lands in the application in Free Preview; the invoice and
    // bank details stay one click away from the preview banner.
    await waitFor(() => expect(useRouterStore.getState().path).toBe(ROUTES.appDashboard));
    expect(calls).toContain('POST /api/subscriptions');
    // The local draft carries the backend organization id, not a minted one.
    expect(useOrganizationStore.getState().subscription?.organizationId).toBe('org-backend-1');
  });

  it('does not navigate when the server rejects the selection', async () => {
    signedIn();
    mockRoutes({
      '/api/organizations/current': () => json({ organization: backendOrganization() }),
      '/api/plans/public': () => json({ plans }),
      '/api/subscriptions': () =>
        json({ error: { code: 'conflict', message: 'This organization already has an active subscription.' } }, 409),
    });

    await renderSubscriptionPage();
    await waitFor(() => expect(screen.queryByTestId('organization-loading')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /Confirm & continue to payment/ }));

    expect(await screen.findByText(/already has an active subscription/)).toBeTruthy();
    expect(useRouterStore.getState().path).toBe(ROUTES.onboardingSubscription);
  });

  it('re-fetches once before rejecting when the store is unexpectedly empty', async () => {
    signedIn();
    // First lookup (mount) finds nothing; the organization is created elsewhere
    // — another tab — and the second lookup finds it.
    let attempt = 0;
    mockRoutes({
      '/api/organizations/current': () => {
        attempt += 1;
        return json({ organization: attempt === 1 ? null : backendOrganization() });
      },
      '/api/plans/public': () => json({ plans }),
      '/api/subscriptions': () => json({ subscriptionId: 'sub-1', status: 'draft' }, 201),
    });

    await renderSubscriptionPage();
    expect(await screen.findByTestId('organization-absent')).toBeTruthy();

    // The button is disabled in this state, so drive the same recovery the
    // handler performs: one forced re-read before anyone is turned away.
    await expect(requireCurrentOrganizationId()).resolves.toBe('org-backend-1');
    await waitFor(() => expect(screen.queryByTestId('organization-absent')).toBeNull());
  });
});

/* ── Refresh, sign-out, new tab ───────────────────────────────────────────── */

describe('session and refresh behaviour', () => {
  it('rehydrates on a cold mount with nothing in the store (refresh / new tab)', async () => {
    signedIn();
    expect(useOrganizationStore.getState().organization).toBeNull();
    mockRoutes({ '/api/organizations/current': () => json({ organization: backendOrganization() }) });

    await renderSubscriptionPage();

    await waitFor(() => expect(useOrganizationStore.getState().organization?.id).toBe('org-backend-1'));
    expect(screen.queryByTestId('organization-absent')).toBeNull();
  });

  it('re-confirms rather than trusting a persisted organization from a previous session', async () => {
    signedIn();
    // A stale organization left in persisted storage by whoever used this
    // browser last. The backend is the authority and says it is gone.
    useOrganizationStore.setState({ organization: { id: 'org-stale', legalName: 'Stale Ltd' } as never });
    mockRoutes({ '/api/organizations/current': () => json({ organization: null }) });

    await renderSubscriptionPage();

    expect(await screen.findByTestId('organization-absent')).toBeTruthy();
    expect(useOrganizationStore.getState().organization).toBeNull();
  });

  it('drops the confirmation when the session ends, so the next user cannot inherit it', async () => {
    signedIn();
    mockRoutes({ '/api/organizations/current': () => json({ organization: backendOrganization() }) });
    await renderSubscriptionPage();
    await waitFor(() => expect(useOrganizationStore.getState().hydration.status).toBe('ready'));

    clearLocalSession();

    expect(useOrganizationStore.getState().hydration).toMatchObject({
      status: 'idle',
      confirmedOrganizationId: null,
    });
  });
});

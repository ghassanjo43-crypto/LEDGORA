// @vitest-environment happy-dom
/**
 * ApplicantsPanel — the operator's view of registered customers.
 *
 * The defect this guards against: a customer who signed up but chose no package
 * was absent from the console entirely. These tests assert that such a person is
 * rendered, honestly labelled ("Not selected", "No organization yet"), and that
 * the panel never invents subscription detail it was not given.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

const API = 'https://api.example.test';

/** A registered prospect: no organization, no plan, no subscription. */
const prospect = (over: Record<string, unknown> = {}) => ({
  userId: 'u-prospect',
  applicationId: 'app-1',
  fullName: 'Priya Prospect',
  email: 'priya@new.test',
  accountStatus: 'active',
  emailVerified: true,
  registeredAt: '2026-07-20T09:00:00.000Z',
  lastLoginAt: null,
  lastActivityAt: new Date().toISOString(),
  stage: 'registered_no_package',
  funnelStage: 'registered_no_package',
  dormant: false,
  source: 'self_registration',
  organizationId: null,
  organizationName: null,
  organizationCountry: null,
  planId: null,
  planCode: null,
  planName: null,
  planCurrency: null,
  planMonthlyPrice: null,
  subscriptionId: null,
  subscriptionStatus: null,
  billingCycle: null,
  subscriptionExpiresAt: null,
  invoiceId: null,
  invoiceNumber: null,
  invoiceStatus: null,
  invoiceTotal: null,
  paymentReference: null,
  proofId: null,
  proofStatus: null,
  packageSelectedAt: null,
  paymentStartedAt: null,
  proofUploadedAt: null,
  activatedAt: null,
  ...over,
});

const subscriber = () =>
  prospect({
    userId: 'u-sub',
    fullName: 'Sam Subscriber',
    email: 'sam@paid.test',
    stage: 'active_subscriber',
    funnelStage: 'active_subscriber',
    organizationId: 'org-1',
    organizationName: 'Paid Holdings Ltd',
    planId: 'plan-1',
    planCode: 'core',
    planName: 'Core',
    planCurrency: 'USD',
    planMonthlyPrice: 49,
    subscriptionId: 'sub-1',
    subscriptionStatus: 'active',
    billingCycle: 'monthly',
    activatedAt: '2026-07-22T10:00:00.000Z',
  });

const listBody = (applicants: unknown[], over: Record<string, unknown> = {}) => ({
  applicants,
  pagination: { limit: 25, offset: 0, count: applicants.length, total: applicants.length },
  stageCounts: {
    all: applicants.length,
    registered_no_package: 0,
    package_selected: 0,
    awaiting_payment: 0,
    pending_verification: 0,
    active_subscriber: 0,
    dormant_applicant: 0,
    ...((over.stageCounts as Record<string, number>) ?? {}),
  },
  dormantDays: 30,
  ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Records every applicant request so query-string assertions are possible. */
function mockList(bodyFor: (url: string) => unknown): { urls: string[] } {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes('/api/admin/applicants')) {
      if ((init?.method ?? 'GET') === 'GET') urls.push(url);
      return json(bodyFor(url));
    }
    return json({ error: { code: 'not_found', message: 'No route.' } }, 404);
  });
  return { urls };
}

async function renderPanel() {
  const { ApplicantsPanel } = await import('./ApplicantsPanel');
  return render(<ApplicantsPanel />);
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_API_URL', API);
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('a customer who registered but chose no package', () => {
  it('is rendered in the roster', async () => {
    mockList(() => listBody([prospect()], { stageCounts: { registered_no_package: 1 } }));
    await renderPanel();

    expect(await screen.findByText('Priya Prospect')).toBeTruthy();
    expect(screen.getByText('priya@new.test')).toBeTruthy();
  });

  it('shows "Not selected" for the package rather than a blank or a guess', async () => {
    mockList(() => listBody([prospect()]));
    await renderPanel();

    const row = await screen.findByTestId('applicant-row');
    expect(within(row).getByText('Not selected')).toBeTruthy();
    expect(within(row).getByText('No organization yet')).toBeTruthy();
    expect(within(row).getByText('Registered — no package')).toBeTruthy();
  });

  it('offers a package-selection reminder, and nothing that cannot work yet', async () => {
    mockList(() => listBody([prospect()]));
    await renderPanel();

    const row = await screen.findByTestId('applicant-row');
    expect(within(row).getByRole('button', { name: /Send package reminder to Priya Prospect/ })).toBeTruthy();
    // No subscription exists, so activation is not offered.
    expect(within(row).queryByRole('button', { name: /Activate subscription/ })).toBeNull();
  });

  it('opens a detail drawer for that applicant only', async () => {
    mockList(() => listBody([prospect(), subscriber()]));
    await renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Open Priya Prospect' }));

    const detail = await screen.findByTestId('applicant-detail');
    expect(detail.getAttribute('data-applicant-id')).toBe('u-prospect');
    expect(within(detail).getByText('No organization yet')).toBeTruthy();
    expect(within(detail).getByText('No subscription')).toBeTruthy();
    expect(within(detail).queryByText('Paid Holdings Ltd')).toBeNull();
  });
});

describe('roster query controls', () => {
  it('requests the selected stage when a tab is chosen', async () => {
    const { urls } = mockList(() => listBody([]));
    await renderPanel();
    await waitFor(() => expect(urls.length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('tab', { name: /Package not selected/ }));
    await waitFor(() => expect(urls.some((u) => u.includes('stage=registered_no_package'))).toBe(true));
  });

  it('shows the per-stage counts on the tabs', async () => {
    mockList(() =>
      listBody([prospect(), subscriber()], {
        stageCounts: { all: 2, registered_no_package: 1, active_subscriber: 1 },
      }),
    );
    await renderPanel();

    const allTab = await screen.findByRole('tab', { name: /All applicants/ });
    expect(allTab.textContent).toContain('2');
    expect(screen.getByRole('tab', { name: /Package not selected/ }).textContent).toContain('1');
  });

  it('sends the search term to the server', async () => {
    const { urls } = mockList(() => listBody([]));
    await renderPanel();
    await waitFor(() => expect(urls.length).toBeGreaterThan(0));

    fireEvent.change(screen.getByLabelText('Search applicants'), { target: { value: 'priya' } });
    await waitFor(() => expect(urls.some((u) => u.includes('search=priya'))).toBe(true), { timeout: 2000 });
  });

  it('sends the sort field and direction', async () => {
    const { urls } = mockList(() => listBody([]));
    await renderPanel();
    await waitFor(() => expect(urls.length).toBeGreaterThan(0));

    fireEvent.change(screen.getByLabelText('Sort applicants by'), { target: { value: 'full_name' } });
    await waitFor(() => expect(urls.some((u) => u.includes('sort=full_name'))).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: /Sort ascending/ }));
    await waitFor(() => expect(urls.some((u) => u.includes('direction=asc'))).toBe(true));
  });

  it('pages through a result set larger than one page', async () => {
    const { urls } = mockList((url) => {
      const offset = Number(new URL(url).searchParams.get('offset') ?? '0');
      return listBody([prospect({ userId: `u-${offset}` })], {
        pagination: { limit: 25, offset, count: 1, total: 60 },
      });
    });
    await renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() => expect(urls.some((u) => u.includes('offset=25'))).toBe(true));
  });
});

describe('active subscribers', () => {
  it('are shown with their organization, package and stage intact', async () => {
    mockList(() => listBody([subscriber()]));
    await renderPanel();

    const row = await screen.findByTestId('applicant-row');
    expect(within(row).getByText('Paid Holdings Ltd')).toBeTruthy();
    expect(within(row).getByText('Core')).toBeTruthy();
    expect(within(row).getByText('Active subscriber')).toBeTruthy();
    // Already active — activation is not offered again.
    expect(within(row).queryByRole('button', { name: /Activate subscription/ })).toBeNull();
  });
});

describe('failure handling', () => {
  it('reports a rejected request instead of silently showing an empty roster', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ error: { code: 'forbidden', message: 'You do not have permission to perform this action.' } }, 403),
    );
    await renderPanel();

    expect(await screen.findByText(/do not have permission/)).toBeTruthy();
  });

  it('says so plainly when no backend is configured', async () => {
    vi.stubEnv('VITE_API_URL', '');
    vi.resetModules();
    await renderPanel();

    expect(await screen.findByText(/Backend not configured/)).toBeTruthy();
  });
});

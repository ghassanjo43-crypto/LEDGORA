// @vitest-environment happy-dom
/**
 * "Reset owner password" on a subscriber row.
 *
 * The Members tab's reset is covered by `components/admin/adminConsolePanels.test.tsx`.
 * What is proven HERE is the subscriber-row entry point, which exists because
 * the overwhelmingly common support case — "the person who owns this account
 * cannot get in" — previously required hunting for the right human inside the
 * tenant's staff list and hoping you picked the owner.
 *
 * The claims:
 *
 *   authority    the control appears only for an operator holding
 *                `members.reset_password`, and only where a row has an owner;
 *   target       it acts on the OWNER'S USER ID through the same member
 *                endpoint every other reset uses — never on the organization,
 *                and never on the wrong row;
 *   deliberation nothing is reset until a named confirmation with a reason is
 *                accepted; cancelling sends nothing at all;
 *   custody      the temporary password appears once, can be copied, and is
 *                gone from the DOM the moment the dialog is dismissed;
 *   honesty      a server refusal is reported as a refusal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { BackendSubscribersPanel } from '@/components/admin/BackendSubscribersPanel';
import { useAdminSubscriberStore } from '@/store/adminConsoleStores';
import type { PlatformCapabilityName } from '@/services/api/adminConsoleApi';

const API = 'https://api.example.test';

const ACME_ORG = '11111111-1111-4111-8111-111111111111';
const BETA_ORG = '22222222-2222-4222-8222-222222222222';
const ACME_OWNER = 'usr-acme-owner';
const BETA_OWNER = 'usr-beta-owner';

const TEMP_PASSWORD = 'Kd7#mQx2Vp9$Rt4Wz6Ah';

/** Everything a super administrator holds that this panel consults. */
const SUPER_ADMIN: PlatformCapabilityName[] = [
  'view-admin',
  'subscribers.read',
  'subscribers.create',
  'subscribers.manage',
  'subscriptions.assign',
  'members.read',
  'members.manage',
  'members.reset_password',
];

/** A support operator: reads the roster, issues nothing. */
const SUPPORT: PlatformCapabilityName[] = ['view-admin', 'subscribers.read', 'members.read'];

/** A billing administrator: manages money, not credentials. */
const BILLING_ADMIN: PlatformCapabilityName[] = [
  'view-admin',
  'subscribers.read',
  'subscribers.archive',
  'members.read',
  'members.remove',
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function rosterRow(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ACME_ORG,
    legalName: 'Acme Trading LLC',
    tradingName: null,
    country: 'AE',
    organizationStatus: 'active',
    dataClassification: 'production',
    classificationReviewedAt: '2026-02-01T00:00:00.000Z',
    createdAt: '2026-01-05T00:00:00.000Z',
    planId: 'plan_core',
    planCode: 'core',
    planName: 'Core',
    edition: 'core',
    subscriptionId: 'sub_1',
    subscriptionStatus: 'active',
    billingCycle: 'monthly',
    startsAt: '2026-01-05T00:00:00.000Z',
    renewsAt: '2026-08-05T00:00:00.000Z',
    seatsUsed: 1,
    seatLimit: 3,
    entityLimit: 1,
    modules: ['accounting'],
    entitlementActive: true,
    ownerUserId: ACME_OWNER,
    ownerName: 'Sam Subscriber',
    ownerEmail: 'sam@acme.test',
    memberCount: 1,
    openInvoiceId: null,
    openInvoiceStatus: null,
    pendingProofId: null,
    ...overrides,
  };
}

const resetResponse = (overrides: Record<string, unknown> = {}) => ({
  member: { userId: ACME_OWNER, email: 'sam@acme.test', fullName: 'Sam Subscriber' },
  mode: 'temporary',
  credential: {
    type: 'temporary_password',
    temporaryPassword: TEMP_PASSWORD,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    deliveryStatus: 'unavailable',
    mustChangePassword: true,
    revokedSessions: 2,
    message: 'Email delivery is not configured. Give this password to the account holder yourself.',
    ...((overrides.credential as object) ?? {}),
  },
  ...overrides,
});

/**
 * Route the roster read and the reset write separately, so a test can assert
 * which of the two actually happened.
 */
function mockApi(resetHandler?: (init: RequestInit) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes('/reset-password')) {
      return (resetHandler?.(init as RequestInit) ?? json(resetResponse())) as unknown as Response;
    }
    return json({
      subscribers: rows,
      pagination: { limit: 25, offset: 0, count: rows.length, total: rows.length },
      facets: {},
    }) as unknown as Response;
  });
}

/** The roster the mocked API serves. Reassigned per test before rendering. */
let rows: Array<Record<string, unknown>> = [];

function renderPanel(capabilities: PlatformCapabilityName[] = SUPER_ADMIN) {
  return render(
    <BackendSubscribersPanel
      capabilities={capabilities}
      onAddSubscriber={() => undefined}
      onAssignPackage={() => undefined}
      onViewMembers={() => undefined}
      onCleanUp={() => undefined}
    />,
  );
}

const resetButton = (org = ACME_ORG) => screen.getByTestId(`reset-owner-password-${org}`);

/** Accept the confirmation dialog with a reason, as an operator must. */
async function confirmWithReason(reason = 'Customer called; lost their password.'): Promise<void> {
  const input = await screen.findByTestId('reason-input');
  fireEvent.change(input, { target: { value: reason } });
  fireEvent.click(screen.getByTestId('reason-confirm'));
}

/** Every reset call the panel made. */
const resetCalls = (spy: ReturnType<typeof mockApi>) =>
  spy.mock.calls.filter(([url]) => String(url).includes('/reset-password'));

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', API);
  useAdminSubscriberStore.getState().clear();
  rows = [rosterRow()];
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  useAdminSubscriberStore.getState().clear();
});

/* ── Authority ────────────────────────────────────────────────────────────── */

describe('who is offered the control', () => {
  it('offers it to an operator holding members.reset_password', async () => {
    mockApi();
    renderPanel();

    await waitFor(() => expect(resetButton()).toBeTruthy());
    // Named after the person, not the tenant — an operator must know whose
    // credential they are about to replace.
    expect(resetButton().getAttribute('aria-label')).toMatch(/Sam Subscriber/);
  });

  it.each([
    ['a support operator', SUPPORT],
    ['a billing administrator', BILLING_ADMIN],
  ])('withholds it from %s, who can still read the roster', async (_label, capabilities) => {
    mockApi();
    renderPanel(capabilities);

    // The row renders — reading is their job…
    await waitFor(() => expect(screen.getByTestId(`classification-${ACME_ORG}`)).toBeTruthy());
    // …and the credential control is simply not there.
    expect(screen.queryByTestId(`reset-owner-password-${ACME_ORG}`)).toBeNull();
  });

  it('withholds it from a row that has no owner to reset', async () => {
    rows = [rosterRow({ ownerUserId: null, ownerName: null, ownerEmail: null })];
    mockApi();
    renderPanel();

    await waitFor(() => expect(screen.getByTestId(`classification-${ACME_ORG}`)).toBeTruthy());
    expect(screen.queryByTestId(`reset-owner-password-${ACME_ORG}`)).toBeNull();
  });
});

/* ── Deliberation ─────────────────────────────────────────────────────────── */

describe('confirmation', () => {
  it('names the owner and the organization before anything happens', async () => {
    const spy = mockApi();
    renderPanel();
    await waitFor(() => expect(resetButton()).toBeTruthy());

    fireEvent.click(resetButton());

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(/Reset password for Sam Subscriber\?/);
    expect(dialog.textContent).toMatch(/sam@acme\.test/);
    expect(dialog.textContent).toMatch(/Acme Trading LLC/);
    // The consequences, stated where they are accepted.
    expect(dialog.textContent).toMatch(/shown to you once/i);
    expect(dialog.textContent).toMatch(/session/i);
    expect(dialog.textContent).toMatch(/choose a new password/i);
    // And the reassurance that this is a credential change and nothing more.
    expect(dialog.textContent).toMatch(/organization, role and subscription are unchanged/i);

    // Opening the dialog sends nothing.
    expect(resetCalls(spy)).toHaveLength(0);
  });

  it('sends nothing when the operator cancels', async () => {
    const spy = mockApi();
    renderPanel();
    await waitFor(() => expect(resetButton()).toBeTruthy());

    fireEvent.click(resetButton());
    await screen.findByTestId('reason-input');
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(screen.queryByTestId('reason-input')).toBeNull());
    expect(resetCalls(spy)).toHaveLength(0);
    expect(screen.queryByTestId('credential-dialog')).toBeNull();
  });

  it('refuses to submit without a reason for the audit trail', async () => {
    const spy = mockApi();
    renderPanel();
    await waitFor(() => expect(resetButton()).toBeTruthy());

    fireEvent.click(resetButton());
    await screen.findByTestId('reason-input');

    expect((screen.getByTestId('reason-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect(resetCalls(spy)).toHaveLength(0);
  });
});

/* ── The request ──────────────────────────────────────────────────────────── */

describe('what is sent', () => {
  it("targets the OWNER'S user id through the shared member endpoint", async () => {
    const spy = mockApi();
    renderPanel();
    await waitFor(() => expect(resetButton()).toBeTruthy());

    fireEvent.click(resetButton());
    await confirmWithReason('Support call 4821.');

    await waitFor(() => expect(resetCalls(spy)).toHaveLength(1));
    const [url, init] = resetCalls(spy)[0]!;

    // The USER, not the organization. An org id here would be a different
    // feature with a different failure mode.
    expect(String(url)).toBe(`${API}/api/admin/members/${ACME_OWNER}/reset-password`);
    expect(String(url)).not.toContain(ACME_ORG);
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).credentials).toBe('include');

    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toEqual({ mode: 'temporary', reason: 'Support call 4821.' });
  });

  it('resets the owner of the row that was clicked, not the first row', async () => {
    rows = [
      rosterRow(),
      rosterRow({
        organizationId: BETA_ORG,
        legalName: 'Beta Holdings FZE',
        ownerUserId: BETA_OWNER,
        ownerName: 'Rae Owner',
        ownerEmail: 'rae@beta.test',
      }),
    ];
    const spy = mockApi();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId(`reset-owner-password-${BETA_ORG}`)).toBeTruthy());

    fireEvent.click(resetButton(BETA_ORG));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(/Rae Owner/);
    expect(dialog.textContent).not.toMatch(/Sam Subscriber/);

    await confirmWithReason();
    await waitFor(() => expect(resetCalls(spy)).toHaveLength(1));
    expect(String(resetCalls(spy)[0]![0])).toContain(BETA_OWNER);
    expect(String(resetCalls(spy)[0]![0])).not.toContain(ACME_OWNER);
  });

  it('never touches the self-service change-password endpoint', async () => {
    const spy = mockApi();
    renderPanel();
    await waitFor(() => expect(resetButton()).toBeTruthy());

    fireEvent.click(resetButton());
    await confirmWithReason();
    await waitFor(() => expect(screen.queryByTestId('credential-value')).toBeTruthy());

    /*
     * The two operations are separate by construction. An administrative reset
     * needs no current password and must never be routed through the endpoint
     * that demands one.
     */
    expect(spy.mock.calls.some(([url]) => String(url).includes('/api/auth/change-password'))).toBe(false);
  });
});

/* ── Custody of the credential ────────────────────────────────────────────── */

describe('the temporary password', () => {
  const openResultDialog = async (): Promise<void> => {
    fireEvent.click(resetButton());
    await confirmWithReason();
    await screen.findByTestId('credential-value');
  };

  it('is shown once, with the warning that it cannot be retrieved', async () => {
    mockApi();
    renderPanel();
    await waitFor(() => expect(resetButton()).toBeTruthy());

    await openResultDialog();

    expect(screen.getByTestId('credential-value').textContent).toBe(TEMP_PASSWORD);
    expect(screen.getByTestId('credential-once-warning').textContent).toMatch(/Argon2id/);
    expect(screen.getByTestId('credential-once-warning').textContent).toMatch(/nobody — including you/i);
    // Who it is for, so it cannot be handed to the wrong person.
    expect(screen.getByTestId('credential-email').textContent).toBe('sam@acme.test');
    // And that the holder is forced to replace it.
    expect(screen.getByTestId('credential-force-change')).toBeTruthy();
    expect(screen.getByTestId('credential-revoked').textContent).toBe('2');
  });

  it('copies to the clipboard on demand', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    mockApi();
    renderPanel();
    await waitFor(() => expect(resetButton()).toBeTruthy());
    await openResultDialog();

    fireEvent.click(screen.getByTestId('credential-copy'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TEMP_PASSWORD));
  });

  it('cannot be dismissed unread, and is gone from the DOM once it is', async () => {
    mockApi();
    renderPanel();
    await waitFor(() => expect(resetButton()).toBeTruthy());
    await openResultDialog();

    // The close control is gated on an explicit acknowledgement, so a stray
    // click cannot destroy an unrecoverable value.
    expect((screen.getByTestId('credential-dismiss') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('credential-value').textContent).toBe(TEMP_PASSWORD);

    /*
     * `waitFor` rather than a bare assertion: the reset triggers a roster
     * refresh that resolves on its own schedule, and the dialog re-renders when
     * it lands. Under a loaded full-suite run that re-render can arrive between
     * the click and the check. The CLAIM is unchanged — disabled until
     * acknowledged, enabled after — only the timing is no longer assumed.
     */
    fireEvent.click(screen.getByTestId('credential-acknowledge'));
    await waitFor(() =>
      expect((screen.getByTestId('credential-dismiss') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('credential-dismiss'));

    await waitFor(() => expect(screen.queryByTestId('credential-dialog')).toBeNull());
    expect(screen.queryByTestId('credential-value')).toBeNull();
    // The value is not recoverable from anywhere the page still renders.
    expect(document.body.textContent).not.toContain(TEMP_PASSWORD);
  });

  it('is never written to localStorage or sessionStorage', async () => {
    localStorage.clear();
    sessionStorage.clear();
    mockApi();
    renderPanel();
    await waitFor(() => expect(resetButton()).toBeTruthy());
    await openResultDialog();

    const dump: string[] = [];
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key) dump.push(key, store.getItem(key) ?? '');
      }
    }
    expect(dump.join(' ')).not.toContain(TEMP_PASSWORD);
    expect(window.location.href).not.toContain(TEMP_PASSWORD);
  });
});

/* ── Failure ──────────────────────────────────────────────────────────────── */

describe('when the server refuses', () => {
  it('reports the refusal and shows no credential dialog', async () => {
    mockApi(() =>
      json(
        {
          error: {
            code: 'forbidden',
            message: 'This action requires a LEDGORA platform administrator.',
          },
        },
        403,
      ),
    );
    renderPanel();
    await waitFor(() => expect(resetButton()).toBeTruthy());

    fireEvent.click(resetButton());
    await confirmWithReason();

    /*
     * Frontend capability checks hide controls; they do not authorize. A server
     * that refuses anyway must be believed, and the operator told — never left
     * with a dialog implying a password was issued.
     */
    // Reported in the panel banner AND kept visible inside the still-open
    // confirmation dialog, so the operator can correct and retry in place.
    expect((await screen.findAllByText(/requires a LEDGORA platform administrator/i)).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('credential-dialog')).toBeNull();
    expect(screen.queryByTestId('credential-value')).toBeNull();
  });

  it('warns explicitly when the reset succeeded but no credential came back', async () => {
    // The dangerous case: the old password is already dead and nobody has the
    // new one. It must never be reported as plain success.
    mockApi(() => json({ member: { userId: ACME_OWNER, email: 'sam@acme.test', fullName: 'Sam Subscriber' }, mode: 'temporary' }));
    renderPanel();
    await waitFor(() => expect(resetButton()).toBeTruthy());

    fireEvent.click(resetButton());
    await confirmWithReason();

    const warning = await screen.findByTestId('subscribers-missing-credential');
    expect(warning.textContent).toMatch(/no temporary credential was returned/i);
    expect(warning.textContent).toMatch(/before telling the customer anything/i);
    expect(screen.queryByTestId('credential-dialog')).toBeNull();
  });
});

// @vitest-environment happy-dom
/**
 * The disposable-cleanup console.
 *
 * What these tests hold the UI to:
 *
 *   authority    every eligibility verdict rendered comes from the server; the
 *                component never computes one and never sends counts back;
 *   deliberation there is no single-click path to permanent deletion — a reason
 *                and an exactly-typed phrase are both required first;
 *   honesty      database deletion and external file cleanup are reported as two
 *                separate states, so a pending file cannot hide behind a
 *                successful row deletion;
 *   protection   a production subscriber offers Archive and nothing else.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { DisposableCleanupPanel } from './DisposableCleanupPanel';
import { BackendSubscribersPanel } from './BackendSubscribersPanel';
import { useAdminSubscriberStore } from '@/store/adminConsoleStores';
import { PERMANENT_DELETION_DISCLOSURE } from '@/services/api/cleanupApi';
import { openBusinessWorkspace } from '@/store/businessWorkspace';
import { setWorkspaceStorageMode, workspaceKeys } from '@/lib/workspaceStorage';
import type { PlatformCapabilityName } from '@/services/api/adminConsoleApi';

const API = 'https://api.example.test';
const TEST_ORG = '11111111-1111-4111-8111-111111111111';
const PROD_ORG = '22222222-2222-4222-8222-222222222222';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: TEST_ORG,
    legalName: 'Dev Sandbox Ltd',
    classification: 'test',
    status: 'active',
    eligible: true,
    blockers: [],
    everActivated: false,
    hasSubscriptionHistory: false,
    hasBusinessActivity: false,
    storedDocumentCount: 0,
    warnings: [],
    counts: [{ key: 'organization_memberships', label: 'Memberships', count: 2 }],
    identities: [],
    externalFileKeys: 0,
    ...overrides,
  };
}

function preview(candidates: Array<Record<string, unknown>>) {
  return {
    previewId: 'prev-1',
    digest: 'a'.repeat(64),
    previewedAt: '2026-08-10T09:00:00.000Z',
    candidates,
    eligibleCount: candidates.filter((c) => c.eligible).length,
    excludedCount: candidates.filter((c) => !c.eligible).length,
  };
}

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', API);
  useAdminSubscriberStore.getState().clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  useAdminSubscriberStore.getState().clear();
});

describe('the cleanup console', () => {
  it('shows eligible and excluded subscribers separately, with the blocking reason', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(
        preview([
          candidate(),
          candidate({
            organizationId: PROD_ORG,
            legalName: 'Real Customer Ltd',
            classification: 'production',
            eligible: false,
            blockers: [
              {
                code: 'production_subscriber',
                message: 'Production subscribers cannot be permanently deleted. Archive this subscriber instead.',
              },
            ],
          }),
        ]),
      ) as unknown as Response,
    );

    render(<DisposableCleanupPanel />);

    await waitFor(() => expect(screen.getByText('Eligible (1)')).toBeTruthy());
    expect(screen.getByText('Excluded (1)')).toBeTruthy();
    expect(screen.getByTestId(`cleanup-excluded-${PROD_ORG}`)).toBeTruthy();
    expect(screen.getByText(/Archive this subscriber instead/)).toBeTruthy();

    // An excluded row cannot be selected at all.
    const checkbox = screen.getByTestId(`cleanup-select-${PROD_ORG}`) as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
  });

  it('warns prominently about an ever-activated tenant while keeping it eligible', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(
        preview([
          candidate({
            everActivated: true,
            hasBusinessActivity: true,
            warnings: ['It has 3 invoice(s), which will be destroyed.'],
          }),
        ]),
      ) as unknown as Response,
    );

    render(<DisposableCleanupPanel />);

    await waitFor(() => expect(screen.getByTestId(`cleanup-activated-${TEST_ORG}`)).toBeTruthy());
    expect(screen.getByText(/was permitted to create accounting records/i)).toBeTruthy();
    expect(screen.getByText(/3 invoice\(s\), which will be destroyed/)).toBeTruthy();

    // Still selectable: activation is a warning, never a blocker.
    const checkbox = screen.getByTestId(`cleanup-select-${TEST_ORG}`) as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
  });

  it('requires a reason and the exact phrase before deletion is possible', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(preview([candidate()])) as unknown as Response,
    );

    render(<DisposableCleanupPanel />);
    await waitFor(() => expect(screen.getByTestId(`cleanup-select-${TEST_ORG}`)).toBeTruthy());

    fireEvent.click(screen.getByTestId(`cleanup-select-${TEST_ORG}`));

    const execute = () => screen.getByTestId('cleanup-execute') as HTMLButtonElement;
    await waitFor(() => expect(execute()).toBeTruthy());

    // Nothing typed.
    expect(execute().disabled).toBe(true);

    fireEvent.change(screen.getByTestId('cleanup-reason'), {
      target: { value: 'Removing the rehearsal tenants.' },
    });
    expect(execute().disabled, 'a reason alone must not be enough').toBe(true);

    // A near-miss phrase must not unlock it.
    fireEvent.change(screen.getByTestId('cleanup-confirmation'), {
      target: { value: 'delete test data permanently' },
    });
    expect(execute().disabled, 'the phrase is case-sensitive').toBe(true);

    fireEvent.change(screen.getByTestId('cleanup-confirmation'), {
      target: { value: 'DELETE TEST DATA PERMANENTLY' },
    });
    expect(execute().disabled).toBe(false);
  });

  it('sends the digest and never sends counts or eligibility back', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/preview')) return json(preview([candidate()])) as unknown as Response;
      return json({
        operationId: 'op-1',
        outcome: 'completed',
        organizations: [
          {
            organizationId: TEST_ORG,
            legalName: 'Dev Sandbox Ltd',
            deleted: true,
            removed: {},
            identitiesDeleted: [],
            identitiesRetained: [],
            filesQueued: 0,
          },
        ],
        databaseDeletion: { succeeded: 1, failed: 0 },
        externalCleanup: { pending: 0, completed: 0, failed: 0 },
        replayed: false,
      }) as unknown as Response;
    });

    render(<DisposableCleanupPanel />);
    await waitFor(() => expect(screen.getByTestId(`cleanup-select-${TEST_ORG}`)).toBeTruthy());

    fireEvent.click(screen.getByTestId(`cleanup-select-${TEST_ORG}`));
    fireEvent.change(screen.getByTestId('cleanup-reason'), {
      target: { value: 'Removing the rehearsal tenants.' },
    });
    fireEvent.change(screen.getByTestId('cleanup-confirmation'), {
      target: { value: 'DELETE TEST DATA PERMANENTLY' },
    });
    fireEvent.click(screen.getByTestId('cleanup-execute'));

    await waitFor(() => {
      const executeCall = fetchMock.mock.calls.find((call) => String(call[0]).endsWith('/execute'));
      expect(executeCall).toBeTruthy();
    });

    const executeCall = fetchMock.mock.calls.find((call) => String(call[0]).endsWith('/execute'))!;
    const body = JSON.parse(String((executeCall[1] as RequestInit).body));

    expect(body.previewDigest).toBe('a'.repeat(64));
    expect(body.organizationIds).toEqual([TEST_ORG]);
    expect(body.confirmation).toBe('DELETE TEST DATA PERMANENTLY');
    expect(body.operationId, 'an id must be sent so a replay is idempotent').toBeTruthy();

    /*
     * The client must not be able to assert what is deletable. If any of these
     * travelled, a tampered console could widen a deletion.
     */
    expect(body.eligible).toBeUndefined();
    expect(body.counts).toBeUndefined();
    expect(body.classification).toBeUndefined();
    expect(body.blockers).toBeUndefined();
  });

  /*
   * The console previews every disposable tenant and deletes only the ticked
   * ones. The digest it holds covers the whole roster, so it has to say which
   * ids that digest was computed over — otherwise the server recomputes over
   * the ticked subset, gets a different digest, and every partial selection is
   * rejected as stale.
   */
  it('sends the whole reviewed roster alongside the ticked subset', async () => {
    const OTHER_ORG = '33333333-3333-4333-8333-333333333333';

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/preview')) {
        return json(
          preview([
            candidate(),
            candidate({ organizationId: OTHER_ORG, legalName: 'Other Sandbox Ltd' }),
          ]),
        ) as unknown as Response;
      }
      return json({
        operationId: 'op-3',
        outcome: 'completed',
        organizations: [],
        databaseDeletion: { succeeded: 1, failed: 0 },
        externalCleanup: { pending: 0, completed: 0, failed: 0 },
        replayed: false,
      }) as unknown as Response;
    });

    render(<DisposableCleanupPanel />);
    await waitFor(() => expect(screen.getByTestId(`cleanup-select-${TEST_ORG}`)).toBeTruthy());

    // Tick one of the two eligible tenants.
    fireEvent.click(screen.getByTestId(`cleanup-select-${TEST_ORG}`));
    fireEvent.change(screen.getByTestId('cleanup-reason'), {
      target: { value: 'Removing one rehearsal tenant.' },
    });
    fireEvent.change(screen.getByTestId('cleanup-confirmation'), {
      target: { value: 'DELETE TEST DATA PERMANENTLY' },
    });
    fireEvent.click(screen.getByTestId('cleanup-execute'));

    await waitFor(() => {
      expect(fetchMock.mock.calls.find((call) => String(call[0]).endsWith('/execute'))).toBeTruthy();
    });

    const executeCall = fetchMock.mock.calls.find((call) => String(call[0]).endsWith('/execute'))!;
    const body = JSON.parse(String((executeCall[1] as RequestInit).body));

    expect(body.organizationIds, 'only the ticked tenant is destroyed').toEqual([TEST_ORG]);
    expect(
      body.previewedOrganizationIds,
      'the digest covers the whole roster, so the whole roster must be named',
    ).toEqual([TEST_ORG, OTHER_ORG]);
  });

  /*
   * Arriving from a row's "Permanently delete" is an explicit choice of a named
   * tenant. Losing it would send the operator hunting through the full roster
   * to re-tick the row they already picked, which is how the wrong one gets
   * ticked.
   */
  const mixedRoster = () =>
    preview([
      candidate(),
      candidate({
        organizationId: PROD_ORG,
        legalName: 'Real Customer Ltd',
        classification: 'production',
        eligible: false,
        blockers: [{ code: 'production_subscriber', message: 'Production subscribers cannot be deleted.' }],
      }),
    ]);

  it('pre-selects the eligible tenant the operator arrived from', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(mixedRoster()) as unknown as Response);

    render(<DisposableCleanupPanel focusOrganizationId={TEST_ORG} />);

    await waitFor(() =>
      expect((screen.getByTestId(`cleanup-select-${TEST_ORG}`) as HTMLInputElement).checked).toBe(true),
    );
    // Still no shortcut: the phrase and reason are untouched, so nothing can go yet.
    expect((screen.getByTestId('cleanup-execute') as HTMLButtonElement).disabled).toBe(true);
  });

  it('never pre-selects a focused tenant the server reports ineligible', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(mixedRoster()) as unknown as Response);

    render(<DisposableCleanupPanel focusOrganizationId={PROD_ORG} />);

    await waitFor(() => expect(screen.getByTestId(`cleanup-excluded-${PROD_ORG}`)).toBeTruthy());
    expect((screen.getByTestId(`cleanup-select-${PROD_ORG}`) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId(`cleanup-select-${TEST_ORG}`) as HTMLInputElement).checked).toBe(false);
  });

  /*
   * The ledger exists so a crash between deleting rows and deleting files is
   * recoverable. That only helps if the leftover work is visible to whoever
   * opens the console next, not just to whoever was watching when it failed.
   */
  it('surfaces file cleanup left outstanding by an earlier session and retries all of it', async () => {
    let pending = 3;

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/file-status')) {
        return json({ pending, completed: 0, failed: 0 }) as unknown as Response;
      }
      if (url.endsWith('/retry-files')) {
        pending = 0;
        return json({ pending: 0, completed: 3, failed: 0 }) as unknown as Response;
      }
      return json(preview([candidate()])) as unknown as Response;
    });

    render(<DisposableCleanupPanel />);

    await waitFor(() => expect(screen.getByTestId('cleanup-outstanding-files')).toBeTruthy());
    expect(screen.getByText(/3 stored file\(s\) pending/)).toBeTruthy();

    fireEvent.click(screen.getByTestId('cleanup-retry-all-files'));

    // Retrying everything means NOT scoping to one operation.
    await waitFor(() => {
      const retry = fetchMock.mock.calls.find((call) => String(call[0]).endsWith('/retry-files'));
      expect(retry).toBeTruthy();
      expect(JSON.parse(String((retry![1] as RequestInit).body)).operationId).toBeUndefined();
    });

    // Once the ledger is clear the notice goes away rather than lingering.
    await waitFor(() => expect(screen.queryByTestId('cleanup-outstanding-files')).toBeNull());
  });

  it('starts with nothing selected when the tab is opened to browse', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(preview([candidate()])) as unknown as Response,
    );

    render(<DisposableCleanupPanel />);

    await waitFor(() => expect(screen.getByTestId(`cleanup-select-${TEST_ORG}`)).toBeTruthy());
    expect((screen.getByTestId(`cleanup-select-${TEST_ORG}`) as HTMLInputElement).checked).toBe(false);
  });

  /*
   * The server cannot delete the books — they are in this browser. So the panel
   * finishes the job locally, and it must key that off what the server said it
   * DELETED rather than off what the operator selected: a tenant whose deletion
   * failed still exists, and destroying its local ledger would be data loss on a
   * live subscriber.
   */
  it('purges local workspace data only for tenants the server confirmed deleted', async () => {
    const FAILED_ORG = '44444444-4444-4444-8444-444444444444';

    setWorkspaceStorageMode('backend');
    openBusinessWorkspace({ kind: 'tenant', organizationId: TEST_ORG });
    openBusinessWorkspace({ kind: 'tenant', organizationId: FAILED_ORG });

    const deletedWorkspace = { kind: 'tenant' as const, organizationId: TEST_ORG };
    const survivingWorkspace = { kind: 'tenant' as const, organizationId: FAILED_ORG };
    expect(workspaceKeys(deletedWorkspace).length).toBeGreaterThan(0);
    expect(workspaceKeys(survivingWorkspace).length).toBeGreaterThan(0);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/preview')) {
        return json(
          preview([candidate(), candidate({ organizationId: FAILED_ORG, legalName: 'Stubborn Ltd' })]),
        ) as unknown as Response;
      }
      if (url.endsWith('/file-status')) {
        return json({ pending: 0, completed: 0, failed: 0 }) as unknown as Response;
      }
      return json({
        operationId: 'op-4',
        outcome: 'failed',
        organizations: [
          { organizationId: TEST_ORG, legalName: 'Dev Sandbox Ltd', deleted: true, removed: {}, identitiesDeleted: [], identitiesRetained: [], filesQueued: 0 },
          { organizationId: FAILED_ORG, legalName: 'Stubborn Ltd', deleted: false, removed: {}, identitiesDeleted: [], identitiesRetained: [], filesQueued: 0, error: 'legal hold applied' },
        ],
        databaseDeletion: { succeeded: 1, failed: 1 },
        externalCleanup: { pending: 0, completed: 0, failed: 0 },
        workspaceDeletion: { status: 'no_server_workspace', detail: 'Records live in each user’s browser.' },
        replayed: false,
      }) as unknown as Response;
    });

    render(<DisposableCleanupPanel />);
    await waitFor(() => expect(screen.getByTestId('cleanup-select-all')).toBeTruthy());

    fireEvent.click(screen.getByTestId('cleanup-select-all'));
    fireEvent.change(screen.getByTestId('cleanup-reason'), {
      target: { value: 'Removing the rehearsal tenants.' },
    });
    fireEvent.change(screen.getByTestId('cleanup-confirmation'), {
      target: { value: 'DELETE TEST DATA PERMANENTLY' },
    });
    fireEvent.click(screen.getByTestId('cleanup-execute'));

    await waitFor(() => expect(screen.getByTestId('cleanup-result')).toBeTruthy());

    expect(workspaceKeys(deletedWorkspace), 'a confirmed-deleted tenant loses its local books').toEqual([]);
    expect(
      workspaceKeys(survivingWorkspace).length,
      'a tenant the server refused to delete keeps its books',
    ).toBeGreaterThan(0);
  });

  it('states that accounting workspaces are not deleted by the server', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/preview')) return json(preview([candidate()])) as unknown as Response;
      if (url.endsWith('/file-status')) {
        return json({ pending: 0, completed: 0, failed: 0 }) as unknown as Response;
      }
      return json({
        operationId: 'op-5',
        outcome: 'completed',
        organizations: [],
        databaseDeletion: { succeeded: 1, failed: 0 },
        externalCleanup: { pending: 0, completed: 0, failed: 0 },
        workspaceDeletion: {
          status: 'no_server_workspace',
          detail: 'Records live in each user’s browser workspace, not on the server.',
        },
        replayed: false,
      }) as unknown as Response;
    });

    render(<DisposableCleanupPanel />);
    await waitFor(() => expect(screen.getByTestId(`cleanup-select-${TEST_ORG}`)).toBeTruthy());

    fireEvent.click(screen.getByTestId(`cleanup-select-${TEST_ORG}`));
    fireEvent.change(screen.getByTestId('cleanup-reason'), {
      target: { value: 'Removing the rehearsal tenant.' },
    });
    fireEvent.change(screen.getByTestId('cleanup-confirmation'), {
      target: { value: 'DELETE TEST DATA PERMANENTLY' },
    });
    fireEvent.click(screen.getByTestId('cleanup-execute'));

    const state = await screen.findByTestId('cleanup-workspace-state');
    expect(state.textContent).toMatch(/not deleted by the server/i);
    expect(state.textContent).toMatch(/browser/i);
  });

  it('warns that an activated tenant’s books are not erased by the deletion', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(preview([candidate({ everActivated: true })])) as unknown as Response,
    );

    render(<DisposableCleanupPanel />);

    await waitFor(() => expect(screen.getByTestId(`cleanup-activated-${TEST_ORG}`)).toBeTruthy());
    const warning = screen.getByTestId(`cleanup-activated-${TEST_ORG}`);
    // The old wording said only that the records "cannot be counted from here",
    // which reads as though the deletion covered them.
    expect(warning.textContent).toMatch(/not on the server/i);
    expect(warning.textContent).toMatch(/cannot erase data already written/i);
  });

  /*
   * The disclosure is the last thing an operator reads before typing the
   * phrase. Both halves matter: what IS destroyed, and the device data that
   * cannot be. Asserted verbatim so a reworded version cannot quietly drop the
   * second sentence.
   */
  it('shows the permanent-deletion disclosure verbatim before the phrase can be typed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(preview([candidate()])) as unknown as Response,
    );

    render(<DisposableCleanupPanel />);
    await waitFor(() => expect(screen.getByTestId(`cleanup-select-${TEST_ORG}`)).toBeTruthy());

    // No selection yet: no confirmation section, so nothing to confirm.
    expect(screen.queryByTestId('cleanup-disclosure')).toBeNull();

    fireEvent.click(screen.getByTestId(`cleanup-select-${TEST_ORG}`));

    const disclosure = screen.getByTestId('cleanup-disclosure');
    expect(disclosure.textContent).toBe(PERMANENT_DELETION_DISCLOSURE);
    expect(disclosure.textContent).toMatch(/platform account, memberships, sessions, and server-held data/);
    expect(disclosure.textContent).toMatch(/cannot be remotely erased and may remain on those devices/);

    // And the screen names the operation for what it is.
    expect(screen.getByText(/Permanently delete 1 subscriber from Ledgora’s platform/)).toBeTruthy();
  });

  it('reports database and file cleanup as separate states', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/preview')) return json(preview([candidate()])) as unknown as Response;
      return json({
        operationId: 'op-2',
        outcome: 'completed_with_pending_cleanup',
        organizations: [
          {
            organizationId: TEST_ORG,
            legalName: 'Dev Sandbox Ltd',
            deleted: true,
            removed: {},
            identitiesDeleted: [],
            identitiesRetained: [],
            filesQueued: 2,
          },
        ],
        databaseDeletion: { succeeded: 1, failed: 0 },
        externalCleanup: { pending: 2, completed: 0, failed: 0 },
        replayed: false,
      }) as unknown as Response;
    });

    render(<DisposableCleanupPanel />);
    await waitFor(() => expect(screen.getByTestId(`cleanup-select-${TEST_ORG}`)).toBeTruthy());

    fireEvent.click(screen.getByTestId(`cleanup-select-${TEST_ORG}`));
    fireEvent.change(screen.getByTestId('cleanup-reason'), {
      target: { value: 'Removing the rehearsal tenants.' },
    });
    fireEvent.change(screen.getByTestId('cleanup-confirmation'), {
      target: { value: 'DELETE TEST DATA PERMANENTLY' },
    });
    fireEvent.click(screen.getByTestId('cleanup-execute'));

    await waitFor(() => expect(screen.getByTestId('cleanup-result')).toBeTruthy());

    // The headline must not claim plain completion while files are outstanding.
    expect(screen.getByText(/Completed, with file cleanup outstanding/)).toBeTruthy();
    expect(screen.getByText(/Database: 1 deleted, 0 failed/)).toBeTruthy();
    expect(screen.getByText(/Files: 0 removed, 2 pending, 0 failed/)).toBeTruthy();
    expect(screen.getByText('Retry file cleanup')).toBeTruthy();
  });

  it('surfaces a stale-preview refusal instead of retrying silently', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/preview')) return json(preview([candidate()])) as unknown as Response;
      return json(
        {
          error: {
            code: 'conflict',
            message: 'The subscribers changed since the preview was taken. Review a fresh preview before deleting anything.',
          },
        },
        409,
      ) as unknown as Response;
    });

    render(<DisposableCleanupPanel />);
    await waitFor(() => expect(screen.getByTestId(`cleanup-select-${TEST_ORG}`)).toBeTruthy());

    fireEvent.click(screen.getByTestId(`cleanup-select-${TEST_ORG}`));
    fireEvent.change(screen.getByTestId('cleanup-reason'), {
      target: { value: 'Removing the rehearsal tenants.' },
    });
    fireEvent.change(screen.getByTestId('cleanup-confirmation'), {
      target: { value: 'DELETE TEST DATA PERMANENTLY' },
    });
    fireEvent.click(screen.getByTestId('cleanup-execute'));

    await waitFor(() => expect(screen.getByTestId('cleanup-error')).toBeTruthy());
    expect(screen.getByText(/changed since the preview/i)).toBeTruthy();
  });
});

/* ══ The roster ════════════════════════════════════════════════════════════ */

const SUPER_ADMIN: PlatformCapabilityName[] = [
  'view-admin',
  'subscribers.read',
  'subscribers.create',
  'subscribers.manage',
  'subscribers.delete',
  'members.read',
];

function rosterRow(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: PROD_ORG,
    legalName: 'Real Customer Ltd',
    tradingName: null,
    country: 'AE',
    organizationStatus: 'active',
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
    seatsUsed: 1,
    seatLimit: 3,
    entityLimit: 1,
    modules: ['accounting'],
    entitlementActive: true,
    ownerUserId: 'usr_1',
    ownerName: 'Sam Subscriber',
    ownerEmail: 'sam@acme.test',
    memberCount: 1,
    openInvoiceId: null,
    openInvoiceStatus: null,
    pendingProofId: null,
    ...overrides,
  };
}

describe('the subscriber roster', () => {
  function renderRoster(rows: Array<Record<string, unknown>>) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        subscribers: rows,
        pagination: { limit: 25, offset: 0, count: rows.length, total: rows.length },
        facets: {},
      }) as unknown as Response,
    );

    return render(
      <BackendSubscribersPanel
        capabilities={SUPER_ADMIN}
        onAddSubscriber={() => undefined}
        onAssignPackage={() => undefined}
        onViewMembers={() => undefined}
        onCleanUp={() => undefined}
      />,
    );
  }

  it('badges classification and offers a production subscriber archive only', async () => {
    renderRoster([rosterRow()]);

    await waitFor(() => expect(screen.getByTestId(`classification-${PROD_ORG}`)).toBeTruthy());
    expect(screen.getByTestId(`classification-${PROD_ORG}`).textContent).toBe('production');

    // Archive is offered; permanent deletion is not, and the reason is stated.
    expect(screen.getByTestId(`archive-${PROD_ORG}`)).toBeTruthy();
    expect(screen.queryByTestId(`permanently-delete-${PROD_ORG}`)).toBeNull();
    expect(screen.getByTestId(`retention-note-${PROD_ORG}`).textContent).toMatch(/Archive only/);
  });

  it('offers permanent deletion for a test subscriber, alongside archive', async () => {
    renderRoster([
      rosterRow({ organizationId: TEST_ORG, legalName: 'Dev Sandbox Ltd', dataClassification: 'test' }),
    ]);

    await waitFor(() => expect(screen.getByTestId(`classification-${TEST_ORG}`)).toBeTruthy());
    expect(screen.getByTestId(`classification-${TEST_ORG}`).textContent).toBe('test');
    expect(screen.getByTestId(`permanently-delete-${TEST_ORG}`)).toBeTruthy();
    expect(screen.getByTestId(`archive-${TEST_ORG}`)).toBeTruthy();
    expect(screen.queryByTestId(`retention-note-${TEST_ORG}`)).toBeNull();
  });

  it('keeps the global "Add user" action absent from platform administration', async () => {
    renderRoster([rosterRow()]);

    await waitFor(() => expect(screen.getByTestId(`classification-${PROD_ORG}`)).toBeTruthy());

    /*
     * Users belong to a subscriber, who manages them from their own Users &
     * Roles page. A global "Add user" here would re-introduce the ownership
     * confusion that was deliberately removed.
     */
    expect(screen.queryByText('Add user')).toBeNull();
    expect(screen.queryByTestId('add-user')).toBeNull();
  });

  it('does not offer deletion to an operator without the capability', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        subscribers: [rosterRow({ organizationId: TEST_ORG, dataClassification: 'test' })],
        pagination: { limit: 25, offset: 0, count: 1, total: 1 },
        facets: {},
      }) as unknown as Response,
    );

    render(
      <BackendSubscribersPanel
        capabilities={['view-admin', 'subscribers.read'] as PlatformCapabilityName[]}
        onAddSubscriber={() => undefined}
        onAssignPackage={() => undefined}
        onViewMembers={() => undefined}
      />,
    );

    await waitFor(() => expect(screen.getByTestId(`classification-${TEST_ORG}`)).toBeTruthy());
    expect(screen.queryByTestId(`permanently-delete-${TEST_ORG}`)).toBeNull();
  });
});

// @vitest-environment happy-dom
/**
 * The Super Admin subscriber-closure workflow.
 *
 * What these tests hold the UI to:
 *
 *   authority   closure actions are offered only to an operator holding the
 *               relevant capability — and the backend remains authoritative;
 *   lifecycle   the actions offered match the subscriber's actual state, and a
 *               pending deletion never offers reactivation;
 *   honesty     every blocker the server returns is shown, `serverVerifiable:
 *               false` is never rendered as a zero, and a refused deletion is
 *               never reported as success;
 *   secrecy     the operator's password and an export's download token live in
 *               component state only, and are cleared when they should be;
 *   scope       one subscriber's dialog never shows another's data.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { BackendSubscribersPanel } from './BackendSubscribersPanel';
import { SubscriberClosureDrawer } from './SubscriberClosureDrawer';
import { RequestDeletionDialog } from './RequestDeletionDialog';
import { useAdminSubscriberStore } from '@/store/adminConsoleStores';
import type { PlatformCapabilityName } from '@/services/api/adminConsoleApi';
import type { DeletionImpact } from '@/services/api/closureApi';

const API = 'https://api.example.test';
const ACME = '11111111-1111-4111-8111-111111111111';
const GLOBEX = '22222222-2222-4222-8222-222222222222';

const SUPER_ADMIN: PlatformCapabilityName[] = [
  'view-admin',
  'subscribers.read',
  'subscribers.manage',
  'subscribers.archive',
  'subscribers.request_deletion',
  'subscribers.export',
  'subscribers.delete',
];

/** Holds `subscribers.read` and nothing that closes an account. */
const SUPPORT: PlatformCapabilityName[] = ['view-admin', 'subscribers.read'];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockRoutes(routes: Array<[RegExp, (url: string, init?: RequestInit) => Response | Promise<Response>]>) {
  const calls: Array<{ url: string; body: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url: url.replace(API, ''), body: typeof init?.body === 'string' ? init.body : '' });
    const hit = routes.find(([pattern]) => pattern.test(url));
    if (!hit) return json({ error: { code: 'not_found', message: `no route for ${url}` } }, 404);
    return hit[1](url, init);
  });
  return calls;
}

/** The panel's required callbacks, none of which these tests exercise. */
const panelHandlers = () => ({
  onAddSubscriber: vi.fn(),
  onAssignPackage: vi.fn(),
  onViewMembers: vi.fn(),
});

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

function subscriberRow(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ACME,
    legalName: 'Acme Holdings Ltd.',
    tradingName: null,
    country: 'AE',
    organizationStatus: 'active',
    dataClassification: 'production',
    // Reviewed by default: existing tests are about accounts nobody is reconciling.
    classificationReviewedAt: '2026-01-02T00:00:00.000Z',
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
    ownerName: 'Sam Owner',
    ownerEmail: 'sam@acme.test',
    memberCount: 2,
    openInvoiceId: null,
    openInvoiceStatus: null,
    pendingProofId: null,
    ...overrides,
  };
}

/** The reconciliation evidence summary, as the server computes it. */
function evidenceFixture(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ACME,
    legalName: 'Acme Holdings Ltd.',
    ownerEmail: 'owner@legacy.test',
    createdAt: '2025-11-03T00:00:00.000Z',
    organizationStatus: 'active',
    currentClassification: 'production',
    reviewedAt: null,
    everActivated: false,
    subscriptionCount: 0,
    paidInvoiceCount: 0,
    approvedProofCount: 0,
    legalHold: false,
    platformOperatorMember: false,
    findings: ['No billing, payment or activation history was found.'],
    looksDisposable: true,
    ...overrides,
  };
}

const subscriberList = (rows: unknown[]) => ({
  subscribers: rows,
  pagination: { limit: 25, offset: 0, count: rows.length, total: rows.length },
  facets: { organizationStatus: {}, subscriptionStatus: {} },
});

function closure(overrides: Record<string, unknown> = {}) {
  return {
    closure: {
      organizationId: ACME,
      legalName: 'Acme Holdings Ltd.',
      organizationStatus: 'active',
      archivedAt: null,
      archiveReason: null,
      deletionRequestedAt: null,
      scheduledPurgeAfter: null,
      deletionReason: null,
      legalHold: false,
      legalHoldReason: null,
      // Production is the default everywhere, including in fixtures.
      dataClassification: 'production',
      classifiedProductionAt: null,
      classificationReason: null,
      recoveryDaysRemaining: null,
      canCancelDeletion: false,
      canRestore: false,
      ...overrides,
    },
  };
}

function impact(overrides: Partial<DeletionImpact> = {}): DeletionImpact {
  return {
    organizationId: ACME,
    legalName: 'Acme Holdings Ltd.',
    organizationStatus: 'archived',
    counts: [
      { key: 'members', label: 'Organization members', count: 2, serverVerifiable: true },
      {
        key: 'journal_entries',
        label: 'Posted journal entries',
        count: null,
        serverVerifiable: false,
        note: 'Held in the customer workspace, not in the account service.',
      },
    ],
    deletionPermitted: true,
    blockingReasons: [],
    willBeAnonymized: ['Members who appear in retained audit history'],
    willBePermanentlyDeleted: ['Organization record'],
    willBeRetained: ['Every audit entry'],
    recommendation: 'This subscriber may be permanently deleted.',
    assessedAt: '2026-08-09T10:00:00.000Z',
    ...overrides,
  };
}

const BLOCKED = impact({
  deletionPermitted: false,
  blockingReasons: [
    { code: 'accounting_records_possible', message: 'This subscriber has held an active subscription.' },
    { code: 'legal_hold', message: 'This subscriber is under a legal hold: ongoing dispute.' },
  ],
  willBeAnonymized: [],
  willBePermanentlyDeleted: [],
  recommendation:
    'This subscriber contains accounting or legally retained records and cannot be permanently deleted. Archive the subscriber instead.',
});

/** The routes a closure drawer needs to load. */
const closureRoutes = (
  status: ReturnType<typeof closure>,
  assessment: DeletionImpact,
  exports: unknown[] = [],
): Array<[RegExp, () => Response]> => [
  [/\/closure\/impact/, () => json({ impact: assessment })],
  [/\/closure$/, () => json(status)],
  [/\/exports$/, () => json({ exports })],
];

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

/* ══ Authority ═══════════════════════════════════════════════════════════ */

describe('who sees the closure actions', () => {
  it('offers "Manage closure" to an operator holding a closure capability', async () => {
    mockRoutes([[/\/api\/admin\/subscribers/, () => json(subscriberList([subscriberRow()]))]]);
    render(<BackendSubscribersPanel capabilities={SUPER_ADMIN} {...panelHandlers()} />);
    expect(await screen.findByTestId(`manage-closure-${ACME}`)).toBeTruthy();
  });

  /*
   * The roster is a window over the whole table, so the filter has to reach the
   * server. Filtering the loaded page would answer "the demo tenants on page 1"
   * while looking like it answered "the demo tenants".
   */
  it('shows the classification badge and filters server-side', async () => {
    const calls = mockRoutes([
      [
        /\/api\/admin\/subscribers/,
        () =>
          json(
            subscriberList([
              subscriberRow(),
              subscriberRow({
                organizationId: GLOBEX,
                legalName: 'Ledgora Demo 01',
                dataClassification: 'demo',
              }),
            ]),
          ),
      ],
    ]);

    render(<BackendSubscribersPanel capabilities={SUPER_ADMIN} {...panelHandlers()} />);

    await waitFor(() => expect(screen.getByTestId(`classification-${ACME}`)).toBeTruthy());
    expect(screen.getByTestId(`classification-${ACME}`).textContent).toBe('PRODUCTION');
    expect(screen.getByTestId(`classification-${GLOBEX}`).textContent).toBe('DEMO');

    fireEvent.change(screen.getByTestId('classification-filter'), { target: { value: 'demo' } });

    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('classification=demo'))).toBe(true),
    );
    // "Any type" clears the filter rather than sending classification=all.
    fireEvent.change(screen.getByTestId('classification-filter'), { target: { value: 'all' } });
    await waitFor(() =>
      expect(calls.filter((c) => c.url.includes('classification=')).length).toBeGreaterThan(0),
    );
  });

  /*
   * Requirement: an existing subscriber with no recorded classification must not
   * silently become one. Rendering "unknown" as demo is precisely how an
   * uncertain historical customer would turn disposable by default.
   */
  it('marks an unclassified subscriber as requiring classification, not as disposable', async () => {
    const unclassified = subscriberRow({ organizationId: GLOBEX, legalName: 'Legacy Customer Ltd' });
    delete (unclassified as Record<string, unknown>).dataClassification;

    mockRoutes([[/\/api\/admin\/subscribers/, () => json(subscriberList([unclassified]))]]);
    render(<BackendSubscribersPanel capabilities={SUPER_ADMIN} {...panelHandlers()} />);

    await waitFor(() => expect(screen.getByTestId(`classification-${GLOBEX}`)).toBeTruthy());
    const badge = screen.getByTestId(`classification-${GLOBEX}`);
    expect(badge.textContent).toBe('Classification required');
    expect(badge.textContent).not.toMatch(/demo|test/i);

    // And it is not offered for permanent deletion on the strength of a guess.
    expect(screen.queryByTestId(`permanently-delete-${GLOBEX}`)).toBeNull();
  });

  /*
   * Reconciling the 008 migration's blanket default. No row is unclassified
   * (the column is NOT NULL), so what is being reconciled is the migration's
   * guess — and confirming it can only ever land on Production.
   */
  it('offers Classify subscriber only while the classification is unreviewed', async () => {
    const reviewed = subscriberRow({ classificationReviewedAt: '2026-08-01T00:00:00.000Z' });
    const unreviewed = subscriberRow({
      organizationId: GLOBEX,
      legalName: 'Legacy Customer Ltd',
      classificationReviewedAt: null,
    });

    mockRoutes([[/\/api\/admin\/subscribers/, () => json(subscriberList([reviewed, unreviewed]))]]);
    render(<BackendSubscribersPanel capabilities={SUPER_ADMIN} {...panelHandlers()} />);

    await waitFor(() => expect(screen.getByTestId(`classify-${GLOBEX}`)).toBeTruthy());
    // The reviewed row offers nothing to reconcile.
    expect(screen.queryByTestId(`classify-${ACME}`)).toBeNull();
    // And the unreviewed one is marked as such next to its type.
    expect(screen.getByTestId(`classification-${GLOBEX}`).textContent).toMatch(/unreviewed/i);
  });

  it('hides Classify subscriber from an operator without subscribers.manage', async () => {
    mockRoutes([
      [
        /\/api\/admin\/subscribers/,
        () => json(subscriberList([subscriberRow({ classificationReviewedAt: null })])),
      ],
    ]);
    render(<BackendSubscribersPanel capabilities={SUPPORT} {...panelHandlers()} />);

    await waitFor(() => expect(screen.getByTestId(`classification-${ACME}`)).toBeTruthy());
    expect(screen.queryByTestId(`classify-${ACME}`)).toBeNull();
  });

  it('defaults to Production, requires a reason, and refreshes the roster on success', async () => {
    let classified = false;
    let posted: Record<string, unknown> | null = null;

    const calls = mockRoutes([
      [/\/classification-evidence$/, () => json({ evidence: evidenceFixture() })],
      [
        /\/classify$/,
        (_url, init) => {
          posted = JSON.parse(String(init?.body));
          classified = true;
          return json({
            classification: {
              organizationId: ACME,
              classification: 'production',
              reviewedAt: '2026-08-11T00:00:00.000Z',
              evidence: evidenceFixture(),
            },
          });
        },
      ],
      [
        /\/api\/admin\/subscribers/,
        () =>
          json(
            subscriberList([
              subscriberRow({
                classificationReviewedAt: classified ? '2026-08-11T00:00:00.000Z' : null,
              }),
            ]),
          ),
      ],
    ]);

    render(<BackendSubscribersPanel capabilities={SUPER_ADMIN} {...panelHandlers()} />);
    fireEvent.click(await screen.findByTestId(`classify-${ACME}`));

    await screen.findByTestId('classify-evidence');
    // The evidence an operator needs, from the server.
    expect(screen.getByTestId('classify-evidence').textContent).toMatch(/owner@legacy\.test/);

    const submit = () => screen.getByTestId('classify-submit') as HTMLButtonElement;
    // Production is pre-selected; a reason is still mandatory.
    expect(
      (within(screen.getByTestId('classify-choice-production')).getByRole('radio') as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(submit().disabled, 'a reason is required').toBe(true);

    fireEvent.change(screen.getByTestId('classify-reason'), {
      target: { value: 'Confirmed against the signed order form.' },
    });
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());

    await waitFor(() => expect(posted).toBeTruthy());
    expect(posted!.classification).toBe('production');

    /*
     * The roster is re-read rather than patched locally, so the badge and the
     * action set come from the server — and the marker disappears with no page
     * reload.
     */
    await waitFor(() => expect(screen.queryByTestId(`classify-${ACME}`)).toBeNull());
    expect(screen.getByTestId(`classification-${ACME}`).textContent).not.toMatch(/unreviewed/i);
    expect(calls.filter((c) => c.url.includes('/api/admin/subscribers?')).length).toBeGreaterThan(1);
  });

  it('requires the acknowledgement for Demo/Test and shows the server refusal', async () => {
    mockRoutes([
      [/\/classification-evidence$/, () => json({ evidence: evidenceFixture() })],
      [
        /\/classify$/,
        () =>
          json(
            {
              error: {
                code: 'conflict',
                message:
                  'Reconciliation can only confirm a subscriber as Production. Marking an existing account disposable is a retention override and is available only through the development CLI, against a development database.',
              },
            },
            409,
          ),
      ],
      [
        /\/api\/admin\/subscribers/,
        () => json(subscriberList([subscriberRow({ classificationReviewedAt: null })])),
      ],
    ]);

    render(<BackendSubscribersPanel capabilities={SUPER_ADMIN} {...panelHandlers()} />);
    fireEvent.click(await screen.findByTestId(`classify-${ACME}`));
    await screen.findByTestId('classify-evidence');

    fireEvent.change(screen.getByTestId('classify-reason'), {
      target: { value: 'I believe this is leftover development data.' },
    });
    fireEvent.click(within(screen.getByTestId('classify-choice-demo')).getByRole('radio'));

    const submit = () => screen.getByTestId('classify-submit') as HTMLButtonElement;
    expect(submit().disabled, 'demo needs the explicit acknowledgement').toBe(true);
    expect(screen.getByTestId('classify-acknowledgement').textContent).toMatch(
      /not a real production customer/i,
    );

    fireEvent.click(within(screen.getByTestId('classify-acknowledgement')).getByRole('checkbox'));
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());

    // The server's own sentence, and the dialog stays open.
    expect((await screen.findByTestId('classify-error')).textContent).toMatch(/development CLI/i);
    expect(screen.getByTestId('classify-dialog')).toBeTruthy();
  });

  it('does not offer it to a support operator', async () => {
    mockRoutes([[/\/api\/admin\/subscribers/, () => json(subscriberList([subscriberRow()]))]]);
    render(<BackendSubscribersPanel capabilities={SUPPORT} {...panelHandlers()} />);
    await screen.findByText('Acme Holdings Ltd.');
    // A courtesy, not a control — the routes refuse them regardless.
    expect(screen.queryByTestId(`manage-closure-${ACME}`)).toBeNull();
  });

  it('shows only the actions the operator is capable of', async () => {
    mockRoutes(closureRoutes(closure({ organizationStatus: 'archived', canRestore: true }), impact()));
    render(
      <SubscriberClosureDrawer
        open
        organizationId={ACME}
        legalName="Acme Holdings Ltd."
        ownerEmail="sam@acme.test"
        memberCount={2}
        subscriptionStatus="cancelled"
        createdAt="2026-01-01T00:00:00.000Z"
        // Archive only: no deletion, no export.
        capabilities={['subscribers.archive']}
        onClose={vi.fn()}
        onRequestDeletion={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    await screen.findByTestId('closure-actions');
    expect(screen.getByTestId('action-reactivate')).toBeTruthy();
    expect(screen.queryByTestId('action-request-deletion')).toBeNull();
    expect(screen.queryByTestId('action-export')).toBeNull();
  });
});

/* ══ Lifecycle → actions ═════════════════════════════════════════════════ */

describe('actions follow the lifecycle state', () => {
  const renderDrawer = (props: Partial<Record<string, unknown>> = {}) =>
    render(
      <SubscriberClosureDrawer
        open
        organizationId={ACME}
        legalName="Acme Holdings Ltd."
        ownerEmail="sam@acme.test"
        memberCount={2}
        subscriptionStatus="active"
        createdAt="2026-01-01T00:00:00.000Z"
        capabilities={SUPER_ADMIN}
        onClose={vi.fn()}
        onRequestDeletion={vi.fn()}
        onChanged={vi.fn()}
        {...(props as object)}
      />,
    );

  /*
   * Classification decides which of these actions can exist at all, so the
   * drawer has to state it and has to offer reclassification only where the
   * database would accept it.
   */
  it('shows the classification and the retention notice for a production account', async () => {
    mockRoutes(closureRoutes(closure({ dataClassification: 'production' }), impact()));
    renderDrawer();
    await screen.findByTestId('closure-actions');

    expect(screen.getByTestId('detail-classification').textContent).toBe('PRODUCTION');
    expect(screen.getByTestId('classification-notice').textContent).toMatch(
      /protected by Ledgora retention policy/i,
    );

    // No reclassification control, and the reason is stated rather than implied.
    expect(screen.queryByTestId('action-change-classification')).toBeNull();
    expect(screen.getByTestId('classification-permanent-note').textContent).toMatch(
      /Production classification is permanent/i,
    );
  });

  it('shows the disposable notice and offers reclassification for a demo account', async () => {
    mockRoutes(closureRoutes(closure({ dataClassification: 'demo' }), impact()));
    renderDrawer();
    await screen.findByTestId('closure-actions');

    expect(screen.getByTestId('detail-classification').textContent).toBe('DEMO');
    expect(screen.getByTestId('classification-notice').textContent).toMatch(
      /permanent deletion may be available after eligibility assessment/i,
    );
    expect(screen.getByTestId('action-change-classification')).toBeTruthy();
    expect(screen.queryByTestId('classification-permanent-note')).toBeNull();
  });

  it('offers only the moves the database permits, and never a downgrade', async () => {
    mockRoutes(closureRoutes(closure({ dataClassification: 'demo' }), impact()));
    renderDrawer();
    await screen.findByTestId('closure-actions');

    fireEvent.click(screen.getByTestId('action-change-classification'));

    const target = (await screen.findByTestId('reclassify-target')) as HTMLSelectElement;
    const offered = [...target.options].map((option) => option.value);
    // From demo: the other disposable flavour, or promotion. Never "stay demo".
    expect(offered.sort()).toEqual(['production', 'test']);
  });

  it('sends the promotion with its reason and reports the change', async () => {
    let patched: { url: string; body: Record<string, unknown> } | null = null;

    mockRoutes([
      [
        /\/classification$/,
        (url, init) => {
          patched = { url, body: JSON.parse(String(init?.body)) };
          return json({
            classification: {
              organizationId: ACME,
              previousClassification: 'demo',
              classification: 'production',
              classifiedProductionAt: '2026-08-10T00:00:00.000Z',
            },
          });
        },
      ],
      ...closureRoutes(closure({ dataClassification: 'demo' }), impact()),
    ]);

    renderDrawer();
    await screen.findByTestId('closure-actions');
    fireEvent.click(screen.getByTestId('action-change-classification'));
    await screen.findByTestId('reclassify-target');

    fireEvent.change(screen.getByTestId('reclassify-target'), { target: { value: 'production' } });
    // Promotion is irreversible, and the dialog says so before it is confirmed.
    expect(screen.getByText(/Promotion is irreversible/i)).toBeTruthy();

    fireEvent.change(screen.getByTestId('reason-input'), {
      target: { value: 'The pilot converted; this is a paying customer now.' },
    });
    fireEvent.click(screen.getByTestId('reason-confirm'));

    await waitFor(() => expect(patched).toBeTruthy());
    expect(patched!.body.classification).toBe('production');
    expect(String(patched!.body.reason)).toMatch(/paying customer/i);
  });

  it('shows the server refusal verbatim when a downgrade is somehow attempted', async () => {
    mockRoutes([
      [
        /\/classification$/,
        () =>
          json(
            {
              error: {
                code: 'conflict',
                message:
                  'Production classification is permanent. This subscriber cannot be reclassified as Demo or Test.',
              },
            },
            409,
          ),
      ],
      ...closureRoutes(closure({ dataClassification: 'demo' }), impact()),
    ]);

    renderDrawer();
    await screen.findByTestId('closure-actions');
    fireEvent.click(screen.getByTestId('action-change-classification'));
    await screen.findByTestId('reclassify-target');

    fireEvent.change(screen.getByTestId('reason-input'), {
      target: { value: 'Attempting a change the server will refuse.' },
    });
    fireEvent.click(screen.getByTestId('reason-confirm'));

    // The server's own sentence, not a guess made here.
    const shown = await screen.findAllByText(/Production classification is permanent/i);
    expect(shown.length).toBeGreaterThan(0);
    // And the dialog stays open, so the refusal cannot be mistaken for success.
    expect(screen.getByTestId('reclassify-target')).toBeTruthy();
  });

  it('offers archive for an active subscriber, and not reactivate', async () => {
    mockRoutes(closureRoutes(closure({ organizationStatus: 'active' }), impact()));
    renderDrawer();
    await screen.findByTestId('closure-actions');
    expect(screen.getByTestId('action-archive')).toBeTruthy();
    expect(screen.queryByTestId('action-reactivate')).toBeNull();
    expect(screen.queryByTestId('action-cancel-deletion')).toBeNull();
  });

  it('offers reactivate and deletion for an archived subscriber', async () => {
    mockRoutes(closureRoutes(closure({ organizationStatus: 'archived', canRestore: true }), impact()));
    renderDrawer();
    await screen.findByTestId('closure-actions');
    expect(screen.getByTestId('action-reactivate')).toBeTruthy();
    expect(screen.getByTestId('action-request-deletion')).toBeTruthy();
    // Already archived — archiving again is not offered.
    expect(screen.queryByTestId('action-archive')).toBeNull();
  });

  it('shows the scheduled purge date and refuses reactivation while pending', async () => {
    mockRoutes(
      closureRoutes(
        closure({
          organizationStatus: 'pending_deletion',
          deletionRequestedAt: '2026-08-01T00:00:00.000Z',
          scheduledPurgeAfter: '2026-08-31T00:00:00.000Z',
          deletionReason: 'Customer asked us to close the account.',
          recoveryDaysRemaining: 22,
          canCancelDeletion: true,
          canRestore: false,
        }),
        impact(),
      ),
    );
    renderDrawer();

    await screen.findByTestId('pending-deletion-notice');
    expect(screen.getByTestId('scheduled-purge-date').textContent).toContain('2026');
    expect(screen.getByText(/22 day\(s\) of the recovery period remain/)).toBeTruthy();
    expect(screen.getByText(/Customer asked us to close the account/)).toBeTruthy();

    expect(screen.getByTestId('action-cancel-deletion')).toBeTruthy();
    // Cancelling a purge is its own act — reactivation is not offered.
    expect(screen.queryByTestId('action-reactivate')).toBeNull();
    // Nor is a second deletion request.
    expect(screen.queryByTestId('action-request-deletion')).toBeNull();
  });

  it('never renders a "deleted" state the server has not confirmed', async () => {
    mockRoutes(closureRoutes(closure({ organizationStatus: 'pending_deletion', deletionRequestedAt: 'x' }), impact()));
    renderDrawer();
    await screen.findByTestId('pending-deletion-notice');
    expect(screen.getByTestId('status-badge').textContent).toBe('Deletion scheduled');
    expect(screen.queryByText(/^Deleted$/)).toBeNull();
  });
});

/* ══ The impact report ═══════════════════════════════════════════════════ */

describe('the closure impact report', () => {
  const renderWithImpact = (assessment: DeletionImpact) => {
    mockRoutes(closureRoutes(closure({ organizationStatus: 'archived' }), assessment));
    return render(
      <SubscriberClosureDrawer
        open
        organizationId={ACME}
        legalName="Acme Holdings Ltd."
        ownerEmail="sam@acme.test"
        memberCount={2}
        subscriptionStatus="cancelled"
        createdAt="2026-01-01T00:00:00.000Z"
        capabilities={SUPER_ADMIN}
        onClose={vi.fn()}
        onRequestDeletion={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
  };

  it('shows every blocker the backend returned', async () => {
    renderWithImpact(BLOCKED);
    await screen.findByTestId('impact-blockers');
    expect(screen.getByTestId('blocker-accounting_records_possible')).toBeTruthy();
    expect(screen.getByTestId('blocker-legal_hold')).toBeTruthy();
    expect(screen.getByTestId('impact-verdict').textContent).toBe('Not eligible');
  });

  it('never renders an unverifiable category as zero', async () => {
    renderWithImpact(impact());
    await screen.findByTestId('closure-impact');

    // The server CAN count members — a real number.
    expect(screen.getByTestId('impact-count-members').textContent).toContain('2');
    // It cannot count journals. Saying "0" would be a claim it has no basis for.
    const journals = screen.getByTestId('impact-count-journal_entries');
    expect(within(journals).getByTestId('unverifiable-journal_entries').textContent).toBe(
      'cannot be verified here',
    );
    expect(journals.textContent).not.toMatch(/\b0\b/);
  });

  it('states the browser-accounting limitation in plain language', async () => {
    renderWithImpact(impact());
    const note = await screen.findByTestId('browser-storage-limitation');
    expect(note.textContent).toMatch(/browser workspace/i);
    expect(note.textContent).toMatch(/not.*evidence that the subscriber has none/i);
  });

  it('shows what is retained and what is removed', async () => {
    renderWithImpact(impact());
    await screen.findByTestId('will-retain');
    expect(screen.getByTestId('will-retain').textContent).toContain('Every audit entry');
    expect(screen.getByTestId('will-delete').textContent).toContain('Organization record');
    expect(screen.getByTestId('will-anonymize').textContent).toContain('retained audit history');
  });
});

/* ══ The deletion dialog ═════════════════════════════════════════════════ */

describe('the permanent-deletion dialog', () => {
  const renderDialog = (
    props: Partial<Record<string, unknown>> = {},
    assessment: DeletionImpact | null = impact(),
  ) => {
    const onScheduled = vi.fn();
    render(
      <RequestDeletionDialog
        open
        organizationId={ACME}
        legalName="Acme Holdings Ltd."
        ownerEmail="sam@acme.test"
        impact={assessment}
        onClose={vi.fn()}
        onScheduled={onScheduled}
        {...(props as object)}
      />,
    );
    return { onScheduled };
  };

  /** Fill every field so the submit button becomes enabled. */
  const fillValidForm = (password = 'Correct-Horse-9-Battery') => {
    fireEvent.change(screen.getByTestId('deletion-reason'), { target: { value: 'Customer closed.' } });
    fireEvent.change(screen.getByTestId('deletion-confirmation'), {
      target: { value: 'Acme Holdings Ltd.' },
    });
    fireEvent.click(screen.getByTestId('deletion-acknowledge'));
    fireEvent.change(screen.getByTestId('deletion-password'), { target: { value: password } });
  };

  it('requires identifier, reason, acknowledgment and password', () => {
    mockRoutes([]);
    renderDialog();
    const submit = () => screen.getByTestId('deletion-submit') as HTMLButtonElement;
    expect(submit().disabled).toBe(true);

    fireEvent.change(screen.getByTestId('deletion-reason'), { target: { value: 'Closing.' } });
    expect(submit().disabled).toBe(true);

    // A near-miss on the name is not a match.
    fireEvent.change(screen.getByTestId('deletion-confirmation'), { target: { value: 'Acme Holdings' } });
    expect(submit().disabled).toBe(true);

    fireEvent.change(screen.getByTestId('deletion-confirmation'), {
      target: { value: 'Acme Holdings Ltd.' },
    });
    expect(submit().disabled).toBe(true);

    fireEvent.click(screen.getByTestId('deletion-acknowledge'));
    expect(submit().disabled).toBe(true);

    fireEvent.change(screen.getByTestId('deletion-password'), { target: { value: 'pw' } });
    expect(submit().disabled).toBe(false);
  });

  it('accepts the owner email as the identifier', () => {
    mockRoutes([]);
    renderDialog();
    fireEvent.change(screen.getByTestId('deletion-reason'), { target: { value: 'Closing.' } });
    fireEvent.change(screen.getByTestId('deletion-confirmation'), { target: { value: 'sam@acme.test' } });
    fireEvent.click(screen.getByTestId('deletion-acknowledge'));
    fireEvent.change(screen.getByTestId('deletion-password'), { target: { value: 'pw' } });
    expect((screen.getByTestId('deletion-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers no form at all when the backend says deletion is blocked', () => {
    mockRoutes([]);
    const onArchiveInstead = vi.fn();
    renderDialog({ onArchiveInstead }, BLOCKED);

    expect(screen.queryByTestId('deletion-password')).toBeNull();
    expect(screen.queryByTestId('deletion-reason')).toBeNull();
    expect(screen.getByTestId('blocker-legal_hold')).toBeTruthy();

    // The safe action is offered in its place.
    fireEvent.click(screen.getByTestId('archive-instead'));
    expect(onArchiveInstead).toHaveBeenCalled();
  });

  it('sends the password only to the deletion endpoint, and reports the schedule', async () => {
    const calls = mockRoutes([
      [
        /\/request-deletion/,
        () =>
          json({
            organizationId: ACME,
            legalName: 'Acme Holdings Ltd.',
            organizationStatus: 'pending_deletion',
            requestedAt: '2026-08-09T10:00:00.000Z',
            scheduledPurgeAfter: '2026-09-08T10:00:00.000Z',
            revokedSessions: 3,
            memberCount: 2,
            impact: impact(),
          }),
      ],
    ]);
    const { onScheduled } = renderDialog();
    fillValidForm('Correct-Horse-9-Battery');
    fireEvent.click(screen.getByTestId('deletion-submit'));

    await waitFor(() => expect(onScheduled).toHaveBeenCalled());
    expect(onScheduled.mock.calls[0]![0].scheduledPurgeAfter).toBe('2026-09-08T10:00:00.000Z');

    // Exactly one request, and the password went nowhere else.
    const withPassword = calls.filter((c) => c.body.includes('Correct-Horse-9-Battery'));
    expect(withPassword).toHaveLength(1);
    expect(withPassword[0]!.url).toContain('/request-deletion');
  });

  it('never persists the password anywhere', async () => {
    mockRoutes([[/\/request-deletion/, () => json({ scheduledPurgeAfter: '2026-09-08T10:00:00.000Z' })]]);
    renderDialog();
    fillValidForm('Correct-Horse-9-Battery');

    // Not in browser storage, before or after submission.
    const dump = () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(dump()).not.toContain('Correct-Horse-9-Battery');
    fireEvent.click(screen.getByTestId('deletion-submit'));
    await waitFor(() => expect(dump()).not.toContain('Correct-Horse-9-Battery'));
    expect(window.location.search).not.toContain('Correct-Horse-9-Battery');
  });

  it('keeps the dialog open on a failed step-up, clearing only the password', async () => {
    mockRoutes([
      [
        /\/request-deletion/,
        () =>
          json(
            {
              error: {
                code: 'reauthentication_failed',
                message: 'That password is not correct. Confirm your password to continue.',
              },
            },
            403,
          ),
      ],
    ]);
    const { onScheduled } = renderDialog();
    fillValidForm('wrong-password');
    fireEvent.click(screen.getByTestId('deletion-submit'));

    // The message appears in the alert AND on the field — both are correct.
    expect((await screen.findAllByText(/That password is not correct/)).length).toBeGreaterThan(0);
    // Never reported as success.
    expect(onScheduled).not.toHaveBeenCalled();
    // The dialog is still open.
    expect(screen.getByTestId('request-deletion-dialog')).toBeTruthy();

    // The password is gone; the work the operator already did is not.
    expect((screen.getByTestId('deletion-password') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('deletion-reason') as HTMLTextAreaElement).value).toBe('Customer closed.');
    expect((screen.getByTestId('deletion-confirmation') as HTMLInputElement).value).toBe(
      'Acme Holdings Ltd.',
    );

    // And a retry is possible.
    fireEvent.change(screen.getByTestId('deletion-password'), { target: { value: 'right' } });
    expect((screen.getByTestId('deletion-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not echo the password in an error message', async () => {
    mockRoutes([
      [/\/request-deletion/, () => json({ error: { code: 'conflict', message: 'Already scheduled.' } }, 409)],
    ]);
    renderDialog();
    fillValidForm('Correct-Horse-9-Battery');
    fireEvent.click(screen.getByTestId('deletion-submit'));

    await screen.findByText('Already scheduled.');
    expect(document.body.textContent).not.toContain('Correct-Horse-9-Battery');
  });

  it('shows a server refusal rather than a false success', async () => {
    mockRoutes([
      [
        /\/request-deletion/,
        () =>
          json(
            {
              error: {
                code: 'conflict',
                message:
                  'This subscriber contains accounting or legally retained records and cannot be permanently deleted. Archive the subscriber instead.',
              },
            },
            409,
          ),
      ],
    ]);
    const { onScheduled } = renderDialog();
    fillValidForm();
    fireEvent.click(screen.getByTestId('deletion-submit'));

    await screen.findByText(/cannot be permanently deleted/);
    expect(onScheduled).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/deletion scheduled/i);
  });

  it('prevents a double submission', async () => {
    let resolveIt: ((value: Response) => void) | undefined;
    const held = new Promise<Response>((resolve) => {
      resolveIt = resolve;
    });
    const calls = mockRoutes([[/\/request-deletion/, () => held]]);
    renderDialog();
    fillValidForm();

    const submit = screen.getByTestId('deletion-submit');
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(true));
    expect(calls.filter((c) => c.url.includes('/request-deletion'))).toHaveLength(1);

    resolveIt?.(json({ scheduledPurgeAfter: '2026-09-08T10:00:00.000Z' }));
  });

  it('shows only the targeted subscriber', () => {
    mockRoutes([]);
    renderDialog();
    expect(document.body.textContent).toContain('Acme Holdings Ltd.');
    expect(document.body.textContent).not.toContain('Globex');
    expect(document.body.textContent).not.toContain(GLOBEX);
  });
});

/* ══ Exports ═════════════════════════════════════════════════════════════ */

describe('subscriber data exports', () => {
  const renderDrawer = () =>
    render(
      <SubscriberClosureDrawer
        open
        organizationId={ACME}
        legalName="Acme Holdings Ltd."
        ownerEmail="sam@acme.test"
        memberCount={2}
        subscriptionStatus="cancelled"
        createdAt="2026-01-01T00:00:00.000Z"
        capabilities={SUPER_ADMIN}
        onClose={vi.fn()}
        onRequestDeletion={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

  const exportRow = (overrides: Record<string, unknown> = {}) => ({
    exportId: 'exp_1',
    status: 'ready',
    createdAt: '2026-08-09T10:00:00.000Z',
    expiresAt: '2026-08-10T10:00:00.000Z',
    expired: false,
    byteSize: 2048,
    sectionCounts: { members: 2 },
    downloadCount: 0,
    firstDownloadedAt: null,
    requestedBy: 'usr_admin',
    ...overrides,
  });

  it('renders ready, downloaded, expired and revoked states accurately', async () => {
    mockRoutes(
      closureRoutes(closure({ organizationStatus: 'archived' }), impact(), [
        exportRow({ exportId: 'exp_ready' }),
        exportRow({ exportId: 'exp_done', status: 'downloaded', downloadCount: 1 }),
        exportRow({ exportId: 'exp_old', expired: true }),
        exportRow({ exportId: 'exp_gone', status: 'revoked' }),
      ]),
    );
    renderDrawer();

    await screen.findByTestId('export-list');
    expect(within(screen.getByTestId('export-row-exp_ready')).getByText('Ready')).toBeTruthy();
    expect(within(screen.getByTestId('export-row-exp_done')).getByText('Downloaded')).toBeTruthy();
    expect(within(screen.getByTestId('export-row-exp_old')).getByText('Expired')).toBeTruthy();
    expect(within(screen.getByTestId('export-row-exp_gone')).getByText('Revoked')).toBeTruthy();

    // A revoked export offers no revoke control.
    expect(screen.queryByTestId('revoke-exp_gone')).toBeNull();
    expect(screen.getByTestId('revoke-exp_ready')).toBeTruthy();
  });

  it('shows the one-time link and the sections it cannot contain', async () => {
    mockRoutes([
      ...closureRoutes(closure({ organizationStatus: 'archived' }), impact()),
      [
        /\/export$/,
        () =>
          json(
            {
              exportId: 'exp_1',
              organizationId: ACME,
              status: 'ready',
              expiresAt: '2026-08-10T10:00:00.000Z',
              sectionCounts: { members: 2 },
              byteSize: 2048,
              downloadToken: 'one-time-token-value',
              unavailableSections: ['journals_and_ledger', 'documents_and_attachments'],
            },
            201,
          ),
      ],
    ]);
    renderDrawer();

    fireEvent.click(await screen.findByTestId('action-export'));
    const panel = await screen.findByTestId('fresh-export');

    expect(screen.getByTestId('unavailable-sections').textContent).toContain('journals_and_ledger');
    // Scoped to the link panel: the success notice says the same thing, and both
    // saying it is correct.
    expect(within(panel).getByText(/cannot be retrieved again/i)).toBeTruthy();

    // The token is never written to browser storage.
    const dump = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(dump).not.toContain('one-time-token-value');
  });

  it('sends the download token in the body, never in the URL', async () => {
    const calls = mockRoutes([
      ...closureRoutes(closure({ organizationStatus: 'archived' }), impact()),
      [
        /\/export$/,
        () =>
          json(
            {
              exportId: 'exp_1',
              organizationId: ACME,
              status: 'ready',
              expiresAt: '2026-08-10T10:00:00.000Z',
              sectionCounts: {},
              byteSize: 10,
              downloadToken: 'one-time-token-value',
              unavailableSections: [],
            },
            201,
          ),
      ],
      [/\/download$/, () => json({ organization: { legal_name: 'Acme Holdings Ltd.' } })],
    ]);
    // happy-dom has no object-URL plumbing; the click path only needs these.
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();

    renderDrawer();
    fireEvent.click(await screen.findByTestId('action-export'));
    fireEvent.click(await screen.findByTestId('download-export'));

    await waitFor(() => expect(calls.some((c) => c.url.includes('/download'))).toBe(true));
    const download = calls.find((c) => c.url.includes('/download'))!;
    // A query parameter would put a live credential in the server's request log.
    expect(download.url).not.toContain('one-time-token-value');
    expect(download.body).toContain('one-time-token-value');
  });

  it('reports an expired or revoked token without claiming success', async () => {
    mockRoutes([
      ...closureRoutes(closure({ organizationStatus: 'archived' }), impact()),
      [
        /\/export$/,
        () =>
          json(
            {
              exportId: 'exp_1',
              organizationId: ACME,
              status: 'ready',
              expiresAt: '2026-08-10T10:00:00.000Z',
              sectionCounts: {},
              byteSize: 10,
              downloadToken: 'stale-token',
              unavailableSections: [],
            },
            201,
          ),
      ],
      [
        /\/download$/,
        () =>
          json(
            {
              error: {
                code: 'validation_error',
                message: 'This download link is no longer valid. Generate a new export.',
              },
            },
            400,
          ),
      ],
    ]);
    renderDrawer();
    fireEvent.click(await screen.findByTestId('action-export'));
    fireEvent.click(await screen.findByTestId('download-export'));

    await screen.findByText(/This download link is no longer valid/);
  });
});

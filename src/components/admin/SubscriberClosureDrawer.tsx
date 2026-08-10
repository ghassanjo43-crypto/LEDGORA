/**
 * "Manage account closure" — the drawer behind the subscriber action menu.
 *
 * One place holding the four things an operator needs to close an account
 * safely: the current lifecycle state, the server's eligibility assessment, the
 * data exports, and the actions that are legitimately available right now.
 *
 * ── Lifecycle drives the actions ─────────────────────────────────────────────
 *   active / suspended  → archive, export
 *   archived            → reactivate, request deletion, export
 *   pending_deletion    → cancel deletion, export        (never reactivate)
 *
 * Reactivation is deliberately absent while a deletion is pending: cancelling a
 * purge is its own deliberate act and must not happen as a side effect of
 * clicking "restore". The server refuses it too — this is the courtesy, not the
 * control.
 *
 * ── Nothing here is authorization ────────────────────────────────────────────
 * The capability list only decides which controls are OFFERED. Every route
 * re-checks its own capability against the database-backed session, so a client
 * that ignored this would simply collect 403s.
 *
 * ── The download token ───────────────────────────────────────────────────────
 * `createExport` returns it exactly once. It is held in local component state
 * for the life of one dialog, used to fetch the payload, and dropped. It never
 * reaches a store, `localStorage`, a URL or a log.
 */
import { useCallback, useEffect, useState } from 'react';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { ApiError } from '@/services/api/client';
import { adminSubscriberApi, type PlatformCapabilityName } from '@/services/api/adminConsoleApi';
import {
  subscriberClosureApi,
  type ClosureStatus,
  type CreatedExport,
  type DeletionImpact,
  type ExportSummary,
} from '@/services/api/closureApi';
import { ClosureImpactReport } from './ClosureImpactReport';
import { ReasonPromptDialog } from './ReasonPromptDialog';

/** Statuses the console understands. `archived` is the backend's own value. */
export const ARCHIVED_STATUSES = new Set(['archived', 'closed']);

export interface SubscriberClosureDrawerProps {
  open: boolean;
  organizationId: string;
  legalName: string;
  ownerEmail: string | null;
  memberCount: number;
  subscriptionStatus: string | null;
  createdAt: string | null;
  capabilities: PlatformCapabilityName[];
  onClose: () => void;
  /** Opens the separate step-up dialog, which needs the impact report. */
  onRequestDeletion: (impact: DeletionImpact | null, impactError: string | null) => void;
  /** Something changed server-side; the caller reloads its roster. */
  onChanged: (message: string) => void;
}

type PendingAction = {
  title: string;
  description: string;
  confirmLabel: string;
  destructive: boolean;
  run: (reason: string) => Promise<string>;
};

export function SubscriberClosureDrawer({
  open,
  organizationId,
  legalName,
  ownerEmail,
  memberCount,
  subscriptionStatus,
  createdAt,
  capabilities,
  onClose,
  onRequestDeletion,
  onChanged,
}: SubscriberClosureDrawerProps) {
  const [closure, setClosure] = useState<ClosureStatus | null>(null);
  const [impact, setImpact] = useState<DeletionImpact | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [exports, setExports] = useState<ExportSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** The one-time export credential. Local state only — see the module note. */
  const [freshExport, setFreshExport] = useState<CreatedExport | null>(null);

  const canArchive = capabilities.includes('subscribers.archive');
  const canRequestDeletion = capabilities.includes('subscribers.request_deletion');
  const canExport = capabilities.includes('subscribers.export');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const status = await subscriberClosureApi.status(organizationId, signal);
        setClosure(status.closure);

        // The impact is the authoritative verdict and is always refetched.
        try {
          const assessment = await subscriberClosureApi.impact(organizationId, signal);
          setImpact(assessment.impact);
          setImpactError(null);
        } catch (caught) {
          if ((caught as { name?: string }).name === 'AbortError') return;
          setImpact(null);
          setImpactError(caught instanceof ApiError ? caught.message : 'The assessment could not be loaded.');
        }

        if (canExport) {
          try {
            setExports((await subscriberClosureApi.listExports(organizationId, signal)).exports);
          } catch {
            // A failed export listing must not hide the closure state.
            setExports([]);
          }
        }
      } catch (caught) {
        if ((caught as { name?: string }).name === 'AbortError') return;
        setError(caught instanceof ApiError ? caught.message : 'The closure status could not be loaded.');
      } finally {
        setLoading(false);
      }
    },
    [organizationId, canExport],
  );

  useEffect(() => {
    if (!open) {
      // The one-time token does not survive the drawer closing.
      setFreshExport(null);
      return;
    }
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [open, load]);

  const runPending = async (reason: string): Promise<void> => {
    if (!pending || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const message = await pending.run(reason);
      setPending(null);
      setNotice(message);
      // Re-read from the server rather than guessing the new state locally.
      await load();
      onChanged(message);
    } catch (caught) {
      // The server's own wording, kept visible. Never a false success.
      setActionError(caught instanceof ApiError ? caught.message : 'The action could not be completed.');
    } finally {
      setBusy(false);
    }
  };

  const status = closure?.organizationStatus ?? '';
  const pendingDeletion = Boolean(closure?.deletionRequestedAt);
  const archived = ARCHIVED_STATUSES.has(status);

  const createExport = async (): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      const created = await subscriberClosureApi.createExport(organizationId);
      setFreshExport(created);
      setNotice('Export generated. The download link is shown once and cannot be retrieved again.');
      setExports((await subscriberClosureApi.listExports(organizationId)).exports);
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : 'The export could not be generated.');
    } finally {
      setBusy(false);
    }
  };

  /** Fetch the payload with the one-time token and hand it to the browser. */
  const download = async (): Promise<void> => {
    if (!freshExport) return;
    setBusy(true);
    setActionError(null);
    try {
      const payload = await subscriberClosureApi.download(
        organizationId,
        freshExport.exportId,
        freshExport.downloadToken,
      );
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `ledgora-export-${legalName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setExports((await subscriberClosureApi.listExports(organizationId)).exports);
      setNotice('Export downloaded.');
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : 'The download failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        widthClassName="max-w-4xl"
        title={`Account closure — ${legalName}`}
        description="Deactivating and archiving is the normal way to close an account. Permanent deletion is available only when every legal, accounting and billing condition permits it."
      >
        <div className="space-y-4">
          {error && <Alert variant="error">{error}</Alert>}
          {actionError && (
            <Alert variant="error" onClose={() => setActionError(null)} title="Could not complete">
              {actionError}
            </Alert>
          )}
          {notice && (
            <Alert variant="success" onClose={() => setNotice(null)}>
              <span data-testid="closure-notice">{notice}</span>
            </Alert>
          )}

          {loading && <p className="text-sm text-slate-500">Loading closure status…</p>}

          {closure && (
            <>
              {/* ── Identity and lifecycle ─────────────────────────────── */}
              <div className="grid gap-2 rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-700 sm:grid-cols-2">
                <Fact label="Organization">{closure.legalName}</Fact>
                <Fact label="Organization ID">
                  <code className="text-[11px]">{closure.organizationId}</code>
                </Fact>
                <Fact label="Owner">{ownerEmail ?? '—'}</Fact>
                <Fact label="Members">{memberCount}</Fact>
                <Fact label="Subscription">{subscriptionStatus ?? 'none'}</Fact>
                <Fact label="Created">{createdAt ? new Date(createdAt).toLocaleDateString() : '—'}</Fact>
                <Fact label="Account status">
                  <StatusBadge status={status} pendingDeletion={pendingDeletion} />
                </Fact>
                {closure.archivedAt && (
                  <Fact label="Archived">{new Date(closure.archivedAt).toLocaleString()}</Fact>
                )}
              </div>

              {closure.legalHold && (
                <Alert variant="warning" title="Legal hold in force">
                  {closure.legalHoldReason ?? 'This subscriber is under a legal hold.'} No deletion is
                  permitted until the hold is lifted.
                </Alert>
              )}

              {/* ── Pending deletion ───────────────────────────────────── */}
              {pendingDeletion && (
                <div data-testid="pending-deletion-notice">
                <Alert variant="error" title="Deletion scheduled">
                  <ul className="space-y-1">
                    <li>
                      Purge permitted after{' '}
                      <span className="font-semibold" data-testid="scheduled-purge-date">
                        {closure.scheduledPurgeAfter
                          ? new Date(closure.scheduledPurgeAfter).toLocaleString()
                          : 'unknown'}
                      </span>
                      {closure.recoveryDaysRemaining !== null && (
                        <> — {closure.recoveryDaysRemaining} day(s) of the recovery period remain.</>
                      )}
                    </li>
                    {closure.deletionReason && <li>Reason: {closure.deletionReason}</li>}
                    <li>
                      The subscriber remains inaccessible throughout. Nothing has been destroyed, and
                      cancelling returns the account to <span className="font-semibold">archived</span>.
                    </li>
                  </ul>
                </Alert>
                </div>
              )}

              {/* ── Actions, by lifecycle state ────────────────────────── */}
              <div className="flex flex-wrap gap-2" data-testid="closure-actions">
                {canArchive && !archived && !pendingDeletion && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    data-testid="action-archive"
                    onClick={() =>
                      setPending({
                        title: `Deactivate and archive ${legalName}`,
                        description:
                          'Access stops immediately and every member is signed out. The subscription is cancelled and the entitlement withdrawn. Every record is retained — archiving is not deletion — and the account can be restored later.',
                        confirmLabel: 'Archive account',
                        destructive: true,
                        // The EXISTING archive endpoint — this drawer adds no
                        // second way to close an account.
                        run: async (reason) => {
                          const result = await adminSubscriberApi.setStatus(
                            organizationId,
                            'archive',
                            reason,
                          );
                          return `${legalName}: account ${result.organizationStatus}, subscription ${
                            result.subscriptionStatus ?? 'none'
                          }. Members are signed out; every record is retained.`;
                        },
                      })
                    }
                  >
                    Deactivate and archive
                  </Button>
                )}

                {canArchive && archived && !pendingDeletion && closure.canRestore && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    data-testid="action-reactivate"
                    onClick={() =>
                      setPending({
                        title: `Reactivate ${legalName}`,
                        description:
                          'The account returns to active. A subscription that was cancelled on archival comes back as pending payment rather than active, so no entitlement is invented — and members must sign in again. Integrations and scheduled jobs are not restored automatically.',
                        confirmLabel: 'Reactivate account',
                        destructive: false,
                        run: async (reason) => {
                          const result = await subscriberClosureApi.reactivate(organizationId, reason);
                          return `${legalName}: account ${result.organizationStatus}, subscription ${
                            result.subscriptionStatus ?? 'none'
                          }. Members must sign in again.`;
                        },
                      })
                    }
                  >
                    Reactivate
                  </Button>
                )}

                {canRequestDeletion && pendingDeletion && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    data-testid="action-cancel-deletion"
                    onClick={() =>
                      setPending({
                        title: `Cancel the scheduled deletion of ${legalName}`,
                        description:
                          'The purge is cancelled and the account returns to archived — not to active. Re-opening the account for the customer is a separate action.',
                        confirmLabel: 'Cancel deletion',
                        destructive: false,
                        run: async (reason) => {
                          const result = await subscriberClosureApi.cancelDeletion(organizationId, reason);
                          return `Deletion cancelled. ${legalName} is now ${result.organizationStatus}.`;
                        },
                      })
                    }
                  >
                    Cancel scheduled deletion
                  </Button>
                )}

                {canRequestDeletion && !pendingDeletion && (
                  <Button
                    variant="danger"
                    disabled={busy}
                    data-testid="action-request-deletion"
                    onClick={() => onRequestDeletion(impact, impactError)}
                  >
                    Request permanent deletion
                  </Button>
                )}

                {canExport && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    data-testid="action-export"
                    onClick={() => void createExport()}
                  >
                    {busy ? 'Working…' : 'Export subscriber data'}
                  </Button>
                )}
              </div>

              {/* ── The one-time download link ─────────────────────────── */}
              {freshExport && (
                <div data-testid="fresh-export">
                <Alert variant="warning" title="Download link — shown once">
                  <p>
                    This link cannot be retrieved again. It expires{' '}
                    {new Date(freshExport.expiresAt).toLocaleString()}.
                  </p>
                  <p className="mt-1 text-xs">
                    Sections not included:{' '}
                    <span data-testid="unavailable-sections">
                      {freshExport.unavailableSections.join(', ')}
                    </span>{' '}
                    — these live in the customer&rsquo;s browser workspace and are not on the server.
                  </p>
                  <Button size="sm" className="mt-2" onClick={() => void download()} data-testid="download-export">
                    Download now
                  </Button>
                </Alert>
                </div>
              )}

              {/* ── Export history ─────────────────────────────────────── */}
              {canExport && exports.length > 0 && (
                <div
                  className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700"
                  data-testid="export-list"
                >
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 dark:bg-slate-800">
                      <tr>
                        <th className="px-3 py-2 text-left">Created</th>
                        <th className="px-3 py-2 text-left">State</th>
                        <th className="px-3 py-2 text-left">Expires</th>
                        <th className="px-3 py-2 text-right">Downloads</th>
                        <th className="px-3 py-2 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {exports.map((item) => (
                        <tr
                          key={item.exportId}
                          className="border-t border-slate-100 dark:border-slate-800"
                          data-testid={`export-row-${item.exportId}`}
                        >
                          <td className="px-3 py-1.5">{new Date(item.createdAt).toLocaleString()}</td>
                          <td className="px-3 py-1.5">
                            <ExportStateBadge item={item} />
                          </td>
                          <td className="px-3 py-1.5">{new Date(item.expiresAt).toLocaleString()}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{item.downloadCount}</td>
                          <td className="px-3 py-1.5 text-right">
                            {item.status !== 'revoked' && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                data-testid={`revoke-${item.exportId}`}
                                onClick={() =>
                                  setPending({
                                    title: 'Withdraw this export',
                                    description:
                                      'The download link stops working and the stored copy of the data is destroyed.',
                                    confirmLabel: 'Withdraw export',
                                    destructive: true,
                                    run: async (reason) => {
                                      await subscriberClosureApi.revokeExport(
                                        organizationId,
                                        item.exportId,
                                        reason,
                                      );
                                      setExports(
                                        (await subscriberClosureApi.listExports(organizationId)).exports,
                                      );
                                      return 'Export withdrawn and its stored copy destroyed.';
                                    },
                                  })
                                }
                              >
                                Revoke
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* ── The assessment ─────────────────────────────────────── */}
              {impactError && (
                <Alert variant="error" title="The eligibility assessment could not be loaded">
                  {impactError}
                </Alert>
              )}
              {impact && <ClosureImpactReport impact={impact} />}
            </>
          )}
        </div>
      </Drawer>

      <ReasonPromptDialog
        open={pending !== null}
        title={pending?.title ?? ''}
        description={pending?.description ?? ''}
        confirmLabel={pending?.confirmLabel}
        destructive={pending?.destructive}
        busy={busy}
        error={actionError}
        onConfirm={(reason) => void runPending(reason)}
        onCancel={() => {
          setPending(null);
          setActionError(null);
        }}
      />
    </>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-slate-700 dark:text-slate-200">{children}</div>
    </div>
  );
}

/**
 * The lifecycle badge.
 *
 * "Deleted" is deliberately absent: a purged subscriber has no row to render, so
 * this component can only ever show states the server has actually confirmed.
 */
export function StatusBadge({ status, pendingDeletion }: { status: string; pendingDeletion: boolean }) {
  if (pendingDeletion || status === 'pending_deletion') {
    return (
      <span data-testid="status-badge">
        <Badge tone="red">Deletion scheduled</Badge>
      </span>
    );
  }
  if (ARCHIVED_STATUSES.has(status)) {
    return (
      <span data-testid="status-badge">
        <Badge tone="amber">Archived</Badge>
      </span>
    );
  }
  if (status === 'suspended') {
    return (
      <span data-testid="status-badge">
        <Badge tone="amber">Suspended</Badge>
      </span>
    );
  }
  return (
    <span data-testid="status-badge">
      <Badge tone="green">Active</Badge>
    </span>
  );
}

function ExportStateBadge({ item }: { item: ExportSummary }) {
  if (item.status === 'revoked') return <Badge tone="red">Revoked</Badge>;
  if (item.status === 'failed') return <Badge tone="red">Failed</Badge>;
  // Expiry is a fact about time, and outranks a stale stored status.
  if (item.expired) return <Badge tone="slate">Expired</Badge>;
  if (item.status === 'downloaded') return <Badge tone="blue">Downloaded</Badge>;
  return <Badge tone="green">Ready</Badge>;
}

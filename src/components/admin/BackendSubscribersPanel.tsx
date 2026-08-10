/**
 * Subscribers, served by the LEDGORA account service.
 *
 * This is the multi-tenant roster the browser-only panel could never be: every
 * organization, its plan, status, renewal date, seat usage, owner and outstanding
 * payment, from `/api/admin/subscribers`. The demo-mode panel (see
 * `SubscribersPanel`) remains for builds with no backend, where a single retained
 * organization really is all the data there is.
 *
 * ── Actions ──────────────────────────────────────────────────────────────────
 * Activate, suspend, archive and restore all require a written reason and are
 * audited server-side; none of them delete anything. Assigning a package and
 * changing the owner open their own dialogs. "Open workspace" and "View exactly as
 * subscriber" hand off to the existing operator-view machinery, which is
 * unchanged — including its rule that the roster of a previously viewed subscriber
 * is discarded before a new context is set.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, RefreshCw, Search, UserPlus } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import type { BadgeTone } from '@/data/ifrsOptions';
import { useOperatorViewStore } from '@/store/operatorViewStore';
import { useMemberDirectoryStore } from '@/store/memberDirectoryStore';
import { useRouterStore } from '@/store/routerStore';
import { ROUTES } from '@/lib/accessControl';
import {
  adminSubscriberApi,
  type AdminSubscriberQuery,
  type AdminSubscriberRow,
  type PlatformCapabilityName,
} from '@/services/api/adminConsoleApi';
import { ApiError } from '@/services/api/client';
import { requestKeyOf, useAdminSubscriberStore } from '@/store/adminConsoleStores';
import { ReasonPromptDialog } from './ReasonPromptDialog';
import { SubscriberClosureDrawer, ARCHIVED_STATUSES, StatusBadge } from './SubscriberClosureDrawer';
import { SubscriberMembersDrawer } from './SubscriberMembersDrawer';
import { RequestDeletionDialog } from './RequestDeletionDialog';
import type { DeletionImpact } from '@/services/api/closureApi';

const PAGE_SIZE = 25;

const ORG_STATUS_FILTERS = [
  { value: 'all', label: 'Any account status' },
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
  // The backend archives to `archived`; `closed` predates it and is kept so
  // existing rows stay selectable.
  { value: 'archived', label: 'Archived' },
  { value: 'pending_deletion', label: 'Deletion scheduled' },
  { value: 'closed', label: 'Closed (legacy)' },
];

const SUBSCRIPTION_FILTERS = [
  { value: 'all', label: 'Any subscription' },
  { value: 'active', label: 'Active' },
  { value: 'pending_payment', label: 'Pending payment' },
  { value: 'pending_verification', label: 'Pending verification' },
  { value: 'past_due', label: 'Past due' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'none', label: 'No subscription' },
];

const SORT_OPTIONS = [
  { value: 'created_at', label: 'Created date' },
  { value: 'legal_name', label: 'Organization' },
  { value: 'plan_code', label: 'Plan' },
  { value: 'subscription_status', label: 'Subscription status' },
  { value: 'renews_at', label: 'Renewal date' },
  { value: 'seats_used', label: 'Seats used' },
  { value: 'status', label: 'Account status' },
];

const SUBSCRIPTION_TONES: Record<string, BadgeTone> = {
  active: 'green',
  past_due: 'amber',
  pending_payment: 'amber',
  pending_verification: 'violet',
  suspended: 'red',
  cancelled: 'slate',
  expired: 'slate',
  rejected: 'red',
  draft: 'slate',
};

const shortDate = (value: string | null): string => (value ? new Date(value).toISOString().slice(0, 10) : '—');

interface PendingAction {
  title: string;
  description: string;
  confirmLabel: string;
  destructive: boolean;
  run: (reason: string) => Promise<string>;
}

export interface BackendSubscribersPanelProps {
  capabilities: PlatformCapabilityName[];
  onAddSubscriber: () => void;
  onAssignPackage: (organizationId: string, organizationName: string) => void;
  /** Open the Members tab scoped to this subscriber. */
  onViewMembers: (organizationId: string, organizationName: string) => void;
  /**
   * Open the cleanup console focused on one subscriber. Deliberately a
   * navigation, not a delete: a single click must never destroy a tenant, so the
   * row action can only take the operator to the preview-and-confirm flow.
   */
  onCleanUp?: (organizationId: string) => void;
}

export function BackendSubscribersPanel({
  capabilities,
  onAddSubscriber,
  onAssignPackage,
  onViewMembers,
  onCleanUp,
}: BackendSubscribersPanelProps) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [orgStatus, setOrgStatus] = useState('all');
  const [subscriptionStatus, setSubscriptionStatus] = useState('all');
  const [sort, setSort] = useState<NonNullable<AdminSubscriberQuery['sort']>>('created_at');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);

  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** The subscriber whose closure drawer is open, if any. */
  const [closureTarget, setClosureTarget] = useState<AdminSubscriberRow | null>(null);
  /**
   * The subscriber whose members are being managed.
   *
   * A FIRST-CLASS action, deliberately not inside the closure drawer: inviting a
   * colleague is routine work and must not be reachable only through the most
   * destructive surface in the console.
   */
  const [membersTarget, setMembersTarget] = useState<AdminSubscriberRow | null>(null);
  /**
   * The step-up deletion dialog. Held beside the drawer rather than inside it so
   * closing the drawer cannot unmount the dialog mid-submission.
   */
  const [deletionTarget, setDeletionTarget] = useState<{
    row: AdminSubscriberRow;
    impact: DeletionImpact | null;
    impactError: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const load = useAdminSubscriberStore((s) => s.load);
  const status = useAdminSubscriberStore((s) => s.status);
  const loadedKey = useAdminSubscriberStore((s) => s.loadedKey);
  const subscribers = useAdminSubscriberStore((s) => s.subscribers);
  const pagination = useAdminSubscriberStore((s) => s.pagination);
  const listError = useAdminSubscriberStore((s) => s.error);

  const enterSubscriberView = useOperatorViewStore((s) => s.enter);
  const navigate = useRouterStore((s) => s.navigate);

  const can = useMemo(
    () => ({
      create: capabilities.includes('subscribers.create'),
      manage: capabilities.includes('subscribers.manage'),
      assign: capabilities.includes('subscriptions.assign'),
    }),
    [capabilities],
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const query = useMemo<AdminSubscriberQuery>(
    () => ({
      ...(search ? { search } : {}),
      ...(orgStatus !== 'all' ? { status: orgStatus } : {}),
      ...(subscriptionStatus !== 'all' ? { subscriptionStatus } : {}),
      sort,
      direction,
      limit: PAGE_SIZE,
      offset,
    }),
    [search, orgStatus, subscriptionStatus, sort, direction, offset],
  );

  const queryKey = useMemo(() => requestKeyOf(query as Record<string, unknown>), [query]);

  useEffect(() => {
    void load(query);
  }, [load, query]);

  // Only render contents that belong to the query being asked for right now.
  const fresh = loadedKey === queryKey;
  const rows = fresh ? subscribers : [];
  const total = fresh ? pagination.total : 0;
  /**
   * Two different questions, deliberately not conflated:
   *  `loading`  — a request is in flight, so paging controls should be inert;
   *  `awaiting` — there is nothing trustworthy to render yet (either loading, or
   *               the store holds another query's contents).
   * Disabling Refresh on `awaiting` would strand a failed load forever: the
   * contents never become fresh, so the retry control would never re-enable.
   */
  const loading = status === 'loading';
  const awaiting = loading || !fresh;

  const refresh = useCallback(() => load(query), [load, query]);

  const runPending = async (reason: string): Promise<void> => {
    if (!pending) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const message = await pending.run(reason);
      setPending(null);
      setNotice(message);
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : 'The action failed.');
    } finally {
      setBusy(false);
    }
  };

  const lifecycle = (row: AdminSubscriberRow, action: 'activate' | 'suspend' | 'archive' | 'restore'): void => {
    const copy: Record<typeof action, { title: string; description: string; confirm: string; destructive: boolean }> = {
      activate: {
        title: `Activate ${row.legalName}`,
        description:
          'The account and its subscription become active, so the customer can save records permanently. Use this only when payment is genuinely settled — it bypasses the payment workflow.',
        confirm: 'Activate account',
        destructive: false,
      },
      suspend: {
        title: `Suspend ${row.legalName}`,
        description:
          'The customer keeps their data but loses access to paid functionality and can no longer save records. Nothing is deleted, and you can restore the account at any time.',
        confirm: 'Suspend account',
        destructive: true,
      },
      archive: {
        title: `Archive ${row.legalName}`,
        description:
          'The account is closed and the subscription cancelled. Every record is retained — archiving is not deletion — and the account can be restored later.',
        confirm: 'Archive account',
        destructive: true,
      },
      restore: {
        title: `Restore ${row.legalName}`,
        description:
          'The account returns to active. A subscription that was never paid for comes back as pending payment rather than active, so no entitlement is invented.',
        confirm: 'Restore account',
        destructive: false,
      },
    };
    const chosen = copy[action];
    setPending({
      title: chosen.title,
      description: chosen.description,
      confirmLabel: chosen.confirm,
      destructive: chosen.destructive,
      run: async (reason) => {
        const result = await adminSubscriberApi.setStatus(row.organizationId, action, reason);
        return `${row.legalName}: account ${result.organizationStatus}, subscription ${result.subscriptionStatus ?? 'none'}.`;
      },
    });
  };

  /**
   * Enter the subscriber's workspace. The member roster held for any previously
   * viewed subscriber is discarded BEFORE the new context is set, so the Members
   * page can never paint one tenant's people under another tenant's name.
   *
   * `exact` narrows the operator to the subscriber's REAL package so they can see
   * the customer's experience. It is applied after entering, because `enter`
   * deliberately resets it — full-access administrator mode is the default and an
   * exact view is always an explicit choice.
   */
  const openWorkspace = (row: AdminSubscriberRow, exact: boolean): void => {
    useMemberDirectoryStore.getState().clear();
    enterSubscriberView({
      organizationId: row.organizationId,
      ownerUserId: row.ownerUserId,
      ownerName: row.ownerName,
      orgName: row.legalName,
    });
    if (exact) useOperatorViewStore.getState().setViewAsSubscriber(true);
    navigate(ROUTES.appDashboard);
  };

  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="space-y-4">
      {listError && <Alert variant="error">{listError}</Alert>}
      {actionError && (
        <Alert variant="error" onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}
      {notice && (
        <Alert variant="success" onClose={() => setNotice(null)}>
          <span data-testid="subscribers-notice">{notice}</span>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <Input
            className="pl-8"
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search organization, owner or plan"
            aria-label="Search subscribers"
          />
        </div>
        <div className="w-48">
          <Select
            options={ORG_STATUS_FILTERS}
            value={orgStatus}
            aria-label="Filter by account status"
            onChange={(event) => {
              setOrgStatus(event.target.value);
              setOffset(0);
            }}
          />
        </div>
        <div className="w-52">
          <Select
            options={SUBSCRIPTION_FILTERS}
            value={subscriptionStatus}
            aria-label="Filter by subscription status"
            onChange={(event) => {
              setSubscriptionStatus(event.target.value);
              setOffset(0);
            }}
          />
        </div>
        <div className="w-48">
          <Select
            options={SORT_OPTIONS}
            value={sort}
            aria-label="Sort subscribers by"
            onChange={(event) => {
              setSort(event.target.value as NonNullable<AdminSubscriberQuery['sort']>);
              setOffset(0);
            }}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
            setOffset(0);
          }}
          aria-label={`Sort ${direction === 'asc' ? 'descending' : 'ascending'}`}
        >
          {direction === 'asc' ? 'Ascending' : 'Descending'}
        </Button>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh
        </Button>
        {can.create && (
          <Button size="sm" onClick={onAddSubscriber} data-testid="add-subscriber">
            <UserPlus className="h-3.5 w-3.5" aria-hidden /> Add subscriber
          </Button>
        )}
      </div>

      <Card className="overflow-x-auto">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 text-xs font-semibold uppercase text-slate-500 dark:border-slate-800">
          <span className="flex items-center gap-1.5">
            <Building2 className="h-3.5 w-3.5" aria-hidden /> Subscribers ({total})
          </span>
          {total > 0 && (
            <span className="font-normal normal-case text-slate-400">
              Showing {offset + 1}–{pageEnd}
            </span>
          )}
        </div>

        {awaiting && rows.length === 0 ? (
          <div className="space-y-2 p-4" data-testid="subscribers-loading">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500" data-testid="subscribers-empty">
            {search || orgStatus !== 'all' || subscriptionStatus !== 'all'
              ? 'No subscribers match these filters.'
              : 'No subscriber organizations yet.'}
          </p>
        ) : (
          <table className="w-full min-w-[1180px] text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
              <tr>
                <th className="px-4 py-2 text-left">Organization</th>
                <th className="px-4 py-2 text-left">Owner</th>
                <th className="px-4 py-2 text-left">Plan</th>
                <th className="px-4 py-2 text-left">Subscription</th>
                <th className="px-4 py-2 text-left">Account</th>
                <th className="px-4 py-2 text-left">Renews / starts</th>
                <th className="px-4 py-2 text-left">Seats</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.organizationId}
                  className="border-t border-slate-100 dark:border-slate-800"
                  data-testid="subscriber-row"
                  data-organization-id={row.organizationId}
                >
                  <td className="px-4 py-2">
                    <span className="font-medium">{row.legalName}</span>
                    <span className="block text-xs text-slate-400">
                      {row.tradingName ? `${row.tradingName} · ` : ''}
                      {row.country}
                    </span>
                  </td>
                  <td className={row.ownerName ? 'px-4 py-2' : 'px-4 py-2 text-slate-400'}>
                    {row.ownerName ?? 'No owner'}
                    {row.ownerEmail && <span className="block text-xs text-slate-400">{row.ownerEmail}</span>}
                  </td>
                  <td className="px-4 py-2">{row.planName ?? row.planCode ?? <span className="text-slate-400">Not selected</span>}</td>
                  <td className="px-4 py-2">
                    <Badge tone={SUBSCRIPTION_TONES[row.subscriptionStatus ?? ''] ?? 'slate'}>
                      {row.subscriptionStatus ?? 'none'}
                    </Badge>
                    {row.pendingProofId && (
                      <Badge tone="violet" className="ml-1">
                        proof to review
                      </Badge>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {/*
                      One badge component for the lifecycle, shared with the
                      closure drawer, so `pending_deletion` reads as "Deletion
                      scheduled" everywhere instead of as a raw enum in one place
                      and a friendly label in another.
                    */}
                    <StatusBadge
                      status={row.organizationStatus}
                      pendingDeletion={row.organizationStatus === 'pending_deletion'}
                    />
                    {/*
                      The classification badge. Production is the default and the
                      protected state, so it reads as reassurance rather than as a
                      warning; test/demo is what marks a tenant destroyable.
                    */}
                    <span
                      className="ml-1"
                      data-testid={`classification-${row.organizationId}`}
                    >
                      <Badge
                        tone={
                          row.dataClassification === 'production'
                            ? 'green'
                            : row.dataClassification === 'test'
                              ? 'amber'
                              : 'violet'
                        }
                      >
                        {row.dataClassification}
                      </Badge>
                    </span>
                    {row.entitlementActive ? (
                      <Badge tone="green" className="ml-1">
                        entitled
                      </Badge>
                    ) : (
                      <Badge tone="slate" className="ml-1">
                        not entitled
                      </Badge>
                    )}
                  </td>
                  <td className="px-4 py-2 text-slate-500">{shortDate(row.renewsAt)}</td>
                  <td className="px-4 py-2 text-slate-500">
                    {row.seatsUsed} / {row.seatLimit ?? '∞'}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onViewMembers(row.organizationId, row.legalName)}
                        aria-label={`View members of ${row.legalName}`}
                      >
                        Members
                      </Button>
                      {can.assign && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onAssignPackage(row.organizationId, row.legalName)}
                          aria-label={`Assign package for ${row.legalName}`}
                        >
                          Package
                        </Button>
                      )}
                      {can.manage && (
                        <>
                          {row.organizationStatus === 'active' ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => lifecycle(row, 'suspend')}
                              aria-label={`Suspend ${row.legalName}`}
                            >
                              Suspend
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => lifecycle(row, 'restore')}
                              aria-label={`Restore ${row.legalName}`}
                            >
                              Restore
                            </Button>
                          )}
                          {row.subscriptionStatus !== 'active' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => lifecycle(row, 'activate')}
                              aria-label={`Activate ${row.legalName}`}
                            >
                              Activate
                            </Button>
                          )}
                          {!ARCHIVED_STATUSES.has(row.organizationStatus) &&
                            row.organizationStatus !== 'pending_deletion' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => lifecycle(row, 'archive')}
                              aria-label={`Archive ${row.legalName}`}
                              data-testid={`archive-${row.organizationId}`}
                            >
                              Archive
                            </Button>
                          )}
                        </>
                      )}
                      {/*
                        Permanent deletion, offered ONLY for a disposable tenant
                        and only to an operator holding `subscribers.delete`.
                        A production row gets an explanation in its place rather
                        than a disabled button with no reason attached.
                      */}
                      {capabilities.includes('subscribers.delete') &&
                        (row.dataClassification === 'test' || row.dataClassification === 'demo' ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-red-600"
                            disabled={busy}
                            onClick={() => onCleanUp?.(row.organizationId)}
                            aria-label={`Permanently delete ${row.legalName}`}
                            data-testid={`permanently-delete-${row.organizationId}`}
                          >
                            Permanently delete
                          </Button>
                        ) : (
                          <span
                            className="self-center text-xs text-slate-400"
                            title="Production subscribers are retained. Archive preserves their accounting history."
                            data-testid={`retention-note-${row.organizationId}`}
                          >
                            Archive only
                          </span>
                        ))}
                      {capabilities.includes('members.read') && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setMembersTarget(row)}
                          aria-label={`Manage users and members of ${row.legalName}`}
                          data-testid={`manage-members-${row.organizationId}`}
                        >
                          Users &amp; members
                        </Button>
                      )}
                      {/*
                        Closure, deletion and export live behind one drawer rather
                        than beside the everyday controls: permanent deletion must
                        not sit next to "Open workspace" as though it were of the
                        same kind. Offered only to an operator who holds at least
                        one of the closure capabilities — the routes re-check each
                        one regardless.
                      */}
                      {(capabilities.includes('subscribers.archive') ||
                        capabilities.includes('subscribers.request_deletion') ||
                        capabilities.includes('subscribers.export')) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setClosureTarget(row)}
                          aria-label={`Manage account closure for ${row.legalName}`}
                          data-testid={`manage-closure-${row.organizationId}`}
                        >
                          Manage closure
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openWorkspace(row, false)}
                        aria-label={`Open the workspace of ${row.legalName}`}
                      >
                        Open workspace
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openWorkspace(row, true)}
                        aria-label={`View exactly as ${row.legalName} sees it`}
                      >
                        View exactly as subscriber
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0 || loading}
            onClick={() => setOffset((current) => Math.max(current - PAGE_SIZE, 0))}
          >
            Previous
          </Button>
          <span className="text-xs text-slate-500" data-testid="subscribers-page">
            Page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.max(Math.ceil(total / PAGE_SIZE), 1)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={pageEnd >= total || loading}
            onClick={() => setOffset((current) => current + PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      )}

      {membersTarget && (
        <SubscriberMembersDrawer
          open
          organizationId={membersTarget.organizationId}
          legalName={membersTarget.legalName}
          organizationStatus={membersTarget.organizationStatus}
          capabilities={capabilities}
          onClose={() => setMembersTarget(null)}
        />
      )}

      {closureTarget && (
        <SubscriberClosureDrawer
          open
          organizationId={closureTarget.organizationId}
          legalName={closureTarget.legalName}
          ownerEmail={closureTarget.ownerEmail}
          memberCount={closureTarget.memberCount}
          subscriptionStatus={closureTarget.subscriptionStatus}
          createdAt={closureTarget.createdAt}
          capabilities={capabilities}
          onClose={() => setClosureTarget(null)}
          onRequestDeletion={(impact, impactError) =>
            setDeletionTarget({ row: closureTarget, impact, impactError })
          }
          onChanged={() => void refresh()}
        />
      )}

      {/*
        A SIBLING of the drawer, never a child — so dismissing the drawer cannot
        unmount the dialog while a step-up submission is in flight.
      */}
      {deletionTarget && (
        <RequestDeletionDialog
          open
          organizationId={deletionTarget.row.organizationId}
          legalName={deletionTarget.row.legalName}
          ownerEmail={deletionTarget.row.ownerEmail}
          impact={deletionTarget.impact}
          impactError={deletionTarget.impactError}
          onClose={() => setDeletionTarget(null)}
          onScheduled={(result) => {
            setDeletionTarget(null);
            setNotice(
              `${result.legalName}: deletion scheduled. The purge is permitted after ${new Date(
                result.scheduledPurgeAfter,
              ).toLocaleString()}, and ${result.revokedSessions} session(s) were revoked. Nothing has been destroyed.`,
            );
            void refresh();
          }}
          onArchiveInstead={() => {
            const row = deletionTarget.row;
            setDeletionTarget(null);
            lifecycle(row, 'archive');
          }}
        />
      )}

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
    </div>
  );
}

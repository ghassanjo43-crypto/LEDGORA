/**
 * Applicants — the platform operator's roster of every registered customer.
 *
 * This replaces the assumption that a subscriber only exists once they have a
 * subscription. The backend query is based on the registered USER and left-joins
 * everything else, so a prospect who has created an account and nothing else is
 * here from the moment they sign up, showing "Not selected" for their package.
 *
 * Every row comes from `/api/admin/applicants`, which is authorised server-side
 * against a database-backed platform role. Nothing on this screen is derived
 * from browser state, and no action here is trusted by the server because the
 * button was rendered.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Users, RefreshCw, Search } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { Skeleton } from '@/components/ui/Skeleton';
import { adminApi, type Applicant, type ApplicantListResponse, type ApplicantQuery } from '@/services/api/authApi';
import { ApiError, isApiConfigured } from '@/services/api/client';
import {
  APPLICANT_TABS,
  availableActions,
  organizationLabel,
  packageLabel,
  stageLabel,
  stageTone,
  type ApplicantTabId,
} from '@/lib/applicantStages';
import { ApplicantDetailDrawer } from './ApplicantDetailDrawer';

const PAGE_SIZE = 25;

const SORT_OPTIONS = [
  { value: 'registered_at', label: 'Registration date' },
  { value: 'last_activity_at', label: 'Last activity' },
  { value: 'full_name', label: 'Name' },
  { value: 'email', label: 'Email' },
  { value: 'organization_name', label: 'Organization' },
  { value: 'stage', label: 'Stage' },
];

const shortDate = (value: string): string => new Date(value).toISOString().slice(0, 10);

/**
 * The row's action buttons.
 *
 * Which ones apply comes from `availableActions`, so what the operator can click
 * is decided in one tested place rather than re-derived from stage conditions
 * scattered through the markup. "Open" is always present — every applicant has
 * detail worth reading, including one who has done nothing but sign up.
 */
function RowActions({
  applicant,
  busy,
  onOpen,
  onRemind,
  onActivate,
}: {
  applicant: Applicant;
  busy: boolean;
  onOpen: () => void;
  onRemind: () => void;
  onActivate: () => void;
}) {
  const actions = availableActions(applicant);

  return (
    <div className="flex justify-end gap-1.5">
      {actions.includes('remind') && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onRemind}
          aria-label={`Send package reminder to ${applicant.fullName}`}
        >
          Remind
        </Button>
      )}
      {actions.includes('activate') && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onActivate}
          aria-label={`Activate subscription for ${applicant.fullName}`}
        >
          Activate
        </Button>
      )}
      <Button size="sm" variant="outline" onClick={onOpen} aria-label={`Open ${applicant.fullName}`}>
        Open
      </Button>
    </div>
  );
}

/** "3 days ago" is more useful than a timestamp when scanning for stalls. */
function relativeDays(value: string): string {
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1 month ago' : `${months} months ago`;
}

export function ApplicantsPanel() {
  const [tab, setTab] = useState<ApplicantTabId>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<NonNullable<ApplicantQuery['sort']>>('registered_at');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);

  const [data, setData] = useState<ApplicantListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const configured = isApiConfigured();
  const requestId = useRef(0);

  /** Debounce the search box so typing does not fire a request per keystroke. */
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const load = useCallback(async (): Promise<void> => {
    if (!configured) {
      setLoading(false);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await adminApi.listApplicants({
        stage: tab,
        search: search || undefined,
        sort,
        direction,
        limit: PAGE_SIZE,
        offset,
      });
      // Ignore a response that a newer request has already superseded.
      if (id !== requestId.current) return;
      setData(result);
    } catch (cause) {
      if (id !== requestId.current) return;
      setError(cause instanceof ApiError ? cause.message : 'Could not load applicants.');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [configured, tab, search, sort, direction, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  // Read every field defensively. An unexpected response shape must degrade to
  // an empty roster with a visible error, never crash the operator's console.
  const applicants = Array.isArray(data?.applicants) ? data.applicants : [];
  const selected = useMemo(
    () => (selectedId ? (applicants.find((a) => a.userId === selectedId) ?? null) : null),
    [applicants, selectedId],
  );

  const tabs: TabItem<ApplicantTabId>[] = useMemo(
    () =>
      APPLICANT_TABS.map((definition) => ({
        id: definition.id,
        label: definition.label,
        count: data?.stageCounts?.[definition.countKey],
      })),
    [data],
  );

  /** Run an action, surface its outcome, then re-read the roster. */
  const runAction = async (label: string, action: () => Promise<string | void>): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const message = await action();
      setNotice(message || `${label} done.`);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : `${label} failed.`);
    } finally {
      setBusy(false);
    }
  };

  const changeState = (applicant: Applicant, state: 'suspend' | 'archive' | 'restore'): void => {
    // The server requires a written reason and records it in the audit trail.
    const reason = window.prompt(`Reason for ${state} (recorded in the audit trail):`);
    if (!reason?.trim()) return;
    void runAction(`${state} applicant`, async () => {
      await adminApi.setApplicantState(applicant.userId, state, reason.trim());
      if (state !== 'restore') setSelectedId(null);
      return `${applicant.fullName} — applicant ${state === 'restore' ? 'restored' : `${state}ed`}.`;
    });
  };

  const remind = (applicant: Applicant): void => {
    void runAction('send reminder', async () => {
      const result = await adminApi.remindApplicant(applicant.userId);
      return result.message;
    });
  };

  const activate = (applicant: Applicant): void => {
    if (!applicant.subscriptionId) return;
    const reason = window.prompt('Reason for manual activation (recorded in the audit trail):');
    if (!reason?.trim()) return;
    void runAction('activate subscription', async () => {
      await adminApi.activateSubscription(applicant.subscriptionId!, reason.trim());
      return `${applicant.fullName} — subscription activated.`;
    });
  };

  if (!configured) {
    return (
      <Alert variant="warning" title="Backend not configured for this build">
        The applicant roster is served by the LEDGORA account service. Set <code>VITE_API_URL</code> and sign in as a
        platform administrator to see registered customers.
      </Alert>
    );
  }

  const total = data?.pagination?.total ?? applicants.length;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="space-y-4">
      <Alert variant="info">
        Every registered customer appears here from the moment they create an account — including prospects who have not
        chosen a package yet. Dormant applicants are shown, never deleted
        {data?.dormantDays ? ` (no activity for ${data.dormantDays} days)` : ''}.
      </Alert>

      {error && <Alert variant="error">{error}</Alert>}
      {notice && (
        <Alert variant="success" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}

      <Tabs
        tabs={tabs}
        value={tab}
        onChange={(id) => {
          setTab(id);
          setOffset(0);
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <Input
            className="pl-8"
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search name, email or organization"
            aria-label="Search applicants"
          />
        </div>
        <div className="w-48">
          <Select
            options={SORT_OPTIONS}
            value={sort}
            aria-label="Sort applicants by"
            onChange={(event) => {
              setSort(event.target.value as NonNullable<ApplicantQuery['sort']>);
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
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Refresh
        </Button>
      </div>

      <Card className="overflow-x-auto">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 text-xs font-semibold uppercase text-slate-500 dark:border-slate-800">
          <span className="flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" aria-hidden />
            Applicants ({total})
          </span>
          {total > 0 && (
            <span className="font-normal normal-case text-slate-400">
              Showing {offset + 1}–{pageEnd}
            </span>
          )}
        </div>

        {loading && !data ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : applicants.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">
            {search ? 'No applicants match that search.' : 'No applicants in this stage yet.'}
          </p>
        ) : (
          <table className="w-full min-w-[1040px] text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
              <tr>
                <th className="px-4 py-2 text-left">Applicant</th>
                <th className="px-4 py-2 text-left">Registered</th>
                <th className="px-4 py-2 text-left">Organization</th>
                <th className="px-4 py-2 text-left">Package</th>
                <th className="px-4 py-2 text-left">Stage</th>
                <th className="px-4 py-2 text-left">Last activity</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {applicants.map((applicant) => (
                <tr
                  key={applicant.userId}
                  className="border-t border-slate-100 dark:border-slate-800"
                  data-testid="applicant-row"
                  data-stage={applicant.stage}
                >
                  <td className="px-4 py-2">
                    <span className="font-medium">{applicant.fullName}</span>
                    <span className="block text-xs text-slate-400">
                      {applicant.email}
                      {applicant.emailVerified ? '' : ' · unverified'}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-slate-500">{shortDate(applicant.registeredAt)}</td>
                  <td className={applicant.organizationName ? 'px-4 py-2' : 'px-4 py-2 text-slate-400'}>
                    {organizationLabel(applicant)}
                  </td>
                  <td className={applicant.planName ? 'px-4 py-2' : 'px-4 py-2 text-slate-400'}>
                    {packageLabel(applicant)}
                  </td>
                  <td className="px-4 py-2">
                    <Badge tone={stageTone(applicant.stage)}>{stageLabel(applicant.stage)}</Badge>
                  </td>
                  <td className="px-4 py-2 text-slate-500">{relativeDays(applicant.lastActivityAt)}</td>
                  <td className="px-4 py-2">
                    <RowActions
                      applicant={applicant}
                      busy={busy}
                      onOpen={() => setSelectedId(applicant.userId)}
                      onRemind={() => remind(applicant)}
                      onActivate={() => activate(applicant)}
                    />
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
          <span className="text-xs text-slate-500">
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

      <ApplicantDetailDrawer
        open={!!selected}
        applicant={selected}
        busy={busy}
        onClose={() => setSelectedId(null)}
        onRemind={() => selected && remind(selected)}
        onSuspend={() => selected && changeState(selected, 'suspend')}
        onArchive={() => selected && changeState(selected, 'archive')}
        onRestore={() => selected && changeState(selected, 'restore')}
      />
    </div>
  );
}

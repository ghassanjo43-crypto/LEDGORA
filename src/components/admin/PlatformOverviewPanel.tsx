/**
 * The Super Admin's landing screen: an operational overview of the PLATFORM.
 *
 * ══ Why this is not a dashboard ══════════════════════════════════════════════
 *
 * `DashboardPage` is an ACCOUNTING dashboard — cash, revenue, receivables,
 * payables. Those are one subscriber's figures, and a Ledgora operator is not a
 * subscriber: they have no organization, no books and no business asking those
 * questions. Reusing it would have made the platform console look like a
 * bookkeeping screen, which is the confusion this whole separation exists to
 * remove.
 *
 * ══ Every number here is real, or it is absent ═══════════════════════════════
 *
 * The hardest rule in this file. A metric appears only when a backend actually
 * answers for it:
 *
 *   subscribers, by status      `/api/admin/subscribers` — counted SERVER-side
 *                               across the whole population, not the page
 *   applicants, by stage        `/api/admin/applicants` — same
 *   members                     `/api/admin/members` — total from pagination
 *   payments awaiting review    the billing store's proof-submitted invoices
 *   outstanding file cleanup    `/api/admin/cleanup/files`
 *
 * Anything else is rendered as UNAVAILABLE with the reason, never as a number.
 * Platform-wide infrastructure cost is the live example: the metering engine
 * estimates cost for ONE organization from browser-held usage and a rate table,
 * so a figure printed here would look like Ledgora's hosting bill and would not
 * be it. A plausible wrong number on an operator console is worse than a blank,
 * because nobody re-checks a number that looks reasonable.
 *
 * A failed request also leaves a tile unavailable rather than zero. "0 pending
 * deletions" and "we could not ask" are different facts, and only one of them
 * means nothing needs attention.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Building2, UserPlus, Users, ClipboardCheck, Trash2, ShieldAlert, ArrowRight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { cn } from '@/lib/utils';
import { isApiConfigured } from '@/services/api/client';
import { adminApi } from '@/services/api/authApi';
import { cleanupApi } from '@/services/api/cleanupApi';
import { useAdminMemberStore, useAdminSubscriberStore } from '@/store/adminConsoleStores';
import { usePendingVerificationCount } from '@/store/billingHooks';

/** A tile's value is a number the backend gave us, or an explained absence. */
type Metric =
  | { state: 'ready'; value: number }
  | { state: 'loading' }
  | { state: 'unavailable'; reason: string };

const UNAVAILABLE_NO_BACKEND = 'No account service is configured in this build.';
const UNAVAILABLE_REQUEST_FAILED = 'The platform service did not answer.';

function MetricTile({
  icon: Icon, label, metric, hint, tone, onOpen, openLabel,
}: {
  icon: LucideIcon;
  label: string;
  metric: Metric;
  hint?: string;
  tone?: 'default' | 'attention';
  onOpen?: () => void;
  openLabel?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border p-4',
        tone === 'attention' && metric.state === 'ready' && metric.value > 0
          ? 'border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10'
          : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
      )}
      data-testid={`platform-metric-${label.toLowerCase().replace(/\W+/g, '-')}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-500">
          <Icon className="h-4 w-4" aria-hidden />
          {label}
        </div>
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            className="focus-ring rounded text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            {openLabel ?? 'Open'} <ArrowRight className="inline h-3 w-3" aria-hidden />
          </button>
        )}
      </div>

      <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
        {metric.state === 'ready' ? metric.value.toLocaleString() : metric.state === 'loading' ? '—' : '—'}
      </p>

      {metric.state === 'unavailable' ? (
        // Stated, not hidden: an operator must be able to tell "nothing to do"
        // from "we could not find out".
        <p className="mt-1 text-[11px] leading-snug text-slate-500">Unavailable · {metric.reason}</p>
      ) : (
        hint && <p className="mt-1 text-[11px] leading-snug text-slate-500">{hint}</p>
      )}
    </div>
  );
}

/** A server-computed distribution, rendered only from keys the server sent. */
function Distribution({ title, counts, empty }: {
  title: string;
  counts: Record<string, number>;
  empty: string;
}) {
  const rows = useMemo(
    () =>
      Object.entries(counts ?? {})
        .filter(([key, value]) => key !== 'all' && value > 0)
        .sort((a, b) => b[1] - a[1]),
    [counts],
  );

  return (
    <Card>
      <CardHeader title={title} />
      <CardBody>
        {rows.length === 0 ? (
          <p className="text-sm text-slate-500">{empty}</p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map(([key, value]) => (
              <li key={key} className="flex items-center justify-between gap-3 text-sm">
                <span className="capitalize text-slate-600 dark:text-slate-300">
                  {key.replace(/^subscription:/, '').replace(/[-_]/g, ' ')}
                </span>
                <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                  {value.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

export interface PlatformOverviewPanelProps {
  /** Jump to another console tab. Keeps the overview a launcher, not a dead end. */
  onOpenTab?: (tab: 'applicants' | 'subscribers' | 'members' | 'payments' | 'metering' | 'cleanup') => void;
  /** Whether this operator holds `subscribers.delete` (drives the cleanup tile). */
  canCleanUp?: boolean;
}

export function PlatformOverviewPanel({ onOpenTab, canCleanUp = false }: PlatformOverviewPanelProps) {
  const configured = isApiConfigured();

  /* ── Subscribers: server-computed totals across the whole population ────── */
  const loadSubscribers = useAdminSubscriberStore((s) => s.load);
  const subscriberStatus = useAdminSubscriberStore((s) => s.status);
  const subscriberTotal = useAdminSubscriberStore((s) => s.pagination?.total ?? 0);
  /*
   * Defaulted defensively. A thin or partial response can leave this undefined,
   * and a summary panel must never be the thing that takes the console down —
   * an operator with no overview still needs the rosters underneath it.
   */
  const statusCounts = useAdminSubscriberStore((s) => s.statusCounts) ?? {};

  /* ── Members ────────────────────────────────────────────────────────────── */
  const loadMembers = useAdminMemberStore((s) => s.load);
  const memberStatus = useAdminMemberStore((s) => s.status);
  const memberTotal = useAdminMemberStore((s) => s.pagination?.total ?? 0);

  /* ── Applicants ─────────────────────────────────────────────────────────── */
  const [applicants, setApplicants] = useState<Metric>({ state: 'loading' });
  const [stageCounts, setStageCounts] = useState<Record<string, number>>({});

  /* ── Outstanding object deletions ───────────────────────────────────────── */
  const [cleanup, setCleanup] = useState<Metric>({ state: 'loading' });

  const pendingPayments = usePendingVerificationCount();

  useEffect(() => {
    if (!configured) return;
    // The rosters the tiles summarise. An empty query is deliberate: the counts
    // must describe every subscriber and member, not a filtered view.
    void loadSubscribers({});
    void loadMembers({});
  }, [configured, loadSubscribers, loadMembers]);

  useEffect(() => {
    if (!configured) {
      setApplicants({ state: 'unavailable', reason: UNAVAILABLE_NO_BACKEND });
      return;
    }
    const controller = new AbortController();
    void adminApi
      .listApplicants({ limit: 1 }, controller.signal)
      .then((res) => {
        setApplicants({ state: 'ready', value: res.pagination?.total ?? 0 });
        setStageCounts(res.stageCounts ?? {});
      })
      .catch(() => setApplicants({ state: 'unavailable', reason: UNAVAILABLE_REQUEST_FAILED }));
    return () => controller.abort();
  }, [configured]);

  useEffect(() => {
    if (!configured || !canCleanUp) {
      setCleanup({
        state: 'unavailable',
        reason: configured ? 'Requires the subscribers.delete capability.' : UNAVAILABLE_NO_BACKEND,
      });
      return;
    }
    let cancelled = false;
    void cleanupApi
      .fileStatus()
      .then((summary) => {
        if (!cancelled) setCleanup({ state: 'ready', value: summary.pending + summary.failed });
      })
      .catch(() => {
        // NOT zero. An unanswered question is not "nothing outstanding".
        if (!cancelled) setCleanup({ state: 'unavailable', reason: UNAVAILABLE_REQUEST_FAILED });
      });
    return () => { cancelled = true; };
  }, [configured, canCleanUp]);

  const rosterMetric = (status: string, total: number): Metric => {
    if (!configured) return { state: 'unavailable', reason: UNAVAILABLE_NO_BACKEND };
    if (status === 'error') return { state: 'unavailable', reason: UNAVAILABLE_REQUEST_FAILED };
    if (status === 'ready') return { state: 'ready', value: total };
    return { state: 'loading' };
  };

  const subscribers = rosterMetric(subscriberStatus, subscriberTotal);
  const members = rosterMetric(memberStatus, memberTotal);

  return (
    <div className="space-y-5" data-testid="platform-overview">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Platform overview</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          Ledgora tenancy, onboarding and operations. These are platform figures — not any
          subscriber&rsquo;s accounts.
        </p>
      </div>

      {!configured && (
        <Alert variant="info" title="No account service configured">
          This build has no platform backend, so tenancy figures cannot be read. The panels below
          show what is genuinely available rather than sample values.
        </Alert>
      )}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricTile
          icon={Building2} label="Subscribers" metric={subscribers}
          hint="Organizations on the platform"
          onOpen={onOpenTab && (() => onOpenTab('subscribers'))}
        />
        <MetricTile
          icon={UserPlus} label="Applicants" metric={applicants}
          hint="Registered customers at any stage"
          onOpen={onOpenTab && (() => onOpenTab('applicants'))}
        />
        <MetricTile
          icon={Users} label="Members" metric={members}
          hint="User accounts across all tenants"
          onOpen={onOpenTab && (() => onOpenTab('members'))}
        />
        <MetricTile
          icon={ClipboardCheck} label="Payments to verify"
          metric={{ state: 'ready', value: pendingPayments }}
          hint="Proof submitted, awaiting review"
          tone="attention"
          onOpen={onOpenTab && (() => onOpenTab('payments'))}
        />
        <MetricTile
          icon={Trash2} label="Files to clean up" metric={cleanup}
          hint="Pending or failed object deletions"
          tone="attention"
          onOpen={canCleanUp && onOpenTab ? () => onOpenTab('cleanup') : undefined}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Distribution
          title="Subscription status"
          counts={Object.fromEntries(
            Object.entries(statusCounts).filter(([k]) => k.startsWith('subscription:')),
          )}
          empty={configured ? 'No subscriptions recorded yet.' : 'Requires the account service.'}
        />
        <Distribution
          title="Organization status"
          counts={Object.fromEntries(
            Object.entries(statusCounts).filter(([k]) => !k.startsWith('subscription:')),
          )}
          empty={configured ? 'No organizations recorded yet.' : 'Requires the account service.'}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Distribution
          title="Applicant stage"
          counts={stageCounts}
          empty={configured ? 'No applicants recorded yet.' : 'Requires the account service.'}
        />

        {/*
          Deliberately NOT a number.

          The metering engine estimates infrastructure cost for ONE organization
          from browser-held usage counters and a configurable rate table. A
          figure shown here would read as Ledgora's platform hosting cost and
          would not be it. Section 12 of the specification is explicit: no
          placeholder infrastructure values presented as live.
        */}
        <Card>
          <CardHeader title="Infrastructure &amp; usage" />
          <CardBody className="space-y-3">
            <div className="flex items-start gap-2">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              <p className="text-sm text-slate-600 dark:text-slate-300">
                Platform-wide storage, bandwidth and hosting cost are not yet aggregated by a
                backend service. The metering console reports usage and estimated cost per
                organization from its rate table.
              </p>
            </div>
            <Badge tone="slate">No platform-wide figure available</Badge>
            {onOpenTab && (
              <div>
                <Button variant="outline" size="sm" onClick={() => onOpenTab('metering')}>
                  Open metering &amp; infrastructure
                </Button>
              </div>
            )}
          </CardBody>
        </Card>
      </section>
    </div>
  );
}

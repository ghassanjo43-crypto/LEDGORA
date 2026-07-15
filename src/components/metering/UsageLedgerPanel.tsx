import { useMemo, useState } from 'react';
import { Lock, LockOpen, Plus, ShieldCheck } from 'lucide-react';
import type { UsageMetric } from '@/types/metering';
import { useUsageStore } from '@/store/usageStore';
import { useIsMeteringAdmin } from '@/store/meteringHooks';
import { periodKeyOf } from '@/lib/meteringCalculations';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/ui/EmptyState';
import { formatDate } from '@/lib/utils';

const METRIC_OPTIONS: { value: UsageMetric; label: string }[] = [
  { value: 'storage_bytes', label: 'Storage (bytes)' },
  { value: 'outbound_download_bytes', label: 'Outbound bandwidth (bytes)' },
  { value: 'journal_entries', label: 'Journal entries' },
  { value: 'api_requests', label: 'API requests' },
  { value: 'invoices', label: 'Invoices' },
  { value: 'uploaded_files', label: 'Uploaded files' },
  { value: 'ai_units', label: 'AI units' },
];

/**
 * Administrator usage-ledger controls. Closing a period freezes the raw usage
 * events (they become immutable); corrections after close are recorded as
 * adjustment entries — closed records are never edited.
 */
export function UsageLedgerPanel() {
  const isAdmin = useIsMeteringAdmin();
  const periods = useUsageStore((s) => s.periods);
  const closePeriod = useUsageStore((s) => s.closePeriod);
  const reopenPeriod = useUsageStore((s) => s.reopenPeriod);
  const recordAdjustment = useUsageStore((s) => s.recordAdjustment);
  const [error, setError] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [metric, setMetric] = useState<UsageMetric>('journal_entries');
  const [qty, setQty] = useState('0');
  const [reason, setReason] = useState('');

  const currentPeriod = periodKeyOf(new Date().toISOString());
  const ordered = useMemo(() => [...periods].sort((a, b) => b.period.localeCompare(a.period)), [periods]);

  if (!isAdmin) {
    return <EmptyState icon={ShieldCheck} title="Administrator access required" description="Closing periods and recording adjustments is restricted to administrators." />;
  }

  const onClose = (period: string): void => {
    setError(null);
    const res = closePeriod(period);
    if (!res.ok) setError(res.error ?? 'Could not close the period.');
  };

  const onAdjust = (period: string): void => {
    setError(null);
    const res = recordAdjustment(period, metric, Number(qty), reason);
    if (!res.ok) {
      setError(res.error ?? 'Could not record the adjustment.');
      return;
    }
    setAdjusting(null);
    setReason('');
    setQty('0');
  };

  return (
    <div className="space-y-3">
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">{error}</div>}

      <Card>
        <CardHeader title="Current period" description={`Close ${currentPeriod} to freeze its usage ledger.`} />
        <CardBody className="flex items-center justify-between">
          <span className="text-sm text-slate-600 dark:text-slate-300">
            {useUsageStore.getState().isPeriodClosed(currentPeriod) ? 'Closed' : 'Open'} · {currentPeriod}
          </span>
          {!useUsageStore.getState().isPeriodClosed(currentPeriod) && (
            <Button variant="primary" size="sm" onClick={() => onClose(currentPeriod)}><Lock className="h-4 w-4" /> Close period</Button>
          )}
        </CardBody>
      </Card>

      {ordered.length === 0 ? (
        <EmptyState icon={Lock} title="No closed periods yet" description="Closed periods and their frozen snapshots appear here." />
      ) : (
        ordered.map((p) => (
          <Card key={p.period}>
            <CardHeader
              title={`Period ${p.period}`}
              description={p.status === 'closed' ? `Closed ${p.closedAt ? formatDate(p.closedAt) : ''} by ${p.closedBy ?? ''}` : 'Open'}
              actions={<Badge tone={p.status === 'closed' ? 'green' : 'amber'}>{p.status}</Badge>}
            />
            <CardBody className="space-y-3">
              {p.summarySnapshot && (
                <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  <Snap label="Journal entries" value={(p.summarySnapshot.counters.journal_entries ?? 0).toLocaleString()} />
                  <Snap label="API requests" value={(p.summarySnapshot.counters.api_requests ?? 0).toLocaleString()} />
                  <Snap label="Avg storage (GB)" value={(p.summarySnapshot.averageStorageBytes / 1_000_000_000).toFixed(2)} />
                  <Snap label="Bandwidth (GB)" value={(p.summarySnapshot.outboundBandwidthBytes / 1_000_000_000).toFixed(2)} />
                </dl>
              )}

              {p.adjustments.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Adjustments (corrections)</p>
                  <ul className="mt-1 space-y-1">
                    {p.adjustments.map((a) => (
                      <li key={a.id} className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                        <Badge tone="slate">{a.metric}</Badge>
                        <span className="font-mono">{a.quantity > 0 ? '+' : ''}{a.quantity.toLocaleString()}</span>
                        <span className="truncate">{a.reason}</span>
                        <span className="ml-auto text-slate-400">{formatDate(a.at)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {p.status === 'closed' && (
                adjusting === p.period ? (
                  <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                    <p className="text-xs text-slate-500">Closed records are immutable — record a correction as an adjustment.</p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <Select value={metric} options={METRIC_OPTIONS} onChange={(e) => setMetric(e.target.value as UsageMetric)} />
                      <Input type="number" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Quantity (+/-)" />
                      <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" />
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setAdjusting(null)}>Cancel</Button>
                      <Button variant="primary" size="sm" onClick={() => onAdjust(p.period)}>Record adjustment</Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => reopenPeriod(p.period)}><LockOpen className="h-4 w-4" /> Reopen</Button>
                    <Button variant="outline" size="sm" onClick={() => setAdjusting(p.period)}><Plus className="h-4 w-4" /> Add adjustment</Button>
                  </div>
                )
              )}
            </CardBody>
          </Card>
        ))
      )}
    </div>
  );
}

function Snap({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="font-mono tabular-nums text-slate-700 dark:text-slate-200">{value}</dd>
    </div>
  );
}

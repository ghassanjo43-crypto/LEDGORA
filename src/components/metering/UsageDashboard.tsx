import { useMemo } from 'react';
import { Gauge, HardDrive, Wifi, TrendingUp, FlaskConical } from 'lucide-react';
import type { AllowanceLine, ThresholdBand } from '@/types/metering';
import { useUsageStore } from '@/store/usageStore';
import {
  useActiveBasePlan,
  useAllowanceLines,
  useOverageStatement,
  useUsageSummary,
} from '@/store/meteringHooks';
import { useMeteringConfigStore } from '@/store/meteringConfigStore';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatCurrency } from '@/lib/money';
import { BYTES_PER_GB } from '@/lib/meteringSeed';
import { platformAdminToolsAllowed } from '@/lib/platformAccess';
import { cn } from '@/lib/utils';

const BAND_BAR: Record<ThresholdBand, string> = {
  ok: 'bg-emerald-500',
  warn70: 'bg-amber-400',
  warn85: 'bg-amber-500',
  over100: 'bg-red-500',
  critical120: 'bg-red-600',
};
const BAND_BADGE: Record<ThresholdBand, { tone: 'green' | 'amber' | 'red'; label: string }> = {
  ok: { tone: 'green', label: 'OK' },
  warn70: { tone: 'amber', label: '70%+' },
  warn85: { tone: 'amber', label: '85%+' },
  over100: { tone: 'red', label: 'Over' },
  critical120: { tone: 'red', label: '120%+' },
};

/** Customer usage dashboard: allowances, thresholds and projected overage. */
export function UsageDashboard() {
  const plan = useActiveBasePlan();
  const lines = useAllowanceLines();
  const overage = useOverageStatement();
  const summary = useUsageSummary();
  const config = useMeteringConfigStore((s) => s.config);

  const modules = useMemo(
    () => config.optionalModules.filter((m) => config.activeModuleCodes.includes(m.code)),
    [config],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Badge tone="blue"><Gauge className="h-3 w-3" /> {plan?.name ?? 'No plan'}</Badge>
              {plan?.startingAt && <span className="text-xs text-slate-400">starting at</span>}
              <span className="text-lg font-semibold text-slate-900 dark:text-slate-50">
                {plan ? formatCurrency(plan.priceMonthly, plan.currency) : '—'}
              </span>
              <span className="text-sm text-slate-400">/ month</span>
            </div>
            {modules.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {modules.map((m) => <Badge key={m.id} tone="teal">{m.name} · {formatCurrency(m.priceMonthly, m.currency)}</Badge>)}
              </div>
            )}
            <p className="mt-1 text-xs text-slate-400">
              Period {summary.period} · day {summary.daysElapsed} of {summary.daysInPeriod}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[11px] uppercase tracking-wide text-slate-400">Projected overage</p>
            <p className={cn('text-xl font-semibold tabular-nums', overage.total > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>
              {formatCurrency(overage.total, overage.currency)}
            </p>
          </div>
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MetricTile icon={HardDrive} label="Avg. storage" value={`${(summary.averageStorageBytes / BYTES_PER_GB).toFixed(2)} GB`} sub={`${plan?.allowances.storageGb ?? 0} GB included`} />
        <MetricTile icon={Wifi} label="Outbound bandwidth" value={`${(summary.outboundBandwidthBytes / BYTES_PER_GB).toFixed(2)} GB`} sub="uploads not counted" />
        <MetricTile icon={TrendingUp} label="Journal entries" value={(summary.counters.journal_entries ?? 0).toLocaleString()} sub={`${(plan?.allowances.journalEntries ?? 0).toLocaleString()} included`} />
      </div>

      <Card>
        <CardHeader title="Allowance usage" description="Consumption against your plan allowance with 70 / 85 / 100 / 120% thresholds." />
        <CardBody className="space-y-3">
          {lines.map((line) => <AllowanceBar key={line.metric} line={line} />)}
        </CardBody>
      </Card>

      {overage.lines.length > 0 && (
        <Card>
          <CardHeader title="Estimated overage charges" description="Charges that would apply if the period closed today." />
          <CardBody className="p-0">
            <table className="w-full text-sm">
              <tbody>
                {overage.lines.map((l) => (
                  <tr key={l.metric + l.label} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                    <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{l.label}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500">{l.quantity} {l.unit} × {formatCurrency(l.rate, overage.currency)}</td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums text-slate-800 dark:text-slate-100">{formatCurrency(l.amount, overage.currency)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="px-4 py-2 font-semibold text-slate-800 dark:text-slate-100" colSpan={2}>Total</td>
                  <td className="px-4 py-2 text-right font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-50">{formatCurrency(overage.total, overage.currency)}</td>
                </tr>
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}

      {platformAdminToolsAllowed() && <UsageSimulator />}
    </div>
  );
}

function AllowanceBar({ line }: { line: AllowanceLine }) {
  const badge = BAND_BADGE[line.band];
  const pct = Math.min(100, line.pct);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-sm">
        <span className="flex items-center gap-2 text-slate-700 dark:text-slate-200">
          {line.label}
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </span>
        <span className="tabular-nums text-slate-500">
          {formatNum(line.used)} / {formatNum(line.allowance)} {line.unit}
          {line.overageCost > 0 && <span className="ml-2 text-red-600 dark:text-red-400">+{formatCurrency(line.overageCost, line.currency)}</span>}
        </span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div className={cn('h-full rounded-full transition-all', BAND_BAR[line.band])} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function MetricTile({ icon: Icon, label, value, sub }: { icon: typeof HardDrive; label: string; value: string; sub: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-slate-400"><Icon className="h-4 w-4" /><span className="text-xs">{label}</span></div>
      <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-50">{value}</p>
      <p className="text-[11px] text-slate-400">{sub}</p>
    </Card>
  );
}

function formatNum(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2);
}

/** Development-only helper to generate representative usage events. */
function UsageSimulator() {
  const store = useUsageStore();
  return (
    <Card>
      <CardHeader title="Simulate usage (development)" description="Generate representative usage events to exercise the meters." />
      <CardBody className="flex flex-wrap gap-2">
        <SimBtn label="Upload 250 MB doc" onClick={() => store.recordUpload({ fileName: 'scan.pdf', contentType: 'application/pdf', sizeBytes: 250_000_000, storageKey: 'obj://demo/scan.pdf' })} />
        <SimBtn label="Download 500 MB" onClick={() => store.recordDownload(500_000_000)} />
        <SimBtn label="+1,000 journal entries" onClick={() => store.recordJournalEntry(1000)} />
        <SimBtn label="+50,000 API requests" onClick={() => store.recordApiRequest(50_000)} />
        <SimBtn label="+100 invoices" onClick={() => store.recordInvoice(100)} />
        <SimBtn label="+10,000 AI units" onClick={() => store.recordAiUnits(10_000)} />
        <SimBtn label="Report export (20 MB)" onClick={() => store.recordReportExport(20_000_000)} />
        <SimBtn label="Reset usage" onClick={() => store.resetToDefault()} />
      </CardBody>
    </Card>
  );
}

function SimBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <FlaskConical className="h-3.5 w-3.5" /> {label}
    </Button>
  );
}

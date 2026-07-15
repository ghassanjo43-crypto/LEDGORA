import { Server, ShieldCheck } from 'lucide-react';
import { useCostRecovery, useInfraCost, useIsMeteringAdmin } from '@/store/meteringHooks';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { formatCurrency } from '@/lib/money';
import { cn } from '@/lib/utils';

/**
 * Administrator infrastructure-cost dashboard: estimated Render/infra cost of the
 * organization's usage vs. the revenue it generates (plan + modules + overage).
 */
export function InfrastructureCostDashboard() {
  const isAdmin = useIsMeteringAdmin();
  const infra = useInfraCost();
  const recovery = useCostRecovery();

  if (!isAdmin) {
    return <EmptyState icon={ShieldCheck} title="Administrator access required" description="Infrastructure cost data is restricted to administrators." />;
  }

  const cur = recovery.currency;
  const rows: { label: string; value: number }[] = [
    { label: 'Compute (web service)', value: infra.compute },
    { label: 'Database (PostgreSQL)', value: infra.database },
    { label: 'Object storage', value: infra.storage },
    { label: 'Egress / outbound bandwidth', value: infra.egress },
    { label: 'AI', value: infra.ai },
    { label: 'API', value: infra.api },
    { label: 'Overhead', value: infra.overhead },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kpi label="Revenue (plan + overage)" value={formatCurrency(recovery.totalRevenue, cur)} tone="text-emerald-600 dark:text-emerald-400" />
        <Kpi label="Estimated infra cost" value={formatCurrency(recovery.infraCost, cur)} tone="text-slate-800 dark:text-slate-100" icon={Server} />
        <Kpi label="Margin" value={`${formatCurrency(recovery.margin, cur)} (${recovery.marginPct}%)`} tone={recovery.margin >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'} />
      </div>

      <Card>
        <CardHeader title="Estimated infrastructure cost" description="Derived from current usage and the editable Render cost assumptions." actions={<Badge tone="slate">{recovery.period}</Badge>} />
        <CardBody className="p-0">
          <table className="w-full text-sm">
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{r.label}</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums text-slate-800 dark:text-slate-100">{formatCurrency(r.value, cur)}</td>
                </tr>
              ))}
              <tr>
                <td className="px-4 py-2 font-semibold text-slate-800 dark:text-slate-100">Total infrastructure cost</td>
                <td className="px-4 py-2 text-right font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-50">{formatCurrency(infra.total, cur)}</td>
              </tr>
            </tbody>
          </table>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Cost recovery" description="Whether usage-based charges recover the underlying infrastructure cost." />
        <CardBody>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Plan revenue" value={formatCurrency(recovery.planRevenue, cur)} />
            <Stat label="Overage revenue" value={formatCurrency(recovery.overageRevenue, cur)} />
            <Stat label="Infra cost" value={formatCurrency(recovery.infraCost, cur)} />
            <Stat label="Margin" value={`${recovery.marginPct}%`} tone={recovery.margin >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'} />
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}

function Kpi({ label, value, tone, icon: Icon }: { label: string; value: string; tone: string; icon?: typeof Server }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-slate-400">{Icon && <Icon className="h-4 w-4" />}<span className="text-xs">{label}</span></div>
      <p className={cn('mt-1 text-xl font-semibold tabular-nums', tone)}>{value}</p>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className={cn('text-sm font-medium text-slate-800 dark:text-slate-100', tone)}>{value}</dd>
    </div>
  );
}

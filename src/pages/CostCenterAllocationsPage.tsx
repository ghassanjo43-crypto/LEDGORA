import { useMemo, useState } from 'react';
import { Plus, RefreshCw, Send, Ban } from 'lucide-react';
import type { CostCenterAllocationTarget } from '@/types/costCenterAllocation';
import { useStore } from '@/store/useStore';
import { useCostCenterStore } from '@/store/costCenterStore';
import { useCostCenterAllocationStore } from '@/store/costCenterAllocationStore';
import { formatCurrency } from '@/lib/money';
import { cn as cx } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import type { BadgeTone } from '@/data/ifrsOptions';
import { PageActions } from '@/components/ui/PageActions';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { AccountSelect } from '@/components/journal/AccountSelect';
import { CostCenterPicker } from '@/components/cost-centers/CostCenterPicker';

const RUN_TONE: Record<string, BadgeTone> = { draft: 'slate', reviewed: 'indigo', posted: 'green', reversed: 'red' };

export function CostCenterAllocationsPage() {
  const accounts = useStore((s) => s.accounts);
  const base = useStore((s) => s.settings.baseCurrency);
  const centers = useCostCenterStore((s) => s.costCenters);
  const rules = useCostCenterAllocationStore((s) => s.rules);
  const runs = useCostCenterAllocationStore((s) => s.runs);
  const store = useCostCenterAllocationStore();
  const { notify } = useToast();
  const money = (n: number): string => formatCurrency(n, base);

  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [sourceCc, setSourceCc] = useState('');
  const [accountId, setAccountId] = useState('');
  const [targets, setTargets] = useState<CostCenterAllocationTarget[]>([{ costCenterId: '', percentage: 0, sortOrder: 0 }]);
  const [periodStart, setPeriodStart] = useState('2026-01-01');
  const [periodEnd, setPeriodEnd] = useState('2026-01-31');
  const [override, setOverride] = useState<number | ''>('');

  const ccName = (id: string): string => centers.find((c) => c.id === id)?.code ?? id;
  const pctTotal = useMemo(() => targets.reduce((s, t) => s + (Number(t.percentage) || 0), 0), [targets]);
  const act = (fn: () => { ok: boolean; error?: string; id?: string }, ok: string): void => { const r = fn(); if (r.ok) notify(ok, 'success'); else notify(r.error ?? 'Action failed.', 'error'); };

  const saveRule = (): void => {
    if (!code.trim() || !accountId || targets.some((t) => !t.costCenterId)) { notify('Provide a code, account and target cost centers.', 'error'); return; }
    const res = store.createRule({ code, name, status: 'active', method: 'percentage', sourceCostCenterId: sourceCc || undefined, allocationAccountId: accountId, targets });
    if (res.ok) { notify('Allocation rule created.', 'success'); setOpen(false); setCode(''); setName(''); setTargets([{ costCenterId: '', percentage: 0, sortOrder: 0 }]); }
  };
  const runRule = (ruleId: string): void => {
    const built = store.buildRun(ruleId, { periodStart, periodEnd, postingDate: periodEnd, sourceAmountOverride: override === '' ? undefined : Number(override) });
    if (built.ok && built.id) { const p = store.postRun(built.id); if (p.ok) notify('Allocation posted.', 'success'); else notify(p.error ?? 'Could not post.', 'error'); }
    else notify(built.error ?? 'Could not build the run.', 'error');
  };

  return (
    <>
      <PageActions><Button onClick={() => setOpen((o) => !o)}><Plus className="h-4 w-4" /> New allocation rule</Button></PageActions>

      {open && (
        <Card className="mb-4"><CardBody>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <Field label="Code" required><Input value={code} onChange={(e) => setCode(e.target.value)} /></Field>
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Source cost center"><CostCenterPicker value={sourceCc} onChange={setSourceCc} costCenters={centers} includeInactive /></Field>
            <Field label="Allocation account" required><AccountSelect value={accountId} accounts={accounts} onChange={(a) => setAccountId(a.id)} /></Field>
          </div>
          <p className="mt-3 mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Targets (percentage) — total {pctTotal}%</p>
          {targets.map((t, idx) => (
            <div key={idx} className="mb-2 flex items-center gap-2">
              <div className="flex-1"><CostCenterPicker value={t.costCenterId} onChange={(id) => setTargets((ts) => ts.map((x, i) => (i === idx ? { ...x, costCenterId: id } : x)))} costCenters={centers} /></div>
              <Input type="number" step="0.01" value={t.percentage ?? 0} onChange={(e) => setTargets((ts) => ts.map((x, i) => (i === idx ? { ...x, percentage: Number(e.target.value) } : x)))} className="h-9 w-24 text-right" />
              <span className="text-xs text-slate-400">%</span>
            </div>
          ))}
          <Button variant="ghost" size="sm" onClick={() => setTargets((ts) => [...ts, { costCenterId: '', percentage: 0, sortOrder: ts.length }])}>+ Add target</Button>
          <div className="mt-3 flex justify-end gap-2"><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={saveRule} disabled={Math.abs(pctTotal - 100) > 0.01}>Create rule</Button></div>
          {Math.abs(pctTotal - 100) > 0.01 && <p className="mt-1 text-right text-xs text-amber-600">Target percentages must total 100%.</p>}
        </CardBody></Card>
      )}

      <Card className="mb-4"><CardBody className="flex flex-wrap items-end gap-2">
        <Field label="Period start"><Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className="h-9" /></Field>
        <Field label="Period end"><Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="h-9" /></Field>
        <Field label="Source amount override"><Input type="number" step="0.01" value={override} onChange={(e) => setOverride(e.target.value === '' ? '' : Number(e.target.value))} placeholder="auto from journals" className="h-9 text-right" /></Field>
      </CardBody></Card>

      {rules.length === 0 ? (
        <Card><CardBody><EmptyState icon={RefreshCw} title="No allocation rules" description="Create a rule to reallocate a shared cost across cost centers. The allocation journal nets to zero at the entity level — only the cost-center dimension shifts." /></CardBody></Card>
      ) : (
        <Card className="mb-4 overflow-hidden"><div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>{['Rule', 'Source', 'Account', 'Targets', 'Method', ''].map((h) => <th key={h} className="px-3 py-2 text-left font-semibold">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rules.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2"><span className="font-mono text-xs font-semibold">{r.code}</span> {r.name}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{r.sourceCostCenterId ? ccName(r.sourceCostCenterId) : '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{accounts.find((a) => a.id === r.allocationAccountId)?.code ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{r.targets.map((t) => `${ccName(t.costCenterId)} ${t.percentage}%`).join(', ')}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{r.method}</td>
                  <td className="px-3 py-2 text-right"><Button size="sm" variant="secondary" onClick={() => runRule(r.id)}><Send className="h-4 w-4" /> Run &amp; post</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></Card>
      )}

      {runs.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:border-slate-800">Allocation runs</div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>{['Rule', 'Period', 'Source', 'Allocated', 'Status', 'Journal', ''].map((h) => <th key={h} className={cx('px-3 py-2 font-semibold', ['Source', 'Allocated'].includes(h) ? 'text-right' : 'text-left')}>{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {runs.map((run) => {
                  const rule = rules.find((r) => r.id === run.ruleId);
                  return (
                    <tr key={run.id}>
                      <td className="px-3 py-2 font-mono text-xs font-semibold">{rule?.code ?? run.ruleId}</td>
                      <td className="px-3 py-2 text-xs text-slate-500">{run.periodStart}…{run.periodEnd}</td>
                      <td className="px-3 py-2 text-right font-mono">{money(run.sourceAmount)}</td>
                      <td className="px-3 py-2 text-right font-mono">{money(run.allocatedAmount)}</td>
                      <td className="px-3 py-2"><Badge tone={RUN_TONE[run.status] ?? 'slate'}>{run.status}</Badge></td>
                      <td className="px-3 py-2 text-xs">{run.journalEntryId ? <Badge tone="green">posted</Badge> : '—'}</td>
                      <td className="px-3 py-2 text-right">{run.status === 'posted' && <Button size="sm" variant="danger" onClick={() => { const reason = window.prompt('Reversal reason?'); if (reason?.trim()) act(() => store.reverseRun(run.id, reason.trim()), 'Run reversed.'); }}><Ban className="h-4 w-4" /> Reverse</Button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

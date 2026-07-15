import { useState } from 'react';
import { Plus, ChevronDown, CalendarClock, Lock, FileCheck2, Unlock } from 'lucide-react';
import type { TaxPeriodStatus } from '@/types/taxReporting';
import { useTaxCodeStore } from '@/store/taxCodeStore';
import { useTaxPeriodStore } from '@/store/taxPeriodStore';
import { cn as cx } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import type { BadgeTone } from '@/data/ifrsOptions';
import { Dropdown, MenuItem } from '@/components/ui/Dropdown';
import { PageActions } from '@/components/ui/PageActions';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';

const TONE: Record<TaxPeriodStatus, BadgeTone> = { open: 'green', prepared: 'amber', filed: 'blue', locked: 'red', reopened: 'violet' };

export function TaxPeriodsPage() {
  const jurisdictions = useTaxCodeStore((s) => s.jurisdictions);
  const periods = useTaxPeriodStore((s) => s.periods);
  const store = useTaxPeriodStore();
  const { notify } = useToast();

  const [jurisdictionId, setJurisdictionId] = useState(jurisdictions[0]?.id ?? '');
  const [periodStart, setPeriodStart] = useState('2026-01-01');
  const [periodEnd, setPeriodEnd] = useState('2026-03-31');

  const jurName = (id: string): string => jurisdictions.find((j) => j.id === id)?.name ?? id;
  const act = (fn: () => { ok: boolean; error?: string }, ok: string): void => { const r = fn(); if (r.ok) notify(ok, 'success'); else notify(r.error ?? 'Action failed.', 'error'); };

  const create = (): void => {
    if (!jurisdictionId) { notify('Create a jurisdiction first.', 'error'); return; }
    act(() => store.createPeriod({ entityId: 'primary', jurisdictionId, periodStart, periodEnd }), 'Tax period created.');
  };
  const reopen = (id: string): void => {
    const reason = window.prompt('Reason for reopening this tax period?');
    if (reason && reason.trim()) act(() => store.reopenPeriod(id, reason.trim()), 'Tax period reopened.');
  };

  return (
    <>
      <PageActions>
        <div className="flex flex-wrap items-end gap-2">
          <Select className="h-9 w-auto" options={jurisdictions.map((j) => ({ value: j.id, label: j.code }))} value={jurisdictionId} onChange={(e) => setJurisdictionId(e.target.value)} aria-label="Jurisdiction" />
          <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className="h-9" />
          <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="h-9" />
          <Button onClick={create}><Plus className="h-4 w-4" /> New period</Button>
        </div>
      </PageActions>

      {periods.length === 0 ? (
        <Card><CardBody><EmptyState icon={CalendarClock} title="No tax periods" description="Create tax periods to prepare, file and lock returns. Locking a period blocks backdated taxable documents and tax-snapshot edits into it." /></CardBody></Card>
      ) : (
        <Card className="overflow-hidden"><div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>
              {['Jurisdiction', 'Start', 'End', 'Status', 'Filed', ''].map((h) => <th key={h} className="px-3 py-2 text-left font-semibold">{h}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {periods.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/20">
                  <td className="px-3 py-2">{jurName(p.jurisdictionId)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{p.periodStart}</td>
                  <td className="px-3 py-2 font-mono text-xs">{p.periodEnd}</td>
                  <td className="px-3 py-2"><Badge tone={TONE[p.status]}>{p.status}</Badge></td>
                  <td className="px-3 py-2 text-xs text-slate-500">{p.filedReference ?? '—'}</td>
                  <td className="px-3 py-2 text-right">
                    <Dropdown label="Actions" align="right" trigger={(o) => (<span className={cx('inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300', o && 'bg-slate-50')}>Actions <ChevronDown className="h-3 w-3" /></span>)}>
                      {(p.status === 'open' || p.status === 'reopened') && <MenuItem onClick={() => act(() => store.setStatus(p.id, 'prepared'), 'Marked prepared.')}><FileCheck2 className="h-4 w-4" /> Mark prepared</MenuItem>}
                      {(p.status === 'open' || p.status === 'prepared' || p.status === 'reopened') && <MenuItem onClick={() => act(() => store.filePeriod(p.id, window.prompt('Filing reference?') ?? undefined), 'Period filed.')}><FileCheck2 className="h-4 w-4" /> File</MenuItem>}
                      {p.status !== 'locked' && <MenuItem onClick={() => act(() => store.lockPeriod(p.id), 'Period locked.')}><Lock className="h-4 w-4" /> Lock</MenuItem>}
                      {(p.status === 'filed' || p.status === 'locked') && <MenuItem onClick={() => reopen(p.id)}><Unlock className="h-4 w-4" /> Reopen</MenuItem>}
                    </Dropdown>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></Card>
      )}
    </>
  );
}

import { useMemo, useState } from 'react';
import { Plus, CheckCircle2, Wand2 } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { useCostCenterStore } from '@/store/costCenterStore';
import { useCostCenterBudgetStore } from '@/store/costCenterBudgetStore';
import { calculateCostCenterBudgetActual } from '@/lib/costCenterBudget';
import { formatCurrency } from '@/lib/money';
import { cn as cx } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import type { BadgeTone } from '@/data/ifrsOptions';
import { PageActions } from '@/components/ui/PageActions';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { AccountSelect } from '@/components/journal/AccountSelect';
import { CostCenterPicker } from '@/components/cost-centers/CostCenterPicker';

const STATUS_TONE: Record<string, BadgeTone> = { draft: 'slate', submitted: 'indigo', approved: 'green', locked: 'blue', archived: 'red' };

export function CostCenterBudgetsPage() {
  const accounts = useStore((s) => s.accounts);
  const base = useStore((s) => s.settings.baseCurrency);
  const entries = useJournalStore((s) => s.entries);
  const centers = useCostCenterStore((s) => s.costCenters);
  const budgets = useCostCenterBudgetStore((s) => s.budgets);
  const store = useCostCenterBudgetStore();
  const { notify } = useToast();
  const money = (n: number): string => formatCurrency(n, base);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ccId, setCcId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [annual, setAnnual] = useState(0);
  const [throughMonth, setThroughMonth] = useState(12);

  const budget = selectedId ? budgets.find((b) => b.id === selectedId) : budgets[0];
  const ccName = (id: string): string => centers.find((c) => c.id === id)?.code ?? id;
  const accName = (id: string): string => accounts.find((a) => a.id === id)?.code ?? id;
  const act = (fn: () => { ok: boolean; error?: string }, ok: string): void => { const r = fn(); if (r.ok) notify(ok, 'success'); else notify(r.error ?? 'Action failed.', 'error'); };

  const vsActual = useMemo(
    () => (budget ? calculateCostCenterBudgetActual({ budget, entries, accounts, base, throughMonth }) : null),
    [budget, entries, accounts, base, throughMonth],
  );

  const newBudget = (): void => { const r = store.createBudget({ name: `Budget ${new Date().getFullYear()}`, fiscalYear: new Date().getFullYear(), currencyCode: base }); if (r.ok && r.id) setSelectedId(r.id); };
  const addSpread = (): void => {
    if (!budget || !ccId || !accountId || !annual) { notify('Pick a cost center, account and annual amount.', 'error'); return; }
    act(() => store.spreadAnnual(budget.id, ccId, accountId, Number(annual)), 'Annual amount spread across 12 months.');
    setAnnual(0);
  };

  return (
    <>
      <PageActions><Button onClick={newBudget}><Plus className="h-4 w-4" /> New budget</Button></PageActions>

      {budgets.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {budgets.map((b) => (
            <button key={b.id} onClick={() => setSelectedId(b.id)} className={cx('rounded-lg border px-2.5 py-1.5 text-xs', budget?.id === b.id ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/10' : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700')}>
              {b.name} · {b.fiscalYear} <Badge tone={STATUS_TONE[b.status] ?? 'slate'} className="ml-1">{b.status}</Badge>
            </button>
          ))}
        </div>
      )}

      {!budget ? (
        <Card><CardBody><EmptyState icon={Plus} title="No budgets" description="Create a cost-center budget (monthly values, annual roll-up). Budgets are management data — never posted to the ledger. Actuals derive from posted journals." /></CardBody></Card>
      ) : (
        <>
          {(budget.status === 'draft' || budget.status === 'submitted') && (
            <Card className="mb-4"><CardBody>
              <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-5">
                <Field label="Cost center"><CostCenterPicker value={ccId} onChange={setCcId} costCenters={centers} /></Field>
                <Field label="Account"><AccountSelect value={accountId} accounts={accounts} onChange={(a) => setAccountId(a.id)} /></Field>
                <Field label="Annual amount"><Input type="number" step="0.01" value={annual} onChange={(e) => setAnnual(Number(e.target.value))} className="text-right" /></Field>
                <div className="sm:col-span-2 flex gap-2">
                  <Button variant="outline" onClick={addSpread}><Wand2 className="h-4 w-4" /> Spread across 12 months</Button>
                  <Button variant="secondary" onClick={() => act(() => store.approveBudget(budget.id), 'Budget approved (now immutable).')}><CheckCircle2 className="h-4 w-4" /> Approve</Button>
                </div>
              </div>
            </CardBody></Card>
          )}

          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2 dark:border-slate-800">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Budget vs actual</span>
              <label className="text-xs text-slate-500">Through month <Select className="ml-1 inline-block h-7 w-auto" options={Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} value={String(throughMonth)} onChange={(e) => setThroughMonth(Number(e.target.value))} /></label>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>
                  {['Cost center', 'Account', 'Budget YTD', 'Actual YTD', 'Variance', 'Var %', ''].map((h) => <th key={h} className={cx('px-3 py-2 font-semibold', ['Budget YTD', 'Actual YTD', 'Variance', 'Var %'].includes(h) ? 'text-right' : 'text-left')}>{h}</th>)}
                </tr></thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {!vsActual || vsActual.rows.length === 0 ? <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">No budget lines or actuals yet.</td></tr> : vsActual.rows.map((r) => (
                    <tr key={`${r.costCenterId}-${r.accountId}`}>
                      <td className="px-3 py-2 font-mono text-xs">{ccName(r.costCenterId)}</td>
                      <td className="px-3 py-2 font-mono text-xs">{accName(r.accountId)}</td>
                      <td className="px-3 py-2 text-right font-mono">{money(r.budget)}</td>
                      <td className="px-3 py-2 text-right font-mono">{money(r.actual)}</td>
                      <td className="px-3 py-2 text-right font-mono">{money(r.variance)}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-500">{r.variancePercent === null ? '—' : `${r.variancePercent}%`}</td>
                      <td className="px-3 py-2"><Badge tone={r.favorable ? 'green' : 'red'}>{r.favorable ? 'favorable' : 'unfavorable'}</Badge></td>
                    </tr>
                  ))}
                </tbody>
                {vsActual && vsActual.rows.length > 0 && <tfoot><tr className="border-t-2 border-slate-200 font-semibold dark:border-slate-700"><td className="px-3 py-2" colSpan={2}>Totals</td><td className="px-3 py-2 text-right font-mono">{money(vsActual.totalBudget)}</td><td className="px-3 py-2 text-right font-mono">{money(vsActual.totalActual)}</td><td className="px-3 py-2 text-right font-mono">{money(vsActual.totalVariance)}</td><td colSpan={2} /></tr></tfoot>}
              </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
}

import { useMemo, useState } from 'react';
import { RefreshCw, Ban } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { useProjectStore } from '@/store/projectStore';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useBillStore } from '@/store/billStore';
import { useCreditNoteStore } from '@/store/creditNoteStore';
import { useReceiptStore } from '@/store/receiptStore';
import { usePaymentStore } from '@/store/paymentStore';
import { useProjectBudgetStore } from '@/store/projectBudgetStore';
import { useProjectRecognitionStore } from '@/store/projectRecognitionStore';
import { useProjectDeliveryStore } from '@/store/projectDeliveryStore';
import { buildProjectIncomeStatement, buildProjectLedger } from '@/lib/projectReporting';
import { buildProjectProfitability, buildProjectCashFlow } from '@/lib/projectProfitability';
import { calculateProjectBudgetActual } from '@/lib/projectBudget';
import { formatCurrency } from '@/lib/money';
import { cn as cx } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';

type ReportType = 'profitability' | 'cash-flow' | 'income-statement' | 'ledger' | 'budget-vs-actual' | 'revenue-recognition';

export function ProjectReportsPage() {
  const base = useStore((s) => s.settings.baseCurrency);
  const accounts = useStore((s) => s.accounts);
  const entries = useJournalStore((s) => s.entries);
  const projects = useProjectStore((s) => s.projects);
  const invoices = useInvoiceStore((s) => s.invoices);
  const bills = useBillStore((s) => s.bills);
  const creditNotes = useCreditNoteStore((s) => s.creditNotes);
  const receipts = useReceiptStore((s) => s.receipts);
  const payments = usePaymentStore((s) => s.payments);
  const budgets = useProjectBudgetStore((s) => s.budgets);
  const runs = useProjectRecognitionStore((s) => s.runs);
  const openCommitment = useProjectDeliveryStore((s) => s.openCommitment);
  const recognitionStore = useProjectRecognitionStore();
  const { notify } = useToast();

  const [prjId, setPrjId] = useState(projects[0]?.id ?? '');
  const [from, setFrom] = useState('2026-01-01');
  const [to, setTo] = useState('2026-12-31');
  const [report, setReport] = useState<ReportType>('profitability');

  const money = (n: number): string => formatCurrency(n, base);
  const project = projects.find((p) => p.id === prjId);

  const profitability = useMemo(() => (project ? buildProjectProfitability({ project, entries, accounts, invoices, bills, creditNotes, receipts, payments, base, committedCost: openCommitment(project.id) }) : null), [project, entries, accounts, invoices, bills, creditNotes, receipts, payments, base, openCommitment]);
  const cashFlow = useMemo(() => (prjId ? buildProjectCashFlow(prjId, { invoices, bills, receipts, payments }) : null), [prjId, invoices, bills, receipts, payments]);
  const is = useMemo(() => (report === 'income-statement' && prjId ? buildProjectIncomeStatement(entries, accounts, prjId, { from, to, base }) : null), [report, prjId, entries, accounts, from, to, base]);
  const ledger = useMemo(() => (report === 'ledger' && prjId ? buildProjectLedger(entries, accounts, prjId, { from, to, base }) : null), [report, prjId, entries, accounts, from, to, base]);
  const budget = useMemo(() => budgets.filter((b) => b.projectId === prjId).slice(-1)[0], [budgets, prjId]);
  const bva = useMemo(() => (report === 'budget-vs-actual' && budget ? calculateProjectBudgetActual({ budget, entries, accounts, base }) : null), [report, budget, entries, accounts, base]);
  const projectRuns = useMemo(() => runs.filter((r) => r.projectId === prjId), [runs, prjId]);

  const act = (fn: () => { ok: boolean; error?: string; id?: string }, ok: string): void => { const r = fn(); if (r.ok) notify(ok, 'success'); else notify(r.error ?? 'Action failed.', 'error'); };
  const recognize = (): void => act(() => { const built = recognitionStore.buildRun(prjId, to); if (!built.ok || !built.id) return built; return recognitionStore.postRun(built.id); }, 'Revenue recognised & posted.');

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900">
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Project<Select className="mt-1 h-9 w-auto" options={projects.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} value={prjId} onChange={(e) => setPrjId(e.target.value)} /></label>
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Report<Select className="mt-1 h-9 w-auto" options={[{ value: 'profitability', label: 'Profitability' }, { value: 'cash-flow', label: 'Cash Flow' }, { value: 'income-statement', label: 'Income Statement' }, { value: 'ledger', label: 'General Ledger' }, { value: 'budget-vs-actual', label: 'Budget vs Actual' }, { value: 'revenue-recognition', label: 'Revenue Recognition' }]} value={report} onChange={(e) => setReport(e.target.value as ReportType)} /></label>
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">From<Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 h-9" /></label>
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">To<Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 h-9" /></label>
      </div>

      {report === 'profitability' && profitability && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card><CardBody>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Contract & revenue</h3>
            <table className="min-w-full text-sm"><tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              <Row label="Original contract value" value={money(profitability.originalContractValue)} />
              <Row label="Approved change orders" value={money(profitability.approvedChangeOrders)} />
              <Row label="Revised contract value" value={money(profitability.revisedContractValue)} strong />
              <Row label="Billed revenue" value={money(profitability.billedRevenue)} />
              <Row label="Recognised revenue" value={money(profitability.recognizedRevenue)} />
              <Row label="Cash collected" value={money(profitability.cashCollected)} />
              <Row label="Receivable balance" value={money(profitability.receivableBalance)} />
            </tbody></table>
          </CardBody></Card>
          <Card><CardBody>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Cost & margin</h3>
            <table className="min-w-full text-sm"><tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              <Row label="Actual cost" value={money(profitability.actualCost)} />
              <Row label="Committed cost" value={money(profitability.committedCost)} />
              <Row label="Forecast cost to complete" value={money(profitability.forecastCostToComplete)} />
              <Row label="Estimated total cost" value={money(profitability.estimatedTotalCost)} />
              <Row label="Gross profit" value={`${money(profitability.grossProfit)}${profitability.grossMarginPercent === null ? '' : ` (${profitability.grossMarginPercent}%)`}`} strong />
              <Row label="Forecast profit" value={`${money(profitability.forecastProfit)}${profitability.forecastMarginPercent === null ? '' : ` (${profitability.forecastMarginPercent}%)`}`} strong />
              <Row label="Payable balance" value={money(profitability.payableBalance)} />
            </tbody></table>
          </CardBody></Card>
        </div>
      )}

      {report === 'cash-flow' && cashFlow && (
        <Card><CardBody>
          <p className="mb-2 text-xs text-slate-500">Cash from receipts allocated to project invoices, less payments allocated to project bills. Invoices and bills are not cash movements.</p>
          <table className="min-w-full text-sm"><tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            <Row label="Cash inflow (receipts → project invoices)" value={money(cashFlow.cashInflow)} />
            <Row label="Cash outflow (payments → project bills)" value={money(cashFlow.cashOutflow)} />
            <Row label={cashFlow.netCash >= 0 ? 'Net cash inflow' : 'Net cash outflow'} value={money(Math.abs(cashFlow.netCash))} strong />
          </tbody></table>
        </CardBody></Card>
      )}

      {report === 'income-statement' && is && (
        <Card><CardBody>
          <table className="min-w-full text-sm"><tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            <Row label="Revenue" value={money(is.revenue)} />
            <Row label="Cost of sales" value={money(is.costOfSales)} />
            <Row label="Gross profit" value={money(is.grossProfit)} strong />
            <Row label="Operating expenses" value={money(is.operatingExpenses)} />
            <Row label="Operating profit" value={money(is.operatingProfit)} strong />
            <Row label="Net result" value={money(is.netResult)} strong />
          </tbody></table>
        </CardBody></Card>
      )}

      {report === 'ledger' && ledger && (
        <Card className="overflow-hidden"><div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>{['Date', 'Journal', 'Account', 'Description', 'Debit', 'Credit'].map((h) => <th key={h} className={cx('px-3 py-2 font-semibold', ['Debit', 'Credit'].includes(h) ? 'text-right' : 'text-left')}>{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {ledger.length === 0 ? <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No ledger lines tagged to this project.</td></tr> : ledger.map((l) => (
                <tr key={l.id}>
                  <td className="px-3 py-2 text-xs text-slate-500">{l.date}</td>
                  <td className="px-3 py-2 font-mono text-xs">{l.journalNumber}</td>
                  <td className="px-3 py-2"><span className="font-mono text-xs font-semibold">{l.accountCode}</span> {l.accountName}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{l.description}</td>
                  <td className="px-3 py-2 text-right font-mono">{l.debit ? money(l.debit) : '—'}</td>
                  <td className="px-3 py-2 text-right font-mono">{l.credit ? money(l.credit) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></Card>
      )}

      {report === 'budget-vs-actual' && (
        !bva ? <Card><CardBody><p className="py-6 text-center text-sm text-slate-400">No budget exists for this project yet. Create one from the Projects page.</p></CardBody></Card> : (
          <Card><CardBody>
            <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric label="Budget revenue" value={money(bva.budgetRevenue)} />
              <Metric label="Actual revenue" value={money(bva.actualRevenue)} />
              <Metric label="Budget cost" value={money(bva.budgetCost)} />
              <Metric label="Actual cost" value={money(bva.actualCost)} />
            </div>
            <table className="min-w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-slate-400"><tr>{['Category', 'Budget', 'Actual', 'Variance', ''].map((h) => <th key={h} className={cx('px-3 py-2 font-semibold', ['Budget', 'Actual', 'Variance'].includes(h) ? 'text-right' : 'text-left')}>{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {bva.rows.map((r) => (
                  <tr key={r.category}>
                    <td className="px-3 py-2 capitalize">{r.category}</td>
                    <td className="px-3 py-2 text-right font-mono">{money(r.budget)}</td>
                    <td className="px-3 py-2 text-right font-mono">{money(r.actual)}</td>
                    <td className="px-3 py-2 text-right font-mono">{money(r.variance)}</td>
                    <td className="px-3 py-2"><Badge tone={r.favorable ? 'green' : 'red'}>{r.favorable ? 'favorable' : 'unfavorable'}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody></Card>
        )
      )}

      {report === 'revenue-recognition' && (
        <>
          <Card className="mb-4"><CardBody className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <span className="text-xs text-slate-500">Method: </span><span className="font-semibold">{project?.revenueRecognitionMethod ?? 'invoice'}</span>
              {profitability && <span className="ml-4 text-xs text-slate-500">Recognised {money(profitability.recognizedRevenue)} of {money(profitability.revisedContractValue)}</span>}
            </div>
            <Button onClick={recognize}><RefreshCw className="h-4 w-4" /> Recognise as of {to} &amp; post</Button>
          </CardBody></Card>
          <Card className="overflow-hidden"><div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>{['As of', 'Method', '% complete', 'Cumulative', 'This period', 'Status', ''].map((h) => <th key={h} className={cx('px-3 py-2 font-semibold', ['% complete', 'Cumulative', 'This period'].includes(h) ? 'text-right' : 'text-left')}>{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {projectRuns.length === 0 ? <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">No recognition runs yet.</td></tr> : projectRuns.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 font-mono text-xs">{r.asOfDate}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{r.method}</td>
                    <td className="px-3 py-2 text-right font-mono">{r.completionPercent}%</td>
                    <td className="px-3 py-2 text-right font-mono">{money(r.targetCumulative)}</td>
                    <td className="px-3 py-2 text-right font-mono">{money(r.currentPeriodAmount)}</td>
                    <td className="px-3 py-2"><Badge tone={r.status === 'posted' ? 'green' : r.status === 'reversed' ? 'red' : 'slate'}>{r.status}</Badge></td>
                    <td className="px-3 py-2 text-right">{r.status === 'posted' && <Button size="sm" variant="danger" onClick={() => { const reason = window.prompt('Reversal reason?'); if (reason?.trim()) act(() => recognitionStore.reverseRun(r.id, reason.trim()), 'Recognition reversed.'); }}><Ban className="h-4 w-4" /> Reverse</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div></Card>
        </>
      )}
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return <tr className={strong ? 'font-semibold' : ''}><td className="px-3 py-2">{label}</td><td className="px-3 py-2 text-right font-mono">{value}</td></tr>;
}
function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-slate-200 p-2 dark:border-slate-800"><p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p><p className="font-mono text-sm font-semibold">{value}</p></div>;
}

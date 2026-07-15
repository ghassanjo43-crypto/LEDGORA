import { useMemo, useState } from 'react';
import { Plus, CheckCircle2, FileText } from 'lucide-react';
import type { Project } from '@/types/project';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useProjectStore } from '@/store/projectStore';
import { useProjectDeliveryStore } from '@/store/projectDeliveryStore';
import { useInvoiceStore } from '@/store/invoiceStore';
import { buildProjectBillingSuggestion } from '@/lib/projectBilling';
import { buildContractValueSummary } from '@/lib/projectContract';
import { formatCurrency } from '@/lib/money';
import { cn as cx, generateId } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';

type Tab = 'time' | 'expenses' | 'commitments' | 'milestones' | 'change-orders' | 'billing';
const TABS: { key: Tab; label: string }[] = [
  { key: 'time', label: 'Time' }, { key: 'expenses', label: 'Expenses' }, { key: 'commitments', label: 'Commitments' },
  { key: 'milestones', label: 'Milestones' }, { key: 'change-orders', label: 'Change Orders' }, { key: 'billing', label: 'Billing' },
];

export function ProjectDeliveryPage() {
  const projects = useProjectStore((s) => s.projects);
  const [prjId, setPrjId] = useState(projects[0]?.id ?? '');
  const [tab, setTab] = useState<Tab>('time');
  const project = projects.find((p) => p.id === prjId);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900">
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Project<Select className="mt-1 h-9 w-auto" options={projects.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} value={prjId} onChange={(e) => setPrjId(e.target.value)} /></label>
        <div className="ml-auto inline-flex flex-wrap rounded-lg border border-slate-200 p-0.5 text-xs dark:border-slate-700">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)} className={cx('rounded-md px-2.5 py-1', tab === t.key ? 'bg-brand-500 text-white' : 'text-slate-600 dark:text-slate-300')}>{t.label}</button>
          ))}
        </div>
      </div>

      {!project ? (
        <Card><CardBody><p className="py-6 text-center text-sm text-slate-400">Select a project.</p></CardBody></Card>
      ) : tab === 'time' ? <TimeSection project={project} />
        : tab === 'expenses' ? <ExpenseSection project={project} />
        : tab === 'commitments' ? <CommitmentSection project={project} />
        : tab === 'milestones' ? <MilestoneSection project={project} />
        : tab === 'change-orders' ? <ChangeOrderSection project={project} />
        : <BillingSection project={project} />}
    </>
  );
}

function useMoney(): (n: number) => string {
  const base = useStore((s) => s.settings.baseCurrency);
  return (n: number) => formatCurrency(n, base);
}
function notifyResult(notify: (m: string, t?: 'success' | 'error' | 'info') => void, r: { ok: boolean; error?: string }, ok: string): void {
  if (r.ok) notify(ok, 'success'); else notify(r.error ?? 'Action failed.', 'error');
}

/* ─────────────────────────── Time ───────────────────────────── */
function TimeSection({ project }: { project: Project }) {
  const entries = useProjectDeliveryStore((s) => s.timeEntries);
  const store = useProjectDeliveryStore();
  const { notify } = useToast();
  const money = useMoney();
  const [f, setF] = useState({ employeeName: '', date: '2026-05-01', hours: 8, billingRate: 120, costRate: 60, billable: true });
  const rows = useMemo(() => entries.filter((t) => t.projectId === project.id), [entries, project.id]);

  const add = (): void => {
    if (!f.employeeName.trim()) { notify('Enter an employee name.', 'error'); return; }
    notifyResult(notify, store.addTimeEntry({ projectId: project.id, ...f }), 'Time entry added.');
  };

  return (
    <>
      <Card className="mb-4"><CardBody>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
          <Field label="Employee"><Input value={f.employeeName} onChange={(e) => setF({ ...f, employeeName: e.target.value })} /></Field>
          <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label="Hours"><Input type="number" step="0.25" value={f.hours} onChange={(e) => setF({ ...f, hours: Number(e.target.value) })} className="text-right" /></Field>
          <Field label="Bill rate"><Input type="number" value={f.billingRate} onChange={(e) => setF({ ...f, billingRate: Number(e.target.value) })} className="text-right" /></Field>
          <Field label="Cost rate"><Input type="number" value={f.costRate} onChange={(e) => setF({ ...f, costRate: Number(e.target.value) })} className="text-right" /></Field>
          <div className="flex items-end"><Button onClick={add}><Plus className="h-4 w-4" /> Add</Button></div>
        </div>
        <label className="mt-2 flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300"><input type="checkbox" checked={f.billable} onChange={(e) => setF({ ...f, billable: e.target.checked })} /> Billable</label>
      </CardBody></Card>
      <TableCard headers={['Employee', 'Date', 'Hours', 'Billable amt', 'Cost amt', 'Status', 'Billed', '']} empty={rows.length === 0} emptyText="No time entries.">
        {rows.map((t) => (
          <tr key={t.id}>
            <td className="px-3 py-2">{t.employeeName}</td>
            <td className="px-3 py-2 font-mono text-xs">{t.date}</td>
            <td className="px-3 py-2 text-right font-mono">{t.hours}</td>
            <td className="px-3 py-2 text-right font-mono">{money(t.billableAmount)}</td>
            <td className="px-3 py-2 text-right font-mono text-slate-500">{money(t.costAmount)}</td>
            <td className="px-3 py-2"><Badge tone={t.approvalStatus === 'approved' ? 'green' : 'slate'}>{t.approvalStatus}</Badge></td>
            <td className="px-3 py-2">{t.billed ? <Badge tone="blue">billed</Badge> : t.billable ? <span className="text-xs text-slate-400">unbilled</span> : <span className="text-xs text-slate-400">n/a</span>}</td>
            <td className="px-3 py-2 text-right">{t.approvalStatus !== 'approved' && <Button size="sm" variant="outline" onClick={() => notifyResult(notify, store.approveTime(t.id), 'Approved.')}><CheckCircle2 className="h-4 w-4" /> Approve</Button>}</td>
          </tr>
        ))}
      </TableCard>
    </>
  );
}

/* ─────────────────────────── Expenses ───────────────────────────── */
function ExpenseSection({ project }: { project: Project }) {
  const expenses = useProjectDeliveryStore((s) => s.expenses);
  const store = useProjectDeliveryStore();
  const { notify } = useToast();
  const money = useMoney();
  const [f, setF] = useState({ date: '2026-05-01', description: '', amount: 500, markupPercent: 10, billable: true });
  const rows = useMemo(() => expenses.filter((e) => e.projectId === project.id), [expenses, project.id]);

  const add = (): void => {
    if (!f.description.trim()) { notify('Enter a description.', 'error'); return; }
    notifyResult(notify, store.addExpense({ projectId: project.id, ...f }), 'Expense added.');
  };

  return (
    <>
      <Card className="mb-4"><CardBody>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
          <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label="Description" className="sm:col-span-2"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Field label="Amount"><Input type="number" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: Number(e.target.value) })} className="text-right" /></Field>
          <Field label="Markup %"><Input type="number" value={f.markupPercent} onChange={(e) => setF({ ...f, markupPercent: Number(e.target.value) })} className="text-right" /></Field>
          <div className="flex items-end"><Button onClick={add}><Plus className="h-4 w-4" /> Add</Button></div>
        </div>
        <label className="mt-2 flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300"><input type="checkbox" checked={f.billable} onChange={(e) => setF({ ...f, billable: e.target.checked })} /> Billable</label>
      </CardBody></Card>
      <TableCard headers={['Date', 'Description', 'Amount', 'Billable amt', 'Status', 'Billed', '']} empty={rows.length === 0} emptyText="No expenses.">
        {rows.map((e) => (
          <tr key={e.id}>
            <td className="px-3 py-2 font-mono text-xs">{e.date}</td>
            <td className="px-3 py-2">{e.description}</td>
            <td className="px-3 py-2 text-right font-mono">{money(e.amount)}</td>
            <td className="px-3 py-2 text-right font-mono">{money(e.billableAmount)}</td>
            <td className="px-3 py-2"><Badge tone={e.approvalStatus === 'approved' ? 'green' : 'slate'}>{e.approvalStatus}</Badge></td>
            <td className="px-3 py-2">{e.billed ? <Badge tone="blue">billed</Badge> : e.billable ? <span className="text-xs text-slate-400">unbilled</span> : <span className="text-xs text-slate-400">n/a</span>}</td>
            <td className="px-3 py-2 text-right">{e.approvalStatus !== 'approved' && <Button size="sm" variant="outline" onClick={() => notifyResult(notify, store.approveExpense(e.id), 'Approved.')}><CheckCircle2 className="h-4 w-4" /> Approve</Button>}</td>
          </tr>
        ))}
      </TableCard>
    </>
  );
}

/* ─────────────────────────── Commitments ───────────────────────────── */
function CommitmentSection({ project }: { project: Project }) {
  const commitments = useProjectDeliveryStore((s) => s.commitments);
  const store = useProjectDeliveryStore();
  const { notify } = useToast();
  const money = useMoney();
  const [f, setF] = useState<{ type: 'purchase-order' | 'subcontract' | 'manual'; reference: string; committedAmount: number; date: string }>({ type: 'purchase-order', reference: '', committedAmount: 10000, date: '2026-03-01' });
  const rows = useMemo(() => commitments.filter((c) => c.projectId === project.id), [commitments, project.id]);

  const add = (): void => {
    if (!f.reference.trim()) { notify('Enter a reference.', 'error'); return; }
    notifyResult(notify, store.addCommitment({ projectId: project.id, ...f }), 'Commitment added.');
  };
  const recordInvoiced = (id: string): void => { const v = window.prompt('Invoiced amount?'); if (v) notifyResult(notify, store.recordCommitmentInvoiced(id, Number(v)), 'Recorded.'); };

  return (
    <>
      <Card className="mb-4"><CardBody>
        <p className="mb-2 text-xs text-slate-500">Commitments are management data — they do not post to the General Ledger.</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Field label="Type"><Select options={[{ value: 'purchase-order', label: 'Purchase order' }, { value: 'subcontract', label: 'Subcontract' }, { value: 'manual', label: 'Manual' }]} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as typeof f.type })} /></Field>
          <Field label="Reference"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
          <Field label="Committed"><Input type="number" step="0.01" value={f.committedAmount} onChange={(e) => setF({ ...f, committedAmount: Number(e.target.value) })} className="text-right" /></Field>
          <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <div className="flex items-end"><Button onClick={add}><Plus className="h-4 w-4" /> Add</Button></div>
        </div>
      </CardBody></Card>
      <TableCard headers={['Type', 'Reference', 'Committed', 'Invoiced', 'Remaining', 'Status', '']} empty={rows.length === 0} emptyText="No commitments.">
        {rows.map((c) => (
          <tr key={c.id}>
            <td className="px-3 py-2 text-xs text-slate-500">{c.type}</td>
            <td className="px-3 py-2 font-mono text-xs">{c.reference}</td>
            <td className="px-3 py-2 text-right font-mono">{money(c.committedAmount)}</td>
            <td className="px-3 py-2 text-right font-mono text-slate-500">{money(c.invoicedAmount)}</td>
            <td className="px-3 py-2 text-right font-mono font-semibold">{money(Math.max(0, c.committedAmount - c.invoicedAmount))}</td>
            <td className="px-3 py-2"><Badge tone={c.status === 'open' ? 'green' : 'slate'}>{c.status}</Badge></td>
            <td className="px-3 py-2 text-right">{c.status === 'open' && <div className="flex justify-end gap-1"><Button size="sm" variant="outline" onClick={() => recordInvoiced(c.id)}>Record invoiced</Button><Button size="sm" variant="ghost" onClick={() => notifyResult(notify, store.closeCommitment(c.id), 'Closed.')}>Close</Button></div>}</td>
          </tr>
        ))}
      </TableCard>
    </>
  );
}

/* ─────────────────────────── Milestones ───────────────────────────── */
function MilestoneSection({ project }: { project: Project }) {
  const store = useProjectStore();
  const { notify } = useToast();
  const money = useMoney();
  const [f, setF] = useState({ name: '', plannedDate: '2026-06-30', billingAmount: 50000, recognitionAmount: 50000 });
  const rows = project.milestones ?? [];

  const add = (): void => {
    if (!f.name.trim()) { notify('Enter a milestone name.', 'error'); return; }
    notifyResult(notify, store.upsertMilestone(project.id, { id: generateId('pms'), name: f.name, plannedDate: f.plannedDate, status: 'planned', billingAmount: f.billingAmount, recognitionAmount: f.recognitionAmount }), 'Milestone added.');
  };

  return (
    <>
      <Card className="mb-4"><CardBody>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Field label="Name" className="sm:col-span-2"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Planned date"><Input type="date" value={f.plannedDate} onChange={(e) => setF({ ...f, plannedDate: e.target.value })} /></Field>
          <Field label="Billing amount"><Input type="number" step="0.01" value={f.billingAmount} onChange={(e) => setF({ ...f, billingAmount: Number(e.target.value), recognitionAmount: Number(e.target.value) })} className="text-right" /></Field>
          <div className="flex items-end"><Button onClick={add}><Plus className="h-4 w-4" /> Add</Button></div>
        </div>
      </CardBody></Card>
      <TableCard headers={['Milestone', 'Planned', 'Billing', 'Recognition', 'Status', '']} empty={rows.length === 0} emptyText="No milestones.">
        {rows.map((m) => (
          <tr key={m.id}>
            <td className="px-3 py-2">{m.name}</td>
            <td className="px-3 py-2 font-mono text-xs text-slate-500">{m.plannedDate ?? '—'}</td>
            <td className="px-3 py-2 text-right font-mono">{money(m.billingAmount)}</td>
            <td className="px-3 py-2 text-right font-mono text-slate-500">{money(m.recognitionAmount ?? m.billingAmount)}</td>
            <td className="px-3 py-2"><Badge tone={m.status === 'completed' ? 'green' : m.status === 'billed' ? 'blue' : 'slate'}>{m.status}</Badge></td>
            <td className="px-3 py-2 text-right">{m.status === 'planned' || m.status === 'in-progress' ? <Button size="sm" variant="outline" onClick={() => notifyResult(notify, store.setMilestoneStatus(project.id, m.id, 'completed'), 'Marked complete.')}><CheckCircle2 className="h-4 w-4" /> Complete</Button> : null}</td>
          </tr>
        ))}
      </TableCard>
    </>
  );
}

/* ─────────────────────────── Change orders ───────────────────────────── */
function ChangeOrderSection({ project }: { project: Project }) {
  const store = useProjectStore();
  const { notify } = useToast();
  const money = useMoney();
  const [f, setF] = useState({ number: '', revenueChange: 0, costChange: 0, scheduleImpactDays: 0, date: '2026-04-01' });
  const rows = project.changeOrders ?? [];
  const summary = buildContractValueSummary(project);

  const add = (): void => {
    if (!f.number.trim()) { notify('Enter a change-order number.', 'error'); return; }
    notifyResult(notify, store.addChangeOrder(project.id, { ...f, status: 'submitted' }), 'Change order added.');
  };

  return (
    <>
      <div className="mb-4 grid grid-cols-3 gap-3">
        <Metric label="Original contract" value={money(summary.originalContractValue)} />
        <Metric label="Approved changes" value={money(summary.approvedRevenueChange)} />
        <Metric label="Revised contract" value={money(summary.revisedContractValue)} strong />
      </div>
      <Card className="mb-4"><CardBody>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
          <Field label="Number"><Input value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} /></Field>
          <Field label="Revenue change"><Input type="number" step="0.01" value={f.revenueChange} onChange={(e) => setF({ ...f, revenueChange: Number(e.target.value) })} className="text-right" /></Field>
          <Field label="Cost change"><Input type="number" step="0.01" value={f.costChange} onChange={(e) => setF({ ...f, costChange: Number(e.target.value) })} className="text-right" /></Field>
          <Field label="Schedule days"><Input type="number" value={f.scheduleImpactDays} onChange={(e) => setF({ ...f, scheduleImpactDays: Number(e.target.value) })} className="text-right" /></Field>
          <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <div className="flex items-end"><Button onClick={add}><Plus className="h-4 w-4" /> Add</Button></div>
        </div>
      </CardBody></Card>
      <TableCard headers={['Number', 'Revenue Δ', 'Cost Δ', 'Days', 'Status', '']} empty={rows.length === 0} emptyText="No change orders.">
        {rows.map((c) => (
          <tr key={c.id}>
            <td className="px-3 py-2 font-mono text-xs font-semibold">{c.number}</td>
            <td className="px-3 py-2 text-right font-mono">{money(c.revenueChange)}</td>
            <td className="px-3 py-2 text-right font-mono text-slate-500">{money(c.costChange)}</td>
            <td className="px-3 py-2 text-right text-xs text-slate-500">{c.scheduleImpactDays ?? 0}</td>
            <td className="px-3 py-2"><Badge tone={c.status === 'approved' ? 'green' : c.status === 'rejected' ? 'red' : 'slate'}>{c.status}</Badge></td>
            <td className="px-3 py-2 text-right">{c.status !== 'approved' && <Button size="sm" variant="outline" onClick={() => notifyResult(notify, store.approveChangeOrder(project.id, c.id), 'Change order approved.')}><CheckCircle2 className="h-4 w-4" /> Approve</Button>}</td>
          </tr>
        ))}
      </TableCard>
    </>
  );
}

/* ─────────────────────────── Billing ───────────────────────────── */
function BillingSection({ project }: { project: Project }) {
  const accounts = useStore((s) => s.accounts);
  const setActiveView = useStore((s) => s.setActiveView);
  const entities = useEntityStore((s) => s.entities);
  const delivery = useProjectDeliveryStore();
  const timeEntries = useProjectDeliveryStore((s) => s.timeEntries);
  const expenses = useProjectDeliveryStore((s) => s.expenses);
  const createDraft = useInvoiceStore((s) => s.createDraft);
  const updateDraft = useInvoiceStore((s) => s.updateDraft);
  const { notify } = useToast();
  const money = useMoney();

  const unbilledTime = useMemo(() => timeEntries.filter((t) => t.projectId === project.id && t.approvalStatus === 'approved' && !t.billed && t.billable), [timeEntries, project.id]);
  const unbilledExp = useMemo(() => expenses.filter((e) => e.projectId === project.id && e.approvalStatus === 'approved' && !e.billed && e.billable), [expenses, project.id]);
  const suggestion = buildProjectBillingSuggestion({ project, timeEntries, expenses, alreadyBilled: 0 });
  const customerName = project.customerId ? entities.find((e) => e.id === project.customerId)?.legalName : undefined;
  const revenueAccount = accounts.find((a) => a.code === '4120');

  const generate = (): void => {
    if (!project.customerId) { notify('Link a customer to this project first (edit the project).', 'error'); return; }
    if (!revenueAccount) { notify('No revenue account (4120) found.', 'error'); return; }
    const amount = suggestion.amount;
    if (amount <= 0) { notify('Nothing to bill (no unbilled approved time/expenses or contract remaining).', 'error'); return; }

    const created = createDraft({ customerId: project.customerId });
    if (!created.ok || !created.id) { notify(created.error ?? 'Could not create the invoice.', 'error'); return; }
    const base = useInvoiceStore.getState().getInvoice(created.id)!.lines[0]!;
    updateDraft(created.id, { lines: [{ ...base, accountId: revenueAccount.id, description: `${project.code} — ${suggestion.method} billing`, quantity: 1, unitPrice: amount, taxRate: 0, projectId: project.id }] });
    // Mark the source time/expenses billed (duplicate-billing prevented by the store).
    if (unbilledTime.length) delivery.billTime(unbilledTime.map((t) => t.id), created.id);
    if (unbilledExp.length) delivery.billExpense(unbilledExp.map((e) => e.id), created.id);
    notify(`Draft invoice created for ${money(amount)} — open it in Invoices to review & issue.`, 'success');
    setActiveView('invoices');
  };

  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Method" value={suggestion.method ?? '—'} />
        <Metric label="Time" value={money(suggestion.timeAmount)} />
        <Metric label="Expenses" value={money(suggestion.expenseAmount)} />
        <Metric label="Suggested billing" value={money(suggestion.amount)} strong />
      </div>
      <Card><CardBody>
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm"><span className="text-xs text-slate-500">Customer: </span><span className="font-semibold">{customerName ?? 'none linked'}</span>{suggestion.note && <span className="ml-3 text-xs text-slate-400">{suggestion.note}</span>}</div>
          <Button onClick={generate} disabled={suggestion.amount <= 0}><FileText className="h-4 w-4" /> Generate draft invoice</Button>
        </div>
        <p className="mb-2 text-xs text-slate-500">A draft invoice is created through the existing invoice module and the source time/expenses are marked billed (duplicate billing is blocked).</p>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <MiniTable title={`Unbilled approved time (${unbilledTime.length})`} rows={unbilledTime.map((t) => [t.employeeName, `${t.hours}h`, money(t.billableAmount)])} />
          <MiniTable title={`Unbilled approved expenses (${unbilledExp.length})`} rows={unbilledExp.map((e) => [e.description, '', money(e.billableAmount)])} />
        </div>
      </CardBody></Card>
    </>
  );
}

/* ─────────────────────────── UI helpers ───────────────────────────── */
function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return <label className={cx('block text-[10px] font-semibold uppercase tracking-wide text-slate-400', className)}>{label}<div className="mt-1">{children}</div></label>;
}
function Metric({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return <Card><CardBody><p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p><p className={strong ? 'font-mono text-lg font-bold text-slate-900 dark:text-slate-100' : 'font-mono text-lg text-slate-700 dark:text-slate-200'}>{value}</p></CardBody></Card>;
}
function TableCard({ headers, children, empty, emptyText }: { headers: string[]; children: React.ReactNode; empty: boolean; emptyText: string }) {
  return (
    <Card className="overflow-hidden"><div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>{headers.map((h, i) => <th key={h} className={cx('px-3 py-2 font-semibold', i > 0 && i < headers.length - 1 && /amt|amount|hours|cost|billing|recognition|committed|invoiced|remaining|revenue|Δ|days/i.test(h) ? 'text-right' : 'text-left')}>{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{empty ? <tr><td colSpan={headers.length} className="px-3 py-6 text-center text-slate-400">{emptyText}</td></tr> : children}</tbody>
      </table>
    </div></Card>
  );
}
function MiniTable({ title, rows }: { title: string; rows: string[][] }) {
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800">
      <div className="border-b border-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-500 dark:border-slate-800">{title}</div>
      <table className="min-w-full text-xs"><tbody className="divide-y divide-slate-100 dark:divide-slate-800">
        {rows.length === 0 ? <tr><td className="px-3 py-3 text-center text-slate-400">None</td></tr> : rows.map((r, i) => (
          <tr key={i}>{r.map((c, j) => <td key={j} className={cx('px-3 py-1.5', j === r.length - 1 ? 'text-right font-mono' : '')}>{c}</td>)}</tr>
        ))}
      </tbody></table>
    </div>
  );
}

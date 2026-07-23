/**
 * Depreciation runs — preview → validate → (approve) → post → reverse.
 *
 * A run is scoped by company, branch, cost center, project, category or an
 * explicit asset list, computes each asset's charge with its own method, and
 * posts ONE voucher (Dr Depreciation Expense / Cr Accumulated Depreciation per
 * asset line). Posting is idempotent — a run can post exactly once — and a
 * posted run reverses with a mirrored voucher restoring the register.
 */
import { useMemo, useState } from 'react';
import { useFixedAssetStore } from '@/store/fixedAssetStore';
import { useStore } from '@/store/useStore';
import type { DepreciationRun } from '@/types/fixedAssets';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { emptyRow, money, Table, useFaOptions, VoucherLink } from './FixedAssetsShared';

function monthRange(): { from: string; to: string } {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${y}-${String(m).padStart(2, '0')}-01`, to: `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}` };
}

const RUN_TONE: Record<DepreciationRun['status'], 'slate' | 'amber' | 'green' | 'red'> = {
  preview: 'slate', approved: 'amber', posted: 'green', reversed: 'red',
};

export function FixedAssetsDepreciationPage() {
  const store = useFixedAssetStore();
  const currency = useStore((s) => s.settings.baseCurrency);
  const { costCenterOptions, projectOptions } = useFaOptions();
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const range = monthRange();
  const [f, setF] = useState({ from: range.from, to: range.to, categoryId: '', costCenterId: '', projectId: '', branch: '' });

  useState(() => { store.ensureSeeded(); return true; });

  const categoryOptions = useMemo(
    () => [{ value: '', label: 'All categories' }, ...store.categories.map((c) => ({ value: c.id, label: c.name }))],
    [store.categories],
  );
  const runs = useMemo(() => store.runs.slice().reverse(), [store.runs]);

  const report = (r: { ok: boolean; error?: string }, okText: string): void =>
    setMsg(r.ok ? { tone: 'success', text: okText } : { tone: 'error', text: r.error ?? 'Action failed.' });

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold">New depreciation run</h3>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Field label="Period from"><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label="Period to"><Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          <Field label="Category"><Select options={categoryOptions} value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })} /></Field>
          <Field label="Cost center"><Select options={[{ value: '', label: 'All' }, ...costCenterOptions.slice(1)]} value={f.costCenterId} onChange={(e) => setF({ ...f, costCenterId: e.target.value })} /></Field>
          <Field label="Project"><Select options={[{ value: '', label: 'All' }, ...projectOptions.slice(1)]} value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })} /></Field>
          <Field label="Branch"><Input value={f.branch} onChange={(e) => setF({ ...f, branch: e.target.value })} placeholder="All" /></Field>
        </div>
        <div className="mt-3 flex justify-end">
          <Button onClick={() => report(
            store.previewDepreciationRun({ periodFrom: f.from, periodTo: f.to, scope: { categoryId: f.categoryId, costCenterId: f.costCenterId, projectId: f.projectId, branch: f.branch } }),
            'Preview created — review the lines, then approve and post.',
          )}>
            Preview run
          </Button>
        </div>
      </Card>
      {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}

      <Table head={['Run', 'Period', 'Assets', 'Total', 'Status', 'Voucher', '']} minWidth={860}>
        {runs.map((r) => (
          <FragmentRow key={r.id} run={r} expanded={expanded === r.id} onToggle={() => setExpanded(expanded === r.id ? null : r.id)} currency={currency}
            onApprove={() => report(store.approveDepreciationRun(r.id), `${r.number} approved.`)}
            onPost={() => report(store.postDepreciationRun(r.id), `${r.number} posted to the General Journal.`)}
            onReverse={() => {
              const reason = window.prompt(`Reason for reversing ${r.number}?`);
              if (reason) report(store.reverseDepreciationRun(r.id, reason), `${r.number} reversed.`);
            }}
            approvalRequired={store.settings.approvalRequired.depreciation}
          />
        ))}
        {runs.length === 0 && emptyRow(7, 'No depreciation runs yet — create a preview above.')}
      </Table>
    </div>
  );
}

function FragmentRow({ run, expanded, onToggle, currency, onApprove, onPost, onReverse, approvalRequired }: {
  run: DepreciationRun; expanded: boolean; onToggle: () => void; currency: string;
  onApprove: () => void; onPost: () => void; onReverse: () => void; approvalRequired: boolean;
}) {
  return (
    <>
      <tr className="border-t border-slate-100 dark:border-slate-800">
        <td className="px-4 py-2 font-medium">{run.number}</td>
        <td className="px-4 py-2 text-slate-500">{run.periodFrom} → {run.periodTo}</td>
        <td className="px-4 py-2">{run.lines.length}</td>
        <td className="px-4 py-2 text-right tabular-nums">{money(run.total)} {currency}</td>
        <td className="px-4 py-2"><Badge tone={RUN_TONE[run.status]}>{run.status}</Badge></td>
        <td className="px-4 py-2"><VoucherLink entryId={run.journalEntryId} entryNumber={run.journalEntryNumber} /></td>
        <td className="px-4 py-2 text-right whitespace-nowrap">
          <Button size="sm" variant="ghost" onClick={onToggle}>{expanded ? 'Hide' : 'Lines'}</Button>
          {run.status === 'preview' && <Button size="sm" variant="ghost" onClick={onApprove}>Approve</Button>}
          {(run.status === 'approved' || (run.status === 'preview' && !approvalRequired)) && <Button size="sm" variant="ghost" onClick={onPost}>Post</Button>}
          {run.status === 'posted' && <Button size="sm" variant="ghost" onClick={onReverse}>Reverse</Button>}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-50/60 dark:bg-slate-800/30">
          <td colSpan={7} className="px-6 py-2">
            <table className="w-full text-xs">
              <thead className="text-slate-400"><tr><th className="py-1 text-left">Asset</th><th className="py-1 text-right">NBV before</th><th className="py-1 text-right">Charge</th><th className="py-1 text-right">NBV after</th></tr></thead>
              <tbody>
                {run.lines.map((l) => (
                  <tr key={l.assetId} className="border-t border-slate-200/60 dark:border-slate-700/60">
                    <td className="py-1">{l.assetCode} — {l.assetName}</td>
                    <td className="py-1 text-right tabular-nums">{money(l.nbvBefore)}</td>
                    <td className="py-1 text-right tabular-nums">{money(l.amount)}</td>
                    <td className="py-1 text-right tabular-nums">{money(l.nbvAfter)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

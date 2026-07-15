import { useMemo, useState } from 'react';
import { RefreshCw, Send, Ban, CheckCircle2, Trash2 } from 'lucide-react';
import { useCurrencyStore } from '@/store/currencyStore';
import { useCurrencyRevaluationStore } from '@/store/currencyRevaluationStore';
import { formatCurrencyAmount } from '@/lib/currencyFormatting';
import { cn as cx } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import type { BadgeTone } from '@/data/ifrsOptions';
import { PageActions } from '@/components/ui/PageActions';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';

const STATUS_TONE: Record<string, BadgeTone> = { draft: 'slate', reviewed: 'indigo', posted: 'green', reversed: 'red' };

export function CurrencyRevaluationPage() {
  const currencies = useCurrencyStore((s) => s.currencies);
  const config = useCurrencyStore((s) => s.getConfig());
  const runs = useCurrencyRevaluationStore((s) => s.runs);
  const store = useCurrencyRevaluationStore();
  const { notify } = useToast();

  const [date, setDate] = useState('2026-12-31');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const curMap = useMemo(() => new Map(currencies.map((c) => [c.code, c])), [currencies]);
  const baseCur = curMap.get(config.baseCurrencyCode);
  const baseMoney = (n: number): string => formatCurrencyAmount(n, baseCur);

  const act = (fn: () => { ok: boolean; error?: string; id?: string }, ok: string): void => { const r = fn(); if (r.ok) { notify(ok, 'success'); if (r.id) setSelectedRunId(r.id); } else notify(r.error ?? 'Action failed.', 'error'); };
  const build = (): void => act(() => store.buildDraft({ revaluationDate: date }), 'Revaluation drafted.');

  const run = selectedRunId ? runs.find((r) => r.id === selectedRunId) : runs[runs.length - 1];

  return (
    <>
      <PageActions>
        <div className="flex items-end gap-2">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Revaluation date<Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 h-9" /></label>
          <Button onClick={build}><RefreshCw className="h-4 w-4" /> Build revaluation</Button>
        </div>
      </PageActions>

      {runs.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {runs.map((r) => (
            <button key={r.id} onClick={() => setSelectedRunId(r.id)} className={cx('rounded-lg border px-2.5 py-1.5 text-xs', run?.id === r.id ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/10' : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700')}>
              {r.revaluationDate} <Badge tone={STATUS_TONE[r.status] ?? 'slate'} className="ml-1">{r.status}</Badge>
            </button>
          ))}
        </div>
      )}

      {!run ? (
        <Card><CardBody><EmptyState icon={RefreshCw} title="No revaluation yet" description="Build a period-end revaluation to compute the unrealized FX on foreign monetary balances (receivables, payables, bank). Non-monetary accounts are excluded." /></CardBody></Card>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Total gain" value={baseMoney(run.totalGain)} />
            <Metric label="Total loss" value={baseMoney(run.totalLoss)} />
            <Metric label={run.netFx >= 0 ? 'Net gain' : 'Net loss'} value={baseMoney(Math.abs(run.netFx))} strong />
            <Card><CardBody className="flex items-center gap-2">
              {run.status === 'draft' && <Button size="sm" variant="secondary" onClick={() => act(() => store.reviewRun(run.id), 'Reviewed.')}><CheckCircle2 className="h-4 w-4" /> Review</Button>}
              {(run.status === 'draft' || run.status === 'reviewed') && <Button size="sm" onClick={() => act(() => store.postRun(run.id), 'Revaluation posted.')}><Send className="h-4 w-4" /> Post</Button>}
              {run.status === 'posted' && <Button size="sm" variant="danger" onClick={() => act(() => store.reverseRun(run.id), 'Revaluation reversed.')}><Ban className="h-4 w-4" /> Reverse</Button>}
              {run.status !== 'posted' && run.status !== 'reversed' && <button title="Delete draft" onClick={() => { act(() => store.deleteDraft(run.id), 'Draft deleted.'); setSelectedRunId(null); }} className="rounded p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><Trash2 className="h-4 w-4" /></button>}
            </CardBody></Card>
          </div>

          <Card className="overflow-hidden"><div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>
                {['Account', 'Cur.', 'Foreign balance', 'Carrying base', 'Closing rate', 'Revalued base', 'Unrealized'].map((h) => <th key={h} className={cx('px-3 py-2 font-semibold', h === 'Account' || h === 'Cur.' ? 'text-left' : 'text-right')}>{h}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {run.lines.map((l) => {
                  const net = l.unrealizedGain - l.unrealizedLoss;
                  return (
                    <tr key={l.id}>
                      <td className="px-3 py-2"><span className="font-mono text-xs font-semibold">{l.accountCode}</span> {l.accountName}</td>
                      <td className="px-3 py-2 font-mono text-xs">{l.currencyCode}</td>
                      <td className="px-3 py-2 text-right font-mono">{formatCurrencyAmount(l.foreignBalance, curMap.get(l.currencyCode))}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-500">{baseMoney(l.carryingBaseAmount)}</td>
                      <td className="px-3 py-2 text-right font-mono">{l.closingRate}</td>
                      <td className="px-3 py-2 text-right font-mono">{baseMoney(l.revaluedBaseAmount)}</td>
                      <td className={cx('px-3 py-2 text-right font-mono font-semibold', net > 0 ? 'text-green-600' : net < 0 ? 'text-red-600' : 'text-slate-500')}>{baseMoney(net)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div></Card>
        </>
      )}
    </>
  );
}

function Metric({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <Card><CardBody>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={strong ? 'font-mono text-lg font-bold text-slate-900 dark:text-slate-100' : 'font-mono text-lg text-slate-700 dark:text-slate-200'}>{value}</p>
    </CardBody></Card>
  );
}

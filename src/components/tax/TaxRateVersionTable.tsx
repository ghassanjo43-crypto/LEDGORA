import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { TaxRateVersion } from '@/types/taxCode';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';

interface Props {
  versions: TaxRateVersion[];
  onCreate: (input: { rate: number; effectiveFrom: string }) => { ok: boolean; error?: string };
  disabled?: boolean;
}

/** Effective-dated rate history + a form to add a new version (end-dates the prior). */
export function TaxRateVersionTable({ versions, onCreate, disabled }: Props) {
  const { notify } = useToast();
  const [rate, setRate] = useState(0);
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));

  const add = (): void => {
    const res = onCreate({ rate: Number(rate), effectiveFrom: from });
    if (res.ok) notify('Rate version added.', 'success');
    else notify(res.error ?? 'Could not add the rate version.', 'error');
  };

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400 dark:bg-slate-800/40">
            <tr><th className="px-2 py-2 text-left">Effective from</th><th className="px-2 py-2 text-left">Effective to</th><th className="px-2 py-2 text-right">Rate</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {versions.length === 0 ? (
              <tr><td colSpan={3} className="px-2 py-3 text-center text-slate-400">No rate versions yet.</td></tr>
            ) : versions.map((v) => (
              <tr key={v.id}>
                <td className="px-2 py-1.5 font-mono">{v.effectiveFrom}</td>
                <td className="px-2 py-1.5 font-mono text-slate-500">{v.effectiveTo ?? '—'}</td>
                <td className="px-2 py-1.5 text-right font-mono">{v.rate}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!disabled && (
        <div className="flex items-end gap-2">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Rate %<Input type="number" step="0.01" value={rate} onChange={(e) => setRate(Number(e.target.value))} className="mt-1 h-8 w-24 text-right" /></label>
          <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">From<Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 h-8" /></label>
          <Button type="button" size="sm" variant="outline" onClick={add}><Plus className="h-4 w-4" /> Add version</Button>
        </div>
      )}
    </div>
  );
}

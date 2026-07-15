import { useMemo, useState } from 'react';
import { Upload, Download, CheckCircle2, XCircle } from 'lucide-react';
import { useCostCenterStore } from '@/store/costCenterStore';
import { dryRunCostCenterImport, commitCostCenterImport, exportCostCentersCsv } from '@/lib/costCenterImport';
import { PRIMARY_ENTITY_ID } from '@/data/costCenterSeed';
import { cn as cx } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';

const TEMPLATE = 'entity,code,name,description,type,parentCode,manager,postingAllowed,budgetEnabled,effectiveFrom,effectiveTo,status\nprimary,CC-IT,IT Department,,support,CC-CORP,,true,true,2026-01-01,,active';

/** CSV import with a dry-run preview (accepted / rejected rows + reasons) before commit. */
export function CostCenterImportDialog({ onClose }: { onClose: () => void }) {
  const centers = useCostCenterStore((s) => s.costCenters);
  const importCostCenters = useCostCenterStore((s) => s.importCostCenters);
  const { notify } = useToast();
  const [text, setText] = useState('');

  const dryRun = useMemo(() => (text.trim() ? dryRunCostCenterImport(text, centers, PRIMARY_ENTITY_ID) : null), [text, centers]);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const commit = (): void => {
    if (!dryRun || dryRun.acceptedCount === 0) return;
    const created = commitCostCenterImport(dryRun, centers);
    const res = importCostCenters(created);
    if (res.ok) { notify(`Imported ${created.length} cost center(s).`, 'success'); onClose(); }
    else notify(res.error ?? 'Import failed.', 'error');
  };

  const downloadExport = (): void => {
    const blob = new Blob([exportCostCentersCsv(centers)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'cost-centers.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-800 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Import cost centers (CSV)</h2>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setText(TEMPLATE)}>Load template</Button>
            <Button size="sm" variant="outline" onClick={downloadExport}><Download className="h-4 w-4" /> Export current</Button>
            <label className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300"><Upload className="h-4 w-4" /> Choose file<input type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} /></label>
          </div>
        </div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste CSV here or choose a file…" className="h-32 w-full resize-none rounded-lg border border-slate-200 bg-white p-2 font-mono text-xs outline-none dark:border-slate-700 dark:bg-slate-900" />

        {dryRun?.headerError && <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">{dryRun.headerError}</p>}

        {dryRun && !dryRun.headerError && (
          <>
            <div className="mt-2 flex gap-4 text-xs">
              <span className="inline-flex items-center gap-1 text-green-600"><CheckCircle2 className="h-4 w-4" /> {dryRun.acceptedCount} accepted</span>
              <span className="inline-flex items-center gap-1 text-red-600"><XCircle className="h-4 w-4" /> {dryRun.rejectedCount} rejected</span>
            </div>
            <div className="mt-2 flex-1 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400 dark:bg-slate-800/60"><tr><th className="px-2 py-1.5 text-left">Row</th><th className="px-2 py-1.5 text-left">Code</th><th className="px-2 py-1.5 text-left">Name</th><th className="px-2 py-1.5 text-left">Result</th></tr></thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {dryRun.rows.map((r) => (
                    <tr key={r.rowNumber} className={cx(!r.accepted && 'bg-red-50/40 dark:bg-red-500/5')}>
                      <td className="px-2 py-1.5 text-slate-400">{r.rowNumber}</td>
                      <td className="px-2 py-1.5 font-mono">{r.raw.code}</td>
                      <td className="px-2 py-1.5">{r.raw.name}</td>
                      <td className="px-2 py-1.5">{r.accepted ? <span className="text-green-600">Accepted</span> : <span className="text-red-600">{r.errors.join(' ')}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={commit} disabled={!dryRun || dryRun.acceptedCount === 0}>Import {dryRun?.acceptedCount ?? 0} cost center(s)</Button>
        </div>
      </div>
    </div>
  );
}

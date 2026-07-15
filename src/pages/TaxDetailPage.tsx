import { useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { useTaxCodeStore } from '@/store/taxCodeStore';
import { assembleTaxRecords, buildTaxDetailReport, filterTaxRecords, type TaxReportFilters } from '@/lib/taxReporting';
import { useToast } from '@/components/ui/Toast';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { TaxDetailReport } from '@/components/tax/TaxDetailReport';

export function TaxDetailPage() {
  const baseCurrency = useStore((s) => s.settings.baseCurrency);
  const setActiveView = useStore((s) => s.setActiveView);
  const entries = useJournalStore((s) => s.entries);
  const taxCodes = useTaxCodeStore((s) => s.taxCodes);
  const adjustments = useTaxCodeStore((s) => s.adjustments);
  const { notify } = useToast();

  const [from, setFrom] = useState('2026-01-01');
  const [to, setTo] = useState('2026-12-31');
  const [codeId, setCodeId] = useState('ALL');

  const records = useMemo(() => assembleTaxRecords({ entries, adjustments, taxCodes, baseCurrency }), [entries, adjustments, taxCodes, baseCurrency]);
  const shown = useMemo(() => {
    const f: TaxReportFilters = { from, to };
    if (codeId !== 'ALL') f.taxCodeId = codeId;
    return buildTaxDetailReport(filterTaxRecords(records, f));
  }, [records, from, to, codeId]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900">
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">From<Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 h-9" /></label>
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">To<Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 h-9" /></label>
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Tax code<Select className="mt-1 h-9 w-auto" options={[{ value: 'ALL', label: 'All codes' }, ...taxCodes.map((c) => ({ value: c.id, label: c.code }))]} value={codeId} onChange={(e) => setCodeId(e.target.value)} /></label>
      </div>
      <TaxDetailReport records={shown} currency={baseCurrency} onDrillDown={(r) => { if (r.journalEntryId) { setActiveView('journal'); notify(`Open journal ${r.documentNumber} to see the posting.`, 'info'); } }} />
    </>
  );
}

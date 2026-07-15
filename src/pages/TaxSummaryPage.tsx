import { useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { useTaxCodeStore } from '@/store/taxCodeStore';
import { assembleTaxRecords, buildTaxSummaryReport, buildTaxBoxTotals, filterTaxRecords, type TaxReportFilters } from '@/lib/taxReporting';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { TaxSummaryReport } from '@/components/tax/TaxSummaryReport';

export function TaxSummaryPage() {
  const baseCurrency = useStore((s) => s.settings.baseCurrency);
  const entries = useJournalStore((s) => s.entries);
  const taxCodes = useTaxCodeStore((s) => s.taxCodes);
  const adjustments = useTaxCodeStore((s) => s.adjustments);
  const reportingBoxes = useTaxCodeStore((s) => s.reportingBoxes);

  const [from, setFrom] = useState('2026-01-01');
  const [to, setTo] = useState('2026-12-31');
  const [direction, setDirection] = useState<string>('ALL');

  const records = useMemo(() => assembleTaxRecords({ entries, adjustments, taxCodes, baseCurrency }), [entries, adjustments, taxCodes, baseCurrency]);
  const filtered = useMemo(() => {
    const f: TaxReportFilters = { from, to };
    if (direction !== 'ALL') f.direction = direction as TaxReportFilters['direction'];
    return filterTaxRecords(records, f);
  }, [records, from, to, direction]);

  const summary = useMemo(() => buildTaxSummaryReport(filtered), [filtered]);
  const boxTotals = useMemo(() => buildTaxBoxTotals(filtered, reportingBoxes), [filtered, reportingBoxes]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900">
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">From<Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 h-9" /></label>
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">To<Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 h-9" /></label>
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Direction<Select className="mt-1 h-9 w-auto" options={[{ value: 'ALL', label: 'All' }, { value: 'sales', label: 'Sales' }, { value: 'purchase', label: 'Purchase' }, { value: 'both', label: 'Both' }]} value={direction} onChange={(e) => setDirection(e.target.value)} /></label>
      </div>
      <TaxSummaryReport summary={summary} boxTotals={boxTotals} currency={baseCurrency} />
    </>
  );
}

import { useMemo, useState } from 'react';
import { useStore } from '@/store/useStore';
import { useJournalStore } from '@/store/journalStore';
import { useTaxCodeStore } from '@/store/taxCodeStore';
import { assembleTaxRecords } from '@/lib/taxReporting';
import { reconcileTaxControlAccounts } from '@/lib/taxReconciliation';
import { Input } from '@/components/ui/Input';
import { TaxReconciliationView } from '@/components/tax/TaxReconciliationView';

export function TaxReconciliationPage() {
  const baseCurrency = useStore((s) => s.settings.baseCurrency);
  const accounts = useStore((s) => s.accounts);
  const entries = useJournalStore((s) => s.entries);
  const taxCodes = useTaxCodeStore((s) => s.taxCodes);
  const adjustments = useTaxCodeStore((s) => s.adjustments);

  const [from, setFrom] = useState('2026-01-01');
  const [to, setTo] = useState('2026-12-31');

  const result = useMemo(() => {
    const records = assembleTaxRecords({ entries, adjustments, taxCodes, baseCurrency }).filter((r) => r.date >= from && r.date <= to);
    return reconcileTaxControlAccounts({ records, entries, accounts, taxCodes, baseCurrency, from, to });
  }, [entries, adjustments, taxCodes, baseCurrency, accounts, from, to]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900">
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">From<Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 h-9" /></label>
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">To<Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 h-9" /></label>
      </div>
      <TaxReconciliationView result={result} currency={baseCurrency} />
    </>
  );
}

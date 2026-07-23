/**
 * Fixed-asset reports: register, additions, disposals, depreciation schedule,
 * groupings (category/location/custodian/cost center/project), fully
 * depreciated, impaired, held for sale, gain/loss on disposal, movement
 * roll-forward and the reconciliation of the register to the General Ledger.
 */
import { useMemo, useState } from 'react';
import { useFixedAssetStore } from '@/store/fixedAssetStore';
import { useJournalStore } from '@/store/journalStore';
import { useStore } from '@/store/useStore';
import { useCostCenterStore } from '@/store/costCenterStore';
import { useProjectStore } from '@/store/projectStore';
import { netBookValue } from '@/lib/fixedAssetCalculations';
import {
  buildDepreciationSchedule, buildMovementReport, buildReconciliation,
  groupAssetsBy, onBookAssets, registerTotals, transactionsInPeriod,
} from '@/lib/fixedAssetReports';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { emptyRow, money, StatusBadge, Table, useFaOptions } from './FixedAssetsShared';

type ReportKey =
  | 'register' | 'additions' | 'disposals' | 'schedule' | 'accumulated' | 'nbv'
  | 'by-category' | 'by-location' | 'by-custodian' | 'by-cost-center' | 'by-project'
  | 'fully-depreciated' | 'impaired' | 'held-for-sale' | 'gain-loss' | 'movement' | 'reconciliation';

const REPORTS: Array<{ value: ReportKey; label: string }> = [
  { value: 'register', label: 'Fixed Asset Register' },
  { value: 'additions', label: 'Asset Additions' },
  { value: 'disposals', label: 'Asset Disposals' },
  { value: 'schedule', label: 'Depreciation Schedule' },
  { value: 'accumulated', label: 'Accumulated Depreciation' },
  { value: 'nbv', label: 'Net Book Value' },
  { value: 'by-category', label: 'Assets by Category' },
  { value: 'by-location', label: 'Assets by Location' },
  { value: 'by-custodian', label: 'Assets by Custodian' },
  { value: 'by-cost-center', label: 'Assets by Cost Center' },
  { value: 'by-project', label: 'Assets by Project' },
  { value: 'fully-depreciated', label: 'Fully Depreciated Assets' },
  { value: 'impaired', label: 'Impaired Assets' },
  { value: 'held-for-sale', label: 'Assets Held for Sale' },
  { value: 'gain-loss', label: 'Gain / Loss on Disposal' },
  { value: 'movement', label: 'Asset Movement Report' },
  { value: 'reconciliation', label: 'Reconciliation to General Ledger' },
];

export function FixedAssetsReportsPage() {
  const store = useFixedAssetStore();
  const entries = useJournalStore((s) => s.entries);
  const accounts = useStore((s) => s.accounts);
  const costCenters = useCostCenterStore((s) => s.costCenters);
  const projects = useProjectStore((s) => s.projects);
  const { accountLabel } = useFaOptions();
  const [report, setReport] = useState<ReportKey>('register');
  const year = new Date().getUTCFullYear();
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const [scheduleAssetId, setScheduleAssetId] = useState('');

  useState(() => { store.ensureSeeded(); return true; });

  const { categories, assets, transactions, runs } = store;
  const catName = (id: string): string => categories.find((c) => c.id === id)?.name ?? '—';
  const totals = useMemo(() => registerTotals(assets), [assets]);

  const grouped = useMemo(() => {
    switch (report) {
      case 'by-category': return groupAssetsBy(assets, (a) => a.categoryId, catName);
      case 'by-location': return groupAssetsBy(assets, (a) => a.location);
      case 'by-custodian': return groupAssetsBy(assets, (a) => a.custodian);
      case 'by-cost-center': return groupAssetsBy(assets, (a) => a.costCenterId, (k) => costCenters.find((c) => c.id === k)?.name ?? '—');
      case 'by-project': return groupAssetsBy(assets, (a) => a.projectId, (k) => projects.find((p) => p.id === k)?.name ?? '—');
      default: return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, assets, categories, costCenters, projects]);

  const listFor = (key: ReportKey) =>
    key === 'fully-depreciated' ? assets.filter((a) => a.status === 'fully_depreciated')
      : key === 'impaired' ? assets.filter((a) => a.impairmentBalance > 0)
        : key === 'held-for-sale' ? assets.filter((a) => a.status === 'held_for_sale')
          : onBookAssets(assets);

  const scheduleAsset = assets.find((a) => a.id === scheduleAssetId) ?? null;
  const schedule = useMemo(
    () => (scheduleAsset ? buildDepreciationSchedule(scheduleAsset, new Date().toISOString().slice(0, 10)) : []),
    [scheduleAsset],
  );

  const needsPeriod = ['additions', 'disposals', 'gain-loss', 'movement'].includes(report);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Report"><Select className="w-72" options={REPORTS} value={report} onChange={(e) => setReport(e.target.value as ReportKey)} /></Field>
        {needsPeriod && (
          <>
            <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          </>
        )}
        {report === 'schedule' && (
          <Field label="Asset">
            <Select className="w-72" value={scheduleAssetId} onChange={(e) => setScheduleAssetId(e.target.value)}
              options={[{ value: '', label: 'Select an asset…' }, ...onBookAssets(assets).map((a) => ({ value: a.id, label: `${a.assetCode} — ${a.name}` }))]} />
          </Field>
        )}
      </div>

      {(report === 'register' || report === 'accumulated' || report === 'nbv' || report === 'fully-depreciated' || report === 'impaired' || report === 'held-for-sale') && (
        <Table head={['Code', 'Name', 'Category', 'Status', 'Cost', 'Accum. dep.', 'Impairment', 'NBV']} minWidth={860}>
          {listFor(report).map((a) => (
            <tr key={a.id} className="border-t border-slate-100 dark:border-slate-800">
              <td className="px-4 py-2 font-medium">{a.assetCode}</td>
              <td className="px-4 py-2">{a.name}</td>
              <td className="px-4 py-2 text-slate-500">{catName(a.categoryId)}</td>
              <td className="px-4 py-2"><StatusBadge status={a.status} /></td>
              <td className="px-4 py-2 text-right tabular-nums">{money(a.originalCost)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{money(a.accumulatedDepreciation)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{money(a.impairmentBalance)}</td>
              <td className="px-4 py-2 text-right font-medium tabular-nums">{money(netBookValue(a))}</td>
            </tr>
          ))}
          {listFor(report).length === 0 && emptyRow(8, 'No matching assets.')}
          <tr className="border-t-2 border-slate-300 font-semibold dark:border-slate-600">
            <td className="px-4 py-2" colSpan={4}>Totals (on books)</td>
            <td className="px-4 py-2 text-right tabular-nums">{money(totals.cost)}</td>
            <td className="px-4 py-2 text-right tabular-nums">{money(totals.accumulatedDepreciation)}</td>
            <td className="px-4 py-2 text-right tabular-nums">{money(totals.impairment)}</td>
            <td className="px-4 py-2 text-right tabular-nums">{money(totals.netBookValue)}</td>
          </tr>
        </Table>
      )}

      {(report === 'additions' || report === 'disposals' || report === 'gain-loss') && (
        <Table head={report === 'gain-loss' ? ['No.', 'Asset', 'Date', 'Proceeds', 'NBV disposed', 'Gain / (loss)', 'Voucher'] : ['No.', 'Asset', 'Date', 'Type', 'Amount', 'Voucher']} minWidth={760}>
          {transactionsInPeriod(
            transactions,
            report === 'additions' ? ['acquisition', 'auc_acquisition', 'capitalization'] : ['disposal', 'partial_disposal', 'intercompany_transfer'],
            from, to,
          ).map((t) => (
            <tr key={t.id} className="border-t border-slate-100 dark:border-slate-800">
              <td className="px-4 py-2 font-medium">{t.number}</td>
              <td className="px-4 py-2">{t.assetCode}</td>
              <td className="px-4 py-2">{t.date}</td>
              {report === 'gain-loss' ? (
                <>
                  <td className="px-4 py-2 text-right tabular-nums">{money(Number(t.details.proceeds ?? 0))}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(Number(t.details.nbvDisposed ?? 0))}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(Number(t.details.gainLoss ?? 0))}</td>
                </>
              ) : (
                <>
                  <td className="px-4 py-2">{t.type.replaceAll('_', ' ')}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(t.amount)}</td>
                </>
              )}
              <td className="px-4 py-2 text-xs text-slate-500">{t.journalEntryNumber || '—'}</td>
            </tr>
          ))}
          {transactionsInPeriod(transactions, report === 'additions' ? ['acquisition', 'auc_acquisition', 'capitalization'] : ['disposal', 'partial_disposal', 'intercompany_transfer'], from, to).length === 0 && emptyRow(7, 'No transactions in this period.')}
        </Table>
      )}

      {report === 'schedule' && (
        scheduleAsset ? (
          <Table head={['Period', 'Charge', 'Accumulated after', 'NBV after']} minWidth={520}>
            {schedule.map((r) => (
              <tr key={r.period} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2">{r.period}</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(r.charge)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(r.accumulatedAfter)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(r.nbvAfter)}</td>
              </tr>
            ))}
            {schedule.length === 0 && emptyRow(4, 'No projected depreciation (fully depreciated, non-depreciating, or units-based).')}
          </Table>
        ) : <Alert variant="info">Select an asset to project its remaining depreciation schedule.</Alert>
      )}

      {grouped.length > 0 && (
        <Table head={['Group', 'Assets', 'Cost', 'Accum. dep.', 'Impairment', 'NBV']} minWidth={680}>
          {grouped.map((g) => (
            <tr key={g.key} className="border-t border-slate-100 dark:border-slate-800">
              <td className="px-4 py-2 font-medium">{g.label}</td>
              <td className="px-4 py-2">{g.totals.count}</td>
              <td className="px-4 py-2 text-right tabular-nums">{money(g.totals.cost)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{money(g.totals.accumulatedDepreciation)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{money(g.totals.impairment)}</td>
              <td className="px-4 py-2 text-right font-medium tabular-nums">{money(g.totals.netBookValue)}</td>
            </tr>
          ))}
        </Table>
      )}

      {report === 'movement' && (
        <Table head={['Category', 'Additions', 'Capitalizations', 'Disposals (NBV)', 'Depreciation', 'Impairment', 'Impairment rev.', 'Revaluation Δ']} minWidth={900}>
          {buildMovementReport(categories, assets, transactions, runs, from, to).map((r) => (
            <tr key={r.label} className="border-t border-slate-100 dark:border-slate-800">
              <td className="px-4 py-2 font-medium">{r.label}</td>
              <td className="px-4 py-2 text-right tabular-nums">{money(r.additions)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{money(r.capitalizations)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{money(r.disposalsCost)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{money(r.depreciationCharge)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{money(r.impairmentCharge)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{money(r.impairmentReversals)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{money(r.revaluationDelta)}</td>
            </tr>
          ))}
          {buildMovementReport(categories, assets, transactions, runs, from, to).length === 0 && emptyRow(8, 'No movements in this period.')}
        </Table>
      )}

      {report === 'reconciliation' && (
        <>
          <Alert variant="info">
            Register balances vs the General Ledger for every mapped account. Differences indicate postings to these
            accounts from outside the Fixed Assets module (e.g. opening balances or manual journals).
          </Alert>
          <Table head={['Account', 'Role', 'Register balance', 'GL balance', 'Difference']} minWidth={720}>
            {buildReconciliation(categories, assets, accounts, entries).map((r) => (
              <tr key={`${r.accountId}-${r.role}`} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2 font-medium">{accountLabel(r.accountId)}</td>
                <td className="px-4 py-2 text-slate-500">{r.role.replaceAll('-', ' ')}</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(r.registerBalance)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(r.glBalance)}</td>
                <td className={`px-4 py-2 text-right font-medium tabular-nums ${Math.abs(r.difference) > 0.004 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{money(r.difference)}</td>
              </tr>
            ))}
            {buildReconciliation(categories, assets, accounts, entries).length === 0 && emptyRow(5, 'No mapped accounts to reconcile yet.')}
          </Table>
        </>
      )}
    </div>
  );
}

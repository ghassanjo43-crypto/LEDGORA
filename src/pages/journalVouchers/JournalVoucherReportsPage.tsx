/**
 * Journal Voucher reports: registers by type/account/user/dimension/company,
 * reversed / opening-balance / intercompany / recurring / unapproved lists,
 * manual tax adjustments, the voucher audit report, and the reconciliation of
 * posted vouchers to the General Ledger.
 */
import { useMemo, useState } from 'react';
import { useJournalVoucherStore } from '@/store/journalVoucherStore';
import { useJournalStore } from '@/store/journalStore';
import { useCostCenterStore } from '@/store/costCenterStore';
import { useProjectStore } from '@/store/projectStore';
import { computeVoucherTotals } from '@/lib/journalVoucherValidation';
import {
  groupVouchersBy, intercompanyVouchers, manualTaxAdjustments, openingBalanceVouchers,
  reconcileVouchersToJournal, recurringVouchers, reversedVouchers, unapprovedVouchers, vouchersByAccount,
} from '@/lib/journalVoucherReports';
import type { JournalVoucher } from '@/types/journalVoucher';
import { Card } from '@/components/ui/Card';
import { Field } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';

const money = (n: number): string => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type ReportKey =
  | 'register' | 'by-type' | 'by-account' | 'by-user' | 'by-cost-center' | 'by-project' | 'by-company'
  | 'reversed' | 'opening-balance' | 'intercompany' | 'recurring' | 'unapproved' | 'tax-adjustments'
  | 'audit' | 'reconciliation';

const REPORTS: Array<{ value: ReportKey; label: string }> = [
  { value: 'register', label: 'Journal Voucher Register' },
  { value: 'by-type', label: 'Vouchers by Type' },
  { value: 'by-account', label: 'Vouchers by Account' },
  { value: 'by-user', label: 'Vouchers by User' },
  { value: 'by-cost-center', label: 'Vouchers by Cost Center' },
  { value: 'by-project', label: 'Vouchers by Project' },
  { value: 'by-company', label: 'Vouchers by Company' },
  { value: 'reversed', label: 'Reversed Vouchers' },
  { value: 'opening-balance', label: 'Opening-Balance Vouchers' },
  { value: 'intercompany', label: 'Intercompany Vouchers' },
  { value: 'recurring', label: 'Recurring Vouchers' },
  { value: 'unapproved', label: 'Unapproved Vouchers' },
  { value: 'tax-adjustments', label: 'Manual Tax Adjustments' },
  { value: 'audit', label: 'Voucher Audit Report' },
  { value: 'reconciliation', label: 'Journal-to-GL Reconciliation' },
];

export function JournalVoucherReportsPage() {
  const store = useJournalVoucherStore();
  const entries = useJournalStore((s) => s.entries);
  const costCenters = useCostCenterStore((s) => s.costCenters);
  const projects = useProjectStore((s) => s.projects);
  const [report, setReport] = useState<ReportKey>('register');

  useState(() => { store.ensureSeeded(); return true; });

  const typeName = (id: string): string => store.types.find((t) => t.id === id)?.name ?? '—';

  const grouped = useMemo(() => {
    switch (report) {
      case 'by-type': return groupVouchersBy(store.vouchers, (v) => v.typeId, typeName);
      case 'by-user': return groupVouchersBy(store.vouchers, (v) => v.preparedBy);
      case 'by-company': return groupVouchersBy(store.vouchers, (v) => v.companyId, (k) => k || '(default company)');
      case 'by-cost-center': return groupVouchersBy(
        store.vouchers,
        (v) => v.lines.find((l) => l.costCenterId)?.costCenterId ?? '',
        (k) => costCenters.find((c) => c.id === k)?.name ?? '—',
      );
      case 'by-project': return groupVouchersBy(
        store.vouchers,
        (v) => v.lines.find((l) => l.projectId)?.projectId ?? '',
        (k) => projects.find((p) => p.id === k)?.name ?? '—',
      );
      case 'by-account': return vouchersByAccount(store.vouchers);
      default: return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, store.vouchers, store.types, costCenters, projects]);

  const listFor = (key: ReportKey): JournalVoucher[] => {
    switch (key) {
      case 'reversed': return reversedVouchers(store.vouchers);
      case 'opening-balance': return openingBalanceVouchers(store.vouchers, store.types);
      case 'intercompany': return intercompanyVouchers(store.vouchers);
      case 'recurring': return recurringVouchers(store.vouchers);
      case 'unapproved': return unapprovedVouchers(store.vouchers);
      case 'tax-adjustments': return manualTaxAdjustments(store.vouchers, store.types);
      default: return store.vouchers;
    }
  };

  const isList = ['register', 'reversed', 'opening-balance', 'intercompany', 'recurring', 'unapproved', 'tax-adjustments'].includes(report);
  const reconciliation = useMemo(
    () => (report === 'reconciliation' ? reconcileVouchersToJournal(store.vouchers, entries) : null),
    [report, store.vouchers, entries],
  );

  return (
    <div className="space-y-4">
      <Field label="Report"><Select className="w-80" options={REPORTS} value={report} onChange={(e) => setReport(e.target.value as ReportKey)} /></Field>

      {isList && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
              <tr><th className="px-4 py-2 text-left">Voucher</th><th className="px-4 py-2 text-left">Date</th><th className="px-4 py-2 text-left">Type</th><th className="px-4 py-2 text-left">Description</th><th className="px-4 py-2 text-right">Amount</th><th className="px-4 py-2 text-left">Status</th><th className="px-4 py-2 text-left">Journal</th><th className="px-4 py-2 text-left">Prepared / Approved / Posted</th></tr>
            </thead>
            <tbody>
              {listFor(report).slice().reverse().map((v) => (
                <tr key={v.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-4 py-2 font-medium">{v.number}{v.intercompanyRef ? <span className="block text-[11px] text-slate-400">{v.intercompanyRef}</span> : null}</td>
                  <td className="px-4 py-2">{v.postingDate}</td>
                  <td className="px-4 py-2 text-slate-500">{typeName(v.typeId)}</td>
                  <td className="px-4 py-2 max-w-[240px] truncate" title={v.description}>{v.description}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(computeVoucherTotals(v.lines, 1).debit)} {v.currency}</td>
                  <td className="px-4 py-2"><Badge tone={v.status === 'posted' ? 'green' : v.status === 'reversed' ? 'violet' : 'slate'}>{v.status.replaceAll('_', ' ')}</Badge></td>
                  <td className="px-4 py-2 text-xs text-slate-500">{v.journalEntryNumber || '—'}</td>
                  <td className="px-4 py-2 text-xs text-slate-400">{[v.preparedBy, v.approvedBy, v.postedBy].map((x) => x || '—').join(' / ')}</td>
                </tr>
              ))}
              {listFor(report).length === 0 && <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-400">No vouchers in this report.</td></tr>}
            </tbody>
          </table>
        </Card>
      )}

      {grouped.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
              <tr><th className="px-4 py-2 text-left">Group</th><th className="px-4 py-2 text-right">Vouchers</th><th className="px-4 py-2 text-right">Total (txn)</th><th className="px-4 py-2 text-right">Total (base)</th></tr>
            </thead>
            <tbody>
              {grouped.map((g) => (
                <tr key={g.key} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-4 py-2 font-medium">{g.label}</td>
                  <td className="px-4 py-2 text-right">{g.count}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(g.totalDebit)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(g.totalBaseDebit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {!isList && grouped.length === 0 && report !== 'audit' && report !== 'reconciliation' && (
        <Alert variant="info">No posted vouchers to report yet.</Alert>
      )}

      {report === 'audit' && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
              <tr><th className="px-4 py-2 text-left">When</th><th className="px-4 py-2 text-left">Actor</th><th className="px-4 py-2 text-left">Event</th><th className="px-4 py-2 text-left">Detail</th><th className="px-4 py-2 text-left">Operator</th></tr>
            </thead>
            <tbody>
              {store.auditTrail.slice().reverse().map((a) => (
                <tr key={a.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-4 py-2 whitespace-nowrap text-xs text-slate-500">{new Date(a.at).toLocaleString()}</td>
                  <td className="px-4 py-2">{a.actor}</td>
                  <td className="px-4 py-2 text-slate-500">{a.event}</td>
                  <td className="px-4 py-2">{a.detail}</td>
                  <td className="px-4 py-2 text-xs text-slate-400">{a.operator ? `${a.operator.operatorEmail ?? a.operator.operatorUserId} (${a.operator.operatorViewMode})` : '—'}</td>
                </tr>
              ))}
              {store.auditTrail.length === 0 && <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-400">No audit records yet.</td></tr>}
            </tbody>
          </table>
        </Card>
      )}

      {report === 'reconciliation' && reconciliation && (
        <>
          <Alert variant={reconciliation.exceptions === 0 ? 'success' : 'warning'}>
            {reconciliation.matched} voucher(s) matched to their General Journal entries · {reconciliation.exceptions} exception(s)
            {reconciliation.orphanJournalNumbers.length > 0 ? ` · orphan journal entries: ${reconciliation.orphanJournalNumbers.join(', ')}` : ''}.
          </Alert>
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
                <tr><th className="px-4 py-2 text-left">Voucher</th><th className="px-4 py-2 text-left">Journal</th><th className="px-4 py-2 text-left">Status</th><th className="px-4 py-2 text-right">Voucher total</th><th className="px-4 py-2 text-right">Journal total</th><th className="px-4 py-2 text-right">Difference</th></tr>
              </thead>
              <tbody>
                {reconciliation.rows.map((r) => (
                  <tr key={r.voucherNumber} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-4 py-2 font-medium">{r.voucherNumber}</td>
                    <td className="px-4 py-2">{r.journalEntryNumber || '—'}</td>
                    <td className="px-4 py-2"><Badge tone={r.status === 'matched' ? 'green' : 'red'}>{r.status}</Badge></td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(r.voucherDebit)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(r.journalDebit)}</td>
                    <td className={`px-4 py-2 text-right tabular-nums ${Math.abs(r.difference) > 0.004 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{money(r.difference)}</td>
                  </tr>
                ))}
                {reconciliation.rows.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400">No posted vouchers to reconcile yet.</td></tr>}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}

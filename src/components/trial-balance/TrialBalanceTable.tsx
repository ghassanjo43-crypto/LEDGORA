import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import type { TrialBalanceRow, TrialBalanceTotals, TrialBalanceViewMode } from '@/types/trialBalance';
import { accountColor } from '@/lib/accountDisplay';
import { accountTypeLabel } from '@/data/ifrsOptions';
import { AccountDot } from '@/components/shared/AccountChip';
import { cn } from '@/lib/utils';
import { tbAmount, tbAmountAlways } from './tbFormat';

export interface TrialBalanceSection {
  id: string;
  /** Group heading; omit for a flat (ungrouped) section. */
  label?: string;
  rows: TrialBalanceRow[];
  subtotals?: TrialBalanceTotals;
}

interface Props {
  viewMode: TrialBalanceViewMode;
  sections: TrialBalanceSection[];
  totals: TrialBalanceTotals;
  onDrill: (row: TrialBalanceRow) => void;
  /** Group ids that are collapsed (grouped view only). */
  collapsed?: Set<string>;
  onToggleGroup?: (id: string) => void;
}

/** Money cell — right-aligned, tabular figures, monochrome. */
function Amt({ value, always = false, className }: { value: number; always?: boolean; className?: string }) {
  return (
    <td className={cn('whitespace-nowrap px-3 py-1.5 text-right font-mono text-[13px] tabular-nums text-slate-700 dark:text-slate-200', className)}>
      {always ? tbAmountAlways(value) : tbAmount(value)}
    </td>
  );
}

export function TrialBalanceTable({ viewMode, sections, totals, onDrill, collapsed, onToggleGroup }: Props) {
  const movement = viewMode === 'movement';
  // Column count for label cells that span the account columns.
  const labelSpan = 3;

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] dark:bg-slate-800/80 dark:text-slate-400">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-semibold">Code</th>
            <th scope="col" className="px-3 py-2 text-left font-semibold">Account</th>
            <th scope="col" className="px-3 py-2 text-left font-semibold">Type</th>
            {movement && (
              <>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Opening Dr</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Opening Cr</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Period Dr</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Period Cr</th>
              </>
            )}
            <th scope="col" className="px-3 py-2 text-right font-semibold" aria-label="Closing debit balance">Debit</th>
            <th scope="col" className="px-3 py-2 text-right font-semibold" aria-label="Closing credit balance">Credit</th>
          </tr>
        </thead>

        {sections.map((section) => {
          const isCollapsed = section.label ? collapsed?.has(section.id) ?? false : false;
          return (
          <tbody key={section.id} className="divide-y divide-slate-100 dark:divide-slate-800">
            {section.label && (
              <tr className="bg-slate-100/70 dark:bg-slate-800/50">
                <td colSpan={movement ? 9 : 5} className="p-0">
                  <button
                    type="button"
                    onClick={() => onToggleGroup?.(section.id)}
                    aria-expanded={!isCollapsed}
                    className="focus-ring flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] font-bold uppercase tracking-wider text-slate-600 hover:bg-slate-200/50 dark:text-slate-300 dark:hover:bg-slate-700/40"
                  >
                    {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    {section.label}
                    <span className="font-normal normal-case text-slate-400">· {section.rows.length}</span>
                  </button>
                </td>
              </tr>
            )}
            {!isCollapsed && section.rows.map((r) => {
              const color = accountColor(r.accountType);
              return (
                <tr
                  key={r.accountId}
                  onClick={() => onDrill(r)}
                  className="cursor-pointer hover:bg-brand-50/50 dark:hover:bg-brand-500/5"
                  title="Open in General Ledger"
                >
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs text-slate-500 dark:text-slate-400">{r.accountCode}</td>
                  <td className="px-3 py-1.5">
                    <span className="flex items-center gap-2">
                      <AccountDot type={r.accountType} />
                      <span className="text-slate-800 dark:text-slate-100">{r.accountName}</span>
                      {r.isAbnormalBalance && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300" title={`Abnormal ${r.abnormalSide} balance`}>
                          <AlertTriangle className="h-3 w-3" /> Abnormal {r.abnormalSide === 'debit' ? 'Dr' : 'Cr'}
                        </span>
                      )}
                      {!r.isActive && (
                        <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-700 dark:text-slate-300">Inactive</span>
                      )}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400" title={color.family}>{accountTypeLabel(r.accountType)}</td>
                  {movement && (
                    <>
                      <Amt value={r.openingDebit} />
                      <Amt value={r.openingCredit} />
                      <Amt value={r.periodDebits} />
                      <Amt value={r.periodCredits} />
                    </>
                  )}
                  <Amt value={r.closingDebit} className="font-semibold" />
                  <Amt value={r.closingCredit} className="font-semibold" />
                </tr>
              );
            })}
            {section.label && section.subtotals && (
              <tr className="bg-slate-50 font-semibold text-slate-700 dark:bg-slate-800/40 dark:text-slate-200">
                <td colSpan={labelSpan} className="px-3 py-1.5 text-right text-xs uppercase tracking-wide text-slate-500">{section.label} subtotal</td>
                {movement && (
                  <>
                    <Amt value={section.subtotals.openingDebit} always />
                    <Amt value={section.subtotals.openingCredit} always />
                    <Amt value={section.subtotals.periodDebits} always />
                    <Amt value={section.subtotals.periodCredits} always />
                  </>
                )}
                <Amt value={section.subtotals.closingDebit} always />
                <Amt value={section.subtotals.closingCredit} always />
              </tr>
            )}
          </tbody>
          );
        })}

        <tfoot>
          <tr className="border-t-2 border-slate-300 bg-white text-sm font-bold text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-white">
            <td colSpan={labelSpan} className="px-3 py-2.5 text-right uppercase tracking-wide">Grand total</td>
            {movement && (
              <>
                <Amt value={totals.openingDebit} always className="!text-[13px] !font-bold" />
                <Amt value={totals.openingCredit} always className="!text-[13px] !font-bold" />
                <Amt value={totals.periodDebits} always className="!text-[13px] !font-bold" />
                <Amt value={totals.periodCredits} always className="!text-[13px] !font-bold" />
              </>
            )}
            <Amt value={totals.closingDebit} always className="!text-[13px] !font-bold" />
            <Amt value={totals.closingCredit} always className="!text-[13px] !font-bold" />
          </tr>
          {movement && (
            <tr className="text-[11px] text-slate-400">
              <td colSpan={labelSpan} className="px-3 py-1 text-right">Difference</td>
              <td colSpan={2} />
              <td colSpan={2} />
              <td colSpan={2} className={cn('px-3 py-1 text-right font-mono', Math.abs(totals.closingDifference) >= 0.01 ? 'text-red-600' : 'text-emerald-600')}>
                {tbAmountAlways(totals.closingDifference)}
              </td>
            </tr>
          )}
          {!movement && (
            <tr className="text-[11px] text-slate-400">
              <td colSpan={labelSpan} className="px-3 py-1 text-right">Difference</td>
              <td colSpan={2} className={cn('px-3 py-1 text-right font-mono', Math.abs(totals.closingDifference) >= 0.01 ? 'text-red-600' : 'text-emerald-600')}>
                {tbAmountAlways(totals.closingDifference)}
              </td>
            </tr>
          )}
        </tfoot>
      </table>
    </div>
  );
}

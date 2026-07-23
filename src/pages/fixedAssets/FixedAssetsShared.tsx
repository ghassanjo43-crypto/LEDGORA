/** Shared helpers for the Fixed Assets pages. */
import { useMemo } from 'react';
import { useStore } from '@/store/useStore';
import { useCostCenterStore } from '@/store/costCenterStore';
import { useProjectStore } from '@/store/projectStore';
import { useJournalView } from '@/store/journalViewStore';
import type { VoucherPlan } from '@/lib/fixedAssetCalculations';
import type { FixedAssetStatus } from '@/types/fixedAssets';
import { Card } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';

export const money = (n: number): string =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function Table({ head, minWidth = 640, children }: { head: string[]; minWidth?: number; children: React.ReactNode }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth }}>
        <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
          <tr>{head.map((h, i) => <th key={`${h}-${i}`} className="px-4 py-2 text-left">{h}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </Card>
  );
}

export const emptyRow = (cols: number, text: string) => (
  <tr><td colSpan={cols} className="px-4 py-8 text-center text-slate-400">{text}</td></tr>
);

const STATUS_TONE: Record<FixedAssetStatus, 'green' | 'amber' | 'red' | 'slate' | 'blue'> = {
  draft: 'slate',
  pending_approval: 'amber',
  active: 'green',
  fully_depreciated: 'blue',
  suspended: 'amber',
  impaired: 'amber',
  held_for_sale: 'blue',
  disposed: 'red',
  cancelled: 'slate',
};

export function StatusBadge({ status }: { status: FixedAssetStatus }) {
  return <Badge tone={STATUS_TONE[status] ?? 'slate'}>{status.replaceAll('_', ' ')}</Badge>;
}

/** Shared option lists (accounts, dimensions) for editors. */
export function useFaOptions() {
  const accounts = useStore((s) => s.accounts);
  const costCenters = useCostCenterStore((s) => s.costCenters);
  const projects = useProjectStore((s) => s.projects);

  const accountOptions = useMemo(
    () => [
      { value: '', label: '— not mapped —' },
      ...accounts
        .filter((a) => a.isPostingAccount && a.isActive)
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
    ],
    [accounts],
  );
  const costCenterOptions = useMemo(
    () => [{ value: '', label: '—' }, ...costCenters.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }))],
    [costCenters],
  );
  const projectOptions = useMemo(
    () => [{ value: '', label: '—' }, ...projects.map((p) => ({ value: p.id, label: p.name }))],
    [projects],
  );
  const accountLabel = (id: string): string => {
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.code} — ${a.name}` : '(unmapped)';
  };
  return { accounts, accountOptions, costCenterOptions, projectOptions, accountLabel };
}

/**
 * Journal preview — shown BEFORE posting so the user sees exactly which
 * balanced voucher will be generated (accounts, amounts, dimensions,
 * narration). Posting is impossible while the plan carries an error.
 */
export function JournalPreview({ plan, currency }: { plan: VoucherPlan | null; currency: string }) {
  const accounts = useStore((s) => s.accounts);
  if (!plan) return null;
  if (!plan.ok) return <Alert variant="error" title="Cannot post">{plan.error}</Alert>;
  const name = (id: string): string => {
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.code} — ${a.name}` : id;
  };
  const totalD = plan.lines.reduce((s, l) => s + l.debit, 0);
  const totalC = plan.lines.reduce((s, l) => s + l.credit, 0);
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700">
      <div className="border-b border-slate-200 px-3 py-1.5 text-xs font-semibold uppercase text-slate-500 dark:border-slate-700">
        Journal preview ({currency})
      </div>
      <table className="w-full text-xs">
        <thead className="text-slate-400">
          <tr><th className="px-3 py-1 text-left">Account</th><th className="px-3 py-1 text-left">Narration</th><th className="px-3 py-1 text-right">Debit</th><th className="px-3 py-1 text-right">Credit</th></tr>
        </thead>
        <tbody>
          {plan.lines.map((l, i) => (
            <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
              <td className="px-3 py-1 font-medium">{name(l.accountId)}</td>
              <td className="px-3 py-1 text-slate-500">{l.description}</td>
              <td className="px-3 py-1 text-right tabular-nums">{l.debit ? money(l.debit) : ''}</td>
              <td className="px-3 py-1 text-right tabular-nums">{l.credit ? money(l.credit) : ''}</td>
            </tr>
          ))}
          <tr className="border-t border-slate-200 font-semibold dark:border-slate-700">
            <td className="px-3 py-1" colSpan={2}>Totals</td>
            <td className="px-3 py-1 text-right tabular-nums">{money(totalD)}</td>
            <td className="px-3 py-1 text-right tabular-nums">{money(totalC)}</td>
          </tr>
        </tbody>
      </table>
      {Math.abs(totalD - totalC) > 0.004 && <Alert variant="error">The journal is unbalanced and cannot be posted.</Alert>}
    </div>
  );
}

/** Link to a generated voucher in the General Journal. */
export function VoucherLink({ entryId, entryNumber }: { entryId: string; entryNumber: string }) {
  const requestFocusEntry = useJournalView((s) => s.requestFocusEntry);
  const setActiveView = useStore((s) => s.setActiveView);
  if (!entryId) return <span className="text-slate-400">—</span>;
  return (
    <button
      type="button"
      className="focus-ring rounded font-medium text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
      onClick={() => { requestFocusEntry(entryId); setActiveView('journal'); }}
    >
      {entryNumber || 'voucher'}
    </button>
  );
}

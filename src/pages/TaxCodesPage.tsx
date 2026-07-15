import { useMemo, useState } from 'react';
import { Plus, ChevronDown, Pencil, Copy, Power, Archive, Percent } from 'lucide-react';
import type { TaxCategory, TaxCode } from '@/types/taxCode';
import { useStore } from '@/store/useStore';
import { useTaxCodeStore } from '@/store/taxCodeStore';
import { cn as cx } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import type { BadgeTone } from '@/data/ifrsOptions';
import { Dropdown, MenuItem } from '@/components/ui/Dropdown';
import { PageActions } from '@/components/ui/PageActions';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { TaxCodeEditor } from '@/components/tax/TaxCodeEditor';

const STATUS_TONE: Record<TaxCode['status'], BadgeTone> = { active: 'green', inactive: 'slate', archived: 'red' };
const CATEGORY_TONE: Partial<Record<TaxCategory, BadgeTone>> = { standard: 'blue', reduced: 'cyan', 'zero-rated': 'teal', exempt: 'amber', 'out-of-scope': 'slate', 'reverse-charge': 'violet', import: 'indigo', withholding: 'rose' };

export function TaxCodesPage() {
  const accounts = useStore((s) => s.accounts);
  const taxCodes = useTaxCodeStore((s) => s.taxCodes);
  const store = useTaxCodeStore();
  const { notify } = useToast();

  const [editorId, setEditorId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<TaxCode['status'] | 'ALL'>('ALL');
  const [directionFilter, setDirectionFilter] = useState<string>('ALL');
  const [search, setSearch] = useState('');

  const accName = (id: string | undefined): string => { const a = accounts.find((x) => x.id === id); return a ? `${a.code}` : '—'; };

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return taxCodes
      .filter((c) => (statusFilter === 'ALL' ? true : c.status === statusFilter))
      .filter((c) => (directionFilter === 'ALL' ? true : c.direction === directionFilter))
      .filter((c) => (q ? `${c.code} ${c.name}`.toLowerCase().includes(q) : true))
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [taxCodes, statusFilter, directionFilter, search]);

  const onNew = (): void => { const res = store.createTaxCode(); if (res.ok && res.id) setEditorId(res.id); };
  const act = (fn: () => { ok: boolean; error?: string }, ok: string): void => { const r = fn(); if (r.ok) notify(ok, 'success'); else notify(r.error ?? 'Action failed.', 'error'); };

  return (
    <>
      <PageActions><Button onClick={onNew}><Plus className="h-4 w-4" /> New tax code</Button></PageActions>

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200/80 bg-white p-3 shadow-card dark:border-slate-800 dark:bg-slate-900">
        <Select className="h-9 w-auto" options={[{ value: 'ALL', label: 'All statuses' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'archived', label: 'Archived' }]} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as TaxCode['status'] | 'ALL')} aria-label="Status" />
        <Select className="h-9 w-auto" options={[{ value: 'ALL', label: 'All directions' }, { value: 'sales', label: 'Sales' }, { value: 'purchase', label: 'Purchase' }, { value: 'both', label: 'Both' }, { value: 'withholding-payable', label: 'Withholding' }]} value={directionFilter} onChange={(e) => setDirectionFilter(e.target.value)} aria-label="Direction" />
        <div className="relative min-w-[180px] flex-1"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search code or name…" className="h-9" /></div>
      </div>

      {rows.length === 0 ? (
        <Card><CardBody><EmptyState icon={Percent} title="No tax codes" description="Create a tax code to configure its rate, accounts, effective-dated versions and reporting boxes. Tax codes are the single source of tax calculation across the app." /></CardBody></Card>
      ) : (
        <Card className="overflow-hidden"><div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400"><tr>
              {['Code', 'Name', 'Category', 'Direction', 'Rate', 'Method', 'Output', 'Input', 'Effective', 'Boxes', 'Status', ''].map((h) => (
                <th key={h} className={cx('px-3 py-2 font-semibold', h === 'Rate' ? 'text-right' : 'text-left')}>{h}</th>
              ))}
            </tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/20">
                  <td className="px-3 py-2 font-mono text-xs font-semibold">{c.code}</td>
                  <td className="px-3 py-2">{c.name}{(c.isDefaultSales || c.isDefaultPurchase) && <Badge tone="indigo" className="ml-1.5">default</Badge>}</td>
                  <td className="px-3 py-2"><Badge tone={CATEGORY_TONE[c.category] ?? 'slate'}>{c.category}</Badge></td>
                  <td className="px-3 py-2 text-xs text-slate-500">{c.direction}</td>
                  <td className="px-3 py-2 text-right font-mono">{c.rateType === 'zero' ? '0%' : `${c.rate}%`}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{c.calculationMethod}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{accName(c.outputTaxAccountId)}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{accName(c.inputTaxAccountId)}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{c.effectiveFrom}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{c.reportingBoxIds.length}</td>
                  <td className="px-3 py-2"><Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge></td>
                  <td className="px-3 py-2 text-right">
                    <Dropdown label="Actions" align="right" trigger={(o) => (<span className={cx('inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300', o && 'bg-slate-50')}>Actions <ChevronDown className="h-3 w-3" /></span>)}>
                      <MenuItem onClick={() => setEditorId(c.id)}><Pencil className="h-4 w-4" /> {c.status === 'archived' ? 'View' : 'Edit'}</MenuItem>
                      <MenuItem onClick={() => act(() => store.duplicateTaxCode(c.id), 'Tax code duplicated.')}><Copy className="h-4 w-4" /> Duplicate</MenuItem>
                      {c.status === 'active' && <MenuItem onClick={() => act(() => store.deactivateTaxCode(c.id), 'Tax code deactivated.')}><Power className="h-4 w-4" /> Deactivate</MenuItem>}
                      {c.status === 'inactive' && <MenuItem onClick={() => act(() => store.activateTaxCode(c.id), 'Tax code activated.')}><Power className="h-4 w-4" /> Activate</MenuItem>}
                      {c.status !== 'archived' && <MenuItem onClick={() => act(() => store.archiveTaxCode(c.id), 'Tax code archived.')}><Archive className="h-4 w-4" /> Archive</MenuItem>}
                    </Dropdown>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></Card>
      )}

      {editorId && <TaxCodeEditor taxCodeId={editorId} onClose={() => setEditorId(null)} />}
    </>
  );
}

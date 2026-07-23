/**
 * Universal Journal Voucher workbench.
 *
 * Register (with status views: drafts, pending approval, posted, reversed),
 * an Excel-like line editor with live totals/difference and journal preview,
 * asset/bank sub-forms per voucher kind, recurring templates, voucher types &
 * settings. The General Journal remains the accounting record — this page is
 * the source-document interface over it.
 */
import { useEffect, useMemo, useState } from 'react';
import { useJournalVoucherStore, makeBlankVoucher, makeBlankLine } from '@/store/journalVoucherStore';
import { useFixedAssetStore } from '@/store/fixedAssetStore';
import { useStore } from '@/store/useStore';
import { useCostCenterStore } from '@/store/costCenterStore';
import { useProjectStore } from '@/store/projectStore';
import { useJournalView } from '@/store/journalViewStore';
import {
  activeLines, computeVoucherTotals, renumber, withCredit, withDebit,
} from '@/lib/journalVoucherValidation';
import type {
  JournalVoucher, JournalVoucherLine, JournalVoucherStatus, RecurringVoucherTemplate, VoucherTypeConfig,
} from '@/types/journalVoucher';
import { generateId, nowIso } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Drawer } from '@/components/ui/Drawer';
import { Toggle } from '@/components/ui/Toggle';
import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { ArrowDown, ArrowUp, Copy, Plus, Printer, Trash2 } from 'lucide-react';

const money = (n: number): string => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = (): string => new Date().toISOString().slice(0, 10);

const STATUS_TONE: Record<JournalVoucherStatus, 'slate' | 'amber' | 'red' | 'green' | 'blue' | 'violet'> = {
  draft: 'slate', pending_approval: 'amber', rejected: 'red', approved: 'blue',
  posted: 'green', partially_reversed: 'violet', reversed: 'violet', cancelled: 'slate',
};

type PageTab = 'register' | 'templates' | 'config';
type RegisterView = 'all' | 'draft' | 'pending_approval' | 'posted' | 'reversed';

export function JournalVouchersPage() {
  const store = useJournalVoucherStore();
  const baseCurrency = useStore((s) => s.settings.baseCurrency);
  const focusVoucherNumber = useJournalView((s) => s.focusVoucherNumber);
  const requestFocusVoucher = useJournalView((s) => s.requestFocusVoucher);
  const [tab, setTab] = useState<PageTab>('register');
  const [view, setView] = useState<RegisterView>('all');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [editing, setEditing] = useState<JournalVoucher | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  useState(() => { store.ensureSeeded(); return true; });

  // Back-link from the General Journal: open the referenced voucher.
  useEffect(() => {
    if (!focusVoucherNumber) return;
    const v = store.vouchers.find((x) => x.number === focusVoucherNumber);
    if (v) setViewingId(v.id);
    requestFocusVoucher(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusVoucherNumber]);

  const report = (r: { ok: boolean; error?: string }, okText: string): boolean => {
    setMsg(r.ok ? { tone: 'success', text: okText } : { tone: 'error', text: r.error ?? 'Action failed.' });
    return r.ok;
  };

  const typeById = useMemo(() => new Map(store.types.map((t) => [t.id, t])), [store.types]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return store.vouchers
      .filter((v) => {
        if (view === 'draft') return v.status === 'draft' || v.status === 'rejected';
        if (view === 'pending_approval') return v.status === 'pending_approval';
        if (view === 'posted') return v.status === 'posted' || v.status === 'partially_reversed';
        if (view === 'reversed') return v.status === 'reversed' || !!v.reversalOfVoucherId;
        return true;
      })
      .filter((v) => !typeFilter || v.typeId === typeFilter)
      .filter((v) => !q || `${v.number} ${v.description} ${v.externalReference} ${v.internalReference} ${v.journalEntryNumber}`.toLowerCase().includes(q))
      .slice()
      .reverse();
  }, [store.vouchers, view, typeFilter, search]);

  const tabs: TabItem<PageTab>[] = [
    { id: 'register', label: 'Voucher Register' },
    { id: 'templates', label: 'Recurring Templates' },
    { id: 'config', label: 'Types & Settings' },
  ];

  const viewing = viewingId ? store.vouchers.find((v) => v.id === viewingId) ?? null : null;

  return (
    <div className="space-y-4">
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}

      {tab === 'register' && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              <Select className="w-44" value={view} onChange={(e) => setView(e.target.value as RegisterView)}
                options={[{ value: 'all', label: 'All vouchers' }, { value: 'draft', label: 'Drafts' }, { value: 'pending_approval', label: 'Pending approval' }, { value: 'posted', label: 'Posted' }, { value: 'reversed', label: 'Reversed' }]} />
              <Select className="w-52" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
                options={[{ value: '', label: 'All types' }, ...store.types.map((t) => ({ value: t.id, label: t.name }))]} />
              <Input className="w-56" placeholder="Search vouchers…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Button onClick={() => {
              const type = store.types.find((t) => t.isActive);
              if (!type) { setMsg({ tone: 'error', text: 'No active voucher types configured.' }); return; }
              setMsg(null);
              setEditing(makeBlankVoucher(type));
            }}>
              New journal voucher
            </Button>
          </div>

          <Card className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
                <tr>
                  <th className="px-4 py-2 text-left">Voucher</th><th className="px-4 py-2 text-left">Date</th>
                  <th className="px-4 py-2 text-left">Type</th><th className="px-4 py-2 text-left">Description</th>
                  <th className="px-4 py-2 text-right">Amount</th><th className="px-4 py-2 text-left">Ccy</th>
                  <th className="px-4 py-2 text-left">Status</th><th className="px-4 py-2 text-left">Journal</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => {
                  const totals = computeVoucherTotals(v.lines, 1);
                  return (
                    <tr key={v.id} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="px-4 py-2 font-medium">{v.number}<span className="block text-[11px] text-slate-400">{v.preparedBy}</span></td>
                      <td className="px-4 py-2">{v.postingDate}</td>
                      <td className="px-4 py-2 text-slate-500">{typeById.get(v.typeId)?.name ?? '—'}</td>
                      <td className="px-4 py-2 max-w-[220px] truncate" title={v.description}>{v.description}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{money(totals.debit)}</td>
                      <td className="px-4 py-2">{v.currency}</td>
                      <td className="px-4 py-2"><Badge tone={STATUS_TONE[v.status]}>{v.status.replaceAll('_', ' ')}</Badge></td>
                      <td className="px-4 py-2 text-xs text-slate-500">{v.journalEntryNumber || '—'}</td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        {(v.status === 'draft' || v.status === 'rejected') && (
                          <Button size="sm" variant="ghost" onClick={() => { setMsg(null); setEditing({ ...v, lines: v.lines.map((l) => ({ ...l })) }); }}>Edit</Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => { setMsg(null); setViewingId(v.id); }}>Open</Button>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && <tr><td colSpan={9} className="px-4 py-10 text-center text-slate-400">No vouchers in this view yet.</td></tr>}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {tab === 'templates' && <TemplatesPanel onMsg={setMsg} />}
      {tab === 'config' && <ConfigPanel onMsg={setMsg} />}

      {/* ── Editor ──────────────────────────────────────────────────────── */}
      <Drawer open={!!editing} onClose={() => setEditing(null)} title={editing?.number ? `Edit ${editing.number}` : 'New journal voucher'} widthClassName="max-w-5xl">
        {editing && (
          <VoucherEditor
            voucher={editing}
            onChange={setEditing}
            baseCurrency={baseCurrency}
            onSave={() => { if (report(store.saveDraft(editing), 'Draft saved.')) setEditing(null); }}
            onSaveAndSubmit={() => {
              const saved = store.saveDraft(editing);
              if (!report(saved, '')) return;
              if (report(store.submitVoucher(saved.id!), 'Submitted for approval.')) setEditing(null);
            }}
            onSaveAndPost={() => {
              const saved = store.saveDraft(editing);
              if (!report(saved, '')) return;
              if (report(store.postVoucher(saved.id!), 'Voucher posted to the General Journal.')) setEditing(null);
            }}
          />
        )}
      </Drawer>

      {/* ── Detail / actions ────────────────────────────────────────────── */}
      <Drawer open={!!viewing} onClose={() => setViewingId(null)} title={viewing ? `${viewing.number} — ${typeById.get(viewing.typeId)?.name ?? ''}` : ''} widthClassName="max-w-3xl">
        {viewing && (
          <VoucherDetail
            voucher={viewing}
            type={typeById.get(viewing.typeId)}
            onAction={(r, text) => { report(r, text); }}
          />
        )}
      </Drawer>
    </div>
  );
}

/* ── Editor ───────────────────────────────────────────────────────────────── */

function VoucherEditor({ voucher, onChange, baseCurrency, onSave, onSaveAndSubmit, onSaveAndPost }: {
  voucher: JournalVoucher;
  onChange: (v: JournalVoucher) => void;
  baseCurrency: string;
  onSave: () => void;
  onSaveAndSubmit: () => void;
  onSaveAndPost: () => void;
}) {
  const store = useJournalVoucherStore();
  const accounts = useStore((s) => s.accounts);
  const type = store.types.find((t) => t.id === voucher.typeId);
  const assets = useFixedAssetStore((s) => s.assets);
  const accountOptions = useMemo(
    () => [{ value: '', label: '—' }, ...accounts.filter((a) => a.isPostingAccount && a.isActive).sort((a, b) => a.code.localeCompare(b.code)).map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }))],
    [accounts],
  );
  const isAssetKind = type && ['asset_acquisition', 'asset_disposal', 'asset_depreciation', 'asset_impairment'].includes(type.kind);
  const foreign = voucher.currency.toUpperCase() !== baseCurrency.toUpperCase();
  const totals = computeVoucherTotals(voucher.lines, foreign ? voucher.exchangeRate : 1);
  const balanced = Math.abs(totals.difference) < 0.005;

  const setLine = (id: string, patch: (l: JournalVoucherLine) => JournalVoucherLine): void =>
    onChange({ ...voucher, lines: voucher.lines.map((l) => (l.id === id ? patch(l) : l)) });
  const lineOp = (op: (lines: JournalVoucherLine[]) => JournalVoucherLine[]): void =>
    onChange({ ...voucher, lines: renumber(op(voucher.lines)) });

  return (
    <div className="space-y-4">
      {type?.warnFormalDocument && (
        <Alert variant="warning">
          {type.name} transactions are normally recorded through a formal source document (invoice, bill, credit or debit note).
          Use this voucher only when no such document exists — it must not replace a legally required document.
        </Alert>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="Voucher type">
          <Select value={voucher.typeId} onChange={(e) => {
            const t = store.types.find((x) => x.id === e.target.value);
            onChange({ ...voucher, typeId: e.target.value, description: voucher.description || t?.defaultDescription || '' });
          }} options={store.types.filter((t) => t.isActive).map((t) => ({ value: t.id, label: t.name }))} />
        </Field>
        <Field label="Transaction date"><Input type="date" value={voucher.transactionDate} onChange={(e) => onChange({ ...voucher, transactionDate: e.target.value })} /></Field>
        <Field label="Posting date"><Input type="date" value={voucher.postingDate} onChange={(e) => onChange({ ...voucher, postingDate: e.target.value, period: e.target.value.slice(0, 7) })} /></Field>
        <Field label="Document date"><Input type="date" value={voucher.documentDate} onChange={(e) => onChange({ ...voucher, documentDate: e.target.value })} /></Field>
        <Field label="Currency"><Input value={voucher.currency} onChange={(e) => onChange({ ...voucher, currency: e.target.value.toUpperCase() })} /></Field>
        <Field label={`Exchange rate → ${baseCurrency}`}><Input type="number" step="0.0001" value={String(voucher.exchangeRate)} onChange={(e) => onChange({ ...voucher, exchangeRate: Number(e.target.value) || 0 })} disabled={!foreign} /></Field>
        <Field label="External reference"><Input value={voucher.externalReference} onChange={(e) => onChange({ ...voucher, externalReference: e.target.value })} /></Field>
        <Field label="Internal reference"><Input value={voucher.internalReference} onChange={(e) => onChange({ ...voucher, internalReference: e.target.value })} /></Field>
        <Field label="Source module" hint="Idempotency guard"><Input value={voucher.sourceModule} onChange={(e) => onChange({ ...voucher, sourceModule: e.target.value })} /></Field>
        <Field label="Source transaction ID"><Input value={voucher.sourceTransactionId} onChange={(e) => onChange({ ...voucher, sourceTransactionId: e.target.value })} /></Field>
        {type?.allowAutoReversal && (
          <Field label="Automatic reversal date"><Input type="date" value={voucher.autoReverseDate} onChange={(e) => onChange({ ...voucher, autoReverseDate: e.target.value })} /></Field>
        )}
        <Field label="Branch"><Input value={voucher.branch} onChange={(e) => onChange({ ...voucher, branch: e.target.value })} /></Field>
      </div>
      <Field label="Description" required><Input value={voucher.description} onChange={(e) => onChange({ ...voucher, description: e.target.value })} /></Field>
      <Field label="Narration"><Textarea value={voucher.narration} onChange={(e) => onChange({ ...voucher, narration: e.target.value })} /></Field>

      {isAssetKind ? (
        <AssetSubForm voucher={voucher} onChange={onChange} kind={type!.kind} accountOptions={accountOptions} assets={assets} />
      ) : (
        <>
          {/* ── Excel-like line grid ─────────────────────────────────── */}
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-xs">
              <thead className="bg-slate-50 text-[11px] uppercase text-slate-500 dark:bg-slate-800/50">
                <tr>
                  <th className="px-2 py-1.5 text-left w-8">#</th>
                  <th className="px-2 py-1.5 text-left min-w-[220px]">Account</th>
                  <th className="px-2 py-1.5 text-right w-28">Debit</th>
                  <th className="px-2 py-1.5 text-right w-28">Credit</th>
                  <th className="px-2 py-1.5 text-left min-w-[160px]">Description</th>
                  <th className="px-2 py-1.5 text-left w-32">Cost center</th>
                  <th className="px-2 py-1.5 text-left w-32">Project</th>
                  {type?.allowTaxCodes && <th className="px-2 py-1.5 text-left w-24">Tax code</th>}
                  {type?.allowTaxCodes && <th className="px-2 py-1.5 text-right w-24">Tax amt</th>}
                  <th className="px-2 py-1.5 text-left w-28">Reference</th>
                  <th className="px-2 py-1.5 w-28" />
                </tr>
              </thead>
              <tbody>
                {voucher.lines.map((l, idx) => (
                  <tr key={l.id} className="border-t border-slate-100 align-top dark:border-slate-800">
                    <td className="px-2 py-1 text-slate-400">{l.lineNumber}</td>
                    <td className="px-2 py-1"><LineAccountPicker accounts={accountOptions} value={l.accountId} onChange={(id) => setLine(l.id, (x) => ({ ...x, accountId: id }))} /></td>
                    <td className="px-2 py-1"><Input className="text-right" type="number" value={l.debit || ''} onChange={(e) => setLine(l.id, (x) => withDebit(x, Number(e.target.value) || 0))} /></td>
                    <td className="px-2 py-1"><Input className="text-right" type="number" value={l.credit || ''} onChange={(e) => setLine(l.id, (x) => withCredit(x, Number(e.target.value) || 0))} /></td>
                    <td className="px-2 py-1"><Input value={l.description} onChange={(e) => setLine(l.id, (x) => ({ ...x, description: e.target.value }))} /></td>
                    <td className="px-2 py-1"><DimensionPicker kind="costCenter" value={l.costCenterId} onChange={(id) => setLine(l.id, (x) => ({ ...x, costCenterId: id }))} /></td>
                    <td className="px-2 py-1"><DimensionPicker kind="project" value={l.projectId} onChange={(id) => setLine(l.id, (x) => ({ ...x, projectId: id }))} /></td>
                    {type?.allowTaxCodes && <td className="px-2 py-1"><Input value={l.taxCode} onChange={(e) => setLine(l.id, (x) => ({ ...x, taxCode: e.target.value }))} /></td>}
                    {type?.allowTaxCodes && <td className="px-2 py-1"><Input className="text-right" type="number" value={l.taxAmount || ''} onChange={(e) => setLine(l.id, (x) => ({ ...x, taxAmount: Number(e.target.value) || 0 }))} /></td>}
                    <td className="px-2 py-1"><Input value={l.reference} onChange={(e) => setLine(l.id, (x) => ({ ...x, reference: e.target.value }))} /></td>
                    <td className="px-2 py-1 whitespace-nowrap text-right">
                      <button type="button" title="Insert below" className="focus-ring rounded p-1 text-slate-400 hover:text-slate-600" onClick={() => lineOp((ls) => [...ls.slice(0, idx + 1), makeBlankLine(), ...ls.slice(idx + 1)])}><Plus className="h-3.5 w-3.5" /></button>
                      <button type="button" title="Duplicate" className="focus-ring rounded p-1 text-slate-400 hover:text-slate-600" onClick={() => lineOp((ls) => [...ls.slice(0, idx + 1), { ...l, id: generateId('jvl') }, ...ls.slice(idx + 1)])}><Copy className="h-3.5 w-3.5" /></button>
                      <button type="button" title="Move up" className="focus-ring rounded p-1 text-slate-400 hover:text-slate-600 disabled:opacity-30" disabled={idx === 0} onClick={() => lineOp((ls) => { const c = [...ls]; [c[idx - 1], c[idx]] = [c[idx]!, c[idx - 1]!]; return c; })}><ArrowUp className="h-3.5 w-3.5" /></button>
                      <button type="button" title="Move down" className="focus-ring rounded p-1 text-slate-400 hover:text-slate-600 disabled:opacity-30" disabled={idx === voucher.lines.length - 1} onClick={() => lineOp((ls) => { const c = [...ls]; [c[idx + 1], c[idx]] = [c[idx]!, c[idx + 1]!]; return c; })}><ArrowDown className="h-3.5 w-3.5" /></button>
                      <button type="button" title="Delete" className="focus-ring rounded p-1 text-slate-400 hover:text-red-500 disabled:opacity-30" disabled={voucher.lines.length <= 2} onClick={() => lineOp((ls) => ls.filter((x) => x.id !== l.id))}><Trash2 className="h-3.5 w-3.5" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex justify-between border-t border-slate-200 px-3 py-2 text-xs dark:border-slate-700">
              <Button size="sm" variant="ghost" onClick={() => lineOp((ls) => [...ls, makeBlankLine()])}><Plus className="h-3.5 w-3.5" /> Add line</Button>
              <div className="flex items-center gap-4 tabular-nums">
                <span>Debit <b>{money(totals.debit)}</b></span>
                <span>Credit <b>{money(totals.credit)}</b></span>
                <span className={balanced ? 'text-emerald-600 dark:text-emerald-400' : 'font-semibold text-red-600 dark:text-red-400'}>
                  Difference {money(totals.difference)}
                </span>
                {foreign && <span className="text-slate-400">Base {baseCurrency}: {money(totals.baseDebit)} / {money(totals.baseCredit)}</span>}
              </div>
            </div>
          </Card>
          <JournalPreviewCard voucher={voucher} baseCurrency={baseCurrency} />
        </>
      )}

      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onSave}>Save draft</Button>
        {type?.approvalRequired ? (
          <Button onClick={onSaveAndSubmit}>Save &amp; submit for approval</Button>
        ) : (
          <Button onClick={onSaveAndPost} disabled={!isAssetKind && !balanced}>Save &amp; post</Button>
        )}
      </div>
    </div>
  );
}

/** Searchable account picker (datalist-backed for keyboard-friendly search). */
function LineAccountPicker({ accounts, value, onChange }: { accounts: Array<{ value: string; label: string }>; value: string; onChange: (id: string) => void }) {
  return (
    <Select
      options={accounts}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function DimensionPicker({ kind, value, onChange }: { kind: 'costCenter' | 'project'; value: string; onChange: (id: string) => void }) {
  const options = useDimensionOptions(kind);
  return <Select options={options} value={value} onChange={(e) => onChange(e.target.value)} />;
}

function useDimensionOptions(kind: 'costCenter' | 'project'): Array<{ value: string; label: string }> {
  const costCenters = useCostCenterStore((s) => s.costCenters);
  const projects = useProjectStore((s) => s.projects);
  return useMemo(
    () => kind === 'costCenter'
      ? [{ value: '', label: '—' }, ...costCenters.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }))]
      : [{ value: '', label: '—' }, ...projects.map((p) => ({ value: p.id, label: p.name }))],
    [kind, costCenters, projects],
  );
}

/** Journal preview mirroring exactly what insertPostedEntry will receive. */
function JournalPreviewCard({ voucher, baseCurrency }: { voucher: JournalVoucher; baseCurrency: string }) {
  const accounts = useStore((s) => s.accounts);
  const lines = activeLines(voucher.lines);
  if (lines.length === 0) return null;
  const foreign = voucher.currency.toUpperCase() !== baseCurrency.toUpperCase();
  const rate = foreign ? voucher.exchangeRate : 1;
  const totals = computeVoucherTotals(voucher.lines, rate);
  const name = (id: string): string => { const a = accounts.find((x) => x.id === id); return a ? `${a.code} — ${a.name}` : '(no account)'; };
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700">
      <div className="border-b border-slate-200 px-3 py-1.5 text-xs font-semibold uppercase text-slate-500 dark:border-slate-700">
        Journal preview — {voucher.currency}{foreign ? ` @ ${voucher.exchangeRate} → ${baseCurrency}` : ''}
      </div>
      <table className="w-full text-xs">
        <thead className="text-slate-400"><tr><th className="px-3 py-1 text-left">Account</th><th className="px-3 py-1 text-left">Narration</th><th className="px-3 py-1 text-right">Debit</th><th className="px-3 py-1 text-right">Credit</th>{foreign && <th className="px-3 py-1 text-right">Base Dr</th>}{foreign && <th className="px-3 py-1 text-right">Base Cr</th>}</tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="border-t border-slate-100 dark:border-slate-800">
              <td className="px-3 py-1 font-medium">{name(l.accountId)}</td>
              <td className="px-3 py-1 text-slate-500">{l.description || voucher.description}</td>
              <td className="px-3 py-1 text-right tabular-nums">{l.debit ? money(l.debit) : ''}</td>
              <td className="px-3 py-1 text-right tabular-nums">{l.credit ? money(l.credit) : ''}</td>
              {foreign && <td className="px-3 py-1 text-right tabular-nums text-slate-400">{l.debit ? money(l.debit * rate) : ''}</td>}
              {foreign && <td className="px-3 py-1 text-right tabular-nums text-slate-400">{l.credit ? money(l.credit * rate) : ''}</td>}
            </tr>
          ))}
          <tr className="border-t border-slate-200 font-semibold dark:border-slate-700">
            <td className="px-3 py-1" colSpan={2}>{Math.abs(totals.difference) < 0.005 ? 'Balanced' : `UNBALANCED (diff ${money(totals.difference)})`}</td>
            <td className="px-3 py-1 text-right tabular-nums">{money(totals.debit)}</td>
            <td className="px-3 py-1 text-right tabular-nums">{money(totals.credit)}</td>
            {foreign && <td className="px-3 py-1 text-right tabular-nums">{money(totals.baseDebit)}</td>}
            {foreign && <td className="px-3 py-1 text-right tabular-nums">{money(totals.baseCredit)}</td>}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/* ── Asset sub-form (delegated posting) ───────────────────────────────────── */

function AssetSubForm({ voucher, onChange, kind, accountOptions, assets }: {
  voucher: JournalVoucher;
  onChange: (v: JournalVoucher) => void;
  kind: string;
  accountOptions: Array<{ value: string; label: string }>;
  assets: ReturnType<typeof useFixedAssetStore.getState>['assets'];
}) {
  const input = voucher.assetInput ?? { assetId: '' };
  const patch = (p: Partial<NonNullable<JournalVoucher['assetInput']>>): void =>
    onChange({ ...voucher, assetInput: { ...input, ...p } });
  const assetOptions = useMemo(() => {
    const pool = kind === 'asset_acquisition'
      ? assets.filter((a) => a.status === 'draft' || a.status === 'pending_approval')
      : assets.filter((a) => !['disposed', 'cancelled', 'draft'].includes(a.status));
    return [{ value: '', label: 'Select an asset…' }, ...pool.map((a) => ({ value: a.id, label: `${a.assetCode} — ${a.name}` }))];
  }, [assets, kind]);

  return (
    <Card><CardBody className="space-y-3">
      <Alert variant="info">
        This voucher posts through the Fixed Assets module: the journal entry and the asset register update together,
        and duplicate capitalization is blocked. Create draft assets in Fixed Assets → Asset Register first.
      </Alert>
      <Field label="Fixed asset" required><Select options={assetOptions} value={input.assetId} onChange={(e) => patch({ assetId: e.target.value })} /></Field>
      {kind === 'asset_acquisition' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Funding">
            <Select value={input.funding ?? 'manual'} onChange={(e) => patch({ funding: e.target.value as NonNullable<JournalVoucher['assetInput']>['funding'] })}
              options={[{ value: 'credit', label: 'Payable' }, { value: 'bank', label: 'Bank' }, { value: 'cash', label: 'Cash' }, { value: 'manual', label: 'Owner contribution / loan / other' }, { value: 'auc', label: 'Asset under construction' }]} />
          </Field>
          <Field label="Funding account" required><Select options={accountOptions} value={input.creditAccountId ?? ''} onChange={(e) => patch({ creditAccountId: e.target.value })} /></Field>
          <Field label="Base cost" required><Input type="number" value={String(input.baseCost ?? 0)} onChange={(e) => patch({ baseCost: Number(e.target.value) || 0 })} /></Field>
          <Field label="Recoverable input tax"><Input type="number" value={String(input.recoverableTax ?? 0)} onChange={(e) => patch({ recoverableTax: Number(e.target.value) || 0 })} /></Field>
          <Field label="Non-recoverable tax (capitalized)"><Input type="number" value={String(input.nonRecoverableTax ?? 0)} onChange={(e) => patch({ nonRecoverableTax: Number(e.target.value) || 0 })} /></Field>
          <Field label="Other capitalized costs"><Input type="number" value={String(input.otherCapitalizedCosts ?? 0)} onChange={(e) => patch({ otherCapitalizedCosts: Number(e.target.value) || 0 })} /></Field>
        </div>
      )}
      {kind === 'asset_disposal' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Proceeds (excl. tax)"><Input type="number" value={String(input.proceeds ?? 0)} onChange={(e) => patch({ proceeds: Number(e.target.value) || 0 })} /></Field>
          <Field label="Disposal costs"><Input type="number" value={String(input.disposalCosts ?? 0)} onChange={(e) => patch({ disposalCosts: Number(e.target.value) || 0 })} /></Field>
          <Field label="Output tax"><Input type="number" value={String(input.outputTax ?? 0)} onChange={(e) => patch({ outputTax: Number(e.target.value) || 0 })} /></Field>
          <Field label="Output tax account"><Select options={accountOptions} value={input.outputTaxAccountId ?? ''} onChange={(e) => patch({ outputTaxAccountId: e.target.value })} /></Field>
          <Field label="Bank / cash / receivable account"><Select options={accountOptions} value={input.receiptAccountId ?? ''} onChange={(e) => patch({ receiptAccountId: e.target.value })} /></Field>
          <Field label="Portion % (blank = full)"><Input type="number" value={String(input.portionPercent ?? '')} onChange={(e) => patch({ portionPercent: Number(e.target.value) || undefined })} /></Field>
          <div className="col-span-2"><Toggle checked={input.catchUpDepreciation ?? true} onChange={(v) => patch({ catchUpDepreciation: v })} label="Post catch-up depreciation to the disposal date first" /></div>
        </div>
      )}
      {kind === 'asset_depreciation' && (
        <Field label="Charge (blank = computed by method through the posting date)">
          <Input type="number" value={String(input.amount ?? '')} onChange={(e) => patch({ amount: Number(e.target.value) || undefined })} />
        </Field>
      )}
      {kind === 'asset_impairment' && (
        <Field label="Recoverable amount" required>
          <Input type="number" value={String(input.recoverableAmount ?? 0)} onChange={(e) => patch({ recoverableAmount: Number(e.target.value) || 0 })} />
        </Field>
      )}
    </CardBody></Card>
  );
}

/* ── Detail drawer (posted / workflow actions) ────────────────────────────── */

function VoucherDetail({ voucher, type, onAction }: {
  voucher: JournalVoucher;
  type: VoucherTypeConfig | undefined;
  onAction: (r: { ok: boolean; error?: string }, text: string) => void;
}) {
  const store = useJournalVoucherStore();
  const baseCurrency = useStore((s) => s.settings.baseCurrency);
  const setActiveView = useStore((s) => s.setActiveView);
  const requestFocusEntry = useJournalView((s) => s.requestFocusEntry);
  const totals = computeVoucherTotals(voucher.lines, 1);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
        <DetailRow label="Status"><Badge tone={STATUS_TONE[voucher.status]}>{voucher.status.replaceAll('_', ' ')}</Badge></DetailRow>
        <DetailRow label="Posting date">{voucher.postingDate} (period {voucher.period})</DetailRow>
        <DetailRow label="Currency">{voucher.currency} @ {voucher.exchangeRate}</DetailRow>
        <DetailRow label="Amount">{money(totals.debit)}</DetailRow>
        <DetailRow label="Prepared by">{voucher.preparedBy || '—'}</DetailRow>
        <DetailRow label="Approved by">{voucher.approvedBy || '—'}</DetailRow>
        <DetailRow label="Posted by">{voucher.postedBy || '—'}</DetailRow>
        <DetailRow label="Journal entry">
          {voucher.journalEntryId ? (
            <button type="button" className="focus-ring rounded font-medium text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
              onClick={() => { requestFocusEntry(voucher.journalEntryId); setActiveView('journal'); }}>
              {voucher.journalEntryNumber}
            </button>
          ) : '—'}
        </DetailRow>
        {voucher.assetTransactionId && <DetailRow label="Asset transaction"><button type="button" className="focus-ring rounded font-medium text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400" onClick={() => setActiveView('fixed-assets')}>{voucher.assetTransactionId}</button></DetailRow>}
        {voucher.sourceModule && <DetailRow label="Source">{voucher.sourceModule}:{voucher.sourceTransactionId}</DetailRow>}
        {voucher.intercompanyRef && <DetailRow label="Intercompany ref">{voucher.intercompanyRef}</DetailRow>}
        {voucher.reversalOfVoucherId && <DetailRow label="Reversal of">{store.vouchers.find((v) => v.id === voucher.reversalOfVoucherId)?.number ?? '—'}</DetailRow>}
        {voucher.reversedByVoucherId && <DetailRow label="Reversed by">{store.vouchers.find((v) => v.id === voucher.reversedByVoucherId)?.number ?? '—'}</DetailRow>}
        {voucher.replacementVoucherId && <DetailRow label="Replacement">{store.vouchers.find((v) => v.id === voucher.replacementVoucherId)?.number ?? '—'}</DetailRow>}
        {voucher.rejectionComment && <DetailRow label="Rejection">{voucher.rejectionComment}</DetailRow>}
      </div>

      <JournalPreviewCard voucher={voucher} baseCurrency={baseCurrency} />

      {/* Approval / posting workflow */}
      <div className="flex flex-wrap justify-end gap-2 print:hidden">
        {(voucher.status === 'draft' || voucher.status === 'rejected') && (
          <>
            <Button size="sm" variant="ghost" onClick={() => onAction(store.cancelDraft(voucher.id), 'Draft cancelled.')}>Cancel draft</Button>
            <Button size="sm" variant="outline" onClick={() => onAction(store.submitVoucher(voucher.id), 'Submitted for approval.')}>Submit</Button>
            {!type?.approvalRequired && <Button size="sm" onClick={() => onAction(store.postVoucher(voucher.id), 'Posted to the General Journal.')}>Post</Button>}
          </>
        )}
        {voucher.status === 'pending_approval' && (
          <>
            <Button size="sm" variant="ghost" onClick={() => { const c = window.prompt('Rejection comment?'); if (c) onAction(store.rejectVoucher(voucher.id, c), 'Voucher rejected.'); }}>Reject</Button>
            <Button size="sm" variant="outline" onClick={() => onAction(store.approveVoucher(voucher.id), 'Voucher approved.')}>Approve</Button>
          </>
        )}
        {voucher.status === 'approved' && <Button size="sm" onClick={() => onAction(store.postVoucher(voucher.id), 'Posted to the General Journal.')}>Post</Button>}
        {(voucher.status === 'posted' || voucher.status === 'partially_reversed') && (
          <>
            <Button size="sm" variant="ghost" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print / PDF</Button>
            <Button size="sm" variant="ghost" onClick={() => exportVoucherCsv(voucher)}>Export CSV</Button>
            <Button size="sm" variant="ghost" onClick={() => onAction(store.copyVoucher(voucher.id), 'Copied into a new draft.')}>Copy</Button>
            <Button size="sm" variant="outline" onClick={() => { const r = window.prompt(`Reason for reversing ${voucher.number}?`); if (r) onAction(store.reverseVoucher(voucher.id, { reason: r }), 'Reversal voucher posted.'); }}>Reverse</Button>
            <Button size="sm" variant="outline" onClick={() => { const r = window.prompt(`Correction reason for ${voucher.number}?`); if (r) onAction(store.correctVoucher(voucher.id, r), 'Reversal posted and replacement draft created.'); }}>Correct</Button>
          </>
        )}
        {voucher.status === 'reversed' && <Button size="sm" variant="ghost" onClick={() => onAction(store.copyVoucher(voucher.id), 'Copied into a new draft.')}>Copy</Button>}
      </div>

      {/* Approval & audit history + signatures for print */}
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">History</h3>
        <ul className="space-y-1 text-xs text-slate-500">
          {voucher.history.map((h) => (
            <li key={h.id} className="flex justify-between gap-2 border-b border-slate-100 py-1 dark:border-slate-800">
              <span className="capitalize">{h.action}{h.comment ? ` — ${h.comment}` : ''}</span>
              <span>{h.actor} · {new Date(h.at).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="hidden grid-cols-4 gap-4 border-t border-slate-300 pt-6 text-center text-xs text-slate-500 print:grid">
        {['Prepared by', 'Reviewed by', 'Approved by', 'Posted by'].map((s) => (
          <div key={s}><div className="mb-8">{s}</div><div className="border-t border-slate-400 pt-1">Signature</div></div>
        ))}
      </div>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex justify-between gap-3 border-b border-slate-100 py-1 dark:border-slate-800"><span className="text-slate-400">{label}</span><span className="text-right">{children}</span></div>;
}

function exportVoucherCsv(v: JournalVoucher): void {
  const rows = [
    ['Voucher', v.number, 'Date', v.postingDate, 'Currency', v.currency, 'Rate', String(v.exchangeRate)],
    ['Line', 'Account code', 'Account name', 'Debit', 'Credit', 'Description', 'Cost center', 'Project', 'Tax code', 'Tax amount', 'Reference'],
    ...activeLines(v.lines).map((l) => [String(l.lineNumber), l.accountCode, l.accountName, String(l.debit), String(l.credit), l.description, l.costCenterId, l.projectId, l.taxCode, String(l.taxAmount), l.reference]),
  ];
  const csv = rows.map((r) => r.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `${v.number}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ── Recurring templates panel ────────────────────────────────────────────── */

function TemplatesPanel({ onMsg }: { onMsg: (m: { tone: 'error' | 'success'; text: string } | null) => void }) {
  const store = useJournalVoucherStore();
  const [editing, setEditing] = useState<RecurringVoucherTemplate | null>(null);
  const recurringTypes = store.types.filter((t) => t.allowRecurring && t.isActive);

  const blank = (): RecurringVoucherTemplate => ({
    id: generateId('rvt'), number: '', name: '', typeId: recurringTypes[0]?.id ?? '',
    frequency: 'monthly', startDate: today(), endDate: '', nextPostingDate: today(),
    description: '', currency: useStore.getState().settings.baseCurrency, exchangeRate: 1,
    lines: renumber([makeBlankLine(), makeBlankLine()]),
    autoReverse: false, approvalRequired: false, active: true,
    createdAt: nowIso(), createdBy: '', generatedVoucherIds: [],
  });

  return (
    <div className="space-y-3">
      <div className="flex justify-end"><Button onClick={() => setEditing(blank())} disabled={recurringTypes.length === 0}>New template</Button></div>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
            <tr><th className="px-4 py-2 text-left">Template</th><th className="px-4 py-2 text-left">Type</th><th className="px-4 py-2 text-left">Frequency</th><th className="px-4 py-2 text-left">Next posting</th><th className="px-4 py-2 text-left">Generated</th><th className="px-4 py-2 text-left">Status</th><th className="px-4 py-2" /></tr>
          </thead>
          <tbody>
            {store.templates.map((t) => (
              <tr key={t.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2 font-medium">{t.number} — {t.name}</td>
                <td className="px-4 py-2 text-slate-500">{store.types.find((x) => x.id === t.typeId)?.name ?? '—'}</td>
                <td className="px-4 py-2">{t.frequency}</td>
                <td className="px-4 py-2">{t.nextPostingDate}</td>
                <td className="px-4 py-2">{t.generatedVoucherIds.length}</td>
                <td className="px-4 py-2"><Badge tone={t.active ? 'green' : 'slate'}>{t.active ? 'active' : 'inactive'}</Badge></td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  <Button size="sm" variant="ghost" onClick={() => setEditing({ ...t, lines: t.lines.map((l) => ({ ...l })) })}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => {
                    const r = store.generateFromTemplate(t.id);
                    onMsg(r.ok ? { tone: 'success', text: 'Voucher generated as a draft (retains the template reference).' } : { tone: 'error', text: r.error ?? 'Generation failed.' });
                  }}>Generate</Button>
                </td>
              </tr>
            ))}
            {store.templates.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">No recurring templates yet.</td></tr>}
          </tbody>
        </table>
      </Card>

      <Drawer open={!!editing} onClose={() => setEditing(null)} title={editing?.number ? `Edit ${editing.number}` : 'New recurring template'}>
        {editing && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name" required><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
              <Field label="Voucher type"><Select options={recurringTypes.map((t) => ({ value: t.id, label: t.name }))} value={editing.typeId} onChange={(e) => setEditing({ ...editing, typeId: e.target.value })} /></Field>
              <Field label="Frequency"><Select options={[{ value: 'monthly', label: 'Monthly' }, { value: 'quarterly', label: 'Quarterly' }, { value: 'annual', label: 'Annual' }]} value={editing.frequency} onChange={(e) => setEditing({ ...editing, frequency: e.target.value as RecurringVoucherTemplate['frequency'] })} /></Field>
              <Field label="Start date"><Input type="date" value={editing.startDate} onChange={(e) => setEditing({ ...editing, startDate: e.target.value, nextPostingDate: editing.nextPostingDate || e.target.value })} /></Field>
              <Field label="End date"><Input type="date" value={editing.endDate} onChange={(e) => setEditing({ ...editing, endDate: e.target.value })} /></Field>
              <Field label="Next posting date"><Input type="date" value={editing.nextPostingDate} onChange={(e) => setEditing({ ...editing, nextPostingDate: e.target.value })} /></Field>
            </div>
            <Field label="Description"><Input value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></Field>
            <div className="flex gap-4">
              <Toggle checked={editing.autoReverse} onChange={(v) => setEditing({ ...editing, autoReverse: v })} label="Automatic reversal next period" />
              <Toggle checked={editing.active} onChange={(v) => setEditing({ ...editing, active: v })} label="Active" />
            </div>
            <TemplateLinesEditor template={editing} onChange={setEditing} />
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button onClick={() => {
                const r = store.saveTemplate(editing);
                onMsg(r.ok ? { tone: 'success', text: 'Template saved.' } : { tone: 'error', text: r.error ?? 'Save failed.' });
                if (r.ok) setEditing(null);
              }}>Save template</Button>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

function TemplateLinesEditor({ template, onChange }: { template: RecurringVoucherTemplate; onChange: (t: RecurringVoucherTemplate) => void }) {
  const accounts = useStore((s) => s.accounts);
  const accountOptions = useMemo(
    () => [{ value: '', label: '—' }, ...accounts.filter((a) => a.isPostingAccount && a.isActive).map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }))],
    [accounts],
  );
  const setLine = (id: string, patch: (l: JournalVoucherLine) => JournalVoucherLine): void =>
    onChange({ ...template, lines: template.lines.map((l) => (l.id === id ? patch(l) : l)) });
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-semibold uppercase text-slate-500">Template lines</h4>
      {template.lines.map((l) => (
        <div key={l.id} className="grid grid-cols-[1fr_90px_90px] gap-2">
          <Select options={accountOptions} value={l.accountId} onChange={(e) => setLine(l.id, (x) => ({ ...x, accountId: e.target.value }))} />
          <Input type="number" placeholder="Debit" value={l.debit || ''} onChange={(e) => setLine(l.id, (x) => withDebit(x, Number(e.target.value) || 0))} />
          <Input type="number" placeholder="Credit" value={l.credit || ''} onChange={(e) => setLine(l.id, (x) => withCredit(x, Number(e.target.value) || 0))} />
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => onChange({ ...template, lines: renumber([...template.lines, makeBlankLine()]) })}><Plus className="h-3.5 w-3.5" /> Add line</Button>
    </div>
  );
}

/* ── Types & settings panel ───────────────────────────────────────────────── */

function ConfigPanel({ onMsg }: { onMsg: (m: { tone: 'error' | 'success'; text: string } | null) => void }) {
  const store = useJournalVoucherStore();
  const accounts = useStore((s) => s.accounts);
  const accountOptions = useMemo(
    () => [{ value: '', label: '— not configured —' }, ...accounts.filter((a) => a.isPostingAccount && a.isActive).map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }))],
    [accounts],
  );
  const [editing, setEditing] = useState<VoucherTypeConfig | null>(null);

  const blankType = (): VoucherTypeConfig => ({
    id: generateId('jvt'), code: '', name: '', kind: 'general', prefix: 'JV',
    defaultDescription: '', defaultDebitAccountId: '', defaultCreditAccountId: '',
    requiredDimensions: [], approvalRequired: false, allowAutoReversal: false,
    allowRecurring: false, allowTaxCodes: false, allowBankAccounts: false,
    allowAssetRefs: false, requireIntercompany: false, warnFormalDocument: false,
    isSystem: false, isActive: true,
  });

  return (
    <div className="space-y-4">
      <Card><CardBody className="space-y-3">
        <h3 className="text-sm font-semibold">Journal-voucher settings</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="Closed through (posting lock)"><Input type="date" value={store.settings.postingLockDate} onChange={(e) => store.updateSettings({ postingLockDate: e.target.value })} /></Field>
          <Field label="Rounding account"><Select options={accountOptions} value={store.settings.roundingAccountId} onChange={(e) => store.updateSettings({ roundingAccountId: e.target.value })} /></Field>
          <Field label="Rounding tolerance"><Input type="number" step="0.01" value={String(store.settings.roundingTolerance)} onChange={(e) => store.updateSettings({ roundingTolerance: Number(e.target.value) || 0 })} /></Field>
          <Field label="FX gain account"><Select options={accountOptions} value={store.settings.fxGainAccountId} onChange={(e) => store.updateSettings({ fxGainAccountId: e.target.value })} /></Field>
          <Field label="FX loss account"><Select options={accountOptions} value={store.settings.fxLossAccountId} onChange={(e) => store.updateSettings({ fxLossAccountId: e.target.value })} /></Field>
          <Field label="Material amount threshold"><Input type="number" value={String(store.settings.materialAmountThreshold)} onChange={(e) => store.updateSettings({ materialAmountThreshold: Number(e.target.value) || 0 })} /></Field>
        </div>
        <div className="flex flex-wrap gap-4">
          <Toggle checked={store.settings.openingBalancesLocked} onChange={(v) => store.updateSettings({ openingBalancesLocked: v })} label="Lock opening balances (normal operations begun)" />
          <Toggle checked={store.settings.segregationOfDuties} onChange={(v) => store.updateSettings({ segregationOfDuties: v })} label="Segregation of duties (preparer ≠ approver for material vouchers)" />
        </div>
      </CardBody></Card>

      <div className="flex justify-end"><Button onClick={() => setEditing(blankType())}>New voucher type</Button></div>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/50">
            <tr><th className="px-4 py-2 text-left">Code</th><th className="px-4 py-2 text-left">Name</th><th className="px-4 py-2 text-left">Prefix</th><th className="px-4 py-2 text-left">Approval</th><th className="px-4 py-2 text-left">Flags</th><th className="px-4 py-2 text-left">Status</th><th className="px-4 py-2" /></tr>
          </thead>
          <tbody>
            {store.types.map((t) => (
              <tr key={t.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2 font-medium">{t.code}</td>
                <td className="px-4 py-2">{t.name}</td>
                <td className="px-4 py-2">{t.prefix}</td>
                <td className="px-4 py-2">{t.approvalRequired ? 'required' : '—'}</td>
                <td className="px-4 py-2 text-xs text-slate-400">
                  {[t.allowAutoReversal && 'auto-rev', t.allowRecurring && 'recurring', t.allowTaxCodes && 'tax', t.allowBankAccounts && 'bank', t.allowAssetRefs && 'asset', t.requireIntercompany && 'intercompany', t.warnFormalDocument && 'formal-doc warning'].filter(Boolean).join(' · ') || '—'}
                </td>
                <td className="px-4 py-2"><Badge tone={t.isActive ? 'green' : 'slate'}>{t.isActive ? 'active' : 'inactive'}</Badge></td>
                <td className="px-4 py-2 text-right"><Button size="sm" variant="ghost" onClick={() => setEditing({ ...t })}>Edit</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Drawer open={!!editing} onClose={() => setEditing(null)} title={editing?.code ? `Edit ${editing.code}` : 'New voucher type'}>
        {editing && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Code" required><Input value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })} /></Field>
              <Field label="Name" required><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
              <Field label="Number prefix" required><Input value={editing.prefix} onChange={(e) => setEditing({ ...editing, prefix: e.target.value.toUpperCase() })} /></Field>
              <Field label="Default description"><Input value={editing.defaultDescription} onChange={(e) => setEditing({ ...editing, defaultDescription: e.target.value })} /></Field>
              <Field label="Default debit account"><Select options={accountOptions} value={editing.defaultDebitAccountId} onChange={(e) => setEditing({ ...editing, defaultDebitAccountId: e.target.value })} /></Field>
              <Field label="Default credit account"><Select options={accountOptions} value={editing.defaultCreditAccountId} onChange={(e) => setEditing({ ...editing, defaultCreditAccountId: e.target.value })} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Toggle checked={editing.approvalRequired} onChange={(v) => setEditing({ ...editing, approvalRequired: v })} label="Approval required" />
              <Toggle checked={editing.allowAutoReversal} onChange={(v) => setEditing({ ...editing, allowAutoReversal: v })} label="Automatic reversal allowed" />
              <Toggle checked={editing.allowRecurring} onChange={(v) => setEditing({ ...editing, allowRecurring: v })} label="Recurring posting allowed" />
              <Toggle checked={editing.allowTaxCodes} onChange={(v) => setEditing({ ...editing, allowTaxCodes: v })} label="Tax codes allowed" />
              <Toggle checked={editing.allowBankAccounts} onChange={(v) => setEditing({ ...editing, allowBankAccounts: v })} label="Bank accounts selectable" />
              <Toggle checked={editing.allowAssetRefs} onChange={(v) => setEditing({ ...editing, allowAssetRefs: v })} label="Asset references selectable" />
              <Toggle checked={editing.requireIntercompany} onChange={(v) => setEditing({ ...editing, requireIntercompany: v })} label="Intercompany balancing required" />
              <Toggle checked={editing.warnFormalDocument} onChange={(v) => setEditing({ ...editing, warnFormalDocument: v })} label="Warn: formal document expected" />
              <Toggle checked={editing.requiredDimensions.includes('costCenter')} onChange={(v) => setEditing({ ...editing, requiredDimensions: v ? [...editing.requiredDimensions.filter((d) => d !== 'costCenter'), 'costCenter'] : editing.requiredDimensions.filter((d) => d !== 'costCenter') })} label="Cost center required" />
              <Toggle checked={editing.requiredDimensions.includes('project')} onChange={(v) => setEditing({ ...editing, requiredDimensions: v ? [...editing.requiredDimensions.filter((d) => d !== 'project'), 'project'] : editing.requiredDimensions.filter((d) => d !== 'project') })} label="Project required" />
              <Toggle checked={editing.isActive} onChange={(v) => setEditing({ ...editing, isActive: v })} label="Active" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button onClick={() => {
                const r = store.saveType(editing);
                onMsg(r.ok ? { tone: 'success', text: 'Voucher type saved.' } : { tone: 'error', text: r.error ?? 'Save failed.' });
                if (r.ok) setEditing(null);
              }}>Save type</Button>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

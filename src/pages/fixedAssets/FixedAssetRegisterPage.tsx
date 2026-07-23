/**
 * Fixed Asset Register — the source-document workbench.
 *
 * Every transaction screen (purchase, capitalize, transfer, impair, revalue,
 * dispose, reverse) shows the generated journal preview BEFORE posting, and
 * posting refuses to proceed while the voucher is unbalanced, unmapped, in a
 * closed period, or otherwise invalid (the store re-validates everything).
 */
import { useMemo, useState } from 'react';
import { useFixedAssetStore, makeBlankAsset } from '@/store/fixedAssetStore';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import {
  buildAcquisitionVoucher, buildCapitalizationVoucher, buildDisposalVoucher,
  buildImpairmentReversalVoucher, buildImpairmentVoucher, buildIntercompanyTransferVoucher,
  buildRevaluationVoucher, computeDepreciation, computeDisposal, netBookValue, portionFraction,
  round2, type DisposalPortion, type VoucherPlan,
} from '@/lib/fixedAssetCalculations';
import type { AcquisitionFunding, FixedAsset } from '@/types/fixedAssets';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { Drawer } from '@/components/ui/Drawer';
import { emptyRow, JournalPreview, money, StatusBadge, Table, useFaOptions, VoucherLink } from './FixedAssetsShared';

type ActionKey = 'purchase' | 'capitalize' | 'transfer' | 'intercompany' | 'impair' | 'impair-reverse' | 'revalue' | 'dispose' | 'status';

const today = (): string => new Date().toISOString().slice(0, 10);

export function FixedAssetRegisterPage() {
  const store = useFixedAssetStore();
  const baseCurrency = useStore((s) => s.settings.baseCurrency);
  const entities = useEntityStore((s) => s.entities);
  const { accountOptions, costCenterOptions, projectOptions } = useFaOptions();
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [creating, setCreating] = useState<FixedAsset | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [action, setAction] = useState<ActionKey>('purchase');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  useState(() => { store.ensureSeeded(); return true; });

  const categories = store.categories;
  const categoryOptions = useMemo(
    () => categories.filter((c) => c.isActive).map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` })),
    [categories],
  );
  const supplierOptions = useMemo(
    () => [{ value: '', label: '—' }, ...entities.filter((e) => e.entityType === 'supplier' || e.entityType === 'both').map((e) => ({ value: e.id, label: e.legalName }))],
    [entities],
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return store.assets
      .filter((a) => (!statusFilter || a.status === statusFilter))
      .filter((a) => !q || `${a.assetCode} ${a.name} ${a.location} ${a.custodian}`.toLowerCase().includes(q));
  }, [store.assets, search, statusFilter]);

  const selected = selectedId ? store.assets.find((a) => a.id === selectedId) ?? null : null;
  const selectedCategory = selected ? categories.find((c) => c.id === selected.categoryId) ?? null : null;
  const assetTxns = useMemo(
    () => (selected ? store.transactions.filter((t) => t.assetId === selected.id).slice().reverse() : []),
    [store.transactions, selected],
  );

  const report = (r: { ok: boolean; error?: string }, okText: string): boolean => {
    setMsg(r.ok ? { tone: 'success', text: okText } : { tone: 'error', text: r.error ?? 'Action failed.' });
    return r.ok;
  };

  const totals = useMemo(() => {
    const live = store.assets.filter((a) => !['disposed', 'cancelled', 'draft', 'pending_approval'].includes(a.status));
    return {
      count: live.length,
      cost: live.reduce((s, a) => s + a.originalCost, 0),
      accum: live.reduce((s, a) => s + a.accumulatedDepreciation, 0),
      nbv: live.reduce((s, a) => s + netBookValue(a), 0),
    };
  }, [store.assets]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Assets on books" value={String(totals.count)} />
        <Stat label="Cost" value={money(totals.cost)} />
        <Stat label="Accumulated depreciation" value={money(totals.accum)} />
        <Stat label="Net book value" value={money(totals.nbv)} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <Input placeholder="Search assets…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-56" />
          <Select
            className="w-44"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={[{ value: '', label: 'All statuses' }, ...['draft', 'pending_approval', 'active', 'fully_depreciated', 'suspended', 'impaired', 'held_for_sale', 'disposed', 'cancelled'].map((s) => ({ value: s, label: s.replaceAll('_', ' ') }))]}
          />
        </div>
        <Button onClick={() => { setMsg(null); setCreating(makeBlankAsset(categories[0]?.id ?? '')); }} disabled={categories.length === 0}>
          New asset
        </Button>
      </div>
      {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}
      {categories.length === 0 && <Alert variant="info">No asset categories configured yet — open Asset Categories to seed or configure them.</Alert>}

      <Table head={['Code', 'Name', 'Category', 'Status', 'Cost', 'Accum. dep.', 'Impairment', 'NBV', '']} minWidth={900}>
        {rows.map((a) => (
          <tr key={a.id} className="border-t border-slate-100 dark:border-slate-800">
            <td className="px-4 py-2 font-medium">{a.assetCode}</td>
            <td className="px-4 py-2">{a.name}<span className="block text-xs text-slate-400">{a.location || a.custodian ? `${a.location}${a.location && a.custodian ? ' · ' : ''}${a.custodian}` : ''}</span></td>
            <td className="px-4 py-2 text-slate-500">{categories.find((c) => c.id === a.categoryId)?.name ?? '—'}</td>
            <td className="px-4 py-2"><StatusBadge status={a.status} /></td>
            <td className="px-4 py-2 text-right tabular-nums">{money(a.originalCost)}</td>
            <td className="px-4 py-2 text-right tabular-nums">{money(a.accumulatedDepreciation)}</td>
            <td className="px-4 py-2 text-right tabular-nums">{money(a.impairmentBalance)}</td>
            <td className="px-4 py-2 text-right font-medium tabular-nums">{money(netBookValue(a))}</td>
            <td className="px-4 py-2 text-right"><Button size="sm" variant="outline" onClick={() => { setMsg(null); setSelectedId(a.id); setAction(a.status === 'draft' ? 'purchase' : 'dispose'); }}>Open</Button></td>
          </tr>
        ))}
        {rows.length === 0 && emptyRow(9, 'No assets found.')}
      </Table>

      {/* ── New asset drawer ─────────────────────────────────────────────── */}
      <Drawer open={!!creating} onClose={() => setCreating(null)} title="New asset (draft)">
        {creating && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Asset code" hint="Blank = auto"><Input value={creating.assetCode} onChange={(e) => setCreating({ ...creating, assetCode: e.target.value })} /></Field>
              <Field label="Name" required><Input value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} /></Field>
            </div>
            <Field label="Description"><Textarea value={creating.description} onChange={(e) => setCreating({ ...creating, description: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category" required><Select options={categoryOptions} value={creating.categoryId} onChange={(e) => { const cat = categories.find((c) => c.id === e.target.value); setCreating({ ...creating, categoryId: e.target.value, method: cat?.defaultMethod ?? creating.method, usefulLifeMonths: cat?.defaultUsefulLifeMonths ?? creating.usefulLifeMonths }); }} /></Field>
              <Field label="Acquisition date"><Input type="date" value={creating.acquisitionDate} onChange={(e) => setCreating({ ...creating, acquisitionDate: e.target.value })} /></Field>
              <Field label="Supplier"><Select options={supplierOptions} value={creating.supplierId} onChange={(e) => setCreating({ ...creating, supplierId: e.target.value, supplierName: entities.find((x) => x.id === e.target.value)?.legalName ?? '' })} /></Field>
              <Field label="Purchase invoice ref"><Input value={creating.purchaseInvoiceRef} onChange={(e) => setCreating({ ...creating, purchaseInvoiceRef: e.target.value })} /></Field>
              <Field label="Branch"><Input value={creating.branch} onChange={(e) => setCreating({ ...creating, branch: e.target.value })} /></Field>
              <Field label="Department"><Input value={creating.department} onChange={(e) => setCreating({ ...creating, department: e.target.value })} /></Field>
              <Field label="Cost center"><Select options={costCenterOptions} value={creating.costCenterId} onChange={(e) => setCreating({ ...creating, costCenterId: e.target.value })} /></Field>
              <Field label="Project"><Select options={projectOptions} value={creating.projectId} onChange={(e) => setCreating({ ...creating, projectId: e.target.value })} /></Field>
              <Field label="Location"><Input value={creating.location} onChange={(e) => setCreating({ ...creating, location: e.target.value })} /></Field>
              <Field label="Custodian"><Input value={creating.custodian} onChange={(e) => setCreating({ ...creating, custodian: e.target.value })} /></Field>
              <Field label="Depreciation method">
                <Select
                  options={[{ value: 'straight_line', label: 'Straight line' }, { value: 'reducing_balance', label: 'Reducing balance' }, { value: 'units_of_production', label: 'Units of production' }, { value: 'none', label: 'None (land)' }]}
                  value={creating.method}
                  onChange={(e) => setCreating({ ...creating, method: e.target.value as FixedAsset['method'] })}
                />
              </Field>
              <Field label="Useful life (months)"><Input type="number" value={String(creating.usefulLifeMonths)} onChange={(e) => setCreating({ ...creating, usefulLifeMonths: Number(e.target.value) || 0 })} /></Field>
              <Field label="Residual value"><Input type="number" value={String(creating.residualValue)} onChange={(e) => setCreating({ ...creating, residualValue: Number(e.target.value) || 0 })} /></Field>
              {creating.method === 'reducing_balance' && (
                <Field label="Annual rate %"><Input type="number" value={String(creating.reducingBalanceRatePercent)} onChange={(e) => setCreating({ ...creating, reducingBalanceRatePercent: Number(e.target.value) || 0 })} /></Field>
              )}
              {creating.method === 'units_of_production' && (
                <Field label="Total units"><Input type="number" value={String(creating.unitsTotal)} onChange={(e) => setCreating({ ...creating, unitsTotal: Number(e.target.value) || 0 })} /></Field>
              )}
              <Field label="Quantity (units)"><Input type="number" value={String(creating.quantity)} onChange={(e) => setCreating({ ...creating, quantity: Math.max(1, Number(e.target.value) || 1) })} /></Field>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setCreating(null)}>Cancel</Button>
              <Button onClick={() => { if (report(store.createAsset(creating), `Asset ${creating.name} created as a draft.`)) setCreating(null); }}>Create draft</Button>
            </div>
          </div>
        )}
      </Drawer>

      {/* ── Asset workbench drawer ───────────────────────────────────────── */}
      <Drawer open={!!selected} onClose={() => setSelectedId(null)} title={selected ? `${selected.assetCode} — ${selected.name}` : ''}>
        {selected && selectedCategory && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
              <Info label="Status"><StatusBadge status={selected.status} /></Info>
              <Info label="Category">{selectedCategory.name}</Info>
              <Info label="Cost">{money(selected.originalCost)}</Info>
              <Info label="AUC balance">{money(selected.aucBalance)}</Info>
              <Info label="Accumulated depreciation">{money(selected.accumulatedDepreciation)}</Info>
              <Info label="Impairment">{money(selected.impairmentBalance)}</Info>
              <Info label="Net book value"><span className="font-semibold">{money(netBookValue(selected))}</span></Info>
              <Info label="Depreciated through">{selected.depreciatedThrough || '—'}</Info>
              {selected.status === 'disposed' && <Info label="Disposal gain / (loss)">{money(selected.disposalGainLoss)}</Info>}
            </div>

            <Field label="Transaction">
              <Select
                value={action}
                onChange={(e) => setAction(e.target.value as ActionKey)}
                options={[
                  { value: 'purchase', label: 'Purchase / acquire' },
                  { value: 'capitalize', label: 'Capitalize (from AUC)' },
                  { value: 'transfer', label: 'Transfer (dimensions)' },
                  { value: 'intercompany', label: 'Intercompany transfer' },
                  { value: 'impair', label: 'Impair' },
                  { value: 'impair-reverse', label: 'Reverse impairment' },
                  { value: 'revalue', label: 'Revalue' },
                  { value: 'dispose', label: 'Sell / dispose' },
                  { value: 'status', label: 'Suspend / hold for sale' },
                ]}
              />
            </Field>

            {action === 'purchase' && <PurchaseForm asset={selected} accountOptions={accountOptions} currency={baseCurrency} onDone={(r) => report(r, 'Acquisition posted with its journal voucher.')} />}
            {action === 'capitalize' && <CapitalizeForm asset={selected} currency={baseCurrency} onDone={(r) => report(r, 'Capitalization posted.')} />}
            {action === 'transfer' && <TransferForm asset={selected} costCenterOptions={costCenterOptions} projectOptions={projectOptions} onDone={(r) => report(r, 'Transfer recorded.')} />}
            {action === 'intercompany' && <IntercompanyForm asset={selected} currency={baseCurrency} onDone={(r) => report(r, 'Intercompany transfer posted.')} />}
            {action === 'impair' && <ImpairForm asset={selected} currency={baseCurrency} onDone={(r) => report(r, 'Impairment posted.')} />}
            {action === 'impair-reverse' && <ImpairReverseForm asset={selected} currency={baseCurrency} onDone={(r) => report(r, 'Impairment reversal posted.')} />}
            {action === 'revalue' && <RevalueForm asset={selected} currency={baseCurrency} onDone={(r) => report(r, 'Revaluation posted.')} />}
            {action === 'dispose' && <DisposeForm asset={selected} accountOptions={accountOptions} currency={baseCurrency} onDone={(r) => report(r, 'Disposal posted with its journal voucher.')} />}
            {action === 'status' && <StatusForm asset={selected} onDone={(r) => report(r, 'Status updated.')} />}

            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">Transactions</h3>
              <Card className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-xs">
                  <thead className="text-slate-400"><tr><th className="px-3 py-1 text-left">No.</th><th className="px-3 py-1 text-left">Type</th><th className="px-3 py-1 text-left">Date</th><th className="px-3 py-1 text-right">Amount</th><th className="px-3 py-1 text-left">Voucher</th><th className="px-3 py-1" /></tr></thead>
                  <tbody>
                    {assetTxns.map((t) => (
                      <tr key={t.id} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="px-3 py-1 font-medium">{t.number}</td>
                        <td className="px-3 py-1">{t.type.replaceAll('_', ' ')}{t.status === 'reversed' ? ' (reversed)' : ''}</td>
                        <td className="px-3 py-1">{t.date}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{money(t.amount)}</td>
                        <td className="px-3 py-1"><VoucherLink entryId={t.journalEntryId} entryNumber={t.journalEntryNumber} /></td>
                        <td className="px-3 py-1 text-right">
                          {t.status === 'posted' && t.type !== 'reversal' && (
                            <Button size="sm" variant="ghost" onClick={() => {
                              const reason = window.prompt(`Reason for reversing ${t.number}?`);
                              if (reason) report(store.reverseTransaction(t.id, reason, 'Approver'), `${t.number} reversed with a reversal voucher.`);
                            }}>Reverse</Button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {assetTxns.length === 0 && emptyRow(6, 'No transactions yet.')}
                  </tbody>
                </table>
              </Card>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card><CardBody className="py-3">
      <div className="text-[11px] uppercase text-slate-400">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </CardBody></Card>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex justify-between gap-3 border-b border-slate-100 py-1 dark:border-slate-800"><span className="text-slate-400">{label}</span><span className="text-right">{children}</span></div>;
}

interface FormProps { asset: FixedAsset; currency: string; onDone: (r: { ok: boolean; error?: string }) => void }
type Opt = Array<{ value: string; label: string }>;

/* ── Purchase / acquisition ─────────────────────────────────────────────── */

function PurchaseForm({ asset, accountOptions, currency, onDone }: FormProps & { accountOptions: Opt }) {
  const store = useFixedAssetStore();
  const category = store.categories.find((c) => c.id === asset.categoryId)!;
  const [f, setF] = useState({ date: today(), funding: 'credit' as AcquisitionFunding, creditAccountId: '', baseCost: 0, recoverableTax: 0, nonRecoverableTax: 0, otherCapitalizedCosts: 0, taxCode: '', invoiceRef: asset.purchaseInvoiceRef, approvedBy: '' });
  const cost = round2(f.baseCost + f.nonRecoverableTax + f.otherCapitalizedCosts);
  const plan: VoucherPlan = buildAcquisitionVoucher({
    category, assetName: asset.name, cost, recoverableTax: f.recoverableTax,
    creditAccountId: f.creditAccountId, toAuc: f.funding === 'auc',
    dims: { costCenter: asset.costCenterId || undefined, project: asset.projectId || undefined }, taxCode: f.taxCode || undefined,
  });
  if (asset.status !== 'draft' && asset.status !== 'pending_approval') {
    return <Alert variant="info">Acquisitions post against draft assets. This asset is already {asset.status.replaceAll('_', ' ')}.</Alert>;
  }
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Funding">
          <Select value={f.funding} onChange={(e) => setF({ ...f, funding: e.target.value as AcquisitionFunding })}
            options={[{ value: 'credit', label: 'On credit (supplier bill)' }, { value: 'bank', label: 'Bank' }, { value: 'cash', label: 'Cash' }, { value: 'auc', label: 'Asset under construction' }, { value: 'manual', label: 'Manual capitalization (other source)' }]} />
        </Field>
      </div>
      <Field label={f.funding === 'credit' ? 'Accounts payable account' : f.funding === 'auc' ? 'Funding account (AP / bank / cash)' : 'Bank / cash / source account'} required>
        <Select options={accountOptions} value={f.creditAccountId} onChange={(e) => setF({ ...f, creditAccountId: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Base cost" required><Input type="number" value={String(f.baseCost)} onChange={(e) => setF({ ...f, baseCost: Number(e.target.value) || 0 })} /></Field>
        <Field label="Recoverable input tax"><Input type="number" value={String(f.recoverableTax)} onChange={(e) => setF({ ...f, recoverableTax: Number(e.target.value) || 0 })} /></Field>
        <Field label="Non-recoverable tax (capitalized)"><Input type="number" value={String(f.nonRecoverableTax)} onChange={(e) => setF({ ...f, nonRecoverableTax: Number(e.target.value) || 0 })} /></Field>
        <Field label="Freight / install / fees (capitalized)"><Input type="number" value={String(f.otherCapitalizedCosts)} onChange={(e) => setF({ ...f, otherCapitalizedCosts: Number(e.target.value) || 0 })} /></Field>
        <Field label="Tax code"><Input value={f.taxCode} onChange={(e) => setF({ ...f, taxCode: e.target.value })} /></Field>
        <Field label="Invoice reference"><Input value={f.invoiceRef} onChange={(e) => setF({ ...f, invoiceRef: e.target.value })} /></Field>
      </div>
      <Field label="Approved by" hint="Required when acquisition approval is enabled"><Input value={f.approvedBy} onChange={(e) => setF({ ...f, approvedBy: e.target.value })} /></Field>
      <JournalPreview plan={cost > 0 ? plan : null} currency={currency} />
      <div className="flex justify-end">
        <Button disabled={!plan.ok || cost <= 0} onClick={() => onDone(store.postAcquisition({ assetId: asset.id, date: f.date, baseCost: f.baseCost, recoverableTax: f.recoverableTax, nonRecoverableTax: f.nonRecoverableTax, otherCapitalizedCosts: f.otherCapitalizedCosts, funding: f.funding, creditAccountId: f.creditAccountId, taxCode: f.taxCode || undefined, supplierId: asset.supplierId, supplierName: asset.supplierName, invoiceRef: f.invoiceRef, approvedBy: f.approvedBy || undefined }))}>
          Post acquisition
        </Button>
      </div>
    </div>
  );
}

function CapitalizeForm({ asset, currency, onDone }: FormProps) {
  const store = useFixedAssetStore();
  const category = store.categories.find((c) => c.id === asset.categoryId)!;
  const [f, setF] = useState({ date: today(), approvedBy: '' });
  if (asset.aucBalance <= 0) return <Alert variant="info">No asset-under-construction balance to capitalize.</Alert>;
  const plan = buildCapitalizationVoucher({ category, assetName: asset.name, amount: asset.aucBalance, dims: { costCenter: asset.costCenterId || undefined, project: asset.projectId || undefined } });
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Capitalization date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Approved by"><Input value={f.approvedBy} onChange={(e) => setF({ ...f, approvedBy: e.target.value })} /></Field>
      </div>
      <JournalPreview plan={plan} currency={currency} />
      <div className="flex justify-end"><Button disabled={!plan.ok} onClick={() => onDone(store.capitalizeAsset({ assetId: asset.id, date: f.date, approvedBy: f.approvedBy || undefined }))}>Capitalize</Button></div>
    </div>
  );
}

function TransferForm({ asset, costCenterOptions, projectOptions, onDone }: Omit<FormProps, 'currency'> & { costCenterOptions: Opt; projectOptions: Opt }) {
  const store = useFixedAssetStore();
  const [f, setF] = useState({ date: today(), branch: asset.branch, department: asset.department, costCenterId: asset.costCenterId, projectId: asset.projectId, location: asset.location, custodian: asset.custodian, reason: '', approvedBy: '' });
  const changes: Record<string, string> = {};
  for (const k of ['branch', 'department', 'costCenterId', 'projectId', 'location', 'custodian'] as const) {
    if (f[k] !== asset[k]) changes[k] = f[k];
  }
  return (
    <div className="space-y-3">
      <Alert variant="info">Transfers within the same legal entity move dimensions only — no gain or loss, no voucher. Use “Intercompany transfer” for another legal entity.</Alert>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Branch"><Input value={f.branch} onChange={(e) => setF({ ...f, branch: e.target.value })} /></Field>
        <Field label="Department"><Input value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} /></Field>
        <Field label="Cost center"><Select options={costCenterOptions} value={f.costCenterId} onChange={(e) => setF({ ...f, costCenterId: e.target.value })} /></Field>
        <Field label="Project"><Select options={projectOptions} value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })} /></Field>
        <Field label="Location"><Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
        <Field label="Custodian"><Input value={f.custodian} onChange={(e) => setF({ ...f, custodian: e.target.value })} /></Field>
        <Field label="Approved by"><Input value={f.approvedBy} onChange={(e) => setF({ ...f, approvedBy: e.target.value })} /></Field>
      </div>
      <Field label="Reason"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      <div className="flex justify-end">
        <Button disabled={Object.keys(changes).length === 0} onClick={() => onDone(store.transferAsset({ assetId: asset.id, date: f.date, changes, reason: f.reason, approvedBy: f.approvedBy || undefined }))}>Record transfer</Button>
      </div>
    </div>
  );
}

function IntercompanyForm({ asset, currency, onDone }: FormProps) {
  const store = useFixedAssetStore();
  const category = store.categories.find((c) => c.id === asset.categoryId)!;
  const [f, setF] = useState({ date: today(), targetCompany: '', reason: '', approvedBy: '' });
  const plan = buildIntercompanyTransferVoucher({ category, assetName: `${asset.assetCode} ${asset.name}`, asset, dueFromAccountId: store.settings.intercompanyDueFromAccountId, dims: { costCenter: asset.costCenterId || undefined, project: asset.projectId || undefined } });
  return (
    <div className="space-y-3">
      {!store.settings.allowIntercompanyTransfers && <Alert variant="warning">Intercompany transfers are disabled. Enable them (with due-to/due-from accounts) in Asset Categories → Settings.</Alert>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Target legal entity" required><Input value={f.targetCompany} onChange={(e) => setF({ ...f, targetCompany: e.target.value })} /></Field>
      </div>
      <Field label="Reason" required><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      <Field label="Approved by"><Input value={f.approvedBy} onChange={(e) => setF({ ...f, approvedBy: e.target.value })} /></Field>
      <JournalPreview plan={store.settings.allowIntercompanyTransfers ? plan : null} currency={currency} />
      <div className="flex justify-end">
        <Button disabled={!store.settings.allowIntercompanyTransfers || !plan.ok || !f.targetCompany.trim() || !f.reason.trim()} onClick={() => onDone(store.intercompanyTransfer({ assetId: asset.id, date: f.date, targetCompany: f.targetCompany, reason: f.reason, approvedBy: f.approvedBy || undefined }))}>
          Post intercompany transfer
        </Button>
      </div>
    </div>
  );
}

function ImpairForm({ asset, currency, onDone }: FormProps) {
  const store = useFixedAssetStore();
  const category = store.categories.find((c) => c.id === asset.categoryId)!;
  const nbv = netBookValue(asset);
  const [f, setF] = useState({ date: today(), recoverableAmount: nbv, reason: '', approvedBy: '' });
  const amount = round2(nbv - f.recoverableAmount);
  const plan = amount > 0 ? buildImpairmentVoucher({ category, assetName: `${asset.assetCode} ${asset.name}`, amount, dims: { costCenter: asset.costCenterId || undefined, project: asset.projectId || undefined } }) : null;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label={`Recoverable amount (carrying ${money(nbv)})`}><Input type="number" value={String(f.recoverableAmount)} onChange={(e) => setF({ ...f, recoverableAmount: Number(e.target.value) || 0 })} /></Field>
      </div>
      <Field label="Reason / impairment evidence" required><Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      <Field label="Approved by"><Input value={f.approvedBy} onChange={(e) => setF({ ...f, approvedBy: e.target.value })} /></Field>
      {amount > 0 && <Alert variant="warning">Impairment loss of {money(amount)} will be recognized.</Alert>}
      <JournalPreview plan={plan} currency={currency} />
      <div className="flex justify-end"><Button disabled={!plan?.ok} onClick={() => onDone(store.impairAsset({ assetId: asset.id, date: f.date, recoverableAmount: f.recoverableAmount, reason: f.reason, approvedBy: f.approvedBy || undefined }))}>Post impairment</Button></div>
    </div>
  );
}

function ImpairReverseForm({ asset, currency, onDone }: FormProps) {
  const store = useFixedAssetStore();
  const category = store.categories.find((c) => c.id === asset.categoryId)!;
  const [f, setF] = useState({ date: today(), amount: asset.impairmentBalance, reason: '', approvedBy: '' });
  const amount = round2(Math.min(f.amount, asset.impairmentBalance));
  const plan = amount > 0 ? buildImpairmentReversalVoucher({ category, assetName: `${asset.assetCode} ${asset.name}`, amount, dims: { costCenter: asset.costCenterId || undefined, project: asset.projectId || undefined } }) : null;
  if (asset.impairmentBalance <= 0) return <Alert variant="info">This asset has no impairment balance to reverse.</Alert>;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label={`Reversal amount (max ${money(asset.impairmentBalance)})`}><Input type="number" value={String(f.amount)} onChange={(e) => setF({ ...f, amount: Number(e.target.value) || 0 })} /></Field>
      </div>
      <Field label="Reason" required><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      <Field label="Approved by"><Input value={f.approvedBy} onChange={(e) => setF({ ...f, approvedBy: e.target.value })} /></Field>
      <JournalPreview plan={plan} currency={currency} />
      <div className="flex justify-end"><Button disabled={!plan?.ok} onClick={() => onDone(store.reverseImpairment({ assetId: asset.id, date: f.date, amount, reason: f.reason, approvedBy: f.approvedBy || undefined }))}>Post reversal</Button></div>
    </div>
  );
}

function RevalueForm({ asset, currency, onDone }: FormProps) {
  const store = useFixedAssetStore();
  const category = store.categories.find((c) => c.id === asset.categoryId)!;
  const [f, setF] = useState({ date: today(), revaluedAmount: netBookValue(asset), reason: '', approvedBy: '' });
  const plan = buildRevaluationVoucher({ category, assetName: `${asset.assetCode} ${asset.name}`, asset, revaluedAmount: f.revaluedAmount, dims: { costCenter: asset.costCenterId || undefined, project: asset.projectId || undefined } });
  return (
    <div className="space-y-3">
      {!category.revaluationEnabled && <Alert variant="warning">Revaluation is not enabled for the “{category.name}” category (accounting policy).</Alert>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label={`Revalued amount (carrying ${money(netBookValue(asset))})`}><Input type="number" value={String(f.revaluedAmount)} onChange={(e) => setF({ ...f, revaluedAmount: Number(e.target.value) || 0 })} /></Field>
      </div>
      <Field label="Valuation basis / reason" required><Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      <Field label="Approved by"><Input value={f.approvedBy} onChange={(e) => setF({ ...f, approvedBy: e.target.value })} /></Field>
      <JournalPreview plan={category.revaluationEnabled ? plan : null} currency={currency} />
      <div className="flex justify-end"><Button disabled={!plan.ok} onClick={() => onDone(store.revalueAsset({ assetId: asset.id, date: f.date, revaluedAmount: f.revaluedAmount, reason: f.reason, approvedBy: f.approvedBy || undefined }))}>Post revaluation</Button></div>
    </div>
  );
}

function DisposeForm({ asset, accountOptions, currency, onDone }: FormProps & { accountOptions: Opt }) {
  const store = useFixedAssetStore();
  const category = store.categories.find((c) => c.id === asset.categoryId)!;
  const [f, setF] = useState({
    date: today(), portionKind: 'full' as DisposalPortion['kind'], portionValue: 0,
    proceeds: 0, disposalCosts: 0, outputTax: 0, outputTaxAccountId: '', receiptAccountId: '',
    buyerName: '', invoiceRef: '', reason: '', approvedBy: '', catchUp: true, overrideReason: '',
  });
  const portion: DisposalPortion = f.portionKind === 'full' ? { kind: 'full' } : { kind: f.portionKind, value: f.portionValue } as DisposalPortion;
  const pf = portionFraction(asset, portion);
  const pending = computeDepreciation({ asset, periodFrom: asset.depreciationStartDate || asset.acquisitionDate, periodTo: f.date });
  const computation = pf.ok ? computeDisposal(asset, pf.fraction, f.proceeds, f.disposalCosts) : null;
  const plan = computation
    ? buildDisposalVoucher({ category, assetName: `${asset.assetCode} ${asset.name}`, computation, proceeds: f.proceeds, disposalCosts: f.disposalCosts, outputTax: f.outputTax, outputTaxAccountId: f.outputTaxAccountId, receiptAccountId: f.receiptAccountId, dims: { costCenter: asset.costCenterId || undefined, project: asset.projectId || undefined } })
    : null;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Disposal date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Portion">
          <Select value={f.portionKind} onChange={(e) => setF({ ...f, portionKind: e.target.value as DisposalPortion['kind'] })}
            options={[{ value: 'full', label: 'Entire asset' }, { value: 'percentage', label: 'Percentage' }, { value: 'cost', label: 'Cost portion' }, { value: 'units', label: 'Units' }]} />
        </Field>
        {f.portionKind !== 'full' && (
          <Field label={f.portionKind === 'percentage' ? 'Percentage %' : f.portionKind === 'cost' ? 'Cost amount' : `Units (of ${asset.quantity})`}>
            <Input type="number" value={String(f.portionValue)} onChange={(e) => setF({ ...f, portionValue: Number(e.target.value) || 0 })} />
          </Field>
        )}
        <Field label="Proceeds (excl. tax)"><Input type="number" value={String(f.proceeds)} onChange={(e) => setF({ ...f, proceeds: Number(e.target.value) || 0 })} /></Field>
        <Field label="Disposal costs"><Input type="number" value={String(f.disposalCosts)} onChange={(e) => setF({ ...f, disposalCosts: Number(e.target.value) || 0 })} /></Field>
        <Field label="Output tax"><Input type="number" value={String(f.outputTax)} onChange={(e) => setF({ ...f, outputTax: Number(e.target.value) || 0 })} /></Field>
        {f.outputTax > 0 && <Field label="Output tax account" required><Select options={accountOptions} value={f.outputTaxAccountId} onChange={(e) => setF({ ...f, outputTaxAccountId: e.target.value })} /></Field>}
        <Field label="Bank / receivable account" required><Select options={accountOptions} value={f.receiptAccountId} onChange={(e) => setF({ ...f, receiptAccountId: e.target.value })} /></Field>
        <Field label="Buyer"><Input value={f.buyerName} onChange={(e) => setF({ ...f, buyerName: e.target.value })} /></Field>
        <Field label="Sales invoice ref"><Input value={f.invoiceRef} onChange={(e) => setF({ ...f, invoiceRef: e.target.value })} /></Field>
        <Field label="Approved by"><Input value={f.approvedBy} onChange={(e) => setF({ ...f, approvedBy: e.target.value })} /></Field>
      </div>
      <Field label="Reason for disposal"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      {pending > 0.005 && (
        <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-500/10">
          <div>Depreciation of <b>{money(pending)}</b> is pending up to the disposal date.</div>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.catchUp} onChange={(e) => setF({ ...f, catchUp: e.target.checked })} /> Post catch-up depreciation first (recommended)</label>
          {!f.catchUp && <Field label="Override reason (documented)" required><Input value={f.overrideReason} onChange={(e) => setF({ ...f, overrideReason: e.target.value })} /></Field>}
        </div>
      )}
      {computation && pf.ok && (
        <Alert variant={computation.gainLoss >= 0 ? 'success' : 'warning'}>
          NBV of disposed portion {money(computation.nbvPortion)} · net proceeds {money(computation.netProceeds)} → {computation.gainLoss >= 0 ? 'gain' : 'loss'} of {money(Math.abs(computation.gainLoss))}.
        </Alert>
      )}
      {!pf.ok && <Alert variant="error">{pf.error}</Alert>}
      <JournalPreview plan={plan} currency={currency} />
      <div className="flex justify-end">
        <Button disabled={!plan?.ok || (pending > 0.005 && !f.catchUp && !f.overrideReason.trim())} onClick={() => onDone(store.disposeAsset({
          assetId: asset.id, date: f.date, portion, proceeds: f.proceeds, disposalCosts: f.disposalCosts,
          outputTax: f.outputTax, outputTaxAccountId: f.outputTaxAccountId || undefined, receiptAccountId: f.receiptAccountId || undefined,
          buyerName: f.buyerName, invoiceRef: f.invoiceRef, reason: f.reason, approvedBy: f.approvedBy || undefined,
          catchUpDepreciation: f.catchUp, depreciationOverrideReason: f.overrideReason || undefined,
        }))}>
          Post disposal
        </Button>
      </div>
    </div>
  );
}

function StatusForm({ asset, onDone }: { asset: FixedAsset; onDone: (r: { ok: boolean; error?: string }) => void }) {
  const store = useFixedAssetStore();
  const [status, setStatus] = useState<'active' | 'suspended' | 'held_for_sale'>('held_for_sale');
  const [reason, setReason] = useState('');
  return (
    <div className="space-y-3">
      <Field label="New status">
        <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}
          options={[{ value: 'held_for_sale', label: 'Held for sale' }, { value: 'suspended', label: 'Suspended' }, { value: 'active', label: 'Active' }]} />
      </Field>
      <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="flex justify-end"><Button onClick={() => onDone(store.setAssetStatus(asset.id, status, reason))}>Update status</Button></div>
    </div>
  );
}

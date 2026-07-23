/**
 * Asset categories & accounting mappings + module settings.
 *
 * Every category maps to chart-of-accounts posting accounts (cost, accumulated
 * depreciation, depreciation expense, impairment, disposal gain/loss, AUC,
 * recoverable tax, revaluation). Nothing is hard-coded: administrators pick
 * accounts from the live chart, and postings refuse when a needed mapping is
 * missing.
 */
import { useState } from 'react';
import { useFixedAssetStore } from '@/store/fixedAssetStore';
import type { AssetCategory, AssetCategoryAccounts, FixedAssetApprovable } from '@/types/fixedAssets';
import { generateId, nowIso } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { Drawer } from '@/components/ui/Drawer';
import { Toggle } from '@/components/ui/Toggle';
import { emptyRow, Table, useFaOptions } from './FixedAssetsShared';

const ACCOUNT_FIELDS: Array<{ key: keyof AssetCategoryAccounts; label: string }> = [
  { key: 'costAccountId', label: 'Fixed asset cost' },
  { key: 'accumulatedDepreciationAccountId', label: 'Accumulated depreciation' },
  { key: 'depreciationExpenseAccountId', label: 'Depreciation expense' },
  { key: 'impairmentLossAccountId', label: 'Impairment loss' },
  { key: 'accumulatedImpairmentAccountId', label: 'Accumulated impairment' },
  { key: 'disposalGainAccountId', label: 'Disposal gain' },
  { key: 'disposalLossAccountId', label: 'Disposal loss' },
  { key: 'aucAccountId', label: 'Asset under construction / clearing' },
  { key: 'recoverableTaxAccountId', label: 'Recoverable input tax' },
  { key: 'revaluationSurplusAccountId', label: 'Revaluation surplus' },
  { key: 'revaluationLossAccountId', label: 'Revaluation loss' },
];

const APPROVALS: Array<{ key: FixedAssetApprovable; label: string }> = [
  { key: 'acquisition', label: 'Asset acquisition' },
  { key: 'capitalization', label: 'Capitalization' },
  { key: 'depreciation', label: 'Depreciation run' },
  { key: 'transfer', label: 'Transfer' },
  { key: 'impairment', label: 'Impairment' },
  { key: 'revaluation', label: 'Revaluation' },
  { key: 'disposal', label: 'Sale / disposal / write-off' },
  { key: 'reversal', label: 'Reversal' },
];

function blankCategory(): AssetCategory {
  const now = nowIso();
  return {
    id: generateId('facat'), code: '', name: '', description: '',
    accounts: {
      costAccountId: '', accumulatedDepreciationAccountId: '', depreciationExpenseAccountId: '',
      impairmentLossAccountId: '', accumulatedImpairmentAccountId: '', disposalGainAccountId: '',
      disposalLossAccountId: '', aucAccountId: '', recoverableTaxAccountId: '',
      revaluationSurplusAccountId: '', revaluationLossAccountId: '',
    },
    defaultMethod: 'straight_line', defaultUsefulLifeMonths: 60, defaultResidualRatePercent: 0,
    revaluationEnabled: false, isActive: true, createdAt: now, updatedAt: now,
  };
}

export function FixedAssetCategoriesPage() {
  const store = useFixedAssetStore();
  const { accountOptions, accountLabel } = useFaOptions();
  const [editing, setEditing] = useState<AssetCategory | null>(null);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  useState(() => { store.ensureSeeded(); return true; });

  const save = (): void => {
    if (!editing) return;
    const res = store.saveCategory(editing);
    if (!res.ok) { setMsg({ tone: 'error', text: res.error ?? 'Could not save category.' }); return; }
    setEditing(null);
    setMsg({ tone: 'success', text: 'Category saved.' });
  };

  return (
    <div className="space-y-5">
      <div className="flex justify-end"><Button onClick={() => { setMsg(null); setEditing(blankCategory()); }}>New category</Button></div>
      {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}

      <Table head={['Code', 'Name', 'Method', 'Life (months)', 'Cost account', 'Revaluation', '']} minWidth={820}>
        {store.categories.map((c) => (
          <tr key={c.id} className="border-t border-slate-100 dark:border-slate-800">
            <td className="px-4 py-2 font-medium">{c.code}</td>
            <td className="px-4 py-2">{c.name}</td>
            <td className="px-4 py-2 text-slate-500">{c.defaultMethod.replaceAll('_', ' ')}</td>
            <td className="px-4 py-2">{c.defaultUsefulLifeMonths || '—'}</td>
            <td className="px-4 py-2 text-xs text-slate-500">{accountLabel(c.accounts.costAccountId)}</td>
            <td className="px-4 py-2">{c.revaluationEnabled ? 'enabled' : '—'}</td>
            <td className="px-4 py-2 text-right"><Button size="sm" variant="ghost" onClick={() => { setMsg(null); setEditing({ ...c, accounts: { ...c.accounts } }); }}>Edit</Button></td>
          </tr>
        ))}
        {store.categories.length === 0 && emptyRow(7, 'No categories yet.')}
      </Table>

      {/* ── Module settings ──────────────────────────────────────────────── */}
      <Card>
        <CardBody className="space-y-4">
          <h3 className="text-sm font-semibold">Fixed-asset settings</h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field label="Closed through (posting lock date)" hint="Postings on or before this date are rejected">
              <Input type="date" value={store.settings.postingLockDate} onChange={(e) => store.updateSettings({ postingLockDate: e.target.value })} />
            </Field>
            <Field label="Default depreciation frequency">
              <Select value={store.settings.defaultFrequency} onChange={(e) => store.updateSettings({ defaultFrequency: e.target.value as 'monthly' | 'quarterly' | 'annual' })}
                options={[{ value: 'monthly', label: 'Monthly' }, { value: 'quarterly', label: 'Quarterly' }, { value: 'annual', label: 'Annual' }]} />
            </Field>
            <div className="flex items-end pb-1">
              <Toggle checked={store.settings.allowIntercompanyTransfers} onChange={(v) => store.updateSettings({ allowIntercompanyTransfers: v })} label="Allow intercompany transfers" />
            </div>
            {store.settings.allowIntercompanyTransfers && (
              <>
                <Field label="Intercompany due-from account"><Select options={accountOptions} value={store.settings.intercompanyDueFromAccountId} onChange={(e) => store.updateSettings({ intercompanyDueFromAccountId: e.target.value })} /></Field>
                <Field label="Intercompany due-to account"><Select options={accountOptions} value={store.settings.intercompanyDueToAccountId} onChange={(e) => store.updateSettings({ intercompanyDueToAccountId: e.target.value })} /></Field>
              </>
            )}
          </div>
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase text-slate-500">Approvals required before posting</h4>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {APPROVALS.map((a) => (
                <Toggle key={a.key} checked={store.settings.approvalRequired[a.key]} onChange={(v) => store.updateSettings({ approvalRequired: { ...store.settings.approvalRequired, [a.key]: v } })} label={a.label} />
              ))}
            </div>
          </div>
        </CardBody>
      </Card>

      {/* ── Category editor ──────────────────────────────────────────────── */}
      <Drawer open={!!editing} onClose={() => setEditing(null)} title={editing?.code ? `Edit ${editing.code}` : 'New category'}>
        {editing && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Code" required><Input value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })} /></Field>
              <Field label="Name" required><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            </div>
            <Field label="Description"><Textarea value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Default method">
                <Select value={editing.defaultMethod} onChange={(e) => setEditing({ ...editing, defaultMethod: e.target.value as AssetCategory['defaultMethod'] })}
                  options={[{ value: 'straight_line', label: 'Straight line' }, { value: 'reducing_balance', label: 'Reducing balance' }, { value: 'units_of_production', label: 'Units of production' }, { value: 'none', label: 'None (land)' }]} />
              </Field>
              <Field label="Default life (months)"><Input type="number" value={String(editing.defaultUsefulLifeMonths)} onChange={(e) => setEditing({ ...editing, defaultUsefulLifeMonths: Number(e.target.value) || 0 })} /></Field>
            </div>
            <Toggle checked={editing.revaluationEnabled} onChange={(v) => setEditing({ ...editing, revaluationEnabled: v })} label="Revaluation permitted (accounting policy)" />
            <h4 className="pt-1 text-xs font-semibold uppercase text-slate-500">Accounting mappings (chart of accounts)</h4>
            <div className="grid grid-cols-1 gap-3">
              {ACCOUNT_FIELDS.map((fld) => (
                <Field key={fld.key} label={fld.label}>
                  <Select options={accountOptions} value={editing.accounts[fld.key]} onChange={(e) => setEditing({ ...editing, accounts: { ...editing.accounts, [fld.key]: e.target.value } })} />
                </Field>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button onClick={save}>Save category</Button>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

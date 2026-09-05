/**
 * The fixed asset register, on the server.
 *
 * ══ What is missing from this screen, and why ════════════════════════════════
 *
 * No cost column. No accumulated depreciation, no net book value, no "assets on
 * books" total. The browser module shows all four, and every one of them is the
 * sum of postings this release does not make — so the honest number is not zero,
 * it is *absent*. A zero in a Cost column is a figure somebody reconciles
 * against; a column that is not there is a question they ask.
 *
 * ══ Archive is not disposal ══════════════════════════════════════════════════
 *
 * The only lifecycle here is register/archive. Disposal derecognises a cost and
 * posts a gain or a loss, and is a later release. The button says archive, the
 * confirmation says archive, and the server refuses every other status name.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ServerAssetCategory, ServerFixedAsset } from '@/services/api/fixedAssetsApi';
import {
  assetGateway,
  loadAssets,
  IMPORT_REQUIRED,
  useServerFixedAssets,
} from '@/services/fixedAssets/fixedAssetsBackend';
import { useFixedAssetRegister } from '@/services/fixedAssets/useFixedAssetRegister';
import { useSuppliers } from '@/services/parties/useSuppliers';
import { loadSuppliers } from '@/services/parties/supplierDirectory';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Drawer } from '@/components/ui/Drawer';
import { emptyRow, Table } from './FixedAssetsShared';
import { AuditHistory } from './FixedAssetHistory';
import { DeferredAccountingPanel } from './DeferredAccounting';

interface Draft {
  id: string;
  version: number;
  assetCode: string;
  name: string;
  description: string;
  categoryId: string;
  acquisitionDate: string;
  depreciationStartDate: string;
  depreciationMethod: 'straight_line' | 'none';
  usefulLifeMonths: string;
  residualValue: string;
  quantity: string;
  location: string;
  custodian: string;
  branch: string;
  department: string;
  supplierPartyId: string;
  purchaseReference: string;
  notes: string;
}

const today = (): string => {
  /* Local calendar components, not `toISOString()`. East of Greenwich the UTC
   * conversion lands on yesterday, and an acquisition date is a calendar fact. */
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

function blank(category: ServerAssetCategory | undefined): Draft {
  return {
    id: '',
    version: 0,
    assetCode: '',
    name: '',
    description: '',
    categoryId: category?.id ?? '',
    acquisitionDate: today(),
    depreciationStartDate: '',
    /* Pre-filled FROM the category, and freely changed. The asset freezes what
     * is saved here; the category is never read back afterwards. */
    depreciationMethod: category?.defaultMethod ?? 'straight_line',
    usefulLifeMonths:
      category?.defaultUsefulLifeMonths === null || category?.defaultUsefulLifeMonths === undefined
        ? ''
        : String(category.defaultUsefulLifeMonths),
    residualValue: '0',
    quantity: '1',
    location: '',
    custodian: '',
    branch: '',
    department: '',
    supplierPartyId: '',
    purchaseReference: '',
    notes: '',
  };
}

const toDraft = (asset: ServerFixedAsset): Draft => ({
  id: asset.id,
  version: asset.version,
  assetCode: asset.assetCode,
  name: asset.name,
  description: asset.description,
  categoryId: asset.categoryId,
  acquisitionDate: asset.acquisitionDate,
  depreciationStartDate: asset.depreciationStartDate ?? '',
  depreciationMethod: asset.depreciationMethod,
  usefulLifeMonths: asset.usefulLifeMonths === null ? '' : String(asset.usefulLifeMonths),
  residualValue: asset.residualValue,
  quantity: String(asset.quantity),
  location: asset.location,
  custodian: asset.custodian,
  branch: asset.branch,
  department: asset.department,
  supplierPartyId: asset.supplierPartyId ?? '',
  purchaseReference: asset.purchaseReference,
  notes: asset.notes,
});

export function DurableAssetRegisterPage() {
  const {
    assets, categories, capabilities, loading, error, strandedAssets, strandedCategories,
    categoriesMissingMappings,
  } = useFixedAssetRegister();
  const assetState = useServerFixedAssets((s) => s.assetState);
  const search = useServerFixedAssets((s) => s.assetSearch);
  const statusFilter = useServerFixedAssets((s) => s.assetStatusFilter);
  const suppliers = useSuppliers();

  const [editing, setEditing] = useState<Draft | null>(null);
  const [detail, setDetail] = useState<ServerFixedAsset | null>(null);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [term, setTerm] = useState(search);

  useEffect(() => { setTerm(search); }, [search]);

  /* The supplier picker is a note about where an asset came from, so the
   * directory is loaded here rather than assumed to be warm from another
   * screen the user may never have opened. */
  useEffect(() => { void loadSuppliers(); }, []);

  const activeCategories = useMemo(
    () => categories.filter((c) => c.status === 'active'),
    [categories],
  );

  const categoryOptions = useMemo(
    () => activeCategories.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` })),
    [activeCategories],
  );

  const supplierOptions = useMemo(
    () => [
      { value: '', label: '—' },
      ...suppliers.suppliers.map((s) => ({ value: s.id, label: s.legalName })),
    ],
    [suppliers.suppliers],
  );

  const run = async (
    work: () => Promise<unknown>, okText: string, onOk?: () => void,
  ): Promise<void> => {
    setBusy(true);
    try {
      await work();
      setMsg({ tone: 'success', text: okText });
      onOk?.();
    } catch (cause) {
      /* The SERVER's own sentence — a stale version, a duplicate code, a
       * refused method — not a generic failure that hides which. */
      setMsg({
        tone: 'error',
        text: cause instanceof Error ? cause.message : 'Could not save the asset.',
      });
    } finally {
      setBusy(false);
    }
  };

  const save = (): void => {
    if (!editing) return;
    const input = {
      assetCode: editing.assetCode.trim() || null,
      name: editing.name.trim(),
      description: editing.description,
      categoryId: editing.categoryId,
      acquisitionDate: editing.acquisitionDate,
      depreciationStartDate: editing.depreciationStartDate || null,
      depreciationMethod: editing.depreciationMethod,
      usefulLifeMonths: editing.depreciationMethod === 'none'
        ? null
        : Number(editing.usefulLifeMonths) || 0,
      /* An exact decimal STRING to the server; never through a float. */
      residualValue: editing.residualValue.trim() || '0',
      quantity: Number(editing.quantity) || 1,
      location: editing.location,
      custodian: editing.custodian,
      branch: editing.branch,
      department: editing.department,
      supplierPartyId: editing.supplierPartyId || null,
      purchaseReference: editing.purchaseReference,
      notes: editing.notes,
    };
    void run(
      () => (editing.id
        ? assetGateway.update(editing.id, editing.version, input)
        : assetGateway.create(input)),
      editing.id ? 'Asset saved.' : 'Asset registered.',
      () => setEditing(null),
    );
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Assets registered" value={String(assets.filter((a) => a.status === 'draft').length)} />
        <Stat label="Archived" value={String(assets.filter((a) => a.status === 'archived').length)} />
        <Stat label="Categories" value={String(activeCategories.length)} />
        <Stat
          label="Units"
          value={String(assets.reduce((sum, a) => sum + a.quantity, 0))}
        />
      </div>

      {/*
        No cost, accumulated depreciation or net book value tile. Each is the sum
        of postings this release does not make, and a zero in one of those tiles
        is a figure somebody would reconcile against a balance sheet.
      */}
      <Alert variant="info" title="Register only — no accounting yet">
        These are register records, not general-ledger balances. This release holds no acquisition
        cost, no accumulated depreciation and no carrying amount, and posts no journal.
      </Alert>

      {error && <Alert variant="error" title="The register could not be loaded">{error}</Alert>}
      {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}

      {(strandedAssets > 0 || strandedCategories > 0) && (
        <Alert variant="warning" title="Fixed assets left in this browser">
          {`This browser still holds ${strandedAssets} asset(s) and ${strandedCategories} category(ies) `
            + 'from before your books moved to the Ledgora service. '}
          {IMPORT_REQUIRED}
        </Alert>
      )}

      {categoriesMissingMappings.length > 0 && (
        <Alert variant="warning" title="Categories that cannot post depreciation">
          {`${categoriesMissingMappings.map((c) => c.code).join(', ')} `}
          {categoriesMissingMappings.length === 1 ? 'has' : 'have'} incomplete account mappings.
          Assets can be registered in them now, and the depreciation posting they exist for will be
          refused until every account is chosen.
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label="Search assets"
            placeholder="Search assets…"
            className="w-56"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void loadAssets({ search: term }); }}
          />
          <Button variant="outline" onClick={() => void loadAssets({ search: term })}>
            Search
          </Button>
          <Select
            aria-label="Filter by status"
            className="w-44"
            value={statusFilter}
            onChange={(e) => void loadAssets({
              status: e.target.value as '' | 'draft' | 'archived',
            })}
            options={[
              { value: '', label: 'All statuses' },
              { value: 'draft', label: 'Registered' },
              { value: 'archived', label: 'Archived' },
            ]}
          />
        </div>
        <Button
          disabled={activeCategories.length === 0}
          onClick={() => { setMsg(null); setEditing(blank(activeCategories[0])); }}
        >
          New asset
        </Button>
      </div>

      {activeCategories.length === 0 && (
        <Alert variant="info">
          No active asset categories yet — open Asset Categories and create one. An asset takes its
          depreciation policy from a category.
        </Alert>
      )}

      <Table
        head={['Code', 'Name', 'Category', 'Acquired', 'Method', 'Life (months)', 'Units', 'Status', '']}
        minWidth={1000}
      >
        {assets.map((asset) => (
          <tr key={asset.id} className="border-t border-slate-100 dark:border-slate-800">
            <td className="px-4 py-2 font-medium">{asset.assetCode}</td>
            <td className="px-4 py-2">
              {asset.name}
              <span className="block text-xs text-slate-400">
                {[asset.location, asset.custodian].filter(Boolean).join(' · ')}
              </span>
            </td>
            <td className="px-4 py-2 text-slate-500">{asset.categoryCode}</td>
            <td className="px-4 py-2 tabular-nums">{asset.acquisitionDate}</td>
            <td className="px-4 py-2 text-slate-500">
              {asset.depreciationMethod === 'none' ? 'none' : 'straight line'}
            </td>
            <td className="px-4 py-2 tabular-nums">{asset.usefulLifeMonths ?? '—'}</td>
            <td className="px-4 py-2 tabular-nums">{asset.quantity}</td>
            <td className="px-4 py-2">
              <Badge tone={asset.status === 'archived' ? 'slate' : 'green'}>
                {asset.status === 'archived' ? 'archived' : 'registered'}
              </Badge>
            </td>
            <td className="px-4 py-2 text-right">
              <div className="flex justify-end gap-1">
                <Button size="sm" variant="ghost" onClick={() => setDetail(asset)}>Open</Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setMsg(null); setEditing(toDraft(asset)); }}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setMsg(null);
                    void run(
                      () => assetGateway.setArchived(
                        asset.id, asset.version, asset.status !== 'archived',
                      ),
                      asset.status === 'archived'
                        ? `Asset ${asset.assetCode} reactivated.`
                        : `Asset ${asset.assetCode} archived.`,
                    );
                  }}
                >
                  {asset.status === 'archived' ? 'Reactivate' : 'Archive'}
                </Button>
              </div>
            </td>
          </tr>
        ))}
        {assets.length === 0 && emptyRow(
          9,
          loading || assetState === 'loading'
            ? 'Loading the register…'
            : 'No assets in the register.',
        )}
      </Table>

      <DeferredAccountingPanel capabilities={capabilities} />

      {/* ── Editor ───────────────────────────────────────────────────────── */}
      <Drawer
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? `Edit ${editing.assetCode}` : 'Register an asset'}
      >
        {editing && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Asset code" htmlFor="fa-code" hint="Blank = allocated (AST-0001)">
                <Input
                  id="fa-code"
                  value={editing.assetCode}
                  onChange={(e) => setEditing({ ...editing, assetCode: e.target.value })}
                />
              </Field>
              <Field label="Name" htmlFor="fa-name" required>
                <Input
                  id="fa-name"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Description" htmlFor="fa-description">
              <Textarea
                id="fa-description"
                value={editing.description}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Category" htmlFor="fa-category" required>
                <Select
                  id="fa-category"
                  options={categoryOptions}
                  value={editing.categoryId}
                  onChange={(e) => {
                    const category = activeCategories.find((c) => c.id === e.target.value);
                    setEditing({
                      ...editing,
                      categoryId: e.target.value,
                      /* Copy the category's policy onto the DRAFT. Once saved,
                       * the asset owns it and a later category edit cannot
                       * reach back and change it. */
                      depreciationMethod: category?.defaultMethod ?? editing.depreciationMethod,
                      usefulLifeMonths: category?.defaultUsefulLifeMonths == null
                        ? ''
                        : String(category.defaultUsefulLifeMonths),
                    });
                  }}
                />
              </Field>
              <Field label="Acquisition date" htmlFor="fa-acquired" required>
                <Input
                  id="fa-acquired"
                  type="date"
                  value={editing.acquisitionDate}
                  onChange={(e) => setEditing({ ...editing, acquisitionDate: e.target.value })}
                />
              </Field>
              <Field
                label="Depreciation method"
                htmlFor="fa-method"
                hint="Straight line, or none for land."
              >
                <Select
                  id="fa-method"
                  value={editing.depreciationMethod}
                  onChange={(e) => setEditing({
                    ...editing,
                    depreciationMethod: e.target.value as Draft['depreciationMethod'],
                    usefulLifeMonths:
                      e.target.value === 'none' ? '' : editing.usefulLifeMonths || '60',
                  })}
                  options={[
                    { value: 'straight_line', label: 'Straight line' },
                    { value: 'none', label: 'None — does not depreciate' },
                  ]}
                />
              </Field>
              <Field
                label="Useful life (months)"
                htmlFor="fa-life"
                hint="Months. This product does not convert years."
              >
                <Input
                  id="fa-life"
                  type="number"
                  disabled={editing.depreciationMethod === 'none'}
                  value={editing.usefulLifeMonths}
                  onChange={(e) => setEditing({ ...editing, usefulLifeMonths: e.target.value })}
                />
              </Field>
              <Field
                label="Residual value"
                htmlFor="fa-residual"
                hint="An amount. Not checked against cost — cost arrives with capitalisation."
              >
                <Input
                  id="fa-residual"
                  value={editing.residualValue}
                  onChange={(e) => setEditing({ ...editing, residualValue: e.target.value })}
                />
              </Field>
              <Field
                label="Depreciation start date"
                htmlFor="fa-start"
                hint="Optional. On or after the acquisition date."
              >
                <Input
                  id="fa-start"
                  type="date"
                  value={editing.depreciationStartDate}
                  onChange={(e) => setEditing({ ...editing, depreciationStartDate: e.target.value })}
                />
              </Field>
              <Field
                label="Units"
                htmlFor="fa-quantity"
                hint="Identical units this one record represents."
              >
                <Input
                  id="fa-quantity"
                  type="number"
                  value={editing.quantity}
                  onChange={(e) => setEditing({ ...editing, quantity: e.target.value })}
                />
              </Field>
              <Field label="Location" htmlFor="fa-location">
                <Input
                  id="fa-location"
                  value={editing.location}
                  onChange={(e) => setEditing({ ...editing, location: e.target.value })}
                />
              </Field>
              <Field label="Custodian" htmlFor="fa-custodian">
                <Input
                  id="fa-custodian"
                  value={editing.custodian}
                  onChange={(e) => setEditing({ ...editing, custodian: e.target.value })}
                />
              </Field>
              <Field label="Branch" htmlFor="fa-branch">
                <Input
                  id="fa-branch"
                  value={editing.branch}
                  onChange={(e) => setEditing({ ...editing, branch: e.target.value })}
                />
              </Field>
              <Field label="Department" htmlFor="fa-department">
                <Input
                  id="fa-department"
                  value={editing.department}
                  onChange={(e) => setEditing({ ...editing, department: e.target.value })}
                />
              </Field>
              <Field
                label="Supplier"
                htmlFor="fa-supplier"
                hint="Where it came from. Links no bill and posts nothing."
              >
                <Select
                  id="fa-supplier"
                  options={supplierOptions}
                  value={editing.supplierPartyId}
                  onChange={(e) => setEditing({ ...editing, supplierPartyId: e.target.value })}
                />
              </Field>
              <Field label="Purchase reference" htmlFor="fa-reference">
                <Input
                  id="fa-reference"
                  value={editing.purchaseReference}
                  onChange={(e) => setEditing({ ...editing, purchaseReference: e.target.value })}
                />
              </Field>
            </div>

            <Field label="Notes" htmlFor="fa-notes">
              <Textarea
                id="fa-notes"
                value={editing.notes}
                onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
              />
            </Field>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button onClick={save} disabled={busy}>
                {editing.id ? 'Save asset' : 'Register asset'}
              </Button>
            </div>
          </div>
        )}
      </Drawer>

      {/* ── Detail ───────────────────────────────────────────────────────── */}
      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail ? `${detail.assetCode} — ${detail.name}` : ''}
      >
        {detail && (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
              <Info label="Status">{detail.status === 'archived' ? 'Archived' : 'Registered'}</Info>
              <Info label="Category">{`${detail.categoryCode} — ${detail.categoryName}`}</Info>
              <Info label="Acquired">{detail.acquisitionDate}</Info>
              <Info label="Depreciation starts">{detail.depreciationStartDate ?? '—'}</Info>
              <Info label="Method">
                {detail.depreciationMethod === 'none' ? 'None' : 'Straight line'}
              </Info>
              <Info label="Useful life">
                {detail.usefulLifeMonths === null
                  ? '—'
                  : `${detail.usefulLifeMonths} ${detail.usefulLifeUnit}`}
              </Info>
              <Info label="Convention">Full month</Info>
              <Info label="Residual value">{detail.residualValue}</Info>
              <Info label="Units">{String(detail.quantity)}</Info>
              <Info label="Location">{detail.location || '—'}</Info>
              <Info label="Custodian">{detail.custodian || '—'}</Info>
              <Info label="Supplier">{detail.supplierName || '—'}</Info>
              <Info label="Purchase reference">{detail.purchaseReference || '—'}</Info>
              <Info label="Version">{String(detail.version)}</Info>
            </dl>

            {detail.notes && (
              <p className="whitespace-pre-wrap text-xs text-slate-500">{detail.notes}</p>
            )}

            <Alert variant="info" title="No accounting for this asset yet">
              {`This asset has ${detail.accountingActivityCount} posted accounting entries. `}
              It has no cost, no accumulated depreciation and no carrying amount, because nothing
              has been posted for it. Its policy stays editable until something is.
            </Alert>

            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">History</h3>
              <AuditHistory
                load={() => assetGateway.history(detail.id)}
                subjectKey={detail.id}
              />
            </div>
          </div>
        )}
      </Drawer>

      {assetState === 'unavailable' && (
        <Button variant="outline" onClick={() => void loadAssets()}>Try again</Button>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardBody className="py-3">
        <div className="text-[11px] uppercase text-slate-400">{label}</div>
        <div className="text-lg font-semibold tabular-nums">{value}</div>
      </CardBody>
    </Card>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-slate-100 py-1 dark:border-slate-800">
      <dt className="text-slate-400">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

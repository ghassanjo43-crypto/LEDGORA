/**
 * Asset categories, on the server.
 *
 * ══ Three mappings, and no more ══════════════════════════════════════════════
 *
 * Asset cost, accumulated depreciation and depreciation expense. The browser
 * module offers eleven, and the other eight — impairment, revaluation, disposal
 * gain and loss, AUC, recoverable tax — each belong to a posting this release
 * does not make. Offering a picker for an account nothing will ever use is how
 * somebody spends an afternoon configuring a workflow that is not there.
 *
 * ══ The pickers are a convenience, not the rule ══════════════════════════════
 *
 * They are narrowed to the accounts the server will accept, so the common case
 * is one click. The server re-checks every one of them — type, normal balance,
 * cash classification, postable, active, leaf, same company — and its refusal
 * is what is shown, in its own words, when a picker and the books disagree.
 */
import { useMemo, useState } from 'react';
import type { ServerAssetCategory } from '@/services/api/fixedAssetsApi';
import {
  categoryGateway,
  loadCategories,
  useServerFixedAssets,
} from '@/services/fixedAssets/fixedAssetsBackend';
import { useFixedAssetRegister } from '@/services/fixedAssets/useFixedAssetRegister';
import { useStore } from '@/store/useStore';
import { ledgerTypeFor } from '@/services/books/accountMapping';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Drawer } from '@/components/ui/Drawer';
import { emptyRow, Table } from './FixedAssetsShared';
import { AuditHistory } from './FixedAssetHistory';

/** The draft a drawer edits. `id` empty means it has never been saved. */
interface Draft {
  id: string;
  version: number;
  code: string;
  name: string;
  description: string;
  defaultMethod: 'straight_line' | 'none';
  defaultUsefulLifeMonths: string;
  defaultResidualPercent: string;
  assetCostAccountId: string;
  accumulatedDepreciationAccountId: string;
  depreciationExpenseAccountId: string;
}

const blank = (): Draft => ({
  id: '',
  version: 0,
  code: '',
  name: '',
  description: '',
  defaultMethod: 'straight_line',
  defaultUsefulLifeMonths: '60',
  defaultResidualPercent: '0',
  assetCostAccountId: '',
  accumulatedDepreciationAccountId: '',
  depreciationExpenseAccountId: '',
});

const toDraft = (category: ServerAssetCategory): Draft => ({
  id: category.id,
  version: category.version,
  code: category.code,
  name: category.name,
  description: category.description,
  defaultMethod: category.defaultMethod,
  defaultUsefulLifeMonths:
    category.defaultUsefulLifeMonths === null ? '' : String(category.defaultUsefulLifeMonths),
  defaultResidualPercent: category.defaultResidualPercent,
  assetCostAccountId: category.assetCostAccountId ?? '',
  accumulatedDepreciationAccountId: category.accumulatedDepreciationAccountId ?? '',
  depreciationExpenseAccountId: category.depreciationExpenseAccountId ?? '',
});

export function DurableAssetCategoriesPage() {
  const { categories, loading, error } = useFixedAssetRegister();
  const categoryState = useServerFixedAssets((s) => s.categoryState);
  const accounts = useStore((s) => s.accounts);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [historyFor, setHistoryFor] = useState<ServerAssetCategory | null>(null);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * The three eligible sets, narrowed by exactly the rules the server applies.
   * `normalBalance` is what separates the cost account from the accumulated
   * depreciation account: both are assets, and the credit one is the
   * contra-asset.
   */
  const options = useMemo(() => {
    const eligible = accounts.filter(
      (a) => a.isPostingAccount && a.isActive && !a.isArchived && !a.isBlocked
        && (!a.cashClassification || a.cashClassification === 'none')
        && !accounts.some((child) => child.parentId === a.id),
    );
    const pick = (ledger: 'asset' | 'expense', balance: 'DEBIT' | 'CREDIT') => [
      { value: '', label: '— not mapped —' },
      ...eligible
        .filter((a) => ledgerTypeFor(a.type) === ledger && a.normalBalance === balance)
        .map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
    ];
    return {
      cost: pick('asset', 'DEBIT'),
      accumulated: pick('asset', 'CREDIT'),
      expense: pick('expense', 'DEBIT'),
    };
  }, [accounts]);

  const report = (result: { ok: boolean; error?: string }, okText: string): boolean => {
    setMsg(result.ok ? { tone: 'success', text: okText } : {
      tone: 'error', text: result.error ?? 'Action failed.',
    });
    return result.ok;
  };

  const run = async (
    work: () => Promise<unknown>, okText: string, onOk?: () => void,
  ): Promise<void> => {
    setBusy(true);
    try {
      await work();
      report({ ok: true }, okText);
      onOk?.();
    } catch (cause) {
      /* The SERVER's sentence, verbatim. It names which account is wrong and
       * why, which a generic "could not save" would throw away. */
      report({ ok: false, error: cause instanceof Error ? cause.message : undefined }, okText);
    } finally {
      setBusy(false);
    }
  };

  const save = (): void => {
    if (!editing) return;
    const input = {
      code: editing.code.trim(),
      name: editing.name.trim(),
      description: editing.description,
      defaultMethod: editing.defaultMethod,
      defaultUsefulLifeMonths: editing.defaultMethod === 'none'
        ? null
        : Number(editing.defaultUsefulLifeMonths) || 0,
      /* An exact decimal STRING all the way to the server. Never a float. */
      defaultResidualPercent: editing.defaultResidualPercent.trim() || '0',
      assetCostAccountId: editing.assetCostAccountId || null,
      accumulatedDepreciationAccountId: editing.accumulatedDepreciationAccountId || null,
      depreciationExpenseAccountId: editing.depreciationExpenseAccountId || null,
    };
    void run(
      () => (editing.id
        ? categoryGateway.update(editing.id, editing.version, input)
        : categoryGateway.create(input)),
      editing.id ? 'Category saved.' : 'Category created.',
      () => setEditing(null),
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-xs text-slate-500 dark:text-slate-400">
          A category holds the depreciation policy a new asset copies, and the three accounts a
          future depreciation entry will use. Saving one creates no journal.
        </p>
        <Button onClick={() => { setMsg(null); setEditing(blank()); }}>New category</Button>
      </div>

      {msg && <Alert variant={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}
      {error && <Alert variant="error" title="The register could not be loaded">{error}</Alert>}

      <Table
        head={['Code', 'Name', 'Method', 'Life (months)', 'Residual %', 'Mappings', 'Status', 'Assets', '']}
        minWidth={980}
      >
        {categories.map((category) => (
          <tr key={category.id} className="border-t border-slate-100 dark:border-slate-800">
            <td className="px-4 py-2 font-medium">{category.code}</td>
            <td className="px-4 py-2">{category.name}</td>
            <td className="px-4 py-2 text-slate-500">
              {category.defaultMethod === 'none' ? 'none (not depreciated)' : 'straight line'}
            </td>
            <td className="px-4 py-2 tabular-nums">{category.defaultUsefulLifeMonths ?? '—'}</td>
            <td className="px-4 py-2 tabular-nums">{category.defaultResidualPercent}</td>
            <td className="px-4 py-2">
              {category.mappingComplete
                ? <Badge tone="green">complete</Badge>
                : <Badge tone="amber">incomplete</Badge>}
            </td>
            <td className="px-4 py-2">
              <Badge tone={category.status === 'active' ? 'green' : 'slate'}>{category.status}</Badge>
            </td>
            <td className="px-4 py-2 tabular-nums">{category.activeAssetCount}</td>
            <td className="px-4 py-2 text-right">
              <div className="flex justify-end gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setMsg(null); setEditing(toDraft(category)); }}
                >
                  Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setHistoryFor(category)}>
                  History
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setMsg(null);
                    void run(
                      () => categoryGateway.setArchived(
                        category.id, category.version, category.status !== 'archived',
                      ),
                      category.status === 'archived'
                        ? `Category ${category.code} reactivated.`
                        : `Category ${category.code} archived.`,
                    );
                  }}
                >
                  {category.status === 'archived' ? 'Reactivate' : 'Archive'}
                </Button>
              </div>
            </td>
          </tr>
        ))}
        {categories.length === 0 && emptyRow(
          9,
          loading || categoryState === 'loading'
            ? 'Loading categories…'
            : 'No asset categories yet. Create one to start registering assets.',
        )}
      </Table>

      <DeferredMappings />

      {/* ── Editor ───────────────────────────────────────────────────────── */}
      <Drawer
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? `Edit ${editing.code}` : 'New asset category'}
      >
        {editing && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Code" htmlFor="fa-cat-code" required>
                <Input
                  id="fa-cat-code"
                  value={editing.code}
                  onChange={(e) => setEditing({ ...editing, code: e.target.value })}
                />
              </Field>
              <Field label="Name" htmlFor="fa-cat-name" required>
                <Input
                  id="fa-cat-name"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Description" htmlFor="fa-cat-description">
              <Textarea
                id="fa-cat-description"
                value={editing.description}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Default method"
                htmlFor="fa-cat-method"
                hint="Straight line, or none for assets such as land."
              >
                <Select
                  id="fa-cat-method"
                  value={editing.defaultMethod}
                  onChange={(e) => setEditing({
                    ...editing,
                    defaultMethod: e.target.value as Draft['defaultMethod'],
                    defaultUsefulLifeMonths:
                      e.target.value === 'none' ? '' : editing.defaultUsefulLifeMonths || '60',
                  })}
                  options={[
                    { value: 'straight_line', label: 'Straight line' },
                    { value: 'none', label: 'None — does not depreciate' },
                  ]}
                />
              </Field>
              <Field
                label="Default useful life (months)"
                htmlFor="fa-cat-life"
                hint="Months. This product does not convert years."
              >
                <Input
                  id="fa-cat-life"
                  type="number"
                  disabled={editing.defaultMethod === 'none'}
                  value={editing.defaultUsefulLifeMonths}
                  onChange={(e) => setEditing({ ...editing, defaultUsefulLifeMonths: e.target.value })}
                />
              </Field>
              <Field
                label="Default residual %"
                htmlFor="fa-cat-residual"
                hint="A percentage of cost. An asset holds a residual AMOUNT."
              >
                <Input
                  id="fa-cat-residual"
                  value={editing.defaultResidualPercent}
                  onChange={(e) => setEditing({ ...editing, defaultResidualPercent: e.target.value })}
                />
              </Field>
              <Field label="Depreciation convention" htmlFor="fa-cat-convention">
                <Input id="fa-cat-convention" value="Full month" readOnly disabled />
              </Field>
            </div>

            <div>
              <h4 className="pt-1 text-xs font-semibold uppercase text-slate-500">
                Accounting mappings
              </h4>
              <p className="mt-1 text-xs text-slate-400">
                Where a future depreciation entry will post. Nothing is posted now, and a category
                may be saved before every account exists — the register report lists what is still
                missing.
              </p>
            </div>
            <Field
              label="Fixed asset cost"
              htmlFor="fa-cat-cost-account"
              hint="An asset account with a debit normal balance."
            >
              <Select
                id="fa-cat-cost-account"
                options={options.cost}
                value={editing.assetCostAccountId}
                onChange={(e) => setEditing({ ...editing, assetCostAccountId: e.target.value })}
              />
            </Field>
            <Field
              label="Accumulated depreciation"
              htmlFor="fa-cat-accum-account"
              hint="A CONTRA-ASSET: an asset account whose normal balance is a credit."
            >
              <Select
                id="fa-cat-accum-account"
                options={options.accumulated}
                value={editing.accumulatedDepreciationAccountId}
                onChange={(e) => setEditing({
                  ...editing, accumulatedDepreciationAccountId: e.target.value,
                })}
              />
            </Field>
            <Field
              label="Depreciation expense"
              htmlFor="fa-cat-expense-account"
              hint="An expense account."
            >
              <Select
                id="fa-cat-expense-account"
                options={options.expense}
                value={editing.depreciationExpenseAccountId}
                onChange={(e) => setEditing({
                  ...editing, depreciationExpenseAccountId: e.target.value,
                })}
              />
            </Field>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button onClick={save} disabled={busy}>Save category</Button>
            </div>
          </div>
        )}
      </Drawer>

      <Drawer
        open={!!historyFor}
        onClose={() => setHistoryFor(null)}
        title={historyFor ? `History — ${historyFor.code}` : ''}
      >
        {historyFor && (
          <AuditHistory
            load={() => categoryGateway.history(historyFor.id)}
            subjectKey={historyFor.id}
          />
        )}
      </Drawer>

      {/* Reload after an outage without making the user find the page again. */}
      {categoryState === 'unavailable' && (
        <Button variant="outline" onClick={() => void loadCategories()}>Try again</Button>
      )}
    </div>
  );
}

/**
 * The eight mappings this release does not ask for, and why.
 *
 * Listed rather than silently absent: an administrator who configured eleven
 * accounts in the browser will look for them, and "we removed the ones nothing
 * uses" is a better answer than an editor that appears to have lost half its
 * fields.
 */
function DeferredMappings() {
  return (
    <Card>
      <CardBody className="space-y-2">
        <h3 className="text-sm font-semibold">Mappings this release does not ask for</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Impairment loss, accumulated impairment, disposal gain, disposal loss, asset under
          construction, recoverable input tax, revaluation surplus and revaluation loss are not
          configured here. Each belongs to a posting this release does not make, and the rules for
          which accounts are eligible are part of the decision that posting has not made. They
          arrive with the workflows that use them — nothing you configure now is lost.
        </p>
      </CardBody>
    </Card>
  );
}

/**
 * The audit trail for one category or one asset.
 *
 * ══ Why before AND after ═════════════════════════════════════════════════════
 *
 * "The category was updated" is not a history; it is a notification. What a
 * reviewer needs is which useful life it had and which it has now, because that
 * is the pair that explains a depreciation figure somebody is questioning. The
 * server records both, and this shows both.
 *
 * The actor is the server's, taken from the session — never a name a client
 * supplied — so a trail cannot be signed with somebody else's.
 */
import { useEffect, useState } from 'react';
import type { FixedAssetAuditEvent } from '@/services/api/fixedAssetsApi';
import { Alert } from '@/components/ui/Alert';
import { Card } from '@/components/ui/Card';

/** Field names as a bookkeeper reads them, not as the API spells them. */
const LABELS: Readonly<Record<string, string>> = {
  code: 'Code',
  assetCode: 'Asset code',
  name: 'Name',
  status: 'Status',
  default_method: 'Default method',
  defaultMethod: 'Default method',
  default_useful_life_months: 'Default useful life (months)',
  defaultUsefulLifeMonths: 'Default useful life (months)',
  default_residual_percent: 'Default residual %',
  defaultResidualPercent: 'Default residual %',
  depreciation_convention: 'Depreciation convention',
  depreciationConvention: 'Depreciation convention',
  asset_cost_account_id: 'Asset cost account',
  assetCostAccountId: 'Asset cost account',
  accumulated_depreciation_account_id: 'Accumulated depreciation account',
  accumulatedDepreciationAccountId: 'Accumulated depreciation account',
  depreciation_expense_account_id: 'Depreciation expense account',
  depreciationExpenseAccountId: 'Depreciation expense account',
  category_id: 'Category',
  categoryId: 'Category',
  acquisition_date: 'Acquisition date',
  acquisitionDate: 'Acquisition date',
  depreciation_start_date: 'Depreciation start date',
  depreciationStartDate: 'Depreciation start date',
  depreciation_method: 'Depreciation method',
  depreciationMethod: 'Depreciation method',
  useful_life_months: 'Useful life (months)',
  usefulLifeMonths: 'Useful life (months)',
  residual_value: 'Residual value',
  residualValue: 'Residual value',
  quantity: 'Units',
  location: 'Location',
  custodian: 'Custodian',
  branch: 'Branch',
  department: 'Department',
  supplier_party_id: 'Supplier',
  supplierPartyId: 'Supplier',
  purchase_reference: 'Purchase reference',
  purchaseReference: 'Purchase reference',
};

const ACTIONS: Readonly<Record<string, string>> = {
  CATEGORY_CREATED: 'Category created',
  CATEGORY_UPDATED: 'Category updated',
  CATEGORY_ARCHIVED: 'Category archived',
  CATEGORY_REACTIVATED: 'Category reactivated',
  ASSET_REGISTERED: 'Asset registered',
  ASSET_UPDATED: 'Asset updated',
  ASSET_ARCHIVED: 'Asset archived',
  ASSET_REACTIVATED: 'Asset reactivated',
};

/** Fields the trail carries for bookkeeping rather than for reading. */
const HIDDEN = new Set(['updated_by', 'created_by', 'description', 'notes']);

const render = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
};

function Changes({ detail }: { detail: Record<string, unknown> }) {
  const before = (detail.before ?? {}) as Record<string, unknown>;
  const after = (detail.after ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !HIDDEN.has(key))
    /* Only what actually moved. A list that repeated every unchanged field
     * would bury the one line somebody opened this to find. */
    .filter((key) => render(before[key]) !== render(after[key]));

  if (keys.length === 0) return null;

  return (
    <table className="mt-1 w-full text-[11px]">
      <thead className="text-slate-400">
        <tr>
          <th className="py-0.5 text-left font-normal">Field</th>
          <th className="py-0.5 text-left font-normal">From</th>
          <th className="py-0.5 text-left font-normal">To</th>
        </tr>
      </thead>
      <tbody>
        {keys.map((key) => (
          <tr key={key} className="border-t border-slate-100 dark:border-slate-800">
            <td className="py-0.5 pr-2 text-slate-500">{LABELS[key] ?? key}</td>
            <td className="py-0.5 pr-2 tabular-nums">{render(before[key])}</td>
            <td className="py-0.5 font-medium tabular-nums">{render(after[key])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AuditHistory({
  load,
  subjectKey,
}: {
  load: () => Promise<FixedAssetAuditEvent[]>;
  subjectKey: string;
}) {
  const [events, setEvents] = useState<FixedAssetAuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setEvents(null);
    setError(null);
    load()
      .then((rows) => { if (live) setEvents(rows); })
      .catch((cause: unknown) => {
        if (!live) return;
        /* Empty and SAID to be empty. A history that silently showed nothing
         * would read as "nobody has touched this". */
        setError(cause instanceof Error ? cause.message : 'Could not load the history.');
      });
    return () => { live = false; };
    /* Keyed on the subject: reopening the drawer for another record must not
     * show the previous one's trail while the new request is in flight. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjectKey]);

  if (error) return <Alert variant="error" title="History unavailable">{error}</Alert>;
  if (events === null) return <p className="text-xs text-slate-400">Loading history…</p>;
  if (events.length === 0) return <p className="text-xs text-slate-400">No history yet.</p>;

  return (
    <div className="space-y-2">
      {events.map((event) => (
        <Card key={event.id} className="px-3 py-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-xs font-semibold">
              {ACTIONS[event.action] ?? event.action}
            </span>
            <span className="text-[11px] text-slate-400">
              {event.occurredAt ? new Date(event.occurredAt).toLocaleString() : ''}
              {event.actorName ? ` · ${event.actorName}` : ''}
              {event.resultingVersion !== null ? ` · v${event.resultingVersion}` : ''}
            </span>
          </div>
          {event.reason && (
            <p className="mt-0.5 text-[11px] italic text-slate-500">{event.reason}</p>
          )}
          <Changes detail={event.detail} />
        </Card>
      ))}
    </div>
  );
}

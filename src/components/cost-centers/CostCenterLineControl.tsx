import { useState } from 'react';
import { Split, X } from 'lucide-react';
import type { CostCenterAssignment } from '@/types/costCenter';
import { useCostCenterStore } from '@/store/costCenterStore';
import { CostCenterPicker } from './CostCenterPicker';
import { CostCenterSplitEditor } from './CostCenterSplitEditor';

interface Props {
  amount: number;
  costCenterId?: string;
  assignments?: CostCenterAssignment[];
  onChange: (patch: { costCenterId?: string; costCenterAssignments?: CostCenterAssignment[] }) => void;
  postingDate?: string;
  currency?: string;
  disabled?: boolean;
}

/**
 * Compact per-line cost-center control shared by invoice / bill / credit-note /
 * supplier-credit line editors: a single picker with a "Split" toggle that
 * reveals the reusable {@link CostCenterSplitEditor}.
 */
export function CostCenterLineControl({ amount, costCenterId, assignments, onChange, postingDate, currency, disabled }: Props) {
  const costCenters = useCostCenterStore((s) => s.costCenters);
  const [split, setSplit] = useState((assignments?.filter((a) => a.costCenterId).length ?? 0) > 1);

  const startSplit = (): void => {
    setSplit(true);
    if (!assignments || assignments.length === 0) {
      onChange({ costCenterId: undefined, costCenterAssignments: costCenterId ? [{ costCenterId, percentage: 100 }] : [{ costCenterId: '', percentage: 100 }] });
    }
  };
  const stopSplit = (): void => {
    setSplit(false);
    const first = assignments?.find((a) => a.costCenterId)?.costCenterId;
    onChange({ costCenterAssignments: undefined, costCenterId: first });
  };

  return (
    <div className="flex items-start gap-2">
      <span className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Cost center</span>
      {split ? (
        <div className="flex-1">
          <CostCenterSplitEditor amount={amount} currency={currency} assignments={assignments ?? []} onChange={(a) => onChange({ costCenterAssignments: a, costCenterId: undefined })} costCenters={costCenters} postingDate={postingDate} disabled={disabled} />
        </div>
      ) : (
        <div className="max-w-xs flex-1"><CostCenterPicker value={costCenterId ?? ''} onChange={(id) => onChange({ costCenterId: id, costCenterAssignments: undefined })} costCenters={costCenters} postingDate={postingDate} disabled={disabled} /></div>
      )}
      {!disabled && (
        <button type="button" onClick={split ? stopSplit : startSplit} className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
          {split ? <><X className="h-3 w-3" /> Single</> : <><Split className="h-3 w-3" /> Split</>}
        </button>
      )}
    </div>
  );
}

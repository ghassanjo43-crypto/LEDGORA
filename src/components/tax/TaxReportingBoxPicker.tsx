import type { TaxReportingBox } from '@/types/taxReporting';
import { cn as cx } from '@/lib/utils';

interface Props {
  boxes: TaxReportingBox[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

/** Multi-select of the jurisdiction's active reporting boxes for a tax code. */
export function TaxReportingBoxPicker({ boxes, selected, onChange, disabled }: Props) {
  const toggle = (id: string): void => {
    if (disabled) return;
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };
  const active = boxes.filter((b) => b.status === 'active').sort((a, b) => a.sortOrder - b.sortOrder);
  if (active.length === 0) return <p className="text-xs text-slate-400">No reporting boxes are defined for this jurisdiction yet.</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {active.map((box) => {
        const on = selected.includes(box.id);
        return (
          <button
            type="button"
            key={box.id}
            onClick={() => toggle(box.id)}
            disabled={disabled}
            className={cx(
              'rounded-lg border px-2.5 py-1.5 text-left text-xs transition',
              on ? 'border-brand-500 bg-brand-50 text-brand-700 dark:border-brand-500/50 dark:bg-brand-500/10 dark:text-brand-300' : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            <span className="font-mono font-semibold">{box.code}</span> · {box.name}
          </button>
        );
      })}
    </div>
  );
}

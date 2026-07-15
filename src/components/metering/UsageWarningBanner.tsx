import { Gauge, ArrowRight } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { useUsageAlertBand } from '@/store/meteringHooks';
import { cn } from '@/lib/utils';

const BAND_TONE: Record<string, string> = {
  warn70: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
  warn85: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200',
  over100: 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200',
  critical120: 'border-red-300 bg-red-100 text-red-900 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-200',
};

/**
 * Shown when any metered allowance crosses a warning threshold (70/85/100/120%).
 * Overage-billed metrics keep working — the banner is informational.
 */
export function UsageWarningBanner() {
  const { band, line } = useUsageAlertBand();
  const setActiveView = useStore((s) => s.setActiveView);
  if (!line) return null;

  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-sm print:hidden', BAND_TONE[band] ?? BAND_TONE.warn70)}>
      <Gauge className="h-4 w-4 shrink-0" />
      <span className="font-medium">
        {line.label} at {Math.round(line.pct)}% of your allowance
        {line.overage > 0 && ` — ${line.overage} ${line.unit} over`}
      </span>
      <span className="opacity-90">
        {band === 'critical120'
          ? 'You are well over your included allowance; overage charges apply.'
          : band === 'over100'
            ? 'You have exceeded your included allowance; overage charges apply.'
            : 'You are approaching your included allowance.'}
      </span>
      <button
        type="button"
        onClick={() => setActiveView('subscription')}
        className="focus-ring ml-auto inline-flex items-center gap-1 rounded font-medium underline-offset-2 hover:underline"
      >
        View usage <ArrowRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

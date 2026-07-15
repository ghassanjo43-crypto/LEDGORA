import type { LucideIcon } from 'lucide-react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

export type MetricTone =
  | 'brand'
  | 'emerald'
  | 'amber'
  | 'red'
  | 'violet'
  | 'indigo'
  | 'cyan'
  | 'slate';

const toneTile: Record<MetricTone, string> = {
  brand: 'bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300',
  emerald: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300',
  amber: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300',
  red: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300',
  violet: 'bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-300',
  indigo: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300',
  cyan: 'bg-cyan-50 text-cyan-600 dark:bg-cyan-500/10 dark:text-cyan-300',
  slate: 'bg-slate-100 text-slate-600 dark:bg-slate-500/10 dark:text-slate-300',
};

const toneGlow: Record<MetricTone, string> = {
  brand: 'before:from-brand-500/10',
  emerald: 'before:from-emerald-500/10',
  amber: 'before:from-amber-500/10',
  red: 'before:from-red-500/10',
  violet: 'before:from-violet-500/10',
  indigo: 'before:from-indigo-500/10',
  cyan: 'before:from-cyan-500/10',
  slate: 'before:from-slate-400/10',
};

export interface MetricTrend {
  value: string;
  direction: 'up' | 'down' | 'flat';
  /** When true, "up" is bad (e.g. errors) and renders red. */
  invert?: boolean;
}

export interface MetricCardProps {
  label: string;
  value: string | number;
  icon: LucideIcon;
  tone?: MetricTone;
  hint?: string;
  trend?: MetricTrend;
  onClick?: () => void;
}

export function MetricCard({
  label,
  value,
  icon: Icon,
  tone = 'brand',
  hint,
  trend,
  onClick,
}: MetricCardProps) {
  const interactive = typeof onClick === 'function';
  const TrendIcon =
    trend?.direction === 'up' ? TrendingUp : trend?.direction === 'down' ? TrendingDown : Minus;
  const goodDirection = trend
    ? trend.direction === 'flat'
      ? 'flat'
      : (trend.direction === 'up') !== !!trend.invert
        ? 'good'
        : 'bad'
    : 'flat';

  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      className={cn(
        'group relative overflow-hidden rounded-xl border border-slate-200/80 bg-white p-4 shadow-card transition duration-150 dark:border-slate-800 dark:bg-slate-900',
        'before:pointer-events-none before:absolute before:-right-8 before:-top-8 before:h-24 before:w-24 before:rounded-full before:bg-gradient-to-br before:to-transparent before:opacity-70',
        toneGlow[tone],
        interactive &&
          'focus-ring cursor-pointer hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-elevated dark:hover:border-slate-700',
      )}
    >
      <div className="flex items-start justify-between">
        <span className={cn('flex h-10 w-10 items-center justify-center rounded-lg', toneTile[tone])}>
          <Icon className="h-5 w-5" strokeWidth={2} />
        </span>
        {trend && (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium',
              goodDirection === 'good'
                ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300'
                : goodDirection === 'bad'
                  ? 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300'
                  : 'bg-slate-100 text-slate-500 dark:bg-slate-500/10 dark:text-slate-400',
            )}
          >
            <TrendIcon className="h-3 w-3" />
            {trend.value}
          </span>
        )}
      </div>
      <p className="mt-3 truncate text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50" title={String(value)}>
        {value}
      </p>
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      {hint && <p className="mt-0.5 truncate text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

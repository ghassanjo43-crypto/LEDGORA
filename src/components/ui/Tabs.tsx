import { Fragment } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: LucideIcon;
  count?: number;
  /**
   * Optional section heading this tab opens, e.g. `CUSTOMERS`.
   *
   * Purely additive: a tab list where nothing declares a group renders exactly
   * as it always did, so every existing caller is unaffected. Grouping exists
   * for the platform console, whose sections — customers, billing, platform —
   * are unrelated enough that a flat row of eight tabs reads as a pile.
   */
  group?: string;
}

export interface TabsProps<T extends string> {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}

/** Underline-style tab bar used for settings and multi-section pages. */
export function Tabs<T extends string>({ tabs, value, onChange, className }: TabsProps<T>) {
  const grouped = tabs.some((tab) => tab.group);

  return (
    <div
      className={cn(
        'flex items-center gap-1 border-b border-slate-200 dark:border-slate-800',
        grouped && 'flex-wrap',
        className,
      )}
      role="tablist"
    >
      {tabs.map((tab, index) => {
        const active = tab.id === value;
        const Icon = tab.icon;
        // A heading appears only where a new section begins.
        const opensGroup = tab.group && tab.group !== tabs[index - 1]?.group;

        return (
          <Fragment key={tab.id}>
            {opensGroup && (
              <span
                className={cn(
                  'select-none self-center px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400',
                  index > 0 && 'ml-2 border-l border-slate-200 dark:border-slate-800',
                )}
              >
                {tab.group}
              </span>
            )}
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(tab.id)}
              className={cn(
                'focus-ring -mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
                active
                  ? 'border-brand-600 text-brand-700 dark:border-brand-400 dark:text-brand-300'
                  : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200',
              )}
            >
              {Icon && <Icon className="h-4 w-4" />}
              {tab.label}
              {typeof tab.count === 'number' && (
                <span
                  className={cn(
                    'rounded-full px-1.5 py-0.5 text-[11px] font-semibold',
                    active
                      ? 'bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-200'
                      : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
                  )}
                >
                  {tab.count}
                </span>
              )}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

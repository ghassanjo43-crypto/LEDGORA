import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}

/** Consistent, friendly empty-state used across tables and pages. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  compact,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-3 py-10' : 'gap-4 py-16',
        className,
      )}
    >
      <span className="relative flex h-16 w-16 items-center justify-center">
        <span className="absolute inset-0 rounded-2xl bg-gradient-to-br from-brand-50 to-slate-100 dark:from-brand-500/10 dark:to-slate-800" />
        <Icon className="relative h-7 w-7 text-brand-500 dark:text-brand-300" strokeWidth={2} />
      </span>
      <div className="max-w-sm">
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</p>
        {description && (
          <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

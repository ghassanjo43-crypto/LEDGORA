import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface Crumb {
  label: string;
  onClick?: () => void;
}

export function Breadcrumb({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cn('flex items-center gap-1 text-xs text-slate-400', className)}>
      {items.map((item, i) => {
        const last = i === items.length - 1;
        return (
          <span key={`${item.label}-${i}`} className="flex items-center gap-1">
            {item.onClick && !last ? (
              <button
                type="button"
                onClick={item.onClick}
                className="focus-ring rounded transition-colors hover:text-slate-600 dark:hover:text-slate-300"
              >
                {item.label}
              </button>
            ) : (
              <span className={cn(last && 'font-medium text-slate-500 dark:text-slate-400')}>
                {item.label}
              </span>
            )}
            {!last && <ChevronRight className="h-3 w-3 text-slate-300 dark:text-slate-600" />}
          </span>
        );
      })}
    </nav>
  );
}

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  breadcrumb?: Crumb[];
  badge?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/**
 * The standard band that opens every page: breadcrumb, icon, title, subtitle
 * and a right-aligned actions cluster (quick actions / primary + secondary).
 */
export function PageHeader({
  title,
  subtitle,
  icon: Icon,
  breadcrumb,
  badge,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn('mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between', className)}>
      <div className="min-w-0">
        {breadcrumb && breadcrumb.length > 0 && <Breadcrumb items={breadcrumb} className="mb-2" />}
        <div className="flex items-center gap-3">
          {Icon && (
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-elevated">
              <Icon className="h-5 w-5" strokeWidth={2} />
            </span>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                {title}
              </h1>
              {badge}
            </div>
            {subtitle && (
              <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
            )}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 empty:hidden">
        {actions}
        {/* Portal target: pages inject their primary actions here via <PageActions>. */}
        <div id="page-header-actions" className="flex flex-wrap items-center gap-2 empty:hidden" />
      </div>
    </div>
  );
}

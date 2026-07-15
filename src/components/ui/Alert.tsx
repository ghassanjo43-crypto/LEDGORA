import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icons';

type AlertVariant = 'info' | 'success' | 'warning' | 'error';

const variantStyles: Record<
  AlertVariant,
  { wrap: string; icon: ReactNode }
> = {
  info: {
    wrap: 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200',
    icon: <Icon.Warning className="h-4 w-4" />,
  },
  success: {
    wrap: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200',
    icon: <Icon.Check className="h-4 w-4" />,
  },
  warning: {
    wrap: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
    icon: <Icon.Warning className="h-4 w-4" />,
  },
  error: {
    wrap: 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200',
    icon: <Icon.Alert className="h-4 w-4" />,
  },
};

export interface AlertProps {
  variant?: AlertVariant;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  onClose?: () => void;
}

export function Alert({ variant = 'info', title, children, className, onClose }: AlertProps) {
  const style = variantStyles[variant];
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm',
        style.wrap,
        className,
      )}
    >
      <span className="mt-0.5 shrink-0">{style.icon}</span>
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn(title && 'mt-0.5', 'text-sm opacity-90')}>{children}</div>}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 opacity-60 transition-opacity hover:opacity-100"
          aria-label="Dismiss"
        >
          <Icon.Close className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

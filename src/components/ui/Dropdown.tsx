import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DropdownProps {
  /** Render the trigger; receives whether the menu is open. */
  trigger: (open: boolean) => ReactNode;
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
  panelClassName?: string;
  /** Accessible label for the trigger wrapper. */
  label?: string;
  /** Close the menu when its content is clicked (default true; false for forms). */
  closeOnClick?: boolean;
}

/** Lightweight popover menu with outside-click + Escape handling. */
export function Dropdown({
  trigger,
  children,
  align = 'right',
  className,
  panelClassName,
  label,
  closeOnClick = true,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className="focus-ring rounded-lg"
      >
        {trigger(open)}
      </button>
      {open && (
        <div
          role="menu"
          onClick={closeOnClick ? () => setOpen(false) : undefined}
          className={cn(
            'absolute z-50 mt-2 min-w-[13rem] animate-scale-in rounded-xl border border-slate-200 bg-white p-1.5 shadow-dropdown dark:border-slate-700 dark:bg-slate-900',
            align === 'right' ? 'right-0 origin-top-right' : 'left-0 origin-top-left',
            panelClassName,
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export interface MenuItemProps {
  icon?: LucideIcon;
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string;
}

export function MenuItem({ icon: Icon, children, onClick, danger, disabled, shortcut }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'focus-ring flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        danger
          ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10'
          : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
      )}
    >
      {Icon && <Icon className="h-4 w-4 shrink-0 text-slate-400" />}
      <span className="flex-1">{children}</span>
      {shortcut && <span className="text-[11px] text-slate-400">{shortcut}</span>}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
      {children}
    </p>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-slate-100 dark:bg-slate-800" />;
}

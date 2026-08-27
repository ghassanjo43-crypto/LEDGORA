import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { computePopoverPosition, type PopoverPosition } from '@/lib/popoverPosition';

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

/** Widest a menu may grow before its labels wrap. */
const MAX_MENU_WIDTH = 320;
/** `min-w-[13rem]` in pixels — the floor the panel has always had. */
const MIN_MENU_WIDTH = 208;

/**
 * Lightweight popover menu with outside-click + Escape handling.
 *
 * ── Why the panel is portaled rather than absolutely positioned ──────────────
 *
 * It used to be an `absolute z-50` child of the trigger, which meant any ancestor
 * with a non-visible `overflow` clipped it. Every data table is exactly that: a
 * `Card` with `overflow-hidden` (for the rounded border) wrapping a scroller with
 * `overflow-x-auto` (for narrow screens). A row's Actions menu opened *inside*
 * that box and was cut off at its edge.
 *
 * Raising `z-index` cannot fix this. Clipping and stacking are separate concerns:
 * an overflow box clips its descendants no matter which layer they paint on, so
 * the panel has to stop being a descendant. It renders into `document.body` and
 * is positioned against the trigger's viewport rect instead — which also means
 * the table keeps its `overflow-hidden` rounding and its horizontal scrolling
 * untouched, rather than being opened up to let the menu escape.
 *
 * Placement reuses `lib/popoverPosition`, the same collision logic behind the
 * account, entity, project and cost-centre pickers: open downward, flip up when
 * the space below is cramped, clamp inside the viewport, bound the height.
 */
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
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** True when this open came from the keyboard, so focus should enter the menu. */
  const viaKeyboard = useRef(false);

  /** Recompute the portal panel position from the trigger + viewport. */
  const reposition = useCallback((): void => {
    const el = buttonRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    /*
     * Measure what the panel actually wants to be, so a long item like
     * "View customer statement" is not forced to wrap at an assumed width. On the
     * very first pass the panel is mounted but hidden, and the floor is used; the
     * layout effect below then re-runs with the real measurement, still before
     * the browser paints.
     */
    const natural = panelRef.current?.scrollWidth ?? 0;
    setPosition(
      computePopoverPosition(
        { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height },
        { width: window.innerWidth, height: window.innerHeight },
        {
          align,
          minWidth: Math.max(MIN_MENU_WIDTH, Math.min(natural, MAX_MENU_WIDTH)),
          maxWidth: MAX_MENU_WIDTH,
          // A menu is short; it should flip up long before a tall picker would.
          preferredMinHeight: 120,
        },
      ),
    );
  }, [align]);

  // Position before paint (avoids a flash), then keep it synced while
  // scrolling/resizing. capture:true so ancestor scroll containers — the table's
  // own horizontal scroller included — also trigger it.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    reposition();
    const onScroll = (): void => reposition();
    const onResize = (): void => reposition();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, reposition]);

  /** The enabled items, in visual order — what the arrow keys walk. */
  const items = (): HTMLElement[] =>
    Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []).filter(
      (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true',
    );

  const close = useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  // Focus the first item only for a KEYBOARD open. A mouse user keeps their
  // pointer flow and sees no focus ring appear on its own.
  useEffect(() => {
    if (!open || !viaKeyboard.current) return;
    items()[0]?.focus();
    viaKeyboard.current = false;
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      // The panel is portaled, so it is NOT inside `ref` any more — both roots
      // have to be consulted or every click on the menu would dismiss it.
      if (ref.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(true);
        return;
      }
      // Tab moves on rather than being trapped: the menu simply closes.
      if (e.key === 'Tab') {
        setOpen(false);
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
      const list = items();
      if (list.length === 0) return;
      e.preventDefault();
      const current = list.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? list.length - 1
            : e.key === 'ArrowDown'
              ? (current + 1) % list.length
              : (current - 1 + list.length) % list.length;
      list[next]?.focus();
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  const panel = (
    <div
      ref={panelRef}
      role="menu"
      data-testid="dropdown-menu"
      data-placement={position?.placement}
      onClick={closeOnClick ? () => close(false) : undefined}
      style={
        position
          ? {
              position: 'fixed',
              top: position.top,
              bottom: position.bottom,
              left: position.left,
              minWidth: position.width,
              maxWidth: MAX_MENU_WIDTH,
              maxHeight: position.maxHeight,
            }
          : // First pass: mounted so it can be measured, not yet shown.
            { position: 'fixed', top: 0, left: 0, visibility: 'hidden' }
      }
      className={cn(
        'z-[1000] animate-scale-in overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-dropdown dark:border-slate-700 dark:bg-slate-900',
        align === 'right' ? 'origin-top-right' : 'origin-top-left',
        panelClassName,
      )}
    >
      {children}
    </div>
  );

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            viaKeyboard.current = true;
          }
        }}
        className="focus-ring rounded-lg"
      >
        {trigger(open)}
      </button>
      {open && typeof document !== 'undefined' && createPortal(panel, document.body)}
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
  /**
   * Native tooltip. Its reason for existing is a DISABLED item: a control that
   * refuses has to be able to say why on the control itself, and a pointer user
   * expects a tooltip to answer that.
   */
  title?: string;
}

export function MenuItem({ icon: Icon, children, onClick, danger, disabled, shortcut, title }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cn(
        // `items-start`, not `items-center`: an item may carry a second line
        // (a disabled reason), and centring would float the icon against it.
        'focus-ring flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        danger
          ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10'
          : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
      )}
    >
      {Icon && <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />}
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

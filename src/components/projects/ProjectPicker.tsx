import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X, Search, Plus } from 'lucide-react';
import type { Project } from '@/types/project';
import { isProjectActiveOnDate } from '@/lib/projectValidation';
import { computePopoverPosition, type PopoverPosition } from '@/lib/popoverPosition';
import { canCreateProject } from '@/store/projectStore';
import { QuickProjectDialog } from '@/components/projects/QuickProjectDialog';
import { cn as cx } from '@/lib/utils';

interface Props {
  value: string;
  onChange: (projectId: string) => void;
  projects: Project[];
  postingDate?: string;
  includeInactive?: boolean;
  disabled?: boolean;
  allowClear?: boolean;
  /** Label for the "nothing selected" row and the trigger placeholder. */
  placeholder?: string;
  /**
   * Offer inline project creation. On by default; the ROLE still decides
   * whether the action appears, and `projectStore.createProject` re-checks the
   * permission on the write regardless of what this component renders.
   */
  allowCreate?: boolean;
}

/**
 * Reusable project picker: searchable, portalled, collision-aware, keyboard nav.
 *
 * The panel is rendered on `document.body` and positioned with the shared
 * {@link computePopoverPosition}, so it is never clipped by a drawer's or a
 * table's scroll container and flips above when the space below is short. The
 * create action is a `shrink-0` footer OUTSIDE the scrolling list, because in a
 * capped-height panel a footer inside the list is the first thing to become
 * unreachable — and it is most needed when the list is long or empty.
 */
export function ProjectPicker({
  value,
  onChange,
  projects,
  postingDate,
  includeInactive,
  disabled,
  allowClear = true,
  placeholder = 'No project',
  allowCreate = true,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [creating, setCreating] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  const mayCreate = allowCreate && canCreateProject();

  const selectable = (p: Project): boolean =>
    includeInactive ? true : isProjectActiveOnDate(p, postingDate ?? new Date().toISOString().slice(0, 10));
  const ordered = useMemo(() => [...projects].sort((a, b) => a.code.localeCompare(b.code)), [projects]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ordered.filter((p) => (q ? `${p.code} ${p.name}`.toLowerCase().includes(q) : true));
  }, [ordered, query]);
  const selected = projects.find((p) => p.id === value);

  const reposition = (): void => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPosition(
      computePopoverPosition(
        { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height },
        { width: window.innerWidth, height: window.innerHeight },
        { minWidth: 320, maxWidth: 420 },
      ),
    );
  };

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onScroll = (): void => reposition();
    const onResize = (): void => reposition();
    // capture:true so ancestor scroll containers reposition the panel too.
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    // `preventScroll`: the search box is in a fixed portal; scrolling it into
    // view would jerk the document behind it.
    if (open && !creating) inputRef.current?.focus({ preventScroll: true });
  }, [open, creating]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      // While the create dialog is up it owns the outside click.
      if (creating) return;
      if (triggerRef.current?.contains(e.target as Node) || panelRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, creating]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [highlight, open, filtered.length]);

  const closeAndFocusTrigger = (): void => {
    setOpen(false);
    window.setTimeout(() => triggerRef.current?.focus({ preventScroll: true }), 0);
  };

  const pick = (p: Project | null): void => {
    if (p && !selectable(p)) return;
    onChange(p?.id ?? '');
    setQuery('');
    closeAndFocusTrigger();
  };

  /**
   * Close the picker BEFORE the dialog opens.
   *
   * The panel is portalled onto `document.body`, so leaving it mounted puts a
   * live dropdown in the document while a modal is up — stacking over it,
   * intercepting clicks and holding focus on a search box the user can no
   * longer see. Unmounting it is the fix; z-index alone would only hide it.
   *
   * `query` survives, because the dialog seeds its Name field from it.
   */
  const openCreate = (): void => {
    setOpen(false);
    setHighlight(0);
    setCreating(true);
  };

  /** The new project is selected on THIS picker's line and nowhere else. */
  const handleCreated = (project: Project): void => {
    setCreating(false);
    pick(project);
  };

  const CONSUMED = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Escape']);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    /*
     * A key this picker acts on must not also reach the surface behind it: the
     * host drawers listen for Escape on `window` to close themselves, so an
     * un-stopped Escape would dismiss the whole voucher instead of the dropdown.
     */
    if (CONSUMED.has(e.key)) e.stopPropagation();

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const p = filtered[highlight];
      if (p) pick(p);
      else if (mayCreate && query.trim()) openCreate();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeAndFocusTrigger();
    }
  };

  return (
    <>
      <div className="relative flex items-center gap-1">
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          onClick={() => setOpen((o) => !o)}
          className={cx(
            'focus-ring flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2.5 text-left text-sm dark:border-slate-700 dark:bg-slate-900',
            disabled && 'cursor-not-allowed opacity-60',
          )}
          // The full code + name when the cell is too narrow to show it all.
          title={selected ? `${selected.code} · ${selected.name}` : undefined}
        >
          <span className={cx('truncate', !selected && 'text-slate-400')}>
            {selected ? `${selected.code} · ${selected.name}` : placeholder}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
        </button>
        {allowClear && value && !disabled && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Clear"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {open &&
        position &&
        createPortal(
          <div
            ref={panelRef}
            data-testid="project-picker-panel"
            data-placement={position.placement}
            className="z-[1000] flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
            style={{
              position: 'fixed',
              left: position.left,
              top: position.top,
              bottom: position.bottom,
              width: position.width,
              maxHeight: position.maxHeight,
            }}
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-2 py-1.5 dark:border-slate-800">
              <Search className="h-4 w-4 text-slate-400" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHighlight(0);
                }}
                onKeyDown={onKeyDown}
                placeholder="Search code or name…"
                aria-controls={listboxId}
                aria-autocomplete="list"
                className="w-full bg-transparent text-sm outline-none"
              />
            </div>

            <ul ref={listRef} id={listboxId} role="listbox" className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
              <li>
                <button
                  type="button"
                  onClick={() => pick(null)}
                  className="flex w-full items-center px-3 py-2 text-left text-sm text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800/60"
                >
                  {placeholder}
                </button>
              </li>

              {filtered.length === 0 && (
                <li className="px-3 py-5 text-center">
                  <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                    {query.trim() ? <>No projects match “{query}”.</> : 'No projects found'}
                  </p>
                  {mayCreate && (
                    <button
                      type="button"
                      onClick={openCreate}
                      className="focus-ring mt-2 inline-flex items-center gap-1.5 rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-100 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {query.trim() ? <>Add “{query.trim()}” as a new project</> : 'Add new project'}
                    </button>
                  )}
                </li>
              )}

              {filtered.map((p, idx) => {
                const ok = selectable(p);
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      role="option"
                      data-index={idx}
                      aria-selected={p.id === value}
                      onMouseEnter={() => setHighlight(idx)}
                      onClick={() => pick(p)}
                      title={`${p.code} · ${p.name}`}
                      className={cx(
                        'flex w-full items-center justify-between px-2 py-1.5 text-left text-sm',
                        idx === highlight && 'bg-brand-50 dark:bg-brand-500/10',
                        !ok && 'cursor-not-allowed text-slate-400',
                        p.id === value && 'font-semibold',
                      )}
                    >
                      <span className="truncate">
                        <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{p.code}</span> · {p.name}
                      </span>
                      {p.status !== 'active' && (
                        <span className="ml-2 shrink-0 text-[10px] uppercase text-amber-500">{p.status}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>

            {mayCreate && (
              /* shrink-0, outside the scroller: always reachable. */
              <div className="shrink-0 border-t border-slate-100 p-1 dark:border-slate-800">
                <button
                  type="button"
                  onClick={openCreate}
                  className="focus-ring flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium text-brand-700 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-500/10"
                >
                  <Plus className="h-4 w-4" /> Add new project
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}

      <QuickProjectDialog
        open={creating}
        initialName={query}
        onCancel={() => {
          // Cancelling changes nothing, and does NOT reopen the dropdown. Focus
          // returns to the trigger; the search box no longer exists.
          setCreating(false);
          triggerRef.current?.focus({ preventScroll: true });
        }}
        onCreated={handleCreated}
      />
    </>
  );
}

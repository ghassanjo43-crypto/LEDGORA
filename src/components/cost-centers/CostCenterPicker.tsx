import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X, Search, Plus } from 'lucide-react';
import type { CostCenter } from '@/types/costCenter';
import { buildCostCenterTree, flattenCostCenterTree } from '@/lib/costCenterHierarchy';
import { computePopoverPosition, type PopoverPosition } from '@/lib/popoverPosition';
import { canCreateCostCenter } from '@/store/costCenterStore';
import { QuickCostCenterDialog } from '@/components/cost-centers/QuickCostCenterDialog';
import { cn as cx } from '@/lib/utils';

interface Props {
  value: string;
  onChange: (costCenterId: string) => void;
  costCenters: CostCenter[];
  /** Only posting cost centers are selectable; summary nodes are shown disabled. */
  postingDate?: string;
  includeInactive?: boolean;
  disabled?: boolean;
  hasError?: boolean;
  allowClear?: boolean;
  /** Label for the "nothing selected" row and the trigger placeholder. */
  placeholder?: string;
  /**
   * Offer inline creation. On by default; the ROLE decides whether it appears,
   * and `costCenterStore.createCostCenter` re-checks on the write regardless of
   * what this component renders.
   */
  allowCreate?: boolean;
}

/**
 * Reusable cost-center picker (§48): searchable, hierarchy-indented, portalled to
 * document.body with collision-aware positioning and internal scroll. Summary
 * (non-posting) nodes are shown but disabled; returns a stable string id.
 *
 * The create action is a `shrink-0` footer OUTSIDE the scrolling list, so a long
 * hierarchy can never scroll it out of reach.
 */
export function CostCenterPicker({
  value,
  onChange,
  costCenters,
  postingDate,
  includeInactive,
  disabled,
  hasError,
  allowClear = true,
  placeholder = 'No cost center',
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

  const mayCreate = allowCreate && canCreateCostCenter();

  const selectable = (c: CostCenter): boolean => {
    if (!c.isPostingAllowed) return false;
    if (includeInactive) return true;
    if (c.status !== 'active') return false;
    if (postingDate && (c.effectiveFrom > postingDate || (c.effectiveTo && c.effectiveTo < postingDate))) return false;
    return true;
  };

  const ordered = useMemo(() => flattenCostCenterTree(buildCostCenterTree(costCenters)), [costCenters]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ordered.filter((c) => (q ? `${c.code} ${c.name}`.toLowerCase().includes(q) : true));
  }, [ordered, query]);

  const selected = costCenters.find((c) => c.id === value);

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
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open && !creating) inputRef.current?.focus({ preventScroll: true });
  }, [open, creating]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
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

  const pick = (c: CostCenter | null): void => {
    if (c && !selectable(c)) return;
    onChange(c?.id ?? '');
    setQuery('');
    closeAndFocusTrigger();
  };

  /**
   * Close the picker BEFORE the dialog opens — see the note in `ProjectPicker`.
   * A portalled panel left mounted under a modal stacks over it, intercepts
   * clicks and keeps focus on an invisible search box.
   */
  const openCreate = (): void => {
    setOpen(false);
    setHighlight(0);
    setCreating(true);
  };

  /** The new cost center is selected on THIS picker's line and nowhere else. */
  const handleCreated = (costCenter: CostCenter): void => {
    setCreating(false);
    pick(costCenter);
  };

  const CONSUMED = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Escape']);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // See ProjectPicker: an un-stopped Escape closes the host drawer instead.
    if (CONSUMED.has(e.key)) e.stopPropagation();

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const c = filtered[highlight];
      if (c) pick(c);
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
          title={selected ? `${selected.code} · ${selected.name}` : undefined}
          className={cx(
            'focus-ring flex h-9 w-full items-center justify-between gap-2 rounded-lg border bg-white px-2.5 text-left text-sm dark:bg-slate-900',
            hasError ? 'border-red-400' : 'border-slate-200 dark:border-slate-700',
            disabled && 'cursor-not-allowed opacity-60',
          )}
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
            data-testid="cost-center-picker-panel"
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
                    {query.trim() ? <>No cost centers match “{query}”.</> : 'No cost centers found'}
                  </p>
                  {mayCreate && (
                    <button
                      type="button"
                      onClick={openCreate}
                      className="focus-ring mt-2 inline-flex items-center gap-1.5 rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-100 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {query.trim() ? <>Add “{query.trim()}” as a new cost center</> : 'Add new cost center'}
                    </button>
                  )}
                </li>
              )}

              {filtered.map((c, idx) => {
                const ok = selectable(c);
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      role="option"
                      data-index={idx}
                      aria-selected={c.id === value}
                      onMouseEnter={() => setHighlight(idx)}
                      onClick={() => pick(c)}
                      title={`${c.code} · ${c.name}`}
                      className={cx(
                        'flex w-full items-center justify-between px-2 py-1.5 text-left text-sm',
                        idx === highlight && 'bg-brand-50 dark:bg-brand-500/10',
                        !ok && 'cursor-not-allowed text-slate-400',
                        c.id === value && 'font-semibold',
                      )}
                    >
                      <span style={{ paddingLeft: c.level * 14 }} className="truncate">
                        <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{c.code}</span> · {c.name}
                      </span>
                      {!c.isPostingAllowed && <span className="ml-2 shrink-0 text-[10px] uppercase text-slate-400">summary</span>}
                      {c.status !== 'active' && <span className="ml-2 shrink-0 text-[10px] uppercase text-amber-500">{c.status}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>

            {mayCreate && (
              <div className="shrink-0 border-t border-slate-100 p-1 dark:border-slate-800">
                <button
                  type="button"
                  onClick={openCreate}
                  className="focus-ring flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium text-brand-700 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-500/10"
                >
                  <Plus className="h-4 w-4" /> Add new cost center
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}

      <QuickCostCenterDialog
        open={creating}
        initialName={query}
        onCancel={() => {
          // Does NOT reopen the dropdown; focus returns to the trigger.
          setCreating(false);
          triggerRef.current?.focus({ preventScroll: true });
        }}
        onCreated={handleCreated}
      />
    </>
  );
}

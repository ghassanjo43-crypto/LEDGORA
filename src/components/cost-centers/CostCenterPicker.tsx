import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X, Search } from 'lucide-react';
import type { CostCenter } from '@/types/costCenter';
import { buildCostCenterTree, flattenCostCenterTree } from '@/lib/costCenterHierarchy';
import { computePopoverPosition, type PopoverPosition } from '@/lib/popoverPosition';
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
}

/**
 * Reusable cost-center picker (§48): searchable, hierarchy-indented, portalled to
 * document.body with collision-aware positioning and internal scroll. Summary
 * (non-posting) nodes are shown but disabled; returns a stable string id.
 */
export function CostCenterPicker({ value, onChange, costCenters, postingDate, includeInactive, disabled, hasError, allowClear = true }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

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

  useLayoutEffect(() => {
    if (!open) return;
    const reposition = (): void => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPosition(computePopoverPosition({ top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height }, { width: window.innerWidth, height: window.innerHeight }, { maxWidth: 420 }));
    };
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => { window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition); };
  }, [open]);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (triggerRef.current?.contains(e.target as Node) || panelRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const pick = (c: CostCenter): void => { if (!selectable(c)) return; onChange(c.id); setOpen(false); setQuery(''); };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = filtered[highlight]; if (c) pick(c); }
    else if (e.key === 'Escape') setOpen(false);
  };

  return (
    <>
      <div className="relative flex items-center gap-1">
        <button ref={triggerRef} type="button" disabled={disabled} onClick={() => setOpen((o) => !o)}
          className={cx('flex h-9 w-full items-center justify-between gap-2 rounded-lg border bg-white px-2.5 text-left text-sm dark:bg-slate-900', hasError ? 'border-red-400' : 'border-slate-200 dark:border-slate-700', disabled && 'cursor-not-allowed opacity-60')}>
          <span className={cx('truncate', !selected && 'text-slate-400')}>{selected ? `${selected.code} · ${selected.name}` : 'Select cost center'}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
        </button>
        {allowClear && value && !disabled && <button type="button" onClick={() => onChange('')} className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Clear"><X className="h-4 w-4" /></button>}
      </div>

      {open && position && createPortal(
        <div ref={panelRef} role="listbox" id={listboxId} className="z-[1000] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
          style={{ position: 'fixed', left: position.left, top: position.top, bottom: position.bottom, width: position.width, maxHeight: position.maxHeight }}>
          <div className="flex items-center gap-2 border-b border-slate-100 px-2 py-1.5 dark:border-slate-800">
            <Search className="h-4 w-4 text-slate-400" />
            <input ref={inputRef} value={query} onChange={(e) => { setQuery(e.target.value); setHighlight(0); }} onKeyDown={onKeyDown} placeholder="Search code or name…" className="w-full bg-transparent text-sm outline-none" />
          </div>
          <ul className="overflow-y-auto py-1" style={{ maxHeight: (position.maxHeight ?? 320) - 44 }}>
            {filtered.length === 0 ? (
              <li className="px-3 py-4 text-center text-xs text-slate-400">No cost centers found.</li>
            ) : filtered.map((c, idx) => {
              const ok = selectable(c);
              return (
                <li key={c.id} role="option" aria-selected={c.id === value} onMouseEnter={() => setHighlight(idx)} onClick={() => pick(c)}
                  className={cx('flex cursor-pointer items-center justify-between px-2 py-1.5 text-sm', idx === highlight && 'bg-slate-100 dark:bg-slate-800', !ok && 'cursor-not-allowed text-slate-400', c.id === value && 'font-semibold')}>
                  <span style={{ paddingLeft: c.level * 14 }} className="truncate"><span className="font-mono text-xs">{c.code}</span> · {c.name}</span>
                  {!c.isPostingAllowed && <span className="ml-2 shrink-0 text-[10px] uppercase text-slate-400">summary</span>}
                  {c.status !== 'active' && <span className="ml-2 shrink-0 text-[10px] uppercase text-amber-500">{c.status}</span>}
                </li>
              );
            })}
          </ul>
        </div>,
        document.body,
      )}
    </>
  );
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X, Search } from 'lucide-react';
import type { Project } from '@/types/project';
import { isProjectActiveOnDate } from '@/lib/projectValidation';
import { computePopoverPosition, type PopoverPosition } from '@/lib/popoverPosition';
import { cn as cx } from '@/lib/utils';

interface Props {
  value: string;
  onChange: (projectId: string) => void;
  projects: Project[];
  postingDate?: string;
  includeInactive?: boolean;
  disabled?: boolean;
  allowClear?: boolean;
}

/** Reusable project picker: searchable, portalled, collision-aware, keyboard nav. */
export function ProjectPicker({ value, onChange, projects, postingDate, includeInactive, disabled, allowClear = true }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectable = (p: Project): boolean => (includeInactive ? true : isProjectActiveOnDate(p, postingDate ?? new Date().toISOString().slice(0, 10)));
  const ordered = useMemo(() => [...projects].sort((a, b) => a.code.localeCompare(b.code)), [projects]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ordered.filter((p) => (q ? `${p.code} ${p.name}`.toLowerCase().includes(q) : true));
  }, [ordered, query]);
  const selected = projects.find((p) => p.id === value);

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

  const pick = (p: Project): void => { if (!selectable(p)) return; onChange(p.id); setOpen(false); setQuery(''); };
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const p = filtered[highlight]; if (p) pick(p); }
    else if (e.key === 'Escape') setOpen(false);
  };

  return (
    <>
      <div className="relative flex items-center gap-1">
        <button ref={triggerRef} type="button" disabled={disabled} onClick={() => setOpen((o) => !o)}
          className={cx('flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2.5 text-left text-sm dark:border-slate-700 dark:bg-slate-900', disabled && 'cursor-not-allowed opacity-60')}>
          <span className={cx('truncate', !selected && 'text-slate-400')}>{selected ? `${selected.code} · ${selected.name}` : 'Select project'}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
        </button>
        {allowClear && value && !disabled && <button type="button" onClick={() => onChange('')} className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Clear"><X className="h-4 w-4" /></button>}
      </div>

      {open && position && createPortal(
        <div ref={panelRef} role="listbox" className="z-[1000] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
          style={{ position: 'fixed', left: position.left, top: position.top, bottom: position.bottom, width: position.width, maxHeight: position.maxHeight }}>
          <div className="flex items-center gap-2 border-b border-slate-100 px-2 py-1.5 dark:border-slate-800">
            <Search className="h-4 w-4 text-slate-400" />
            <input ref={inputRef} value={query} onChange={(e) => { setQuery(e.target.value); setHighlight(0); }} onKeyDown={onKeyDown} placeholder="Search code or name…" className="w-full bg-transparent text-sm outline-none" />
          </div>
          <ul className="overflow-y-auto py-1" style={{ maxHeight: (position.maxHeight ?? 320) - 44 }}>
            {filtered.length === 0 ? (
              <li className="px-3 py-4 text-center text-xs text-slate-400">No projects found.</li>
            ) : filtered.map((p, idx) => {
              const ok = selectable(p);
              return (
                <li key={p.id} role="option" aria-selected={p.id === value} onMouseEnter={() => setHighlight(idx)} onClick={() => pick(p)}
                  className={cx('flex cursor-pointer items-center justify-between px-2 py-1.5 text-sm', idx === highlight && 'bg-slate-100 dark:bg-slate-800', !ok && 'cursor-not-allowed text-slate-400', p.id === value && 'font-semibold')}>
                  <span className="truncate"><span className="font-mono text-xs">{p.code}</span> · {p.name}</span>
                  {p.status !== 'active' && <span className="ml-2 shrink-0 text-[10px] uppercase text-amber-500">{p.status}</span>}
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

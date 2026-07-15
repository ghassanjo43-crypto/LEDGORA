import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, MapPin } from 'lucide-react';
import type { BusinessEntity } from '@/types';
import { cn } from '@/lib/utils';
import { EntityTypeBadge } from '@/components/entities/EntityBadges';

interface EntityPickerProps {
  /** Selected entity id ('' when none). */
  value: string;
  /** Fires with the full entity, or null when cleared. */
  onChange: (entity: BusinessEntity | null) => void;
  entities: BusinessEntity[];
  hasError?: boolean;
  disabled?: boolean;
  id?: string;
  /** Placeholder / clear label. */
  placeholder?: string;
}

/**
 * Searchable customer/supplier picker. Shows company name, role badge, country
 * and entity code; searches by company, code, contact and email. Mirrors
 * {@link AccountSelect} so the two pickers feel identical.
 */
export function EntityPicker({
  value,
  onChange,
  entities,
  hasError,
  disabled,
  id,
  placeholder = 'No entity',
}: EntityPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sorted = useMemo(
    () => entities.slice().sort((a, b) => a.legalName.localeCompare(b.legalName)),
    [entities],
  );
  const selected = useMemo(() => entities.find((e) => e.id === value), [entities, value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((e) =>
      `${e.legalName} ${e.tradingName} ${e.entityCode} ${e.contactPerson} ${e.email} ${e.country}`
        .toLowerCase()
        .includes(q),
    );
  }, [sorted, query]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setHighlight(0);
      const t = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [open]);

  const choose = (entity: BusinessEntity | null): void => {
    onChange(entity);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') setOpen(false);
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = filtered[highlight];
      if (pick) choose(pick);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        id={id}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'focus-ring flex h-9 w-full items-center justify-between gap-2 rounded-lg border bg-white px-2.5 text-left text-sm text-slate-900 transition-colors disabled:cursor-not-allowed disabled:opacity-60 dark:bg-slate-900 dark:text-slate-100',
          hasError
            ? 'border-red-400 focus-visible:ring-red-500 dark:border-red-500'
            : 'border-slate-300 dark:border-slate-700',
        )}
      >
        <span className="min-w-0 truncate">
          {selected ? (
            <span className="truncate">{selected.legalName}</span>
          ) : (
            <span className="text-slate-400">{placeholder}</span>
          )}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-[min(26rem,90vw)] rounded-lg border border-slate-200 bg-white shadow-dropdown dark:border-slate-700 dark:bg-slate-900">
          <div className="border-b border-slate-100 p-2 dark:border-slate-800">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHighlight(0);
                }}
                onKeyDown={onKeyDown}
                placeholder="Search company, code, contact, email…"
                className="focus-ring w-full rounded-md border border-slate-200 bg-white py-1.5 pl-8 pr-2 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
            </div>
          </div>
          <ul className="max-h-64 overflow-y-auto py-1" role="listbox">
            <li>
              <button
                type="button"
                onClick={() => choose(null)}
                className="flex w-full items-center px-3 py-2 text-left text-sm text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800/60"
              >
                {placeholder}
              </button>
            </li>
            {filtered.length === 0 && (
              <li className="px-3 py-6 text-center text-xs text-slate-400">
                No entities match “{query}”.
              </li>
            )}
            {filtered.map((entity, idx) => (
              <li key={entity.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={entity.id === value}
                  onMouseEnter={() => setHighlight(idx)}
                  onClick={() => choose(entity)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
                    idx === highlight ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60',
                    entity.id === value && 'ring-1 ring-inset ring-brand-300 dark:ring-brand-500/40',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className={cn('truncate text-sm font-medium text-slate-800 dark:text-slate-100', !entity.isActive && 'text-slate-400 line-through')}>
                        {entity.legalName}
                      </span>
                      <EntityTypeBadge type={entity.entityType} />
                    </span>
                    <span className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-400">
                      <span className="font-mono">{entity.entityCode}</span>
                      {entity.country && (
                        <span className="flex items-center gap-0.5">
                          <MapPin className="h-3 w-3" /> {entity.country}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

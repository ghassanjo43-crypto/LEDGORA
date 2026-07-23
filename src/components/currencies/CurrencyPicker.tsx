import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import type { Currency } from '@/types/currency';
import { currencyTypeOf, monetaryDecimalsOf } from '@/types/currency';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/Badge';

interface Props {
  value: string;
  onChange: (code: string) => void;
  currencies: Currency[];
  /** Only offer these codes (e.g. an entity's enabled set). */
  allowed?: string[];
  /** Inactive currencies stay searchable/readable but are NOT selectable unless set. */
  includeInactive?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
}

/**
 * Reusable searchable Currency Picker — the single selection control for every
 * currency choice (documents, accounts, settings). Shows code, name, symbol,
 * decimal places, active status and a standard/custom badge. Only ACTIVE
 * currencies are selectable for new transactions; historical inactive
 * currencies remain visible where `includeInactive` is set (read contexts).
 */
export function CurrencyPicker({ value, onChange, currencies, allowed, includeInactive, disabled, placeholder = 'Select currency…', className, ...rest }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    return currencies
      .filter((c) => (includeInactive ? c.status !== 'archived' : c.status === 'active'))
      .filter((c) => (allowed ? allowed.includes(c.code) || c.code === value : true))
      .filter((c) =>
        !q ||
        c.code.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q) ||
        (c.localizedName ?? '').toLowerCase().includes(q) ||
        c.symbol.toLowerCase().includes(q),
      )
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [currencies, allowed, includeInactive, query, value]);

  const selected = currencies.find((c) => c.code === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setQuery('');
  }, [open]);

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        disabled={disabled}
        aria-label={rest['aria-label'] ?? 'Currency'}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'focus-ring flex w-full items-center justify-between gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 transition-colors disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100',
        )}
      >
        {selected ? (
          <span className="flex items-center gap-2 truncate">
            <span className="font-mono text-xs font-semibold">{selected.code}</span>
            <span className="truncate text-slate-500 dark:text-slate-400">{selected.name}</span>
            {selected.status !== 'active' && <Badge tone="slate">{selected.status}</Badge>}
          </span>
        ) : (
          <span className="text-slate-400">{placeholder}</span>
        )}
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full min-w-[18rem] rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
            <Search className="h-4 w-4 text-slate-400" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search code, name or symbol…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400"
              aria-label="Search currencies"
            />
          </div>
          <ul className="max-h-64 overflow-y-auto py-1" role="listbox">
            {options.length === 0 && <li className="px-3 py-2 text-sm text-slate-400">No matching currencies.</li>}
            {options.map((c) => {
              const isSelected = c.code === value;
              const selectable = c.status === 'active' || includeInactive;
              return (
                <li key={c.id} role="option" aria-selected={isSelected}>
                  <button
                    type="button"
                    disabled={!selectable}
                    onClick={() => { onChange(c.code); setOpen(false); }}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-slate-800/60',
                      isSelected && 'bg-slate-50 dark:bg-slate-800/40',
                    )}
                  >
                    <span className="w-14 shrink-0 font-mono text-xs font-semibold">{c.code}</span>
                    <span className="flex-1 truncate">{c.localizedName ?? c.name}</span>
                    <span className="shrink-0 text-xs text-slate-400">{c.symbol}</span>
                    <span className="shrink-0 rounded bg-slate-100 px-1 font-mono text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400" title="Monetary decimal places">{monetaryDecimalsOf(c)}dp</span>
                    <Badge tone={c.isIso ? 'blue' : 'violet'}>{c.isIso ? 'standard' : currencyTypeOf(c) === 'fiat' ? 'custom' : currencyTypeOf(c)}</Badge>
                    {c.status !== 'active' && <Badge tone="slate">{c.status}</Badge>}
                    {isSelected && <Check className="h-4 w-4 shrink-0 text-teal-600" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

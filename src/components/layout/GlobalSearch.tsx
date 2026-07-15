import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  CornerDownLeft,
  ListTree,
  BookOpenText,
  Building2,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ViewKey } from '@/types';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useJournalStore } from '@/store/journalStore';
import { ALL_NAV_ITEMS, canAccessView } from '@/config/navigation';
import { useEffectiveModules } from '@/store/entitlementHooks';
import { cn } from '@/lib/utils';

interface Result {
  id: string;
  title: string;
  subtitle: string;
  view: ViewKey;
  icon: LucideIcon;
  group: string;
}

export function GlobalSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const setActiveView = useStore((s) => s.setActiveView);
  const entities = useEntityStore((s) => s.entities);
  const entries = useJournalStore((s) => s.entries);
  const moduleIds = useEffectiveModules();

  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setHighlight(0);
      const t = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [open]);

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    const out: Result[] = [];

    // Pages / modules — never surface a view the organization does not own.
    for (const item of ALL_NAV_ITEMS) {
      if (!canAccessView(moduleIds, item.key)) continue;
      if (!q || item.label.toLowerCase().includes(q)) {
        out.push({
          id: `nav-${item.key}`,
          title: item.label,
          subtitle: item.comingSoon ? 'Module · coming soon' : 'Go to module',
          view: item.key,
          icon: item.icon,
          group: 'Navigate',
        });
      }
    }
    if (!q) return out.slice(0, 8);

    for (const a of accounts) {
      if (
        a.code.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q) ||
        a.ifrsCategory.toLowerCase().includes(q)
      ) {
        out.push({
          id: `acc-${a.id}`,
          title: `${a.code} — ${a.name}`,
          subtitle: `Account · ${a.ifrsCategory || 'Chart of Accounts'}`,
          view: 'tree',
          icon: ListTree,
          group: 'Accounts',
        });
      }
      if (out.length > 60) break;
    }

    for (const e of entities) {
      if (
        e.legalName.toLowerCase().includes(q) ||
        e.entityCode.toLowerCase().includes(q) ||
        e.email.toLowerCase().includes(q)
      ) {
        out.push({
          id: `ent-${e.id}`,
          title: e.legalName,
          subtitle: `${e.entityCode} · ${e.entityType}`,
          view: e.entityType === 'supplier' ? 'suppliers' : 'customers',
          icon: Building2,
          group: 'Entities',
        });
      }
    }

    for (const j of entries) {
      if (
        j.entryNumber.toLowerCase().includes(q) ||
        j.reference.toLowerCase().includes(q) ||
        j.description.toLowerCase().includes(q)
      ) {
        out.push({
          id: `je-${j.id}`,
          title: `${j.entryNumber} — ${j.description}`,
          subtitle: `Journal · ${j.reference || j.status}`,
          view: 'journal',
          icon: BookOpenText,
          group: 'Journal',
        });
      }
    }

    return out.slice(0, 40);
  }, [query, accounts, entities, entries, moduleIds]);

  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, results.length - 1)));
  }, [results.length]);

  if (!open) return null;

  const choose = (r: Result): void => {
    setActiveView(r.view);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = results[highlight];
      if (pick) choose(pick);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center p-4 pt-[12vh]" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-fade-in" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-xl animate-scale-in overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-dropdown dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center gap-3 border-b border-slate-100 px-4 dark:border-slate-800">
          <Search className="h-5 w-5 text-slate-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search accounts, entities, journal entries, modules…"
            className="w-full bg-transparent py-3.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-slate-100"
          />
          <kbd className="hidden rounded border border-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-400 dark:border-slate-700 sm:block">
            ESC
          </kbd>
        </div>

        <div className="max-h-[52vh] overflow-y-auto p-2">
          {results.length === 0 ? (
            <p className="px-3 py-10 text-center text-sm text-slate-400">
              No matches for “{query}”.
            </p>
          ) : (
            results.map((r, idx) => {
              const Icon = r.icon;
              const showGroup = idx === 0 || results[idx - 1]?.group !== r.group;
              return (
                <div key={r.id}>
                  {showGroup && (
                    <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      {r.group}
                    </p>
                  )}
                  <button
                    type="button"
                    onMouseEnter={() => setHighlight(idx)}
                    onClick={() => choose(r)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors',
                      idx === highlight ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60',
                    )}
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                        {r.title}
                      </span>
                      <span className="block truncate text-xs text-slate-400">{r.subtitle}</span>
                    </span>
                    {idx === highlight && <CornerDownLeft className="h-4 w-4 shrink-0 text-slate-300" />}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400 dark:border-slate-800">
          <span className="flex items-center gap-1"><ArrowUp className="h-3 w-3" /><ArrowDown className="h-3 w-3" /> navigate</span>
          <span className="flex items-center gap-1"><CornerDownLeft className="h-3 w-3" /> open</span>
        </div>
      </div>
    </div>
  );
}

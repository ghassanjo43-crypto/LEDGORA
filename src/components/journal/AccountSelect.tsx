import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Account } from '@/types';
import { accountTypeLabel } from '@/data/ifrsOptions';
import { isPostingAccount } from '@/lib/journalValidation';
import { computePopoverPosition, type PopoverPosition } from '@/lib/popoverPosition';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/ui/icons';
import { AccountDot } from '@/components/shared/AccountChip';

interface AccountSelectProps {
  /** Selected account id ('' when nothing chosen). */
  value: string;
  /** Fires with the full account object so callers can snapshot code/name/type. */
  onChange: (account: Account) => void;
  /** The full chart of accounts (filtered internally to selectable accounts). */
  accounts: Account[];
  hasError?: boolean;
  disabled?: boolean;
  id?: string;
}

/**
 * Searchable Chart-of-Accounts dropdown. Only ACTIVE POSTING accounts are
 * selectable (header and inactive accounts are excluded, via the shared
 * {@link isPostingAccount} helper so the picker can never offer an account the
 * posting validator would reject).
 *
 * The results panel is rendered in a PORTAL on document.body so it is never
 * clipped by the drawer's scroll container or hidden behind the sticky footer.
 * It is collision-aware: it opens below the field when there is room and flips
 * above when there isn't (e.g. a credit line near the bottom of the drawer),
 * always staying inside the viewport with its own internal scroll.
 */
export function AccountSelect({
  value,
  onChange,
  accounts,
  hasError,
  disabled,
  id,
}: AccountSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [position, setPosition] = useState<PopoverPosition | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  const selectable = useMemo(
    () =>
      accounts
        .filter((a) => isPostingAccount(a) && a.isActive)
        .sort((a, b) => a.code.localeCompare(b.code)),
    [accounts],
  );

  const selected = useMemo(() => accounts.find((a) => a.id === value), [accounts, value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return selectable;
    return selectable.filter((a) => {
      const hay = `${a.code} ${a.name} ${accountTypeLabel(a.type)} ${a.ifrsCategory}`.toLowerCase();
      return hay.includes(q);
    });
  }, [selectable, query]);

  /** Recompute the portal panel position from the trigger + viewport. */
  const reposition = (): void => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPosition(
      computePopoverPosition(
        { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height },
        { width: window.innerWidth, height: window.innerHeight },
        { maxWidth: 480 },
      ),
    );
  };

  // Position before paint (avoids a flash), then keep it synced while scrolling/resizing.
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onScroll = (): void => reposition();
    const onResize = (): void => reposition();
    // capture:true so ancestor scroll containers (the drawer body) also trigger it.
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Close on outside click (accounting for the portaled panel), focus the search box,
  // and reset the transient query/highlight when opening.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    // Highlight the currently-selected account, if any, else the first result.
    const selIdx = selectable.findIndex((a) => a.id === value);
    setHighlight(selIdx >= 0 ? selIdx : 0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    const onPointerDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('mousedown', onPointerDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the highlighted option scrolled into view within the list.
  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [highlight, open, filtered.length]);

  const closeAndFocusTrigger = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const choose = (account: Account): void => {
    onChange(account);
    closeAndFocusTrigger();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAndFocusTrigger();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 8, filtered.length - 1));
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 8, 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setHighlight(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setHighlight(filtered.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = filtered[highlight];
      if (pick) choose(pick);
    }
  };

  const showInactiveSnapshot = value && !selected;

  return (
    <div className="relative">
      <button
        type="button"
        id={id}
        ref={triggerRef}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'focus-ring flex w-full items-center justify-between gap-2 rounded-lg border bg-white px-2.5 py-1.5 text-left text-sm text-slate-900 transition-colors disabled:cursor-not-allowed disabled:opacity-60 dark:bg-slate-900 dark:text-slate-100',
          hasError
            ? 'border-red-400 focus-visible:ring-red-500 dark:border-red-500'
            : 'border-slate-300 dark:border-slate-700',
        )}
      >
        <span className="min-w-0 truncate">
          {selected ? (
            <span className="flex items-center gap-1.5">
              <AccountDot type={selected.type} />
              <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{selected.code}</span>
              <span className="truncate">{selected.name}</span>
            </span>
          ) : showInactiveSnapshot ? (
            <span className="text-slate-400">Account unavailable — reselect</span>
          ) : (
            <span className="text-slate-400">Select account…</span>
          )}
        </span>
        <Icon.ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
      </button>

      {open && position &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: 'fixed',
              top: position.top,
              bottom: position.bottom,
              left: position.left,
              width: position.width,
              maxHeight: position.maxHeight,
            }}
            className="z-[1000] flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
          >
            <div className="shrink-0 border-b border-slate-100 p-2 dark:border-slate-800">
              <div className="relative">
                <Icon.Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setHighlight(0);
                  }}
                  onKeyDown={onKeyDown}
                  placeholder="Search code, name, type or IFRS category…"
                  aria-controls={listboxId}
                  aria-autocomplete="list"
                  className="focus-ring w-full rounded-md border border-slate-200 bg-white py-1.5 pl-8 pr-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </div>
            </div>
            <ul
              ref={listRef}
              id={listboxId}
              role="listbox"
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1"
            >
              {filtered.length === 0 && (
                <li className="px-3 py-6 text-center text-xs text-slate-400">
                  No active posting accounts match “{query}”.
                </li>
              )}
              {filtered.map((account, idx) => (
                <li key={account.id}>
                  <button
                    type="button"
                    role="option"
                    data-index={idx}
                    aria-selected={account.id === value}
                    onMouseEnter={() => setHighlight(idx)}
                    onClick={() => choose(account)}
                    className={cn(
                      'flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors',
                      idx === highlight ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60',
                      account.id === value && 'ring-1 ring-inset ring-brand-300 dark:ring-brand-500/40',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <AccountDot type={account.type} />
                      <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{account.code}</span>
                      <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{account.name}</span>
                    </span>
                    <span className="text-[11px] text-slate-400">
                      {accountTypeLabel(account.type)} · {account.ifrsCategory || '—'} ·{' '}
                      <span className="font-medium">
                        {account.normalBalance === 'DEBIT' ? 'Debit' : 'Credit'} balance
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  );
}

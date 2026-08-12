import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Search, MapPin, Plus } from 'lucide-react';
import type { BusinessEntity } from '@/types';
import { computePopoverPosition, type PopoverPosition } from '@/lib/popoverPosition';
import { cn } from '@/lib/utils';
import { EntityTypeBadge } from '@/components/entities/EntityBadges';
import { QuickEntityDialog } from '@/components/entities/QuickEntityDialog';
import { canCreateEntity } from '@/store/useEntityStore';

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
  /**
   * Offer inline entity creation. On by default; a caller that is genuinely
   * read-only can turn it off. The ROLE still decides whether the action is
   * actually available — see `canCreateEntity` — and the store re-checks the
   * permission on the write regardless of what this component renders.
   */
  allowCreate?: boolean;
}

/**
 * Searchable customer/supplier picker. Shows company name, role badge, country
 * and entity code; searches by company, code, contact and email.
 *
 * ── Why the panel is portalled ───────────────────────────────────────────────
 * The results panel is rendered in a PORTAL on document.body, exactly as
 * {@link AccountSelect} in the same journal row does. Positioned inside the
 * component it was a child of the entry drawer's `overflow-y-auto` body, so a
 * picker on a line near the bottom had its options clipped by that scroll
 * container: every option existed in the DOM and could be found by a test,
 * while a real user could not see or click them. Clipping is a property of the
 * ANCESTOR, so no amount of z-index or max-height on the panel fixes it — the
 * panel has to leave the container.
 *
 * Positioning uses the shared {@link computePopoverPosition}, the same
 * collision-aware helper the account and cost-center pickers use: it opens
 * below when there is room, flips above when there is not, clamps inside the
 * viewport and caps its own height so the list scrolls internally instead of
 * running off screen.
 *
 * ── Why the create action sits outside the scrolling list ────────────────────
 * "Add new entity" is a `shrink-0` footer of the flex column, not the last row
 * of the `<ul>`. In a capped-height panel a footer inside the list is the first
 * thing to be scrolled out of reach — and this action is most needed precisely
 * when the list is long enough to scroll.
 */
export function EntityPicker({
  value,
  onChange,
  entities,
  hasError,
  disabled,
  id,
  placeholder = 'No entity',
  allowCreate = true,
}: EntityPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [creating, setCreating] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  /*
   * Read once per render from the canonical resolver. A role without
   * `entity.create` is never given a create control at all — not a disabled one
   * that appears to be an option — and `useEntityStore.addEntity` refuses the
   * write independently, so hiding the button is an affordance, not the gate.
   */
  const mayCreate = allowCreate && canCreateEntity();

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

  /** Recompute the portal panel position from the trigger + viewport. */
  const reposition = (): void => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPosition(
      computePopoverPosition(
        { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height },
        { width: window.innerWidth, height: window.innerHeight },
        // The entity column is narrow; the panel needs room for a name, a role
        // badge and a country without wrapping, so it is allowed to exceed the
        // trigger width. It is still clamped inside the viewport.
        { minWidth: 320, maxWidth: 416 },
      ),
    );
  };

  // Positioned before paint (no flash), then kept in sync while anything
  // scrolls or the window resizes.
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onScroll = (): void => reposition();
    const onResize = (): void => reposition();
    // capture:true so ANCESTOR scroll containers — the entry drawer's body, the
    // journal table — reposition the panel too, instead of leaving it behind.
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      // While the create dialog is up it owns the outside-click; closing the
      // list underneath it would unmount the dialog mid-typing.
      if (creating) return;
      const target = e.target as Node;
      // The panel is portalled, so it is NOT inside the trigger's subtree —
      // both have to be checked or clicking an option closes the picker.
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open, creating]);

  // Keep the highlighted option visible inside the panel's own scroller.
  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [highlight, open, filtered.length]);

  useEffect(() => {
    // Deliberately does NOT clear while the create dialog is open: the query is
    // the name the user is about to create, and it has to survive the round trip.
    if (open && !creating) {
      setQuery('');
      setHighlight(0);
      // `preventScroll`: the search box lives in a fixed portal, and letting the
      // browser scroll it into view would jerk the journal drawer behind it.
      const t = window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [open, creating]);

  const choose = (entity: BusinessEntity | null): void => {
    onChange(entity);
    setOpen(false);
    // Focus returns to the picker's own control, so the caller's line keeps the
    // keyboard rather than dropping it to the top of the document.
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const openCreate = (): void => setCreating(true);

  /**
   * The newly created entity is selected on THIS picker's line — the line the
   * user opened the dialog from — and nothing else about the host document is
   * touched.
   */
  const handleCreated = (entity: BusinessEntity): void => {
    setCreating(false);
    choose(entity);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      window.setTimeout(() => triggerRef.current?.focus(), 0);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      /*
       * Always prevented, never allowed to bubble: this input lives inside the
       * host document's <form>, and an un-stopped Enter submits it. Enter with
       * no match and a create-capable role opens the create dialog, which is
       * the action the user is reaching for at that moment.
       */
      e.preventDefault();
      e.stopPropagation();
      const pick = filtered[highlight];
      if (pick) choose(pick);
      else if (mayCreate && query.trim()) openCreate();
    }
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        id={id}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
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

      {open &&
        position &&
        createPortal(
          <div
            ref={panelRef}
            data-testid="entity-picker-panel"
            data-placement={position.placement}
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
            {/* shrink-0: the search stays put while the list below it scrolls. */}
            <div className="shrink-0 border-b border-slate-100 p-2 dark:border-slate-800">
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
                  aria-controls={listboxId}
                  aria-autocomplete="list"
                  className="focus-ring w-full rounded-md border border-slate-200 bg-white py-1.5 pl-8 pr-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
            </div>
            {/* min-h-0 + flex-1: the list is the only part that scrolls, so the
                search above and the create action below are always reachable. */}
            <ul
              ref={listRef}
              id={listboxId}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1"
              role="listbox"
            >
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
              <li className="px-3 py-5 text-center">
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  {query.trim() ? <>No entities match “{query}”.</> : 'No entities found'}
                </p>
                {mayCreate && (
                  /*
                   * Prominent here rather than only in the footer: an empty
                   * result is the exact moment the user needs this, and making
                   * them find a separate control is what sent them out of the
                   * document in the first place.
                   */
                  <button
                    type="button"
                    onClick={openCreate}
                    className="focus-ring mt-2 inline-flex items-center gap-1.5 rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700 transition-colors hover:bg-brand-100 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {query.trim() ? <>Add “{query.trim()}” as a new entity</> : 'Add new entity'}
                  </button>
                )}
              </li>
            )}
            {filtered.map((entity, idx) => (
              <li key={entity.id}>
                <button
                  type="button"
                  role="option"
                  data-index={idx}
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

            {mayCreate && (
              /*
               * Always available, matches or not — and `shrink-0`, OUTSIDE the
               * scrolling list. Inside it, this is the first control to scroll
               * out of reach in a capped-height panel, which is exactly when a
               * long unmatched list makes it most needed.
               */
              <div className="shrink-0 border-t border-slate-100 p-1 dark:border-slate-800">
                <button
                  type="button"
                  onClick={openCreate}
                  className="focus-ring flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium text-brand-700 transition-colors hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-500/10"
                >
                  <Plus className="h-4 w-4" /> Add new entity
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}

      <QuickEntityDialog
        open={creating}
        initialName={query}
        onCancel={() => {
          // Cancelling changes nothing: not the selection, not the search, and
          // nothing in the document behind.
          setCreating(false);
          window.setTimeout(() => inputRef.current?.focus(), 0);
        }}
        onCreated={handleCreated}
      />
    </div>
  );
}

/**
 * Reactive URL state for the history-based router. Components read `path` /
 * `query` and call `navigate(target)`. Selectors return primitives or the stored
 * query object (stable per navigation) — never a freshly-built object.
 */
import { create } from 'zustand';
import { readLocation, splitTarget } from '@/lib/appRouter';

interface RouterState {
  path: string;
  query: Record<string, string>;
  /** Push a new path (optionally with `?query`) onto history. */
  navigate: (target: string, opts?: { replace?: boolean }) => void;
  /** Re-read the current browser location (used on popstate). */
  sync: () => void;
}

const initial = readLocation();

export const useRouterStore = create<RouterState>((set, get) => ({
  path: initial.path,
  query: initial.query,

  navigate: (target, opts) => {
    const next = splitTarget(target);
    // No-op if we're already exactly here (avoids redundant history entries).
    const current = get();
    const sameQuery =
      JSON.stringify(current.query) === JSON.stringify(next.query);
    if (current.path === next.path && sameQuery) return;
    if (typeof window !== 'undefined') {
      const url = target.startsWith('/') ? target : `/${target}`;
      if (opts?.replace) window.history.replaceState({}, '', url);
      else window.history.pushState({}, '', url);
    }
    set({ path: next.path, query: next.query });
  },

  sync: () => {
    const loc = readLocation();
    set({ path: loc.path, query: loc.query });
  },
}));

/** Wire browser back/forward to the store. Call once at app start. */
export function initRouter(): () => void {
  if (typeof window === 'undefined') return () => {};
  const onPop = (): void => useRouterStore.getState().sync();
  window.addEventListener('popstate', onPop);
  return () => window.removeEventListener('popstate', onPop);
}

/** Imperative navigation helper for non-component call sites. */
export function navigate(target: string, opts?: { replace?: boolean }): void {
  useRouterStore.getState().navigate(target, opts);
}

/**
 * Minimal history-based router. The app navigates by real URL paths (so the
 * specification's literal routes like `/register?plan=core` work and are
 * shareable/bookmarkable) without pulling in a routing dependency. The reactive
 * state lives in `routerStore`; these are the pure helpers.
 */

export interface Location {
  /** Pathname with no trailing slash (except root). */
  path: string;
  /** Parsed query string. */
  query: Record<string, string>;
}

function normalizePath(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  return pathname.replace(/\/+$/, '') || '/';
}

export function parseQuery(search: string): Record<string, string> {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

/** Read the current browser location (safe under SSR/tests via a guard). */
export function readLocation(): Location {
  if (typeof window === 'undefined') return { path: '/', query: {} };
  return {
    path: normalizePath(window.location.pathname),
    query: parseQuery(window.location.search),
  };
}

/** Split a `/path?a=b` string into a normalized path + query object. */
export function splitTarget(target: string): Location {
  const [rawPath, rawQuery = ''] = target.split('?');
  return { path: normalizePath(rawPath ?? '/'), query: parseQuery(rawQuery) };
}

/**
 * Workspace storage adapter for business (accounting) data.
 *
 * Every accounting/inventory/manufacturing/billing-document store persists
 * through `businessDataStorage` instead of talking to `localStorage` directly.
 *
 * ── Tenant scoping: the property this module exists to guarantee ─────────────
 * Every key written here is namespaced by the ACTIVE WORKSPACE:
 *
 *     ledgora:ws:<kind>:<organizationId>:<store-name>
 *
 * so two organizations on the same browser cannot address the same key. This was
 * not always so. The adapter previously wrote each store under its bare name —
 * `ifrs-coa-store`, `ifrs-journal-store`, `ledgerly-invoices` — with no
 * organization component at all, which meant a second subscriber signing in on a
 * browser that had held a first subscriber's books simply read them: chart of
 * accounts, journals, customers, suppliers, invoices, bills, payments, receipts,
 * the lot. Namespacing makes that unrepresentable rather than merely unlikely:
 * there is no key Organization B can ask for that returns Organization A's data.
 *
 * ── Fail closed when no workspace is active ──────────────────────────────────
 * With no active workspace the adapter serves the volatile in-memory map and
 * NEVER touches `localStorage`. That is deliberate: "we do not yet know which
 * tenant this is" must not resolve to "use the shared global key", which is
 * precisely the bug above. Nothing durable is read or written until a workspace
 * has been opened.
 *
 * ── Modes ────────────────────────────────────────────────────────────────────
 *  - `'backend'` — the durable path. Frontend-only today, so it is served by the
 *    browser-storage development adapter below. This is the ONE place a real
 *    backend persistence service replaces browser storage.
 *  - `'memory'`  — a per-tab in-memory map. Nothing reaches `localStorage`,
 *    `sessionStorage` or any server, so a Free Demo workspace evaporates on
 *    refresh, tab close, demo exit or sign-out.
 *
 * Both the mode and the active workspace are recorded under dedicated keys
 * (session information, not business data) so they are known synchronously at
 * module load — before any store rehydrates. That is what makes a refresh come
 * back with the right tenant's books instead of the previous one's.
 *
 * ── This is development-grade isolation, not production isolation ────────────
 * Namespacing keys stops one tenant's data reaching another through the normal
 * running of the application. It is NOT a security boundary: everything here is
 * in the user's own browser, readable and writable with devtools. Real isolation
 * requires the records to live server-side behind the organization-scoped
 * authorization that already guards the account surfaces. See the note in
 * `store/businessWorkspace`.
 */
import { createJSONStorage, type StateStorage } from 'zustand/middleware';

export type WorkspaceStorageMode = 'memory' | 'backend';

/** Whose books these are. `demo` is the only workspace that may hold seed data. */
export type WorkspaceKind = 'tenant' | 'demo';

export interface WorkspaceIdentity {
  kind: WorkspaceKind;
  /** The backend-confirmed organization id, or the demo workspace's own id. */
  organizationId: string;
}

/** Where the *mode* is recorded. Never holds business data. */
export const WORKSPACE_MODE_KEY = 'ledgora-workspace-storage-mode';

/** Where the *active workspace* is recorded. Never holds business data. */
export const ACTIVE_WORKSPACE_KEY = 'ledgora-active-workspace';

/** Namespace every business key lives under. */
export const WORKSPACE_PREFIX = 'ledgora:ws';

/** Volatile workspace. Cleared on demo exit / sign-out; gone on refresh. */
const memoryWorkspace = new Map<string, string>();

function browserStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    // Private-mode / disabled storage: fall back to memory rather than throwing.
    return null;
  }
}

export function getWorkspaceStorageMode(): WorkspaceStorageMode {
  const raw = browserStorage()?.getItem(WORKSPACE_MODE_KEY);
  return raw === 'memory' ? 'memory' : 'backend';
}

/**
 * Switch the workspace between durable and memory-only storage. Switching modes
 * always drops the volatile workspace so demo records can never leak into a
 * durable workspace (or vice versa).
 */
export function setWorkspaceStorageMode(mode: WorkspaceStorageMode): void {
  memoryWorkspace.clear();
  const storage = browserStorage();
  if (!storage) return;
  if (mode === 'memory') storage.setItem(WORKSPACE_MODE_KEY, 'memory');
  else storage.removeItem(WORKSPACE_MODE_KEY);
}

/* ── The active workspace ─────────────────────────────────────────────────── */

/**
 * Read synchronously from storage rather than held in a module variable, so a
 * page reload knows which tenant it is BEFORE the first store rehydrates. A
 * module variable would start empty on every load and every store would hydrate
 * against the wrong scope — or, worse, fall back to a shared one.
 */
export function getActiveWorkspace(): WorkspaceIdentity | null {
  const raw = browserStorage()?.getItem(ACTIVE_WORKSPACE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceIdentity>;
    if (!parsed || typeof parsed.organizationId !== 'string' || !parsed.organizationId) return null;
    const kind: WorkspaceKind = parsed.kind === 'demo' ? 'demo' : 'tenant';
    return { kind, organizationId: parsed.organizationId };
  } catch {
    // An unparseable marker is treated as "no workspace" — fail closed rather
    // than guessing a tenant.
    return null;
  }
}

/**
 * Point the adapter at one organization's books, or at nothing.
 *
 * Passing `null` (sign-out) leaves every durable key untouched but makes them
 * unreachable: the next read serves the volatile map instead. Nothing is
 * deleted, because signing out is not a request to destroy the account's data.
 */
export function setActiveWorkspace(identity: WorkspaceIdentity | null): void {
  // The volatile map belongs to whichever workspace was previously active, so it
  // must not survive a switch.
  memoryWorkspace.clear();
  const storage = browserStorage();
  if (!storage) return;
  if (!identity) {
    storage.removeItem(ACTIVE_WORKSPACE_KEY);
    return;
  }
  storage.setItem(ACTIVE_WORKSPACE_KEY, JSON.stringify(identity));
}

/** The key prefix one workspace's records live under. */
export function workspaceScope(identity: WorkspaceIdentity): string {
  return `${WORKSPACE_PREFIX}:${identity.kind}:${identity.organizationId}:`;
}

/**
 * The physical key for a store within the active workspace, or `null` when no
 * workspace is open. `null` is the fail-closed signal the adapter acts on.
 */
function scopedKey(name: string): string | null {
  const identity = getActiveWorkspace();
  if (!identity) return null;
  return `${workspaceScope(identity)}${name}`;
}

/** Discard every in-memory business record (demo exit, sign-out). */
export function clearMemoryWorkspace(): void {
  memoryWorkspace.clear();
}

/** Test/diagnostic helper: keys currently held in the volatile workspace. */
export function memoryWorkspaceKeys(): string[] {
  return [...memoryWorkspace.keys()];
}

/**
 * Every durable key belonging to one workspace.
 *
 * Used by diagnostics and by the tests that prove one tenant's records are
 * physically absent from another tenant's scope.
 */
export function workspaceKeys(identity: WorkspaceIdentity): string[] {
  const storage = browserStorage();
  if (!storage) return [];
  const prefix = workspaceScope(identity);
  const found: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key && key.startsWith(prefix)) found.push(key);
  }
  return found;
}

/**
 * Delete one workspace's durable records.
 *
 * Scoped by construction: it can only remove keys under that workspace's own
 * prefix, so "clear this tenant" can never reach another tenant's books.
 */
export function clearWorkspaceData(identity: WorkspaceIdentity): number {
  const storage = browserStorage();
  if (!storage) return 0;
  const keys = workspaceKeys(identity);
  for (const key of keys) storage.removeItem(key);
  return keys.length;
}

/* ── The adapter ──────────────────────────────────────────────────────────── */

/**
 * The `StateStorage` handed to every business store's `persist` middleware.
 * The mode and the workspace are read per operation, so opening a different
 * tenant takes effect immediately for stores that were created long before.
 */
export const businessDataStorage: StateStorage = {
  getItem: (name) => {
    if (getWorkspaceStorageMode() === 'memory') return memoryWorkspace.get(name) ?? null;
    const key = scopedKey(name);
    // No workspace open → nothing durable is readable. Never fall back to the
    // bare name: that shared key is exactly how one tenant read another's books.
    if (!key) return memoryWorkspace.get(name) ?? null;
    // BACKEND SEAM: a real deployment loads the workspace from the API here.
    return browserStorage()?.getItem(key) ?? null;
  },
  setItem: (name, value) => {
    if (getWorkspaceStorageMode() === 'memory') {
      memoryWorkspace.set(name, value);
      return;
    }
    const key = scopedKey(name);
    if (!key) {
      // Nothing durable is written before a tenant is known, so a store that
      // hydrates early cannot stamp its defaults onto a shared key.
      memoryWorkspace.set(name, value);
      return;
    }
    // BACKEND SEAM: a real deployment writes the record through the API here.
    browserStorage()?.setItem(key, value);
  },
  removeItem: (name) => {
    if (getWorkspaceStorageMode() === 'memory') {
      memoryWorkspace.delete(name);
      return;
    }
    const key = scopedKey(name);
    if (!key) {
      memoryWorkspace.delete(name);
      return;
    }
    browserStorage()?.removeItem(key);
  },
};

/** Ready-made JSON storage for `persist({ storage: businessJSONStorage })`. */
export const businessJSONStorage = createJSONStorage(() => businessDataStorage);

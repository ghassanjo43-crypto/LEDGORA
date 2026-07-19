/**
 * Workspace storage adapter for business (accounting) data.
 *
 * Every accounting/inventory/manufacturing/billing-document store persists
 * through `businessDataStorage` instead of talking to `localStorage` directly.
 * The adapter has two modes:
 *
 *  - `'backend'` — the durable path. Frontend-only today, so it is served by the
 *    browser-storage development adapter below. This is the ONE place a real
 *    backend persistence service replaces browser storage.
 *  - `'memory'`  — a per-tab in-memory map. Nothing reaches `localStorage`,
 *    `sessionStorage` or any server, so a Free Demo workspace evaporates on
 *    refresh, tab close, demo exit or sign-out.
 *
 * The mode itself is recorded under a dedicated key (session information, not
 * business data) so it is known synchronously at module load — before any store
 * rehydrates. That is what makes a refresh during Free Demo come back empty
 * instead of resurrecting either demo data or the previous account's books.
 */
import { createJSONStorage, type StateStorage } from 'zustand/middleware';

export type WorkspaceStorageMode = 'memory' | 'backend';

/** Where the *mode* is recorded. Never holds business data. */
export const WORKSPACE_MODE_KEY = 'ledgora-workspace-storage-mode';

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

/** Discard every in-memory business record (demo exit, sign-out). */
export function clearMemoryWorkspace(): void {
  memoryWorkspace.clear();
}

/** Test/diagnostic helper: keys currently held in the volatile workspace. */
export function memoryWorkspaceKeys(): string[] {
  return [...memoryWorkspace.keys()];
}

/**
 * The `StateStorage` handed to every business store's `persist` middleware.
 * The mode is read per operation, so flipping into demo mode takes effect
 * immediately for stores that were created long before.
 */
export const businessDataStorage: StateStorage = {
  getItem: (name) => {
    if (getWorkspaceStorageMode() === 'memory') return memoryWorkspace.get(name) ?? null;
    // BACKEND SEAM: a real deployment loads the workspace from the API here.
    return browserStorage()?.getItem(name) ?? null;
  },
  setItem: (name, value) => {
    if (getWorkspaceStorageMode() === 'memory') {
      memoryWorkspace.set(name, value);
      return;
    }
    // BACKEND SEAM: a real deployment writes the record through the API here.
    browserStorage()?.setItem(name, value);
  },
  removeItem: (name) => {
    if (getWorkspaceStorageMode() === 'memory') {
      memoryWorkspace.delete(name);
      return;
    }
    browserStorage()?.removeItem(name);
  },
};

/** Ready-made JSON storage for `persist({ storage: businessJSONStorage })`. */
export const businessJSONStorage = createJSONStorage(() => businessDataStorage);

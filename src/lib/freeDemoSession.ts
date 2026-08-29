/**
 * Free Demo workspace lifecycle + the workspace storage-mode sync.
 *
 * Entering the demo switches business storage to memory-only and clears the
 * books, so a demo visitor never sees (or writes to) a real workspace. Leaving
 * the demo — by upgrading, exiting or signing out — discards the volatile
 * workspace and re-reads the durable one.
 */
import type { AccountStatus } from '@/types/session';
import { releaseServerBooks } from '@/services/books/booksEngine';
import {
  clearMemoryWorkspace,
  getWorkspaceStorageMode,
  setActiveWorkspace,
  setWorkspaceStorageMode,
  type WorkspaceStorageMode,
} from './workspaceStorage';
import {
  FREE_DEMO_WORKSPACE_ID,
  resetBusinessWorkspace,
  rehydrateBusinessWorkspace,
} from '@/store/businessWorkspace';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { useOperatorViewStore } from '@/store/operatorViewStore';

/**
 * The storage mode a given account status runs in.
 *
 * `anonymous`, `free-demo` and `free-preview` are memory-only: no business
 * record can reach durable storage. For Free Preview this is the whole
 * mechanism behind `canPersistData: false` — the customer explores every
 * feature, and because every business store persists through
 * `businessJSONStorage`, not one of their records touches localStorage,
 * sessionStorage, IndexedDB or the backend.
 *
 * `registered-no-plan` also cannot persist business data, but it is enforced
 * upstream — that status cannot open the accounting application at all (see
 * `lib/sessionModel.canOpenApplication`), so there is no business data to write;
 * keeping durable mode preserves the organization profile the subscription step
 * needs.
 */
export function storageModeFor(status: AccountStatus): WorkspaceStorageMode {
  return status === 'anonymous' || status === 'free-demo' || status === 'free-preview'
    ? 'memory'
    : 'backend';
}

/**
 * Apply the storage mode for a status. Returns true when the mode changed.
 *
 * Entering memory mode also DROPS whatever the business stores currently hold.
 * Without that a customer who signed in (durable rehydrate) and then resolved to
 * Free Preview would carry the durable workspace into the preview in memory,
 * where they could edit records that were never meant to be writable. Leaving
 * memory mode re-reads the durable workspace for the same reason.
 */
export function syncWorkspaceStorageMode(status: AccountStatus): boolean {
  const next = storageModeFor(status);
  if (getWorkspaceStorageMode() === next) return false;
  setWorkspaceStorageMode(next);
  /* Free Preview and Free Demo are memory-only and must not be refused as
   * browser writes; a durable status re-latches on its own from the session. */
  if (next === 'memory') releaseServerBooks();
  if (next === 'memory') {
    // The mode is switched FIRST, so these default-writes land in the volatile
    // map and cannot overwrite the durable workspace.
    resetBusinessWorkspace();
  } else {
    // Re-read only. Resetting here would write defaults THROUGH to durable
    // storage and the rehydrate would then faithfully read back the wreckage.
    rehydrateBusinessWorkspace();
  }
  return true;
}

/** Begin a Free Demo: memory-only storage with a freshly seeded workspace. */
export function startFreeDemoWorkspace(): void {
  // Order matters: switch to memory FIRST so the reset below cannot overwrite a
  // durable workspace belonging to a real subscriber.
  setWorkspaceStorageMode('memory');
  /*
   * And leave the server engine, so the demo's records go to the volatile
   * workspace rather than being refused as browser writes. This is a genuine
   * end of the durable session for these stores — the demo is explicitly
   * ephemeral and calls no persistence API — which is why releasing the latch
   * here is correct and releasing it on a failed request never is.
   */
  releaseServerBooks();
  /*
   * Claim the demo workspace identity here, not just in the shell.
   *
   * The demo is the ONE workspace allowed to hold seed fixtures, and this is
   * where it is seeded. Recording the identity at the same moment means the
   * shell's workspace effect sees the demo already open and leaves it alone —
   * otherwise its first run would treat the demo as a new workspace and reset
   * it, throwing away whatever the visitor had already entered.
   */
  setActiveWorkspace({ kind: 'demo', organizationId: FREE_DEMO_WORKSPACE_ID });
  resetBusinessWorkspace();
  useAccountSessionStore.getState().setDemoActive(true);
}

/**
 * End a Free Demo. The volatile workspace is discarded (this is the documented
 * behaviour: demo records are never carried into a real subscription) and the
 * durable workspace, if any, is re-read.
 */
export function endFreeDemoWorkspace(): void {
  clearMemoryWorkspace();
  useAccountSessionStore.getState().setDemoActive(false);
  setWorkspaceStorageMode('backend');
  resetBusinessWorkspace();
  rehydrateBusinessWorkspace();
}

/**
 * Discard every business record held for the current session and return the
 * workspace to memory-only. Used on sign-out: it never touches another
 * (durable) account's records because the reset runs in memory mode.
 */
export function clearWorkspaceForSignOut(): void {
  setWorkspaceStorageMode('memory');
  releaseServerBooks();
  useAccountSessionStore.getState().resetToDefault();
  // Leaving the account also leaves any operator subscriber-view mode, so a
  // later session never resumes viewing a tenant.
  useOperatorViewStore.getState().exit();
  /*
   * Release the tenant namespace. The signed-out account's records are left
   * exactly where they are — signing out is not a request to destroy books —
   * but they stop being addressable, so whoever signs in next cannot read them
   * even before their own workspace is opened.
   */
  setActiveWorkspace(null);
  resetBusinessWorkspace();
  clearMemoryWorkspace();
}

/** Restore the durable workspace after a successful sign-in. */
export function restoreWorkspaceForSignIn(): void {
  setWorkspaceStorageMode('backend');
  rehydrateBusinessWorkspace();
}

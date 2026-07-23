/**
 * Free Demo workspace lifecycle + the workspace storage-mode sync.
 *
 * Entering the demo switches business storage to memory-only and clears the
 * books, so a demo visitor never sees (or writes to) a real workspace. Leaving
 * the demo — by upgrading, exiting or signing out — discards the volatile
 * workspace and re-reads the durable one.
 */
import type { AccountStatus } from '@/types/session';
import {
  clearMemoryWorkspace,
  getWorkspaceStorageMode,
  setWorkspaceStorageMode,
  type WorkspaceStorageMode,
} from './workspaceStorage';
import { resetBusinessWorkspace, rehydrateBusinessWorkspace } from '@/store/businessWorkspace';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { useOperatorViewStore } from '@/store/operatorViewStore';

/**
 * The storage mode a given account status runs in.
 *
 * `anonymous` and `free-demo` are memory-only: no business record can reach
 * durable storage. `registered-no-plan` also cannot persist business data, but
 * it is enforced upstream — that status cannot open the accounting application
 * at all (see `lib/sessionModel.canOpenApplication`), so there is no business
 * data to write; keeping durable mode preserves the organization profile the
 * subscription step needs.
 */
export function storageModeFor(status: AccountStatus): WorkspaceStorageMode {
  return status === 'anonymous' || status === 'free-demo' ? 'memory' : 'backend';
}

/** Apply the storage mode for a status. Returns true when the mode changed. */
export function syncWorkspaceStorageMode(status: AccountStatus): boolean {
  const next = storageModeFor(status);
  if (getWorkspaceStorageMode() === next) return false;
  setWorkspaceStorageMode(next);
  return true;
}

/** Begin a Free Demo: memory-only storage with a freshly seeded workspace. */
export function startFreeDemoWorkspace(): void {
  // Order matters: switch to memory FIRST so the reset below cannot overwrite a
  // durable workspace belonging to a real subscriber.
  setWorkspaceStorageMode('memory');
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
  useAccountSessionStore.getState().resetToDefault();
  // Leaving the account also leaves any operator subscriber-view mode, so a
  // later session never resumes viewing a tenant.
  useOperatorViewStore.getState().exit();
  resetBusinessWorkspace();
  clearMemoryWorkspace();
}

/** Restore the durable workspace after a successful sign-in. */
export function restoreWorkspaceForSignIn(): void {
  setWorkspaceStorageMode('backend');
  rehydrateBusinessWorkspace();
}

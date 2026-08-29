/**
 * Where a set of books actually lives.
 *
 * ══ Two engines, and only two ════════════════════════════════════════════════
 *
 *   `server` — a signed-in subscriber on a durable workspace. Every account and
 *              journal is read from and written to PostgreSQL, scoped to the
 *              selected company. The browser holds a CACHE of the last answer
 *              and decides nothing.
 *
 *   `demo`   — Free Demo, Free Preview and anyone not signed in. Records live
 *              in the volatile in-memory workspace, evaporate on refresh, and
 *              never reach a persistence API. This is a real product feature —
 *              somebody trying Ledgora gets working books — and it is
 *              explicitly NOT durable.
 *
 * ══ Why `server` latches ═════════════════════════════════════════════════════
 *
 * The dangerous version of this function derives the engine freshly from the
 * session on every call. Then the network drops, `GET /api/auth/session` fails,
 * the session store reports `unavailable`, and the next verdict is `demo` — so
 * a subscriber's next posting goes silently into browser storage. They see it
 * saved. It is not saved. It is in a cache that the next successful hydration
 * will overwrite without a word, and the transaction is simply gone.
 *
 * That is the single worst failure this whole phase exists to prevent, so the
 * verdict LATCHES. Once a durable subscriber session has been confirmed, this
 * browser is on the server engine until the workspace itself changes — sign-out
 * or a switch to a demo workspace. An outage then produces a visible error on
 * the screen the user is looking at, which is the honest outcome: "could not
 * save" is recoverable, "saved somewhere that does not count" is not.
 *
 * ══ Who is deliberately NOT a server subscriber ══════════════════════════════
 *
 * Platform operators. They have no books of their own, and an operator
 * inspecting a tenant must not create accounts under whatever company reference
 * their own browser happens to hold.
 */
import { isApiConfigured } from '@/services/api/client';
import { getWorkspaceStorageMode } from '@/lib/workspaceStorage';
import { useBackendSessionStore } from '@/store/backendSessionStore';

export type BooksEngine = 'server' | 'demo';

/**
 * Set once a durable subscriber session has been seen, cleared only when the
 * workspace changes. Module-level rather than in a store because it must not be
 * persisted, inspected or edited: it is a safety latch, not application state.
 */
let latched = false;

/** Whether the session, right now, is a durable subscriber's. */
function durableSubscriberNow(): boolean {
  if (!isApiConfigured()) return false;
  if (getWorkspaceStorageMode() !== 'backend') return false;
  const session = useBackendSessionStore.getState();
  /* `ready` WITH a user is the only state meaning the server confirmed this
   * identity. `unknown`, `loading` and `unavailable` all mean it has not. */
  if (session.status !== 'ready' || !session.user) return false;
  return session.platformRoles.length === 0;
}

/**
 * Which engine this browser is on.
 *
 * Re-checks the live session so a subscriber who signs in mid-session moves on
 * to the server engine immediately — but never moves BACK off it, which is what
 * the latch is for.
 */
export function booksEngine(): BooksEngine {
  if (latched) return 'server';
  if (durableSubscriberNow()) {
    latched = true;
    return 'server';
  }
  return 'demo';
}

/** True when writes must go to the server and nowhere else. */
export function booksAreServerAuthoritative(): boolean {
  return booksEngine() === 'server';
}

/**
 * Release the latch.
 *
 * The ONLY correct callers are sign-out and entering a demo workspace: both
 * genuinely end the durable session rather than interrupting it. Never call
 * this to recover from a failed request — that is precisely the downgrade the
 * latch exists to prevent.
 */
export function releaseServerBooks(): void {
  latched = false;
}

/** Test seam. Behaves as sign-out; named so its use in code stands out. */
export const __resetBooksEngineForTests = releaseServerBooks;

/**
 * The refusal a browser store gives when asked to write while the server owns
 * the books. Deliberately one sentence about what happened and what to do.
 */
export const SERVER_BOOKS_MESSAGE =
  'These books are kept on the Ledgora service. Reload the page, or try again once you are back online — '
  + 'nothing is saved in this browser.';

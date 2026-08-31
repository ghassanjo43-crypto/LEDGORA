/**
 * The company-scope generation counter, on its own.
 *
 * ══ Why this is not just a `let` inside booksScope ═══════════════════════════
 *
 * `booksScope` has to CLEAR the caches when the company changes, so it imports
 * the stores. Those stores have to know whether a response they are holding has
 * been overtaken, so they import the counter. Keeping both in one module makes
 * every such store circularly dependent on `booksScope`, and a cycle resolves
 * differently depending on which side the module graph reaches first — which is
 * not a theoretical problem: it silently turned the cache clearing into a no-op
 * under one import order and left it working under another.
 *
 * The counter depends on nothing, so nothing can cycle through it. `booksScope`
 * re-exports the readers, and existing callers are unaffected.
 */

/**
 * Bumped by every company change. A hydration that started under an older value
 * has been overtaken and must not write.
 */
let generation = 0;

export function booksGeneration(): number {
  return generation;
}

/** Whether a result from `startedAt` may still be applied. */
export function isCurrentGeneration(startedAt: number): boolean {
  return startedAt === generation;
}

/** Called only by `booksScope` when the open company changes. */
export function bumpBooksGeneration(): number {
  generation += 1;
  return generation;
}

/** Tests only: return to a known counter so one file cannot affect the next. */
export function __resetBooksGenerationForTests(): void {
  generation = 0;
}

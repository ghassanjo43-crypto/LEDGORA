import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { availableParallelism } from 'node:os';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  test: {
    environment: 'node',
    // Each file gets its own PGlite instance; forks keep them fully isolated.
    pool: 'forks',
    /**
     * Every `beforeEach` boots a real PostgreSQL engine and runs the production
     * migrations, so each fork is CPU-hungry rather than IO-bound. Left
     * unbounded, one fork per test file oversubscribes the machine and the
     * FIRST hook in each file starves past its timeout — a failure that is
     * purely about scheduling and says nothing about the code under test.
     *
     * Cap the pool at half the available cores (at least two) and give the
     * database-bootstrapping hooks room to finish under that contention.
     *
     * Vitest 4 removed the per-pool `poolOptions.forks.maxForks` in favour of
     * this top-level cap, which applies to whichever `pool` is selected.
     */
    maxWorkers: Math.max(2, Math.floor(availableParallelism() / 2)),
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});

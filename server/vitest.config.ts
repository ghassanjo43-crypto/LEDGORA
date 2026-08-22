import { defineConfig } from 'vitest/config';
import path from 'node:path';

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
     * PGlite is memory- and CPU-intensive enough that deriving this from the
     * logical core count is unsafe: concurrent engines on a 12-thread
     * workstation starve migration hooks past 120 seconds. One fork keeps
     * isolation while allowing every database to boot and close normally.
     *
     * Vitest 4 removed the per-pool `poolOptions.forks.maxForks` in favour of
     * this top-level cap, which applies to whichever `pool` is selected.
     */
    maxWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});

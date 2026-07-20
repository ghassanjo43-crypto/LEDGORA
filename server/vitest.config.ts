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
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vitest = resolve(serverRoot, '..', 'node_modules', 'vitest', 'vitest.mjs');
const files = readdirSync(resolve(serverRoot, 'tests'))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => `tests/${name}`);

const startedAt = Date.now();
for (const [index, file] of files.entries()) {
  process.stdout.write(`\n[server:test ${index + 1}/${files.length}] ${file}\n`);
  const result = spawnSync(process.execPath, [vitest, 'run', file, '--maxWorkers=1'], {
    cwd: serverRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(2);
process.stdout.write(`\nServer suite completed: ${files.length} test files in ${durationSeconds}s.\n`);

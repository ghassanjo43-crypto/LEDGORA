/**
 * Migration CLI.
 *
 *   npm run db:migrate          # apply everything outstanding
 *   npm run db:migrate:down     # roll back one step (development only)
 */
import { exit, argv } from 'node:process';
import { getConfig } from '../config/env.js';
import { createDatabase } from '../db/index.js';
import { assertMigrationsSucceeded, migrateDown, migrateToLatest } from '../db/migrator.js';

async function main(): Promise<void> {
  const direction = argv[2] === 'down' ? 'down' : 'up';
  const config = getConfig();
  const db = await createDatabase({ databaseUrl: config.DATABASE_URL, isProduction: config.isProduction });

  try {
    if (!config.DATABASE_URL) {
      console.warn('No DATABASE_URL configured — migrating the in-process development database (nothing is persisted).');
    }
    const result = direction === 'up' ? await migrateToLatest(db) : await migrateDown(db, config.isProduction);
    assertMigrationsSucceeded(result);

    const applied = result.results ?? [];
    if (applied.length === 0) console.info('Database already up to date.');
    for (const item of applied) console.info(`${item.direction === 'Up' ? 'applied' : 'reverted'}: ${item.migrationName}`);
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  exit(1);
});

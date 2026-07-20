/**
 * Server entry point.
 *
 * Boot order: validate config → connect → migrate → optional admin bootstrap →
 * listen. Migrations run at start so a Render deploy converges without a manual
 * step; they are forward-only and non-destructive.
 */
import { buildApp } from './app.js';
import { getConfig, describeConfig } from './config/env.js';
import { createDatabase } from './db/index.js';
import { assertMigrationsSucceeded, migrateToLatest } from './db/migrator.js';
import { runAdminBootstrap } from './cli/bootstrapAdmin.js';

async function main(): Promise<void> {
  const config = getConfig();
  const db = await createDatabase({
    databaseUrl: config.DATABASE_URL,
    isProduction: config.isProduction,
  });

  assertMigrationsSucceeded(await migrateToLatest(db));

  // Optional, explicitly-enabled first-administrator provisioning.
  await runAdminBootstrap(db, config, (message) => console.info(`[bootstrap] ${message}`));

  const app = await buildApp({ config, db });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info(describeConfig(config), 'LEDGORA API ready');
}

main().catch((error: unknown) => {
  console.error('Failed to start the LEDGORA API:', error instanceof Error ? error.message : error);
  process.exit(1);
});

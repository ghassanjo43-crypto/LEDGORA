/**
 * Migration runner.
 *
 * Migrations are explicit modules in a static provider rather than filesystem
 * discovery, so the compiled `dist/` bundle carries them and Render never needs
 * source files at runtime. Forward-only in production: `migrateDown` refuses to
 * run there.
 */
import { Migrator, type Migration, type MigrationProvider, type MigrationResultSet } from 'kysely';
// Migrations run against the schema as it exists at that point in time, so
// they are intentionally schema-agnostic.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = import('kysely').Kysely<any>;
import * as initialSchema from './migrations/001_initial_schema.js';
import * as referenceData from './migrations/002_reference_data.js';

const MIGRATIONS: Record<string, Migration> = {
  '001_initial_schema': initialSchema,
  '002_reference_data': referenceData,
};

class StaticMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return MIGRATIONS;
  }
}

export function createMigrator(db: AnyKysely): Migrator {
  return new Migrator({ db, provider: new StaticMigrationProvider() });
}

export async function migrateToLatest(db: AnyKysely): Promise<MigrationResultSet> {
  return createMigrator(db).migrateToLatest();
}

export async function migrateDown(db: AnyKysely, isProduction: boolean): Promise<MigrationResultSet> {
  if (isProduction) {
    throw new Error('Refusing to run a down-migration in production. Production migrations are forward-only.');
  }
  return createMigrator(db).migrateDown();
}

/** Throw with a readable message when any migration failed. */
export function assertMigrationsSucceeded(result: MigrationResultSet): void {
  if (result.error) {
    const failed = result.results?.find((r) => r.status === 'Error');
    throw new Error(`Migration failed${failed ? ` at "${failed.migrationName}"` : ''}: ${String(result.error)}`);
  }
}

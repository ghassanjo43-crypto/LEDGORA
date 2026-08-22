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
import * as subscriptionApplications from './migrations/003_subscription_applications.js';
import * as adminConsole from './migrations/004_admin_console.js';
import * as retentionAndDeletion from './migrations/005_retention_and_deletion.js';
import * as userPermissions from './migrations/006_user_permissions.js';
import * as subscriberClosure from './migrations/007_subscriber_closure.js';
import * as dataClassification from './migrations/008_data_classification.js';
import * as disposableCleanup from './migrations/009_disposable_cleanup.js';
import * as classificationReview from './migrations/010_classification_review.js';
import * as identityClassificationGuard from './migrations/011_identity_classification_guard.js';
import * as repairDeletionTombstoneStatusColumns from './migrations/012_repair_deletion_tombstone_status_columns.js';
import * as accountingFoundation from './migrations/013_accounting_foundation.js';
import * as commercialPackageCatalogue from './migrations/014_commercial_package_catalogue.js';
import * as accountPostingStates from './migrations/015_account_posting_states.js';
import * as openingBalances from './migrations/016_opening_balances.js';

const MIGRATIONS: Record<string, Migration> = {
  '001_initial_schema': initialSchema,
  '002_reference_data': referenceData,
  '003_subscription_applications': subscriptionApplications,
  '004_admin_console': adminConsole,
  '005_retention_and_deletion': retentionAndDeletion,
  '006_user_permissions': userPermissions,
  '007_subscriber_closure': subscriberClosure,
  '008_data_classification': dataClassification,
  '009_disposable_cleanup': disposableCleanup,
  '010_classification_review': classificationReview,
  '011_identity_classification_guard': identityClassificationGuard,
  '012_repair_deletion_tombstone_status_columns': repairDeletionTombstoneStatusColumns,
  '013_accounting_foundation': accountingFoundation,
  '014_commercial_package_catalogue': commercialPackageCatalogue,
  '015_account_posting_states': accountPostingStates,
  '016_opening_balances': openingBalances,
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

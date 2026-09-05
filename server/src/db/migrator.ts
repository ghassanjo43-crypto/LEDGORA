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
import * as immutableSubscriberOwnership from './migrations/017_immutable_subscriber_ownership.js';
import * as packageModuleRepair from './migrations/018_package_module_repair.js';
import * as salesInvoices from './migrations/019_sales_invoices.js';
import * as invoiceSettlement from './migrations/020_invoice_settlement.js';
import * as organizationLanguage from './migrations/021_organization_language.js';
import * as companyRegistry from './migrations/022_company_registry.js';
import * as previewSessions from './migrations/023_preview_sessions.js';
import * as legalAcceptance from './migrations/024_legal_acceptance.js';
import * as companyScopedAccounting from './migrations/025_company_scoped_accounting.js';
import * as companyAdoptionState from './migrations/026_company_adoption_state.js';
import * as companySettings from './migrations/027_company_settings.js';
import * as accountClassification from './migrations/028_account_classification.js';
import * as sourcePostingIdentity from './migrations/029_source_posting_identity.js';
import * as businessParties from './migrations/030_business_parties.js';
import * as invoiceCustomerFk from './migrations/031_invoice_customer_fk.js';
import * as salesTaxCodes from './migrations/032_sales_tax_codes.js';
import * as supplierProfiles from './migrations/033_supplier_profiles.js';
import * as supplierBills from './migrations/034_supplier_bills.js';
import * as purchaseTax from './migrations/035_purchase_tax.js';
import * as supplierPayments from './migrations/036_supplier_payments.js';
import * as inventoryMasterData from './migrations/037_inventory_master_data.js';
import * as inventoryMovements from './migrations/038_inventory_movements.js';
import * as stockedBills from './migrations/039_stocked_bills.js';
import * as stockedInvoices from './migrations/040_stocked_invoices.js';
import * as stockCounts from './migrations/041_stock_counts.js';
import * as purchaseOrders from './migrations/042_purchase_orders.js';

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
  '017_immutable_subscriber_ownership': immutableSubscriberOwnership,
  '018_package_module_repair': packageModuleRepair,
  '019_sales_invoices': salesInvoices,
  '020_invoice_settlement': invoiceSettlement,
  '021_organization_language': organizationLanguage,
  '022_company_registry': companyRegistry,
  '023_preview_sessions': previewSessions,
  '024_legal_acceptance': legalAcceptance,
  '025_company_scoped_accounting': companyScopedAccounting,
  '026_company_adoption_state': companyAdoptionState,
  '027_company_settings': companySettings,
  '028_account_classification': accountClassification,
  '029_source_posting_identity': sourcePostingIdentity,
  '030_business_parties': businessParties,
  '031_invoice_customer_fk': invoiceCustomerFk,
  '032_sales_tax_codes': salesTaxCodes,
  '033_supplier_profiles': supplierProfiles,
  '034_supplier_bills': supplierBills,
  '035_purchase_tax': purchaseTax,
  '036_supplier_payments': supplierPayments,
  '037_inventory_master_data': inventoryMasterData,
  '038_inventory_movements': inventoryMovements,
  '039_stocked_bills': stockedBills,
  '040_stocked_invoices': stockedInvoices,
  '041_stock_counts': stockCounts,
  '042_purchase_orders': purchaseOrders,
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

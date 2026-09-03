/**
 * The authoritative inventory of everything an organization owns.
 *
 * ── Why this is data and not a hand-written delete sequence ──────────────────
 * A purge written as a list of statements is correct exactly once: the day it is
 * written. The next migration adds a tenant-owned table, nobody remembers to
 * extend the purge, and the failure is silent — rows belonging to a destroyed
 * tenant survive, or a foreign key aborts a destruction halfway through.
 *
 * So the inventory is a value. The purge iterates it, the preview counts it, and
 * `tenantInventory.test.ts` compares it against the live database catalogue and
 * FAILS when a new table references `organizations(id)` without a decision being
 * recorded here. Forgetting becomes a red test instead of a data leak.
 *
 * ── Why cascade is not trusted ───────────────────────────────────────────────
 * Most of these tables are ON DELETE CASCADE, so `DELETE FROM organizations`
 * would appear to work. It is still wrong to rely on it:
 *   · a cascade reports nothing, so the operator cannot be told what was
 *     destroyed and the tombstone has no counts;
 *   · a cascade cannot distinguish "delete this" from "null this out" for rows
 *     that are shared or are audit evidence;
 *   · it silently extends itself to tables added later, which is the exact
 *     behaviour this module exists to prevent.
 * Explicit deletion in a reviewed order is slower and knows what it did.
 */
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/schema.js';

/** What kind of thing this is, which decides what may be done to it. */
export type OwnershipKind =
  /** Belongs to exactly one organization and has no meaning without it. */
  | 'authoritative'
  /** Recomputable from authoritative rows; safe to drop. */
  | 'derived'
  /** Referenced by other tenants or by the platform; must survive. */
  | 'shared'
  /** Evidence of what happened; must survive the subject. */
  | 'immutable_audit';

export type Disposition =
  | 'delete'
  /** Keep the row, drop the link (FK is ON DELETE SET NULL). */
  | 'detach'
  /** Never touched by a tenant deletion. */
  | 'retain'
  /** Not a database row: an object in external storage. */
  | 'external_cleanup';

export interface TenantDependency {
  table: keyof Database | 'external:payment_proof_files';
  /** The column tying a row to its organization. */
  ownershipKey: string;
  kind: OwnershipKind;
  disposition: Disposition;
  /** Ascending. Children strictly before parents. */
  order: number;
  /** The label shown in the preview. */
  label: string;
  /** True when a row here can be reached from another organization. */
  crossTenantReachable: boolean;
  /** Why this disposition, in one sentence. */
  rationale: string;
}

/**
 * Deletion order, children first.
 *
 * The ordering constraints that actually matter:
 *   · `payment_proofs` references `subscription_invoices`, so proofs go first.
 *   · every organization-scoped table goes before `organizations` itself.
 *   · `organization_memberships` goes before `organizations` but AFTER
 *     everything keyed on a member, because member cleanup reads it.
 *   · identities are considered only after the organization row is gone, so
 *     "does this person still belong anywhere?" has its final answer.
 */
export const TENANT_DEPENDENCIES: readonly TenantDependency[] = [
  {
    table: 'external:payment_proof_files',
    ownershipKey: 'payment_proofs.storage_key',
    kind: 'authoritative',
    disposition: 'external_cleanup',
    order: 5,
    label: 'Stored payment-proof files',
    crossTenantReachable: false,
    rationale:
      'Object storage is not transactional with the database, so keys are recorded in the cleanup ledger before the rows naming them are deleted.',
  },
  {
    table: 'payment_proofs',
    ownershipKey: 'invoice_id → subscription_invoices.organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 10,
    label: 'Payment proofs',
    crossTenantReachable: false,
    rationale: 'Owned through its invoice; a proof has no meaning once the invoice is gone.',
  },
  {
    table: 'subscription_invoices',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 20,
    label: 'Subscription invoices',
    crossTenantReachable: false,
    rationale: 'Billing records of this tenant only. Retained for production tenants by the classification gate, not here.',
  },
  {
    table: 'subscriber_data_exports',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 25,
    label: 'Data export archives',
    crossTenantReachable: false,
    rationale:
      'Its `payload` column holds a full JSON copy of the tenant. Leaving it behind would preserve exactly the business content the deletion is meant to remove.',
  },
  {
    table: 'user_permission_overrides',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 30,
    label: 'Per-user permission overrides',
    crossTenantReachable: false,
    rationale:
      'Scoped to one organization even though it names a global user; the grant is meaningless once that organization is gone.',
  },
  {
    table: 'subscription_package_changes',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 40,
    label: 'Package change history',
    crossTenantReachable: false,
    rationale: 'History of this tenant’s own plan changes.',
  },
  {
    table: 'organization_entitlements',
    ownershipKey: 'organization_id',
    kind: 'derived',
    disposition: 'delete',
    order: 50,
    label: 'Resolved entitlements',
    crossTenantReachable: false,
    rationale: 'A recomputable cache of the subscription; never a source of truth.',
  },
  {
    table: 'subscription_applications',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 60,
    label: 'Onboarding applications',
    crossTenantReachable: false,
    rationale:
      'FK is ON DELETE SET NULL, so a cascade would leave a detached applicant row behind. Deleted explicitly for that reason.',
  },
  {
    table: 'organization_memberships',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 70,
    label: 'Memberships',
    crossTenantReachable: false,
    rationale:
      'The link, not the person. Deleting a membership must never be read as deleting the identity behind it.',
  },
  {
    table: 'subscriptions',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 80,
    label: 'Subscriptions',
    crossTenantReachable: false,
    rationale: 'One tenant’s billing relationship.',
  },
  /* ── Accounting books (Phase A) ────────────────────────────────────────
   * Tenant-owned by construction and destroyed with the tenant. Ordered
   * children-first: audit and versions, then lines, then entries, then the
   * accounts and periods they point at. The composite foreign keys make the
   * order load-bearing rather than stylistic.
   */
  {
    table: 'accounting_audit_events',
    ownershipKey: 'organization_id',
    kind: 'immutable_audit',
    disposition: 'delete',
    order: 41,
    label: 'Accounting audit events',
    crossTenantReachable: false,
    rationale:
      'Evidence about THIS tenant’s books only. It has no foreign key to the records it describes, so it is removed explicitly rather than by cascade.',
  },
  {
    table: 'journal_entry_versions',
    ownershipKey: 'organization_id',
    kind: 'immutable_audit',
    disposition: 'delete',
    order: 42,
    label: 'Journal version history',
    crossTenantReachable: false,
    rationale: 'Superseded snapshots of this tenant’s own entries.',
  },
  {
    table: 'journal_lines',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 43,
    label: 'Journal lines',
    crossTenantReachable: false,
    rationale: 'The postings themselves; meaningless without the entry they belong to.',
  },
  /*
   * Sales invoices — migration 019. Ordered before the journal entries and
   * accounts they reference, children ahead of their parents.
   */
  {
    table: 'platform_preview_sessions',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 5.3,
    label: 'Subscriber preview sessions',
    crossTenantReachable: false,
    rationale:
      'Records of a platform administrator looking at this tenant. The audit LOG of those events is '
      + 'kept separately and is not removed with the tenant; these are the live credentials only.',
  },
  {
    table: 'companies',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    /*
     * AFTER every accounting table (40.1-46), not before them.
     *
     * Since migration 025 each accounting row carries a composite foreign key to
     * its company with ON DELETE RESTRICT — which is what makes a set of books
     * with live journals impossible to remove by accident. The same constraint
     * means the books must go first: deleting the registry row while its
     * journals still exist is refused outright, and the purge would fail
     * part-way through with the tenant half-erased.
     */
    order: 46.5,
    label: 'Company registry',
    crossTenantReachable: false,
    rationale:
      'The server-side record of a tenant set of books, holding the authoritative bookkeeping language. '
      + 'It has no meaning once the tenant is gone. Removed after the books it owns, because the '
      + 'accounting tables reference it with ON DELETE RESTRICT.',
  },
  {
    table: 'legal_acceptances',
    ownershipKey: 'organization_id',
    kind: 'immutable_audit',
    disposition: 'delete',
    order: 47,
    label: 'Legal acceptances',
    crossTenantReachable: false,
    rationale:
      'Evidence of what a customer agreed to, and append-only: the table refuses UPDATE '
      + 'unconditionally and DELETE except while an authorised purge is in progress. It is removed '
      + 'here rather than retained because a record of consent cannot meaningfully outlive every '
      + 'party to it, and a customer who has asked to be erased must actually be erasable.',
  },
  {
    table: 'organization_legal_country_changes',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 47.1,
    label: 'Legal country changes',
    crossTenantReachable: false,
    rationale:
      'The trail of which country law governed this tenant, and under which addendum. It describes '
      + 'the tenant and nothing else, so it goes with the tenant.',
  },
  {
    table: 'organization_language_changes',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 5.5,
    label: 'Organization language changes',
    crossTenantReachable: false,
    rationale:
      'Why a tenant changed the language its documents are issued in. It outlives log retention because '
      + 'an auditor may ask years later, but it has no meaning once the tenant itself is gone.',
  },
  /*
   * Supplier payments, children first — and the whole group before BILLS,
   * because an allocation points at the bill it settled.
   */
  {
    table: 'payment_audit_events',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 37.92,
    label: 'Payment audit events',
    crossTenantReachable: false,
    rationale: 'The history of a supplier payment; meaningless once that payment is gone.',
  },
  {
    table: 'payment_allocations',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 37.94,
    label: 'Payment allocations',
    crossTenantReachable: false,
    rationale: 'What each payment settled. References bills, so it is deleted before them.',
  },
  {
    table: 'supplier_payments',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 37.96,
    label: 'Supplier payments',
    crossTenantReachable: false,
    rationale: 'Money the tenant paid its suppliers. References suppliers and accounts, so it goes before both.',
  },
  {
    table: 'payment_numbering',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 37.98,
    label: 'Payment numbering',
    crossTenantReachable: false,
    rationale: 'The held payment sequence for a tenant company.',
  },
  {
    table: 'bill_audit_events',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 38.02,
    label: 'Bill audit events',
    crossTenantReachable: false,
    rationale: 'The history of a supplier bill; meaningless once that bill is gone.',
  },
  {
    table: 'bill_lines',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 38.04,
    label: 'Bill lines',
    crossTenantReachable: false,
    rationale: 'Owned through their bill. References accounts, so they are deleted before them.',
  },
  {
    table: 'bills',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 38.06,
    label: 'Supplier bills',
    crossTenantReachable: false,
    rationale: 'The tenant purchase ledger. References suppliers and accounts, so it goes before both.',
  },
  {
    table: 'bill_numbering',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 38.08,
    label: 'Bill numbering',
    crossTenantReachable: false,
    rationale: 'The held bill sequence for a tenant company.',
  },
  {
    table: 'inventory_movements',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 35.92,
    label: 'Stock movements',
    crossTenantReachable: false,
    rationale: 'The immutable quantity ledger. References items, warehouses, units and accounts, so it goes before all of them.',
  },
  {
    table: 'inventory_documents',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 35.94,
    label: 'Stock documents',
    crossTenantReachable: false,
    rationale: 'Receipts, issues, transfers and adjustments. Deleted after the movements that belong to them.',
  },
  {
    table: 'inventory_document_numbering',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 35.96,
    label: 'Stock document numbering',
    crossTenantReachable: false,
    rationale: 'Per-company sequence counters; meaningless once the documents are gone.',
  },
  {
    table: 'inventory_audit_events',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 40.62,
    label: 'Inventory master-data audit events',
    crossTenantReachable: false,
    rationale: 'The history of a tenant catalogue; meaningless once the catalogue is gone.',
  },
  {
    table: 'inventory_settings',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 40.64,
    label: 'Inventory accounting profile',
    crossTenantReachable: false,
    rationale: 'Where a company maps stock to its chart. References accounts and a warehouse, so it goes before both.',
  },
  {
    table: 'inventory_items',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 40.66,
    label: 'Items',
    crossTenantReachable: false,
    rationale: 'The product and service catalogue. References units, tax codes and accounts, so it is deleted before them — and deleted AFTER bill and invoice lines, which name an item under a RESTRICT key and would refuse to let it go.',
  },
  {
    table: 'warehouses',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 40.68,
    label: 'Warehouses',
    crossTenantReachable: false,
    rationale: 'Where stock will be held. Deleted after the settings row that may point at one, and after the bill and invoice lines that name one under a RESTRICT key.',
  },
  {
    table: 'units_of_measure',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 40.7,
    label: 'Units of measure',
    crossTenantReachable: false,
    rationale: 'How items are counted. Deleted after the items that name them.',
  },
  {
    table: 'business_party_audit_events',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 40.72,
    label: 'Business party audit events',
    crossTenantReachable: false,
    rationale: 'The history of a tenant counterparty record; meaningless once that party is gone.',
  },
  {
    table: 'business_party_customer_profiles',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 40.74,
    label: 'Customer profiles',
    crossTenantReachable: false,
    rationale: 'The customer role of a business party. References accounts, so it is deleted before them.',
  },
  {
    table: 'business_party_supplier_profiles',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 40.75,
    label: 'Supplier profiles',
    crossTenantReachable: false,
    rationale: 'The supplier role of a business party. References accounts, so it is deleted before them.',
  },
  {
    table: 'business_party_addresses',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 40.76,
    label: 'Business party addresses',
    crossTenantReachable: false,
    rationale: 'Owned through its party; deleted before it.',
  },
  {
    table: 'business_parties',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 40.78,
    label: 'Business parties',
    crossTenantReachable: false,
    rationale: 'The tenant counterparty directory: customers today, suppliers when Purchasing migrates. Deleted AFTER the bills and invoices that name a party, which hold it under a RESTRICT key.',
  },
  {
    table: 'invoice_audit_events',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 40.1,
    label: 'Invoice audit events',
    crossTenantReachable: false,
    rationale: 'The history of a tenant invoice; meaningless once that invoice is gone.',
  },
  {
    table: 'invoice_payments',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 40.2,
    label: 'Invoice payments',
    crossTenantReachable: false,
    rationale: 'Owned through its invoice; deleted before the journal entries it references.',
  },
  {
    table: 'invoice_lines',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 40.3,
    label: 'Invoice lines',
    crossTenantReachable: false,
    rationale: 'Owned through its invoice; deleted before the accounts each line points at.',
  },
  {
    table: 'invoice_numbering',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 40.4,
    label: 'Invoice numbering',
    crossTenantReachable: false,
    rationale: 'Per-entity document sequences. Nothing references them.',
  },
  {
    table: 'invoices',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 40.5,
    label: 'Sales invoices',
    crossTenantReachable: false,
    rationale: 'Tenant sales documents; deleted before the journal entries they posted.',
  },
  {
    table: 'opening_balance_sets',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 43.5,
    label: 'Opening balance migrations',
    crossTenantReachable: false,
    rationale: 'Tenant migration workflow metadata; deleted before the authoritative journal entries it references.',
  },
  {
    table: 'journal_entries',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 44,
    label: 'Journal entries',
    crossTenantReachable: false,
    rationale: 'The tenant’s ledger. Deleted only for a disposable tenant, by the classification gate.',
  },
  {
    table: 'accounts',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 45,
    label: 'Chart of accounts',
    crossTenantReachable: false,
    rationale: 'Deleted after the lines that reference it, which is why it sits later in the order.',
  },
  {
    table: 'accounting_periods',
    ownershipKey: 'organization_id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 46,
    label: 'Accounting periods',
    crossTenantReachable: false,
    rationale: 'The tenant’s own open/closed calendar.',
  },
  {
    table: 'organizations',
    ownershipKey: 'id',
    kind: 'authoritative',
    disposition: 'delete',
    order: 90,
    label: 'The organization record',
    crossTenantReachable: false,
    rationale: 'The tenant itself, deleted only after everything keyed to it.',
  },
  {
    table: 'audit_logs',
    ownershipKey: 'organization_id',
    kind: 'immutable_audit',
    disposition: 'detach',
    order: 100,
    label: 'Audit entries',
    crossTenantReachable: true,
    rationale:
      'ON DELETE SET NULL by design: the record that something was destroyed cannot be destroyed with it. Action, actor and timestamp survive; the tombstone carries the legal name so the trail stays readable.',
  },
  {
    table: 'users',
    ownershipKey: 'organization_memberships.user_id',
    kind: 'shared',
    disposition: 'retain',
    order: 110,
    label: 'Global identities',
    crossTenantReachable: true,
    rationale:
      'Credentials belong to the global identity, never to one subscriber. Deleted only when separately proven orphaned and test/demo classified — see identity rules in cleanupService.',
  },
  {
    table: 'auth_sessions',
    ownershipKey: 'user_id',
    kind: 'shared',
    disposition: 'retain',
    order: 120,
    label: 'Sessions',
    crossTenantReachable: true,
    rationale:
      'Keyed to a person, not a tenant. Revoked for members losing their last membership; a user active elsewhere keeps their access.',
  },
  {
    table: 'password_reset_tokens',
    ownershipKey: 'user_id',
    kind: 'shared',
    disposition: 'retain',
    order: 130,
    label: 'Password-reset and invitation tokens',
    crossTenantReachable: true,
    rationale: 'Deleted only alongside an identity that is itself being deleted.',
  },
  {
    table: 'platform_user_roles',
    ownershipKey: 'user_id',
    kind: 'shared',
    disposition: 'retain',
    order: 140,
    label: 'Platform operator roles',
    crossTenantReachable: true,
    rationale: 'Platform authority is global. Its presence is a non-waivable blocker, so this is never reached.',
  },
  {
    table: 'subscription_plans',
    ownershipKey: '(none)',
    kind: 'shared',
    disposition: 'retain',
    order: 150,
    label: 'Subscription plans',
    crossTenantReachable: true,
    rationale: 'Platform catalogue shared by every tenant.',
  },
  {
    table: 'billing_settings',
    ownershipKey: '(none)',
    kind: 'shared',
    disposition: 'retain',
    order: 160,
    label: 'Billing settings',
    crossTenantReachable: true,
    rationale: 'A platform-wide singleton, not tenant-owned despite naming an updating user.',
  },
  {
    table: 'bank_details',
    ownershipKey: '(none)',
    kind: 'shared',
    disposition: 'retain',
    order: 170,
    label: 'Bank details',
    crossTenantReachable: true,
    rationale: 'A platform-wide singleton.',
  },
];

/** The tables a tenant deletion actually issues DELETE statements against, in order. */
export const DELETION_SEQUENCE = TENANT_DEPENDENCIES.filter((d) => d.disposition === 'delete').sort(
  (a, b) => a.order - b.order,
);

/**
 * Tables holding rows keyed directly by `organization_id` that the preview
 * counts. `payment_proofs` is reached through its invoice and is counted
 * separately.
 */
export const DIRECTLY_OWNED_TABLES = [
  /* Sales invoices, children first — see migration 019. */
  'platform_preview_sessions',
  'organization_language_changes',
  /* Business parties, children first — see migration 030. */
  /* Supplier payments, children first — see migration 036. Before the bills
   * their allocations point at. */
  'payment_audit_events',
  'payment_allocations',
  'supplier_payments',
  'payment_numbering',
  /* Supplier bills, children first — see migration 034. */
  'bill_audit_events',
  'bill_lines',
  'bills',
  'bill_numbering',
  /* Inventory movements, children first — see migration 038. Before the
   * documents they belong to and the master data they reference. */
  'inventory_movements',
  'inventory_documents',
  'inventory_document_numbering',
  /* Inventory master data, children first — see migration 037. Before the
   * accounts, tax codes and units these rows reference with ON DELETE RESTRICT. */
  'inventory_audit_events',
  'inventory_settings',
  'inventory_items',
  'warehouses',
  'units_of_measure',
  'business_party_audit_events',
  'business_party_customer_profiles',
  'business_party_supplier_profiles',
  'business_party_addresses',
  'business_parties',
  'invoice_audit_events',
  'invoice_payments',
  'invoice_lines',
  'invoice_numbering',
  'invoices',
  'accounting_audit_events',
  'journal_entry_versions',
  'journal_lines',
  'opening_balance_sets',
  'journal_entries',
  'accounts',
  'accounting_periods',
  /* After the books: the accounting tables reference it with ON DELETE RESTRICT. */
  'companies',
  'legal_acceptances',
  'organization_legal_country_changes',
  'subscription_invoices',
  'subscriber_data_exports',
  'user_permission_overrides',
  'subscription_package_changes',
  'organization_entitlements',
  'subscription_applications',
  'organization_memberships',
  'subscriptions',
] as const;

export type DirectlyOwnedTable = (typeof DIRECTLY_OWNED_TABLES)[number];

/**
 * Every table in the live database with a foreign key to `organizations(id)`.
 *
 * Read from the catalogue rather than from a list, so the inventory test is
 * checking reality instead of checking another hand-written list against a
 * hand-written list.
 */
export async function organizationReferencingTables(db: Kysely<Database>): Promise<string[]> {
  const result = await sql<{ table_name: string }>`
    SELECT DISTINCT tc.table_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'organizations'
      AND tc.table_schema = 'public'
    ORDER BY tc.table_name
  `.execute(db);

  return result.rows.map((r) => r.table_name);
}

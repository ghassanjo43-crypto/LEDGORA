/**
 * Kysely table interfaces — the compile-time shape of the PostgreSQL schema.
 * Kept in step with `db/migrations`. Every query in the codebase is built
 * through Kysely, so all values are parameterized by construction.
 */
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * `timestamptz`: selected as a Date, optional on insert (database default
 * supplies it), settable on update. Deliberately NOT wrapped in `Generated<>` —
 * that nests ColumnType and makes the update type unusable.
 */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export type UserStatus = 'active' | 'disabled' | 'locked' | 'pending_verification';
export type PlatformRole = 'super_admin' | 'billing_admin' | 'support';
/**
 * The authority ladder inside one subscriber organization, strongest first.
 *
 * `admin` and `manager` were added by migration 006. `admin` is the
 * "Organization Admin" authority level — it may administer people inside its own
 * tenant, which `owner` also may; the distinction is that ownership is a single
 * transferable position tied to the organization's existence, while `admin` is a
 * role any number of members may hold.
 */
export type OrganizationRole = 'owner' | 'admin' | 'manager' | 'accountant' | 'member' | 'viewer';
export type MembershipStatus = 'active' | 'invited' | 'suspended';
/**
 * `archived` is the normal end state for a subscriber: out of circulation, every
 * record retained, restorable by an administrator. `closed` predates it and is
 * kept so existing rows keep their meaning.
 */
export type OrganizationStatus =
  | 'active'
  | 'suspended'
  | 'archived'
  /**
   * Deletion has been requested and a purge date recorded. Distinct from
   * `archived`: both are out of circulation with everything retained, but only
   * this one is scheduled to be destroyed, and only this one can be cancelled.
   */
  | 'pending_deletion'
  | 'closed';

/**
 * Is this real customer data?
 *
 * A THIRD axis, independent of lifecycle and subscription status. An archived
 * tenant is still production; a trial subscription is not demo data. Only `test`
 * and `demo` records may ever be permanently deleted, and `production` is the
 * default so a forgotten field fails closed.
 */
export type DataClassification = 'production' | 'test' | 'demo';

/** Lifecycle of a generated subscriber data export. */
export type DataExportStatus = 'pending' | 'ready' | 'downloaded' | 'failed' | 'revoked';
export type SubscriptionStatus =
  | 'draft'
  | 'pending_payment'
  | 'pending_verification'
  | 'active'
  | 'past_due'
  | 'suspended'
  | 'cancelled'
  | 'expired'
  | 'rejected';
export type InvoiceStatus = 'issued' | 'proof_submitted' | 'paid' | 'rejected' | 'cancelled';
export type PaymentProofStatus = 'submitted' | 'approved' | 'rejected' | 'more_information_required';
export type BillingCycle = 'monthly' | 'annual';

/**
 * A user-scoped permission override. `deny` is evaluated BEFORE `grant`, so an
 * explicit refusal always wins — see `services/permissionService`.
 */
export type PermissionEffect = 'grant' | 'deny';

/** What a single-use password token was issued for. */
export type TokenPurpose = 'invitation' | 'reset';

/**
 * Where an applicant stands in the onboarding funnel.
 *
 * `dormant_applicant` is deliberately NOT here: dormancy is derived at read time
 * from `last_activity_at`, so an inactive prospect is *shown* as dormant without
 * losing the stage they actually reached — and comes back automatically the
 * moment they sign in again.
 */
export type ApplicationStatus =
  | 'registered_no_package'
  | 'package_selected'
  | 'awaiting_payment'
  | 'pending_verification'
  | 'active_subscriber'
  | 'suspended'
  | 'archived';

export interface UsersTable {
  id: Generated<string>;
  email: string;
  /** Lower-cased email; carries the case-insensitive unique constraint. */
  normalized_email: string;
  password_hash: string;
  full_name: string;
  email_verified_at: Timestamp | null;
  status: UserStatus;
  must_change_password: Generated<boolean>;
  failed_login_count: Generated<number>;
  locked_until: Timestamp | null;
  last_login_at: Timestamp | null;
  /**
   * When the CURRENT password stops being accepted. Set only for an
   * administrator-issued temporary password; null means "does not expire".
   */
  password_expires_at: Timestamp | null;
  disabled_at: Timestamp | null;
  /** Soft deletion, for an account that must stay referenceable. */
  deleted_at: Timestamp | null;
  /**
   * Set when personal fields have been replaced. The row and its id survive, so
   * every historical foreign key — audit actor, proof uploader — keeps resolving.
   */
  anonymized_at: Timestamp | null;
  /**
   * Per-IDENTITY classification, deliberately NOT inherited from an
   * organization. Somebody invited into a demo tenant may be a real user with a
   * membership elsewhere; deleting that tenant must not make them disposable.
   */
  data_classification: Generated<DataClassification>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface PlatformUserRolesTable {
  id: Generated<string>;
  user_id: string;
  role: PlatformRole;
  created_at: Timestamp;
  created_by: string | null;
}

/**
 * A server-issued subscriber preview session.
 *
 * Preview is something the server GRANTS, not something a request asserts: the
 * credential exists only because a start request was made, which is the same
 * moment the audit row was written. Access and evidence of access are one event.
 */
export interface PlatformPreviewSessionsTable {
  id: Generated<string>;
  /** The real administrator. Preview never changes who the caller is. */
  admin_user_id: string;
  organization_id: string;
  /** SHA-256 of the issued credential; the credential itself is never stored. */
  token_hash: string;
  started_at: Generated<Timestamp>;
  /** What actually bounds access — an explicit exit is not guaranteed. */
  expires_at: Timestamp;
  ended_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

/**
 * A set of books, as the SERVER knows it.
 *
 * The books themselves still live in the browser; this is the registry that
 * makes one fact about them authoritative — the bookkeeping language, which
 * must bind every member and survive a determined user with devtools.
 */
export interface CompaniesTable {
  id: Generated<string>;
  organization_id: string;
  /** The browser-side id for the same books. Text: not a uuid. */
  client_reference: string;
  legal_name: Generated<string>;
  /** Null until chosen. A default would be indistinguishable from a decision. */
  bookkeeping_language: string | null;
  /** Set once. A database trigger refuses every later change to it. */
  language_locked_at: Timestamp | null;
  language_selected_by: string | null;
  /**
   * NULL means PROVISIONAL: created automatically with the organization, and
   * still waiting for a client to claim it. The first browser registration
   * adopts this very row — same server id — rather than adding a second one.
   *
   * A partial unique index allows at most one such row per organization.
   */
  adopted_at: Timestamp | null;
  adopted_by: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/** Why a language changed, kept beyond log retention. */
/**
 * Accounting settings for ONE set of books.
 *
 * Per company, never per organization: fiscal year, reporting framework and tax
 * registration decide what the numbers mean, and two companies under one
 * subscriber legitimately differ on all three. `organizations` keeps its copies
 * as onboarding defaults only.
 */
export interface CompanySettingsTable {
  organization_id: string;
  company_id: string;
  /** ISO month-day, e.g. '01-01'. */
  fiscal_year_start: Generated<string>;
  books_start_date: string | null;
  /** Accrual only — a CHECK permits no other value until cash basis exists. */
  accounting_basis: Generated<'accrual'>;
  reporting_framework: Generated<'IFRS' | 'IFRS_FOR_SMES' | 'US_GAAP' | 'OTHER'>;
  tax_registered: Generated<boolean>;
  tax_registration_number: Generated<string>;
  /** A percentage held exactly, as a decimal string. Never a float. */
  default_tax_rate: ColumnType<string, string | number | undefined, string | number>;
  organization_type: Generated<string>;
  industry_type: Generated<string>;
  logo_url: Generated<string>;
  email: Generated<string>;
  phone: Generated<string>;
  website: Generated<string>;
  country: Generated<string>;
  state_province: Generated<string>;
  city: Generated<string>;
  address_line1: Generated<string>;
  address_line2: Generated<string>;
  postal_code: Generated<string>;
  /** Optimistic concurrency token. */
  version: Generated<number>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface OrganizationLanguageChangesTable {
  id: Generated<string>;
  organization_id: string;
  field: 'interface_language' | 'document_language';
  previous_value: string;
  new_value: string;
  reason: string;
  changed_by: string | null;
  changed_at: Generated<Timestamp>;
}

/**
 * Evidence of who accepted which legal document, at which version, having been
 * shown exactly which text. Append-only, enforced by a trigger (migration 024).
 */
export interface LegalAcceptancesTable {
  id: Generated<string>;
  user_id: string;
  organization_id: string;
  /** The legal country as it was AT ACCEPTANCE — copied, never joined. */
  legal_country: 'AE' | 'JO' | 'SA';
  /**
   * Which legal act this row records.
   *
   * `organization` binds the company and requires authority; `individual` is
   * one person acknowledging for themselves and binds nobody else. Two acts,
   * never collapsed into one.
   */
  scope: 'organization' | 'individual';
  document_id: 'master-terms' | 'addendum-ae' | 'addendum-jo' | 'addendum-sa';
  version: string;
  /** SHA-256 of the canonical text shown. Verifiable by a third party. */
  content_hash: string;
  binding_authority_confirmed: Generated<boolean>;
  accepted_as_role: string | null;
  /** Server time. Never client-supplied. */
  accepted_at: Generated<Date>;
  user_agent: string | null;
  created_at: Generated<Date>;
}

/**
 * Every change to an organization's registered legal country.
 *
 * Its own table rather than a generic audit row because the change has a
 * specific consequence a reader must be able to see: it supersedes the previous
 * Country Addendum acceptance. Append-only (migration 024).
 */
export interface OrganizationLegalCountryChangesTable {
  id: Generated<string>;
  organization_id: string;
  /** Null on first selection — there was no previous value. */
  previous_country: 'AE' | 'JO' | 'SA' | null;
  new_country: 'AE' | 'JO' | 'SA';
  changed_by_user_id: string | null;
  changed_by_role: string | null;
  /** How the actor held the authority, for the record. */
  authority: string;
  reason: string | null;
  changed_at: Generated<Date>;
}

export interface OrganizationsTable {
  id: Generated<string>;
  subscriber_owner_user_id: string;
  legal_name: string;
  trading_name: string | null;
  country: string;
  /**
   * The country the organization is legally REGISTERED in, restricted to the
   * three Ledgora is offered in. Distinct from `country` above, which is
   * unconstrained descriptive text and must never decide which Country
   * Addendum governs a contract. Null until the owner has been asked — it
   * cannot be inferred. See migration 024.
   */
  legal_country: 'AE' | 'JO' | 'SA' | null;
  registration_number: string | null;
  tax_number: string | null;
  industry: string | null;
  base_currency: string;
  /**
   * The language of SCREENS for everyone in this organization.
   *
   * A company-wide default so members do not each see a different product.
   * Whether an individual may override it is `interface_language_locked` —
   * an Arabic-only bookkeeper and an English-only auditor may both need these
   * books, and no compliance rule requires forcing one of them out.
   */
  interface_language: Generated<string>;
  /**
   * The language of DOCUMENTS: invoices sent to customers, UBL submitted to an
   * authority. This is the compliance-relevant one — a tax document reissued in
   * a different language from the one already cleared is a different document.
   */
  document_language: Generated<string>;
  interface_language_locked: Generated<boolean>;
  fiscal_year_start: string;
  books_start_date: string | null;
  status: Generated<OrganizationStatus>;
  /** Operator-only notes. Never returned on a customer-facing surface. */
  internal_notes: string | null;
  archived_at: Timestamp | null;
  archived_by: string | null;
  archive_reason: string | null;
  /** A purge is requested first and carried out afterwards, never in one click. */
  deletion_requested_at: Timestamp | null;
  deletion_eligible_after: Timestamp | null;
  /** The operator who requested the purge, for the audit trail. */
  deletion_requested_by: string | null;
  /** Why it was requested. Mandatory at request time. */
  deletion_reason: string | null;
  /**
   * production | test | demo. Only the latter two may be permanently deleted.
   * A database trigger refuses any move away from `production`.
   */
  data_classification: Generated<DataClassification>;
  classified_production_at: Timestamp;
  classified_by: string | null;
  /**
   * When a human last confirmed this classification, or null when the only
   * thing that ever set it was the 008 migration default. Null means "nobody
   * has looked", never "not production".
   */
  classification_reviewed_at: Timestamp | null;
  classification_reviewed_by: string | null;
  /**
   * Set inside the deletion transaction, under this row's lock. A tenant write
   * arriving mid-destruction is refused rather than creating a row that belongs
   * to an organization which is about to stop existing.
   */
  deletion_in_progress: Generated<boolean>;
  classification_reason: string | null;
  /** A hard block no eligibility calculation may override. */
  legal_hold: Generated<boolean>;
  legal_hold_reason: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OrganizationMembershipsTable {
  id: Generated<string>;
  organization_id: string;
  user_id: string;
  role: OrganizationRole;
  status: Generated<MembershipStatus>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SubscriptionPlansTable {
  id: Generated<string>;
  code: string;
  name: string;
  description: string | null;
  edition: string;
  currency: string;
  monthly_price: string;
  annual_price: string | null;
  user_limit: number;
  entity_limit: number;
  storage_limit: number | null;
  bandwidth_limit: number | null;
  /** jsonb array of module identifiers. */
  module_entitlements: ColumnType<string[], string | string[], string | string[]>;
  is_public: Generated<boolean>;
  is_active: Generated<boolean>;
  sort_order: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SubscriptionsTable {
  id: Generated<string>;
  organization_id: string;
  plan_id: string | null;
  status: SubscriptionStatus;
  billing_cycle: Generated<BillingCycle>;
  starts_at: Timestamp | null;
  expires_at: Timestamp | null;
  grace_ends_at: Timestamp | null;
  user_limit: number | null;
  entity_limit: number | null;
  /** Per-tenant storage override; null falls back to the plan's own limit. */
  storage_limit: ColumnType<string | null, string | number | null | undefined, string | number | null>;
  /** Optional modules bought ON TOP of the plan. jsonb array of module ids. */
  extra_modules: ColumnType<string[], string | string[] | undefined, string | string[]>;
  payment_reference: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SubscriptionInvoicesTable {
  id: Generated<string>;
  invoice_number: string;
  organization_id: string;
  subscription_id: string;
  currency: string;
  subtotal: string;
  tax: Generated<string>;
  total: string;
  status: Generated<InvoiceStatus>;
  payment_reference: string;
  issued_at: Timestamp;
  due_at: Timestamp;
  paid_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface PaymentProofsTable {
  id: Generated<string>;
  invoice_id: string;
  uploaded_by_user_id: string;
  file_name: string;
  /** Opaque storage key. The file itself never lives in PostgreSQL. */
  storage_key: string;
  mime_type: string;
  file_size: number;
  bank_transaction_reference: string | null;
  ledgora_payment_reference: string;
  amount: string;
  paid_at: Timestamp;
  note: string | null;
  status: Generated<PaymentProofStatus>;
  reviewed_by_user_id: string | null;
  reviewed_at: Timestamp | null;
  rejection_reason: string | null;
  information_request: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BillingSettingsTable {
  id: Generated<string>;
  currency: Generated<string>;
  payment_due_days: Generated<number>;
  grace_days: Generated<number>;
  term_months: Generated<number>;
  updated_at: Timestamp;
  updated_by: string | null;
}

export interface BankDetailsTable {
  id: Generated<string>;
  bank_name: string;
  account_name: string;
  account_number: string;
  iban: string | null;
  swift: string | null;
  branch: string | null;
  instructions: string | null;
  /** True while the shipped placeholder values are still in place. */
  is_placeholder: Generated<boolean>;
  updated_at: Timestamp;
  updated_by: string | null;
}

export interface AuthSessionsTable {
  id: Generated<string>;
  user_id: string;
  /** SHA-256 of the session token. The raw token is never stored. */
  token_hash: string;
  expires_at: Timestamp;
  last_used_at: Timestamp;
  revoked_at: Timestamp | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Timestamp;
}

/**
 * One row per registered customer, created with the account itself. This is the
 * record the administrator's applicant roster is built on — it exists long
 * before an organization, a package or a subscription does.
 */
export interface SubscriptionApplicationsTable {
  id: Generated<string>;
  /** Unique — one application per account. */
  user_id: string;
  organization_id: string | null;
  selected_plan_id: string | null;
  subscription_id: string | null;
  status: Generated<ApplicationStatus>;
  registered_at: Timestamp;
  package_selected_at: Timestamp | null;
  payment_started_at: Timestamp | null;
  proof_uploaded_at: Timestamp | null;
  activated_at: Timestamp | null;
  last_activity_at: Timestamp;
  /** How the applicant arrived: `self_registration`, `backfill`, … */
  source: Generated<string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * A single-use password reset link.
 *
 * Only the SHA-256 hash is stored — the same rule `auth_sessions` follows. A
 * reset link is a bearer credential, so the database must not hold anything that
 * could be replayed if it leaked.
 */
export interface PasswordResetTokensTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  /** The operator who issued it, when an administrator did. */
  issued_by_user_id: string | null;
  /**
   * Which act this token serves. `invitation` is first-time password setup for
   * an account that has never had a usable one; `reset` replaces an existing
   * password. The redemption path is the same, but the audit trail is not.
   */
  purpose: Generated<TokenPurpose>;
  /**
   * Withdrawn by an administrator before it was used. Distinct from `used_at`:
   * a revoked token was never redeemed, and conflating the two would record a
   * cancellation as if the recipient had acted on it.
   */
  revoked_at: Timestamp | null;
  created_at: Timestamp;
}

/**
 * One administrator's decision about one person's access to one action, inside
 * one organization.
 *
 * Rows here are the ONLY user-scoped permission state in the system. They are
 * never consulted directly: `services/permissionService` resolves them against
 * the role template and the organization's entitlement, in that order, and a row
 * whose module the tenant no longer owns is refused rather than deleted.
 */
export interface UserPermissionOverridesTable {
  id: Generated<string>;
  user_id: string;
  organization_id: string;
  /** A subject id from `config/permissionCatalog`. */
  subject: string;
  /** An action id from `config/permissionCatalog`. */
  action: string;
  effect: PermissionEffect;
  reason: string | null;
  granted_by_user_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * The RESOLVED entitlement for one organization.
 *
 * Derived state, recomputed by `recalculateEntitlements` from the tenant's
 * subscription and plan — never edited directly and never a second source of
 * truth. It exists so an entitlement read is one indexed row rather than a
 * multi-join, and so a package change has something concrete to invalidate.
 */
export interface OrganizationEntitlementsTable {
  id: Generated<string>;
  organization_id: string;
  subscription_id: string | null;
  plan_id: string | null;
  plan_code: string | null;
  edition: string | null;
  modules: ColumnType<string[], string | string[] | undefined, string | string[]>;
  user_limit: number | null;
  entity_limit: number | null;
  storage_limit: ColumnType<string | null, string | number | null | undefined, string | number | null>;
  status: Generated<string>;
  active: Generated<boolean>;
  starts_at: Timestamp | null;
  expires_at: Timestamp | null;
  computed_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * Package history — append-only.
 *
 * The subscription row carries only the plan in force NOW, so "what did this
 * tenant have before, and who changed it?" needs its own record. Kept for the
 * life of the organization: a downgrade must stay reconstructable.
 */
export interface SubscriptionPackageChangesTable {
  id: Generated<string>;
  organization_id: string;
  subscription_id: string | null;
  previous_plan_id: string | null;
  new_plan_id: string | null;
  previous_plan_code: string | null;
  new_plan_code: string | null;
  previous_status: string | null;
  new_status: string | null;
  previous_modules: ColumnType<string[], string | string[] | undefined, string | string[]>;
  new_modules: ColumnType<string[], string | string[] | undefined, string | string[]>;
  previous_user_limit: number | null;
  new_user_limit: number | null;
  direction: Generated<string>;
  effective_at: Timestamp;
  reason: string;
  changed_by_user_id: string | null;
  created_at: Timestamp;
}

/**
 * A generated subscriber data export.
 *
 * Only the SHA-256 hash of the download token is stored — a download link is a
 * bearer credential, and the same rule that governs `auth_sessions` and
 * `password_reset_tokens` applies here.
 */
export interface SubscriberDataExportsTable {
  id: Generated<string>;
  organization_id: string;
  requested_by: string | null;
  status: Generated<DataExportStatus>;
  token_hash: string;
  expires_at: Timestamp;
  /** The generated JSON. Built by an allow-list projection, never `SELECT *`. */
  payload: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  byte_size: number | null;
  section_counts: ColumnType<Record<string, number>, string | undefined, string>;
  error_message: string | null;
  first_downloaded_at: Timestamp | null;
  download_count: Generated<number>;
  revoked_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * What survives a tenant's destruction.
 *
 * No foreign key to `organizations` — the row it would point at is the thing
 * being deleted. Counts and identifiers only: never accounting content, document
 * bodies, credentials, hashes or invitation secrets. The question this answers
 * is "was this destroyed, by whom, and how much of it", not "what did it say".
 */
export interface SubscriberDeletionTombstonesTable {
  id: Generated<string>;
  operation_id: string;
  request_id: string | null;
  organization_id: string;
  deleted_by_user_id: string | null;
  legal_name: string;
  deleted_by_email: string | null;
  classification_at_deletion: string;
  reason: string;
  previewed_at: Timestamp;
  executed_at: Generated<Timestamp>;
  removed_counts: ColumnType<Record<string, number>, string | undefined, string>;
  identities_deleted: Generated<string[]>;
  identities_retained: Generated<string[]>;
  /** Rows in this database. `completed | failed`. */
  database_deletion_status: Generated<string>;
  /**
   * The tenant's accounting books. Always `no_server_workspace` in this
   * deployment — they live in browser storage, so the server has none to delete.
   */
  workspace_deletion_status: Generated<string>;
  /** Objects in file storage. `none | pending | completed | failed`. */
  external_cleanup_status: Generated<string>;
  /** The aggregate of the three above. */
  outcome: string;
  failure_summary: string | null;
  created_at: Timestamp;
}

/** Durable intent to delete an external object. Written before the row naming it. */
export interface FileCleanupQueueTable {
  id: Generated<string>;
  operation_id: string;
  organization_id: string;
  storage_key: string;
  source_table: string;
  source_id: string | null;
  status: Generated<'pending' | 'completed' | 'failed'>;
  attempts: Generated<number>;
  last_error: string | null;
  last_attempted_at: Timestamp | null;
  completed_at: Timestamp | null;
  created_at: Timestamp;
}

/** One confirmed cleanup run. Makes a replayed confirmation idempotent. */
export interface CleanupOperationsTable {
  operation_id: string;
  requested_by_user_id: string | null;
  preview_digest: string;
  organization_ids: string[];
  reason: string;
  previewed_at: Timestamp;
  status: Generated<'pending' | 'completed' | 'failed'>;
  result: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  created_at: Timestamp;
  completed_at: Timestamp | null;
}

export interface AuditLogsTable {
  id: Generated<string>;
  actor_user_id: string | null;
  actor_platform_role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  organization_id: string | null;
  metadata: ColumnType<Record<string, unknown>, string | undefined, string>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Timestamp;
}

export interface Database {
  users: UsersTable;
  platform_user_roles: PlatformUserRolesTable;
  organizations: OrganizationsTable;
  legal_acceptances: LegalAcceptancesTable;
  organization_legal_country_changes: OrganizationLegalCountryChangesTable;
  organization_language_changes: OrganizationLanguageChangesTable;
  companies: CompaniesTable;
  company_settings: CompanySettingsTable;
  platform_preview_sessions: PlatformPreviewSessionsTable;
  organization_memberships: OrganizationMembershipsTable;
  subscription_plans: SubscriptionPlansTable;
  subscriptions: SubscriptionsTable;
  subscription_invoices: SubscriptionInvoicesTable;
  payment_proofs: PaymentProofsTable;
  billing_settings: BillingSettingsTable;
  bank_details: BankDetailsTable;
  auth_sessions: AuthSessionsTable;
  subscription_applications: SubscriptionApplicationsTable;
  password_reset_tokens: PasswordResetTokensTable;
  organization_entitlements: OrganizationEntitlementsTable;
  subscription_package_changes: SubscriptionPackageChangesTable;
  user_permission_overrides: UserPermissionOverridesTable;
  subscriber_data_exports: SubscriberDataExportsTable;
  audit_logs: AuditLogsTable;
  subscriber_deletion_tombstones: SubscriberDeletionTombstonesTable;
  file_cleanup_queue: FileCleanupQueueTable;
  cleanup_operations: CleanupOperationsTable;

  /* Phase A — accounting books. */
  accounting_periods: AccountingPeriodsTable;
  accounts: AccountsTable;
  journal_entries: JournalEntriesTable;
  journal_lines: JournalLinesTable;
  journal_entry_versions: JournalEntryVersionsTable;
  accounting_audit_events: AccountingAuditEventsTable;
  opening_balance_sets: OpeningBalanceSetsTable;
  business_parties: BusinessPartiesTable;
  business_party_addresses: BusinessPartyAddressesTable;
  business_party_customer_profiles: BusinessPartyCustomerProfilesTable;
  business_party_supplier_profiles: BusinessPartySupplierProfilesTable;
  business_party_audit_events: BusinessPartyAuditEventsTable;
  invoices: InvoicesTable;
  invoice_lines: InvoiceLinesTable;
  invoice_payments: InvoicePaymentsTable;
  invoice_numbering: InvoiceNumberingTable;
  invoice_audit_events: InvoiceAuditEventsTable;
  tax_codes: TaxCodesTable;
  tax_rate_versions: TaxRateVersionsTable;
  tax_code_audit_events: TaxCodeAuditEventsTable;
}


/* ══ Phase A — accounting books ═══════════════════════════════════════════════
 *
 * Money is `string` on the way out of PostgreSQL, not `number`: node-postgres
 * hands NUMERIC back as a string precisely so an exact decimal is not silently
 * pushed through a float, and this schema keeps that promise all the way to the
 * service layer.
 */

export interface AccountingPeriodsTable {
  id: Generated<string>;
  organization_id: string;
  /**
   * Which set of books this row belongs to. Scoped WITH `organization_id`,
   * never instead of it: the composite foreign key is what makes a
   * cross-company reference unrepresentable rather than merely refused.
   */
  company_id: string;
  fiscal_year: number;
  period_number: number;
  start_date: string;
  end_date: string;
  /** open | soft_closed | locked */
  status: Generated<string>;
  locked_at: Timestamp | null;
  locked_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AccountsTable {
  id: Generated<string>;
  organization_id: string;
  /**
   * Which set of books this row belongs to. Scoped WITH `organization_id`,
   * never instead of it: the composite foreign key is what makes a
   * cross-company reference unrepresentable rather than merely refused.
   */
  company_id: string;
  account_code: string;
  account_name: string;
  /** asset | liability | equity | income | expense */
  account_type: string;
  account_subtype: string | null;
  /**
   * none | cash_and_cash_equivalents | restricted_cash | bank_overdraft
   *
   * The AUTHORITATIVE answer to "is this account cash", constrained by CHECK
   * rather than inferred from a name. `restricted_cash` is recorded so it can
   * be excluded from the cash-flow figure; `bank_overdraft` is a liability that
   * counts as a negative component of cash under IAS 7.
   */
  cash_classification: Generated<string>;
  /** debit | credit */
  normal_balance: string;
  parent_account_id: string | null;
  restricted_currency: string | null;
  /** Order among SIBLINGS. Ties are broken by account code. */
  sort_order: Generated<number>;
  /**
   * The IFRS presentation classification the chart of accounts screen uses.
   * Finer than `account_type` — four of its values are all `expense` to the
   * ledger — and empty when the caller expressed no opinion.
   */
  presentation_type: Generated<string>;
  ifrs_statement: Generated<string>;
  ifrs_category: Generated<string>;
  ifrs_subcategory: Generated<string>;
  /**
   * Presentation metadata only. NOTHING reads this to prepare a statement: a
   * classified operating/investing/financing cash flow needs each posting
   * mapped to an activity, not each account labelled with one.
   */
  cash_flow_category: Generated<string>;
  profit_or_loss_category: Generated<string>;
  description: Generated<string>;
  industry_tag: Generated<string>;
  is_postable: Generated<boolean>;
  active: Generated<boolean>;
  blocked: Generated<boolean>;
  archived: Generated<boolean>;
  system_account: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface JournalEntriesTable {
  id: Generated<string>;
  organization_id: string;
  /**
   * Which set of books this row belongs to. Scoped WITH `organization_id`,
   * never instead of it: the composite foreign key is what makes a
   * cross-company reference unrepresentable rather than merely refused.
   */
  company_id: string;
  journal_number: string;
  journal_type: Generated<string>;
  transaction_date: string;
  posting_date: string;
  /** draft | posted | reversed | voided */
  status: Generated<string>;
  reference: Generated<string>;
  description: Generated<string>;
  notes: Generated<string>;
  transaction_currency: string;
  functional_currency: string;
  exchange_rate: Generated<string>;
  source_type: string | null;
  /** TEXT, not uuid: a browser-minted `inv_…` is an external reference. */
  source_id: string | null;
  /**
   * WHAT happened to the document — `issue`, `settlement:<id>`,
   * `depreciation:2026-06`. With `source_type` and `source_id` it forms the
   * unique key that makes a repeated posting return the existing journal
   * instead of writing a second one. Null on rows written before 029.
   */
  source_event: string | null;
  original_entry_id: string | null;
  reversal_entry_id: string | null;
  replacement_entry_id: string | null;
  /** Optimistic concurrency token. */
  version: Generated<number>;
  created_by: string | null;
  updated_by: string | null;
  posted_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  posted_at: Timestamp | null;
}

export interface JournalLinesTable {
  id: Generated<string>;
  organization_id: string;
  /**
   * Which set of books this row belongs to. Scoped WITH `organization_id`,
   * never instead of it: the composite foreign key is what makes a
   * cross-company reference unrepresentable rather than merely refused.
   */
  company_id: string;
  journal_entry_id: string;
  line_number: number;
  account_id: string;
  entity_id: string | null;
  project_id: string | null;
  cost_center_id: string | null;
  memo: Generated<string>;
  debit_transaction: Generated<string>;
  credit_transaction: Generated<string>;
  debit_functional: Generated<string>;
  credit_functional: Generated<string>;
  exchange_rate: Generated<string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** An immutable snapshot of an entry as it stood BEFORE a change. */
export interface JournalEntryVersionsTable {
  id: Generated<string>;
  organization_id: string;
  /**
   * Which set of books this row belongs to. Scoped WITH `organization_id`,
   * never instead of it: the composite foreign key is what makes a
   * cross-company reference unrepresentable rather than merely refused.
   */
  company_id: string;
  journal_entry_id: string;
  version: number;
  change_kind: string;
  reason: Generated<string>;
  snapshot: ColumnType<Record<string, unknown>, string, string>;
  changes: ColumnType<unknown[], string | undefined, string>;
  actor_user_id: string | null;
  actor_name: Generated<string>;
  at: Timestamp;
}

/** Append-only accounting audit. Deliberately separate from `audit_logs`. */
export interface AccountingAuditEventsTable {
  id: Generated<string>;
  organization_id: string;
  /**
   * Which set of books this row belongs to. Scoped WITH `organization_id`,
   * never instead of it: the composite foreign key is what makes a
   * cross-company reference unrepresentable rather than merely refused.
   */
  company_id: string;
  action: string;
  record_type: string;
  record_id: string | null;
  actor_user_id: string | null;
  actor_name: Generated<string>;
  reason: Generated<string>;
  previous_version: number | null;
  resulting_version: number | null;
  detail: ColumnType<Record<string, unknown>, string | undefined, string>;
  request_id: string | null;
  at: Timestamp;
}

export interface OpeningBalanceSetsTable {
  id: Generated<string>;
  organization_id: string;
  /**
   * Which set of books this row belongs to. Scoped WITH `organization_id`,
   * never instead of it: the composite foreign key is what makes a
   * cross-company reference unrepresentable rather than merely refused.
   */
  company_id: string;
  journal_entry_id: string;
  bookkeeping_start_date: string;
  opening_balance_date: string;
  status: Generated<string>;
  reference: Generated<string>;
  description: Generated<string>;
  version: Generated<number>;
  prepared_by: string | null;
  submitted_by: string | null;
  submitted_at: Timestamp | null;
  approved_by: string | null;
  approved_at: Timestamp | null;
  posted_by: string | null;
  posted_at: Timestamp | null;
  reversed_by: string | null;
  reversed_at: Timestamp | null;
  reversal_journal_entry_id: string | null;
  replaces_opening_balance_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
export type AuthSession = Selectable<AuthSessionsTable>;


/* ══ Phase B — sales invoices ═════════════════════════════════════════════════
 *
 * Money is `string` here for the same reason it is in the ledger: PostgreSQL
 * returns NUMERIC as a string so an exact decimal is never pushed through a
 * float, and this schema keeps that promise up to the service layer.
 *
 * `issuing_entity_id`, `customer_id` and the dimension ids are plain strings
 * rather than typed references — the business-entity, project and cost-center
 * directories are still browser-resident. See migration 019.
 */

/** Sales-invoice lifecycle. Distinct from the billing `InvoiceStatus` above. */
export type SalesInvoiceStatus =
  | 'draft'
  | 'approved'
  | 'issued'
  | 'sent'
  | 'partially-paid'
  | 'paid'
  | 'void';

export type InvoiceDiscountType = 'percentage' | 'amount';

export type InventoryFulfillmentMode = 'none' | 'issue-on-invoice' | 'delivered-separately';


/* ══ Business parties ═════════════════════════════════════════════════════ */

/**
 * One legal party, holding one or more ROLES.
 *
 * Not a customers table: the product models a party that may be a customer, a
 * supplier or both, sharing one code, one tax number and one address book. See
 * `030_business_parties` for why splitting that duplicates real entities.
 */
export interface BusinessPartiesTable {
  id: Generated<string>;
  organization_id: string;
  /** Scoped WITH `organization_id`, never instead of it. */
  company_id: string;
  party_code: string;
  legal_name: string;
  trading_name: Generated<string>;
  /** Roles, not a kind: dropping one leaves the party and the other intact. */
  is_customer: Generated<boolean>;
  is_supplier: Generated<boolean>;
  contact_person: Generated<string>;
  job_title: Generated<string>;
  email: Generated<string>;
  phone: Generated<string>;
  mobile: Generated<string>;
  website: Generated<string>;
  tax_registration_number: Generated<string>;
  commercial_registration_number: Generated<string>;
  payment_terms: Generated<string>;
  default_currency: Generated<string>;
  bank_name: Generated<string>;
  bank_account_name: Generated<string>;
  iban: Generated<string>;
  swift_code: Generated<string>;
  notes: Generated<string>;
  /** active | archived. There is no deleted state. */
  status: Generated<string>;
  archived_at: Timestamp | null;
  version: Generated<number>;
  created_by: string | null;
  updated_by: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface BusinessPartyAddressesTable {
  id: Generated<string>;
  organization_id: string;
  company_id: string;
  party_id: string;
  /** billing | shipping | registered */
  purpose: Generated<string>;
  is_primary: Generated<boolean>;
  address_line1: Generated<string>;
  address_line2: Generated<string>;
  city: Generated<string>;
  postal_code: Generated<string>;
  country: Generated<string>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/**
 * The customer role's own fields.
 *
 * Separate from the party so the customer route can be handed this table plus
 * the shared one and be structurally unable to write a supplier field.
 */
export interface BusinessPartyCustomerProfilesTable {
  organization_id: string;
  company_id: string;
  party_id: string;
  customer_category: Generated<string>;
  /** numeric, not a float: it is compared against a receivable balance. */
  credit_limit: Generated<string>;
  default_revenue_account_id: string | null;
  default_receivable_account_id: string | null;
  default_invoice_template_id: string | null;
  invoice_delivery_method: Generated<string>;
  customer_payment_terms: Generated<string>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/**
 * The supplier role's own fields.
 *
 * Separate from the party for the reason migration 030 gives: the vendor route
 * can be handed this table and the shared one, and is then STRUCTURALLY unable
 * to write a customer field — the columns are not in a table it touches.
 */
export interface BusinessPartySupplierProfilesTable {
  organization_id: string;
  company_id: string;
  party_id: string;
  supplier_category: Generated<string>;
  /**
   * Accounts Payable control for this supplier.
   *
   * Per supplier, mirroring the receivable on the customer profile. There is no
   * company-level default in this product, so there is no precedence rule.
   */
  default_payable_account_id: string | null;
  /** Master data for a later slice. Nothing posts it: P1 creates no bills. */
  default_expense_account_id: string | null;
  supplier_payment_terms: Generated<string>;
  /** Recorded, never acted on — withholding has no server accounting treatment. */
  withholding_tax_applicable: Generated<boolean>;
  preferred_payment_method: Generated<string>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface BusinessPartyAuditEventsTable {
  id: Generated<string>;
  organization_id: string;
  company_id: string;
  party_id: string;
  action: string;
  actor_user_id: string | null;
  actor_name: Generated<string>;
  reason: Generated<string>;
  previous_version: number | null;
  resulting_version: number | null;
  detail: ColumnType<Record<string, unknown>, string | undefined, string>;
  request_id: string | null;
  at: Generated<Timestamp>;
}

export interface InvoicesTable {
  id: Generated<string>;
  organization_id: string;
  /**
   * Which set of books this row belongs to. Scoped WITH `organization_id`,
   * never instead of it: the composite foreign key is what makes a
   * cross-company reference unrepresentable rather than merely refused.
   */
  company_id: string;
  issuing_entity_id: string;
  customer_id: string;
  invoice_number: string;
  status: Generated<SalesInvoiceStatus>;
  issue_date: string;
  due_date: string;
  transaction_currency: string;
  functional_currency: string;
  exchange_rate: Generated<string>;
  purchase_order_reference: Generated<string>;
  customer_reference: Generated<string>;
  salesperson_id: string | null;
  project_id: string | null;
  cost_center_id: string | null;
  template_id: string | null;
  template_version_id: string | null;
  template_resolution_source: string | null;
  /** Frozen presentation, so a reprint matches what the customer received. */
  template_snapshot: ColumnType<unknown, string | null, string | null>;
  subtotal: Generated<string>;
  discount_total: Generated<string>;
  tax_total: Generated<string>;
  additional_charges_total: Generated<string>;
  grand_total: Generated<string>;
  amount_paid: Generated<string>;
  credits_applied: Generated<string>;
  balance_due: Generated<string>;
  notes: Generated<string>;
  terms: Generated<string>;
  payment_terms: Generated<string>;
  journal_entry_id: string | null;
  reversal_journal_entry_id: string | null;
  void_reason: string | null;
  /**
   * The accounts this invoice posted against, recorded at issue.
   *
   * A receipt credits the receivable the invoice DEBITED; without this the
   * settlement path would have to be told, and any account it was told would
   * balance the entry while leaving the real receivable outstanding.
   */
  receivable_account_id: string | null;
  tax_account_id: string | null;
  additional_charges_account_id: string | null;
  issued_at: Timestamp | null;
  sent_at: Timestamp | null;
  paid_at: Timestamp | null;
  voided_at: Timestamp | null;
  version: Generated<number>;
  created_by: string | null;
  updated_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface InvoiceLinesTable {
  id: Generated<string>;
  organization_id: string;
  /**
   * Which set of books this row belongs to. Scoped WITH `organization_id`,
   * never instead of it: the composite foreign key is what makes a
   * cross-company reference unrepresentable rather than merely refused.
   */
  company_id: string;
  invoice_id: string;
  line_number: number;
  account_id: string;
  item_id: string | null;
  description: Generated<string>;
  quantity: Generated<string>;
  unit: Generated<string>;
  unit_price: Generated<string>;
  discount_type: InvoiceDiscountType | null;
  discount_value: string | null;
  /**
   * The code AND the rate and amount it produced. A tax code's rate is
   * effective-dated; an invoice must keep reporting the tax it actually
   * charged, not what the code says today.
   */
  tax_code_id: string | null;
  tax_rate: Generated<string>;
  tax_amount: Generated<string>;
  line_subtotal: Generated<string>;
  line_total: Generated<string>;
  entity_id: string | null;
  project_id: string | null;
  cost_center_id: string | null;
  cost_center_assignments: ColumnType<unknown, string | null, string | null>;
  inventory_item_id: string | null;
  warehouse_id: string | null;
  inventory_fulfillment_mode: InventoryFulfillmentMode | null;
  issued_unit_cost: string | null;
  /*
   * The FROZEN tax snapshot, written at issue and never recomputed.
   *
   * Denormalised on purpose: `tax_code_id` alone would leave an issued invoice
   * depending on mutable current configuration, so archiving a code or
   * end-dating a rate would change what a posted document says it charged.
   * These columns are what was actually charged, and only a reversal may write
   * a different set.
   */
  tax_rate_version_id: string | null;
  tax_code_code: string | null;
  tax_code_name: string | null;
  tax_category: SalesTaxCategory | null;
  tax_calculation_method: SalesTaxMethod | null;
  tax_rate_effective_from: string | null;
  tax_rate_effective_to: string | null;
  taxable_amount: Generated<string>;
  tax_account_id: string | null;
  /** The date the rate was resolved on — this invoice's `issue_date`. */
  tax_point_date: string | null;
  tax_snapshot_at: Timestamp | null;
  created_at: Timestamp;
}

/**
 * The categories the server can stand behind, and why the list stops here.
 *
 * Zero-rated, exempt and out-of-scope all charge nothing, and collapsing them
 * would be the easy mistake: they are legally distinct and reported
 * separately — a zero-rated export belongs in a different box from an exempt
 * supply, and an out-of-scope item is not in the return at all. Reverse-charge,
 * import, self-assessed and withholding are absent because each posts to
 * accounts this slice has no controlled mapping for.
 */
export type SalesTaxCategory = 'standard' | 'reduced' | 'zero-rated' | 'exempt' | 'out-of-scope';

/** Percentage only. Fixed, compound and self-assessed are refused explicitly. */
export type SalesTaxMethod = 'exclusive' | 'inclusive';

export type SalesTaxStatus = 'active' | 'inactive' | 'archived';

export interface TaxCodesTable {
  id: Generated<string>;
  organization_id: string;
  company_id: string;
  code: string;
  name: string;
  description: Generated<string>;
  category: SalesTaxCategory;
  calculation_method: SalesTaxMethod;
  status: Generated<SalesTaxStatus>;
  /**
   * Where output tax credits. Per CODE rather than per company because §12
   * makes the code resolve its own account: one company-wide default would
   * force two legally distinct taxes into one control account and make a
   * reconciliation that has to separate them impossible.
   */
  output_tax_account_id: string | null;
  effective_from: string;
  effective_to: string | null;
  version: Generated<number>;
  created_by: string | null;
  updated_by: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/**
 * A rate is a property of a code ON A DATE, not of the code.
 *
 * One stored number would mean a rate rise silently rewrote every invoice ever
 * issued under the old one — including the documents a tax authority already
 * holds copies of.
 */
export interface TaxRateVersionsTable {
  id: Generated<string>;
  organization_id: string;
  company_id: string;
  tax_code_id: string;
  /** A PERCENTAGE held exactly, as a decimal string. Never a float. */
  rate: string;
  effective_from: string;
  effective_to: string | null;
  output_tax_account_id: string | null;
  created_by: string | null;
  created_at: Generated<Timestamp>;
}

export interface TaxCodeAuditEventsTable {
  id: Generated<string>;
  organization_id: string;
  company_id: string;
  tax_code_id: string;
  action: string;
  detail: ColumnType<unknown, string | null, string | null>;
  previous_version: number | null;
  resulting_version: number | null;
  actor_user_id: string | null;
  actor_name: Generated<string>;
  created_at: Generated<Timestamp>;
}

export interface InvoicePaymentsTable {
  id: Generated<string>;
  organization_id: string;
  /**
   * Which set of books this row belongs to. Scoped WITH `organization_id`,
   * never instead of it: the composite foreign key is what makes a
   * cross-company reference unrepresentable rather than merely refused.
   */
  company_id: string;
  invoice_id: string;
  paid_on: string;
  amount: string;
  method: Generated<string>;
  reference: Generated<string>;
  bank_account_id: string | null;
  journal_entry_id: string | null;
  receipt_id: string | null;
  /**
   * A receipt recorded in error is reversed, never deleted: the row stays, a
   * reversing entry is posted, and both remain findable. Deleting would balance
   * the subledger by making the mistake invisible.
   */
  reversed_at: Timestamp | null;
  reversal_journal_entry_id: string | null;
  reversal_reason: string | null;
  created_by: string | null;
  created_at: Timestamp;
}

export interface InvoiceNumberingTable {
  organization_id: string;
  /**
   * Which set of books this row belongs to. Scoped WITH `organization_id`,
   * never instead of it: the composite foreign key is what makes a
   * cross-company reference unrepresentable rather than merely refused.
   */
  company_id: string;
  issuing_entity_id: string;
  prefix: Generated<string>;
  include_year: Generated<boolean>;
  sequence_length: Generated<number>;
  /** Held, never derived: a counted sequence reuses a number after a deletion. */
  next_sequence: Generated<number>;
  updated_at: Timestamp;
}

export interface InvoiceAuditEventsTable {
  id: Generated<string>;
  organization_id: string;
  /**
   * Which set of books this row belongs to. Scoped WITH `organization_id`,
   * never instead of it: the composite foreign key is what makes a
   * cross-company reference unrepresentable rather than merely refused.
   */
  company_id: string;
  invoice_id: string;
  action: string;
  detail: Generated<string>;
  actor_user_id: string | null;
  occurred_at: Timestamp;
}

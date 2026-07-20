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
export type OrganizationRole = 'owner' | 'accountant' | 'member' | 'viewer';
export type MembershipStatus = 'active' | 'invited' | 'suspended';
export type OrganizationStatus = 'active' | 'suspended' | 'closed';
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

export interface OrganizationsTable {
  id: Generated<string>;
  legal_name: string;
  trading_name: string | null;
  country: string;
  registration_number: string | null;
  tax_number: string | null;
  industry: string | null;
  base_currency: string;
  fiscal_year_start: string;
  books_start_date: string | null;
  status: Generated<OrganizationStatus>;
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
  organization_memberships: OrganizationMembershipsTable;
  subscription_plans: SubscriptionPlansTable;
  subscriptions: SubscriptionsTable;
  subscription_invoices: SubscriptionInvoicesTable;
  payment_proofs: PaymentProofsTable;
  billing_settings: BillingSettingsTable;
  bank_details: BankDetailsTable;
  auth_sessions: AuthSessionsTable;
  audit_logs: AuditLogsTable;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
export type AuthSession = Selectable<AuthSessionsTable>;

/**
 * Organization-level subscription & package-management types.
 *
 * Ledgora is one application / one accounting engine. Packages (plans) are
 * data-driven and fully editable from the administrator panel — names, prices,
 * limits, bank details and entitlements are NEVER hard-coded. Payment is manual
 * bank-remittance only (no online payment at this stage):
 *
 *   Package Selection → Subscription Invoice → Bank Instructions → Proof Upload
 *   → Pending Verification → Administrator Approval → Subscription Activation
 */
import type { LedgoraEdition, LedgoraModule } from './entitlements';

/** A purchasable package. All fields are editable from the admin panel. */
export interface SubscriptionPlan {
  id: string;
  /** Stable code used for defaults/upgrade math (e.g. 'core'). */
  code: string;
  name: string;
  description: string;
  edition: LedgoraEdition;

  priceMonthly: number;
  currency: string;

  userLimit: number;
  entityLimit: number;

  /** Entitlements on top of / removed from the edition preset. */
  addOnModules: LedgoraModule[];
  removedModules: LedgoraModule[];

  /** Available for purchase. */
  isActive: boolean;
  /** Shown in the public catalog. */
  isPublic: boolean;
  sortOrder: number;

  createdAt: string;
  updatedAt: string;
}

/** Bank account the organization remits to. Editable from the admin panel. */
export interface BankDetails {
  bankName: string;
  accountName: string;
  accountNumber: string;
  iban: string;
  swift: string;
  branch: string;
  /** Free-text remittance instructions shown on the invoice. */
  instructions: string;
  /**
   * True while these are the shipped placeholder details (no real account has
   * been configured). Drives the "do not transfer real money" warning. It is a
   * structured flag rather than a text match so the warning cannot be defeated —
   * or accidentally triggered — by wording changes. Cleared automatically the
   * first time an administrator saves real details.
   */
  isPlaceholder?: boolean;
}

/** Global billing configuration. */
export interface BillingSettings {
  currency: string;
  bank: BankDetails;
  /** Days after expiry before access is fully blocked. */
  graceDays: number;
  /** Days-before-expiry reminder thresholds (e.g. [7, 3, 0]). */
  reminderOffsets: number[];
  /** Days a subscription period lasts (monthly = 1 month, but configurable). */
  termMonths: number;
  invoicePrefix: string;
  /** Days an issued invoice remains payable. */
  paymentDueDays: number;
  updatedAt: string;
}

export type SubscriptionChangeType =
  | 'new'
  | 'renewal'
  | 'upgrade'
  | 'downgrade'
  | 'reactivation';

/** Invoice state machine (the required payment process). */
export type SubscriptionInvoiceStatus =
  | 'issued' // invoice created, bank instructions shown, awaiting proof
  | 'proof-submitted' // proof uploaded, pending administrator verification
  | 'approved' // administrator approved, subscription activated
  | 'rejected' // administrator rejected, organization may re-upload
  | 'cancelled'; // invoice voided / superseded

/** An uploaded bank-remittance payment proof. */
export interface PaymentProof {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  /** Base64 data URL (image or PDF), size-capped. */
  dataUrl: string;
  /** The LEDGORA payment reference the customer says they quoted. */
  reference: string;
  /** The bank's own transaction/reference number, when the customer supplies it. */
  bankTransactionReference?: string;
  /**
   * Whether `reference` matched the invoice's payment reference at upload time.
   * Recorded for the administrator reviewing the proof — a mismatch never blocks
   * the upload, and never activates anything on its own.
   */
  matchesInvoiceReference?: boolean;
  amount: number;
  paidAt: string;
  note: string;
  uploadedAt: string;
  uploadedBy: string;
}

export interface SubscriptionInvoice {
  id: string;
  number: string;
  organizationId: string;
  /**
   * Unique bank-remittance reference (`LG-XXXX-XXXX`) the customer must quote on
   * the transfer. This — not the invoice number — is what reconciles an incoming
   * payment. Issued by the payment-reference service at invoice creation.
   */
  paymentReference: string;

  planId: string;
  planCode: string;
  planName: string;
  edition: LedgoraEdition;
  changeType: SubscriptionChangeType;
  status: SubscriptionInvoiceStatus;

  currency: string;
  amount: number;

  periodStart: string;
  periodEnd: string;

  issuedAt: string;
  dueAt: string;

  /** Bank details frozen at issue time (edits to settings never rewrite history). */
  bankSnapshot: BankDetails;

  proofs: PaymentProof[];
  currentProofId?: string;

  verifiedBy?: string;
  verifiedAt?: string;
  rejectionReason?: string;

  notes: string;
  createdAt: string;
  updatedAt: string;
}

export type BillingAuditEvent =
  | 'plan-created'
  | 'plan-updated'
  | 'plan-archived'
  | 'bank-details-updated'
  | 'billing-settings-updated'
  | 'invoice-issued'
  | 'proof-uploaded'
  | 'payment-approved'
  | 'payment-rejected'
  | 'invoice-cancelled'
  | 'subscription-activated'
  | 'subscription-renewed'
  | 'subscription-upgraded'
  | 'subscription-downgraded'
  | 'subscription-cancelled'
  | 'subscription-expired'
  | 'grace-started';

export interface BillingAuditEntry {
  id: string;
  event: BillingAuditEvent;
  at: string;
  actor: string;
  detail: string;
  invoiceId?: string;
  planId?: string;
}

export type ReminderKind = 'before-expiry' | 'on-expiry' | 'in-grace' | 'grace-ended';

export interface RenewalReminder {
  kind: ReminderKind;
  daysUntilExpiry: number;
  expiresAt: string;
  graceEndsAt: string;
  title: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

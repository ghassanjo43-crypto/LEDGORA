/**
 * Customer registration, organization onboarding and subscription-selection
 * domain types.
 *
 * This layer models the public → registered → verified → onboarded → subscribed
 * customer funnel. Ledgora is frontend-only today, so anything that is
 * inherently server-side is modelled with a clean seam and called out:
 *   - Passwords are NEVER stored in plaintext. We keep only a non-reversible
 *     mock hash (a real backend uses argon2/bcrypt). The UI never persists the
 *     raw password.
 *   - Email verification + activation emails are represented as tokens / audit
 *     entries; a real backend sends the mail and the link hits an API.
 *   - Access control returns a controlled 403 shape so the same policy a backend
 *     API would enforce is enforced here too, not only by hiding menus.
 */

/** A registered customer user (the person). The first user of an org is owner. */
export interface RegisteredUser {
  id: string;
  fullName: string;
  /** Business email — also the login identity (lower-cased, unique). */
  email: string;
  mobile: string;
  country: string;
  /** Non-reversible mock hash. Never the raw password. */
  passwordHash: string;
  emailVerified: boolean;
  /** Outstanding verification token (cleared once verified). Seam for email. */
  verificationToken?: string;
  termsAcceptedAt?: string;
  /** Organization this user belongs to (set during onboarding). */
  organizationId?: string;
  role: OrgUserRole;
  /** Membership state. Owners/self-registered users are 'active'; teammates
   * added by an admin start 'invited' until they verify + set a password. */
  status?: MemberStatus;
  invitedAt?: string;
  invitedBy?: string;
  /** Plan code the visitor arrived with from /pricing (?plan=…). */
  intendedPlanCode?: string;
  createdAt: string;
  lastLoginAt?: string;
}

export type OrgUserRole = 'owner' | 'admin' | 'member';
export type MemberStatus = 'active' | 'invited' | 'suspended';

/** The subscriber organization (tenant). */
export interface Organization {
  id: string;
  ownerUserId: string;
  legalName: string;
  tradingName: string;
  country: string;
  registrationNumber: string;
  taxNumber: string;
  industry: string;
  baseCurrency: string;
  /** Financial-year start as MM-DD (e.g. '01-01'). */
  fiscalYearStart: string;
  /** Books opening date (yyyy-mm-dd). */
  booksStartDate: string;
  createdAt: string;
}

/**
 * The organization-level subscription lifecycle. These statuses drive the
 * post-login redirect state machine and route/API access control.
 */
export type OnboardingSubscriptionStatus =
  | 'draft' // selected but not confirmed
  | 'pending_payment' // invoice issued, awaiting bank remittance + proof
  | 'pending_verification' // proof uploaded, awaiting admin review
  | 'active' // approved & running
  | 'expired' // term ended
  | 'suspended' // administratively suspended
  | 'rejected'; // proof rejected — back to payment

/** A single chosen subscription (base plan + add-ons + extra seats/companies). */
export interface OnboardingSubscription {
  id: string;
  organizationId: string;
  status: OnboardingSubscriptionStatus;
  /** Commercial base plan code (core | professional | business | enterprise). */
  basePlanCode: string;
  /** Optional module codes chosen as add-ons. */
  addOnModuleCodes: string[];
  /** Extra seats beyond the plan allowance. */
  extraUsers: number;
  /** Extra companies beyond the plan allowance. */
  extraCompanies: number;
  currency: string;
  /** Reviewed monthly total (USD) at confirmation time. */
  monthlyTotal: number;
  /** Set once activated. */
  startsAt?: string;
  expiresAt?: string;
  renewsAt?: string;
  /** The invoice raised for this subscription (once confirmed). */
  invoiceId?: string;
  /** Unique bank-remittance payment reference (once confirmed). */
  paymentReference?: string;
  createdAt: string;
  updatedAt: string;
}

/** A line on the subscription invoice / cart review. */
export interface SubscriptionLineItem {
  key: string;
  label: string;
  detail?: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface CartPricing {
  currency: string;
  lines: SubscriptionLineItem[];
  monthlyTotal: number;
}

/** Frozen snapshot of bank details on an invoice at issue time. */
export interface BankInstructions {
  bankName: string;
  accountName: string;
  accountNumber: string;
  iban: string;
  swift: string;
  branch: string;
  instructions: string;
}

export type OnboardingInvoiceStatus =
  | 'issued'
  | 'proof-submitted'
  | 'paid'
  | 'rejected'
  | 'cancelled';

/** Payment proof uploaded by the customer (metadata + data URL seam). */
export interface OnboardingPaymentProof {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  /** Data URL for the demo; a real backend stores the object + a signed URL. */
  dataUrl: string;
  reference: string;
  amount: number;
  paidAt: string;
  note?: string;
  uploadedAt: string;
  uploadedBy: string;
}

export interface OnboardingInvoice {
  id: string;
  number: string;
  organizationId: string;
  subscriptionId: string;
  status: OnboardingInvoiceStatus;
  currency: string;
  lines: SubscriptionLineItem[];
  total: number;
  /** Unique payment reference the customer must quote on the transfer. */
  paymentReference: string;
  bank: BankInstructions;
  issuedAt: string;
  dueAt: string;
  proofs: OnboardingPaymentProof[];
  currentProofId?: string;
  paidAt?: string;
  verifiedBy?: string;
  verifiedAt?: string;
  rejectionReason?: string;
  /** Administrator "request more information" note (customer-visible). */
  infoRequest?: string;
  createdAt: string;
  updatedAt: string;
}

export type OnboardingAuditEvent =
  | 'user-registered'
  | 'email-verified'
  | 'user-logged-in'
  | 'organization-created'
  | 'subscription-drafted'
  | 'subscription-confirmed'
  | 'invoice-issued'
  | 'proof-uploaded'
  | 'payment-approved'
  | 'payment-rejected'
  | 'info-requested'
  | 'subscription-activated'
  | 'activation-email-sent'
  | 'subscription-expired'
  | 'subscription-suspended'
  | 'subscription-renewed';

export interface OnboardingAuditEntry {
  id: string;
  event: OnboardingAuditEvent;
  at: string;
  actor: string;
  detail: string;
  organizationId?: string;
  invoiceId?: string;
}

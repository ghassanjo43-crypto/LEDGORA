/**
 * Typed calls against the Super Admin console surface.
 *
 * Every call here is authorised SERVER-SIDE against a database-backed platform
 * capability. Nothing in this module — and nothing in the components that use it —
 * is a permission: a hidden button is a courtesy to the operator, not a control.
 * The console asks `/api/admin/me` which capabilities it holds purely so it can
 * avoid offering an action that would come back 403.
 *
 * ── Credentials in responses ─────────────────────────────────────────────────
 * `createSubscriber` and `resetPassword` are the only calls that ever carry a
 * secret, and only in the single response that generated it. Those values must go
 * straight to the dialog that displays them and never into a store, a log, a URL
 * or anything persisted. See `CredentialResultDialog`.
 */
import { api } from './client';

export type PlatformCapabilityName =
  | 'view-admin'
  | 'manage-users'
  | 'manage-plans'
  | 'manage-billing-settings'
  | 'manage-bank-details'
  | 'verify-payments'
  | 'activate-subscription'
  | 'manage-platform-roles'
  | 'subscribers.read'
  | 'subscribers.create'
  | 'subscribers.manage'
  | 'members.read'
  | 'members.manage'
  | 'members.reset_password'
  | 'subscriptions.assign'
  /**
   * User administration proper — bringing an account into existence, moving it
   * between tenants, and configuring what it may do. Deliberately separate from
   * `members.manage`: changing an account's status is support work, deciding
   * which accounting actions it may perform is not.
   */
  | 'users.create'
  | 'users.assign_organization'
  | 'permissions.read'
  | 'permissions.manage'
  | 'members.remove'
  | 'members.delete'
  | 'applicants.delete'
  | 'subscribers.archive'
  | 'subscribers.delete'
  /**
   * Closure workflow. Scheduling a purge and taking a copy of a tenant's data
   * are distinct authorities from archiving, and from each other.
   */
  | 'subscribers.request_deletion'
  | 'subscribers.export';

/* ── Members ──────────────────────────────────────────────────────────────── */

export interface AdminMemberRow {
  userId: string;
  fullName: string;
  email: string;
  accountStatus: string;
  emailVerified: boolean;
  mustChangePassword: boolean;
  locked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  /**
   * The account type of the IDENTITY (`production | test | demo`), which is not
   * the classification of the organization it belongs to. A production person
   * inside a demo tenant survives that tenant's deletion.
   */
  dataClassification: string;
  organizationId: string | null;
  organizationName: string | null;
  organizationStatus: string | null;
  organizationRole: string | null;
  membershipStatus: string | null;
  isOwner: boolean;
  platformRoles: string[];
  organizationCount: number;
  /**
   * The PRIMARY organization's package. Null for an account with no tenant.
   * A package belongs to the organization, never to the person — this is here
   * so the directory can show which subscription covers them.
   */
  planCode: string | null;
  edition: string | null;
  subscriptionStatus: string | null;
  subscriptionActive: boolean;
}

export interface AdminMemberListResponse {
  members: AdminMemberRow[];
  pagination: { limit: number; offset: number; count: number; total: number };
  facets: {
    accountStatus: Record<string, number>;
    organizationRole: Record<string, number>;
  };
}

export interface AdminMemberQuery {
  search?: string;
  organizationId?: string;
  role?: string;
  accountStatus?: string;
  membershipStatus?: string;
  verification?: 'verified' | 'unverified';
  audience?: 'platform' | 'customer';
  sort?:
    | 'created_at'
    | 'full_name'
    | 'email'
    | 'organization_name'
    | 'organization_role'
    | 'account_status'
    | 'last_login_at';
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface AuditEntry {
  id: string;
  action: string;
  actorUserId: string | null;
  actorPlatformRole: string | null;
  targetType: string | null;
  targetId: string | null;
  organizationId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * The member drawer's payload.
 *
 * Note the shape of `security`: a session COUNT, never a session. There is no
 * field here — and none on the server — that could carry a hash, a token or a
 * password. See `server/src/services/memberAdminService.ts`.
 */
export interface AdminMemberDetail {
  identity: {
    userId: string;
    fullName: string;
    email: string;
    emailVerified: boolean;
    emailVerifiedAt: string | null;
    accountStatus: string;
    registeredAt: string;
    lastLoginAt: string | null;
    failedLoginCount: number;
    locked: boolean;
    lockedUntil: string | null;
    platformRoles: string[];
  };
  organizations: Array<{
    organizationId: string;
    organizationName: string;
    organizationStatus: string;
    role: string;
    isOwner: boolean;
    membershipStatus: string;
    joinedAt: string;
    primary: boolean;
  }>;
  subscription: {
    organizationId: string;
    planId: string | null;
    planCode: string | null;
    planName: string | null;
    edition: string | null;
    modules: string[];
    status: string;
    billingCycle: string | null;
    activatedAt: string | null;
    expiresAt: string | null;
    seatsUsed: number;
    seatLimit: number | null;
    entityLimit: number | null;
    invoiceStatus: string | null;
    invoiceNumber: string | null;
    invoiceTotal: number | null;
    paymentProofStatus: string | null;
    entitlementActive: boolean;
  } | null;
  security: {
    activeSessionCount: number;
    lastSessionAt: string | null;
    mustChangePassword: boolean;
    passwordExpiresAt: string | null;
    hasPendingResetToken: boolean;
    recentSecurityActions: AuditEntry[];
  };
  administration: {
    auditHistory: AuditEntry[];
    internalNotes: string | null;
  };
}

/**
 * Whether a credential actually reached its recipient.
 *
 * `unavailable` means no mail service is configured, so nothing was attempted —
 * the administrator is the delivery channel. `failed` means delivery was tried
 * and broke. Never render either as "email sent".
 */
export type CredentialDeliveryStatus = 'sent' | 'unavailable' | 'failed';

/**
 * A one-time credential, as returned by create-subscriber and reset-password.
 *
 * ── Handling rule ───────────────────────────────────────────────────────────
 * `temporaryPassword` and `invitationToken` exist in ONE response and nowhere
 * else in the system. They must go straight from the API call to the dialog that
 * displays them, held in plain (non-persisted) React state, and be dropped when
 * the administrator confirms they have copied the value. Never put either in a
 * Zustand store, `localStorage`, `sessionStorage`, a URL or a log.
 */
export interface OneTimeCredential {
  /** The discriminant: switch on this rather than probing optional fields. */
  type: 'temporary_password' | 'invitation';
  /** Shown once. Never store this. */
  temporaryPassword?: string;
  /** Shown once. Never store this. */
  invitationToken?: string;
  expiresAt: string;
  deliveryStatus: CredentialDeliveryStatus;
  mustChangePassword: boolean;
  revokedSessions?: number;
  message: string;
}

export interface ResetPasswordResponse {
  member: { userId: string; email: string; fullName: string };
  mode: 'temporary' | 'link';
  credential: OneTimeCredential;
}

function queryString(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '' || value === 'all') continue;
    params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `?${suffix}` : '';
}

const id = (value: string): string => encodeURIComponent(value);

export const adminMemberApi = {
  list(query: AdminMemberQuery = {}, signal?: AbortSignal) {
    return api.get<AdminMemberListResponse>(`/api/admin/members${queryString(query)}`, signal);
  },

  get(userId: string, signal?: AbortSignal) {
    return api.get<{ member: AdminMemberDetail }>(`/api/admin/members/${id(userId)}`, signal);
  },

  /**
   * Reset a password. The result may contain a one-time secret — hand it directly
   * to the result dialog and let it go out of scope; do not put it in a store.
   */
  resetPassword(
    userId: string,
    input: { mode: 'temporary' | 'link'; reason?: string; keepDisabled?: boolean },
  ) {
    return api.post<ResetPasswordResponse>(`/api/admin/members/${id(userId)}/reset-password`, input);
  },

  unlock(userId: string) {
    return api.post<{ userId: string; accountStatus: string; failedLoginCount: number }>(
      `/api/admin/members/${id(userId)}/unlock`,
    );
  },

  revokeSessions(userId: string) {
    return api.post<{ userId: string; revokedSessions: number }>(
      `/api/admin/members/${id(userId)}/revoke-sessions`,
    );
  },

  setStatus(userId: string, status: string, reason: string) {
    return api.patch<{ userId: string; accountStatus: string; revokedSessions: number }>(
      `/api/admin/members/${id(userId)}/status`,
      { status, reason },
    );
  },

  verifyEmail(userId: string, reason: string) {
    return api.post<{ userId: string; emailVerified: boolean; emailVerifiedAt: string }>(
      `/api/admin/members/${id(userId)}/verify-email`,
      { reason },
    );
  },

  updateMembership(
    userId: string,
    input: { organizationId: string; role?: string; status?: string },
  ) {
    return api.patch<{ userId: string; organizationId: string; role: string; status: string }>(
      `/api/admin/members/${id(userId)}/membership`,
      input,
    );
  },
};

/* ── Subscribers ──────────────────────────────────────────────────────────── */

export interface AdminSubscriberRow {
  organizationId: string;
  legalName: string;
  tradingName: string | null;
  country: string;
  organizationStatus: string;
  /**
   * production | test | demo, from the database. Decides whether the console
   * offers permanent deletion — the server refuses regardless, but showing a
   * button that is always refused is its own kind of lie.
   */
  dataClassification: string;
  /**
   * Null when the 008 migration default is the only thing that ever set the
   * classification. Null means "nobody has reviewed this", never "not
   * production" — the column is NOT NULL, so an unclassified row cannot exist.
   */
  classificationReviewedAt: string | null;
  legalHold: boolean;
  createdAt: string;
  planId: string | null;
  planCode: string | null;
  planName: string | null;
  edition: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  billingCycle: string | null;
  startsAt: string | null;
  renewsAt: string | null;
  seatsUsed: number;
  seatLimit: number | null;
  entityLimit: number | null;
  modules: string[];
  entitlementActive: boolean;
  ownerUserId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  memberCount: number;
  openInvoiceId: string | null;
  openInvoiceStatus: string | null;
  pendingProofId: string | null;
}

export interface AdminSubscriberListResponse {
  subscribers: AdminSubscriberRow[];
  pagination: { limit: number; offset: number; count: number; total: number };
  statusCounts: Record<string, number>;
}

export interface AdminSubscriberQuery {
  status?: string;
  /**
   * `production | test | demo`, or `all`/absent. Applied server-side in SQL:
   * filtering the loaded page instead would show only the matches that happened
   * to land on it.
   */
  classification?: string;
  subscriptionStatus?: string;
  planId?: string;
  search?: string;
  sort?:
    | 'created_at'
    | 'legal_name'
    | 'status'
    | 'plan_code'
    | 'subscription_status'
    | 'renews_at'
    | 'seats_used';
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface EntitlementSnapshot {
  organizationId: string;
  subscriptionId: string | null;
  planId: string | null;
  planCode: string | null;
  planName: string | null;
  edition: string | null;
  modules: string[];
  userLimit: number | null;
  entityLimit: number | null;
  storageLimit: number | null;
  status: string;
  active: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  computedAt: string;
}

export interface PackageHistoryEntry {
  id: string;
  previousPlanCode: string | null;
  newPlanCode: string | null;
  previousStatus: string | null;
  newStatus: string | null;
  previousModules: string[];
  newModules: string[];
  previousUserLimit: number | null;
  newUserLimit: number | null;
  direction: string;
  effectiveAt: string;
  reason: string;
  changedByUserId: string | null;
  changedByName: string | null;
  createdAt: string;
}

export interface AdminSubscriberDetail {
  subscriber: AdminSubscriberRow;
  internalNotes: string | null;
  entitlements: EntitlementSnapshot;
  members: Array<{
    userId: string;
    fullName: string;
    email: string;
    role: string;
    membershipStatus: string;
    accountStatus: string;
    emailVerified: boolean;
    lastLoginAt: string | null;
    joinedAt: string;
  }>;
  invoices: Array<{
    id: string;
    invoiceNumber: string;
    status: string;
    currency: string;
    total: number;
    paymentReference: string;
    issuedAt: string;
    dueAt: string;
    paidAt: string | null;
    proofStatus: string | null;
    proofId: string | null;
  }>;
  packageHistory: PackageHistoryEntry[];
}

export interface PackageConsequence {
  code: string;
  severity: 'warning' | 'blocking';
  message: string;
  detail?: Record<string, unknown>;
}

export interface PackageAssessment {
  organizationId: string;
  direction: 'upgrade' | 'downgrade' | 'lateral' | 'initial';
  isDowngrade: boolean;
  current: {
    planId: string | null;
    planCode: string | null;
    planName: string | null;
    status: string;
    modules: string[];
    userLimit: number | null;
    entityLimit: number | null;
    seatsUsed: number;
  };
  proposed: {
    planId: string;
    planCode: string;
    planName: string;
    status: string;
    modules: string[];
    userLimit: number | null;
    entityLimit: number | null;
  };
  consequences: PackageConsequence[];
  membersOverLimit: Array<{ userId: string; fullName: string; email: string; role: string; joinedAt: string }>;
  modulesRemoved: string[];
}

export interface CreateSubscriberInput {
  fullName: string;
  email: string;
  organizationLegalName: string;
  tradingName?: string;
  country: string;
  baseCurrency?: string;
  planId: string;
  modules?: string[];
  subscriptionStatus?: string;
  organizationStatus?: string;
  startDate?: string;
  billingCycle?: 'monthly' | 'annual';
  seatAllowance?: number | null;
  entityAllowance?: number | null;
  storageAllowance?: number | null;
  paymentConfirmed?: boolean;
  internalNotes?: string;
  onboarding: 'invite' | 'temporary';
  /**
   * Whether the tenant is real or disposable. Omitted means `production` on the
   * server — the safe default is never inferred from anything else about the
   * request, and a test/demo value here is what makes permanent deletion
   * possible at all.
   */
  dataClassification?: 'production' | 'test' | 'demo';
}

export interface CreateSubscriberResponse {
  subscriber: {
    userId: string;
    organizationId: string;
    email: string;
    fullName: string;
    subscriptionId: string;
    membershipId: string;
    applicationId: string | null;
    subscriptionStatus: string;
  };
  entitlements: EntitlementSnapshot;
  /**
   * The one-time credential. Expected on every successful creation — but the
   * client checks for it rather than assuming, so a contract drift surfaces as an
   * explicit recovery instruction instead of a silently missing dialog.
   */
  credential?: OneTimeCredential;
}

export interface AssignPackageInput {
  planId: string;
  modules?: string[];
  billingCycle?: 'monthly' | 'annual';
  status?: string;
  effectiveDate?: string;
  seatOverride?: number | null;
  entityOverride?: number | null;
  storageOverride?: number | null;
  reason: string;
  /** Which consequences the operator was shown and accepted. Audited. */
  acknowledgedConsequences?: string[];
}

export interface AssignPackageResponse {
  organizationId: string;
  subscriptionId: string;
  status: string;
  direction: string;
  previousPlanCode: string | null;
  newPlanCode: string;
  entitlements: EntitlementSnapshot;
  historyId: string;
  consequences: PackageConsequence[];
}

export const adminSubscriberApi = {
  list(query: AdminSubscriberQuery = {}, signal?: AbortSignal) {
    return api.get<AdminSubscriberListResponse>(`/api/admin/subscribers${queryString(query)}`, signal);
  },

  get(organizationId: string, signal?: AbortSignal) {
    return api.get<AdminSubscriberDetail>(`/api/admin/subscribers/${id(organizationId)}`, signal);
  },

  /** The response carries a one-time onboarding secret. Do not persist it. */
  create(input: CreateSubscriberInput) {
    return api.post<CreateSubscriberResponse>('/api/admin/subscribers', input);
  },

  setStatus(organizationId: string, action: 'activate' | 'suspend' | 'archive' | 'restore', reason: string) {
    return api.patch<{
      organizationId: string;
      organizationStatus: string;
      subscriptionStatus: string | null;
      entitlements: EntitlementSnapshot;
    }>(`/api/admin/subscribers/${id(organizationId)}/status`, { action, reason });
  },

  changeOwner(
    organizationId: string,
    input: { newOwnerUserId: string; previousOwnerRole?: string; reason: string },
  ) {
    return api.post<{ organizationId: string; previousOwnerUserId: string | null; newOwnerUserId: string }>(
      `/api/admin/subscribers/${id(organizationId)}/change-owner`,
      input,
    );
  },

  updateNotes(organizationId: string, internalNotes: string) {
    return api.patch<{ organizationId: string; internalNotes: string | null }>(
      `/api/admin/subscribers/${id(organizationId)}/notes`,
      { internalNotes },
    );
  },

  /**
   * Preview a package change. A pure read, so it is safe to call as the operator
   * edits the form — and the server re-runs the same assessment on submit, so
   * skipping it cannot skip the analysis.
   */
  packageImpact(
    organizationId: string,
    query: { planId: string; modules?: string[]; status?: string; seatOverride?: number | null },
    signal?: AbortSignal,
  ) {
    const params = new URLSearchParams({ planId: query.planId });
    if (query.status) params.set('status', query.status);
    if (query.seatOverride !== undefined && query.seatOverride !== null) {
      params.set('seatOverride', String(query.seatOverride));
    }
    for (const module of query.modules ?? []) params.append('modules', module);
    return api.get<{ assessment: PackageAssessment }>(
      `/api/admin/subscribers/${id(organizationId)}/package-impact?${params.toString()}`,
      signal,
    );
  },

  assignPackage(organizationId: string, input: AssignPackageInput) {
    return api.post<AssignPackageResponse>(
      `/api/admin/subscribers/${id(organizationId)}/assign-package`,
      input,
    );
  },

  refreshEntitlements(organizationId: string) {
    return api.post<{ entitlements: EntitlementSnapshot }>(
      `/api/admin/subscribers/${id(organizationId)}/refresh-entitlements`,
    );
  },

  packageHistory(organizationId: string, signal?: AbortSignal) {
    return api.get<{ history: PackageHistoryEntry[] }>(
      `/api/admin/subscribers/${id(organizationId)}/package-history`,
      signal,
    );
  },
};

/** The capabilities the signed-in operator actually holds, per the server. */
export function fetchAdminCapabilities(signal?: AbortSignal) {
  return api.get<{ user: Record<string, unknown>; capabilities: PlatformCapabilityName[] }>(
    '/api/admin/me',
    signal,
  );
}

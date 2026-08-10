/**
 * Typed calls against the backend authentication and administration surface.
 *
 * `getSession()` is the ONLY source of truth for who the user is and which
 * platform role (if any) they hold. Nothing here trusts a browser-held value.
 */
import { api, ApiError, setCsrfToken, clearCsrfToken } from './client';

/** Platform roles exactly as the backend spells them. */
export type BackendPlatformRole = 'super_admin' | 'billing_admin' | 'support';

export interface BackendUser {
  id: string;
  email: string;
  fullName: string;
  status: 'active' | 'disabled' | 'locked' | 'pending_verification';
  emailVerified: boolean;
  mustChangePassword: boolean;
  platformRoles: BackendPlatformRole[];
  lastLoginAt: string | null;
  createdAt: string;
}

export interface BackendSessionResponse {
  authenticated: boolean;
  user: BackendUser | null;
  /** Double-submit CSRF token to hold in memory. Null when not authenticated. */
  csrfToken?: string | null;
}

export const authApi = {
  /** Current server session. Never throws for "not signed in" — returns false. */
  async getSession(signal?: AbortSignal): Promise<BackendSessionResponse> {
    try {
      const result = await api.get<BackendSessionResponse>('/api/auth/session', signal);
      // Recover the CSRF token into memory after a reload; drop it if the server
      // reports no session, so a stale token cannot ride a later request.
      if (result.authenticated) setCsrfToken(result.csrfToken);
      else clearCsrfToken();
      return result;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        clearCsrfToken();
        return { authenticated: false, user: null, csrfToken: null };
      }
      throw error;
    }
  },

  async register(input: { email: string; password: string; fullName: string }) {
    const result = await api.post<{ user: BackendUser; csrfToken?: string }>('/api/auth/register', input);
    setCsrfToken(result.csrfToken);
    return result;
  },

  async signIn(input: { email: string; password: string }) {
    const result = await api.post<{ user: BackendUser; mustChangePassword: boolean; csrfToken?: string }>(
      '/api/auth/login',
      input,
    );
    setCsrfToken(result.csrfToken);
    return result;
  },

  async signOut() {
    try {
      return await api.post<{ ok: boolean }>('/api/auth/logout');
    } finally {
      // The CSRF token is meaningless once the session is gone.
      clearCsrfToken();
    }
  },

  signOutEverywhere() {
    return api.post<{ ok: boolean; revokedSessions: number }>('/api/auth/logout-all');
  },

  changePassword(input: { currentPassword: string; newPassword: string }) {
    return api.post<{ ok: boolean }>('/api/auth/change-password', input);
  },

  requestPasswordReset(email: string) {
    return api.post<{ ok: boolean; message?: string }>('/api/auth/forgot-password', { email });
  },
};

/* ── Subscription funnel ──────────────────────────────────────────────────── */

export interface PublicPlan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  edition: string;
  currency: string;
  monthlyPrice: number;
  annualPrice: number | null;
  userLimit: number;
  entityLimit: number;
  modules: string[];
}

export const subscriptionApi = {
  listPublicPlans() {
    return api.get<{ plans: PublicPlan[] }>('/api/plans/public');
  },

  /**
   * Create the caller's organization. The response carries the created record,
   * so the client adopts the SERVER's organization rather than minting a local
   * one. A second call for the same owner returns 409 — see the onboarding page,
   * which adopts the existing organization instead of creating a duplicate.
   */
  createOrganization(input: {
    legalName: string;
    country: string;
    tradingName?: string;
    registrationNumber?: string;
    taxNumber?: string;
    industry?: string;
    baseCurrency?: string;
    fiscalYearStart?: string;
    booksStartDate?: string;
  }) {
    return api.post<{ organizationId: string; organization: Record<string, unknown> | null }>(
      '/api/organizations',
      input,
    );
  },

  currentOrganization(signal?: AbortSignal) {
    return api.get<{ organization: Record<string, unknown> | null }>('/api/organizations/current', signal);
  },

  selectPlan(planId: string, billingCycle: 'monthly' | 'annual' = 'monthly') {
    return api.post<{ subscriptionId: string; status: string }>('/api/subscriptions', { planId, billingCycle });
  },

  /** Issues the invoice and the server-generated payment reference. */
  confirm(subscriptionId: string) {
    return api.post<{
      subscriptionId: string;
      invoiceId: string;
      invoiceNumber: string;
      paymentReference: string;
      total: number;
      currency: string;
      dueAt: string;
    }>(`/api/subscriptions/${subscriptionId}/confirm`);
  },

  current() {
    return api.get<{
      subscription: Record<string, unknown> | null;
      invoice: Record<string, unknown> | null;
      bank: Record<string, unknown> | null;
    }>('/api/subscriptions/current');
  },

  uploadPaymentProof(invoiceId: string, form: FormData) {
    return api.upload<{ id: string; status: string; matchesInvoiceReference: boolean }>(
      `/api/invoices/${invoiceId}/payment-proof`,
      form,
    );
  },
};

/* ── Administration (every call is authorised server-side) ────────────────── */

export interface AdminPaymentProof {
  id: string;
  status: string;
  invoiceId: string;
  invoiceNumber: string;
  organizationId: string;
  organizationName: string;
  invoicePaymentReference: string;
  quotedReference: string;
  bankTransactionReference: string | null;
  matchesInvoiceReference: boolean;
  amount: number;
  invoiceTotal: number;
  paidAt: string;
  fileName: string;
  uploadedAt: string;
  informationRequest: string | null;
  rejectionReason: string | null;
}

/**
 * Where an applicant stands in the onboarding funnel.
 *
 * `registered_no_package` is the one that matters most: it is what a customer
 * who has created an account and nothing else looks like. They are visible to
 * the operator from that moment, with no organization and no subscription.
 */
export type ApplicantStage =
  | 'registered_no_package'
  | 'package_selected'
  | 'awaiting_payment'
  | 'pending_verification'
  | 'active_subscriber'
  | 'dormant_applicant'
  | 'suspended'
  | 'archived';

export interface Applicant {
  userId: string;
  applicationId: string | null;
  fullName: string;
  email: string;
  accountStatus: string;
  emailVerified: boolean;
  registeredAt: string;
  lastLoginAt: string | null;
  lastActivityAt: string;
  /** Stage including the dormancy overlay — what the roster displays. */
  stage: ApplicantStage;
  /** Stage actually reached, ignoring dormancy. */
  funnelStage: Exclude<ApplicantStage, 'dormant_applicant'>;
  dormant: boolean;
  source: string | null;
  organizationId: string | null;
  organizationName: string | null;
  organizationCountry: string | null;
  planId: string | null;
  planCode: string | null;
  planName: string | null;
  planCurrency: string | null;
  planMonthlyPrice: number | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  billingCycle: string | null;
  subscriptionExpiresAt: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
  invoiceTotal: number | null;
  paymentReference: string | null;
  proofId: string | null;
  proofStatus: string | null;
  packageSelectedAt: string | null;
  paymentStartedAt: string | null;
  proofUploadedAt: string | null;
  activatedAt: string | null;
}

export interface ApplicantListResponse {
  applicants: Applicant[];
  pagination: { limit: number; offset: number; count: number; total: number };
  stageCounts: Record<string, number>;
  dormantDays: number;
}

export interface ApplicantQuery {
  stage?: ApplicantStage | 'all';
  search?: string;
  sort?: 'registered_at' | 'last_activity_at' | 'full_name' | 'email' | 'organization_name' | 'stage';
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export const adminApi = {
  me() {
    return api.get<{ user: BackendUser }>('/api/admin/me');
  },

  /**
   * Every registered customer, at whatever stage — including the ones who have
   * chosen nothing yet. This is the roster the operator works from.
   */
  listApplicants(query: ApplicantQuery = {}, signal?: AbortSignal) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const suffix = params.toString();
    return api.get<ApplicantListResponse>(`/api/admin/applicants${suffix ? `?${suffix}` : ''}`, signal);
  },

  getApplicant(userId: string, signal?: AbortSignal) {
    return api.get<{ applicant: Applicant }>(`/api/admin/applicants/${encodeURIComponent(userId)}`, signal);
  },

  remindApplicant(userId: string) {
    return api.post<{ applicant: Applicant; delivered: boolean; message: string }>(
      `/api/admin/applicants/${encodeURIComponent(userId)}/remind`,
    );
  },

  /** Suspend, archive or restore. None of these delete the account. */
  setApplicantState(userId: string, action: 'suspend' | 'archive' | 'restore', reason: string) {
    return api.post<{ applicant: Applicant }>(
      `/api/admin/applicants/${encodeURIComponent(userId)}/${action}`,
      { reason },
    );
  },

  activateSubscription(subscriptionId: string, reason: string) {
    return api.post<{ id: string; status: string }>(
      `/api/admin/subscriptions/${encodeURIComponent(subscriptionId)}/activate`,
      { reason },
    );
  },

  listPaymentProofs(status = 'submitted') {
    return api.get<{ proofs: AdminPaymentProof[] }>(`/api/admin/payment-proofs?status=${encodeURIComponent(status)}`);
  },

  approveProof(id: string) {
    return api.post<{ subscriptionId: string; status: string; appliedModules: string[] }>(
      `/api/admin/payment-proofs/${id}/approve`,
    );
  },

  rejectProof(id: string, reason: string) {
    return api.post<{ proofId: string; status: string }>(`/api/admin/payment-proofs/${id}/reject`, { reason });
  },

  requestProofInformation(id: string, note: string) {
    return api.post<{ proofId: string; status: string }>(`/api/admin/payment-proofs/${id}/request-information`, { note });
  },

  listSubscriptions(status?: string) {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    return api.get<{ subscriptions: Array<Record<string, unknown>> }>(`/api/admin/subscriptions${query}`);
  },

  getBankDetails() {
    return api.get<{ bankDetails: Record<string, unknown> | null }>('/api/admin/bank-details');
  },

  updateBankDetails(patch: Record<string, string>) {
    return api.patch<{ bankDetails: Record<string, unknown> }>('/api/admin/bank-details', patch);
  },

  listPlans() {
    return api.get<{ plans: Array<Record<string, unknown>> }>('/api/admin/plans');
  },

  auditLogs(limit = 50) {
    return api.get<{ entries: Array<Record<string, unknown>> }>(`/api/admin/audit-logs?limit=${limit}`);
  },
};

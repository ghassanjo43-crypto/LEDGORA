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

  createOrganization(input: { legalName: string; country: string; tradingName?: string; baseCurrency?: string }) {
    return api.post<{ organizationId: string }>('/api/organizations', input);
  },

  currentOrganization() {
    return api.get<{ organization: Record<string, unknown> | null }>('/api/organizations/current');
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

export const adminApi = {
  me() {
    return api.get<{ user: BackendUser }>('/api/admin/me');
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

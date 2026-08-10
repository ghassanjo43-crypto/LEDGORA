/**
 * Subscriber closure and data export.
 *
 * Typed against the endpoints in `server/src/routes/adminClosure.ts`. Every call
 * is authorised server-side against a database-backed platform capability
 * (`subscribers.request_deletion`, `subscribers.export`, `subscribers.archive`,
 * `subscribers.read`); nothing in this module is a permission.
 *
 * ── Two values in here are secrets ───────────────────────────────────────────
 * The operator's password, and an export's download token. Neither may be
 * stored: the password is passed straight through to `requestDeletion` and held
 * only in the calling component's local state, and `downloadToken` comes back
 * exactly once from `createExport` — the server keeps only its SHA-256 digest,
 * so a token that is lost cannot be recovered and a new export must be made.
 *
 * Neither value may enter a Zustand store, `localStorage`, `sessionStorage`, a
 * URL or a log line. The download is a POST with the token in the BODY for
 * exactly that reason: a query parameter would be written to the server's
 * request log as part of `req.url`.
 */
import { api } from './client';

/* ── Closure status ───────────────────────────────────────────────────────── */

export interface ClosureStatus {
  organizationId: string;
  legalName: string;
  organizationStatus: string;
  archivedAt: string | null;
  archiveReason: string | null;
  deletionRequestedAt: string | null;
  /** When the purge becomes permissible — not when it will happen. */
  scheduledPurgeAfter: string | null;
  deletionReason: string | null;
  legalHold: boolean;
  legalHoldReason: string | null;
  recoveryDaysRemaining: number | null;
  canCancelDeletion: boolean;
  canRestore: boolean;
}

/* ── The eligibility assessment ───────────────────────────────────────────── */

/**
 * One line of the impact report.
 *
 * `serverVerifiable: false` is the load-bearing field. It marks a category the
 * account service genuinely CANNOT count — Ledgora's accounting records live in
 * the customer's browser workspace — and the UI must render it as "cannot be
 * verified here", never as a zero. A zero would say "there is no accounting
 * data", which is a claim this server is in no position to make.
 */
export interface ImpactCount {
  key: string;
  label: string;
  count: number | null;
  serverVerifiable: boolean;
  note?: string;
}

export interface BlockingReason {
  code: string;
  message: string;
}

export interface DeletionImpact {
  organizationId: string;
  legalName: string;
  organizationStatus: string;
  counts: ImpactCount[];
  deletionPermitted: boolean;
  blockingReasons: BlockingReason[];
  willBeAnonymized: string[];
  willBePermanentlyDeleted: string[];
  willBeRetained: string[];
  recommendation: string;
  assessedAt: string;
}

/* ── Deletion request ─────────────────────────────────────────────────────── */

export interface DeletionRequestResult {
  organizationId: string;
  legalName: string;
  organizationStatus: string;
  requestedAt: string;
  scheduledPurgeAfter: string;
  revokedSessions: number;
  memberCount: number;
  impact: DeletionImpact;
}

/* ── Exports ──────────────────────────────────────────────────────────────── */

export interface ExportSummary {
  exportId: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  byteSize: number | null;
  sectionCounts: Record<string, number>;
  downloadCount: number;
  firstDownloadedAt: string | null;
  requestedBy: string | null;
}

export interface CreatedExport {
  exportId: string;
  organizationId: string;
  status: string;
  expiresAt: string;
  sectionCounts: Record<string, number>;
  byteSize: number;
  /**
   * Returned exactly once. Only its hash is stored server-side, so this value
   * cannot be retrieved again — it must go straight to the operator and never
   * into any persisted state.
   */
  downloadToken: string;
  /**
   * Sections the account service cannot produce, named explicitly. Their absence
   * is NOT evidence that the subscriber has none of that data.
   */
  unavailableSections: string[];
}

const id = (value: string): string => encodeURIComponent(value);

export const subscriberClosureApi = {
  /** Lifecycle state and which closure actions are currently offerable. */
  status(organizationId: string, signal?: AbortSignal) {
    return api.get<{ closure: ClosureStatus }>(
      `/api/admin/subscribers/${id(organizationId)}/closure`,
      signal,
    );
  },

  /**
   * The authoritative eligibility assessment, recomputed on every call. A client
   * may not cache it and the server never believes one that is sent back.
   */
  impact(organizationId: string, signal?: AbortSignal) {
    return api.get<{ impact: DeletionImpact }>(
      `/api/admin/subscribers/${id(organizationId)}/closure/impact`,
      signal,
    );
  },

  /**
   * Schedule a permanent deletion.
   *
   * `password` is the acting operator's own, verified server-side against their
   * stored Argon2id digest. It is passed through and never retained here.
   */
  requestDeletion(
    organizationId: string,
    input: { reason: string; confirmation: string; password: string; recoveryDays?: number },
  ) {
    return api.post<DeletionRequestResult>(
      `/api/admin/subscribers/${id(organizationId)}/request-deletion`,
      input,
    );
  },

  /** Cancel a scheduled deletion. Returns the subscriber to `archived`. */
  cancelDeletion(organizationId: string, reason: string) {
    return api.post<{ organizationId: string; organizationStatus: string; cancelledAt: string }>(
      `/api/admin/subscribers/${id(organizationId)}/cancel-deletion`,
      { reason },
    );
  },

  /** Re-open an archived subscriber. Refused while a deletion is pending. */
  reactivate(organizationId: string, reason: string) {
    return api.post<{
      organizationId: string;
      organizationStatus: string;
      subscriptionStatus: string | null;
      revokedSessions: number;
      entitlementActive: boolean;
    }>(`/api/admin/subscribers/${id(organizationId)}/reactivate`, { reason });
  },

  /* ── Exports ───────────────────────────────────────────────────────────── */

  createExport(organizationId: string, input: { ttlMinutes?: number } = {}) {
    return api.post<CreatedExport>(`/api/admin/subscribers/${id(organizationId)}/export`, input);
  },

  listExports(organizationId: string, signal?: AbortSignal) {
    return api.get<{ exports: ExportSummary[] }>(
      `/api/admin/subscribers/${id(organizationId)}/exports`,
      signal,
    );
  },

  /**
   * Redeem a download token.
   *
   * A POST with the token in the body: a query parameter would put a live
   * credential into the server's request log. The response is the export payload
   * itself, which the caller turns into a file — it is never stored here.
   */
  download(organizationId: string, exportId: string, token: string) {
    return api.post<unknown>(
      `/api/admin/subscribers/${id(organizationId)}/exports/${id(exportId)}/download`,
      { token },
    );
  },

  revokeExport(organizationId: string, exportId: string, reason: string) {
    return api.post<{ exportId: string; revoked: boolean }>(
      `/api/admin/subscribers/${id(organizationId)}/exports/${id(exportId)}/revoke`,
      { reason },
    );
  },
};

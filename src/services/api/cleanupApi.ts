/**
 * Disposable-tenant cleanup.
 *
 * Typed against `server/src/routes/adminSubscribers.ts`. Every call is
 * authorised server-side against the `subscribers.delete` platform capability,
 * which only `super_admin` holds — nothing in this module is a permission, and a
 * component that renders a delete button has not thereby been granted one.
 *
 * ── The digest is the only preview state that travels back ───────────────────
 * The server recomputes eligibility, classification and every count before it
 * destroys anything, and compares its own freshly-computed digest against the
 * one sent here. So this client cannot make a tenant deletable by claiming it
 * is, and cannot widen a deletion by editing the counts it displays. What the
 * digest buys is the opposite guarantee: that the operator confirmed the state
 * they were actually shown, and that a change since then forces a new look.
 */
import { api } from './client';

/**
 * The disclosure every permanent-deletion confirmation must show, verbatim.
 *
 * One exported constant rather than prose repeated per screen: the second half
 * is the part people get wrong. A server purge destroys the platform account and
 * everything the server holds, but Ledgora's accounting records live in each
 * user's browser, so the operation has no way to reach a device — and a
 * confirmation that implies otherwise is how an operator concludes a data-removal
 * obligation has been met when it has not.
 */
export const PERMANENT_DELETION_DISCLOSURE =
  'This permanently deletes the subscriber’s platform account, memberships, sessions, and server-held data. ' +
  'Accounting data previously stored in users’ browsers cannot be remotely erased and may remain on those devices.';

export interface CategoryCount {
  key: string;
  label: string;
  count: number;
}

export interface IdentityDisposition {
  userId: string;
  email: string;
  outcome: 'retained_other_membership' | 'retained_platform_role' | 'retained_production' | 'deletable';
  detail: string;
}

export interface CleanupCandidate {
  organizationId: string;
  legalName: string;
  classification: string;
  status: string;
  eligible: boolean;
  blockers: { code: string; message: string }[];
  everActivated: boolean;
  hasSubscriptionHistory: boolean;
  hasBusinessActivity: boolean;
  storedDocumentCount: number;
  /**
   * Whether the server can reach and delete this tenant's accounting workspace.
   * Always `false` today: the books live in browser storage, not on the server.
   */
  workspaceDataReachable: boolean;
  warnings: string[];
  counts: CategoryCount[];
  identities: IdentityDisposition[];
  externalFileKeys: number;
}

export interface CleanupPreview {
  previewId: string;
  digest: string;
  previewedAt: string;
  candidates: CleanupCandidate[];
  eligibleCount: number;
  excludedCount: number;
}

export interface OrganizationOutcome {
  organizationId: string;
  legalName: string;
  deleted: boolean;
  removed: Record<string, number>;
  identitiesDeleted: string[];
  identitiesRetained: string[];
  filesQueued: number;
  error?: string;
}

export interface ExternalCleanupSummary {
  pending: number;
  completed: number;
  failed: number;
}

export interface CleanupResult {
  operationId: string;
  outcome: 'completed' | 'completed_with_pending_cleanup' | 'failed';
  organizations: OrganizationOutcome[];
  /** Reported separately on purpose: a database success is not a file success. */
  databaseDeletion: { succeeded: number; failed: number };
  externalCleanup: ExternalCleanupSummary;
  /**
   * The third storage layer. `no_server_workspace` states that the tenant's
   * books were never on the server, so this operation did not delete them —
   * deliberately not phrased as a success.
   */
  workspaceDeletion: { status: 'no_server_workspace'; detail: string };
  replayed: boolean;
}

export const cleanupApi = {
  /** Read-only. Safe to call as the operator adjusts the selection. */
  preview(organizationIds: string[]) {
    return api.post<CleanupPreview>('/api/admin/cleanup/preview', { organizationIds });
  },

  /** Every disposable tenant on the platform, for "select all eligible". */
  previewAllDisposable() {
    return api.post<CleanupPreview>('/api/admin/cleanup/preview', { allDisposable: true });
  },

  execute(input: {
    /** The ticked subset. Must be contained in `previewedOrganizationIds`. */
    organizationIds: string[];
    /**
     * Every id the preview covered. The console shows the whole disposable
     * roster and deletes a ticked subset of it, so the digest is bound to the
     * roster that was reviewed rather than to the selection — otherwise every
     * partial selection would be rejected as stale.
     */
    previewedOrganizationIds: string[];
    previewDigest: string;
    previewedAt: string;
    reason: string;
    confirmation: string;
    /**
     * Generated once per confirmation attempt by the caller, so a retried or
     * double-submitted request maps to the same server-side operation and
     * returns the original result instead of destroying a second time.
     */
    operationId: string;
  }) {
    return api.post<CleanupResult>('/api/admin/cleanup/execute', input);
  },

  /** Manual stand-in for a background worker; this deployment has none. */
  retryFiles(operationId?: string) {
    return api.post<ExternalCleanupSummary>('/api/admin/cleanup/retry-files', { operationId });
  },

  fileStatus() {
    return api.get<ExternalCleanupSummary>('/api/admin/cleanup/file-status');
  },
};

/**
 * Member management calls, in the two contexts the backend authorizes.
 *
 * The operator calls name the organization in the URL; the subscriber calls do
 * not name it at all — the server derives it from the caller's own membership,
 * so there is no id for a browser to tamper with. Sending an organization id the
 * caller is not entitled to simply fails: the admin routes require a verified
 * platform capability. See `server/src/routes/members.ts`.
 */
import { api } from './client';
import type { OrganizationRole } from '@/types/roles';

/**
 * The membership role, aliased to the one definition in `types/roles`.
 *
 * This used to restate a four-value list of its own, which quietly went stale
 * when the ladder gained `admin` and `manager` — an alias cannot.
 */
export type MemberRole = OrganizationRole;

/**
 * Roles an invitation may carry.
 *
 * Mirrors the backend's `ASSIGNABLE_ROLES`: ownership is transferred rather than
 * handed out, and minting an Organization Admin through an invite would be
 * lateral privilege propagation. The server refuses both regardless — this is
 * what stops the form offering them.
 */
export type InvitableRole = Exclude<OrganizationRole, 'owner' | 'admin'>;
export type MemberStatus = 'active' | 'invited' | 'suspended';

export interface MemberRecord {
  userId: string;
  membershipId: string;
  email: string;
  fullName: string;
  role: MemberRole;
  status: MemberStatus;
  accountStatus: string;
  emailVerified: boolean;
  lastLoginAt: string | null;
  joinedAt: string;
}

export interface MemberListResult {
  organizationId: string | null;
  members: MemberRecord[];
  seatsUsed: number;
  seatLimit: number | null;
  /** The caller's own role — subscriber context only. */
  role?: MemberRole | null;
  organization?: { id: string; legalName: string; status: string };
}


/**
 * Whether an invitation actually reached its recipient.
 *
 * `unavailable` is not a failure — no mail transport is configured, so nothing
 * was attempted and the administrator is the delivery channel. `failed` means
 * delivery was tried and broke. Neither may ever be rendered as "email sent".
 */
export type InvitationDelivery = 'sent' | 'unavailable' | 'failed';

/**
 * What the invite and resend endpoints return.
 *
 * ── `invitationToken` is present ONLY in development ─────────────────────────
 * The server strips it unless `EXPOSE_INVITATION_TOKENS` is enabled, which it
 * refuses to be in production. When it IS present, `developmentOnlyLink` is
 * true — the flag exists so the UI is obliged to label the link rather than
 * rendering a live credential as ordinary data.
 *
 * It must be held in local component state only: never a store, never browser
 * storage, never a URL, never a log.
 */
export interface InvitationResult {
  member: MemberRecord;
  /** Which credential path was used. */
  onboarding?: 'invitation' | 'temporary_password';
  /** True when the member must replace their credential at first sign-in. */
  mustChangePassword?: boolean;
  invitationToken?: string;
  expiresAt: string;
  delivery: InvitationDelivery;
  developmentOnlyLink: boolean;
  reusedExistingIdentity?: boolean;
}

/**
 * Seat usage, straight from the backend.
 *
 * Active AND pending-invited memberships each reserve a seat; suspended and
 * removed memberships release theirs. This is the server's own arithmetic — the
 * browser never recomputes it, and never enforces it.
 */
export interface SeatUsage {
  seatLimit: number | null;
  seatsUsed: number;
  activeMembers: number;
  pendingInvitations: number;
  suspendedMembers: number;
  seatsRemaining: number | null;
  atLimit: boolean;
}

export const memberApi = {
  /** Subscriber context: the caller's own organization. */
  listForCurrentOrganization(signal?: AbortSignal) {
    return api.get<MemberListResult>('/api/organizations/current/members', signal);
  },

  /** Operator context: an explicitly named subscriber organization. */
  listForOrganization(organizationId: string, signal?: AbortSignal) {
    return api.get<MemberListResult>(
      `/api/admin/organizations/${encodeURIComponent(organizationId)}/members`,
      signal,
    );
  },

  /**
   * Operator context: invite into an explicitly named subscriber.
   *
   * Returns the full invitation envelope, not just the member — the previous
   * type here said `{ member }`, which had gone stale against a backend that
   * also reports delivery and (in development only) the acceptance link.
   */
  inviteToOrganization(
    organizationId: string,
    input: { email: string; fullName: string; role: InvitableRole },
  ) {
    return api.post<InvitationResult>(
      `/api/admin/organizations/${encodeURIComponent(organizationId)}/members/invite`,
      input,
    );
  },

  /**
   * Operator context: seat usage for an explicitly named subscriber.
   *
   * Authoritative, from the same `seatUsage` the invitation path enforces. The
   * console used to decompose these figures from the roster in the browser,
   * which is a second calculation that can disagree with the one that actually
   * refuses an invitation.
   */
  seatsForOrganization(organizationId: string, signal?: AbortSignal) {
    return api.get<{ seats: SeatUsage }>(
      `/api/admin/organizations/${encodeURIComponent(organizationId)}/seats`,
      signal,
    );
  },

  /** Operator context: resend a pending invitation in a named subscriber. */
  resendInvitationForOrganization(organizationId: string, userId: string) {
    return api.post<InvitationResult>(
      `/api/admin/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}/resend-invitation`,
      {},
    );
  },

  /** Operator context: withdraw a pending invitation in a named subscriber. */
  cancelInvitationForOrganization(organizationId: string, userId: string) {
    return api.post<{ cancelled: true }>(
      `/api/admin/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}/cancel-invitation`,
      {},
    );
  },

  /* ── Subscriber context: the caller's OWN organization ─────────────────── */

  /**
   * Seat usage, as the server counts it.
   *
   * The same figures the invitation path enforces under its row lock, so the
   * screen and the server cannot disagree. Subscriber context only — the
   * operator roster carries `seatsUsed`/`seatLimit` on its own response.
   */
  seatsForCurrentOrganization(signal?: AbortSignal) {
    return api.get<{ seats: SeatUsage }>('/api/organizations/current/seats', signal);
  },

  /**
   * Add somebody to the caller's OWN organization.
   *
   * `temporaryPassword` is passed straight through and never retained by this
   * module: it is validated against the canonical policy and hashed server-side,
   * and no response ever returns it.
   */
  inviteToCurrentOrganization(input: {
    email: string;
    fullName: string;
    role: InvitableRole;
    onboarding?: 'invitation' | 'temporary_password';
    temporaryPassword?: string;
  }) {
    return api.post<InvitationResult>('/api/organizations/current/users/invite', input);
  },

  /**
   * Resend a pending invitation.
   *
   * Supersedes every outstanding link, so the previous one stops working. No
   * additional seat is consumed — the membership already exists.
   */
  resendInvitation(userId: string) {
    return api.post<InvitationResult>(
      `/api/organizations/current/users/${encodeURIComponent(userId)}/resend-invitation`,
      {},
    );
  },

  /** Withdraw a pending invitation. Releases its seat; keeps the identity. */
  cancelInvitation(userId: string) {
    return api.post<{ cancelled: true }>(
      `/api/organizations/current/users/${encodeURIComponent(userId)}/cancel-invitation`,
      {},
    );
  },

  /** Change a member's role or membership status inside the caller's own tenant. */
  updateInCurrentOrganization(
    userId: string,
    input: { role?: MemberRole; status?: MemberStatus; reason: string },
  ) {
    return api.patch<{ member: MemberRecord }>(
      `/api/organizations/current/users/${encodeURIComponent(userId)}`,
      input,
    );
  },

  updateInOrganization(
    organizationId: string,
    userId: string,
    input: { role?: MemberRole; status?: MemberStatus },
  ) {
    return api.patch<{ member: MemberRecord }>(
      `/api/admin/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}`,
      input,
    );
  },

  removeFromOrganization(organizationId: string, userId: string) {
    return api.del<{ removed: boolean }>(
      `/api/admin/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}`,
    );
  },
};

/**
 * Typed calls against the user-administration and permission surface.
 *
 * ── Why nothing here restates the catalogue ──────────────────────────────────
 * `fetchPermissionCatalog` returns the subjects, actions and role templates the
 * SERVER defines. This module has no list of modules, no list of actions and no
 * copy of what an Accountant may do — because a second copy is a copy that
 * drifts, and a permission editor showing something the resolver disagrees with
 * is worse than no editor.
 *
 * The types below describe the SHAPE of that payload. They do not enumerate its
 * contents: `subject` and `action` are strings, exactly as they arrive.
 *
 * ── Why every call is authorised server-side ─────────────────────────────────
 * Nothing in this module is a permission. The console hides controls the
 * operator cannot use as a courtesy, so it does not offer an action that would
 * come back 403 — but each route re-checks its own capability, and the resolver
 * re-runs the whole precedence rule. A client that ignores all of this gains
 * nothing.
 *
 * ── Credentials in responses ─────────────────────────────────────────────────
 * `createUser` and `issueInvitation` are the only calls that ever carry a
 * secret, and only in the single response that generated it. Those values go
 * straight to the dialog that shows them and never into a store, a log, a URL or
 * anything persisted.
 */
import { api } from './client';

/* ── The catalogue ────────────────────────────────────────────────────────── */

export interface PermissionSubjectView {
  id: string;
  label: string;
  group: string;
  scope: 'organization' | 'administration';
  /** The entitlement module the tenant must own, or null for the base product. */
  requiredModule: string | null;
  /** The actions that mean something for this subject. */
  actions: string[];
  description: string;
}

export interface PermissionRoleView {
  id: string;
  label: string;
  description: string;
  /** The template, as `subject:action` keys. Rendered as "inherited". */
  permissions: string[];
}

export interface PermissionCatalog {
  actions: Array<{ id: string; label: string }>;
  subjects: PermissionSubjectView[];
  roles: PermissionRoleView[];
}

/* ── Resolved permissions ─────────────────────────────────────────────────── */

/** Why a cell resolved the way it did. Mirrors the server's `PermissionSource`. */
export type PermissionSource =
  | 'platform_super_admin'
  | 'account_inactive'
  | 'no_membership'
  | 'membership_inactive'
  | 'subscription_inactive'
  | 'not_entitled'
  | 'user_deny'
  | 'user_grant'
  | 'role'
  | 'default_deny';

export interface ResolvedPermission {
  subject: string;
  action: string;
  allowed: boolean;
  source: PermissionSource;
  /** The role template grants this — the editor's "inherited" state. */
  inRoleTemplate: boolean;
  /** An explicit decision exists, whether or not it is currently in force. */
  override: 'grant' | 'deny' | null;
  /**
   * Configured to be allowed but refused because the package does not include
   * the module. The editor shows this as unavailable-and-preserved, never as
   * unset — the configuration behind it is intact and returns on an upgrade.
   */
  blockedByEntitlement: boolean;
}

export interface EffectivePermissions {
  userId: string;
  organizationId: string;
  role: string | null;
  membershipStatus: string | null;
  accountStatus: string;
  platformRoles: string[];
  isPlatformSuperAdmin: boolean;
  subscription: {
    active: boolean;
    status: string;
    planCode: string | null;
    planName: string | null;
    edition: string | null;
    modules: string[];
  };
  permissions: ResolvedPermission[];
  allowedKeys: string[];
}

export interface PermissionChange {
  subject: string;
  action: string;
  /** `inherit` removes the override, returning the cell to its role default. */
  effect: 'grant' | 'deny' | 'inherit';
}

export interface PermissionChangeResult {
  userId: string;
  organizationId: string;
  applied: number;
  granted: string[];
  denied: string[];
  reverted: string[];
  revokedSessions: number;
  effective: EffectivePermissions;
}

/* ── One-time credentials ─────────────────────────────────────────────────── */

/**
 * Shaped exactly like the subscriber-creation envelope, so the console has ONE
 * way to handle a one-time secret and one dialog to show it in.
 */
export interface OneTimeCredential {
  type: 'temporary_password' | 'invitation';
  temporaryPassword?: string;
  invitationToken?: string;
  expiresAt: string;
  deliveryStatus: 'sent' | 'unavailable' | 'failed';
  mustChangePassword: boolean;
  revokedSessions?: number;
  message: string;
}

export interface CreateUserInput {
  fullName: string;
  email: string;
  organizationId?: string | null;
  role?: string;
  accountStatus?: 'active' | 'disabled' | 'pending_verification';
  membershipStatus?: 'active' | 'invited' | 'suspended';
  platformRoles?: string[];
  onboarding: 'invitation' | 'temporary_password';
  permissions?: PermissionChange[];
  notes?: string;
}

export interface CreatedUserResponse {
  user: {
    userId: string;
    email: string;
    fullName: string;
    accountStatus: string;
    organizationId: string | null;
    role: string | null;
    membershipStatus: string | null;
    platformRoles: string[];
  };
  credential: OneTimeCredential;
}

/* ── Platform operator calls ──────────────────────────────────────────────── */

export function fetchPermissionCatalog(signal?: AbortSignal): Promise<PermissionCatalog> {
  return api.get<PermissionCatalog>('/api/admin/permissions/catalog', signal);
}

export function fetchEffectivePermissions(
  userId: string,
  organizationId: string,
  signal?: AbortSignal,
): Promise<EffectivePermissions> {
  return api.get<EffectivePermissions>(
    `/api/admin/users/${userId}/permissions?organizationId=${encodeURIComponent(organizationId)}`,
    signal,
  );
}

export function updatePermissions(
  userId: string,
  input: { organizationId: string; changes: PermissionChange[]; reason?: string },
): Promise<PermissionChangeResult> {
  return api.patch<PermissionChangeResult>(`/api/admin/users/${userId}/permissions`, input);
}

export function resetPermissionsToRole(
  userId: string,
  input: { organizationId: string; reason?: string },
): Promise<PermissionChangeResult> {
  return api.post<PermissionChangeResult>(`/api/admin/users/${userId}/permissions/reset`, input);
}

export function createUser(input: CreateUserInput): Promise<CreatedUserResponse> {
  return api.post<CreatedUserResponse>('/api/admin/users', input);
}

export function assignOrganization(
  userId: string,
  input: {
    organizationId: string;
    role: string;
    membershipStatus?: string;
    keepExisting?: boolean;
    reason: string;
  },
): Promise<{
  userId: string;
  organizationId: string;
  role: string;
  membershipStatus: string;
  previousOrganizationId: string | null;
  revokedSessions: number;
}> {
  return api.post(`/api/admin/users/${userId}/organization`, input);
}

export function setPlatformRole(
  userId: string,
  input: { role: string; granted: boolean; reason: string },
): Promise<{ userId: string; role: string; granted: boolean; revokedSessions: number }> {
  return api.patch(`/api/admin/users/${userId}/platform-role`, input);
}

/** Issue a fresh setup link. The token comes back once and is never retrievable. */
export function issueInvitation(
  userId: string,
  input: { ttlMinutes?: number; reason?: string } = {},
): Promise<{ member: { userId: string; email: string; fullName: string }; credential: OneTimeCredential }> {
  return api.post(`/api/admin/users/${userId}/invitation`, input);
}

export function revokeInvitations(
  userId: string,
  reason: string,
): Promise<{ userId: string; revoked: number }> {
  return api.post(`/api/admin/users/${userId}/invitation/revoke`, { reason });
}

/* ── Organization-admin calls (the caller's OWN tenant) ───────────────────── */

/**
 * The same catalogue, served to an Organization Admin.
 *
 * Note what is absent from every call below: an organization identifier. The
 * server derives it from the caller's own membership, so these functions have no
 * way to name a tenant and there is nothing for a modified request to point
 * somewhere else.
 */
export function fetchOwnPermissionCatalog(signal?: AbortSignal): Promise<PermissionCatalog> {
  return api.get<PermissionCatalog>('/api/organizations/current/permissions/catalog', signal);
}

export function fetchOwnUserPermissions(
  userId: string,
  signal?: AbortSignal,
): Promise<EffectivePermissions> {
  return api.get<EffectivePermissions>(`/api/organizations/current/users/${userId}/permissions`, signal);
}

export function updateOwnUserPermissions(
  userId: string,
  input: { changes: PermissionChange[]; reason?: string },
): Promise<PermissionChangeResult> {
  return api.patch<PermissionChangeResult>(
    `/api/organizations/current/users/${userId}/permissions`,
    input,
  );
}

export function resetOwnUserPermissions(
  userId: string,
  reason?: string,
): Promise<PermissionChangeResult> {
  return api.post<PermissionChangeResult>(
    `/api/organizations/current/users/${userId}/permissions/reset`,
    { reason },
  );
}

/* ── Invitation redemption (unauthenticated) ──────────────────────────────── */

export interface TokenDescription {
  valid: boolean;
  purpose: 'invitation' | 'reset' | null;
  /** `a***@example.com`. Enough to recognise, not enough to harvest. */
  maskedEmail: string | null;
  expiresAt: string | null;
}

/**
 * Check whether a setup link is still usable.
 *
 * A POST despite only reading: the token must not travel in a URL, where the
 * server's request log would capture it. See `server/src/routes/auth.ts`.
 *
 * Made once when the setup page mounts; the caller guards its own state update
 * on unmount rather than aborting, since the shared POST helper takes no signal.
 */
export function describeInvitation(token: string): Promise<TokenDescription> {
  return api.post<TokenDescription>('/api/auth/invitation/inspect', { token });
}

export function completePasswordSetup(
  token: string,
  newPassword: string,
): Promise<{ ok: true; email: string; purpose: 'invitation' | 'reset'; message: string }> {
  return api.post('/api/auth/reset-password', { token, newPassword });
}

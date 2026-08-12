/**
 * Projects — role-based permissions, following the existing organization role
 * model (`types/roles.OrganizationRole`) and the same shape as
 * `currencyPermissions`, `fixedAssetPermissions`, `entityPermissions` and
 * `journalPermissions`.
 *
 * ── Why creation is separated from selection ────────────────────────────────
 * A project is a reporting dimension: every posting tagged with it rolls into
 * its budget, its delivery reports and its recognition schedule. Reading and
 * tagging are ordinary daily work, so `projects.read` is broad. Minting a new
 * one silently creates a reporting bucket that finance has to reconcile later,
 * which is why `projects.create` is not.
 *
 * ── Where this is enforced, and the limit ───────────────────────────────────
 * In `store/projectStore.createProject` — on the write, not only on the button
 * that offers it. Ledgora's accounting data is browser-resident today, so the
 * store is the deepest boundary that exists: a genuine gate against the
 * application's own code paths, and NOT a security boundary against a user with
 * devtools. When projects move server-side these same rules must be restated
 * there, and the server's copy becomes the authoritative one.
 */
import type { OrganizationRole } from '@/types/roles';

export type ProjectPermission =
  | 'projects.read'
  | 'projects.create'
  | 'projects.edit'
  | 'projects.close';

const ALL: ProjectPermission[] = ['projects.read', 'projects.create', 'projects.edit', 'projects.close'];

/**
 * Owners and admins hold everything. Managers and accountants create and edit
 * projects as ordinary delivery/finance work — an accountant who cannot open a
 * project mid-entry is the friction this picker's create action exists to
 * remove — while closing one stays with administrators, because closing reaches
 * backwards into every posting already tagged to it. Members and viewers read.
 */
const ROLE_GRANTS: Record<OrganizationRole, ProjectPermission[]> = {
  owner: ALL,
  admin: ALL,
  manager: ['projects.read', 'projects.create', 'projects.edit'],
  accountant: ['projects.read', 'projects.create', 'projects.edit'],
  member: ['projects.read'],
  viewer: ['projects.read'],
};

export function roleHasProjectPermission(role: OrganizationRole, permission: ProjectPermission): boolean {
  return (ROLE_GRANTS[role] ?? []).includes(permission);
}

export interface ProjectPermissionResult {
  ok: boolean;
  error?: string;
}

export function assertProjectPermission(
  role: OrganizationRole,
  permission: ProjectPermission,
): ProjectPermissionResult {
  return roleHasProjectPermission(role, permission)
    ? { ok: true }
    : { ok: false, error: `Your role (${role}) does not include the "${permission}" permission.` };
}

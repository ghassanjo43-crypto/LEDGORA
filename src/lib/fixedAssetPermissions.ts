/**
 * Fixed Assets — role-based permissions, following the existing organization
 * role model (`types/roles.OrganizationRole`).
 *
 * A platform administrator inspecting a subscriber workspace in full-access
 * operator mode may use the module for support, but every posting is still
 * recorded against the selected organization and attributed to the REAL
 * administrator by the audit layer (`store/platformFullAccess`).
 */
import type { OrganizationRole } from '@/types/roles';

export type FixedAssetPermission =
  | 'fa.view'
  | 'fa.create'
  | 'fa.edit_draft'
  | 'fa.approve_capitalization'
  | 'fa.run_depreciation'
  | 'fa.approve_depreciation'
  | 'fa.post_journals'
  | 'fa.transfer'
  | 'fa.impair'
  | 'fa.revalue'
  | 'fa.dispose'
  | 'fa.reverse'
  | 'fa.configure'
  | 'fa.reports';

const ALL: FixedAssetPermission[] = [
  'fa.view', 'fa.create', 'fa.edit_draft', 'fa.approve_capitalization',
  'fa.run_depreciation', 'fa.approve_depreciation', 'fa.post_journals',
  'fa.transfer', 'fa.impair', 'fa.revalue', 'fa.dispose', 'fa.reverse',
  'fa.configure', 'fa.reports',
];

/** Role → permission grants. Owners/admins hold everything, including approvals. */
const ROLE_GRANTS: Record<OrganizationRole, FixedAssetPermission[]> = {
  owner: ALL,
  admin: ALL,
  // Accountants operate the module day-to-day but do not approve or configure.
  accountant: [
    'fa.view', 'fa.create', 'fa.edit_draft', 'fa.run_depreciation',
    'fa.post_journals', 'fa.transfer', 'fa.impair', 'fa.revalue',
    'fa.dispose', 'fa.reverse', 'fa.reports',
  ],
  /**
   * Manager — everything an Accountant may do, plus the approvals.
   *
   * This is the rung the backend catalogue defines the same way: the role that
   * posts is deliberately not the role that approves, so the Manager exists to
   * hold the second pair of eyes. Configuration stays with the administrators.
   */
  manager: [
    'fa.view', 'fa.create', 'fa.edit_draft', 'fa.run_depreciation',
    'fa.post_journals', 'fa.transfer', 'fa.impair', 'fa.revalue',
    'fa.dispose', 'fa.reverse', 'fa.reports',
    'fa.approve_capitalization', 'fa.approve_depreciation',
  ],
  member: ['fa.view', 'fa.create', 'fa.edit_draft', 'fa.reports'],
  viewer: ['fa.view', 'fa.reports'],
};

export function roleHasFaPermission(role: OrganizationRole, permission: FixedAssetPermission): boolean {
  return (ROLE_GRANTS[role] ?? []).includes(permission);
}

export interface FaPermissionResult {
  ok: boolean;
  error?: string;
}

export function assertFaPermission(role: OrganizationRole, permission: FixedAssetPermission): FaPermissionResult {
  return roleHasFaPermission(role, permission)
    ? { ok: true }
    : { ok: false, error: `Your role (${role}) does not include the "${permission}" permission.` };
}

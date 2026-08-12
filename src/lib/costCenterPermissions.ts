/**
 * Cost centers — role-based permissions, following the existing organization
 * role model (`types/roles.OrganizationRole`) and the same shape as
 * `projectPermissions` and the other module permission maps.
 *
 * ── Why creation is separated from selection ────────────────────────────────
 * A cost center is a node in a hierarchy that budgets, allocations and
 * management reporting all read. Adding one is not just adding a label: it
 * changes the shape of the tree those reports roll up, and a near-duplicate
 * created in a hurry splits a department's costs across two buckets that nobody
 * notices until the month-end variance looks wrong.
 *
 * ── Where this is enforced, and the limit ───────────────────────────────────
 * In `store/costCenterStore.createCostCenter` — on the write, not only on the
 * control that offers it. Ledgora's accounting data is browser-resident today,
 * so the store is the deepest boundary available: a real gate against the
 * application's own code paths, and NOT a security boundary against a user with
 * devtools. These rules must be restated server-side when this data migrates,
 * and the server's copy becomes authoritative.
 */
import type { OrganizationRole } from '@/types/roles';

export type CostCenterPermission =
  | 'cost_centers.read'
  | 'cost_centers.create'
  | 'cost_centers.edit'
  | 'cost_centers.archive';

const ALL: CostCenterPermission[] = [
  'cost_centers.read',
  'cost_centers.create',
  'cost_centers.edit',
  'cost_centers.archive',
];

/**
 * Owners and admins hold everything. Managers and accountants may open a cost
 * center as part of recording work; archiving one stays with administrators,
 * because it withdraws a node other records still point at. Members and viewers
 * read and tag.
 */
const ROLE_GRANTS: Record<OrganizationRole, CostCenterPermission[]> = {
  owner: ALL,
  admin: ALL,
  manager: ['cost_centers.read', 'cost_centers.create', 'cost_centers.edit'],
  accountant: ['cost_centers.read', 'cost_centers.create', 'cost_centers.edit'],
  member: ['cost_centers.read'],
  viewer: ['cost_centers.read'],
};

export function roleHasCostCenterPermission(
  role: OrganizationRole,
  permission: CostCenterPermission,
): boolean {
  return (ROLE_GRANTS[role] ?? []).includes(permission);
}

export interface CostCenterPermissionResult {
  ok: boolean;
  error?: string;
}

export function assertCostCenterPermission(
  role: OrganizationRole,
  permission: CostCenterPermission,
): CostCenterPermissionResult {
  return roleHasCostCenterPermission(role, permission)
    ? { ok: true }
    : { ok: false, error: `Your role (${role}) does not include the "${permission}" permission.` };
}

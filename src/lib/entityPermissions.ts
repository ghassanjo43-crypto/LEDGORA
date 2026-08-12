/**
 * Customers / suppliers / contacts — role-based permissions, following the
 * existing organization role model (`types/roles.OrganizationRole`) and the
 * same shape as `currencyPermissions`, `fixedAssetPermissions` and
 * `journalVoucherPermissions`.
 *
 * ── Why entity creation is a permission at all ───────────────────────────────
 * The entity directory is master data, and a counterparty record is what
 * invoices, bills, payments and journal attribution all point at. Letting any
 * reader mint one turns a shared reference list into a free-text field, and
 * silently splits a customer's history across near-duplicate records nobody
 * asked for. Reading is broad; creating is not.
 *
 * ── Where this is enforced ───────────────────────────────────────────────────
 * In `store/useEntityStore`, on the write itself — not only in the components
 * that offer the button. A UI check decides what to draw; the store check
 * decides what happens, and it is the one that holds when a caller reaches the
 * action another way. Ledgora's books are browser-resident today, so the store
 * is the deepest boundary that exists: it is a real gate against the
 * application's own code paths, and it is NOT a security boundary against a
 * user with devtools. When these records move server-side the same rule has to
 * be restated there, and that server check will be the authoritative one.
 */
import type { OrganizationRole } from '@/types/roles';

export type EntityPermission =
  | 'entity.view'
  | 'entity.create'
  | 'entity.edit'
  | 'entity.delete';

const ALL: EntityPermission[] = ['entity.view', 'entity.create', 'entity.edit', 'entity.delete'];

/**
 * Role → permission grants.
 *
 * Owners and admins hold everything. Accountants and managers create and edit
 * counterparties as ordinary daily work — an accountant who cannot add a
 * supplier mid-entry is the friction this module's caller exists to remove —
 * but deletion stays with administrators, because removing master data reaches
 * backwards into documents that already reference it. Members and viewers read.
 */
const ROLE_GRANTS: Record<OrganizationRole, EntityPermission[]> = {
  owner: ALL,
  admin: ALL,
  accountant: ['entity.view', 'entity.create', 'entity.edit'],
  manager: ['entity.view', 'entity.create', 'entity.edit'],
  member: ['entity.view'],
  viewer: ['entity.view'],
};

export function roleHasEntityPermission(role: OrganizationRole, permission: EntityPermission): boolean {
  return (ROLE_GRANTS[role] ?? []).includes(permission);
}

export interface EntityPermissionResult {
  ok: boolean;
  error?: string;
}

export function assertEntityPermission(
  role: OrganizationRole,
  permission: EntityPermission,
): EntityPermissionResult {
  return roleHasEntityPermission(role, permission)
    ? { ok: true }
    : { ok: false, error: `Your role (${role}) does not include the "${permission}" permission.` };
}

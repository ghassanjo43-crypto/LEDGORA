/**
 * General Journal — role-based permissions, following the existing organization
 * role model (`types/roles.OrganizationRole`) and the same shape as
 * `currencyPermissions`, `fixedAssetPermissions` and `entityPermissions`.
 *
 * ── Where this is enforced, and the honest limit ─────────────────────────────
 * In `store/journalStore`, on every mutating action — not in the components
 * that draw the buttons. A UI check decides what to offer; the store check
 * decides what happens, and it is the one that holds when an action is reached
 * another way.
 *
 * Ledgora's journals live in the customer's BROWSER workspace today; there is
 * no journal table on the account service, and therefore no server-side
 * authorization point for this module to call. The store is the deepest
 * boundary that exists: a real gate against the application's own code paths,
 * and NOT a security boundary against a user with devtools. When journals move
 * server-side, every rule in this file and in `journalAmendment` has to be
 * restated there, and the server's copy becomes the authoritative one. Until
 * then, describing this as "backend authorization" would be a false claim.
 */
import type { OrganizationRole } from '@/types/roles';

export type JournalPermission =
  | 'journal.read'
  | 'journal.create'
  | 'journal.edit'
  | 'journal.post'
  | 'journal.reverse';

const ALL: JournalPermission[] = [
  'journal.read',
  'journal.create',
  'journal.edit',
  'journal.post',
  'journal.reverse',
];

/**
 * Role → permission grants.
 *
 * Accountants prepare and correct entries as daily work. Posting and reversal
 * are the acts that change the ledger, so they sit with the manager rung and
 * above — the same approval ladder the rest of the modules use. Members and
 * viewers read.
 */
const ROLE_GRANTS: Record<OrganizationRole, JournalPermission[]> = {
  owner: ALL,
  admin: ALL,
  manager: ALL,
  accountant: ['journal.read', 'journal.create', 'journal.edit', 'journal.post'],
  member: ['journal.read'],
  viewer: ['journal.read'],
};

export function roleHasJournalPermission(role: OrganizationRole, permission: JournalPermission): boolean {
  return (ROLE_GRANTS[role] ?? []).includes(permission);
}

export interface JournalPermissionResult {
  ok: boolean;
  error?: string;
}

export function assertJournalPermission(
  role: OrganizationRole,
  permission: JournalPermission,
): JournalPermissionResult {
  return roleHasJournalPermission(role, permission)
    ? { ok: true }
    : { ok: false, error: `Your role (${role}) does not include the "${permission}" permission.` };
}

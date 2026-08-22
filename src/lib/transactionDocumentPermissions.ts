/**
 * Invoices, bills and payments — role-based permissions, following the existing
 * organization role model (`types/roles.OrganizationRole`) and the same shape as
 * `entityPermissions`, `journalPermissions` and `fixedAssetPermissions`.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * Every other transactional module already had one; these three did not, so
 * `invoiceStore.createDraft`, `billStore.createDraft` and
 * `paymentStore.createDraft` were reachable by any role including `viewer`.
 * That was invisible while the only callers were the modules' own pages, which
 * a viewer reaches through navigation the sidebar already gates. Adding a
 * Dashboard quick-create makes it reachable from somewhere else, so the missing
 * rule becomes real rather than theoretical.
 *
 * ── Where this is enforced ───────────────────────────────────────────────────
 * In the STORES, on the write itself — not in the menu that offers the button.
 * A UI check decides what to draw; the store check decides what happens, and it
 * is the one that holds when the action is reached another way. The Dashboard
 * reads the same resolver so the menu and the write agree, but the menu is not
 * where the decision is made.
 *
 * Ledgora's invoices, bills and payments are browser-resident today, so the
 * store is the deepest boundary that exists: a real gate against the
 * application's own code paths, and NOT a security boundary against a user with
 * devtools. When these records move server-side the same rules must be restated
 * there, and the server's copy becomes the authoritative one — exactly as
 * happened for journals in Phase A1.
 */
import type { OrganizationRole } from '@/types/roles';

/** The three documents the Dashboard can quick-create. */
export type TransactionDocument = 'invoice' | 'bill' | 'payment';

export type TransactionDocumentPermission =
  | 'invoice.create'
  | 'bill.create'
  | 'bill.edit'
  | 'bill.transition'
  | 'payment.create';

export const CREATE_PERMISSION: Record<TransactionDocument, TransactionDocumentPermission> = {
  invoice: 'invoice.create',
  bill: 'bill.create',
  payment: 'payment.create',
};

const ALL: TransactionDocumentPermission[] = ['invoice.create', 'bill.create', 'bill.edit', 'bill.transition', 'payment.create'];

/**
 * Role → permission grants.
 *
 * Deliberately the same ladder the rest of the document modules use. Raising an
 * invoice, entering a supplier bill and recording a payment are ordinary daily
 * bookkeeping, so accountants and managers hold them; owners and admins hold
 * everything. Members author their own records elsewhere but do not originate
 * documents that commit the company to a counterparty, and viewers read.
 *
 * Note what is NOT here: issuing, approving and posting. Those already live in
 * their own modules and are unaffected — this file governs the act of starting
 * a draft, which is the only thing a quick-create does.
 */
const ROLE_GRANTS: Record<OrganizationRole, TransactionDocumentPermission[]> = {
  owner: ALL,
  admin: ALL,
  manager: ALL,
  accountant: ALL,
  member: [],
  viewer: [],
};

export function roleHasTransactionDocumentPermission(
  role: OrganizationRole,
  permission: TransactionDocumentPermission,
): boolean {
  return (ROLE_GRANTS[role] ?? []).includes(permission);
}

export interface TransactionDocumentPermissionResult {
  ok: boolean;
  error?: string;
}

export function assertTransactionDocumentPermission(
  role: OrganizationRole,
  permission: TransactionDocumentPermission,
): TransactionDocumentPermissionResult {
  return roleHasTransactionDocumentPermission(role, permission)
    ? { ok: true }
    : { ok: false, error: `Your role (${role}) does not include the "${permission}" permission.` };
}

/** May this role start a draft of `document`? For UI affordances. */
export function roleCanCreateDocument(role: OrganizationRole, document: TransactionDocument): boolean {
  return roleHasTransactionDocumentPermission(role, CREATE_PERMISSION[document]);
}

export function roleCanEditBills(role: OrganizationRole): boolean {
  return roleHasTransactionDocumentPermission(role, 'bill.edit');
}

export function roleCanTransitionBills(role: OrganizationRole): boolean {
  return roleHasTransactionDocumentPermission(role, 'bill.transition');
}

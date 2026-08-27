/**
 * Who may amend a posted document.
 *
 * ── Why this is not a new permission system ──────────────────────────────────
 * The keys below are the SERVER catalogue's keys, verbatim:
 * `invoices:amend`, `bills:amend`, `credit_notes:amend` — the same
 * `subject:action` pairs `server/src/config/permissionCatalog` defines and
 * `permissionService` resolves. Nothing here invents a vocabulary. What this
 * module adds is the part the server cannot do for records that are not on it:
 * apply that catalogue to books held in the browser.
 *
 * ── Why an override layer exists at all ──────────────────────────────────────
 * The requirement is that the SUBSCRIBER decides which people may amend, not
 * that a role ladder decides for them. The server already models exactly that —
 * a role template plus per-user overrides in `user_permission_overrides` — but
 * invoices, bills and credit notes are browser-resident, so the browser stores
 * have never had anything to consult except `OrganizationRole`. This module
 * restates the server's PRECEDENCE, and `store/amendmentPolicyStore` holds the
 * overrides the owner sets, scoped to the workspace like every other business
 * record.
 *
 * The precedence is the server's, in the server's order:
 *
 *   1. account / membership inactive        → deny
 *   2. subscription inactive                → deny
 *   3. explicit user deny                   → deny
 *   4. explicit user grant                  → allow
 *   5. explicit role grant (subscriber set) → allow
 *   6. role template default                → allow / deny
 *
 * A platform operator working inside a subscriber workspace is NOT silently
 * given the permission: `platformOperatorMayAmend` is false, and the only way
 * a support session amends a subscriber's books is through the existing
 * impersonation surface, which records who did it.
 *
 * ── The honest limit ─────────────────────────────────────────────────────────
 * These checks run in the STORES, which is the deepest boundary that exists for
 * browser-resident books. That is a real gate against the application's own
 * code paths and NOT a security boundary against a user with devtools. When
 * these documents move server-side the same rules have to be restated there and
 * the server's copy becomes authoritative — exactly the note
 * `journalPermissions` and `transactionDocumentPermissions` already carry.
 */
import type { OrganizationRole } from '@/types/roles';
import type { AmendableDocumentType } from '@/types/documentAmendment';

/** A `subject:action` key from the server permission catalogue. */
export type AmendmentPermissionKey =
  | 'invoices:amend'
  | 'bills:amend'
  | 'credit_notes:amend';

export const AMENDMENT_PERMISSION_KEYS: AmendmentPermissionKey[] = [
  'invoices:amend',
  'bills:amend',
  'credit_notes:amend',
];

/**
 * Which catalogue permission governs which document.
 *
 * A supplier debit note is a posted sub-record of the bill it corrects, so it
 * is governed by `bills:amend`. Giving it a key of its own would create a
 * permission with no subject in the server catalogue — a cell the permission
 * matrix could never draw and the resolver would never grant.
 */
export const DOCUMENT_PERMISSION: Record<AmendableDocumentType, AmendmentPermissionKey> = {
  invoice: 'invoices:amend',
  bill: 'bills:amend',
  'credit-note': 'credit_notes:amend',
  'supplier-debit-note': 'bills:amend',
};

export const PERMISSION_LABELS: Record<AmendmentPermissionKey, string> = {
  'invoices:amend': 'Amend posted sales invoices',
  'bills:amend': 'Amend posted purchase bills',
  'credit_notes:amend': 'Amend posted credit notes',
};

/**
 * The role template, mirroring the server's.
 *
 * `amend` is deliberately NOT in the `BOOKKEEPING` action group the server
 * gives accountants and managers. Reversing a posted document and reposting a
 * corrected one restates figures a customer, a supplier or a tax return may
 * already have relied on, so the default holders are the two roles that hold
 * everything: the subscriber (`owner`) and the Organization Admin (`admin`).
 * Anyone else amends only because the subscriber decided they should — which is
 * the whole point of the requirement.
 */
const ROLE_TEMPLATE: Record<OrganizationRole, AmendmentPermissionKey[]> = {
  owner: [...AMENDMENT_PERMISSION_KEYS],
  admin: [...AMENDMENT_PERMISSION_KEYS],
  manager: [],
  accountant: [],
  member: [],
  viewer: [],
};

export function roleTemplateGrants(role: OrganizationRole, key: AmendmentPermissionKey): boolean {
  return (ROLE_TEMPLATE[role] ?? []).includes(key);
}

/** The template as data, for the policy editor's "inherited" column. */
export function amendmentRoleTemplate(): Record<OrganizationRole, AmendmentPermissionKey[]> {
  return {
    owner: [...ROLE_TEMPLATE.owner],
    admin: [...ROLE_TEMPLATE.admin],
    manager: [...ROLE_TEMPLATE.manager],
    accountant: [...ROLE_TEMPLATE.accountant],
    member: [...ROLE_TEMPLATE.member],
    viewer: [...ROLE_TEMPLATE.viewer],
  };
}

/* ── Overrides the subscriber sets ────────────────────────────────────────── */

export type OverrideEffect = 'grant' | 'deny';

/** One person, one permission, one explicit decision. */
export interface UserAmendmentOverride {
  userId: string;
  key: AmendmentPermissionKey;
  effect: OverrideEffect;
}

/** One role, one permission, granted for everybody holding that role. */
export interface RoleAmendmentGrant {
  role: OrganizationRole;
  key: AmendmentPermissionKey;
}

export interface AmendmentPolicy {
  roleGrants: RoleAmendmentGrant[];
  userOverrides: UserAmendmentOverride[];
}

export const EMPTY_AMENDMENT_POLICY: AmendmentPolicy = { roleGrants: [], userOverrides: [] };

/* ── Resolution ───────────────────────────────────────────────────────────── */

export type AmendmentPermissionSource =
  | 'membership_inactive'
  | 'subscription_inactive'
  | 'platform_operator'
  | 'user_deny'
  | 'user_grant'
  | 'role_grant'
  | 'role_template'
  | 'default_deny';

export interface AmendmentPermissionInput {
  role: OrganizationRole;
  /** Absent for the single-user local workspace, where there is no directory. */
  userId?: string;
  /** False when the membership or the account is not active. */
  membershipActive?: boolean;
  /** False when the subscription does not permit new posting. */
  subscriptionActive?: boolean;
  /**
   * True when a LEDGORA platform operator is acting inside this workspace.
   * Never an automatic grant — see the module note.
   */
  actingAsPlatformOperator?: boolean;
  policy?: AmendmentPolicy;
}

export interface AmendmentPermissionResult {
  allowed: boolean;
  source: AmendmentPermissionSource;
  error?: string;
}

/**
 * Resolve one permission for one person, in the server's precedence order.
 *
 * Fails closed at every step: an unknown role has no template, an absent policy
 * grants nothing, and an inactive membership or subscription refuses before any
 * grant is even consulted.
 */
export function resolveAmendmentPermission(
  input: AmendmentPermissionInput,
  key: AmendmentPermissionKey,
): AmendmentPermissionResult {
  if (input.membershipActive === false) {
    return {
      allowed: false,
      source: 'membership_inactive',
      error: 'Your membership of this organization is not active, so posted documents cannot be amended.',
    };
  }
  if (input.subscriptionActive === false) {
    return {
      allowed: false,
      source: 'subscription_inactive',
      error: 'This subscription does not currently permit new posting, so posted documents cannot be amended.',
    };
  }

  /*
   * A platform operator is refused BEFORE any grant is read.
   *
   * Support reaching into a subscriber's books and quietly restating a posted
   * invoice is precisely the thing the platform/organization role split exists
   * to prevent. Ledgora has no support-impersonation mechanism that records an
   * accounting write, so there is nothing here to authorise it with.
   */
  if (input.actingAsPlatformOperator) {
    return {
      allowed: false,
      source: 'platform_operator',
      error:
        'A Ledgora platform operator cannot amend a subscriber’s posted documents. '
        + 'The organization’s own owner or an authorized user must perform the amendment.',
    };
  }

  const policy = input.policy ?? EMPTY_AMENDMENT_POLICY;

  if (input.userId) {
    const explicit = policy.userOverrides.filter((o) => o.userId === input.userId && o.key === key);
    // A deny wins over a grant for the same person: the safer of two
    // contradictory instructions is the one that refuses.
    if (explicit.some((o) => o.effect === 'deny')) {
      return { allowed: false, source: 'user_deny', error: denyMessage(key) };
    }
    if (explicit.some((o) => o.effect === 'grant')) {
      return { allowed: true, source: 'user_grant' };
    }
  }

  if (policy.roleGrants.some((g) => g.role === input.role && g.key === key)) {
    return { allowed: true, source: 'role_grant' };
  }

  if (roleTemplateGrants(input.role, key)) {
    return { allowed: true, source: 'role_template' };
  }

  return { allowed: false, source: 'default_deny', error: denyMessage(key, input.role) };
}

function denyMessage(key: AmendmentPermissionKey, role?: OrganizationRole): string {
  const what = PERMISSION_LABELS[key].toLowerCase();
  return role
    ? `Your role (${role}) does not include permission to ${what}. The organization owner can grant it.`
    : `You do not have permission to ${what}.`;
}

/** The document-shaped form the stores call. */
export function resolveDocumentAmendmentPermission(
  input: AmendmentPermissionInput,
  documentType: AmendableDocumentType,
): AmendmentPermissionResult {
  return resolveAmendmentPermission(input, DOCUMENT_PERMISSION[documentType]);
}

/**
 * May this role or user administer the amendment policy itself?
 *
 * The same two roles the server lets administer `user_administration`: the
 * subscriber and the Organization Admin. A manager who has been GRANTED the
 * amendment permission cannot turn round and grant it to anybody else — a
 * permission that can widen itself is not a permission.
 */
export function canAdministerAmendmentPolicy(role: OrganizationRole): boolean {
  return role === 'owner' || role === 'admin';
}

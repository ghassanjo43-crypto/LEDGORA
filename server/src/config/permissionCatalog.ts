/**
 * The permission catalogue: what can be permitted, and what each role may do.
 *
 * ── Why this is code and not a table ─────────────────────────────────────────
 * This file is policy, and it sits beside `guards/platform.ts` for the same
 * reason that file is code: an authorization rule should change through review,
 * not through an UPDATE. Nothing here is editable at runtime, so there is no
 * path by which someone holding a database connection quietly widens what an
 * Accountant may do. What IS data — one administrator's exception for one
 * person — lives in `user_permission_overrides`, because that is the thing an
 * operator actually edits.
 *
 * ── Why the module ids are the coarse ones ───────────────────────────────────
 * Ledgora has two module vocabularies. `src/config/modules.ts` on the frontend
 * enumerates 68 fine-grained capabilities for the entitlement UI; the PLANS in
 * `db/migrations/002_reference_data` sell about a dozen coarse ones, and it is
 * the coarse set that lands in `subscription_plans.module_entitlements` and
 * therefore in `organization_entitlements.modules`.
 *
 * `requiredModule` below names the COARSE id, deliberately, because the
 * entitlement gate is a lookup against what the tenant actually bought. Keying
 * it to the fine-grained frontend registry would produce a gate that never
 * matches — every permission blocked, or (worse, if the check were written the
 * other way round) every permission allowed.
 *
 * ── Why the frontend does not restate any of this ────────────────────────────
 * `GET /api/admin/permissions/catalog` serves `catalogView()`. The permission
 * matrix renders whatever the server sends. There is exactly one list, and it is
 * this one — so a subject added here appears in the editor without a second
 * edit, and cannot appear in the editor without the resolver knowing about it.
 */

/* ── Actions ──────────────────────────────────────────────────────────────── */

/**
 * Every action the system can permit, in display order.
 *
 * These are the matrix's columns. Not every action is meaningful for every
 * subject — a Trial Balance cannot be "voided" — so each subject declares the
 * ones that apply and the matrix leaves the rest blank rather than offering a
 * control that would mean nothing.
 */
export const PERMISSION_ACTIONS = [
  'view',
  'create',
  'edit',
  'delete',
  'void',
  'approve',
  'submit',
  'post',
  'unpost',
  'export',
  'manage_users',
  'manage_subscriptions',
  'manage_organization_settings',
] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export const ACTION_LABELS: Record<PermissionAction, string> = {
  view: 'View',
  create: 'Create',
  edit: 'Edit',
  delete: 'Delete',
  void: 'Void',
  approve: 'Approve',
  submit: 'Submit',
  post: 'Post',
  unpost: 'Unpost',
  export: 'Export',
  manage_users: 'Manage users',
  manage_subscriptions: 'Manage subscriptions',
  manage_organization_settings: 'Manage settings',
};

/* ── Action groups, used to build role templates without a 300-cell table ──── */

/** Read-only rights. The floor for anyone who can open a module at all. */
const READ: PermissionAction[] = ['view', 'export'];
/** Day-to-day authoring: bring a record into existence and correct it. */
const AUTHOR: PermissionAction[] = ['create', 'edit', 'submit'];
/**
 * Acts that change the LEDGER or destroy a record. Posting an entry and voiding
 * a document are bookkeeping authority, deliberately separate from authoring.
 */
const BOOKKEEPING: PermissionAction[] = ['delete', 'void', 'post', 'unpost'];

/* ── Subjects ─────────────────────────────────────────────────────────────── */

/**
 * Where a subject can be administered.
 *
 *  · `organization` — a normal product area. Grantable to any member, gated by
 *    the tenant's entitlement.
 *  · `administration` — the tenant's own governance surfaces (its people, its
 *    package, its audit trail). Grantable INSIDE one organization and never
 *    beyond it: holding `user_administration.manage_users` lets an Organization
 *    Admin manage their own colleagues, and buys nothing whatsoever in any other
 *    tenant. Cross-tenant reach is a platform capability
 *    (`guards/platform.ts`) and is not representable here at all.
 */
export type SubjectScope = 'organization' | 'administration';

export interface PermissionSubject {
  id: string;
  label: string;
  /** Grouping for the matrix's section headers. */
  group: string;
  scope: SubjectScope;
  /**
   * The entitlement module the tenant must own, in the COARSE plan vocabulary.
   * `null` means the subject is part of the base product and is gated only by
   * having an active subscription at all.
   */
  requiredModule: string | null;
  /** The actions that mean something here. Anything else is not representable. */
  actions: PermissionAction[];
  description: string;
}

/**
 * The catalogue.
 *
 * Order is display order: the matrix renders rows in this sequence, grouped by
 * `group`, so the editor's shape is decided here rather than in the component.
 */
export const PERMISSION_SUBJECTS: PermissionSubject[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    group: 'Overview',
    scope: 'organization',
    requiredModule: null,
    actions: [...READ],
    description: 'The organization overview and its widgets.',
  },

  /* ── Accounting ────────────────────────────────────────────────────────── */
  {
    id: 'chart_of_accounts',
    label: 'Chart of Accounts',
    group: 'Accounting',
    scope: 'organization',
    requiredModule: 'accounting',
    actions: [...READ, ...AUTHOR, 'delete'],
    description: 'The account structure the ledger is built on.',
  },
  {
    id: 'general_journal',
    label: 'General Journal',
    group: 'Accounting',
    scope: 'organization',
    requiredModule: 'accounting',
    actions: [...READ, ...AUTHOR, ...BOOKKEEPING, 'approve'],
    description: 'Journal entries and vouchers, including posting and reversal.',
  },
  {
    id: 'opening_balances',
    label: 'Opening Balances',
    group: 'Accounting',
    scope: 'organization',
    requiredModule: 'accounting',
    actions: ['view', 'create', 'edit', 'submit', 'approve', 'post', 'void', 'export'],
    description: 'Prepare, approve, post and reverse the company migration opening balances.',
  },
  {
    id: 'general_ledger',
    label: 'General Ledger',
    group: 'Accounting',
    scope: 'organization',
    requiredModule: 'accounting',
    actions: [...READ],
    description: 'Posted ledger activity by account.',
  },
  {
    id: 'trial_balance',
    label: 'Trial Balance',
    group: 'Accounting',
    scope: 'organization',
    requiredModule: 'accounting',
    actions: [...READ],
    description: 'Period trial balance.',
  },
  {
    id: 'financial_statements',
    label: 'Financial Statements',
    group: 'Accounting',
    scope: 'organization',
    requiredModule: 'accounting',
    actions: [...READ],
    description: 'Balance sheet, income statement and cash flow.',
  },
  {
    id: 'tax',
    label: 'Tax',
    group: 'Accounting',
    scope: 'organization',
    requiredModule: 'accounting',
    actions: [...READ, ...AUTHOR, 'delete', 'approve', 'post'],
    description: 'Tax codes, periods and returns.',
  },
  {
    id: 'currencies',
    label: 'Currencies',
    group: 'Accounting',
    scope: 'organization',
    requiredModule: 'multi_currency',
    actions: [...READ, ...AUTHOR, 'delete', 'post'],
    description: 'Currency master, exchange rates and revaluation.',
  },
  {
    id: 'fixed_assets',
    label: 'Fixed Assets',
    group: 'Accounting',
    scope: 'organization',
    requiredModule: 'fixed_assets',
    actions: [...READ, ...AUTHOR, ...BOOKKEEPING, 'approve'],
    description: 'Asset register, depreciation, disposal and revaluation.',
  },

  /* ── Sales & purchases ─────────────────────────────────────────────────── */
  {
    id: 'customers',
    label: 'Customers',
    group: 'Sales & purchases',
    scope: 'organization',
    requiredModule: 'invoicing',
    actions: [...READ, ...AUTHOR, 'delete'],
    description: 'Customer master records and statements.',
  },
  {
    id: 'vendors',
    label: 'Vendors',
    group: 'Sales & purchases',
    scope: 'organization',
    requiredModule: 'invoicing',
    actions: [...READ, ...AUTHOR, 'delete'],
    description: 'Supplier master records and statements.',
  },
  {
    id: 'invoices',
    label: 'Invoices',
    group: 'Sales & purchases',
    scope: 'organization',
    requiredModule: 'invoicing',
    actions: [...READ, ...AUTHOR, ...BOOKKEEPING, 'approve'],
    description: 'Sales invoices, from draft to posted.',
  },
  {
    id: 'credit_notes',
    label: 'Credit Notes',
    group: 'Sales & purchases',
    scope: 'organization',
    requiredModule: 'invoicing',
    actions: [...READ, ...AUTHOR, ...BOOKKEEPING, 'approve'],
    description: 'Customer credit notes and their applications.',
  },
  {
    id: 'bills',
    label: 'Bills',
    group: 'Sales & purchases',
    scope: 'organization',
    requiredModule: 'invoicing',
    actions: [...READ, ...AUTHOR, ...BOOKKEEPING, 'approve'],
    description: 'Supplier bills, from draft to posted.',
  },
  {
    id: 'payments',
    label: 'Payments',
    group: 'Sales & purchases',
    scope: 'organization',
    requiredModule: 'invoicing',
    actions: [...READ, ...AUTHOR, ...BOOKKEEPING, 'approve'],
    description: 'Outgoing payments and their allocations.',
  },
  {
    id: 'receipts',
    label: 'Receipts',
    group: 'Sales & purchases',
    scope: 'organization',
    requiredModule: 'invoicing',
    actions: [...READ, ...AUTHOR, ...BOOKKEEPING, 'approve'],
    description: 'Incoming receipts and their allocations.',
  },

  /* ── Operations ────────────────────────────────────────────────────────── */
  {
    id: 'inventory',
    label: 'Inventory',
    group: 'Operations',
    scope: 'organization',
    requiredModule: 'inventory_basic',
    actions: [...READ, ...AUTHOR, ...BOOKKEEPING, 'approve'],
    description: 'Items, movements, valuation and warehouses.',
  },
  {
    id: 'cost_centers',
    label: 'Cost Centers',
    group: 'Operations',
    scope: 'organization',
    requiredModule: 'cost_centers',
    actions: [...READ, ...AUTHOR, 'delete', 'approve', 'post'],
    description: 'Cost centres, budgets and allocations.',
  },
  {
    id: 'projects',
    label: 'Projects',
    group: 'Operations',
    scope: 'organization',
    requiredModule: 'projects',
    actions: [...READ, ...AUTHOR, ...BOOKKEEPING, 'approve'],
    description: 'Projects, budgets, time, expenses and billing.',
  },
  {
    id: 'construction',
    label: 'Construction',
    group: 'Operations',
    scope: 'organization',
    requiredModule: 'construction',
    actions: [...READ, ...AUTHOR, ...BOOKKEEPING, 'approve'],
    description: 'Contracts, WBS, progress billing, retention and variations.',
  },
  {
    id: 'manufacturing',
    label: 'Manufacturing',
    group: 'Operations',
    scope: 'organization',
    requiredModule: 'manufacturing',
    actions: [...READ, ...AUTHOR, ...BOOKKEEPING, 'approve'],
    description: 'BOMs, routings, work orders, WIP and variance analysis.',
  },

  /* ── Reporting & records ───────────────────────────────────────────────── */
  {
    id: 'reports',
    label: 'Reports',
    group: 'Reporting & records',
    scope: 'organization',
    requiredModule: 'reports',
    actions: [...READ],
    description: 'Analytical and management reporting.',
  },
  {
    id: 'documents',
    label: 'Documents',
    group: 'Reporting & records',
    scope: 'organization',
    requiredModule: null,
    actions: [...READ, ...AUTHOR, 'delete'],
    description: 'Attachments and supporting files.',
  },
  {
    id: 'email_reminders',
    label: 'Email Reminders',
    group: 'Reporting & records',
    scope: 'organization',
    requiredModule: null,
    actions: [...READ, ...AUTHOR, 'delete', 'approve'],
    description: 'Automated customer reminders and their schedules.',
  },

  /* ── Administration (tenant governance, never cross-tenant) ────────────── */
  {
    id: 'user_administration',
    label: 'User Administration',
    group: 'Administration',
    scope: 'administration',
    requiredModule: null,
    actions: ['view', 'manage_users'],
    description: "Manage people, roles and permissions inside this organization only.",
  },
  {
    id: 'subscription_administration',
    label: 'Subscription Administration',
    group: 'Administration',
    scope: 'administration',
    requiredModule: null,
    actions: ['view', 'manage_subscriptions'],
    description: "View and change this organization's own package.",
  },
  {
    id: 'organization_settings',
    label: 'Organization Settings',
    group: 'Administration',
    scope: 'administration',
    requiredModule: null,
    actions: ['view', 'manage_organization_settings'],
    description: 'Fiscal year, base currency, branding and defaults.',
  },
  {
    id: 'audit_logs',
    label: 'Audit Logs',
    group: 'Administration',
    scope: 'administration',
    requiredModule: null,
    actions: [...READ],
    description: "This organization's audit history.",
  },
];

/* ── Lookup ───────────────────────────────────────────────────────────────── */

const SUBJECTS_BY_ID = new Map(PERMISSION_SUBJECTS.map((subject) => [subject.id, subject]));

export function findSubject(subjectId: string): PermissionSubject | undefined {
  return SUBJECTS_BY_ID.get(subjectId);
}

/** The canonical key for one permission. Used everywhere a Set is involved. */
export function permissionKey(subject: string, action: string): string {
  return `${subject}:${action}`;
}

/**
 * Is this a real permission?
 *
 * The anti-mass-assignment check. Every write path runs a caller-supplied
 * (subject, action) pair through this before it can become a row, so an invented
 * pair — `"*": "*"`, `"users": "become_super_admin"` — is rejected at the
 * boundary instead of being stored as a permission nothing enforces but a future
 * resolver might.
 */
export function isKnownPermission(subject: string, action: string): boolean {
  const found = SUBJECTS_BY_ID.get(subject);
  return found !== undefined && found.actions.includes(action as PermissionAction);
}

/** Every valid permission key. The universe a template is a subset of. */
export function allPermissionKeys(): string[] {
  return PERMISSION_SUBJECTS.flatMap((subject) =>
    subject.actions.map((action) => permissionKey(subject.id, action)),
  );
}

/* ── Roles ────────────────────────────────────────────────────────────────── */

/**
 * The authority ladder, strongest first.
 *
 * These reconcile the specification's required levels with what the database
 * already stored:
 *
 *   Super Admin          → NOT here. It is a PLATFORM role (`platform_user_roles`),
 *                          not an organization role, and conflating the two is
 *                          exactly what `guards/platform.ts` exists to prevent.
 *   Organization Admin   → `owner` (the transferable ownership position) and
 *                          `admin` (the role any number of members may hold).
 *   Manager              → `manager`   (added by migration 006)
 *   Accountant           → `accountant` (existing)
 *   Standard User        → `member`     (existing)
 *   Read-only / Auditor  → `viewer`     (existing)
 */
export const ORGANIZATION_ROLES = ['owner', 'admin', 'manager', 'accountant', 'member', 'viewer'] as const;
export type CatalogRole = (typeof ORGANIZATION_ROLES)[number];

export const ROLE_LABELS: Record<CatalogRole, string> = {
  owner: 'Owner',
  admin: 'Organization Admin',
  manager: 'Manager',
  accountant: 'Accountant',
  member: 'Standard User',
  viewer: 'Read-only / Auditor',
};

export const ROLE_DESCRIPTIONS: Record<CatalogRole, string> = {
  owner: 'Full authority, and the one account that cannot be removed without transferring ownership.',
  admin: 'Full authority inside this organization, including its people and its package.',
  manager: 'Everything an Accountant may do, plus approval of documents and entries.',
  accountant: 'Day-to-day bookkeeping: authoring, posting, reversing and voiding.',
  member: 'Creates and edits records but cannot post, void or approve them.',
  viewer: 'Reads and exports everything. Changes nothing.',
};

/* ── Role templates ───────────────────────────────────────────────────────── */

/** Subjects a role gets nothing on at all. */
const ADMINISTRATION_SUBJECTS = new Set(
  PERMISSION_SUBJECTS.filter((s) => s.scope === 'administration').map((s) => s.id),
);

/**
 * Build a template by picking, for every subject, the actions a role may use.
 *
 * Expressed as a rule rather than a literal 300-cell table so that adding a
 * subject to the catalogue cannot leave a role silently ungranted — or silently
 * granted — because someone updated five lists and forgot the sixth.
 */
function buildTemplate(allow: (subject: PermissionSubject) => PermissionAction[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const subject of PERMISSION_SUBJECTS) {
    for (const action of allow(subject)) {
      // Intersect with what the subject actually supports, so a rule can name an
      // action freely without inventing it where it has no meaning.
      if (subject.actions.includes(action)) keys.add(permissionKey(subject.id, action));
    }
  }
  return keys;
}

/**
 * The templates, as a deliberately MONOTONE ladder:
 *
 *   viewer ⊂ member ⊂ accountant ⊂ manager ⊂ admin = owner
 *
 * Monotonicity is a property worth having, not a coincidence: it makes "is this
 * a promotion or a demotion?" answerable, it means changing someone's role never
 * both grants and removes authority in one step, and it is asserted by a unit
 * test so a future edit cannot quietly break it.
 */
const ROLE_TEMPLATES: Record<CatalogRole, ReadonlySet<string>> = {
  /* Reads and exports everything, including the audit trail — that is what makes
     this role usable by an auditor. Governance surfaces stay closed: an auditor
     reads the books, they do not administer the people. */
  viewer: buildTemplate((subject) =>
    ADMINISTRATION_SUBJECTS.has(subject.id) && subject.id !== 'audit_logs' ? [] : [...READ],
  ),

  /* Authors records. Cannot make any of them permanent. */
  member: buildTemplate((subject) =>
    ADMINISTRATION_SUBJECTS.has(subject.id) && subject.id !== 'audit_logs'
      ? []
      : [...READ, ...AUTHOR],
  ),

  /* Bookkeeping authority: posts, unposts, voids and deletes drafts. Does NOT
     approve — approval is a second pair of eyes, and giving it to the same role
     that posts would make the control decorative. */
  accountant: buildTemplate((subject) =>
    ADMINISTRATION_SUBJECTS.has(subject.id) && subject.id !== 'audit_logs'
      ? []
      : [...READ, ...AUTHOR, ...BOOKKEEPING],
  ),

  /* The approver. Everything an Accountant may do, plus `approve`. */
  manager: buildTemplate((subject) =>
    ADMINISTRATION_SUBJECTS.has(subject.id) && subject.id !== 'audit_logs'
      ? []
      : [...READ, ...AUTHOR, ...BOOKKEEPING, 'approve'],
  ),

  /* Full authority inside this tenant, governance included. Still confined to
     this tenant: `manage_users` here is scoped by the organization the
     membership belongs to and confers nothing anywhere else. */
  admin: buildTemplate((subject) => subject.actions),
  owner: buildTemplate((subject) => subject.actions),
};

/** The permissions a role grants by default, before any override. */
export function roleTemplate(role: string): ReadonlySet<string> {
  return ROLE_TEMPLATES[role as CatalogRole] ?? new Set<string>();
}

export function isCatalogRole(role: string): role is CatalogRole {
  return (ORGANIZATION_ROLES as readonly string[]).includes(role);
}

/* ── Serialisable view, for the permission editor ─────────────────────────── */

export interface PermissionCatalogView {
  actions: Array<{ id: PermissionAction; label: string }>;
  subjects: Array<{
    id: string;
    label: string;
    group: string;
    scope: SubjectScope;
    requiredModule: string | null;
    actions: PermissionAction[];
    description: string;
  }>;
  roles: Array<{
    id: CatalogRole;
    label: string;
    description: string;
    /** The template, as `subject:action` keys — what the editor shows as "inherited". */
    permissions: string[];
  }>;
}

/**
 * The whole catalogue, ready to serialise.
 *
 * This is what `GET /api/admin/permissions/catalog` returns and what the matrix
 * renders. The frontend keeps no copy of any of it.
 */
export function catalogView(): PermissionCatalogView {
  return {
    actions: PERMISSION_ACTIONS.map((id) => ({ id, label: ACTION_LABELS[id] })),
    subjects: PERMISSION_SUBJECTS.map((subject) => ({ ...subject, actions: [...subject.actions] })),
    roles: ORGANIZATION_ROLES.map((id) => ({
      id,
      label: ROLE_LABELS[id],
      description: ROLE_DESCRIPTIONS[id],
      permissions: [...roleTemplate(id)].sort(),
    })),
  };
}

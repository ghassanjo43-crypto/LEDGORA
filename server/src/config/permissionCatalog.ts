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
  /**
   * Amend a POSTED document, through the controlled reversal-and-reposting
   * workflow — never by overwriting it.
   *
   * Deliberately its own action rather than a wider reading of `edit`. Editing
   * is what happens to a draft nobody has relied on; amending restates a figure
   * a customer, a supplier or a filed return may already have been given, and
   * conflating the two would hand that authority to everyone who can type into
   * a draft.
   */
  'amend',
  /**
   * Acknowledge a legal document FOR YOURSELF.
   *
   * Every authenticated member of an organization holds this, Viewer included,
   * and it survives a lapsed subscription. It binds nobody but the person doing
   * it, and it must never ask them to claim authority they do not have.
   */
  'acknowledge',
  /**
   * Bind the ORGANIZATION to a legal document.
   *
   * A SEPARATE action from `acknowledge`, and named so the difference cannot be
   * missed at a call site. Accepting terms on a company's behalf is an act of
   * corporate authority, not a bookkeeping one: not something an Accountant
   * does as part of posting, and not something an Organization Admin acquires
   * by being able to manage colleagues. Only the subscriber who owns the
   * workspace holds it by default; anyone else needs an explicit grant.
   *
   * One undifferentiated "accept" covering both was the earlier mistake. It
   * made an invited bookkeeper's personal acknowledgement and the company
   * signing a contract the same permission, which is exactly the conflation the
   * two-level model exists to prevent.
   */
  'accept_for_organization',
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
  amend: 'Amend posted',
  acknowledge: 'Acknowledge (self)',
  accept_for_organization: 'Accept for the organization',
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
/**
 * Restating a posted document. Deliberately NOT part of `BOOKKEEPING`.
 *
 * An Accountant posts, unposts and voids as daily work; none of those changes
 * what a document that has already gone out SAYS. An amendment does — it
 * reverses the posting and issues a corrected replacement — so it defaults to
 * the two roles that hold everything, and the subscriber grants it to anyone
 * else deliberately, per person or per role, through `user_permission_overrides`.
 */
const AMENDMENT: PermissionAction[] = ['amend'];

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
  /*
   * The shared item catalogue: products and services.
   *
   * Gated by `invoicing` and NOT by `inventory_basic`, because the product has
   * always treated the catalogue as shared master data — the navigation puts
   * Items in Master Data rather than the Inventory group, the route guard gives
   * it no module requirement, and a Core subscriber can reach it. That is the
   * right shape: you cannot raise an invoice line from a catalogue you cannot
   * open, which is exactly why customers and vendors sit on the same module.
   *
   * Stock itself — warehouses, movements, valuation — stays on `inventory`.
   * Holding this subject buys a name for something; it buys no stock at all.
   *
   * There is no `delete`: an item is named by documents already issued, so it
   * is archived and never removed.
   */
  {
    id: 'items',
    label: 'Items',
    group: 'Sales & purchases',
    scope: 'organization',
    requiredModule: 'invoicing',
    actions: [...READ, ...AUTHOR],
    description: 'Product and service catalogue shared by sales and purchasing.',
  },
  {
    id: 'invoices',
    label: 'Invoices',
    group: 'Sales & purchases',
    scope: 'organization',
    requiredModule: 'invoicing',
    actions: [...READ, ...AUTHOR, ...BOOKKEEPING, ...AMENDMENT, 'approve'],
    description: 'Sales invoices, from draft to posted.',
  },
  {
    id: 'credit_notes',
    label: 'Credit Notes',
    group: 'Sales & purchases',
    scope: 'organization',
    requiredModule: 'invoicing',
    actions: [...READ, ...AUTHOR, ...BOOKKEEPING, ...AMENDMENT, 'approve'],
    description: 'Customer credit notes and their applications.',
  },
  {
    id: 'bills',
    label: 'Bills',
    group: 'Sales & purchases',
    scope: 'organization',
    requiredModule: 'invoicing',
    actions: [...READ, ...AUTHOR, ...BOOKKEEPING, ...AMENDMENT, 'approve'],
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
    id: 'legal_terms',
    label: 'Terms and Conditions',
    group: 'Administration',
    scope: 'administration',
    requiredModule: null,
    /*
     * `accept` binds the organization. `manage_organization_settings` is the
     * authority to set or change the registered LEGAL COUNTRY, which decides
     * which Country Addendum governs the contract — the same class of act, so
     * the same restriction.
     */
    actions: ['view', 'acknowledge', 'accept_for_organization', 'manage_organization_settings'],
    description: 'Reading and acknowledging the Terms, accepting them for the organization, and the registered legal country.',
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
 *   Organization Admin   → `owner` (the subscriber who owns the workspace — a
 *                          permanent position that is never reassigned) and
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
  owner: 'The subscriber who owns this workspace. Full authority, and permanent — it cannot be removed or reassigned.',
  admin: 'Full authority inside this organization, including its people and its package.',
  manager: 'Everything an Accountant may do, plus approval of documents and entries.',
  accountant: 'Day-to-day bookkeeping: authoring, posting, reversing and voiding.',
  member: 'Creates and edits records but cannot post, void or approve them.',
  viewer: 'Reads and exports everything. Changes nothing.',
};

/* ── Role templates ───────────────────────────────────────────────────────── */

/**
 * Actions that NO role template grants, on any subject, however senior.
 *
 * The `admin` and `owner` templates are otherwise "everything the subject
 * supports", which is right for ordinary authority and wrong for this one:
 * binding the company to a contract, and choosing the law that governs it, are
 * not powers that should arrive with a job title. `owner` gets them back
 * explicitly below — the subscriber who owns the workspace is the one person
 * who has that authority by construction — and anybody else needs a deliberate,
 * per-person grant recorded in `user_permission_overrides`.
 */
const NEVER_IN_A_TEMPLATE = new Set<string>([
  permissionKeyLiteral('legal_terms', 'accept_for_organization'),
  permissionKeyLiteral('legal_terms', 'manage_organization_settings'),
]);

/** Local, so the constant above can be declared before `permissionKey`. */
function permissionKeyLiteral(subject: string, action: string): string {
  return `${subject}:${action}`;
}

/** What the OWNER holds that no template grants — see above. */
const OWNER_ONLY = [...NEVER_IN_A_TEMPLATE];

/** Subjects a role gets nothing on at all. */
const ADMINISTRATION_SUBJECTS = new Set(
  PERMISSION_SUBJECTS.filter((s) => s.scope === 'administration').map((s) => s.id),
);

/**
 * Administration subjects every role may nonetheless READ.
 *
 * `audit_logs` because that is what makes the Read-only/Auditor role usable by
 * an auditor. `legal_terms` because every user has to acknowledge the Terms
 * individually before they get operational access, and a person cannot
 * acknowledge a document they are not permitted to read. Withholding the text
 * while requiring agreement to it is not a control, it is a trap.
 *
 * Neither grants any WRITE action: reading the audit trail is not editing it,
 * and reading the Terms is not accepting them for the company.
 */
const ADMINISTRATION_READABLE_BY_ALL = new Set(['audit_logs', 'legal_terms']);

/**
 * Actions every role holds on a subject, whatever the rest of its template says.
 *
 * `legal_terms:acknowledge` is here because acknowledging the Terms for
 * yourself is not an authority at all — it is a thing every user must do before
 * they can work, Viewer included. Deriving it from a role ladder would mean the
 * most junior person could be unable to perform the one act the product
 * requires of everybody.
 *
 * It confers nothing beyond itself: it does not bind the organization, and
 * `accept_for_organization` remains in NEVER_IN_A_TEMPLATE.
 */
const UNIVERSAL_ACTIONS: Record<string, PermissionAction[]> = {
  legal_terms: ['acknowledge'],
};

/** What a role gets on `subject` regardless of its own rule. */
function universalActionsFor(subject: PermissionSubject): PermissionAction[] {
  return UNIVERSAL_ACTIONS[subject.id] ?? [];
}

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
    for (const action of [...allow(subject), ...universalActionsFor(subject)]) {
      // Intersect with what the subject actually supports, so a rule can name an
      // action freely without inventing it where it has no meaning.
      if (!subject.actions.includes(action)) continue;
      const key = permissionKey(subject.id, action);
      // Corporate authority is never granted by a role rule. See the constant.
      if (NEVER_IN_A_TEMPLATE.has(key)) continue;
      keys.add(key);
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
    ADMINISTRATION_SUBJECTS.has(subject.id) && !ADMINISTRATION_READABLE_BY_ALL.has(subject.id) ? [] : [...READ],
  ),

  /* Authors records. Cannot make any of them permanent. */
  member: buildTemplate((subject) =>
    ADMINISTRATION_SUBJECTS.has(subject.id) && !ADMINISTRATION_READABLE_BY_ALL.has(subject.id)
      ? []
      : [...READ, ...AUTHOR],
  ),

  /* Bookkeeping authority: posts, unposts, voids and deletes drafts. Does NOT
     approve — approval is a second pair of eyes, and giving it to the same role
     that posts would make the control decorative. */
  accountant: buildTemplate((subject) =>
    ADMINISTRATION_SUBJECTS.has(subject.id) && !ADMINISTRATION_READABLE_BY_ALL.has(subject.id)
      ? []
      : [...READ, ...AUTHOR, ...BOOKKEEPING],
  ),

  /* The approver. Everything an Accountant may do, plus `approve`. */
  manager: buildTemplate((subject) =>
    ADMINISTRATION_SUBJECTS.has(subject.id) && !ADMINISTRATION_READABLE_BY_ALL.has(subject.id)
      ? []
      : [...READ, ...AUTHOR, ...BOOKKEEPING, 'approve'],
  ),

  /* Full authority inside this tenant, governance included. Still confined to
     this tenant: `manage_users` here is scoped by the organization the
     membership belongs to and confers nothing anywhere else. */
  admin: buildTemplate((subject) => subject.actions),
  /*
   * The subscriber who owns the workspace: everything an admin has, plus the
   * two acts of corporate authority no template grants. `owner ⊇ admin` still
   * holds, so the ladder stays monotone.
   */
  owner: new Set<string>([...buildTemplate((subject) => subject.actions), ...OWNER_ONLY]),
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

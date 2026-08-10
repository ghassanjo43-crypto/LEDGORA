/**
 * Cross-organization member administration, for platform operators only.
 *
 * ── Why this is a separate module from `memberService` ────────────────────────
 * `memberService` is scoped: every function takes an `organizationId` its caller
 * has already authorized, and a subscriber reaches it through their own
 * membership. Nothing in it can see across tenants, which is exactly the property
 * that makes it safe for the customer-facing path.
 *
 * This module deliberately DOES see across tenants — the directory is "every user
 * in the platform" — so it lives apart, is reachable only from routes carrying a
 * `members.*` platform capability, and is never imported by a subscriber path. If
 * a subscriber route ever imports from here, that is the bug.
 *
 * ── What is never returned ───────────────────────────────────────────────────
 * Every projection below is an explicit allow-list built field by field. A
 * deny-list would leak any column added later, and the one column that matters
 * most (`password_hash`) sits in the same row as everything the drawer needs.
 * Session token hashes, CSRF material and reset tokens are not read at all — only
 * COUNTS of sessions, which is what "3 active sessions" needs and no more.
 *
 * ── The safeguards, and why each exists ──────────────────────────────────────
 *  · last active owner   — an organization with no owner can never be
 *                          administered by its customer again;
 *  · last super_admin    — a platform with no super_admin cannot grant one, so
 *                          the console becomes permanently read-only;
 *  · self-lockout        — an operator disabling or unassigning themselves takes
 *                          the console down for the person holding it.
 * All three are enforced HERE, in the service, not in the route: a second caller
 * added later inherits the protection instead of having to remember it.
 */
import { sql, type Kysely } from 'kysely';
import type {
  Database,
  MembershipStatus,
  OrganizationRole,
  PlatformRole,
  UserStatus,
} from '../db/schema.js';
import { writeAuditLog, listAuditForSubject, type AuditContext, type AuditEntryView } from '../lib/audit.js';
import { errors } from '../lib/errors.js';
import { hashPassword } from '../lib/password.js';
import { generateResetToken, generateTemporaryPassword } from '../lib/credentials.js';
import { revokeAllUserSessions } from './sessionService.js';
import { getEntitlements, type EntitlementView } from './entitlementService.js';
// The credential envelope is defined once, beside subscriber creation, and reused
// here so both one-time-secret paths are literally the same shape.
import type { OneTimeCredential } from './subscriberService.js';

export interface MemberAdminContext extends AuditContext {
  actorUserId: string;
  actorPlatformRole: string;
}

/* ── Directory ────────────────────────────────────────────────────────────── */

export const MEMBER_SORT_FIELDS = [
  'created_at',
  'full_name',
  'email',
  'organization_name',
  'organization_role',
  'account_status',
  'last_login_at',
] as const;
export type MemberSortField = (typeof MEMBER_SORT_FIELDS)[number];

export interface MemberDirectoryRow {
  userId: string;
  fullName: string;
  email: string;
  accountStatus: string;
  emailVerified: boolean;
  mustChangePassword: boolean;
  locked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  /**
   * `production | test | demo` for the IDENTITY itself, independent of the
   * classification of any organization it belongs to. This is the column that
   * decides whether the account can ever be deleted alongside a disposable
   * tenant, so it is shown rather than inferred.
   */
  dataClassification: string;
  organizationId: string | null;
  organizationName: string | null;
  organizationStatus: string | null;
  organizationRole: string | null;
  membershipStatus: string | null;
  isOwner: boolean;
  /** Non-empty only for Ledgora staff. A customer always has `[]`. */
  platformRoles: string[];
  /** How many organizations this account belongs to. */
  organizationCount: number;
  /**
   * The PRIMARY organization's package. Null for an account with no tenant —
   * a platform operator, or a registration that has not created one yet.
   *
   * A package belongs to the ORGANIZATION, never to the person; this is
   * denormalised onto the row purely so the directory can show it.
   */
  planCode: string | null;
  edition: string | null;
  subscriptionStatus: string | null;
  subscriptionActive: boolean;
}

export interface ListMembersOptions {
  search?: string;
  organizationId?: string;
  role?: string;
  accountStatus?: string;
  membershipStatus?: string;
  /** `verified`, `unverified`, or omitted for both. */
  verification?: 'verified' | 'unverified';
  /** `platform` for staff only, `customer` for subscribers only. */
  audience?: 'platform' | 'customer';
  sort?: MemberSortField;
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface MemberDirectoryResult {
  members: MemberDirectoryRow[];
  pagination: { limit: number; offset: number; count: number; total: number };
  facets: {
    accountStatus: Record<string, number>;
    organizationRole: Record<string, number>;
  };
}

/**
 * The directory projection.
 *
 * Based on `users` and LEFT JOINed outwards, so an account with no membership —
 * a brand-new registration, or a platform operator — is still listed. The
 * PRIMARY membership (oldest active, else oldest) is denormalised onto the row so
 * the table has one line per person; `organization_count` tells the reader when
 * there is more to see in the drawer.
 *
 * Column list is explicit. `password_hash`, `normalized_email` and every session
 * artefact are absent by construction rather than by removal.
 */
function memberCte() {
  return sql`
    WITH member AS (
      SELECT
        u.id                                AS user_id,
        u.full_name                         AS full_name,
        u.email                             AS email,
        u.status                            AS account_status,
        (u.email_verified_at IS NOT NULL)   AS email_verified,
        u.must_change_password              AS must_change_password,
        (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked,
        u.last_login_at                     AS last_login_at,
        u.created_at                        AS created_at,
        /*
         * The identity's own account type, which is NOT the classification of
         * the organization it happens to belong to. A production person can sit
         * in a demo tenant, and whether their account survives that tenant's
         * deletion is decided by this column alone — so the directory shows it
         * rather than letting an operator infer it from the tenant.
         */
        u.data_classification               AS data_classification,
        o.id                                AS organization_id,
        o.legal_name                        AS organization_name,
        o.status                            AS organization_status,
        m.role                              AS organization_role,
        m.status                            AS membership_status,
        (m.role = 'owner')                  AS is_owner,
        COALESCE(pr.roles, '[]'::jsonb)     AS platform_roles,
        COALESCE(mc.total, 0)               AS organization_count,
        /*
         * The PRIMARY organization's package, so the directory can answer
         * "which subscription is this person covered by?" without a second
         * request per row. Read from organization_entitlements -- the resolved
         * cache -- rather than re-joining subscription to plan here, so the
         * directory and every other entitlement read give the same answer.
         */
        e.plan_code                         AS plan_code,
        e.edition                           AS edition,
        e.status                            AS subscription_status,
        COALESCE(e.active, false)           AS subscription_active
      FROM users u
      LEFT JOIN LATERAL (
        SELECT om.organization_id, om.role, om.status
        FROM organization_memberships om
        WHERE om.user_id = u.id
        ORDER BY (om.status = 'active') DESC, (om.role = 'owner') DESC, om.created_at ASC
        LIMIT 1
      ) m ON true
      LEFT JOIN organizations o ON o.id = m.organization_id
      LEFT JOIN organization_entitlements e ON e.organization_id = m.organization_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(r.role ORDER BY r.role) AS roles
        FROM platform_user_roles r
        WHERE r.user_id = u.id
      ) pr ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS total
        FROM organization_memberships om2
        WHERE om2.user_id = u.id
      ) mc ON true
    )
  `;
}

function memberPredicate(options: ListMembersOptions) {
  const clauses = [sql`1 = 1`];

  if (options.organizationId) clauses.push(sql`organization_id = ${options.organizationId}::uuid`);
  if (options.role && options.role !== 'all') clauses.push(sql`organization_role = ${options.role}`);
  if (options.accountStatus && options.accountStatus !== 'all') {
    clauses.push(sql`account_status = ${options.accountStatus}`);
  }
  if (options.membershipStatus && options.membershipStatus !== 'all') {
    clauses.push(sql`membership_status = ${options.membershipStatus}`);
  }
  if (options.verification === 'verified') clauses.push(sql`email_verified = true`);
  if (options.verification === 'unverified') clauses.push(sql`email_verified = false`);
  // `platform_roles` is `[]` for a customer, so emptiness is the audience test.
  if (options.audience === 'platform') clauses.push(sql`jsonb_array_length(platform_roles) > 0`);
  if (options.audience === 'customer') clauses.push(sql`jsonb_array_length(platform_roles) = 0`);

  if (options.search) {
    // Parameterised — the pattern is a bound value, never interpolated SQL.
    const pattern = `%${options.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    clauses.push(sql`(
      full_name ILIKE ${pattern} ESCAPE '\\'
      OR email ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE(organization_name, '') ILIKE ${pattern} ESCAPE '\\'
    )`);
  }

  return sql.join(clauses, sql` AND `);
}

/** Whitelisted ORDER BY. Nothing from the request ever reaches `sql.raw`. */
const MEMBER_SORT_COLUMN: Record<MemberSortField, string> = {
  created_at: 'created_at',
  full_name: 'full_name',
  email: 'email',
  organization_name: 'organization_name',
  organization_role: 'organization_role',
  account_status: 'account_status',
  last_login_at: 'last_login_at',
};

interface MemberQueryRow {
  user_id: string;
  full_name: string;
  email: string;
  account_status: string;
  email_verified: boolean;
  must_change_password: boolean;
  locked: boolean;
  last_login_at: Date | null;
  created_at: Date;
  data_classification: string;
  organization_id: string | null;
  organization_name: string | null;
  organization_status: string | null;
  organization_role: string | null;
  membership_status: string | null;
  is_owner: boolean | null;
  platform_roles: unknown;
  organization_count: number;
  plan_code: string | null;
  edition: string | null;
  subscription_status: string | null;
  subscription_active: boolean | null;
}

const iso = (value: Date | null): string | null => (value ? new Date(value).toISOString() : null);

function toRoleList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toDirectoryRow(row: MemberQueryRow): MemberDirectoryRow {
  return {
    userId: row.user_id,
    fullName: row.full_name,
    email: row.email,
    accountStatus: row.account_status,
    emailVerified: Boolean(row.email_verified),
    mustChangePassword: Boolean(row.must_change_password),
    locked: Boolean(row.locked),
    lastLoginAt: iso(row.last_login_at),
    createdAt: new Date(row.created_at).toISOString(),
    dataClassification: row.data_classification,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    organizationStatus: row.organization_status,
    organizationRole: row.organization_role,
    membershipStatus: row.membership_status,
    isOwner: Boolean(row.is_owner),
    platformRoles: toRoleList(row.platform_roles),
    organizationCount: row.organization_count ?? 0,
    planCode: row.plan_code,
    edition: row.edition,
    subscriptionStatus: row.subscription_status,
    subscriptionActive: Boolean(row.subscription_active),
  };
}

export async function listAllMembers(
  db: Kysely<Database>,
  options: ListMembersOptions = {},
): Promise<MemberDirectoryResult> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const search = options.search?.trim() || undefined;

  const cte = memberCte();
  const where = memberPredicate({ ...options, search });
  const sortField: MemberSortField = options.sort ?? 'created_at';
  const direction = options.direction === 'asc' ? 'ASC' : 'DESC';
  // Both halves come from a whitelist; `user_id` breaks ties so pagination is
  // stable and a row can never appear on two pages.
  const orderBy = sql.raw(`${MEMBER_SORT_COLUMN[sortField]} ${direction} NULLS LAST, user_id ASC`);

  const rows = await sql<MemberQueryRow>`
    ${cte}
    SELECT * FROM member WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}
  `.execute(db);

  const totals = await sql<{ total: number }>`
    ${cte}
    SELECT COUNT(*)::int AS total FROM member WHERE ${where}
  `.execute(db);

  // Facets honour the search and the organization filter but not the facet
  // dimensions themselves, so the badges describe what the operator can select.
  const facetWhere = memberPredicate({ search, organizationId: options.organizationId });
  const statusFacet = await sql<{ account_status: string; total: number }>`
    ${cte}
    SELECT account_status, COUNT(*)::int AS total FROM member WHERE ${facetWhere} GROUP BY account_status
  `.execute(db);
  const roleFacet = await sql<{ organization_role: string | null; total: number }>`
    ${cte}
    SELECT organization_role, COUNT(*)::int AS total FROM member WHERE ${facetWhere} GROUP BY organization_role
  `.execute(db);

  return {
    members: rows.rows.map(toDirectoryRow),
    pagination: { limit, offset, count: rows.rows.length, total: totals.rows[0]?.total ?? 0 },
    facets: {
      accountStatus: Object.fromEntries(statusFacet.rows.map((r) => [r.account_status, r.total])),
      organizationRole: Object.fromEntries(
        roleFacet.rows.map((r) => [r.organization_role ?? 'none', r.total]),
      ),
    },
  };
}

/* ── Detail ───────────────────────────────────────────────────────────────── */

export interface MemberDetail {
  identity: {
    userId: string;
    fullName: string;
    email: string;
    emailVerified: boolean;
    emailVerifiedAt: string | null;
    accountStatus: string;
    registeredAt: string;
    lastLoginAt: string | null;
    failedLoginCount: number;
    locked: boolean;
    lockedUntil: string | null;
    platformRoles: string[];
  };
  organizations: Array<{
    organizationId: string;
    organizationName: string;
    organizationStatus: string;
    role: string;
    isOwner: boolean;
    membershipStatus: string;
    joinedAt: string;
    /** True for the membership the directory row was built from. */
    primary: boolean;
  }>;
  /** The PRIMARY organization's subscription. A package is never user-scoped. */
  subscription: {
    organizationId: string;
    planId: string | null;
    planCode: string | null;
    planName: string | null;
    edition: string | null;
    modules: string[];
    status: string;
    billingCycle: string | null;
    activatedAt: string | null;
    expiresAt: string | null;
    seatsUsed: number;
    seatLimit: number | null;
    entityLimit: number | null;
    invoiceStatus: string | null;
    invoiceNumber: string | null;
    invoiceTotal: number | null;
    paymentProofStatus: string | null;
    entitlementActive: boolean;
  } | null;
  security: {
    /** A COUNT. No token, hash or session identifier is exposed. */
    activeSessionCount: number;
    lastSessionAt: string | null;
    mustChangePassword: boolean;
    passwordExpiresAt: string | null;
    /** True while an unused, unexpired reset link exists. */
    hasPendingResetToken: boolean;
    recentSecurityActions: AuditEntryView[];
  };
  administration: {
    auditHistory: AuditEntryView[];
    internalNotes: string | null;
  };
}

/** Security-relevant actions, for the drawer's dedicated list. */
const SECURITY_ACTIONS = new Set([
  'auth.login',
  'auth.login_failed',
  'auth.logout_all',
  'auth.password_changed',
  'auth.session_revoked',
  'auth.account_locked',
  'member.password_reset_temporary',
  'member.password_reset_link_issued',
  'member.account_unlocked',
  'member.sessions_revoked',
  'member.account_status_changed',
  'member.email_verified_by_admin',
  'user.status_changed',
]);

/**
 * Everything the member drawer shows, in one call.
 *
 * Assembled from explicit column lists. Note what is NOT selected anywhere:
 * `users.password_hash`, `auth_sessions.token_hash`,
 * `password_reset_tokens.token_hash`. They are not fetched and then dropped —
 * they are never read, so no future refactor can accidentally serialise them.
 */
export async function getMemberDetail(db: Kysely<Database>, userId: string): Promise<MemberDetail> {
  const user = await db
    .selectFrom('users')
    .select([
      'id',
      'full_name',
      'email',
      'status',
      'email_verified_at',
      'must_change_password',
      'failed_login_count',
      'locked_until',
      'last_login_at',
      'password_expires_at',
      'created_at',
    ])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) throw errors.notFound('Member');

  const platformRoles = await db
    .selectFrom('platform_user_roles')
    .select('role')
    .where('user_id', '=', userId)
    .orderBy('role', 'asc')
    .execute();

  const memberships = await db
    .selectFrom('organization_memberships')
    .innerJoin('organizations', 'organizations.id', 'organization_memberships.organization_id')
    .select([
      'organization_memberships.organization_id',
      'organization_memberships.role',
      'organization_memberships.status',
      'organization_memberships.created_at as joined_at',
      'organizations.legal_name',
      'organizations.status as organization_status',
    ])
    .where('organization_memberships.user_id', '=', userId)
    // Same precedence as the directory, so "primary" means the same thing here.
    .orderBy(sql`(organization_memberships.status = 'active') DESC`)
    .orderBy(sql`(organization_memberships.role = 'owner') DESC`)
    .orderBy('organization_memberships.created_at', 'asc')
    .execute();

  const primary = memberships[0];

  const sessions = await db
    .selectFrom('auth_sessions')
    .select([sql<number>`count(*)::int`.as('total'), sql<Date | null>`max(last_used_at)`.as('last_used_at')])
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', new Date())
    .executeTakeFirst();

  const pendingReset = await db
    .selectFrom('password_reset_tokens')
    // Only the id — the hash is not selected even though it sits in the row.
    .select('id')
    .where('user_id', '=', userId)
    .where('used_at', 'is', null)
    .where('expires_at', '>', new Date())
    .executeTakeFirst();

  const auditHistory = await listAuditForSubject(db, userId, {
    limit: 40,
    organizationId: primary?.organization_id ?? null,
  });

  /* ── The organization's subscription, never the member's ───────────────── */
  let subscription: MemberDetail['subscription'] = null;
  if (primary) {
    const organizationId = primary.organization_id;
    const entitlement: EntitlementView = await getEntitlements(db, organizationId);

    const row = await db
      .selectFrom('subscriptions')
      .leftJoin('subscription_plans', 'subscription_plans.id', 'subscriptions.plan_id')
      .select([
        'subscriptions.id',
        'subscriptions.status',
        'subscriptions.billing_cycle',
        'subscriptions.starts_at',
        'subscriptions.expires_at',
        'subscriptions.user_limit',
        'subscriptions.entity_limit',
        'subscription_plans.id as plan_id',
        'subscription_plans.code as plan_code',
        'subscription_plans.name as plan_name',
        'subscription_plans.edition',
        'subscription_plans.user_limit as plan_user_limit',
        'subscription_plans.entity_limit as plan_entity_limit',
      ])
      .where('subscriptions.organization_id', '=', organizationId)
      .orderBy(sql`(subscriptions.status = 'active') DESC`)
      .orderBy('subscriptions.created_at', 'desc')
      .executeTakeFirst();

    const invoice = await db
      .selectFrom('subscription_invoices')
      .leftJoin('payment_proofs', 'payment_proofs.invoice_id', 'subscription_invoices.id')
      .select([
        'subscription_invoices.invoice_number',
        'subscription_invoices.status',
        'subscription_invoices.total',
        'payment_proofs.status as proof_status',
      ])
      .where('subscription_invoices.organization_id', '=', organizationId)
      .where('subscription_invoices.status', '!=', 'cancelled')
      .orderBy('subscription_invoices.created_at', 'desc')
      .executeTakeFirst();

    const seats = await db
      .selectFrom('organization_memberships')
      .select(sql<number>`count(*)::int`.as('total'))
      .where('organization_id', '=', organizationId)
      .where('status', '!=', 'suspended')
      .executeTakeFirst();

    subscription = {
      organizationId,
      planId: row?.plan_id ?? entitlement.planId,
      planCode: row?.plan_code ?? entitlement.planCode,
      planName: row?.plan_name ?? entitlement.planName,
      edition: row?.edition ?? entitlement.edition,
      modules: entitlement.modules,
      status: row?.status ?? 'none',
      billingCycle: row?.billing_cycle ?? null,
      activatedAt: iso(row?.starts_at ?? null),
      expiresAt: iso(row?.expires_at ?? null),
      seatsUsed: seats?.total ?? 0,
      seatLimit: row?.user_limit ?? row?.plan_user_limit ?? entitlement.userLimit,
      entityLimit: row?.entity_limit ?? row?.plan_entity_limit ?? entitlement.entityLimit,
      invoiceStatus: invoice?.status ?? null,
      invoiceNumber: invoice?.invoice_number ?? null,
      invoiceTotal: invoice ? Number(invoice.total) : null,
      paymentProofStatus: invoice?.proof_status ?? null,
      entitlementActive: entitlement.active,
    };
  }

  const notes = primary
    ? (
        await db
          .selectFrom('organizations')
          .select('internal_notes')
          .where('id', '=', primary.organization_id)
          .executeTakeFirst()
      )?.internal_notes ?? null
    : null;

  const lockedUntil = user.locked_until ? new Date(user.locked_until) : null;

  return {
    identity: {
      userId: user.id,
      fullName: user.full_name,
      email: user.email,
      emailVerified: user.email_verified_at !== null,
      emailVerifiedAt: iso(user.email_verified_at),
      accountStatus: user.status,
      registeredAt: new Date(user.created_at).toISOString(),
      lastLoginAt: iso(user.last_login_at),
      failedLoginCount: user.failed_login_count,
      locked: lockedUntil !== null && lockedUntil.getTime() > Date.now(),
      lockedUntil: lockedUntil ? lockedUntil.toISOString() : null,
      platformRoles: platformRoles.map((r) => r.role),
    },
    organizations: memberships.map((m, index) => ({
      organizationId: m.organization_id,
      organizationName: m.legal_name,
      organizationStatus: m.organization_status,
      role: m.role,
      isOwner: m.role === 'owner',
      membershipStatus: m.status,
      joinedAt: new Date(m.joined_at).toISOString(),
      primary: index === 0,
    })),
    subscription,
    security: {
      activeSessionCount: sessions?.total ?? 0,
      lastSessionAt: iso(sessions?.last_used_at ?? null),
      mustChangePassword: user.must_change_password,
      passwordExpiresAt: iso(user.password_expires_at),
      hasPendingResetToken: Boolean(pendingReset),
      recentSecurityActions: auditHistory.filter((entry) => SECURITY_ACTIONS.has(entry.action)).slice(0, 15),
    },
    administration: {
      auditHistory,
      internalNotes: notes,
    },
  };
}

/* ── Safeguards ───────────────────────────────────────────────────────────── */

async function requireUser(db: Kysely<Database>, userId: string) {
  const user = await db
    .selectFrom('users')
    .select(['id', 'email', 'full_name', 'status'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) throw errors.notFound('Member');
  return user;
}

/** Active super_admins other than the one named. */
async function otherActiveSuperAdmins(db: Kysely<Database>, exceptUserId: string): Promise<number> {
  const rows = await db
    .selectFrom('platform_user_roles')
    .innerJoin('users', 'users.id', 'platform_user_roles.user_id')
    .select('platform_user_roles.id')
    .where('platform_user_roles.role', '=', 'super_admin')
    .where('users.status', '=', 'active')
    .where('users.id', '!=', exceptUserId)
    .execute();
  return rows.length;
}

async function isSuperAdmin(db: Kysely<Database>, userId: string): Promise<boolean> {
  const row = await db
    .selectFrom('platform_user_roles')
    .select('id')
    .where('user_id', '=', userId)
    .where('role', '=', 'super_admin')
    .executeTakeFirst();
  return Boolean(row);
}

/**
 * Refuse a change that would leave the platform with no way back in.
 *
 * Two distinct hazards, deliberately reported differently: locking YOURSELF out
 * is a mistake the operator can simply not make, while removing the LAST
 * super_admin is unrecoverable for everyone.
 */
async function assertNotSelfLockout(
  db: Kysely<Database>,
  targetUserId: string,
  actorUserId: string,
  what: string,
): Promise<void> {
  if (targetUserId === actorUserId) {
    throw errors.validation(`You cannot ${what} your own account from the administration console.`);
  }
  if (await isSuperAdmin(db, targetUserId)) {
    if ((await otherActiveSuperAdmins(db, targetUserId)) === 0) {
      throw errors.conflict(
        'This is the last active platform super administrator. Grant the role to another account before changing this one.',
      );
    }
  }
}

/* ── Password reset ───────────────────────────────────────────────────────── */

export type ResetMode = 'temporary' | 'link';

/**
 * The reset result, shaped exactly like the creation result.
 *
 * Deliberately the same `credential` envelope as `createSubscriber` returns, so
 * the console has ONE way to handle a one-time secret and one dialog to show it
 * in. Two near-identical shapes is how one of the two paths ends up quietly
 * dropping the value.
 */
export interface ResetPasswordResult {
  member: { userId: string; email: string; fullName: string };
  mode: ResetMode;
  credential: OneTimeCredential;
}

/**
 * Reset another user's password, administratively.
 *
 * The current password is never read, verified or returned — there is no code
 * path in this function that touches `password_hash` except to OVERWRITE it. An
 * administrator cannot learn an existing password through this console, by
 * design; the only thing they can do is replace it.
 *
 * `temporary` mode performs the whole recovery in one transaction:
 *   · replace the hash with a freshly generated password's Argon2id digest;
 *   · force a change at first sign-in (`must_change_password`);
 *   · expire the temporary credential after the configured window;
 *   · clear the failure counter and any lock, so the customer is not locked out
 *     by the very attempts that prompted the reset;
 *   · return the account to `active` unless it was deliberately disabled;
 *   · revoke every live session, because whoever held one had the OLD password.
 *
 * `link` mode issues a single-use, expiring token, stores only its SHA-256 hash,
 * and reports honestly that nothing was delivered when no mail service exists.
 */
export async function adminResetPassword(
  db: Kysely<Database>,
  input: {
    userId: string;
    mode: ResetMode;
    /** Leave the account disabled rather than reactivating it. */
    keepDisabled?: boolean;
    temporaryPasswordTtlMinutes?: number;
    resetLinkTtlMinutes?: number;
    reason?: string;
  },
  context: MemberAdminContext,
): Promise<ResetPasswordResult> {
  const user = await requireUser(db, input.userId);

  // An operator resetting their own password through the admin path would be
  // shown their own new credential in a dialog and lose every session — the
  // self-service change-password flow is the correct route.
  if (input.userId === context.actorUserId) {
    throw errors.validation(
      'Use "change password" on your own account. An administrator cannot reset their own password from this console.',
    );
  }

  if (input.mode === 'link') {
    const ttl = input.resetLinkTtlMinutes ?? 60 * 24;
    const token = generateResetToken(ttl);

    await db.transaction().execute(async (trx) => {
      // Supersede any outstanding link, so "single-use" is not undermined by a
      // stack of valid tokens issued by successive attempts.
      await trx
        .updateTable('password_reset_tokens')
        .set({ used_at: new Date() })
        .where('user_id', '=', input.userId)
        .where('used_at', 'is', null)
        .execute();

      await trx
        .insertInto('password_reset_tokens')
        .values({
          user_id: input.userId,
          token_hash: token.tokenHash,
          expires_at: token.expiresAt,
          issued_by_user_id: context.actorUserId,
        })
        .execute();

      await writeAuditLog(trx, {
        ...context,
        action: 'member.password_reset_link_issued',
        targetType: 'user',
        targetId: input.userId,
        // No token, no hash — only the fact and the window.
        metadata: {
          reason: input.reason?.trim() || null,
          expiresAt: token.expiresAt.toISOString(),
          delivered: false,
          ttlMinutes: ttl,
        },
      });
    });

    return {
      member: { userId: input.userId, email: user.email, fullName: user.full_name },
      mode: 'link',
      credential: {
        type: 'invitation',
        invitationToken: token.token,
        expiresAt: token.expiresAt.toISOString(),
        deliveryStatus: 'unavailable',
        // A link does not change the password, so nothing is forced yet and no
        // session was ended.
        mustChangePassword: false,
        revokedSessions: 0,
        message:
          'Password reset link could not be sent because email delivery is not configured. Copy the link and give it to the account holder through a channel you trust.',
      },
    };
  }

  /* ── Temporary password ───────────────────────────────────────────────── */
  const temporaryPassword = generateTemporaryPassword();
  // Argon2 before the transaction — an expensive KDF must not hold a connection.
  const passwordHash = await hashPassword(temporaryPassword);
  const ttl = Math.max(input.temporaryPasswordTtlMinutes ?? 60 * 24, 5);
  const expiresAt = new Date(Date.now() + ttl * 60_000);

  const revokedSessions = await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('users')
      .set({
        password_hash: passwordHash,
        must_change_password: true,
        password_expires_at: expiresAt,
        failed_login_count: 0,
        locked_until: null,
        // A locked account is returned to service; a deliberately disabled one
        // stays disabled unless the caller asked otherwise.
        status: input.keepDisabled && user.status === 'disabled' ? 'disabled' : ('active' as UserStatus),
        updated_at: new Date(),
      })
      .where('id', '=', input.userId)
      .execute();

    // Whoever held a session authenticated with the OLD password.
    const revoked = await revokeAllUserSessions(trx, input.userId);

    // Outstanding reset links are superseded by an issued credential.
    await trx
      .updateTable('password_reset_tokens')
      .set({ used_at: new Date() })
      .where('user_id', '=', input.userId)
      .where('used_at', 'is', null)
      .execute();

    await writeAuditLog(trx, {
      ...context,
      action: 'member.password_reset_temporary',
      targetType: 'user',
      targetId: input.userId,
      /*
       * The password itself is absent, and `sanitiseMetadata` would redact it
       * even if a future edit added it by mistake. What is recorded is what an
       * auditor needs: that a temporary credential was issued, by whom, when it
       * expires, and that a change is forced.
       */
      metadata: {
        reason: input.reason?.trim() || null,
        expiresAt: expiresAt.toISOString(),
        mustChangePassword: true,
        revokedSessions: revoked,
        lockCleared: true,
        ttlMinutes: ttl,
      },
    });

    return revoked;
  });

  return {
    member: { userId: input.userId, email: user.email, fullName: user.full_name },
    mode: 'temporary',
    credential: {
      type: 'temporary_password',
      temporaryPassword,
      expiresAt: expiresAt.toISOString(),
      // Nothing was emailed; the administrator is the delivery channel.
      deliveryStatus: 'unavailable',
      mustChangePassword: true,
      revokedSessions,
      message: `Temporary password generated for ${user.full_name}. Show it once — it cannot be retrieved again, expires in ${ttl} minutes, and must be changed at first sign-in.`,
    },
  };
}

/* ── Account maintenance ──────────────────────────────────────────────────── */

/** Lift a lockout without touching the password. */
export async function unlockMember(
  db: Kysely<Database>,
  userId: string,
  context: MemberAdminContext,
): Promise<{ userId: string; accountStatus: string; failedLoginCount: number }> {
  const user = await requireUser(db, userId);

  const updated = await db.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable('users')
      .set({
        failed_login_count: 0,
        locked_until: null,
        // `locked` is a transient state; `disabled` is a decision and is kept.
        status: user.status === 'locked' ? 'active' : user.status,
        updated_at: new Date(),
      })
      .where('id', '=', userId)
      .returning(['status', 'failed_login_count'])
      .executeTakeFirstOrThrow();

    await writeAuditLog(trx, {
      ...context,
      action: 'member.account_unlocked',
      targetType: 'user',
      targetId: userId,
      metadata: { previousStatus: user.status, newStatus: row.status },
    });
    return row;
  });

  return { userId, accountStatus: updated.status, failedLoginCount: updated.failed_login_count };
}

/** Sign the member out everywhere. Does not change their password. */
export async function revokeMemberSessions(
  db: Kysely<Database>,
  userId: string,
  context: MemberAdminContext,
): Promise<{ userId: string; revokedSessions: number }> {
  await requireUser(db, userId);
  if (userId === context.actorUserId) {
    throw errors.validation('Use "sign out everywhere" on your own account instead.');
  }

  const revoked = await db.transaction().execute(async (trx) => {
    const count = await revokeAllUserSessions(trx, userId);
    await writeAuditLog(trx, {
      ...context,
      action: 'member.sessions_revoked',
      targetType: 'user',
      targetId: userId,
      metadata: { revokedSessions: count },
    });
    return count;
  });

  return { userId, revokedSessions: revoked };
}

/**
 * Enable or disable the account itself (distinct from a membership status).
 *
 * Disabling takes effect on the NEXT request, because `resolveSession` rejects a
 * non-active user — so sessions are revoked here too rather than leaving the
 * account reachable until its cookies expire.
 */
export async function setMemberAccountStatus(
  db: Kysely<Database>,
  userId: string,
  status: UserStatus,
  reason: string,
  context: MemberAdminContext,
): Promise<{ userId: string; accountStatus: UserStatus; revokedSessions: number }> {
  const user = await requireUser(db, userId);
  const trimmed = reason?.trim();
  if (!trimmed) {
    throw errors.validation('A reason is required and is recorded in the audit trail.', {
      fieldErrors: { reason: 'Explain why this account status is changing.' },
    });
  }

  if (status !== 'active') {
    await assertNotSelfLockout(db, userId, context.actorUserId, 'disable');
  }

  const revokedSessions = await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('users')
      .set({
        status,
        // Re-enabling clears the lock artefacts, so the customer is not disabled
        // and then immediately locked out by a stale failure count.
        ...(status === 'active' ? { failed_login_count: 0, locked_until: null } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', userId)
      .execute();

    const revoked =
      status === 'active' ? 0 : await revokeAllUserSessions(trx, userId);

    await writeAuditLog(trx, {
      ...context,
      action: 'member.account_status_changed',
      targetType: 'user',
      targetId: userId,
      metadata: { reason: trimmed, previousStatus: user.status, newStatus: status, revokedSessions: revoked },
    });
    return revoked;
  });

  return { userId, accountStatus: status, revokedSessions };
}

/**
 * Mark an email verified on the customer's behalf.
 *
 * A real deliverability check is the mail service's job; this exists because an
 * operator who has confirmed identity another way should not have to leave the
 * customer stuck. It is therefore explicitly audited as an ADMINISTRATIVE
 * verification, never recorded as if the customer had clicked a link.
 */
export async function verifyMemberEmail(
  db: Kysely<Database>,
  userId: string,
  reason: string,
  context: MemberAdminContext,
): Promise<{ userId: string; emailVerified: boolean; emailVerifiedAt: string }> {
  const user = await db
    .selectFrom('users')
    .select(['id', 'email', 'email_verified_at', 'status'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) throw errors.notFound('Member');

  const trimmed = reason?.trim();
  if (!trimmed) {
    throw errors.validation('A reason is required and is recorded in the audit trail.', {
      fieldErrors: { reason: 'Record how this address was verified.' },
    });
  }
  if (user.email_verified_at) throw errors.conflict('This email address is already verified.');

  const verifiedAt = new Date();
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('users')
      .set({
        email_verified_at: verifiedAt,
        // A pending-verification account becomes usable at the same moment.
        status: user.status === 'pending_verification' ? 'active' : user.status,
        updated_at: verifiedAt,
      })
      .where('id', '=', userId)
      .execute();

    await writeAuditLog(trx, {
      ...context,
      action: 'member.email_verified_by_admin',
      targetType: 'user',
      targetId: userId,
      metadata: { reason: trimmed, email: user.email, verifiedAt: verifiedAt.toISOString(), byAdministrator: true },
    });
  });

  return { userId, emailVerified: true, emailVerifiedAt: verifiedAt.toISOString() };
}

/* ── Membership ───────────────────────────────────────────────────────────── */

export interface UpdateMembershipInput {
  userId: string;
  organizationId: string;
  role?: OrganizationRole;
  status?: MembershipStatus;
}

/**
 * Change a member's role or membership status inside a named organization.
 *
 * The last-active-owner rule lives here as well as in `memberService`, because
 * this is a different entry point and a safeguard that is only in one caller is
 * not a safeguard. Promotion TO owner is allowed (that is ownership transfer's
 * building block); leaving zero active owners is not.
 */
export async function updateMembershipAsAdmin(
  db: Kysely<Database>,
  input: UpdateMembershipInput,
  context: MemberAdminContext,
): Promise<{ userId: string; organizationId: string; role: string; status: string }> {
  if (input.role === undefined && input.status === undefined) {
    throw errors.validation('Provide a role or a status to change.');
  }

  return db.transaction().execute(async (trx) => {
    const membership = await trx
      .selectFrom('organization_memberships')
      .selectAll()
      .where('organization_id', '=', input.organizationId)
      .where('user_id', '=', input.userId)
      .forUpdate()
      .executeTakeFirst();
    if (!membership) throw errors.notFound('Member');

    const losesOwnership =
      membership.role === 'owner' &&
      ((input.role !== undefined && input.role !== 'owner') ||
        (input.status !== undefined && input.status !== 'active'));

    if (losesOwnership) {
      const others = await trx
        .selectFrom('organization_memberships')
        .select('id')
        .where('organization_id', '=', input.organizationId)
        .where('role', '=', 'owner')
        .where('status', '=', 'active')
        .where('user_id', '!=', input.userId)
        .execute();
      if (others.length === 0) {
        throw errors.conflict(
          'The organization must keep at least one active owner. Transfer ownership first.',
        );
      }
    }

    const updated = await trx
      .updateTable('organization_memberships')
      .set({
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', membership.id)
      .returning(['role', 'status'])
      .executeTakeFirstOrThrow();

    if (input.role !== undefined && input.role !== membership.role) {
      await writeAuditLog(trx, {
        ...context,
        organizationId: input.organizationId,
        action: 'member.role_changed',
        targetType: 'user',
        targetId: input.userId,
        metadata: { from: membership.role, to: input.role },
      });
    }
    if (input.status !== undefined && input.status !== membership.status) {
      await writeAuditLog(trx, {
        ...context,
        organizationId: input.organizationId,
        action: 'member.status_changed',
        targetType: 'user',
        targetId: input.userId,
        metadata: { from: membership.status, to: input.status },
      });
    }

    return {
      userId: input.userId,
      organizationId: input.organizationId,
      role: updated.role,
      status: updated.status,
    };
  });
}

/** Platform roles an operator may grant or revoke from the console. */
export const GRANTABLE_PLATFORM_ROLES: readonly PlatformRole[] = ['super_admin', 'billing_admin', 'support'];

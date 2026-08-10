/**
 * Effective permissions: resolution, and the writes that change them.
 *
 * ── The precedence rule, stated once ─────────────────────────────────────────
 * Every permission question in Ledgora is answered by `resolvePermissions`, in
 * this order, and the FIRST rule that applies decides:
 *
 *   1. Platform layer
 *        a. the account itself must be active                        → else deny
 *        b. a platform super administrator is allowed everything     → allow
 *        c. the membership must exist and be active                  → else deny
 *   2. Subscription entitlement
 *        the organization's subscription must be live, and must include the
 *        subject's module                                            → else deny
 *   3. An explicit user DENIAL                                       → deny
 *   4. An explicit user GRANT                                        → allow
 *   5. The role template                                             → allow
 *   6. Default                                                       → deny
 *
 * Two properties fall out of that ordering and both are deliberate.
 *
 * The entitlement gate sits ABOVE every user-scoped rule, so no grant — not an
 * override, not a role, not an Organization Admin's decision — can open a module
 * the tenant has not bought. "The backend must reject attempts to bypass
 * subscription restrictions" is not a check bolted onto the write path; it is
 * where the gate sits in the resolution order, which means it also holds for
 * grants that were legitimate when they were made and stopped being so later.
 *
 * A denial outranks a grant, so revoking one specific right from someone whose
 * role otherwise carries it is expressible without inventing a new role.
 *
 * ── Why a downgrade destroys nothing ─────────────────────────────────────────
 * When a subscription loses a module, NOTHING here deletes an override. Rule 2
 * simply starts refusing, and the resolved permission reports
 * `blockedByEntitlement: true` so the editor can show the configuration as
 * intact-but-inactive rather than as absent. Re-buy the module and rule 2 stops
 * refusing — the original configuration is live again because it was never
 * touched. A cleanup job here would silently make downgrades irreversible.
 *
 * ── Why there is no cache ────────────────────────────────────────────────────
 * Resolution reads the database on every call. That is a deliberate cost: it
 * means a permission change takes effect on the target's very next request, with
 * no invalidation step that could be forgotten and no window in which a
 * withdrawn right still works. Sessions are additionally revoked when a change
 * REMOVES access — see `applyPermissionChanges`.
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database, PermissionEffect } from '../db/schema.js';
import {
  PERMISSION_SUBJECTS,
  findSubject,
  isKnownPermission,
  permissionKey,
  roleTemplate,
  type PermissionSubject,
} from '../config/permissionCatalog.js';
import { getEntitlements } from './entitlementService.js';
import { writeAuditLog, type AuditContext } from '../lib/audit.js';
import { errors } from '../lib/errors.js';
import { revokeAllUserSessions } from './sessionService.js';

export type Executor = Kysely<Database> | Transaction<Database>;

/* ── Resolution ───────────────────────────────────────────────────────────── */

/**
 * Why a permission resolved the way it did.
 *
 * Returned for every cell so the editor can explain itself rather than showing a
 * bare tick — "inherited from Accountant" and "granted specifically to this
 * person" look identical otherwise, and an administrator reviewing access needs
 * to tell them apart.
 */
export type PermissionSource =
  /** Held because the caller is a Ledgora platform super administrator. */
  | 'platform_super_admin'
  /** The user account is disabled, locked or awaiting verification. */
  | 'account_inactive'
  /** The user is not a member of this organization. */
  | 'no_membership'
  /** The membership exists but is invited or suspended. */
  | 'membership_inactive'
  /** The organization has no live subscription. */
  | 'subscription_inactive'
  /** The organization's package does not include this module. */
  | 'not_entitled'
  | 'user_deny'
  | 'user_grant'
  | 'role'
  | 'default_deny';

export interface ResolvedPermission {
  subject: string;
  action: string;
  allowed: boolean;
  source: PermissionSource;
  /** The role template grants this. Shown as "inherited". */
  inRoleTemplate: boolean;
  /** An explicit decision exists for this cell, whether or not it is in force. */
  override: PermissionEffect | null;
  /**
   * Configured to be allowed — by role or by grant — but refused by rule 2.
   *
   * This is the flag that makes a downgrade visibly reversible: the editor shows
   * the cell as unavailable-because-of-the-package, not as unset, and the stored
   * configuration behind it is untouched.
   */
  blockedByEntitlement: boolean;
}

export interface EffectivePermissions {
  userId: string;
  organizationId: string;
  /** Null when the user is not a member (a platform operator, typically). */
  role: string | null;
  membershipStatus: string | null;
  accountStatus: string;
  platformRoles: string[];
  isPlatformSuperAdmin: boolean;
  subscription: {
    active: boolean;
    status: string;
    planCode: string | null;
    planName: string | null;
    edition: string | null;
    modules: string[];
  };
  permissions: ResolvedPermission[];
  /** Just the allowed keys, for a fast `has` check. */
  allowedKeys: string[];
}

interface ResolutionInputs {
  accountStatus: string;
  platformRoles: string[];
  role: string | null;
  membershipStatus: string | null;
  entitlementActive: boolean;
  modules: ReadonlySet<string>;
  overrides: Map<string, PermissionEffect>;
}

/**
 * The rule, applied to one cell.
 *
 * Extracted so the ordering is testable in isolation and stated in exactly one
 * place. Every caller — the guard, the editor's preview, the API — goes through
 * here, so there is no second implementation to drift.
 */
function resolveOne(subject: PermissionSubject, action: string, input: ResolutionInputs): ResolvedPermission {
  const key = permissionKey(subject.id, action);
  const inRoleTemplate = input.role !== null && roleTemplate(input.role).has(key);
  const override = input.overrides.get(key) ?? null;

  /** What the configuration says, ignoring the package. Drives `blockedByEntitlement`. */
  const configuredAllow = override === 'deny' ? false : override === 'grant' ? true : inRoleTemplate;

  const refuse = (source: PermissionSource, blocked = false): ResolvedPermission => ({
    subject: subject.id,
    action,
    allowed: false,
    source,
    inRoleTemplate,
    override,
    blockedByEntitlement: blocked,
  });

  /* ── 1. Platform layer ──────────────────────────────────────────────────── */

  // 1a. A restriction, and it applies to everyone including operators.
  if (input.accountStatus !== 'active') return refuse('account_inactive');

  // 1b. Elevation. A super administrator supports every tenant, which is the
  //     same authority `lib/platformEntitlementOverride` already models for the
  //     product surface — stated here too so the two cannot disagree.
  if (input.platformRoles.includes('super_admin')) {
    return {
      subject: subject.id,
      action,
      allowed: true,
      source: 'platform_super_admin',
      inRoleTemplate,
      override,
      blockedByEntitlement: false,
    };
  }

  // 1c. Everyone else needs a live membership in THIS organization. This is the
  //     tenant boundary: no membership, no permissions, whatever is configured.
  if (input.role === null) return refuse('no_membership');
  if (input.membershipStatus !== 'active') return refuse('membership_inactive');

  /* ── 2. Subscription entitlement — above every user-scoped rule ─────────── */

  if (!input.entitlementActive) return refuse('subscription_inactive', configuredAllow);
  if (subject.requiredModule !== null && !input.modules.has(subject.requiredModule)) {
    return refuse('not_entitled', configuredAllow);
  }

  /* ── 3–6. User denial, user grant, role, default ────────────────────────── */

  if (override === 'deny') return refuse('user_deny');
  if (override === 'grant') {
    return {
      subject: subject.id,
      action,
      allowed: true,
      source: 'user_grant',
      inRoleTemplate,
      override,
      blockedByEntitlement: false,
    };
  }
  if (inRoleTemplate) {
    return {
      subject: subject.id,
      action,
      allowed: true,
      source: 'role',
      inRoleTemplate,
      override,
      blockedByEntitlement: false,
    };
  }
  return refuse('default_deny');
}

/** Pure resolution over the whole catalogue. Exported for unit tests. */
export function resolveAll(input: ResolutionInputs): ResolvedPermission[] {
  const out: ResolvedPermission[] = [];
  for (const subject of PERMISSION_SUBJECTS) {
    for (const action of subject.actions) out.push(resolveOne(subject, action, input));
  }
  return out;
}

async function loadInputs(
  db: Executor,
  userId: string,
  organizationId: string,
): Promise<{ inputs: ResolutionInputs; subscription: EffectivePermissions['subscription'] }> {
  const user = await db
    .selectFrom('users')
    .select(['id', 'status'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) throw errors.notFound('User');

  const platformRoles = (
    await db.selectFrom('platform_user_roles').select('role').where('user_id', '=', userId).execute()
  ).map((row) => row.role as string);

  const membership = await db
    .selectFrom('organization_memberships')
    .select(['role', 'status'])
    .where('organization_id', '=', organizationId)
    .where('user_id', '=', userId)
    .executeTakeFirst();

  const entitlement = await getEntitlements(db, organizationId);

  const overrideRows = await db
    .selectFrom('user_permission_overrides')
    .select(['subject', 'action', 'effect'])
    .where('user_id', '=', userId)
    .where('organization_id', '=', organizationId)
    .execute();

  const overrides = new Map<string, PermissionEffect>();
  for (const row of overrideRows) {
    // A row naming a subject or action the catalogue no longer has is ignored
    // rather than trusted: the catalogue is the authority on what exists.
    if (isKnownPermission(row.subject, row.action)) {
      overrides.set(permissionKey(row.subject, row.action), row.effect);
    }
  }

  return {
    inputs: {
      accountStatus: user.status,
      platformRoles,
      role: membership?.role ?? null,
      membershipStatus: membership?.status ?? null,
      entitlementActive: entitlement.active,
      modules: new Set(entitlement.modules),
      overrides,
    },
    subscription: {
      active: entitlement.active,
      status: entitlement.status,
      planCode: entitlement.planCode,
      planName: entitlement.planName,
      edition: entitlement.edition,
      modules: entitlement.modules,
    },
  };
}

/** Everything about one person's access to one organization. */
export async function resolvePermissions(
  db: Executor,
  userId: string,
  organizationId: string,
): Promise<EffectivePermissions> {
  const { inputs, subscription } = await loadInputs(db, userId, organizationId);
  const permissions = resolveAll(inputs);

  return {
    userId,
    organizationId,
    role: inputs.role,
    membershipStatus: inputs.membershipStatus,
    accountStatus: inputs.accountStatus,
    platformRoles: inputs.platformRoles,
    isPlatformSuperAdmin: inputs.platformRoles.includes('super_admin'),
    subscription,
    permissions,
    allowedKeys: permissions.filter((p) => p.allowed).map((p) => permissionKey(p.subject, p.action)),
  };
}

/**
 * The single-question form, for guards.
 *
 * Deliberately resolves the whole catalogue rather than querying one cell: the
 * expensive part is the four round trips that build the inputs, and answering
 * one question with the same data that answers all of them keeps ONE code path
 * for the rule. A guard asking a different question than the editor previews is
 * the bug this avoids.
 */
export async function can(
  db: Executor,
  userId: string,
  organizationId: string,
  subject: string,
  action: string,
): Promise<boolean> {
  if (!isKnownPermission(subject, action)) return false;
  const { inputs } = await loadInputs(db, userId, organizationId);
  const definition = findSubject(subject);
  if (!definition) return false;
  return resolveOne(definition, action, inputs).allowed;
}

/* ── Writes ───────────────────────────────────────────────────────────────── */

export interface PermissionChange {
  subject: string;
  action: string;
  /** `inherit` removes the override and returns the cell to its role default. */
  effect: PermissionEffect | 'inherit';
}

export interface PermissionActorContext extends AuditContext {
  actorUserId: string;
  /**
   * What the ACTOR may do in this organization, or `null` for a platform super
   * administrator (who is not constrained by it).
   *
   * This is the "cannot grant what you do not hold" rule, and it is passed IN
   * rather than looked up here on purpose: the caller has already resolved the
   * actor to authorize the request at all, and re-resolving would invite the two
   * answers to differ.
   */
  actorAllowedKeys: ReadonlySet<string> | null;
}

export interface PermissionChangeResult {
  userId: string;
  organizationId: string;
  applied: number;
  granted: string[];
  denied: string[];
  reverted: string[];
  /** Sessions ended because the change removed access. */
  revokedSessions: number;
  effective: EffectivePermissions;
}

/**
 * Apply a set of permission changes.
 *
 * Three guarantees, all enforced here rather than in the routes so a second
 * caller added later inherits them:
 *
 *  · every (subject, action) is checked against the catalogue, so an invented
 *    pair cannot be stored — this is the anti-mass-assignment boundary;
 *  · an actor may not grant a permission they do not themselves hold, and the
 *    REJECTION is audited, because a privilege-escalation attempt is exactly the
 *    kind of event an auditor needs to see;
 *  · every applied change is audited individually with its previous and new
 *    value, inside the same transaction as the change.
 */
export async function applyPermissionChanges(
  db: Kysely<Database>,
  input: {
    userId: string;
    organizationId: string;
    changes: PermissionChange[];
    reason?: string;
  },
  context: PermissionActorContext,
): Promise<PermissionChangeResult> {
  if (input.changes.length === 0) throw errors.validation('No permission changes were supplied.');

  /* ── Validate against the catalogue ─────────────────────────────────────── */
  for (const change of input.changes) {
    if (!isKnownPermission(change.subject, change.action)) {
      throw errors.validation(
        `"${change.subject}.${change.action}" is not a permission this system defines.`,
        { fieldErrors: { permissions: 'One or more permissions were not recognised.' } },
      );
    }
  }

  // Deduplicate, last write wins, so a payload naming the same cell twice cannot
  // produce two rows or two contradictory audit entries.
  const deduped = new Map<string, PermissionChange>();
  for (const change of input.changes) deduped.set(permissionKey(change.subject, change.action), change);

  /* ── The target must be a member of the organization ────────────────────── */
  const membership = await db
    .selectFrom('organization_memberships')
    .select(['role', 'status'])
    .where('organization_id', '=', input.organizationId)
    .where('user_id', '=', input.userId)
    .executeTakeFirst();
  if (!membership) {
    throw errors.validation(
      'This user is not a member of that organization. Assign them to it before configuring permissions.',
    );
  }

  /* ── "You cannot grant what you do not hold" ────────────────────────────── */
  if (context.actorAllowedKeys !== null) {
    const overreach = [...deduped.values()]
      .filter((change) => change.effect === 'grant')
      .map((change) => permissionKey(change.subject, change.action))
      .filter((key) => !context.actorAllowedKeys!.has(key));

    if (overreach.length > 0) {
      // Record the attempt before refusing it. A rejected escalation that leaves
      // no trace is indistinguishable from one that never happened.
      await writeAuditLog(db, {
        ...context,
        organizationId: input.organizationId,
        action: 'permission.escalation_rejected',
        targetType: 'user',
        targetId: input.userId,
        metadata: { attempted: overreach.sort(), reason: 'actor does not hold these permissions' },
      });
      throw errors.forbidden(
        'You cannot grant a permission you do not hold yourself. The attempt has been recorded.',
      );
    }
  }

  const before = await resolvePermissions(db, input.userId, input.organizationId);
  const allowedBefore = new Set(before.allowedKeys);

  const granted: string[] = [];
  const denied: string[] = [];
  const reverted: string[] = [];
  const trimmedReason = input.reason?.trim() || null;

  await db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('user_permission_overrides')
      .select(['subject', 'action', 'effect'])
      .where('user_id', '=', input.userId)
      .where('organization_id', '=', input.organizationId)
      .execute();
    const previous = new Map(
      existing.map((row) => [permissionKey(row.subject, row.action), row.effect as PermissionEffect]),
    );

    for (const [key, change] of deduped) {
      const previousEffect = previous.get(key) ?? null;
      const nextEffect = change.effect === 'inherit' ? null : change.effect;
      // A no-op is skipped entirely — it should not produce an audit entry
      // claiming something changed.
      if (previousEffect === nextEffect) continue;

      if (nextEffect === null) {
        await trx
          .deleteFrom('user_permission_overrides')
          .where('user_id', '=', input.userId)
          .where('organization_id', '=', input.organizationId)
          .where('subject', '=', change.subject)
          .where('action', '=', change.action)
          .execute();
        reverted.push(key);
      } else {
        await trx
          .insertInto('user_permission_overrides')
          .values({
            user_id: input.userId,
            organization_id: input.organizationId,
            subject: change.subject,
            action: change.action,
            effect: nextEffect,
            reason: trimmedReason,
            granted_by_user_id: context.actorUserId,
          })
          // The unique key makes a repeat edit an update rather than a duplicate,
          // so two operators editing the same matrix converge instead of racing.
          .onConflict((oc) =>
            oc.columns(['user_id', 'organization_id', 'subject', 'action']).doUpdateSet({
              effect: nextEffect,
              reason: trimmedReason,
              granted_by_user_id: context.actorUserId,
              updated_at: new Date(),
            }),
          )
          .execute();
        (nextEffect === 'grant' ? granted : denied).push(key);
      }

      await writeAuditLog(trx, {
        ...context,
        organizationId: input.organizationId,
        action:
          nextEffect === 'grant'
            ? 'permission.granted'
            : nextEffect === 'deny'
              ? 'permission.denied'
              : 'permission.reset',
        targetType: 'user',
        targetId: input.userId,
        metadata: {
          subject: change.subject,
          permissionAction: change.action,
          previousValue: previousEffect ?? 'inherit',
          newValue: nextEffect ?? 'inherit',
          role: membership.role,
          reason: trimmedReason,
        },
      });
    }
  });

  const effective = await resolvePermissions(db, input.userId, input.organizationId);

  /*
   * Sessions are ended only when the change REMOVED something.
   *
   * Resolution is uncached, so any change is already in force on the target's
   * next request — signing them out is not needed for correctness. It is done
   * for withdrawals specifically, so a screen already open on a surface the
   * person may no longer use is not left sitting there.
   */
  const lost = [...allowedBefore].filter((key) => !effective.allowedKeys.includes(key));
  let revokedSessions = 0;
  if (lost.length > 0) {
    revokedSessions = await revokeAllUserSessions(db, input.userId);
    if (revokedSessions > 0) {
      await writeAuditLog(db, {
        ...context,
        organizationId: input.organizationId,
        action: 'member.sessions_revoked',
        targetType: 'user',
        targetId: input.userId,
        metadata: { reason: 'permissions reduced', removedPermissions: lost.sort(), revokedSessions },
      });
    }
  }

  return {
    userId: input.userId,
    organizationId: input.organizationId,
    applied: granted.length + denied.length + reverted.length,
    granted,
    denied,
    reverted,
    revokedSessions,
    effective,
  };
}

/**
 * Drop every override, returning the user to their role's defaults.
 *
 * The editor's "Reset to role defaults". Audited as one event with the count and
 * the keys, rather than as N individual resets — it is one decision.
 */
export async function resetPermissionsToRole(
  db: Kysely<Database>,
  input: { userId: string; organizationId: string; reason?: string },
  context: PermissionActorContext,
): Promise<PermissionChangeResult> {
  const before = await resolvePermissions(db, input.userId, input.organizationId);
  const allowedBefore = new Set(before.allowedKeys);

  const cleared = await db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom('user_permission_overrides')
      .select(['subject', 'action', 'effect'])
      .where('user_id', '=', input.userId)
      .where('organization_id', '=', input.organizationId)
      .execute();

    if (rows.length > 0) {
      await trx
        .deleteFrom('user_permission_overrides')
        .where('user_id', '=', input.userId)
        .where('organization_id', '=', input.organizationId)
        .execute();
    }

    await writeAuditLog(trx, {
      ...context,
      organizationId: input.organizationId,
      action: 'permission.reset_all',
      targetType: 'user',
      targetId: input.userId,
      metadata: {
        clearedCount: rows.length,
        cleared: rows.map((r) => `${r.subject}:${r.action}=${r.effect}`).sort(),
        reason: input.reason?.trim() || null,
      },
    });

    return rows.map((r) => permissionKey(r.subject, r.action));
  });

  const effective = await resolvePermissions(db, input.userId, input.organizationId);

  const lost = [...allowedBefore].filter((key) => !effective.allowedKeys.includes(key));
  let revokedSessions = 0;
  if (lost.length > 0) revokedSessions = await revokeAllUserSessions(db, input.userId);

  return {
    userId: input.userId,
    organizationId: input.organizationId,
    applied: cleared.length,
    granted: [],
    denied: [],
    reverted: cleared,
    revokedSessions,
    effective,
  };
}

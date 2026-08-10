/**
 * Administrative user creation, organization assignment and platform-role grants.
 *
 * ── What this module is, next to the two that already exist ──────────────────
 * `memberService`    — a subscriber managing their own colleagues, always inside
 *                      one already-authorized organization.
 * `memberAdminService` — an operator maintaining an EXISTING account: status,
 *                      lockout, sessions, credentials, membership role.
 * this module        — bringing an account INTO existence, deciding which tenant
 *                      it belongs to, and granting platform authority.
 *
 * The split matters because these are the acts with no undo. Creating a user and
 * moving one between tenants change who exists and whose books they can see;
 * they are gated by their own capabilities (`users.create`,
 * `users.assign_organization`) precisely so a broad "manage members" grant does
 * not silently include them.
 *
 * ── The safeguards, and why each is here rather than in a route ──────────────
 *  · only a super administrator may create or promote another one — checked
 *    against the ACTOR'S verified session roles, never against anything in the
 *    request;
 *  · the platform must always retain one active super administrator;
 *  · an administrator cannot deactivate, delete or demote their own account;
 *  · an organization must always retain one active owner.
 *
 * All four live in the service. A safeguard that is only in the one route that
 * happens to call it today is not a safeguard — it is a comment with a runtime.
 *
 * ── Nothing here ever handles a plaintext password ───────────────────────────
 * A created account gets either a random unusable hash plus an invitation link,
 * or a generated temporary password that is hashed immediately and returned in
 * exactly one response. There is no code path that stores, logs or re-reads a
 * plaintext password, and no endpoint that can return an existing one.
 */
import type { Kysely } from 'kysely';
import type {
  Database,
  MembershipStatus,
  OrganizationRole,
  PlatformRole,
  UserStatus,
} from '../db/schema.js';
import { writeAuditLog, type AuditContext } from '../lib/audit.js';
import { errors } from '../lib/errors.js';
import { hashPassword } from '../lib/password.js';
import { generateResetToken, generateTemporaryPassword } from '../lib/credentials.js';
import { generateSessionToken } from '../lib/tokens.js';
import { insertUser, normaliseEmail } from './userService.js';
import { revokeAllUserSessions } from './sessionService.js';
import { isCatalogRole } from '../config/permissionCatalog.js';
import { applyPermissionChanges, type PermissionChange } from './permissionService.js';
import type { OneTimeCredential } from './subscriberService.js';

export interface UserAdminContext extends AuditContext {
  actorUserId: string;
  actorPlatformRole: string;
  /** The actor's verified platform roles, from the session. Never from a body. */
  actorPlatformRoles: string[];
}

/* ── Shared safeguards ────────────────────────────────────────────────────── */

export async function isSuperAdmin(db: Kysely<Database>, userId: string): Promise<boolean> {
  const row = await db
    .selectFrom('platform_user_roles')
    .select('id')
    .where('user_id', '=', userId)
    .where('role', '=', 'super_admin')
    .executeTakeFirst();
  return Boolean(row);
}

/** Active super administrators other than the one named. */
export async function otherActiveSuperAdmins(db: Kysely<Database>, exceptUserId: string): Promise<number> {
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

/**
 * "Only a Super Admin may create or promote another Super Admin."
 *
 * The rejected attempt is audited before the refusal, so an operator probing for
 * an escalation path leaves a record whether or not they find one.
 */
async function assertMayGrantSuperAdmin(
  db: Kysely<Database>,
  context: UserAdminContext,
  targetUserId: string | null,
): Promise<void> {
  if (context.actorPlatformRoles.includes('super_admin')) return;

  await writeAuditLog(db, {
    ...context,
    action: 'platform_role.escalation_rejected',
    targetType: 'user',
    targetId: targetUserId,
    metadata: {
      attemptedRole: 'super_admin',
      actorRoles: context.actorPlatformRoles,
      reason: 'only a super administrator may grant platform super administrator',
    },
  });
  throw errors.forbidden(
    'Only a platform super administrator may grant super administrator authority. The attempt has been recorded.',
  );
}

/**
 * Refuse a change that would leave the platform unadministrable, or lock the
 * acting operator out of their own console.
 */
export async function assertLastSuperAdminProtected(
  db: Kysely<Database>,
  targetUserId: string,
  actorUserId: string,
  what: string,
): Promise<void> {
  if (targetUserId === actorUserId) {
    throw errors.validation(`You cannot ${what} your own account.`);
  }
  if (await isSuperAdmin(db, targetUserId)) {
    if ((await otherActiveSuperAdmins(db, targetUserId)) === 0) {
      throw errors.conflict(
        'This is the last active platform super administrator. Grant the role to another account before changing this one.',
      );
    }
  }
}

/* ── Creation ─────────────────────────────────────────────────────────────── */

/** How the new account gets its first password. */
export type OnboardingMethod = 'invitation' | 'temporary_password';

export interface CreateUserInput {
  fullName: string;
  email: string;
  /** Optional tenant. A platform operator is created with none. */
  organizationId?: string | null;
  role?: OrganizationRole;
  membershipStatus?: MembershipStatus;
  accountStatus?: UserStatus;
  /** Platform authority. Granting `super_admin` requires the actor to hold it. */
  platformRoles?: PlatformRole[];
  onboarding: OnboardingMethod;
  /** Overrides applied at creation, on top of the role template. */
  permissions?: PermissionChange[];
  temporaryPasswordTtlMinutes?: number;
  invitationTtlMinutes?: number;
  notes?: string;
}

export interface CreatedUser {
  user: {
    userId: string;
    email: string;
    fullName: string;
    accountStatus: UserStatus;
    organizationId: string | null;
    role: OrganizationRole | null;
    membershipStatus: MembershipStatus | null;
    platformRoles: PlatformRole[];
  };
  credential: OneTimeCredential;
}

/**
 * Create a user account, optionally placing it in an organization.
 *
 * The whole thing is one transaction: an account that exists without the
 * membership, the invitation token or the audit entry that were supposed to
 * accompany it is a worse outcome than a failed creation.
 */
export async function createUserAsAdmin(
  db: Kysely<Database>,
  input: CreateUserInput,
  context: UserAdminContext,
): Promise<CreatedUser> {
  const email = normaliseEmail(input.email);
  const fullName = input.fullName.trim();
  if (!fullName) {
    throw errors.validation('A full name is required.', { fieldErrors: { fullName: 'Enter the person’s name.' } });
  }

  const platformRoles = input.platformRoles ?? [];
  if (platformRoles.includes('super_admin')) {
    await assertMayGrantSuperAdmin(db, context, null);
  }

  /* ── The tenant, and the role inside it ─────────────────────────────────── */
  let organization: { id: string; legal_name: string } | undefined;
  if (input.organizationId) {
    organization = await db
      .selectFrom('organizations')
      .select(['id', 'legal_name'])
      .where('id', '=', input.organizationId)
      .executeTakeFirst();
    if (!organization) throw errors.notFound('Organization');
  }

  const role = input.role ?? 'member';
  if (organization && !isCatalogRole(role)) {
    throw errors.validation('Choose a role for the new user.', { fieldErrors: { role: 'Unknown role.' } });
  }
  if (!organization && input.role) {
    throw errors.validation('A role can only be set when the user is assigned to an organization.', {
      fieldErrors: { organizationId: 'Choose an organization, or clear the role.' },
    });
  }
  /*
   * `owner` is not offered at creation. Ownership is a position that is
   * TRANSFERRED — the last-active-owner rule exists to protect it — and minting
   * a second owner as a side effect of adding a user would route around that.
   */
  if (role === 'owner') {
    throw errors.validation('Ownership is transferred, not assigned at creation.', {
      fieldErrors: { role: 'Create the user as an Organization Admin and transfer ownership separately.' },
    });
  }

  /* ── The credential ─────────────────────────────────────────────────────── */
  const usingTemporary = input.onboarding === 'temporary_password';
  const temporaryPassword = usingTemporary ? generateTemporaryPassword() : null;
  const invitationTtl = Math.max(input.invitationTtlMinutes ?? 60 * 24 * 7, 5);
  const invitation = generateResetToken(invitationTtl);

  /*
   * Argon2 before the transaction — an expensive KDF must not hold a connection.
   *
   * When an invitation is used, the stored hash is of a value nobody has ever
   * seen: a fresh 256-bit token, hashed and discarded. That is what makes the
   * account genuinely unusable until the invitation is redeemed, rather than
   * merely flagged as such.
   */
  const passwordHash = await hashPassword(temporaryPassword ?? generateSessionToken());
  const temporaryTtl = Math.max(input.temporaryPasswordTtlMinutes ?? 60 * 24, 5);
  const passwordExpiresAt = usingTemporary ? new Date(Date.now() + temporaryTtl * 60_000) : null;

  const created = await db.transaction().execute(async (trx) => {
    const user = await insertUser(trx, {
      email: input.email.trim(),
      fullName,
      passwordHash,
      // An invited account is `pending_verification` until the link is redeemed —
      // it must not be able to authenticate before its holder proves reachability.
      status: input.accountStatus ?? (usingTemporary ? 'active' : 'pending_verification'),
      mustChangePassword: usingTemporary,
      emailVerified: false,
    });

    if (passwordExpiresAt) {
      await trx
        .updateTable('users')
        .set({ password_expires_at: passwordExpiresAt })
        .where('id', '=', user.id)
        .execute();
    }

    if (organization) {
      await trx
        .insertInto('organization_memberships')
        .values({
          organization_id: organization.id,
          user_id: user.id,
          role,
          status: input.membershipStatus ?? (usingTemporary ? 'active' : 'invited'),
        })
        .execute();
    }

    for (const platformRole of platformRoles) {
      await trx
        .insertInto('platform_user_roles')
        .values({ user_id: user.id, role: platformRole, created_by: context.actorUserId })
        .execute();
      await writeAuditLog(trx, {
        ...context,
        action: 'platform_role.assigned',
        targetType: 'user',
        targetId: user.id,
        metadata: { role: platformRole, atCreation: true },
      });
    }

    // Minted for BOTH methods, so an administrator whose temporary password went
    // astray can fall back to the link without a second round trip.
    await trx
      .insertInto('password_reset_tokens')
      .values({
        user_id: user.id,
        token_hash: invitation.tokenHash,
        expires_at: invitation.expiresAt,
        issued_by_user_id: context.actorUserId,
        purpose: 'invitation',
      })
      .execute();

    await writeAuditLog(trx, {
      ...context,
      organizationId: organization?.id ?? null,
      action: 'user.created_by_admin',
      targetType: 'user',
      targetId: user.id,
      // No credential, no token, no hash. What an auditor needs is the decision.
      metadata: {
        email,
        fullName,
        organizationId: organization?.id ?? null,
        organizationName: organization?.legal_name ?? null,
        role: organization ? role : null,
        platformRoles,
        onboardingMethod: input.onboarding,
        accountStatus: input.accountStatus ?? (usingTemporary ? 'active' : 'pending_verification'),
        hasNotes: Boolean(input.notes?.trim()),
      },
    });

    await writeAuditLog(trx, {
      ...context,
      organizationId: organization?.id ?? null,
      action: 'invitation.created',
      targetType: 'user',
      targetId: user.id,
      metadata: {
        purpose: 'invitation',
        expiresAt: invitation.expiresAt.toISOString(),
        ttlMinutes: invitationTtl,
        delivered: false,
      },
    });

    if (organization) {
      await writeAuditLog(trx, {
        ...context,
        organizationId: organization.id,
        action: 'user.organization_assigned',
        targetType: 'user',
        targetId: user.id,
        metadata: { organizationId: organization.id, role, previousOrganizationId: null },
      });
    }

    return user;
  });

  /*
   * Overrides are applied AFTER the account exists, through the normal write
   * path — so they pass the same catalogue validation, the same "cannot grant
   * what you do not hold" check and produce the same per-cell audit entries as
   * any later edit. A creation-time shortcut here would be a second, unaudited
   * way to configure permissions.
   */
  if (organization && input.permissions && input.permissions.length > 0) {
    await applyPermissionChanges(
      db,
      {
        userId: created.id,
        organizationId: organization.id,
        changes: input.permissions,
        reason: 'Set at account creation.',
      },
      {
        ...context,
        actorAllowedKeys: null,
      },
    );
  }

  return {
    user: {
      userId: created.id,
      email: created.email,
      fullName: created.full_name,
      accountStatus: created.status,
      organizationId: organization?.id ?? null,
      role: organization ? role : null,
      membershipStatus: organization ? (input.membershipStatus ?? (usingTemporary ? 'active' : 'invited')) : null,
      platformRoles,
    },
    credential: usingTemporary
      ? {
          type: 'temporary_password',
          temporaryPassword: temporaryPassword!,
          expiresAt: passwordExpiresAt!.toISOString(),
          deliveryStatus: 'unavailable',
          mustChangePassword: true,
          message: `Temporary password generated for ${fullName}. Show it once — it cannot be retrieved again, expires in ${temporaryTtl} minutes, and must be changed at first sign-in.`,
        }
      : {
          type: 'invitation',
          invitationToken: invitation.token,
          expiresAt: invitation.expiresAt.toISOString(),
          deliveryStatus: 'unavailable',
          // The invitee chooses their own password, so there is no interim
          // credential for them to be forced to replace.
          mustChangePassword: false,
          message:
            'Invitation link could not be sent because email delivery is not configured. Copy the link and pass it to the recipient through a channel you trust. It can be shown only once.',
        },
  };
}

/* ── Organization assignment ──────────────────────────────────────────────── */

export interface AssignOrganizationInput {
  userId: string;
  organizationId: string;
  role: OrganizationRole;
  membershipStatus?: MembershipStatus;
  /** Leave the previous membership in place instead of moving the user. */
  keepExisting?: boolean;
  reason: string;
}

/**
 * Place a user in an organization, or move them to a different one.
 *
 * ── Why a move DELETES the old membership and its overrides ──────────────────
 * "Changing an organization must not expose data from the previous
 * organization." Overrides are keyed by (user, organization), so leaving them
 * behind would not grant anything in the new tenant — but it WOULD leave a live
 * membership of the old one, and a live membership is access. So the move
 * removes the previous membership and, with it, the permission configuration
 * that only made sense inside that tenant. Both are recorded in the audit entry
 * before they go, so the change is reconstructable.
 *
 * The user's authored records, audit entries and document attributions are not
 * touched by any of this — they reference the user id, which does not change.
 */
export async function assignOrganization(
  db: Kysely<Database>,
  input: AssignOrganizationInput,
  context: UserAdminContext,
): Promise<{
  userId: string;
  organizationId: string;
  role: OrganizationRole;
  membershipStatus: MembershipStatus;
  previousOrganizationId: string | null;
  revokedSessions: number;
}> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw errors.validation('A reason is required and is recorded in the audit trail.', {
      fieldErrors: { reason: 'Explain why this user is being reassigned.' },
    });
  }
  if (!isCatalogRole(input.role)) {
    throw errors.validation('Unknown role.', { fieldErrors: { role: 'Choose a valid role.' } });
  }
  if (input.role === 'owner') {
    throw errors.validation('Ownership is transferred through the ownership transfer action.', {
      fieldErrors: { role: 'Choose a role other than Owner.' },
    });
  }

  const user = await db
    .selectFrom('users')
    .select(['id', 'email', 'full_name'])
    .where('id', '=', input.userId)
    .executeTakeFirst();
  if (!user) throw errors.notFound('User');

  const organization = await db
    .selectFrom('organizations')
    .select(['id', 'legal_name'])
    .where('id', '=', input.organizationId)
    .executeTakeFirst();
  if (!organization) throw errors.notFound('Organization');

  const existing = await db
    .selectFrom('organization_memberships')
    .select(['id', 'organization_id', 'role', 'status'])
    .where('user_id', '=', input.userId)
    .execute();

  const alreadyHere = existing.find((m) => m.organization_id === input.organizationId);
  const elsewhere = existing.filter((m) => m.organization_id !== input.organizationId);

  /*
   * Moving the last active owner out of a tenant would leave it unmanageable by
   * its own customer. The same rule `memberService` enforces, enforced here too
   * because this is a different entry point.
   */
  for (const membership of elsewhere) {
    if (input.keepExisting) break;
    if (membership.role === 'owner' && membership.status === 'active') {
      const others = await db
        .selectFrom('organization_memberships')
        .select('id')
        .where('organization_id', '=', membership.organization_id)
        .where('role', '=', 'owner')
        .where('status', '=', 'active')
        .where('user_id', '!=', input.userId)
        .execute();
      if (others.length === 0) {
        throw errors.conflict(
          'This user is the last active owner of their current organization. Transfer that ownership before moving them.',
        );
      }
    }
  }

  const status: MembershipStatus = input.membershipStatus ?? 'active';
  const previousOrganizationId = elsewhere[0]?.organization_id ?? null;

  await db.transaction().execute(async (trx) => {
    if (!input.keepExisting) {
      for (const membership of elsewhere) {
        /*
         * The overrides go with the membership. They are decisions about what
         * this person may do in THAT tenant; keeping them after the membership
         * has gone would leave configuration behind that nothing can reach and
         * that would silently reactivate if they were ever re-added.
         */
        const dropped = await trx
          .selectFrom('user_permission_overrides')
          .select(['subject', 'action', 'effect'])
          .where('user_id', '=', input.userId)
          .where('organization_id', '=', membership.organization_id)
          .execute();

        await trx
          .deleteFrom('user_permission_overrides')
          .where('user_id', '=', input.userId)
          .where('organization_id', '=', membership.organization_id)
          .execute();

        await trx.deleteFrom('organization_memberships').where('id', '=', membership.id).execute();

        await writeAuditLog(trx, {
          ...context,
          organizationId: membership.organization_id,
          action: 'user.organization_transferred',
          targetType: 'user',
          targetId: input.userId,
          metadata: {
            reason,
            fromOrganizationId: membership.organization_id,
            toOrganizationId: input.organizationId,
            previousRole: membership.role,
            previousMembershipStatus: membership.status,
            clearedOverrides: dropped.map((d) => `${d.subject}:${d.action}=${d.effect}`).sort(),
          },
        });
      }
    }

    if (alreadyHere) {
      await trx
        .updateTable('organization_memberships')
        .set({ role: input.role, status, updated_at: new Date() })
        .where('id', '=', alreadyHere.id)
        .execute();
    } else {
      await trx
        .insertInto('organization_memberships')
        .values({
          organization_id: input.organizationId,
          user_id: input.userId,
          role: input.role,
          status,
        })
        .execute();
    }

    await writeAuditLog(trx, {
      ...context,
      organizationId: input.organizationId,
      action: 'user.organization_assigned',
      targetType: 'user',
      targetId: input.userId,
      metadata: {
        reason,
        organizationId: input.organizationId,
        organizationName: organization.legal_name,
        role: input.role,
        membershipStatus: status,
        previousOrganizationId,
        previousRole: alreadyHere?.role ?? null,
      },
    });
  });

  /*
   * Sign the user out. Their tenant context has changed, and a session opened
   * against the previous organization must not be the thing that decides what
   * they see next — this is the concrete meaning of "changing an organization
   * must not expose data from the previous organization".
   */
  const revokedSessions = await revokeAllUserSessions(db, input.userId);

  return {
    userId: input.userId,
    organizationId: input.organizationId,
    role: input.role,
    membershipStatus: status,
    previousOrganizationId,
    revokedSessions,
  };
}

/* ── Platform role grants ─────────────────────────────────────────────────── */

/**
 * Grant or revoke platform authority.
 *
 * Both directions are guarded: granting `super_admin` requires holding it, and
 * revoking it may not remove the last active one or the actor's own.
 */
export async function setPlatformRole(
  db: Kysely<Database>,
  input: { userId: string; role: PlatformRole; granted: boolean; reason: string },
  context: UserAdminContext,
): Promise<{ userId: string; role: PlatformRole; granted: boolean; revokedSessions: number }> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw errors.validation('A reason is required and is recorded in the audit trail.', {
      fieldErrors: { reason: 'Explain why this platform role is changing.' },
    });
  }

  const user = await db
    .selectFrom('users')
    .select(['id', 'status'])
    .where('id', '=', input.userId)
    .executeTakeFirst();
  if (!user) throw errors.notFound('User');

  if (input.role === 'super_admin') {
    await assertMayGrantSuperAdmin(db, context, input.userId);
    if (!input.granted) {
      // Demotion is the dangerous direction: it can lock the platform out.
      await assertLastSuperAdminProtected(db, input.userId, context.actorUserId, 'demote');
    }
  }

  const existing = await db
    .selectFrom('platform_user_roles')
    .select('id')
    .where('user_id', '=', input.userId)
    .where('role', '=', input.role)
    .executeTakeFirst();

  if (input.granted === Boolean(existing)) {
    return { userId: input.userId, role: input.role, granted: input.granted, revokedSessions: 0 };
  }

  await db.transaction().execute(async (trx) => {
    if (input.granted) {
      await trx
        .insertInto('platform_user_roles')
        .values({ user_id: input.userId, role: input.role, created_by: context.actorUserId })
        .execute();
    } else {
      await trx
        .deleteFrom('platform_user_roles')
        .where('user_id', '=', input.userId)
        .where('role', '=', input.role)
        .execute();
    }

    await writeAuditLog(trx, {
      ...context,
      action: input.granted ? 'platform_role.assigned' : 'platform_role.revoked',
      targetType: 'user',
      targetId: input.userId,
      metadata: { role: input.role, reason, previousValue: Boolean(existing), newValue: input.granted },
    });
  });

  // Platform authority is resolved into the session principal, so a change must
  // not wait for the old session to expire.
  const revokedSessions = await revokeAllUserSessions(db, input.userId);

  return { userId: input.userId, role: input.role, granted: input.granted, revokedSessions };
}

/**
 * Organization members.
 *
 * Every function here is scoped by an `organizationId` that its CALLER has
 * already authorized — either by verifying the caller's own active membership
 * (subscriber path) or by verifying a platform capability and the organization's
 * existence (operator path). Nothing in this module derives the organization from
 * a request body, and nothing widens a caller's rights.
 *
 * ── The rule that shapes the operator path ───────────────────────────────────
 * A platform administrator managing a subscriber's members must NEVER become a
 * member of that subscriber. No function below inserts, updates or reads a
 * membership row for the acting administrator: `actorUserId` is used for the
 * audit trail and for nothing else. That is what keeps an operator tenantless
 * while still able to do support work — and it is why the Members page must take
 * its organization from the VIEWED subscriber rather than from the
 * administrator's own (correctly empty) membership.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database, MembershipStatus, OrganizationRole } from '../db/schema.js';
import { writeAuditLog, type AuditContext } from '../lib/audit.js';
import { errors } from '../lib/errors.js';
import { findUserByEmail, insertUser, normaliseEmail } from './userService.js';
import { checkPasswordPolicy, hashPassword } from '../lib/password.js';
import { generateSessionToken } from '../lib/tokens.js';
import { generateResetToken } from '../lib/credentials.js';

export type Executor = Kysely<Database> | Transaction<Database>;

export interface MemberView {
  userId: string;
  membershipId: string;
  email: string;
  fullName: string;
  role: OrganizationRole;
  status: MembershipStatus;
  accountStatus: string;
  emailVerified: boolean;
  lastLoginAt: string | null;
  joinedAt: string;
}

/**
 * Roles a new member may be given.
 *
 * `owner` is excluded because ownership is TRANSFERRED — the last-active-owner
 * rule exists to protect that position, and minting a second owner through an
 * invitation would route around it. `admin` is excluded for a related reason: an
 * Organization Admin creating more Organization Admins is lateral privilege
 * propagation, so that promotion goes through the operator console or the owner.
 */
export const ASSIGNABLE_ROLES: readonly OrganizationRole[] = ['manager', 'accountant', 'member', 'viewer'];

const iso = (value: Date | null): string | null => (value ? new Date(value).toISOString() : null);

/** The organization must exist before anyone manages its members. */
export async function requireOrganization(
  db: Executor,
  organizationId: string,
): Promise<{ id: string; legalName: string; status: string }> {
  const row = await db
    .selectFrom('organizations')
    .select(['id', 'legal_name', 'status'])
    .where('id', '=', organizationId)
    .executeTakeFirst();
  if (!row) throw errors.notFound('Organization');
  return { id: row.id, legalName: row.legal_name, status: row.status };
}

export async function listMembers(db: Executor, organizationId: string): Promise<MemberView[]> {
  const rows = await db
    .selectFrom('organization_memberships')
    .innerJoin('users', 'users.id', 'organization_memberships.user_id')
    .select([
      'organization_memberships.id as membership_id',
      'organization_memberships.role',
      'organization_memberships.status',
      'organization_memberships.created_at as joined_at',
      'users.id as user_id',
      'users.email',
      'users.full_name',
      'users.status as account_status',
      'users.email_verified_at',
      'users.last_login_at',
    ])
    .where('organization_memberships.organization_id', '=', organizationId)
    .orderBy('organization_memberships.created_at', 'asc')
    .execute();

  return rows.map((row) => ({
    userId: row.user_id,
    membershipId: row.membership_id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    status: row.status,
    accountStatus: row.account_status,
    emailVerified: row.email_verified_at !== null,
    lastLoginAt: iso(row.last_login_at),
    joinedAt: new Date(row.joined_at).toISOString(),
  }));
}

/** Seats consumed: everyone but a suspended member occupies one. */
export async function countSeats(db: Executor, organizationId: string): Promise<number> {
  const rows = await db
    .selectFrom('organization_memberships')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('status', '!=', 'suspended')
    .execute();
  return rows.length;
}

/**
 * The organization's purchased seat allowance.
 *
 * The per-tenant override on the SUBSCRIPTION wins, falling back to the plan's
 * own limit — the same precedence `entitlementService.recalculateEntitlements`
 * applies. This used to read only the plan, so a negotiated `seatAllowance` was
 * silently ignored and a tenant sold 3 seats was enforced at their plan's 100.
 *
 * `leftJoin`, not `innerJoin`: a subscription with no plan still carries its own
 * override, and an inner join dropped that row entirely — reporting "no limit".
 */
export async function seatLimit(db: Executor, organizationId: string): Promise<number | null> {
  const row = await db
    .selectFrom('subscriptions')
    .leftJoin('subscription_plans', 'subscription_plans.id', 'subscriptions.plan_id')
    .select(['subscriptions.user_limit as override', 'subscription_plans.user_limit as plan_limit'])
    .where('subscriptions.organization_id', '=', organizationId)
    // An ACTIVE subscription is the one that entitles; otherwise the newest.
    .orderBy(sql`(subscriptions.status = 'active') DESC`)
    .orderBy('subscriptions.created_at', 'desc')
    .executeTakeFirst();
  if (!row) return null;
  return row.override ?? row.plan_limit ?? null;
}

async function membershipOf(
  db: Executor,
  organizationId: string,
  userId: string,
): Promise<{ id: string; role: OrganizationRole; status: MembershipStatus } | null> {
  const row = await db
    .selectFrom('organization_memberships')
    .select(['id', 'role', 'status'])
    .where('organization_id', '=', organizationId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row ? { id: row.id, role: row.role, status: row.status } : null;
}

/* ── Onboarding activation ────────────────────────────────────────────────── */

/**
 * How the holder established their own password. Both are administrator-initiated
 * onboarding acts, and both reach the SAME milestone.
 */
export type ActivationTrigger = 'invitation_redeemed' | 'temporary_password_replaced';

/**
 * THE activation rule: an `invited` membership becomes `active` at the moment its
 * holder first establishes a password of their own.
 *
 * ── Why this is one function and not two flows ───────────────────────────────
 * Ledgora offers two ways to onboard someone an administrator has invited —
 * redeem a single-use link, or replace a forced temporary password. They are two
 * routes to one milestone, not two lifecycles, so the transition lives here and
 * both callers use it. Writing the transition twice is how the two paths come to
 * disagree about who ends up with access.
 *
 * ── What it deliberately does NOT do ─────────────────────────────────────────
 * Only `invited` is touched. A `suspended` membership stays suspended: suspension
 * is an administrator's decision, and a password change must never overturn it.
 * A REMOVED member has no membership row at all, so there is nothing to match —
 * which is why possessing valid credentials cannot, on its own, restore access to
 * an organization somebody was taken out of.
 *
 * ── Idempotent, and transactional by construction ────────────────────────────
 * The `status = 'invited'` predicate is the idempotency: a second password change
 * matches no rows, returns 0, and writes no audit entry claiming something
 * happened. The caller passes its own transaction handle, so the activation and
 * the password change that caused it commit together or not at all.
 */
export async function activateInvitedMemberships(
  db: Executor,
  userId: string,
  context: AuditContext & { trigger: ActivationTrigger },
): Promise<number> {
  const pending = await db
    .selectFrom('organization_memberships')
    .select(['id', 'organization_id', 'role'])
    .where('user_id', '=', userId)
    .where('status', '=', 'invited')
    .execute();

  // No pending invitation is the normal case for an ordinary password change.
  // Returning early keeps the trail free of entries for non-events.
  if (pending.length === 0) return 0;

  await db
    .updateTable('organization_memberships')
    .set({ status: 'active', updated_at: new Date() })
    .where('user_id', '=', userId)
    .where('status', '=', 'invited')
    .execute();

  for (const membership of pending) {
    await writeAuditLog(db as Kysely<Database>, {
      ...context,
      organizationId: membership.organization_id,
      // The member acted on their own account; there is no operator here, and
      // attributing it to one would misstate who did it.
      actorUserId: userId,
      actorPlatformRole: null,
      action: 'membership.activated',
      targetType: 'user',
      targetId: userId,
      metadata: {
        trigger: context.trigger,
        role: membership.role,
        previousStatus: 'invited',
        newStatus: 'active',
      },
    });
  }

  return pending.length;
}

export interface InviteMemberInput {
  organizationId: string;
  email: string;
  fullName: string;
  role: OrganizationRole;
  /**
   * How the new member gets their first credential.
   *
   * `invitation` (the default, and the recommended path) sends a single-use link
   * and nobody — including the administrator — ever learns the password.
   * `temporary_password` is for when initial credentials must be handed over
   * directly; the value is hashed immediately and must be replaced at first
   * sign-in.
   */
  onboarding?: 'invitation' | 'temporary_password';
  /** Required for `temporary_password`. Hashed here; never stored in the clear. */
  temporaryPassword?: string;
}

export interface ActorContext extends AuditContext {
  /** The authenticated caller. Recorded for audit; never given membership. */
  actorUserId: string;
  /** The caller's platform role when acting as an operator, else null. */
  actorPlatformRole?: string | null;
}

/**
 * Lifecycle states in which a subscriber may take on new people.
 *
 * An archived or pending-deletion tenant is out of circulation and every member
 * has been signed out; inviting somebody into it would create an access grant
 * that immediately does nothing, and would consume a seat on a closed account.
 * `suspended` is deliberately included: a suspended subscriber is a live
 * customer with a billing problem, not a closed one.
 */
const INVITABLE_ORGANIZATION_STATUSES = new Set(['active', 'suspended']);

/**
 * Thrown when the seat check inside the invitation transaction refuses.
 *
 * A marker, not a user-facing error: the transaction rolls back, the caller
 * catches this OUTSIDE it, writes the audit entry where it will actually commit,
 * and only then surfaces the conflict.
 */
class SeatLimitReached extends Error {
  constructor(
    readonly seatLimit: number,
    readonly seatsUsed: number,
  ) {
    super('Seat limit reached');
    this.name = 'SeatLimitReached';
  }
}

/**
 * Whether the invitation actually reached its recipient.
 *
 * `unavailable` is not a failure — it is "no mail service is configured in this
 * deployment, so nothing was attempted". Distinguishing it from `failed` matters:
 * one means an administrator must hand the link over themselves, the other means
 * delivery was tried and broke. Neither may ever be rendered as "email sent".
 */
export type InvitationDelivery = 'sent' | 'unavailable' | 'failed';

export interface InvitedMember {
  member: MemberView;
  /** Which credential path was used. */
  onboarding: 'invitation' | 'temporary_password';
  /**
   * True when the member must replace their credential at first sign-in.
   *
   * The temporary-password path always sets it. Enforcement is server-side and
   * total: `guards/passwordChange` refuses every route but session-read,
   * change-password and logout while it stands.
   */
  mustChangePassword: boolean;
  /**
   * The single-use invitation token.
   *
   * ── Why this is optional ────────────────────────────────────────────────
   * The SERVICE always produces one; the ROUTE decides whether it may leave the
   * process. In production it never does — a raw invitation link is a bearer
   * credential for somebody else's account, and returning it in an API response
   * puts it in the browser, the proxy log and whatever the client does next.
   * See `EXPOSE_INVITATION_TOKENS` in `config/env`.
   *
   * Only its SHA-256 digest reaches the database, so a token that is not
   * delivered cannot be recovered — the invitation must be resent.
   */
  invitationToken?: string;
  expiresAt: string;
  delivery: InvitationDelivery;
  /** True when an existing Ledgora identity joined, rather than a new account. */
  reusedExistingIdentity: boolean;
}

/**
 * Invite a member into ONE organization.
 *
 * ── Why the whole thing sits in one transaction with a row lock ──────────────
 * The seat check used to be a read followed, later, by an insert. Two
 * administrators inviting at the same moment both read "4 of 5 used" and both
 * inserted, leaving the tenant at 6 of 5. Taking `FOR UPDATE` on the
 * organization row serialises invitations for that tenant, so the count a caller
 * sees is still true when it writes. That is what makes the limit an enforced
 * rule rather than a hopeful one.
 *
 * ── Why an existing identity is reused ───────────────────────────────────────
 * A person is one Ledgora identity with many memberships. Inviting an address
 * that already has an account attaches a NEW membership to the existing user —
 * never a second account for the same person, and never a change to their
 * password, which they already have and which this organization has no business
 * touching.
 *
 * ── What the invitee gets ────────────────────────────────────────────────────
 * A membership in `invited` status and a single-use, expiring token. Redeeming
 * it activates the membership through `activateInvitedMemberships`, the one
 * activation rule both credential paths share.
 */
export async function inviteMember(
  db: Kysely<Database>,
  input: InviteMemberInput & { invitationTtlMinutes?: number },
  context: ActorContext,
): Promise<InvitedMember> {
  if (!ASSIGNABLE_ROLES.includes(input.role)) {
    throw errors.validation('Choose a role for the new member.', {
      fieldErrors: { role: 'A new member cannot be made an owner.' },
    });
  }

  const email = normaliseEmail(input.email);
  const fullName = input.fullName?.trim();
  if (!fullName) {
    throw errors.validation('A full name is required.', {
      fieldErrors: { fullName: 'Enter the name of the person being invited.' },
    });
  }

  const onboarding = input.onboarding ?? 'invitation';
  const usingTemporaryPassword = onboarding === 'temporary_password';

  /*
   * The CANONICAL password policy, checked here rather than in the browser: a
   * client-side rule is a suggestion, and this value becomes a real credential
   * the moment it is hashed.
   */
  if (usingTemporaryPassword) {
    const policy = checkPasswordPolicy(input.temporaryPassword ?? '', {
      email: normaliseEmail(input.email),
      fullName: input.fullName?.trim(),
    });
    if (!policy.ok) {
      throw errors.validation(policy.problems[0] ?? 'That password does not meet the policy.', {
        fieldErrors: { temporaryPassword: policy.problems.join(' ') },
      });
    }
  }

  /*
   * Argon2 before the transaction — an expensive KDF must never hold a
   * connection open.
   *
   * For the INVITATION path the hash is of a value nobody has ever seen, so the
   * account is genuinely unusable until the link is redeemed. For the TEMPORARY
   * path it is the administrator's chosen password, hashed once; the plaintext
   * lives only in this function's arguments and is written nowhere.
   */
  const newAccountHash = await hashPassword(
    usingTemporaryPassword ? input.temporaryPassword! : generateSessionToken(),
  );
  const ttl = Math.max(input.invitationTtlMinutes ?? 60 * 24 * 7, 5);
  const invitation = generateResetToken(ttl);

  const result = await db
    .transaction()
    .execute(async (trx) => {
      /* ── The lock that makes the seat limit real ─────────────────────────── */
      const organization = await trx
        .selectFrom('organizations')
        .select(['id', 'legal_name', 'status', 'deletion_in_progress'])
        .where('id', '=', input.organizationId)
        .forUpdate()
        .executeTakeFirst();
      if (!organization) throw errors.notFound('Organization');

      /*
       * The write freeze. Checked under the SAME row lock the cleanup
       * transaction takes, so this either runs before the freeze is set or sees
       * it — there is no interleaving that creates a membership belonging to an
       * organization midway through being destroyed.
       */
      if (organization.deletion_in_progress) {
        throw errors.conflict('This subscriber is being permanently deleted and cannot take on new members.');
      }

      if (!INVITABLE_ORGANIZATION_STATUSES.has(organization.status)) {
        throw errors.conflict(
          `This subscriber is ${organization.status} and cannot take on new members. Restore it first.`,
        );
      }

      /* ── Seats, counted under the lock ───────────────────────────────────── */
      const limit = await seatLimit(trx, input.organizationId);
      if (limit !== null) {
        const used = await countSeats(trx, input.organizationId);
        if (used >= limit) {
          /*
           * Carried OUT of the transaction rather than audited here.
           *
           * The refusal and the rollback are the same event, so an audit row
           * written on `trx` is undone by the very throw that records it — the
           * trail would show nothing for a refusal that definitely happened. The
           * caller writes it on the pooled connection instead. Same reasoning as
           * `DeletionBlocked` in `services/deletionService`.
           */
          throw new SeatLimitReached(limit, used);
        }
      }

      /* ── One identity, many memberships ──────────────────────────────────── */
      const existing = await findUserByEmail(trx, email);
      let userId: string;
      let reusedExistingIdentity = false;

      if (existing) {
        reusedExistingIdentity = true;
        userId = existing.id;

        /*
         * ── The rule that makes multi-organization identities safe ────────
         *
         * Credentials belong to the GLOBAL identity, not to whichever
         * subscriber happens to be adding that email today. Accepting an
         * administrator-set password here would let any subscriber overwrite
         * the password of somebody who already works for a different customer —
         * an account takeover dressed up as onboarding.
         *
         * So a temporary password is refused outright for an existing identity,
         * and the administrator is directed to the invitation path, which adds
         * a membership and touches nothing else about that person.
         */
        if (usingTemporaryPassword) {
          throw errors.conflict(
            'This email already has a Ledgora account. Send an invitation instead — they will join using their existing password. A temporary password can only be set for a brand-new account.',
          );
        }

        // Already here? That is a duplicate, not a second membership.
        const alreadyMember = await trx
          .selectFrom('organization_memberships')
          .select(['id', 'status'])
          .where('organization_id', '=', input.organizationId)
          .where('user_id', '=', userId)
          .executeTakeFirst();
        if (alreadyMember) {
          throw errors.conflict(
            alreadyMember.status === 'invited'
              ? 'This person already has a pending invitation to this organization. Resend it instead.'
              : 'This person is already a member of this organization.',
          );
        }
      } else {
        const created = await insertUser(trx, {
          email: input.email.trim(),
          fullName,
          passwordHash: newAccountHash,
          /*
           * The forced-change flag. Enforced server-side by
           * `guards/passwordChange`, which permits exactly three things until it
           * is cleared: read the session, change the password, sign out.
           */
          mustChangePassword: usingTemporaryPassword,
          /*
           * `active`, deliberately.
           *
           * What actually stops an invited account authenticating is its password:
           * the hash above is of a fresh 256-bit token nobody has ever seen, so
           * there is no credential to present. The account STATUS is a separate
           * axis — it is what an administrator sets to disable somebody — and
           * marking a normal new invitee `pending_verification` would conflate the
           * two while adding no protection. The membership is what gates access,
           * and it stays `invited` until the link is redeemed.
           */
          status: 'active',
          emailVerified: false,
        });
        userId = created.id;
      }

      await trx
        .insertInto('organization_memberships')
        .values({
          organization_id: input.organizationId,
          user_id: userId,
          role: input.role,
          /*
           * A temporary-password member is ACTIVE immediately: they sign in with
           * the credential they were handed, and the forced-change gate — not a
           * pending membership — is what constrains them until they replace it.
           * An invited member stays `invited` until they redeem their link.
           */
          status: usingTemporaryPassword ? 'active' : 'invited',
        })
        .execute();

      /*
       * The single-use link, hash only — minted for the INVITATION path only.
       * A temporary-password account already has a working credential, and a
       * second way in would widen the attack surface for no benefit.
       */
      if (!usingTemporaryPassword) {
        await trx
          .insertInto('password_reset_tokens')
          .values({
            user_id: userId,
            token_hash: invitation.tokenHash,
            expires_at: invitation.expiresAt,
            issued_by_user_id: context.actorUserId,
            purpose: 'invitation',
          })
          .execute();
      }

      await writeAuditLog(trx, {
        ...context,
        organizationId: input.organizationId,
        action: 'member.invited',
        targetType: 'user',
        targetId: userId,
        // No token, no hash. The decision and its scope.
        // No password, no token, no hash. `sanitiseMetadata` would redact any
        // of them anyway; none is put here in the first place.
        metadata: {
          email,
          role: input.role,
          reusedExistingIdentity,
          onboarding,
          /*
           * Named to avoid every word in `sanitiseMetadata`'s deny-list
           * (password, token, secret, hash, credential…). That redactor is
           * correctly aggressive and should stay so; the fix is to record the
           * FACT under a name that is unambiguously not a secret, rather than
           * to loosen the filter.
           */
          firstLoginChangeRequired: usingTemporaryPassword,
          membershipStatus: usingTemporaryPassword ? 'active' : 'invited',
          ...(usingTemporaryPassword
            ? {}
            : { expiresAt: invitation.expiresAt.toISOString() }),
          organizationName: organization.legal_name,
        },
      });

      return { userId, reusedExistingIdentity };
    })
    .catch(async (cause: unknown) => {
      if (!(cause instanceof SeatLimitReached)) throw cause;
      // The transaction has rolled back; this write survives.
      await writeAuditLog(db, {
        ...context,
        organizationId: input.organizationId,
        action: 'member.seat_limit_reached',
        targetType: 'organization',
        targetId: input.organizationId,
        metadata: {
          seatLimit: cause.seatLimit,
          seatsUsed: cause.seatsUsed,
          attemptedEmail: email,
          role: input.role,
        },
      });
      throw errors.conflict(
        `This plan allows ${cause.seatLimit} users and ${cause.seatsUsed} are in use. Free a seat or upgrade the package to add another.`,
      );
    });

  const member = (await listMembers(db, input.organizationId)).find((m) => m.userId === result.userId);
  if (!member) throw errors.notFound('Member');

  return {
    member,
    onboarding,
    mustChangePassword: usingTemporaryPassword,
    /*
     * No token for the temporary path — none was minted. And the temporary
     * PASSWORD is deliberately absent: the administrator typed it, so returning
     * it would only put a live credential somewhere else.
     */
    ...(usingTemporaryPassword ? {} : { invitationToken: invitation.token }),
    expiresAt: invitation.expiresAt.toISOString(),
    // Overwritten by the route once delivery has actually been attempted.
    delivery: 'unavailable',
    reusedExistingIdentity: result.reusedExistingIdentity,
  };
}

/**
 * Resend a pending invitation.
 *
 * Supersedes every outstanding link for that person before minting a new one, so
 * "single use" is not undermined by a stack of valid tokens accumulated through
 * repeated clicks. Consumes no additional seat — the membership already exists.
 */
export async function resendInvitation(
  db: Kysely<Database>,
  input: { organizationId: string; userId: string; invitationTtlMinutes?: number },
  context: ActorContext,
): Promise<{ invitationToken: string; expiresAt: string }> {
  const ttl = Math.max(input.invitationTtlMinutes ?? 60 * 24 * 7, 5);
  const invitation = generateResetToken(ttl);

  await db.transaction().execute(async (trx) => {
    const membership = await trx
      .selectFrom('organization_memberships')
      .select(['id', 'status'])
      .where('organization_id', '=', input.organizationId)
      .where('user_id', '=', input.userId)
      .executeTakeFirst();
    /*
     * 404, not 403. A user outside this tenant must be indistinguishable from
     * one that does not exist — answering "forbidden" would confirm the id
     * belongs to somebody.
     */
    if (!membership) throw errors.notFound('Member');
    if (membership.status !== 'invited') {
      throw errors.conflict('This member has already accepted their invitation.');
    }

    await trx
      .updateTable('password_reset_tokens')
      .set({ revoked_at: new Date() })
      .where('user_id', '=', input.userId)
      .where('used_at', 'is', null)
      .where('revoked_at', 'is', null)
      .execute();

    await trx
      .insertInto('password_reset_tokens')
      .values({
        user_id: input.userId,
        token_hash: invitation.tokenHash,
        expires_at: invitation.expiresAt,
        issued_by_user_id: context.actorUserId,
        purpose: 'invitation',
      })
      .execute();

    await writeAuditLog(trx, {
      ...context,
      organizationId: input.organizationId,
      action: 'member.invitation_resent',
      targetType: 'user',
      targetId: input.userId,
      metadata: { expiresAt: invitation.expiresAt.toISOString(), ttlMinutes: ttl },
    });
  });

  return { invitationToken: invitation.token, expiresAt: invitation.expiresAt.toISOString() };
}

/**
 * Cancel a pending invitation.
 *
 * Removes the membership — releasing its seat — and withdraws every outstanding
 * link. The user ACCOUNT is left alone: it may be an existing identity with
 * memberships elsewhere, and even a brand-new one may already be named in an
 * audit entry.
 */
export async function cancelInvitation(
  db: Kysely<Database>,
  input: { organizationId: string; userId: string },
  context: ActorContext,
): Promise<{ cancelled: true }> {
  await db.transaction().execute(async (trx) => {
    const membership = await trx
      .selectFrom('organization_memberships')
      .select(['id', 'status', 'role'])
      .where('organization_id', '=', input.organizationId)
      .where('user_id', '=', input.userId)
      .executeTakeFirst();
    if (!membership) throw errors.notFound('Member');
    if (membership.status !== 'invited') {
      throw errors.conflict('This member has already accepted their invitation.');
    }

    await trx.deleteFrom('organization_memberships').where('id', '=', membership.id).execute();

    await trx
      .updateTable('password_reset_tokens')
      .set({ revoked_at: new Date() })
      .where('user_id', '=', input.userId)
      .where('used_at', 'is', null)
      .where('revoked_at', 'is', null)
      .execute();

    await writeAuditLog(trx, {
      ...context,
      organizationId: input.organizationId,
      action: 'member.invitation_cancelled',
      targetType: 'user',
      targetId: input.userId,
      metadata: { role: membership.role, seatReleased: true },
    });
  });

  return { cancelled: true };
}

/**
 * Seat usage for one organization.
 *
 * ── The rule, stated once ────────────────────────────────────────────────────
 * A seat is consumed by every membership that is NOT suspended — so an `active`
 * member and a pending `invited` one each hold one. Pending invitations reserve
 * a seat deliberately: the alternative lets an administrator issue twenty
 * invitations against five seats and discover the problem only when the
 * nineteenth person tries to accept.
 *
 * Suspending a member RELEASES their seat; removing them releases it too. Both
 * are reversible in the sense that matters — the person can be reactivated or
 * re-invited when a seat is free again.
 *
 * This is the same `countSeats` the invitation path enforces under its lock, so
 * what the screen shows and what the server enforces cannot disagree.
 */
export interface SeatUsage {
  seatLimit: number | null;
  seatsUsed: number;
  activeMembers: number;
  pendingInvitations: number;
  suspendedMembers: number;
  seatsRemaining: number | null;
  atLimit: boolean;
}

export async function seatUsage(db: Executor, organizationId: string): Promise<SeatUsage> {
  const rows = await db
    .selectFrom('organization_memberships')
    .select(['status'])
    .where('organization_id', '=', organizationId)
    .execute();

  const activeMembers = rows.filter((r) => r.status === 'active').length;
  const pendingInvitations = rows.filter((r) => r.status === 'invited').length;
  const suspendedMembers = rows.filter((r) => r.status === 'suspended').length;
  const seatsUsed = activeMembers + pendingInvitations;
  const limit = await seatLimit(db, organizationId);

  return {
    seatLimit: limit,
    seatsUsed,
    activeMembers,
    pendingInvitations,
    suspendedMembers,
    seatsRemaining: limit === null ? null : Math.max(limit - seatsUsed, 0),
    atLimit: limit !== null && seatsUsed >= limit,
  };
}

export interface UpdateMemberInput {
  organizationId: string;
  userId: string;
  role?: OrganizationRole;
  status?: MembershipStatus;
}

/** Change a member's role and/or status inside one organization. */
export async function updateMember(
  db: Kysely<Database>,
  input: UpdateMemberInput,
  context: ActorContext,
): Promise<MemberView> {
  await requireOrganization(db, input.organizationId);
  const membership = await membershipOf(db, input.organizationId, input.userId);
  if (!membership) throw errors.notFound('Member');

  if (input.role === undefined && input.status === undefined) {
    throw errors.validation('Nothing to change.');
  }

  if (input.role === 'owner' && membership.role !== 'owner') {
    throw errors.conflict('A workspace already has its permanent subscriber owner.');
  }

  // The subscriber's designated owner membership is permanent.  Administrators
  // may manage members, but cannot use that authority to claim the workspace.
  const losesOwnership =
    (input.role !== undefined && membership.role === 'owner' && input.role !== 'owner') ||
    (input.status !== undefined && membership.role === 'owner' && input.status !== 'active');
  if (losesOwnership) {
    throw errors.conflict(
      'The subscriber owner is permanent and its workspace membership cannot be changed.',
    );
  }

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('organization_memberships')
      .set({
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        updated_at: new Date(),
      })
      .where('organization_id', '=', input.organizationId)
      .where('user_id', '=', input.userId)
      .execute();

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
  });

  const member = (await listMembers(db, input.organizationId)).find((m) => m.userId === input.userId);
  if (!member) throw errors.notFound('Member');
  return member;
}

/**
 * Remove a member from the organization.
 *
 * The MEMBERSHIP is deleted; the user account and every record they authored are
 * left intact. Nothing in Ledgora deletes accounting history.
 */
export async function removeMember(
  db: Kysely<Database>,
  input: { organizationId: string; userId: string },
  context: ActorContext,
): Promise<void> {
  await requireOrganization(db, input.organizationId);
  const membership = await membershipOf(db, input.organizationId, input.userId);
  if (!membership) throw errors.notFound('Member');
  if (membership.role === 'owner') {
    throw errors.conflict('Transfer ownership before removing an owner.');
  }

  await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom('organization_memberships')
      .where('organization_id', '=', input.organizationId)
      .where('user_id', '=', input.userId)
      .execute();

    await writeAuditLog(trx, {
      ...context,
      organizationId: input.organizationId,
      action: 'member.removed',
      targetType: 'user',
      targetId: input.userId,
      metadata: { role: membership.role },
    });
  });
}

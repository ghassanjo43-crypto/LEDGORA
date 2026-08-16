/**
 * Redeeming an invitation or password-reset link.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 * `password_reset_tokens` has existed since migration 004 and three code paths
 * mint rows in it, but `POST /api/auth/reset-password` returned 501 — so every
 * invitation ever issued was a link that could not be used. This module is the
 * redemption half.
 *
 * It is ALSO where a self-service "I forgot my password" link is minted
 * (`issuePasswordResetToken`), deliberately in the same module and the same
 * table as the invitation path: one token store, one digest-only rule, one
 * redemption function. A second reset system would be a second place for
 * single-use, expiry and revocation to be got subtly wrong.
 *
 * ── What redemption is allowed to reveal ─────────────────────────────────────
 * `describeToken` powers the "set your password" screen, which needs to know
 * whether the link is still good and whose account it is for. It returns the
 * masked email and nothing else — never the full address, never the account
 * status, never whether a password already exists. A link is a bearer
 * credential; holding one should let you SET a password, not enumerate facts
 * about the account.
 *
 * An invalid, expired, revoked or already-used token produces the SAME answer.
 * Distinguishing "expired" from "never existed" tells a holder of a guessed
 * token that they guessed correctly.
 *
 * ── Why redemption is one transaction with a conditional update ──────────────
 * Marking the token used and setting the new password must not be separable, or
 * a crash between them leaves a burned token and an unchanged password. The
 * `used_at IS NULL` predicate on the UPDATE is what makes single-use real under
 * concurrency: two simultaneous redemptions both read a live token, and exactly
 * one of them updates a row.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { hashToken } from '../lib/tokens.js';
import { generateResetToken } from '../lib/credentials.js';
import { hashPassword, checkPasswordPolicy } from '../lib/password.js';
import { writeAuditLog, type AuditContext } from '../lib/audit.js';
import { errors } from '../lib/errors.js';
import { revokeAllUserSessions } from './sessionService.js';
import { activateInvitedMemberships } from './memberService.js';

/**
 * One refusal for every unusable token.
 *
 * Deliberately identical wording whatever the cause, for the reason given above.
 * The message tells the holder what to DO, which is the only useful thing that
 * can be said without leaking.
 */
function invalidToken() {
  return errors.validation(
    'This link is no longer valid. It may have expired or already been used. Ask your administrator for a new one.',
  );
}

/** `a***@example.com` — enough to recognise, not enough to harvest. */
function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

export interface TokenDescription {
  valid: boolean;
  purpose: 'invitation' | 'reset' | null;
  maskedEmail: string | null;
  expiresAt: string | null;
}

/**
 * Is this link usable, and what is it for?
 *
 * Read-only. Calling it does not consume the token — the screen that collects
 * the new password needs to render before anything is spent.
 */
export async function describeToken(db: Kysely<Database>, rawToken: string): Promise<TokenDescription> {
  const unusable: TokenDescription = { valid: false, purpose: null, maskedEmail: null, expiresAt: null };
  if (!rawToken || rawToken.length < 16) return unusable;

  const row = await db
    .selectFrom('password_reset_tokens')
    .innerJoin('users', 'users.id', 'password_reset_tokens.user_id')
    .select([
      'password_reset_tokens.purpose',
      'password_reset_tokens.expires_at',
      'password_reset_tokens.used_at',
      'password_reset_tokens.revoked_at',
      'users.email',
      'users.deleted_at',
    ])
    // Looked up by HASH. The raw token is never stored, so a database disclosure
    // yields nothing that can be replayed here.
    .where('password_reset_tokens.token_hash', '=', hashToken(rawToken))
    .executeTakeFirst();

  if (!row) return unusable;
  if (row.used_at || row.revoked_at) return unusable;
  if (new Date(row.expires_at).getTime() <= Date.now()) return unusable;
  if (row.deleted_at) return unusable;

  return {
    valid: true,
    purpose: row.purpose,
    maskedEmail: maskEmail(row.email),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/* ── Self-service reset: issuing the link ─────────────────────────────────── */

export interface IssuedResetToken {
  userId: string;
  email: string;
  /** Returned once, to be put in a link and then dropped. Never persisted. */
  token: string;
  expiresAt: Date;
  ttlMinutes: number;
}

/**
 * Mint a reset link for a self-service "I forgot my password" request.
 *
 * ── Why this returns `null` rather than throwing ─────────────────────────────
 * The caller must answer identically whether or not the address exists, so
 * "there is nobody here" is an ORDINARY result, not an error. Throwing would
 * push the caller into a catch block that has to remember to reply as if
 * nothing had happened — and one day it would not.
 *
 * ── Who is eligible ──────────────────────────────────────────────────────────
 * A live account that is not deleted and not DISABLED. Disabling is a deliberate
 * administrative decision, and a self-service link must never be the thing that
 * begins to overturn it; redemption refuses a disabled account too, so issuing
 * the link would only produce a message the holder cannot act on.
 *
 * ── What is written, and what is not ─────────────────────────────────────────
 * Only the SHA-256 digest reaches the database — the same storage the invitation
 * path uses, in the same table, redeemed by the same `redeemToken`. There is no
 * second reset system here. The raw token is returned to the caller for exactly
 * one purpose: to be interpolated into an email body that is never logged.
 */
export async function issuePasswordResetToken(
  db: Kysely<Database>,
  input: { email: string; ttlMinutes: number },
  context: AuditContext = {},
): Promise<IssuedResetToken | null> {
  const normalized = input.email.trim().toLowerCase();
  if (!normalized) return null;

  const user = await db
    .selectFrom('users')
    .select(['id', 'email', 'status', 'deleted_at'])
    .where('normalized_email', '=', normalized)
    .executeTakeFirst();

  if (!user || user.deleted_at || user.status === 'disabled') return null;

  const ttlMinutes = Math.max(input.ttlMinutes, 1);
  const generated = generateResetToken(ttlMinutes);
  const now = new Date();

  await db.transaction().execute(async (trx) => {
    /*
     * Supersede every outstanding link first.
     *
     * `revoked_at`, not `used_at`: an earlier link that a repeated request
     * replaced was never redeemed, and recording it as used would put a
     * redemption in the trail that never happened. It also means a stack of
     * links from impatient repeat requests cannot undermine single-use — only
     * the newest one works.
     */
    await trx
      .updateTable('password_reset_tokens')
      .set({ revoked_at: now })
      .where('user_id', '=', user.id)
      .where('used_at', 'is', null)
      .where('revoked_at', 'is', null)
      .execute();

    await trx
      .insertInto('password_reset_tokens')
      .values({
        user_id: user.id,
        token_hash: generated.tokenHash,
        expires_at: generated.expiresAt,
        purpose: 'reset',
        // Nobody issued it on the account holder's behalf; the request was
        // unauthenticated, so there is no operator to name.
        issued_by_user_id: null,
      })
      .execute();

    await writeAuditLog(trx, {
      ...context,
      // Attributed to the account itself. The requester is unauthenticated and
      // therefore unknown — the IP and user agent in `context` are all that can
      // honestly be said about who asked.
      actorUserId: user.id,
      action: 'auth.password_reset_requested',
      targetType: 'user',
      targetId: user.id,
      // No token, no hash. The fact and its window only.
      metadata: { expiresAt: generated.expiresAt.toISOString(), ttlMinutes, selfService: true },
    });
  });

  return {
    userId: user.id,
    email: user.email,
    token: generated.token,
    expiresAt: generated.expiresAt,
    ttlMinutes,
  };
}

export interface RedeemResult {
  userId: string;
  email: string;
  purpose: 'invitation' | 'reset';
  revokedSessions: number;
}

/**
 * Set a password from a single-use link.
 *
 * On success the account is brought fully into service: the forced-change flag
 * and any temporary-password deadline are cleared (the holder has just chosen
 * their own password, so there is nothing left to force), the lockout counters
 * are reset, and — for an invitation — the address is marked verified and the
 * membership activated, because redeeming a link sent to that address IS the
 * proof of reachability the pending state was waiting for.
 *
 * Every live session is revoked. Whoever held one authenticated with the
 * previous credential, which this call has just replaced.
 */
export async function redeemToken(
  db: Kysely<Database>,
  input: { token: string; newPassword: string },
  context: AuditContext = {},
): Promise<RedeemResult> {
  const tokenHash = hashToken(input.token ?? '');

  const row = await db
    .selectFrom('password_reset_tokens')
    .innerJoin('users', 'users.id', 'password_reset_tokens.user_id')
    .select([
      'password_reset_tokens.id as token_id',
      'password_reset_tokens.purpose',
      'password_reset_tokens.expires_at',
      'password_reset_tokens.used_at',
      'password_reset_tokens.revoked_at',
      'users.id as user_id',
      'users.email',
      'users.full_name',
      'users.status',
      'users.deleted_at',
    ])
    .where('password_reset_tokens.token_hash', '=', tokenHash)
    .executeTakeFirst();

  if (!row || row.used_at || row.revoked_at || row.deleted_at) throw invalidToken();
  if (new Date(row.expires_at).getTime() <= Date.now()) throw invalidToken();

  /*
   * The policy check happens before anything is spent, so a rejected password
   * does not burn the link. It is given the account's own email and name so the
   * "must not contain your name" rules can apply — the same check the
   * self-service change-password path runs.
   */
  const policy = checkPasswordPolicy(input.newPassword ?? '', {
    email: row.email,
    fullName: row.full_name,
  });
  if (!policy.ok) {
    throw errors.validation(policy.problems[0] ?? 'That password does not meet the policy.', {
      fieldErrors: { newPassword: policy.problems.join(' ') },
    });
  }

  // Argon2 outside the transaction — an expensive KDF must not hold a connection.
  const passwordHash = await hashPassword(input.newPassword);
  const now = new Date();

  const revokedSessions = await db.transaction().execute(async (trx) => {
    /*
     * Burn the token FIRST, conditionally.
     *
     * `used_at IS NULL` in the predicate is the single-use guarantee: under two
     * concurrent redemptions both transactions see a live token, but only one
     * updates a row. The loser gets zero and refuses, having changed nothing.
     */
    const burned = await trx
      .updateTable('password_reset_tokens')
      .set({ used_at: now })
      .where('id', '=', row.token_id)
      .where('used_at', 'is', null)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    if (Number(burned.numUpdatedRows ?? 0) === 0) throw invalidToken();

    await trx
      .updateTable('users')
      .set({
        password_hash: passwordHash,
        // The holder chose this password themselves; there is nothing to force.
        must_change_password: false,
        password_expires_at: null,
        failed_login_count: 0,
        locked_until: null,
        // Redeeming a link sent to the address proves reachability. A reset link
        // for an already-verified account leaves the existing timestamp alone.
        ...(row.purpose === 'invitation' ? { email_verified_at: now } : {}),
        /*
         * A pending or locked account becomes usable. A DISABLED one does not:
         * disabling is a deliberate administrative decision, and a password link
         * must never be the thing that overturns it.
         */
        status: row.status === 'disabled' ? 'disabled' : 'active',
        updated_at: now,
      })
      .where('id', '=', row.user_id)
      .execute();

    /*
     * The invitation has been accepted, which is exactly what `invited` was
     * waiting for.
     *
     * Delegated to `memberService.activateInvitedMemberships` rather than done
     * inline, so this path and the temporary-password path share ONE transition
     * — including its refusal to touch a suspended membership and its per-
     * membership audit entry. A second copy here is how the two would drift.
     */
    let activated = 0;
    if (row.purpose === 'invitation') {
      activated = await activateInvitedMemberships(trx, row.user_id, {
        ...context,
        trigger: 'invitation_redeemed',
      });
    }

    // Supersede any other outstanding link, so a stack of valid tokens issued by
    // successive attempts cannot undermine single-use.
    await trx
      .updateTable('password_reset_tokens')
      .set({ revoked_at: now })
      .where('user_id', '=', row.user_id)
      .where('id', '!=', row.token_id)
      .where('used_at', 'is', null)
      .where('revoked_at', 'is', null)
      .execute();

    const revoked = await revokeAllUserSessions(trx, row.user_id);

    await writeAuditLog(trx, {
      ...context,
      // The subject acted on their own account — there is no operator here.
      actorUserId: row.user_id,
      action: row.purpose === 'invitation' ? 'invitation.redeemed' : 'auth.password_reset_completed',
      targetType: 'user',
      targetId: row.user_id,
      // No token, no hash, no password. The fact and its consequences only.
      metadata: {
        purpose: row.purpose,
        revokedSessions: revoked,
        emailVerified: row.purpose === 'invitation',
        previousStatus: row.status,
        activatedMemberships: activated,
      },
    });

    return revoked;
  });

  return {
    userId: row.user_id,
    email: row.email,
    purpose: row.purpose,
    revokedSessions,
  };
}

/**
 * Withdraw every outstanding link for a user.
 *
 * Recorded as `invitation.revoked` rather than by setting `used_at`: a token an
 * administrator cancelled was never redeemed, and marking it used would put a
 * redemption in the trail that never happened.
 */
export async function revokeOutstandingTokens(
  db: Kysely<Database>,
  input: { userId: string; reason: string },
  context: AuditContext & { actorUserId: string },
): Promise<{ userId: string; revoked: number }> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw errors.validation('A reason is required and is recorded in the audit trail.', {
      fieldErrors: { reason: 'Explain why these links are being withdrawn.' },
    });
  }

  const now = new Date();
  const revoked = await db.transaction().execute(async (trx) => {
    const result = await trx
      .updateTable('password_reset_tokens')
      .set({ revoked_at: now })
      .where('user_id', '=', input.userId)
      .where('used_at', 'is', null)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    const count = Number(result.numUpdatedRows ?? 0);
    if (count > 0) {
      await writeAuditLog(trx, {
        ...context,
        action: 'invitation.revoked',
        targetType: 'user',
        targetId: input.userId,
        metadata: { reason, revokedCount: count },
      });
    }
    return count;
  });

  return { userId: input.userId, revoked };
}

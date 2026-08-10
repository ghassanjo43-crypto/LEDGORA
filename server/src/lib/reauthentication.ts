/**
 * Step-up re-authentication for irreversible acts.
 *
 * ── Why a session is not enough ──────────────────────────────────────────────
 * A live session proves somebody signed in on this browser at some point. For
 * scheduling the destruction of a subscriber's records that is the wrong
 * question: what has to be proved is that the person AT THE KEYBOARD RIGHT NOW
 * holds the operator's credential. An unattended laptop, a borrowed session or a
 * stolen cookie all pass the first test and fail this one.
 *
 * ── Why it is verified here and not in the browser ───────────────────────────
 * A "please confirm your password" checkbox in a dialog proves nothing whatever:
 * the client that renders it is the client an attacker controls. The password is
 * verified against the stored Argon2id digest of the ACTING operator, resolved
 * from the database-backed session — never from anything in the request beyond
 * the password itself.
 *
 * ── What never happens to the password ───────────────────────────────────────
 * It is compared and discarded. It is not stored, not logged (`req.body.password`
 * is in the logger's redact list), not echoed in a response, and not written to
 * audit metadata — `sanitiseMetadata` would redact it even if a future edit put
 * it there by mistake. What IS recorded is the fact that a step-up succeeded or
 * failed, which is what an auditor needs.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { verifyPassword } from './password.js';
import { writeAuditLog, type AuditContext } from './audit.js';
import { errors } from './errors.js';

export interface ReauthenticationInput {
  /** The acting operator, from the verified session. Never from the body. */
  actorUserId: string;
  /** The password typed into the confirmation dialog. */
  password: string;
}

/**
 * Verify the acting operator's password, or throw.
 *
 * A failure is audited before it is thrown: repeated step-up failures against a
 * destructive endpoint are exactly the pattern a reviewer wants to be able to
 * find.
 */
export async function requireReauthentication(
  db: Kysely<Database>,
  input: ReauthenticationInput,
  context: AuditContext & { action: string; targetType?: string; targetId?: string | null },
): Promise<void> {
  const password = input.password ?? '';
  if (!password) {
    throw errors.validation('Confirm your password to continue.', {
      fieldErrors: { password: 'Your password is required for this action.' },
    });
  }

  const actor = await db
    .selectFrom('users')
    .select(['id', 'password_hash', 'status'])
    .where('id', '=', input.actorUserId)
    .executeTakeFirst();

  // The session resolved to a user a moment ago, so this is a "cannot happen"
  // that must still fail closed rather than skip the check.
  if (!actor || actor.status !== 'active') throw errors.unauthenticated();

  if (!(await verifyPassword(actor.password_hash, password))) {
    await writeAuditLog(db, {
      ...context,
      actorUserId: input.actorUserId,
      action: 'auth.reauthentication_failed',
      targetType: context.targetType ?? null,
      targetId: context.targetId ?? null,
      // The attempted password is absent by construction.
      metadata: { forAction: context.action },
    });
    /*
     * Deliberately NOT `invalidCredentials()`: the caller is already
     * authenticated, so there is nothing to enumerate, and a distinct code lets
     * the dialog re-prompt for the password instead of bouncing to sign-in.
     */
    throw errors.reauthenticationFailed();
  }
}

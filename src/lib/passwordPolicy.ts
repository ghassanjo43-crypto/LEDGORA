/**
 * Client-side mirror of the account password policy.
 *
 * ── Advisory only ────────────────────────────────────────────────────────────
 * `server/src/lib/password.ts` owns this policy and re-checks every rule on
 * every request. Nothing here is a security control: it exists so the person
 * typing gets an immediate, specific reason instead of a round trip, and so a
 * form can disable its submit button before spending an Argon2 hash on a
 * password that was never going to be accepted.
 *
 * When the two disagree the SERVER wins — a `password_policy` response carries
 * its own `problems`, and the form displays those verbatim rather than any
 * message composed here. The common-password list is deliberately NOT mirrored:
 * it is a server-side blocklist that will grow, and a stale copy in the bundle
 * would tell a user their password is fine seconds before the server refuses it.
 */

/** Kept in step with MIN_PASSWORD_LENGTH / MAX_PASSWORD_LENGTH on the server. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

/** The single wording used by every password field in the application. */
export const PASSWORD_RULE_HINT =
  'At least 12 characters, with upper and lower case letters and a digit. It must not contain your name or email address.';

export interface PasswordPolicyContext {
  email?: string | null;
  fullName?: string | null;
}

/**
 * Every rule the given password breaks, in the server's own wording. An empty
 * array means "nothing this client can see is wrong with it" — never "accepted".
 */
export function checkPasswordPolicy(
  password: string,
  context: PasswordPolicyContext = {},
): string[] {
  const problems: string[] = [];

  if (password.length < MIN_PASSWORD_LENGTH) {
    problems.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    problems.push(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
    problems.push('Password must contain both upper and lower case letters.');
  }
  if (!/\d/.test(password)) {
    problems.push('Password must contain at least one digit.');
  }

  const lowered = password.toLowerCase();

  const localPart = context.email?.split('@')[0]?.toLowerCase();
  if (localPart && localPart.length >= 3 && lowered.includes(localPart)) {
    problems.push('Password must not contain your email address.');
  }

  if (context.fullName) {
    for (const part of context.fullName.toLowerCase().split(/\s+/)) {
      if (part.length >= 4 && lowered.includes(part)) {
        problems.push('Password must not contain your name.');
        break;
      }
    }
  }

  return problems;
}

/** Convenience predicate for a submit button. */
export function passwordMeetsPolicy(password: string, context: PasswordPolicyContext = {}): boolean {
  return checkPasswordPolicy(password, context).length === 0;
}

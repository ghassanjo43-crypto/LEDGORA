/**
 * Administrator-issued credentials: temporary passwords and reset tokens.
 *
 * ── The one rule this module exists to keep ──────────────────────────────────
 * A generated secret is returned to its caller EXACTLY ONCE and never persisted
 * in a recoverable form. Nothing here logs, stores or re-derives a raw value:
 *  · a temporary password is handed back for a single response, then only its
 *    Argon2id hash reaches the database;
 *  · a reset token is handed back for a single response, then only its SHA-256
 *    hash reaches the database.
 *
 * The two hashes differ deliberately. A password is a low-entropy human secret
 * that must resist offline attack, so it needs a memory-hard KDF. A reset token
 * is 256 bits of `randomBytes` — SHA-256 is the right choice there for the same
 * reason it is right for session tokens, and Argon2 would only make lookup slow.
 *
 * ── Why not a passphrase generator ───────────────────────────────────────────
 * The alphabet below excludes visually ambiguous characters (no I/l/1, O/0) so a
 * password read aloud over the phone or copied from a screen arrives intact. The
 * length keeps the entropy well above the 12-character policy minimum even with
 * the reduced alphabet.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { hashToken } from './tokens.js';

/**
 * Unambiguous alphabet. Deliberately no `I`, `l`, `1`, `O`, `0` — a temporary
 * password that cannot be transcribed reliably generates support calls, and the
 * lost entropy is bought back by length.
 */
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_=+';
const ALL = `${UPPER}${LOWER}${DIGITS}${SYMBOLS}`;

/** 20 characters over a ~76-symbol alphabet — comfortably over 100 bits. */
export const TEMPORARY_PASSWORD_LENGTH = 20;

/** `randomInt` is the CSPRNG-backed unbiased picker; never `Math.random()`. */
function pick(alphabet: string): string {
  return alphabet[randomInt(alphabet.length)]!;
}

/**
 * Fisher–Yates with `randomInt`, so the guaranteed characters are not always in
 * the same positions — otherwise every generated password would start with an
 * upper-case letter and end with a symbol.
 */
function shuffle(characters: string[]): string[] {
  for (let i = characters.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [characters[i], characters[j]] = [characters[j]!, characters[i]!];
  }
  return characters;
}

/**
 * A cryptographically secure temporary password that satisfies the account
 * password policy by construction (upper, lower, digit, length).
 *
 * The return value must be treated as write-once: hash it, show it to the
 * administrator, and let it go out of scope. Do not log it, do not put it on an
 * object that gets serialised beyond the single response, and do not store it.
 */
export function generateTemporaryPassword(): string {
  // One of each required class first, so policy compliance is not left to luck.
  const required = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
  const rest = Array.from({ length: TEMPORARY_PASSWORD_LENGTH - required.length }, () => pick(ALL));
  return shuffle([...required, ...rest]).join('');
}

export interface GeneratedResetToken {
  /** Returned once, to be put in a link. Never persisted. */
  token: string;
  /** What the database stores. */
  tokenHash: string;
  expiresAt: Date;
}

/**
 * A single-use reset token and its hash.
 *
 * Single-use is enforced by the `used_at` column at redemption time, not here —
 * this function only mints the value. 256 bits of entropy makes guessing
 * irrelevant; expiry limits the window if the link itself leaks.
 */
export function generateResetToken(ttlMinutes: number): GeneratedResetToken {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + Math.max(ttlMinutes, 1) * 60_000),
  };
}

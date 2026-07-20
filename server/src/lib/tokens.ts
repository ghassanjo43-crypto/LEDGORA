/**
 * Token generation and hashing.
 *
 * Session tokens, payment references and reset tokens all come from
 * `crypto.randomBytes` — never `Math.random()`. Only the SHA-256 hash of a
 * session token is persisted, so a database disclosure does not yield usable
 * session credentials.
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/** 256 bits of entropy, URL-safe. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison for hex digests of equal length. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Crockford-style alphabet: no I, L, O or U, so a reference cannot be misread
 * when a human copies it into a bank transfer form.
 */
const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAYMENT_REFERENCE_PATTERN = /^LG-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/**
 * `LG-XXXX-XXXX` bank-remittance reference, cryptographically random.
 * Uniqueness is enforced by the UNIQUE constraint on
 * `subscription_invoices.payment_reference`; callers retry on conflict.
 */
export function generatePaymentReference(): string {
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => REFERENCE_ALPHABET[b % REFERENCE_ALPHABET.length]);
  return `LG-${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}`;
}

/** Opaque storage key for an uploaded file. Contains no user-controlled path. */
export function generateStorageKey(extension: string): string {
  const safeExt = extension.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();
  return `${randomBytes(16).toString('hex')}${safeExt ? `.${safeExt}` : ''}`;
}

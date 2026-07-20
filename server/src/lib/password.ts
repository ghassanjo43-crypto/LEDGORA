/**
 * Password hashing and policy.
 *
 * Argon2id (memory-hard, side-channel resistant) via @node-rs/argon2, which
 * ships prebuilt binaries so no compiler toolchain is needed. Verification is
 * constant-time inside the library.
 *
 * A raw password never leaves this module: it is not logged, not stored, not
 * returned, and not placed on any object that gets serialised.
 */
import { hash, verify, Algorithm } from '@node-rs/argon2';

/**
 * OWASP-aligned parameters (19 MiB, t=2, p=1). Tuned to stay comfortably within
 * Render's smaller instance memory while remaining costly to attack.
 */
const PRODUCTION_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Argon2id is deliberately expensive, which makes a large test suite unusably
 * slow. Tests — and ONLY tests — use reduced work factors. The algorithm and
 * hash format are unchanged, so everything under test is still real Argon2id.
 * This can never apply in production: it is keyed to NODE_ENV === 'test'.
 */
const TEST_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 512,
  timeCost: 1,
  parallelism: 1,
} as const;

const OPTIONS = process.env.NODE_ENV === 'test' ? TEST_OPTIONS : PRODUCTION_OPTIONS;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

/** Obvious-guess list. Not a substitute for a breach-corpus check in production. */
const FORBIDDEN = new Set([
  'password', 'password1', 'passw0rd', '123456789012', 'qwertyuiop12',
  'administrator', 'ledgora12345', 'letmein12345', 'changeme1234',
]);

export interface PasswordPolicyResult {
  ok: boolean;
  problems: string[];
}

export function checkPasswordPolicy(password: string, context: { email?: string; fullName?: string } = {}): PasswordPolicyResult {
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
  if (FORBIDDEN.has(lowered)) {
    problems.push('That password is too common.');
  }
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
  return { ok: problems.length === 0, problems };
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

/**
 * Constant-time verification. Returns false (never throws) on a malformed hash,
 * so a corrupted record cannot become an authentication bypass.
 */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password, OPTIONS);
  } catch {
    return false;
  }
}

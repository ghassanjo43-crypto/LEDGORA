/**
 * Static option lists and small pure helpers for the registration / onboarding
 * funnel. Anything the super administrator can edit lives in a store (billing
 * bank details, metering plans); the lists here are UI vocabulary only.
 */
import type { SelectOption } from '@/components/ui/Select';
import { generateDevelopmentReference } from '@/services/paymentReferenceService';

/** A compact country list (extend freely — UI vocabulary, not billing config). */
export const COUNTRY_OPTIONS: SelectOption[] = [
  { value: 'AE', label: 'United Arab Emirates' },
  { value: 'SA', label: 'Saudi Arabia' },
  { value: 'JO', label: 'Jordan' },
  { value: 'EG', label: 'Egypt' },
  { value: 'QA', label: 'Qatar' },
  { value: 'KW', label: 'Kuwait' },
  { value: 'BH', label: 'Bahrain' },
  { value: 'OM', label: 'Oman' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'US', label: 'United States' },
  { value: 'CA', label: 'Canada' },
  { value: 'DE', label: 'Germany' },
  { value: 'FR', label: 'France' },
  { value: 'IN', label: 'India' },
  { value: 'PK', label: 'Pakistan' },
  { value: 'SG', label: 'Singapore' },
  { value: 'AU', label: 'Australia' },
  { value: 'OTHER', label: 'Other' },
];

/** Financial-year start options as MM-DD. */
export const FY_START_OPTIONS: SelectOption[] = [
  { value: '01-01', label: 'January (calendar year)' },
  { value: '04-01', label: 'April' },
  { value: '07-01', label: 'July' },
  { value: '10-01', label: 'October' },
];

export function countryLabel(code: string): string {
  return COUNTRY_OPTIONS.find((c) => c.value === code)?.label ?? code;
}

/* ── Validators (shared by UI and store so rules are enforced once) ────────── */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE_RE = /^\+?[0-9\s-]{7,20}$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

export function isValidMobile(value: string): boolean {
  return MOBILE_RE.test(value.trim());
}

/** Password policy: at least 8 chars, one letter and one digit. */
export function passwordProblem(value: string): string | null {
  if (value.length < 8) return 'Use at least 8 characters.';
  if (!/[A-Za-z]/.test(value)) return 'Include at least one letter.';
  if (!/[0-9]/.test(value)) return 'Include at least one number.';
  return null;
}

/**
 * Non-reversible mock password hash. This is NOT cryptographically secure and
 * is only a seam: a real backend stores an argon2/bcrypt hash. The raw password
 * is never persisted anywhere in the client.
 */
export function mockHashPassword(raw: string): string {
  let h = 2166136261;
  const salted = `ledgora:${raw}`;
  for (let i = 0; i < salted.length; i += 1) {
    h ^= salted.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `mh1$${(h >>> 0).toString(16)}`;
}

export function verifyMockPassword(raw: string, hash: string): boolean {
  return mockHashPassword(raw) === hash;
}

/** A short opaque email-verification token (seam for an emailed link). */
export function makeVerificationToken(): string {
  return `evt_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Human-quotable bank-remittance payment reference, e.g. `LG-7F3K-9QX2`.
 *
 * Delegates to the payment-reference service so there is ONE generator in the
 * codebase and one place a backend implementation replaces it. Pass `isTaken` to
 * check against references the caller already holds; in production the database
 * UNIQUE constraint is what actually guarantees uniqueness.
 * @see services/paymentReferenceService
 */
export function makePaymentReference(isTaken?: (reference: string) => boolean): string {
  return generateDevelopmentReference(isTaken);
}

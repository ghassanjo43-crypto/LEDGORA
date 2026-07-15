/**
 * Permission checks for the billing / package-management module. Entitlement
 * (what the ORGANIZATION owns) and permission (what the USER may do) are
 * separate concerns — both must pass. Administrator-only actions: editing
 * packages, editing bank details/settings, and verifying/approving payments.
 */
import type { UserRole } from '@/store/sessionStore';

export interface PermissionResult {
  ok: boolean;
  error?: string;
}

const DENIED =
  'You do not have permission to perform this action. An administrator is required.';

/** Anyone signed in may view billing and start a subscription request. */
export function canViewBilling(_role: UserRole): boolean {
  return true;
}

export function canSubscribe(_role: UserRole): boolean {
  return true;
}

/** Only administrators manage packages, bank details and billing settings. */
export function canManagePlans(role: UserRole): boolean {
  return role === 'admin';
}

export function canManageBillingSettings(role: UserRole): boolean {
  return role === 'admin';
}

/** Only administrators verify (approve/reject) payment proofs. */
export function canVerifyPayments(role: UserRole): boolean {
  return role === 'admin';
}

export function assertCanManagePlans(role: UserRole): PermissionResult {
  return canManagePlans(role) ? { ok: true } : { ok: false, error: DENIED };
}

export function assertCanManageBillingSettings(role: UserRole): PermissionResult {
  return canManageBillingSettings(role) ? { ok: true } : { ok: false, error: DENIED };
}

export function assertCanVerifyPayments(role: UserRole): PermissionResult {
  return canVerifyPayments(role) ? { ok: true } : { ok: false, error: DENIED };
}

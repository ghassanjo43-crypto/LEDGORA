/**
 * Permission checks for the billing / package-management module. Entitlement
 * (what the ORGANIZATION owns) and permission (what the USER may do) are
 * separate concerns — both must pass.
 *
 * Every check here resolves through `lib/platformAccess`, so it FAILS CLOSED in
 * a production build: approving a payment, editing packages or changing bank
 * details is refused even when the action is called directly from the browser
 * console, because no browser-held value can grant a platform role.
 */
import type { PlatformRole } from '@/types/roles';
import {
  assertPlatformCapability,
  hasPlatformCapability,
  type PermissionResult,
} from './platformAccess';

export type { PermissionResult };

const DENIED =
  'You do not have permission to perform this action. It requires a verified LEDGORA platform administrator.';

/** Anyone signed in may view billing and start a subscription request. */
export function canViewBilling(_role: PlatformRole): boolean {
  return true;
}

export function canSubscribe(_role: PlatformRole): boolean {
  return true;
}

/** Only platform billing administrators manage packages and settings. */
export function canManagePlans(role: PlatformRole): boolean {
  return hasPlatformCapability(role, 'manage-plans');
}

export function canManageBillingSettings(role: PlatformRole): boolean {
  return hasPlatformCapability(role, 'manage-billing-settings');
}

/** Only platform billing administrators verify (approve/reject) payment proofs. */
export function canVerifyPayments(role: PlatformRole): boolean {
  return hasPlatformCapability(role, 'verify-payments');
}

export function assertCanManagePlans(role: PlatformRole): PermissionResult {
  return assertPlatformCapability(role, 'manage-plans', DENIED);
}

export function assertCanManageBillingSettings(role: PlatformRole): PermissionResult {
  return assertPlatformCapability(role, 'manage-billing-settings', DENIED);
}

export function assertCanVerifyPayments(role: PlatformRole): PermissionResult {
  return assertPlatformCapability(role, 'verify-payments', DENIED);
}

/** Activating a paid subscription is a platform action, never a customer one. */
export function assertCanActivateSubscription(role: PlatformRole): PermissionResult {
  return assertPlatformCapability(role, 'activate-subscription', DENIED);
}

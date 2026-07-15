/**
 * Permission checks for the metering / infrastructure module. Editing plans,
 * allowances, overage rates, bundles and Render cost assumptions is restricted
 * to the super administrator. In this frontend the 'admin' role represents the
 * super administrator; a real backend enforces the same checks server-side.
 */
import type { UserRole } from '@/store/sessionStore';

export interface PermissionResult {
  ok: boolean;
  error?: string;
}

const DENIED = 'Only the super administrator can change metering configuration.';

export function canManageMetering(role: UserRole): boolean {
  return role === 'admin';
}

export function canClosePeriods(role: UserRole): boolean {
  return role === 'admin';
}

export function canViewInfraCost(role: UserRole): boolean {
  return role === 'admin';
}

export function assertCanManageMetering(role: UserRole): PermissionResult {
  return canManageMetering(role) ? { ok: true } : { ok: false, error: DENIED };
}

export function assertCanClosePeriods(role: UserRole): PermissionResult {
  return canClosePeriods(role) ? { ok: true } : { ok: false, error: DENIED };
}

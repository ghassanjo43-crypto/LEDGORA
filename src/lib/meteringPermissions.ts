/**
 * Permission checks for the metering / infrastructure module. Editing plans,
 * allowances, overage rates, bundles and Render cost assumptions is restricted
 * to the LEDGORA super administrator.
 *
 * Like the billing checks, these resolve through `lib/platformAccess` and so
 * FAIL CLOSED in a production build — metering and infrastructure-cost
 * administration cannot be reached from a deployed browser at all.
 */
import type { PlatformRole } from '@/types/roles';
import {
  assertPlatformCapability,
  hasPlatformCapability,
  type PermissionResult,
} from './platformAccess';

export type { PermissionResult };

const DENIED = 'Only a verified LEDGORA super administrator can change metering configuration.';

export function canManageMetering(role: PlatformRole): boolean {
  return hasPlatformCapability(role, 'manage-metering');
}

export function canClosePeriods(role: PlatformRole): boolean {
  return hasPlatformCapability(role, 'close-usage-periods');
}

export function canViewInfraCost(role: PlatformRole): boolean {
  return hasPlatformCapability(role, 'view-infra-cost');
}

export function assertCanManageMetering(role: PlatformRole): PermissionResult {
  return assertPlatformCapability(role, 'manage-metering', DENIED);
}

export function assertCanClosePeriods(role: PlatformRole): PermissionResult {
  return assertPlatformCapability(role, 'close-usage-periods', DENIED);
}

export function assertCanViewInfraCost(role: PlatformRole): PermissionResult {
  return assertPlatformCapability(role, 'view-infra-cost', DENIED);
}

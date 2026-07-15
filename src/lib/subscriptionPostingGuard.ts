/**
 * Subscription status gate for NEW posting activity.
 *
 * MVP rules (spec §18):
 *   - trial / active / past-due → posting allowed
 *   - suspended / cancelled / expired → posting blocked, but existing data is
 *     fully preserved and reporting/export remain available.
 *
 * This never deletes data; it only prevents creating new postings while the
 * subscription is not in good standing.
 */
import type { SubscriptionStatus } from '@/types/subscription';
import type { LedgoraEdition, LedgoraModule } from '@/types/entitlements';
import { statusIsActive } from './entitlementResolution';

export interface PostingGuardResult {
  ok: boolean;
  error?: string;
}

const BLOCK_MESSAGES: Partial<Record<SubscriptionStatus, string>> = {
  suspended:
    'Your Ledgora subscription is suspended. New posting is blocked until it is reactivated after bank-remittance confirmation. Your existing data is preserved.',
  cancelled:
    'Your Ledgora subscription is cancelled. New posting is blocked. Your existing data is preserved and remains available for reporting and export.',
  expired:
    'Your Ledgora subscription has expired. New posting is blocked until it is renewed. Your existing data is preserved.',
  'past-due':
    'Your Ledgora subscription is past due. Please arrange payment to avoid interruption.',
};

/** Whether the given subscription status permits creating new postings. */
export function subscriptionAllowsPosting(status: SubscriptionStatus): boolean {
  return statusIsActive(status);
}

/**
 * Assert that the given status allows posting. Returns a result object rather
 * than throwing so it composes cleanly with the store action result pattern.
 */
export function assertSubscriptionAllowsPosting(
  status: SubscriptionStatus,
): PostingGuardResult {
  if (subscriptionAllowsPosting(status)) return { ok: true };
  return {
    ok: false,
    error:
      BLOCK_MESSAGES[status] ??
      'Your Ledgora subscription does not currently allow new posting.',
  };
}

/* ── Limits (spec §19) ────────────────────────────────────────────────────── */

export interface LimitCheckResult {
  ok: boolean;
  error?: string;
}

export function canCreateUser(
  currentUserCount: number,
  userLimit: number,
): LimitCheckResult {
  if (currentUserCount < userLimit) return { ok: true };
  return {
    ok: false,
    error: `Your current Ledgora subscription supports up to ${userLimit} user${userLimit === 1 ? '' : 's'}.`,
  };
}

export function canCreateEntity(
  currentEntityCount: number,
  entityLimit: number,
): LimitCheckResult {
  if (currentEntityCount < entityLimit) return { ok: true };
  return {
    ok: false,
    error: `Your current Ledgora subscription supports up to ${entityLimit} entit${entityLimit === 1 ? 'y' : 'ies'}.`,
  };
}

/** Whether a module-scoped write should be blocked because the org lost the module. */
export function assertModuleActivityAllowed(
  moduleIds: readonly LedgoraModule[],
  module: LedgoraModule,
  edition: LedgoraEdition,
): PostingGuardResult {
  if (moduleIds.includes(module)) return { ok: true };
  return {
    ok: false,
    error: `This activity requires a module that is not included in your current Ledgora ${edition} edition. Historical records remain visible, but new records are blocked.`,
  };
}

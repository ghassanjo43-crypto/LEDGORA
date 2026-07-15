/**
 * Migration & subscription construction helpers.
 *
 * Existing local/development organizations already use many modules. To avoid
 * hiding any currently-implemented module after this change, an organization
 * with no subscription is migrated to an Enterprise DEVELOPMENT subscription.
 * New organizations must explicitly select an edition during onboarding.
 *
 * No existing records are ever deleted or rewritten by these helpers.
 */
import type { LedgoraEdition } from '@/types/entitlements';
import type {
  ActivationMethod,
  OrganizationSubscription,
  SubscriptionStatus,
} from '@/types/subscription';
import { EDITION_LIMITS } from '@/config/editions';

/** Deterministic-ish id without pulling in the app's generateId (keeps this pure). */
function subId(): string {
  return `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface CreateSubscriptionInput {
  organizationId: string;
  edition: LedgoraEdition;
  status?: SubscriptionStatus;
  activationMethod?: ActivationMethod;
  now?: string;
  userLimit?: number;
  entityLimit?: number;
  adminNotes?: string;
}

/** Build a fresh subscription for a chosen edition (used by onboarding). */
export function createSubscription(
  input: CreateSubscriptionInput,
): OrganizationSubscription {
  const now = input.now ?? new Date().toISOString();
  const limits = EDITION_LIMITS[input.edition];
  const status = input.status ?? 'active';
  return {
    id: subId(),
    organizationId: input.organizationId,
    edition: input.edition,
    status,
    enabledModules: [],
    disabledModules: [],
    userLimit: input.userLimit ?? limits.userLimit,
    entityLimit: input.entityLimit ?? limits.entityLimit,
    startsAt: now,
    activationMethod: input.activationMethod ?? 'admin',
    adminNotes: input.adminNotes,
    createdAt: now,
    updatedAt: now,
    activatedAt: status === 'active' ? now : undefined,
  };
}

/**
 * The Enterprise development subscription assigned to pre-existing organizations
 * so that no already-implemented module disappears after entitlements ship.
 */
export function createEnterpriseDevelopmentSubscription(
  organizationId = 'primary',
  now = new Date().toISOString(),
): OrganizationSubscription {
  return {
    ...createSubscription({
      organizationId,
      edition: 'enterprise',
      status: 'active',
      activationMethod: 'admin',
      now,
    }),
    adminNotes:
      'Enterprise development subscription (auto-migrated existing organization).',
  };
}

/**
 * Migration rule: an existing local organization with no subscription becomes
 * an Enterprise development subscription. If a subscription already exists it is
 * returned untouched.
 */
export function migrateExistingOrganization(
  existing: OrganizationSubscription | null | undefined,
  organizationId = 'primary',
  now = new Date().toISOString(),
): OrganizationSubscription {
  if (existing) return existing;
  return createEnterpriseDevelopmentSubscription(organizationId, now);
}

/** True when a persisted value looks like a valid subscription object. */
export function isSubscriptionShape(
  value: unknown,
): value is OrganizationSubscription {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<OrganizationSubscription>;
  return (
    typeof v.edition === 'string' &&
    typeof v.status === 'string' &&
    Array.isArray(v.enabledModules) &&
    Array.isArray(v.disabledModules)
  );
}

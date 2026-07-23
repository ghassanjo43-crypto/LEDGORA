/**
 * Organization subscription model. Phase 1 supports manual activation after a
 * bank-remittance confirmation — there is no online card billing. Subscription
 * status gates NEW posting activity but never deletes or rewrites data.
 */
import type { LedgoraEdition, LedgoraModule } from './entitlements';

export type SubscriptionStatus =
  | 'trial'
  | 'active'
  | 'past-due'
  | 'suspended'
  | 'cancelled'
  | 'expired';

/** How a subscription reached its current active state. */
export type ActivationMethod = 'manual' | 'bank-remittance' | 'trial' | 'admin';

export interface OrganizationSubscription {
  id: string;
  organizationId: string;

  edition: LedgoraEdition;
  status: SubscriptionStatus;

  /** Explicit add-on modules enabled on top of the edition preset. */
  enabledModules: LedgoraModule[];
  /** Modules explicitly turned off even though the edition would include them. */
  disabledModules: LedgoraModule[];

  userLimit: number;
  entityLimit: number;

  startsAt: string;
  expiresAt?: string;

  activationMethod: ActivationMethod;

  bankRemittanceReference?: string;
  adminNotes?: string;

  createdAt: string;
  updatedAt: string;
  activatedAt?: string;
  suspendedAt?: string;
}

/** Kinds of entitlement/subscription events recorded on the audit trail. */
export type SubscriptionAuditEvent =
  | 'edition-selected'
  | 'subscription-activated'
  | 'subscription-renewed'
  | 'subscription-suspended'
  | 'subscription-status-changed'
  | 'module-enabled'
  | 'module-disabled'
  | 'limits-changed'
  | 'bank-remittance-recorded'
  | 'admin-override'
  | 'development-edition-switched'
  | 'organization-migrated';

export interface SubscriptionAuditEntry {
  id: string;
  event: SubscriptionAuditEvent;
  at: string;
  actor: string;
  detail: string;
  /**
   * Present when the action was performed by a platform operator inside a
   * subscriber workspace: identifies the authenticated administrator, the
   * organization acted on and the operator-view mode. Never set for actions by
   * the subscriber's own users.
   */
  operator?: import('@/lib/platformEntitlementOverride').OperatorAuditMetadata;
}

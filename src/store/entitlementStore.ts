/**
 * Central entitlement store — the single runtime source of truth for what the
 * active organization can access.
 *
 * Design notes:
 *  - `effectiveModuleIds` is stored as a concrete array in state and recomputed
 *    ONLY inside actions. Selectors return the stored array (stable reference)
 *    or a primitive (boolean). Never build a fresh Set/array in a selector —
 *    that would trigger React 18 useSyncExternalStore infinite loops.
 *  - Subscription status gates NEW posting but never module ownership, so a
 *    suspended organization keeps its data and navigation for owned modules.
 *  - Persisted under a NEW key (`ledgora-entitlements`) with a versioned
 *    migration; no existing store key is renamed.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { LedgoraEdition, LedgoraModule } from '@/types/entitlements';
import type {
  OrganizationSubscription,
  SubscriptionAuditEntry,
  SubscriptionAuditEvent,
  SubscriptionStatus,
} from '@/types/subscription';
import { EDITION_LIMITS } from '@/config/editions';
import { resolveEffectiveModules } from '@/lib/entitlementResolution';
import {
  createEnterpriseDevelopmentSubscription,
  isSubscriptionShape,
  migrateExistingOrganization,
} from '@/lib/entitlementMigration';
import { sortModules } from '@/config/editions';
import { operatorAuditContext, resolveAuditActor } from './platformFullAccess';

const ACTOR = 'Finance Manager';

function nowIso(): string {
  return new Date().toISOString();
}

function auditId(): string {
  return `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function audit(
  event: SubscriptionAuditEvent,
  detail: string,
): SubscriptionAuditEntry {
  // A platform operator acting inside a subscriber workspace is identified as
  // the administrator — audit never impersonates the subscriber.
  const operator = operatorAuditContext();
  return {
    id: auditId(),
    event,
    at: nowIso(),
    actor: resolveAuditActor(ACTOR),
    detail,
    ...(operator ? { operator } : {}),
  };
}

export interface EntitlementState {
  subscription: OrganizationSubscription;
  effectiveModuleIds: LedgoraModule[];
  auditTrail: SubscriptionAuditEntry[];

  /* Edition & status */
  setEdition: (edition: LedgoraEdition) => void;
  setSubscriptionStatus: (status: SubscriptionStatus) => void;

  /* Add-ons */
  enableModule: (module: LedgoraModule) => void;
  disableModule: (module: LedgoraModule) => void;

  /* Lifecycle */
  activateSubscription: (input?: {
    method?: OrganizationSubscription['activationMethod'];
    bankRemittanceReference?: string;
    adminNotes?: string;
  }) => void;
  suspendSubscription: (reason?: string) => void;
  renewSubscription: (expiresAt?: string) => void;
  extendExpiry: (expiresAt: string) => void;
  updateLimits: (limits: { userLimit?: number; entityLimit?: number }) => void;

  /* Reads */
  hasModule: (module: LedgoraModule) => boolean;

  /* Dev/testing */
  replaceSubscription: (subscription: OrganizationSubscription) => void;
  resetToDefault: () => void;
}

/** Recompute derived state and append an audit entry in one update. */
function withRecompute(
  subscription: OrganizationSubscription,
  auditTrail: SubscriptionAuditEntry[],
  entry?: SubscriptionAuditEntry,
): Pick<EntitlementState, 'subscription' | 'effectiveModuleIds' | 'auditTrail'> {
  const next: OrganizationSubscription = { ...subscription, updatedAt: nowIso() };
  return {
    subscription: next,
    effectiveModuleIds: resolveEffectiveModules(next),
    auditTrail: entry ? [...auditTrail, entry] : auditTrail,
  };
}

const initialSubscription = createEnterpriseDevelopmentSubscription();

export const useEntitlementStore = create<EntitlementState>()(
  persist(
    (set, get) => ({
      subscription: initialSubscription,
      effectiveModuleIds: resolveEffectiveModules(initialSubscription),
      auditTrail: [],

      setEdition: (edition) => {
        const { subscription, auditTrail } = get();
        const limits = EDITION_LIMITS[edition];
        // Keep explicit add-ons/disables but reset limits to the new edition's
        // defaults when they were still at the previous edition's defaults.
        const next: OrganizationSubscription = {
          ...subscription,
          edition,
          userLimit: limits.userLimit,
          entityLimit: limits.entityLimit,
        };
        set(
          withRecompute(
            next,
            auditTrail,
            audit('edition-selected', `Edition set to ${edition}.`),
          ),
        );
      },

      setSubscriptionStatus: (status) => {
        const { subscription, auditTrail } = get();
        const next: OrganizationSubscription = {
          ...subscription,
          status,
          suspendedAt:
            status === 'suspended' ? nowIso() : subscription.suspendedAt,
        };
        set(
          withRecompute(
            next,
            auditTrail,
            audit('subscription-status-changed', `Status set to ${status}.`),
          ),
        );
      },

      enableModule: (module) => {
        const { subscription, auditTrail } = get();
        const enabled = new Set(subscription.enabledModules);
        const disabled = new Set(subscription.disabledModules);
        enabled.add(module);
        disabled.delete(module); // enabling clears any explicit disable
        const next: OrganizationSubscription = {
          ...subscription,
          enabledModules: sortModules(enabled),
          disabledModules: sortModules(disabled),
        };
        set(
          withRecompute(
            next,
            auditTrail,
            audit('module-enabled', `Module enabled: ${module}.`),
          ),
        );
      },

      disableModule: (module) => {
        const { subscription, auditTrail } = get();
        const enabled = new Set(subscription.enabledModules);
        const disabled = new Set(subscription.disabledModules);
        enabled.delete(module); // remove any explicit add-on
        disabled.add(module);
        const next: OrganizationSubscription = {
          ...subscription,
          enabledModules: sortModules(enabled),
          disabledModules: sortModules(disabled),
        };
        set(
          withRecompute(
            next,
            auditTrail,
            audit('module-disabled', `Module disabled: ${module}.`),
          ),
        );
      },

      activateSubscription: (input) => {
        const { subscription, auditTrail } = get();
        const now = nowIso();
        const trail = [...auditTrail];
        if (input?.bankRemittanceReference) {
          trail.push(
            audit(
              'bank-remittance-recorded',
              `Bank remittance reference: ${input.bankRemittanceReference}.`,
            ),
          );
        }
        trail.push(audit('subscription-activated', 'Subscription activated.'));
        const next: OrganizationSubscription = {
          ...subscription,
          status: 'active',
          activatedAt: now,
          suspendedAt: undefined,
          activationMethod: input?.method ?? subscription.activationMethod,
          bankRemittanceReference:
            input?.bankRemittanceReference ?? subscription.bankRemittanceReference,
          adminNotes: input?.adminNotes ?? subscription.adminNotes,
        };
        set(withRecompute(next, trail));
      },

      suspendSubscription: (reason) => {
        const { subscription, auditTrail } = get();
        const next: OrganizationSubscription = {
          ...subscription,
          status: 'suspended',
          suspendedAt: nowIso(),
        };
        set(
          withRecompute(
            next,
            auditTrail,
            audit(
              'subscription-suspended',
              reason ? `Suspended: ${reason}.` : 'Subscription suspended.',
            ),
          ),
        );
      },

      renewSubscription: (expiresAt) => {
        const { subscription, auditTrail } = get();
        const next: OrganizationSubscription = {
          ...subscription,
          status: 'active',
          expiresAt: expiresAt ?? subscription.expiresAt,
          activatedAt: nowIso(),
          suspendedAt: undefined,
        };
        set(
          withRecompute(
            next,
            auditTrail,
            audit('subscription-renewed', 'Subscription renewed.'),
          ),
        );
      },

      extendExpiry: (expiresAt) => {
        const { subscription, auditTrail } = get();
        const next: OrganizationSubscription = { ...subscription, expiresAt };
        set(
          withRecompute(
            next,
            auditTrail,
            audit('limits-changed', `Expiry extended to ${expiresAt}.`),
          ),
        );
      },

      updateLimits: (limits) => {
        const { subscription, auditTrail } = get();
        const next: OrganizationSubscription = {
          ...subscription,
          userLimit: limits.userLimit ?? subscription.userLimit,
          entityLimit: limits.entityLimit ?? subscription.entityLimit,
        };
        set(
          withRecompute(
            next,
            auditTrail,
            audit(
              'limits-changed',
              `Limits updated (users ${next.userLimit}, entities ${next.entityLimit}).`,
            ),
          ),
        );
      },

      hasModule: (module) => get().effectiveModuleIds.includes(module),

      replaceSubscription: (subscription) => {
        set(withRecompute(subscription, get().auditTrail));
      },

      resetToDefault: () => {
        const fresh = createEnterpriseDevelopmentSubscription();
        set({
          subscription: fresh,
          effectiveModuleIds: resolveEffectiveModules(fresh),
          auditTrail: [],
        });
      },
    }),
    {
      name: 'ledgora-entitlements',
      version: 1,
      partialize: (s) => ({
        subscription: s.subscription,
        auditTrail: s.auditTrail,
      }),
      // Versioned migration: tolerate legacy/absent shapes. An organization with
      // no valid subscription is migrated to Enterprise development so no
      // existing module disappears.
      migrate: (persisted, _version) => {
        const p = (persisted ?? {}) as Partial<EntitlementState>;
        const subscription = isSubscriptionShape(p.subscription)
          ? p.subscription
          : migrateExistingOrganization(null);
        const auditTrail: SubscriptionAuditEntry[] = Array.isArray(p.auditTrail)
          ? p.auditTrail
          : [];
        return { subscription, auditTrail };
      },
      // On hydration, always recompute derived module ids from the persisted
      // subscription and backfill a subscription for pre-entitlement stores.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<EntitlementState>;
        const subscription = isSubscriptionShape(p.subscription)
          ? p.subscription
          : migrateExistingOrganization(current.subscription ?? null);
        return {
          ...current,
          ...p,
          subscription,
          effectiveModuleIds: resolveEffectiveModules(subscription),
          auditTrail: Array.isArray(p.auditTrail) ? p.auditTrail : [],
        };
      },
    },
  ),
);

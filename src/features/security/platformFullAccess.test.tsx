// @vitest-environment happy-dom
/**
 * Platform-administrator full feature access while viewing a subscriber
 * workspace — the entitlement-override contract.
 *
 * A backend-verified super_admin in operator subscriber-view mode gets EVERY
 * Ledgora edition/module/page through ONE central resolver
 * (`lib/platformEntitlementOverride` via `store/entitlementHooks`), while the
 * subscriber's stored subscription — plan, edition, modules, limits, billing —
 * is never modified, tenant scoping still applies, and nothing a non-admin can
 * write into browser storage activates the override.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  FULL_ACCESS_MODULE_IDS,
  resolvePlatformEntitlementOverride,
} from '@/lib/platformEntitlementOverride';
import {
  getPlatformEntitlementOverride,
  isPlatformAdminFullAccess,
  operatorAuditContext,
  resolveAuditActor,
} from '@/store/platformFullAccess';
import { getEffectiveModuleIds, orgHasModule } from '@/store/entitlementHooks';
import { canAccessFeature } from '@/lib/entitlementResolution';
import { canAccessView, filterNavigationByEntitlements, VIEW_MODULE_REQUIREMENTS } from '@/config/navigation';
import { ALL_EDITIONS, EDITION_MODULES } from '@/config/editions';
import { apiGuard } from '@/lib/accessControl';
import { FeatureGate } from '@/components/entitlements/FeatureGate';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useOperatorViewStore } from '@/store/operatorViewStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useSessionStore } from '@/store/sessionStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useAuthStore } from '@/store/authStore';
import { useBillingStore } from '@/store/billingStore';
import { useMeteringConfigStore } from '@/store/meteringConfigStore';
import { clearWorkspaceForSignOut } from '@/lib/freeDemoSession';
import type { BackendUser } from '@/services/api/authApi';

/** A backend-verified super_admin session (the production trust path). */
const ADMIN: BackendUser = {
  id: 'usr_admin_1',
  email: 'admin@ledgora.com',
  fullName: 'Platform Admin',
  status: 'active',
  emailVerified: true,
  mustChangePassword: false,
  platformRoles: ['super_admin'],
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function verifyAdminWithBackend(): void {
  useBackendSessionStore.setState({ status: 'ready', user: ADMIN, platformRoles: ['super_admin'], error: null });
}

/** Seed the retained active tenant and downgrade it to a Projects package. */
function seedProjectsTenant(): { orgId: string } {
  useAuthStore.getState().resetToDefault();
  useOrganizationStore.getState().resetToDefault();
  useBillingStore.getState().ensureSeeded();
  useMeteringConfigStore.getState().resetToDefault();
  useOrganizationStore.getState().ensureBootstrapped();
  const orgId = useOrganizationStore.getState().organization!.id;

  const ent = useEntitlementStore.getState();
  ent.replaceSubscription({
    ...ent.subscription,
    edition: 'projects',
    status: 'active',
    enabledModules: [],
    disabledModules: [],
  });
  return { orgId };
}

/** Enter operator viewing mode for the active tenant. */
function enterOperatorView(orgId: string): void {
  useOperatorViewStore.getState().enter({ organizationId: orgId, orgName: 'Acme Holdings Ltd.' });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useSessionStore.setState({ platformRole: 'none', userName: 'Visitor' });
  useBackendSessionStore.setState({ status: 'unknown', user: null, platformRoles: [], error: null });
  useOperatorViewStore.getState().exit();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  useOperatorViewStore.getState().exit();
});

/* ── The central resolver (pure) ─────────────────────────────────────────── */

describe('resolvePlatformEntitlementOverride', () => {
  const base = {
    platformRole: 'super-admin' as const,
    operatorViewActive: true,
    viewAsSubscriber: false,
    viewedOrganizationId: 'org1',
    activeOrganizationId: 'org1',
  };

  it('grants full access only to a super-admin in active viewing mode', () => {
    expect(resolvePlatformEntitlementOverride(base)).toBe('full_access');
    expect(resolvePlatformEntitlementOverride({ ...base, platformRole: 'none' })).toBe('none');
    expect(resolvePlatformEntitlementOverride({ ...base, platformRole: 'support' })).toBe('none');
    expect(resolvePlatformEntitlementOverride({ ...base, platformRole: 'billing-admin' })).toBe('none');
    expect(resolvePlatformEntitlementOverride({ ...base, operatorViewActive: false })).toBe('none');
  });

  it('fails closed when the viewed organization does not match the loaded one', () => {
    expect(resolvePlatformEntitlementOverride({ ...base, activeOrganizationId: 'org2' })).toBe('none');
    expect(resolvePlatformEntitlementOverride({ ...base, activeOrganizationId: null })).toBe('none');
  });

  it('"view exactly as subscriber" applies the real package instead', () => {
    expect(resolvePlatformEntitlementOverride({ ...base, viewAsSubscriber: true })).toBe('subscriber_view');
  });
});

/* ── Full access across every edition and module ─────────────────────────── */

describe('super_admin in operator mode', () => {
  it('can open Settings and every module despite a Projects package', () => {
    const { orgId } = seedProjectsTenant();
    verifyAdminWithBackend();

    // Before viewing: the workspace resolves the Projects package.
    expect(canAccessFeature(getEffectiveModuleIds(), { requiredModule: 'manufacturing_core' })).toBe(false);

    enterOperatorView(orgId);
    expect(getPlatformEntitlementOverride()).toBe('full_access');

    const ids = getEffectiveModuleIds();
    expect(canAccessView(ids, 'settings')).toBe(true);
    expect(canAccessView(ids, 'subscription')).toBe(true);
    expect(canAccessView(ids, 'members')).toBe(true);
    // Accounting, sales/purchasing, reporting, inventory, projects,
    // construction, manufacturing and administration-support modules.
    for (const m of [
      'core_accounting', 'sales', 'purchases', 'advanced_reporting',
      'inventory_basic', 'projects', 'construction_projects',
      'manufacturing_core', 'multi_entity', 'audit_admin',
    ] as const) {
      expect(orgHasModule(m)).toBe(true);
    }
  });

  it('covers Core, Projects, Construction, Manufacturing and Enterprise editions', () => {
    for (const edition of ALL_EDITIONS) {
      for (const m of EDITION_MODULES[edition]) {
        expect(FULL_ACCESS_MODULE_IDS).toContain(m);
      }
    }
  });

  it('sidebar, routes and feature gates share the same centralized result', () => {
    const { orgId } = seedProjectsTenant();
    verifyAdminWithBackend();
    enterOperatorView(orgId);

    const ids = getEffectiveModuleIds();
    // Sidebar navigation: every group survives filtering.
    const groups = filterNavigationByEntitlements(ids);
    expect(groups.some((g) => g.label === 'Manufacturing')).toBe(true);
    expect(groups.some((g) => g.label === 'Inventory')).toBe(true);
    // Route guard: every registered view requirement passes.
    for (const view of Object.keys(VIEW_MODULE_REQUIREMENTS)) {
      expect(canAccessView(ids, view as never)).toBe(true);
    }
    // Feature gate component: renders gated children through the same hooks.
    render(
      <FeatureGate module="manufacturing_core" fallback={<span>locked</span>}>
        <span>manufacturing-visible</span>
      </FeatureGate>,
    );
    expect(screen.getByText('manufacturing-visible')).toBeTruthy();
    expect(screen.queryByText('locked')).toBeNull();
  });

  it('modelled backend guard honours only a server-resolved override', () => {
    expect(apiGuard({ subscriptionStatus: 'active', resource: 'manufacturing', hasEntitlement: false, platformOverride: 'full_access' }).ok).toBe(true);
    expect(apiGuard({ subscriptionStatus: 'active', resource: 'manufacturing', hasEntitlement: false, platformOverride: 'none' }).ok).toBe(false);
    expect(apiGuard({ subscriptionStatus: 'active', resource: 'manufacturing', hasEntitlement: false }).ok).toBe(false);
  });
});

/* ── The subscriber's subscription is never modified ─────────────────────── */

describe('subscriber subscription integrity', () => {
  it('entering, using and leaving operator mode leaves the stored subscription untouched', () => {
    const { orgId } = seedProjectsTenant();
    verifyAdminWithBackend();
    const before = JSON.stringify(useEntitlementStore.getState().subscription);
    const ownedBefore = useEntitlementStore.getState().effectiveModuleIds;

    enterOperatorView(orgId);
    void getEffectiveModuleIds();
    expect(orgHasModule('manufacturing_core')).toBe(true);

    // Stored subscription (plan, edition, modules, limits) is bit-identical.
    expect(JSON.stringify(useEntitlementStore.getState().subscription)).toBe(before);
    expect(useEntitlementStore.getState().subscription.edition).toBe('projects');
    // The stored owned-module set never changed either — the override widens
    // only the value the hooks serve.
    expect(useEntitlementStore.getState().effectiveModuleIds).toBe(ownedBefore);
  });

  it('leaving operator mode restores the normal package restrictions', () => {
    const { orgId } = seedProjectsTenant();
    verifyAdminWithBackend();
    enterOperatorView(orgId);
    expect(orgHasModule('manufacturing_core')).toBe(true);

    useOperatorViewStore.getState().exit();
    expect(getPlatformEntitlementOverride()).toBe('none');
    expect(orgHasModule('manufacturing_core')).toBe(false);
  });

  it('"view exactly as subscriber" applies the real package, and is reversible', () => {
    const { orgId } = seedProjectsTenant();
    verifyAdminWithBackend();
    enterOperatorView(orgId);

    useOperatorViewStore.getState().setViewAsSubscriber(true);
    expect(getPlatformEntitlementOverride()).toBe('subscriber_view');
    expect(orgHasModule('manufacturing_core')).toBe(false);
    expect(orgHasModule('projects')).toBe(true); // their real package

    useOperatorViewStore.getState().setViewAsSubscriber(false);
    expect(orgHasModule('manufacturing_core')).toBe(true);
  });

  it('sign-out clears full-access mode', () => {
    const { orgId } = seedProjectsTenant();
    verifyAdminWithBackend();
    enterOperatorView(orgId);
    expect(isPlatformAdminFullAccess()).toBe(true);

    clearWorkspaceForSignOut();
    expect(isPlatformAdminFullAccess()).toBe(false);
    expect(useOperatorViewStore.getState().active).toBe(false);
  });
});

/* ── Trust boundary ──────────────────────────────────────────────────────── */

describe('trust boundary', () => {
  it('a normal Projects subscriber remains blocked from excluded modules', () => {
    seedProjectsTenant();
    // No platform role of any kind.
    const ids = getEffectiveModuleIds();
    expect(canAccessFeature(ids, { requiredModule: 'manufacturing_core' })).toBe(false);
    expect(canAccessFeature(ids, { requiredModule: 'construction_projects' })).toBe(false);
    expect(canAccessFeature(ids, { requiredModule: 'projects' })).toBe(true);
  });

  it('a non-admin cannot activate the override through sessionStorage', () => {
    const { orgId } = seedProjectsTenant();
    // A tenant plants the operator-view payload AND flips the store flag.
    sessionStorage.setItem(
      'ledgora-operator-view',
      JSON.stringify({ state: { active: true, viewAsSubscriber: false, organizationId: orgId }, version: 0 }),
    );
    useOperatorViewStore.getState().enter({ organizationId: orgId });

    // With no verified (or simulated) role, the override stays off.
    expect(getPlatformEntitlementOverride()).toBe('none');
    expect(orgHasModule('manufacturing_core')).toBe(false);
  });

  it('the override stays scoped to the selected organization', () => {
    seedProjectsTenant();
    verifyAdminWithBackend();
    // Viewing context names a DIFFERENT organization than the loaded one.
    useOperatorViewStore.getState().enter({ organizationId: 'org_other_tenant' });
    expect(getPlatformEntitlementOverride()).toBe('none');
    expect(orgHasModule('manufacturing_core')).toBe(false);
  });
});

/* ── Usage limits & audit ────────────────────────────────────────────────── */

describe('usage limits under operator full access', () => {
  it('does not block the administrator at the seat limit, without raising the allowance', () => {
    const { orgId } = seedProjectsTenant();
    verifyAdminWithBackend();

    // Shrink the limit to the seats already used so the org is exactly full.
    const org = useOrganizationStore.getState().organization!;
    const seatsUsed = useAuthStore.getState().users.filter((u) => u.organizationId === org.id && u.status !== 'suspended').length;
    useEntitlementStore.getState().updateLimits({ userLimit: seatsUsed });

    // The subscriber themselves is blocked.
    const blocked = useAuthStore.getState().inviteMember({ fullName: 'One Too Many', email: 'extra@acme.com', role: 'accountant' });
    expect(blocked.ok).toBe(false);

    // The operator is not blocked — but the recorded allowance is unchanged,
    // so the workspace keeps showing its real over-limit warning state.
    enterOperatorView(orgId);
    const allowed = useAuthStore.getState().inviteMember({ fullName: 'Support Added', email: 'support-added@acme.com', role: 'accountant' });
    expect(allowed.ok).toBe(true);
    expect(useEntitlementStore.getState().subscription.userLimit).toBe(seatsUsed);
  });
});

describe('operator audit attribution', () => {
  it('identifies the administrator, the organization and the mode — never the subscriber', () => {
    const { orgId } = seedProjectsTenant();
    verifyAdminWithBackend();
    enterOperatorView(orgId);

    const ctx = operatorAuditContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.operatorUserId).toBe('usr_admin_1');
    expect(ctx!.operatorEmail).toBe('admin@ledgora.com');
    expect(ctx!.organizationId).toBe(orgId);
    expect(ctx!.operatorViewMode).toBe('full_access');
    expect(ctx!.at).toBeTruthy();

    expect(resolveAuditActor('Finance Manager')).toContain('admin@ledgora.com');
    expect(resolveAuditActor('Finance Manager')).not.toBe('Finance Manager');
  });

  it('audit entries written during operator mode carry the operator metadata', () => {
    const { orgId } = seedProjectsTenant();
    verifyAdminWithBackend();
    enterOperatorView(orgId);

    useEntitlementStore.getState().extendExpiry('2027-01-01');
    const entry = useEntitlementStore.getState().auditTrail.at(-1)!;
    expect(entry.actor).toContain('Platform administrator');
    expect(entry.operator?.operatorUserId).toBe('usr_admin_1');
    expect(entry.operator?.organizationId).toBe(orgId);
    expect(entry.operator?.operatorViewMode).toBe('full_access');
  });

  it('outside operator mode, audit keeps the normal actor and no metadata', () => {
    seedProjectsTenant();
    useEntitlementStore.getState().extendExpiry('2027-01-01');
    const entry = useEntitlementStore.getState().auditTrail.at(-1)!;
    expect(entry.actor).toBe('Finance Manager');
    expect(entry.operator).toBeUndefined();
  });
});

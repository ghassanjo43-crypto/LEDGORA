import { describe, it, expect } from 'vitest';
import {
  ROUTES,
  apiGuard,
  assertApiAccess,
  ForbiddenError,
  isPathAllowed,
  resolveEntitlementActivation,
  resolvePostLoginRoute,
  surfaceOf,
  type AccessContext,
} from './accessControl';

const verified = { emailVerified: true };

/* ── Post-login redirect state machine ────────────────────────────────────── */

describe('resolvePostLoginRoute', () => {
  const base: AccessContext = { user: verified, hasOrganization: true, subscriptionStatus: 'active' };

  it('sends an unauthenticated visitor to the public welcome page', () => {
    expect(resolvePostLoginRoute({ user: null, hasOrganization: false, subscriptionStatus: null })).toBe(ROUTES.welcome);
  });

  it('sends a Free Demo visitor to the application', () => {
    expect(
      resolvePostLoginRoute({ user: null, hasOrganization: false, subscriptionStatus: null, demoActive: true }),
    ).toBe(ROUTES.appDashboard);
  });

  it('routes each stage exactly as specified', () => {
    expect(resolvePostLoginRoute({ user: { emailVerified: false }, hasOrganization: false, subscriptionStatus: null })).toBe(ROUTES.verifyEmail);
    expect(resolvePostLoginRoute({ user: verified, hasOrganization: false, subscriptionStatus: null })).toBe(ROUTES.onboardingOrganization);
    expect(resolvePostLoginRoute({ user: verified, hasOrganization: true, subscriptionStatus: null })).toBe(ROUTES.onboardingSubscription);
    expect(resolvePostLoginRoute({ ...base, subscriptionStatus: 'draft' })).toBe(ROUTES.onboardingSubscription);
    expect(resolvePostLoginRoute({ ...base, subscriptionStatus: 'pending_payment' })).toBe(ROUTES.billingPayment);
    expect(resolvePostLoginRoute({ ...base, subscriptionStatus: 'pending_verification' })).toBe(ROUTES.subscriptionStatus);
    expect(resolvePostLoginRoute({ ...base, subscriptionStatus: 'active' })).toBe(ROUTES.appDashboard);
    expect(resolvePostLoginRoute({ ...base, subscriptionStatus: 'expired' })).toBe(ROUTES.billingRenew);
    expect(resolvePostLoginRoute({ ...base, subscriptionStatus: 'suspended' })).toBe(ROUTES.subscriptionSuspended);
    expect(resolvePostLoginRoute({ ...base, subscriptionStatus: 'rejected' })).toBe(ROUTES.billingPayment);
  });
});

/* ── Surface classification + route policy ────────────────────────────────── */

describe('surface policy', () => {
  it('classifies paths into surfaces', () => {
    expect(surfaceOf('/app/dashboard')).toBe('app');
    expect(surfaceOf('/admin/payments')).toBe('admin');
    expect(surfaceOf('/onboarding/subscription')).toBe('onboarding');
    expect(surfaceOf('/billing/payment')).toBe('billing');
    expect(surfaceOf('/subscription/status')).toBe('subscription-status');
    expect(surfaceOf('/pricing')).toBe('public');
  });

  it('blocks the app for a pending subscription but allows onboarding/billing/support', () => {
    const pending: AccessContext = { user: verified, hasOrganization: true, subscriptionStatus: 'pending_verification' };
    expect(isPathAllowed(pending, '/app/dashboard')).toBe(false);
    expect(isPathAllowed(pending, '/app/invoices')).toBe(false);
    expect(isPathAllowed(pending, ROUTES.billingPayment)).toBe(true);
    expect(isPathAllowed(pending, ROUTES.subscriptionStatus)).toBe(true);
    expect(isPathAllowed(pending, ROUTES.profile)).toBe(true);
    expect(isPathAllowed(pending, ROUTES.support)).toBe(true);
  });

  it('opens the whole app once active', () => {
    const active: AccessContext = { user: verified, hasOrganization: true, subscriptionStatus: 'active' };
    expect(isPathAllowed(active, '/app/dashboard')).toBe(true);
    expect(isPathAllowed(active, '/app/reports')).toBe(true);
  });
});

/* ── Backend API guard (controlled 403) ───────────────────────────────────── */

describe('apiGuard', () => {
  it('returns 403 subscription_inactive when not active', () => {
    const res = apiGuard({ subscriptionStatus: 'pending_verification', resource: 'accounting', hasEntitlement: true });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ status: 403, code: 'subscription_inactive' });
  });

  it('returns 403 module_not_entitled when active but not entitled', () => {
    const res = apiGuard({ subscriptionStatus: 'active', resource: 'construction', hasEntitlement: false });
    expect(res).toMatchObject({ status: 403, code: 'module_not_entitled' });
  });

  it('allows an active, entitled request', () => {
    expect(apiGuard({ subscriptionStatus: 'active', resource: 'accounting', hasEntitlement: true })).toEqual({ ok: true, status: 200 });
  });

  it('assertApiAccess throws a 403 ForbiddenError when refused', () => {
    expect(() => assertApiAccess({ subscriptionStatus: null, resource: 'reports', hasEntitlement: true })).toThrow(ForbiddenError);
    try {
      assertApiAccess({ subscriptionStatus: 'expired', resource: 'reports', hasEntitlement: true });
    } catch (e) {
      expect((e as ForbiddenError).status).toBe(403);
      expect((e as ForbiddenError).code).toBe('subscription_inactive');
    }
  });
});

/* ── Plan/add-on → entitlement mapping ────────────────────────────────────── */

describe('resolveEntitlementActivation', () => {
  it('maps base allowances + extras to limits and enables add-on modules', () => {
    const act = resolveEntitlementActivation({
      baseUsers: 10,
      baseCompanies: 3,
      addOnModuleCodes: ['projects', 'consolidation'],
      extraUsers: 2,
      extraCompanies: 1,
    });
    expect(act.edition).toBe('core');
    expect(act.userLimit).toBe(12);
    expect(act.entityLimit).toBe(4);
    expect(act.enabledModules).toContain('projects');
    expect(act.enabledModules).toContain('multi_entity');
  });

  it('treats AI as a metered feature (no gate-able module)', () => {
    const act = resolveEntitlementActivation({ baseUsers: 3, baseCompanies: 1, addOnModuleCodes: ['ai'], extraUsers: 0, extraCompanies: 0 });
    expect(act.enabledModules).toEqual([]);
  });
});

/**
 * The platform operator and the subscriber are different applications.
 *
 * ══ What this suite protects ═════════════════════════════════════════════════
 *
 * A Ledgora operator runs the SaaS. They have no organization, no package, no
 * subscription and no books, and they must never land on — or be able to reach —
 * a subscriber's bookkeeping workspace except through the deliberate support
 * flow. A subscriber, equally, must never reach the platform console.
 *
 * The separation is enforced in `lib/accessControl`, which is a set of pure
 * functions over an `AccessContext`. That is what makes it testable here without
 * a browser: these tests exercise the DECISIONS, and the shell tests exercise the
 * rendering that follows from them.
 *
 * ══ Why the landing rule is stated as an ORDER ═══════════════════════════════
 *
 * `resolvePostLoginRoute` resolves the operator BEFORE any customer state. That
 * ordering is the fix for a real production defect: evaluating the customer
 * funnel first sent an operator — who has no subscription — into package
 * selection. Several tests below pin the ordering rather than only the outcome,
 * because the outcome is right for the wrong reason if the order is lost.
 */
import { describe, it, expect } from 'vitest';
import {
  ROUTES,
  isPathAllowed,
  operatorLandingRoute,
  requiredAdminCapability,
  resolvePostLoginRoute,
  surfaceOf,
  type AccessContext,
} from '@/lib/accessControl';
import { platformRoleHasCapability } from '@/types/roles';

/** A signed-in, verified identity — the part every context below shares. */
const USER = { emailVerified: true };

/** A Ledgora operator: no organization, no subscription, no books. */
function superAdmin(overrides: Partial<AccessContext> = {}): AccessContext {
  return {
    user: USER,
    hasOrganization: false,
    subscriptionStatus: null,
    platformRole: 'super-admin',
    operatorViewing: false,
    demoActive: false,
    mustChangePassword: false,
    ...overrides,
  } as AccessContext;
}

/** A paying customer: an organization with an active subscription. */
function subscriber(overrides: Partial<AccessContext> = {}): AccessContext {
  return {
    user: USER,
    hasOrganization: true,
    subscriptionStatus: 'active',
    platformRole: 'none',
    operatorViewing: false,
    demoActive: false,
    mustChangePassword: false,
    ...overrides,
  } as AccessContext;
}

/* ══ 1–2 · Where a Super Admin lands ═══════════════════════════════════════ */

describe('Super Admin landing', () => {
  it('lands on the platform console, never the bookkeeping dashboard', () => {
    expect(resolvePostLoginRoute(superAdmin())).toBe(ROUTES.adminConsole);
    expect(resolvePostLoginRoute(superAdmin())).not.toBe(ROUTES.appDashboard);
  });

  it('lands there even though they have no organization or subscription', () => {
    /*
     * The ordering that matters. An operator has neither, so a resolver that
     * evaluated the customer funnel first would send them to onboarding or
     * package selection — the production defect this ordering prevents.
     */
    const landing = resolvePostLoginRoute(superAdmin({ hasOrganization: false, subscriptionStatus: null }));
    expect(landing).toBe(ROUTES.adminConsole);
    expect(landing).not.toBe(ROUTES.onboardingOrganization);
    expect(landing).not.toBe(ROUTES.onboardingSubscription);
  });

  it('sends a super admin holding manage-any-organization to the console', () => {
    expect(platformRoleHasCapability('super-admin', 'manage-any-organization')).toBe(true);
    expect(operatorLandingRoute('super-admin')).toBe(ROUTES.adminConsole);
  });

  it('still puts a forced password change ahead of the console', () => {
    // A bootstrap credential typed into a deploy dashboard must not stay usable
    // just because it opened an administration surface.
    expect(resolvePostLoginRoute(superAdmin({ mustChangePassword: true }))).toBe(ROUTES.changePassword);
  });
});

/* ══ 4 · The subscriber experience is untouched ════════════════════════════ */

describe('subscriber landing', () => {
  it('an active subscriber still lands on the bookkeeping dashboard', () => {
    expect(resolvePostLoginRoute(subscriber())).toBe(ROUTES.appDashboard);
  });

  it('an organization owner/admin is NOT treated as a platform operator', () => {
    /*
     * Different authorities entirely. Organization role lives in the tenant;
     * `platformRole` is the Ledgora staff role, and only the latter opens the
     * console.
     */
    const orgAdmin = subscriber({ platformRole: 'none' });
    expect(resolvePostLoginRoute(orgAdmin)).toBe(ROUTES.appDashboard);
    expect(isPathAllowed(orgAdmin, ROUTES.adminConsole)).toBe(false);
  });

  it('keeps the whole bookkeeping surface open to a subscriber', () => {
    for (const path of [ROUTES.appDashboard, `${ROUTES.appDashboard}/anything`]) {
      expect(isPathAllowed(subscriber(), path), path).toBe(true);
    }
  });
});

/* ══ 6, 18 · The bookkeeping dashboard is closed to an operator ════════════ */

describe('bookkeeping is closed to a platform operator', () => {
  it('refuses the application surface outside support mode', () => {
    expect(isPathAllowed(superAdmin(), ROUTES.appDashboard)).toBe(false);
  });

  it('cannot be bypassed by typing a deeper application path', () => {
    /*
     * The check is on the SURFACE, not on a list of known paths, so inventing a
     * route does not get round it. This is what makes the protection more than a
     * hidden sidebar link.
     */
    for (const path of [
      ROUTES.appDashboard,
      `${ROUTES.appDashboard}/general-journal`,
      `${ROUTES.appDashboard}/../app/trial-balance`,
      '/app/anything/at/all',
    ]) {
      expect(surfaceOf(path), path).toBe('app');
      expect(isPathAllowed(superAdmin(), path), path).toBe(false);
    }
  });

  it('redirects a refused operator back to the console, not into onboarding', () => {
    // Where they are sent matters as much as being refused: bouncing them into
    // the customer funnel was the original defect.
    expect(resolvePostLoginRoute(superAdmin())).toBe(ROUTES.adminConsole);
  });
});

/* ══ 5 · No tenant context for a normal operator ═══════════════════════════ */

describe('a platform operator is tenantless', () => {
  it('needs no organization and no subscription to use the console', () => {
    const ctx = superAdmin({ hasOrganization: false, subscriptionStatus: null });
    expect(isPathAllowed(ctx, ROUTES.adminConsole)).toBe(true);
  });

  it('is not helped, or harmed, by having one attached', () => {
    // Administration is decided by the verified capability alone. An operator
    // who happens to have an organization is still an operator.
    const withOrg = superAdmin({ hasOrganization: true, subscriptionStatus: 'active' });
    expect(isPathAllowed(withOrg, ROUTES.adminConsole)).toBe(true);
    // …and the application is still refused outside support mode.
    expect(isPathAllowed(withOrg, ROUTES.appDashboard)).toBe(false);
  });
});

/* ══ 7–8, 10–11 · Deliberate subscriber support mode ═══════════════════════ */

describe('subscriber support mode', () => {
  const viewing = superAdmin({ operatorViewing: true });

  it('opens the application for an operator who has explicitly entered it', () => {
    expect(isPathAllowed(viewing, ROUTES.appDashboard)).toBe(true);
  });

  it('lands them on the workspace rather than bouncing back to the console', () => {
    // Without this the shell would fight the operator: enter support mode, get
    // sent straight back to /admin/console.
    expect(resolvePostLoginRoute(viewing)).toBe(ROUTES.appDashboard);
  });

  it('does not change the platform role', () => {
    // Support mode is a session-scoped VIEW, not a demotion. The operator is
    // still a super-admin throughout, which is why exiting can return them to
    // the console.
    expect(viewing.platformRole).toBe('super-admin');
    expect(isPathAllowed(viewing, ROUTES.adminConsole)).toBe(true);
  });

  it('returns to the console the moment support mode ends', () => {
    const exited = superAdmin({ operatorViewing: false });
    expect(resolvePostLoginRoute(exited)).toBe(ROUTES.adminConsole);
    expect(isPathAllowed(exited, ROUTES.appDashboard)).toBe(false);
  });

  it('does not let a mere flag open administration for a non-operator', () => {
    /*
     * The flag is not authority. A subscriber whose browser sets
     * `operatorViewing` gains nothing: the console is gated on the verified
     * platform capability, which they do not hold.
     */
    const forged = subscriber({ operatorViewing: true });
    expect(isPathAllowed(forged, ROUTES.adminConsole)).toBe(false);
  });
});

/* ══ 12–14 · Who may not reach the console ═════════════════════════════════ */

describe('the console is closed to every non-operator', () => {
  const outsiders: Array<[string, AccessContext]> = [
    ['an active subscriber', subscriber()],
    ['an organization admin', subscriber({ platformRole: 'none' })],
    ['an ordinary member', subscriber({ platformRole: 'none', subscriptionStatus: 'active' })],
    ['a subscriber with no subscription', subscriber({ subscriptionStatus: null })],
    ['a Free Demo visitor', { ...subscriber(), demoActive: true, platformRole: 'none' } as AccessContext],
  ];

  it.each(outsiders)('refuses the console to %s', (_label, ctx) => {
    expect(isPathAllowed(ctx, ROUTES.adminConsole)).toBe(false);
  });

  it('refuses every administration path, not only the console', () => {
    for (const path of [ROUTES.adminConsole, ROUTES.adminPayments, '/admin/anything-new']) {
      expect(isPathAllowed(subscriber(), path), path).toBe(false);
    }
  });

  it('refuses a demo visitor even if a platform role is somehow present', () => {
    // A demo is never an operator, whatever else the context claims.
    const demoWithRole = superAdmin({ demoActive: true });
    expect(isPathAllowed(demoWithRole, ROUTES.adminConsole)).toBe(false);
  });
});

/* ══ 15 · Capability checks are preserved ══════════════════════════════════ */

describe('administration capabilities', () => {
  it('demands the strongest capability for an unclassified admin path', () => {
    /*
     * A new `/admin/*` route is unreachable until it is classified, rather than
     * defaulting to the weakest requirement and being open by accident.
     */
    const capability = requiredAdminCapability('/admin/something-added-later');
    expect(platformRoleHasCapability('support', capability)).toBe(false);
    expect(platformRoleHasCapability('super-admin', capability)).toBe(true);
  });

  it('lets a billing admin reach payments but not the whole console', () => {
    const billing = superAdmin({ platformRole: 'billing-admin' });
    expect(isPathAllowed(billing, ROUTES.adminPayments)).toBe(true);
    expect(isPathAllowed(billing, ROUTES.adminConsole)).toBe(false);
    // …and they land where they can actually work.
    expect(operatorLandingRoute('billing-admin')).toBe(ROUTES.adminPayments);
  });

  it('keeps a support operator out of the customer funnel', () => {
    // Non-'none' but without a dedicated surface: still administration, never
    // package selection.
    expect(operatorLandingRoute('support')).toBe(ROUTES.adminConsole);
  });
});

/* ══ 3 · No flash: the decision needs no rendering ═════════════════════════ */

describe('resolving without rendering', () => {
  it('decides the landing from context alone, before any surface is drawn', () => {
    /*
     * These are pure functions of the context, so the shell can hold the paint
     * until the server has answered and then route once. Nothing here consults a
     * store, a URL or a rendered component — which is what makes "resolve first,
     * paint second" possible and the bookkeeping flash impossible.
     */
    expect(resolvePostLoginRoute(superAdmin())).toBe(ROUTES.adminConsole);
    expect(resolvePostLoginRoute(subscriber())).toBe(ROUTES.appDashboard);
  });
});

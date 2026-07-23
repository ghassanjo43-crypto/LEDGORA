// @vitest-environment happy-dom
/**
 * Operator "subscriber view" mode — the routing/trust contract.
 *
 * A platform super-admin can step into the subscriber application WITHOUT
 * ceasing to be an operator, and the shell must not immediately bounce them back
 * to /admin/console. The mode is session-scoped and grants nothing to anyone who
 * is not already a verified operator.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isPathAllowed, resolvePostLoginRoute, ROUTES, type AccessContext } from '@/lib/accessControl';
import { readAccessContext } from '@/lib/accessContext';
import { useOperatorViewStore } from '@/store/operatorViewStore';
import { useSessionStore } from '@/store/sessionStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { useAuthStore } from '@/store/authStore';
import { useOrganizationStore } from '@/store/organizationStore';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { clearWorkspaceForSignOut } from '@/lib/freeDemoSession';

/** A verified operator with no tenant of their own. */
const operator = (over: Partial<AccessContext> = {}): AccessContext => ({
  user: { emailVerified: true },
  hasOrganization: false,
  subscriptionStatus: null,
  platformRole: 'super-admin',
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useSessionStore.setState({ platformRole: 'none', userName: 'Visitor' });
  useBackendSessionStore.getState().clear();
  useAuthStore.setState({ users: [], currentUserId: null });
  useOrganizationStore.setState({ organization: null, subscription: null });
  useAccountSessionStore.setState({ demoActive: false });
  useOperatorViewStore.getState().exit();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  useOperatorViewStore.getState().exit();
});

describe('entering subscriber-view mode', () => {
  it('records the mode and the viewed organization context', () => {
    useOperatorViewStore.getState().enter({ organizationId: 'org1', ownerUserId: 'u1', orgName: 'Acme' });
    const s = useOperatorViewStore.getState();
    expect(s.active).toBe(true);
    expect(s.organizationId).toBe('org1');
    expect(s.ownerUserId).toBe('u1');
    expect(s.orgName).toBe('Acme');
  });

  it('is session-scoped, never a permanent localStorage override', () => {
    useOperatorViewStore.getState().enter({ organizationId: 'org1' });
    const raw = sessionStorage.getItem('ledgora-operator-view');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).state.active).toBe(true);
    // The role itself is untouched, and nothing durable is written.
    expect(localStorage.getItem('ledgora-operator-view')).toBeNull();
  });
});

describe('route guard while viewing', () => {
  it('sends a viewing operator to the app dashboard, not the console', () => {
    expect(resolvePostLoginRoute(operator({ operatorViewing: true }))).toBe(ROUTES.appDashboard);
  });

  it('still sends a non-viewing operator to the console', () => {
    expect(resolvePostLoginRoute(operator())).toBe(ROUTES.adminConsole);
  });

  it('does not bounce a viewing operator off the application surface', () => {
    expect(isPathAllowed(operator({ operatorViewing: true }), ROUTES.appDashboard)).toBe(true);
  });

  it('keeps a non-viewing operator out of the application surface', () => {
    expect(isPathAllowed(operator(), ROUTES.appDashboard)).toBe(false);
  });

  it('never downgrades the operator: admin paths stay open while viewing', () => {
    // Proves viewing mode is orthogonal to the role — the super-admin can still
    // reach administration; nothing mutated platformRoles.
    expect(isPathAllowed(operator({ operatorViewing: true }), ROUTES.adminConsole)).toBe(true);
  });
});

describe('trust boundary', () => {
  it('honours viewing mode only for a genuine effective operator', () => {
    // A locally-simulated operator (DEV + dev tools under Vitest) viewing a tenant.
    useSessionStore.setState({ platformRole: 'super-admin' });
    useOperatorViewStore.getState().enter({ organizationId: 'o' });
    expect(readAccessContext().platformRole).toBe('super-admin');
    expect(readAccessContext().operatorViewing).toBe(true);
  });

  it('grants no tenant access when a non-operator sets the flag', () => {
    // Whatever a tenant writes, their effective role stays 'none', so the flag
    // is inert and the application surface stays closed.
    useSessionStore.setState({ platformRole: 'none' });
    useOperatorViewStore.getState().enter({ organizationId: 'o' });
    const ctx = readAccessContext();
    expect(ctx.platformRole).toBe('none');
    expect(ctx.operatorViewing).toBe(false);
    expect(isPathAllowed(ctx, ROUTES.appDashboard)).toBe(false);
  });
});

describe('leaving subscriber-view mode', () => {
  it('"Return to admin console" (exit) clears the viewed context', () => {
    useOperatorViewStore.getState().enter({ organizationId: 'o', ownerUserId: 'u', orgName: 'Acme' });
    useOperatorViewStore.getState().exit();
    const s = useOperatorViewStore.getState();
    expect(s.active).toBe(false);
    expect(s.organizationId).toBeNull();
    expect(s.ownerUserId).toBeNull();
  });

  it('sign-out clears the viewing context', () => {
    useSessionStore.setState({ platformRole: 'super-admin' });
    useOperatorViewStore.getState().enter({ organizationId: 'o', ownerUserId: 'u' });
    clearWorkspaceForSignOut();
    expect(useOperatorViewStore.getState().active).toBe(false);
  });
});

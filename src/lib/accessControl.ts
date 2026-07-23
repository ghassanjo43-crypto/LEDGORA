/**
 * Organization-level access control — the single policy that BOTH the frontend
 * router and the (modelled) backend API enforce.
 *
 * Two jobs:
 *  1. `resolvePostLoginRoute` — the redirect state machine that decides where a
 *     user lands after login based on verification / organization / subscription.
 *  2. `apiGuard` — the controlled 403 a backend API returns when an organization
 *     without an active subscription (or without the entitled module) requests a
 *     protected resource. The UI never relies on hidden menus alone; the same
 *     check runs server-side (here, modelled) and returns HTTP 403.
 *
 * It also maps a chosen base plan + add-ons to concrete entitlements at
 * activation time.
 */
import type { OnboardingSubscriptionStatus } from '@/types/onboarding';
import type { LedgoraEdition, LedgoraModule } from '@/types/entitlements';
import type { PlatformCapability, PlatformRole } from '@/types/roles';
import { platformRoleHasCapability } from '@/types/roles';
import { EDITION_MODULES, sortModules } from '@/config/editions';

/* ── Route constants (the literal paths from the specification) ────────────── */

export const ROUTES = {
  /** Public landing surface for an unauthenticated visitor. */
  welcome: '/',
  pricing: '/pricing',
  login: '/login',
  register: '/register',
  verifyEmail: '/verify-email',
  onboardingOrganization: '/onboarding/organization',
  onboardingSubscription: '/onboarding/subscription',
  billingPayment: '/billing/payment',
  subscriptionStatus: '/subscription/status',
  subscriptionSuspended: '/subscription/suspended',
  billingRenew: '/billing/renew',
  profile: '/profile',
  support: '/support',
  appDashboard: '/app/dashboard',
  adminPayments: '/admin/payments',
  /** Platform-operator landing surface. NOT part of the tenant application. */
  adminConsole: '/admin/console',
  /** Forced password change (bootstrap administrators, reset credentials). */
  changePassword: '/account/change-password',
} as const;

/** Coarse surface a path belongs to (drives access decisions). */
export type Surface =
  | 'public'
  | 'onboarding'
  | 'billing'
  | 'subscription-status'
  | 'profile'
  | 'support'
  | 'app'
  | 'admin'
  /** Forced credential change — reachable by any authenticated user. */
  | 'account';

/** Paths visitors may open with no authenticated session. */
export const PUBLIC_PATHS: string[] = [
  ROUTES.welcome,
  ROUTES.pricing,
  ROUTES.login,
  ROUTES.register,
  ROUTES.verifyEmail,
];

/** Surfaces a logged-in user may use while their subscription is NOT active. */
const INACTIVE_ALLOWED_SURFACES: Surface[] = [
  'public',
  'onboarding',
  'billing',
  'subscription-status',
  'profile',
  'support',
];

export function surfaceOf(path: string): Surface {
  if (path.startsWith('/app')) return 'app';
  if (path.startsWith('/admin')) return 'admin';
  if (path.startsWith('/account')) return 'account';
  if (path.startsWith('/onboarding')) return 'onboarding';
  if (path === ROUTES.subscriptionStatus || path === ROUTES.subscriptionSuspended)
    return 'subscription-status';
  if (path.startsWith('/billing')) return 'billing';
  if (path.startsWith('/profile')) return 'profile';
  if (path.startsWith('/support')) return 'support';
  return 'public';
}

/* ── Post-login redirect state machine ─────────────────────────────────────── */

export interface AccessContext {
  /** The signed-in user, or null when no session exists. */
  user: { emailVerified: boolean } | null;
  hasOrganization: boolean;
  subscriptionStatus: OnboardingSubscriptionStatus | null;
  /**
   * A Free Demo workspace is running. The demo is not a subscription: it opens
   * the application without a plan, and only the demo-permitted views (see
   * `config/freeDemo`) render inside it.
   */
  demoActive?: boolean;
  /**
   * The EFFECTIVE platform role, as resolved by `lib/platformAccess` — i.e.
   * confirmed by the backend session, or simulated on an approved local dev
   * machine. Never read this from browser storage, a query parameter or a
   * frontend user record: a tenant could set any of those.
   */
  platformRole?: PlatformRole;
  /**
   * The backend requires a new password before anything else (a bootstrap
   * administrator provisioned from an environment variable, for instance).
   */
  mustChangePassword?: boolean;
  /**
   * The operator has explicitly entered "subscriber view" mode (see
   * `store/operatorViewStore`). It is only ever true here for a genuine
   * effective operator — `readAccessContext` re-validates it against the
   * verified role — so it relaxes routing onto the application surface without
   * granting any tenant a way in.
   */
  operatorViewing?: boolean;
}

/**
 * A LEDGORA operator is not a tenant subscriber.
 *
 * Platform roles are granted in the database by an existing super_admin and
 * have nothing to do with buying a package. Sending an operator through the
 * customer funnel — organization creation, package selection, payment proof —
 * is a defect: they have no tenant to create and nothing to buy.
 */
export function isPlatformOperator(role: PlatformRole | undefined): boolean {
  return role !== undefined && role !== 'none';
}

/** Where a verified operator belongs, by role. */
export function operatorLandingRoute(role: PlatformRole): string {
  // Super-admins own the whole console; a billing admin only reviews payments.
  if (platformRoleHasCapability(role, 'manage-any-organization')) return ROUTES.adminConsole;
  if (platformRoleHasCapability(role, 'verify-payments')) return ROUTES.adminPayments;
  // 'support' and anything else privileged enough to be non-'none' but without
  // a dedicated surface still must not enter the customer funnel.
  return ROUTES.adminConsole;
}

/**
 * The capability an administration path demands. Unknown `/admin/*` paths
 * default to the strongest requirement so a new route cannot be reachable by
 * accident before it is classified here.
 */
export function requiredAdminCapability(path: string): PlatformCapability {
  if (path.startsWith(ROUTES.adminPayments)) return 'verify-payments';
  return 'manage-any-organization';
}

/**
 * Where the given user belongs right now. Implements the exact specification:
 *   unverified → /verify-email · no org → /onboarding/organization ·
 *   no subscription → /onboarding/subscription · pending_payment → /billing/payment ·
 *   pending_verification → /subscription/status · active → /app/dashboard ·
 *   expired → /billing/renew · suspended → /subscription/suspended ·
 *   rejected → /billing/payment.
 */
export function resolvePostLoginRoute(ctx: AccessContext): string {
  // ── Platform operators are resolved BEFORE any customer state ────────────
  // An operator has no tenant organization and no subscription, so evaluating
  // the customer funnel first would send them to package selection — the
  // production defect this ordering exists to prevent.
  if (isPlatformOperator(ctx.platformRole)) {
    // A temporary credential is exchanged before the console opens, so a
    // bootstrap password that was typed into a deploy dashboard cannot remain
    // in use once it has granted access.
    if (ctx.mustChangePassword) return ROUTES.changePassword;
    // An operator who has explicitly entered subscriber-view mode belongs on the
    // application surface, NOT the console — this is what stops the shell from
    // bouncing "Exit to subscriber view" straight back to /admin/console.
    if (ctx.operatorViewing) return ROUTES.appDashboard;
    return operatorLandingRoute(ctx.platformRole!);
  }

  // A running Free Demo owns the application surface until it is exited.
  if (ctx.demoActive) return ROUTES.appDashboard;
  if (!ctx.user) return ROUTES.welcome;
  if (ctx.mustChangePassword) return ROUTES.changePassword;
  if (!ctx.user.emailVerified) return ROUTES.verifyEmail;
  if (!ctx.hasOrganization) return ROUTES.onboardingOrganization;

  const status = ctx.subscriptionStatus;
  if (!status || status === 'draft') return ROUTES.onboardingSubscription;

  switch (status) {
    case 'pending_payment':
      return ROUTES.billingPayment;
    case 'pending_verification':
      return ROUTES.subscriptionStatus;
    case 'active':
      return ROUTES.appDashboard;
    case 'expired':
      return ROUTES.billingRenew;
    case 'suspended':
      return ROUTES.subscriptionSuspended;
    case 'rejected':
      return ROUTES.billingPayment;
    default:
      return ROUTES.onboardingSubscription;
  }
}

/**
 * May this authenticated user view this path right now? Active subscriptions may
 * go anywhere in the app; otherwise only the inactive-allowed surfaces are
 * reachable and everything else redirects to `resolvePostLoginRoute`.
 * (Admin surface access is decided separately by platform role.)
 */
export function isPathAllowed(ctx: AccessContext, path: string): boolean {
  const surface = surfaceOf(path);

  // Administration is decided ONLY by the verified platform capability, never
  // by organization or subscription state — an operator has neither. A demo
  // visitor is never an operator.
  if (surface === 'admin') {
    if (ctx.demoActive) return false;
    return platformRoleHasCapability(ctx.platformRole ?? 'none', requiredAdminCapability(path));
  }

  // A forced password change must stay reachable, or the user is trapped: every
  // other surface redirects back to it.
  if (surface === 'account') return !!ctx.user;

  // Nothing else opens until a required password change is done.
  if (ctx.mustChangePassword) return false;

  // An operator has no subscription, so the customer surfaces below would all
  // deny them. In explicit subscriber-view mode they may use the application
  // surface for the organization they are viewing; otherwise they belong on
  // administration and nothing else opens.
  if (isPlatformOperator(ctx.platformRole)) {
    return !!ctx.operatorViewing && surface === 'app';
  }

  // A Free Demo may open the application (view-level limits are applied by the
  // AccessGate).
  if (ctx.demoActive) return true;
  if (ctx.subscriptionStatus === 'active') return true;
  return INACTIVE_ALLOWED_SURFACES.includes(surface);
}

/* ── Backend API guard (controlled 403) ────────────────────────────────────── */

/** Resources a real backend protects behind an active subscription. */
export type ProtectedResource =
  | 'accounting'
  | 'invoicing'
  | 'projects'
  | 'construction'
  | 'manufacturing'
  | 'reports';

export const PROTECTED_RESOURCES: ProtectedResource[] = [
  'accounting',
  'invoicing',
  'projects',
  'construction',
  'manufacturing',
  'reports',
];

export interface ApiAllowed {
  ok: true;
  status: 200;
}
export interface ApiForbidden {
  ok: false;
  status: 403;
  code: 'subscription_inactive' | 'module_not_entitled';
  message: string;
}
export type ApiGuardResult = ApiAllowed | ApiForbidden;

export interface ApiGuardInput {
  subscriptionStatus: OnboardingSubscriptionStatus | null;
  resource: ProtectedResource;
  /** Whether the organization's entitlements include the module for `resource`. */
  hasEntitlement: boolean;
  /**
   * Server-resolved operator override (see `lib/platformEntitlementOverride`).
   * `'full_access'` — a VERIFIED super-admin in operator viewing mode — skips
   * only the product-package refusals below. It is resolved by the backend from
   * the authenticated session, never from a client-supplied value, and it does
   * not bypass authentication, organization scoping or ownership checks: those
   * run before this guard is ever consulted.
   */
  platformOverride?: 'full_access' | 'none';
}

/**
 * The check a protected backend endpoint runs. Returns a controlled 403 (never
 * throws by default) so callers can shape a real HTTP response. An inactive
 * subscription is refused before any per-module entitlement check.
 */
export function apiGuard(input: ApiGuardInput): ApiGuardResult {
  // Platform administrator with full feature access: package restrictions do
  // not apply (the subscriber's subscription record itself is untouched).
  if (input.platformOverride === 'full_access') return { ok: true, status: 200 };
  if (input.subscriptionStatus !== 'active') {
    return {
      ok: false,
      status: 403,
      code: 'subscription_inactive',
      message: 'Your organization does not have an active subscription.',
    };
  }
  if (!input.hasEntitlement) {
    return {
      ok: false,
      status: 403,
      code: 'module_not_entitled',
      message: `Your plan does not include the ${input.resource} module.`,
    };
  }
  return { ok: true, status: 200 };
}

/** Thrown form of {@link apiGuard} for call sites that prefer exceptions. */
export class ForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(readonly code: ApiForbidden['code'], message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export function assertApiAccess(input: ApiGuardInput): void {
  const result = apiGuard(input);
  if (!result.ok) throw new ForbiddenError(result.code, result.message);
}

/* ── Plan/add-on → entitlement mapping (used at activation) ─────────────────── */

const CORE_MODULE_SET = new Set(EDITION_MODULES.core);

function deltaFromCore(edition: LedgoraEdition): LedgoraModule[] {
  return EDITION_MODULES[edition].filter((m) => !CORE_MODULE_SET.has(m));
}

/**
 * Which modules each optional add-on unlocks on top of the core accounting base.
 * Base plans (core/professional/business/enterprise) differ by allowances and
 * limits, not by functional modules; the functional modules are add-ons.
 */
export const ADD_ON_MODULES: Record<string, LedgoraModule[]> = {
  projects: deltaFromCore('projects'),
  construction: deltaFromCore('construction'),
  manufacturing: deltaFromCore('manufacturing'),
  advanced_inventory: ['inventory_basic', 'inventory_advanced', 'warehouses', 'lot_serial_tracking', 'landed_cost'],
  consolidation: ['multi_entity'],
  ai: [], // AI is a metered usage feature, not a gate-able module
};

export interface EntitlementActivation {
  edition: LedgoraEdition;
  enabledModules: LedgoraModule[];
  userLimit: number;
  entityLimit: number;
}

/**
 * Resolve the entitlement snapshot to apply when a subscription is activated.
 * Every base plan maps to the `core` edition; paid add-ons enable their module
 * groups; limits come from the plan allowance plus any purchased extras.
 */
export function resolveEntitlementActivation(input: {
  baseUsers: number;
  baseCompanies: number;
  addOnModuleCodes: string[];
  extraUsers: number;
  extraCompanies: number;
}): EntitlementActivation {
  const modules = new Set<LedgoraModule>();
  for (const code of input.addOnModuleCodes) {
    for (const m of ADD_ON_MODULES[code] ?? []) modules.add(m);
  }
  return {
    edition: 'core',
    enabledModules: sortModules(modules),
    userLimit: input.baseUsers + Math.max(0, input.extraUsers),
    entityLimit: input.baseCompanies + Math.max(0, input.extraCompanies),
  };
}

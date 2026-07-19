/**
 * THE platform-administration policy. Every sensitive operator action resolves
 * its permission here, and nothing else may decide it.
 *
 * ── Why this file exists ──────────────────────────────────────────────────────
 * LEDGORA has no authentication backend. A frontend cannot hold a secret, and
 * anything in `localStorage` is fully under the visitor's control. Therefore a
 * browser-held "I am an administrator" value can NEVER be treated as an
 * authorization decision in a deployed build.
 *
 * The policy until a backend exists:
 *
 *   Platform-administration tooling operates ONLY on a local development
 *   server, and only when the developer has explicitly opted in with an
 *   uncommitted `.env.local` containing `VITE_LEDGORA_DEV_TOOLS=true`.
 *
 * `import.meta.env.DEV` is baked in at build time by Vite and is `false` in any
 * production bundle, so the whole administration path is statically dead in a
 * Render deployment. Editing `localStorage`, calling a store action from the
 * browser console, or hand-crafting a URL cannot re-enable it.
 *
 * ── BACKEND SEAM ──────────────────────────────────────────────────────────────
 * When the API lands, the effective platform role comes from a verified server
 * session (`GET /api/auth/session` → `platformRole`), and every action below is
 * additionally enforced server-side. The client check then becomes a UX
 * affordance rather than the control it is standing in for today.
 */
import {
  platformRoleHasCapability,
  type PlatformCapability,
  type PlatformRole,
} from '@/types/roles';

export interface PermissionResult {
  ok: boolean;
  error?: string;
}

export const PLATFORM_ADMIN_DENIED =
  'Platform administration is disabled in this build. These actions require a verified LEDGORA operator session on the server.';

/**
 * May platform-administration tooling run at all?
 *
 * BOTH conditions are required:
 *   1. `import.meta.env.DEV` — a local dev server, never a production bundle.
 *   2. `VITE_LEDGORA_DEV_TOOLS === 'true'` — explicit, uncommitted opt-in.
 *
 * Deliberately NOT consulted: localStorage, sessionStorage, cookies, URL
 * parameters, or any other visitor-controlled input.
 */
export function platformAdminToolsAllowed(): boolean {
  try {
    const env = import.meta.env as Record<string, unknown> | undefined;
    if (!env) return false;
    return env.DEV === true && env.VITE_LEDGORA_DEV_TOOLS === 'true';
  } catch {
    return false;
  }
}

/**
 * The platform role that actually applies. A stored role is honoured only while
 * `platformAdminToolsAllowed()` holds; otherwise every user is `'none'`,
 * regardless of what is persisted in the browser.
 */
export function effectivePlatformRole(storedRole: PlatformRole): PlatformRole {
  return platformAdminToolsAllowed() ? storedRole : 'none';
}

/** Capability check against the effective (production-locked) role. */
export function hasPlatformCapability(storedRole: PlatformRole, capability: PlatformCapability): boolean {
  return platformRoleHasCapability(effectivePlatformRole(storedRole), capability);
}

/** Fail-closed assertion used by every sensitive store action. */
export function assertPlatformCapability(
  storedRole: PlatformRole,
  capability: PlatformCapability,
  deniedMessage = PLATFORM_ADMIN_DENIED,
): PermissionResult {
  return hasPlatformCapability(storedRole, capability)
    ? { ok: true }
    : { ok: false, error: deniedMessage };
}

/**
 * The single hook components use to ask "may this person administer LEDGORA?".
 *
 * It combines the backend-verified session (authoritative in production) with
 * the local development simulation, so no component has to know which path is
 * in play — and no component can accidentally trust a browser value.
 */
import { useEffect, useMemo } from 'react';
import type { PlatformCapability, PlatformRole } from '@/types/roles';
import { platformRoleHasCapability } from '@/types/roles';
import { effectivePlatformRole, platformAdminToolsAllowed } from '@/lib/platformAccess';
import { useSessionStore } from '@/store/sessionStore';
import { useBackendSessionStore } from '@/store/backendSessionStore';
import { isApiConfigured } from '@/services/api/client';

/**
 * Confirm the backend session once at application start. Until it resolves the
 * effective role stays `'none'`, so the administrator surface never flashes
 * into view before the server has verified anything.
 */
export function useBackendSessionBootstrap(): void {
  const status = useBackendSessionStore((s) => s.status);
  const refresh = useBackendSessionStore((s) => s.refresh);

  useEffect(() => {
    if (status === 'unknown') void refresh();
  }, [status, refresh]);
}

/** The role that actually applies right now. */
export function useEffectivePlatformRole(): PlatformRole {
  const storedRole = useSessionStore((s) => s.platformRole);
  const backendRoles = useBackendSessionStore((s) => s.platformRoles);
  return useMemo(() => effectivePlatformRole(storedRole, backendRoles), [storedRole, backendRoles]);
}

export function usePlatformCapability(capability: PlatformCapability): boolean {
  const role = useEffectivePlatformRole();
  return platformRoleHasCapability(role, capability);
}

/** True when the visitor may see any administration surface at all. */
export function useIsPlatformAdmin(): boolean {
  return usePlatformCapability('manage-any-organization');
}

export interface PlatformAccessState {
  role: PlatformRole;
  /** The backend confirmed this role (as opposed to a local simulation). */
  verifiedByBackend: boolean;
  /** A local developer is simulating the role. */
  simulatedLocally: boolean;
  /** The session check has not finished yet — render nothing privileged. */
  resolving: boolean;
}

export function usePlatformAccess(): PlatformAccessState {
  const role = useEffectivePlatformRole();
  const status = useBackendSessionStore((s) => s.status);
  const backendRoles = useBackendSessionStore((s) => s.platformRoles);

  return useMemo(() => {
    const verifiedByBackend = backendRoles.length > 0;
    return {
      role,
      verifiedByBackend,
      simulatedLocally: !verifiedByBackend && role !== 'none' && platformAdminToolsAllowed(),
      // Only "resolving" when a backend actually exists to wait for.
      resolving: isApiConfigured() && (status === 'unknown' || status === 'loading'),
    };
  }, [role, status, backendRoles]);
}

import type { ReactNode } from 'react';
import type { LedgoraModule } from '@/types/entitlements';
import { useCanAccessFeature } from '@/store/entitlementHooks';

export interface FeatureGateProps {
  module?: LedgoraModule;
  allModules?: LedgoraModule[];
  anyModules?: LedgoraModule[];
  /** Rendered when the required module(s) are not owned. Default: nothing. */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * Conditionally render children based on the active organization's entitlements.
 * The default behaviour for an unavailable feature is HIDDEN (render nothing),
 * not disabled.
 *
 *   <FeatureGate module="projects"><ProjectsPanel /></FeatureGate>
 */
export function FeatureGate({
  module,
  allModules,
  anyModules,
  fallback = null,
  children,
}: FeatureGateProps) {
  const allowed = useCanAccessFeature({
    requiredModule: module,
    requiredAllModules: allModules,
    requiredAnyModules: anyModules,
  });
  return <>{allowed ? children : fallback}</>;
}

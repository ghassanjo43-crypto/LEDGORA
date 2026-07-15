import type { ReactElement } from 'react';
import type { LedgoraModule } from '@/types/entitlements';
import { useCanAccessFeature } from '@/store/entitlementHooks';
import { ModuleUnavailablePage } from './ModuleUnavailablePage';

export interface ModuleRouteProps {
  module?: LedgoraModule;
  allModules?: LedgoraModule[];
  anyModules?: LedgoraModule[];
  element: ReactElement;
}

/**
 * Route-level entitlement guard. Renders the protected element only when the
 * required module(s) are owned; otherwise renders the module-unavailable page.
 * Because this runs on every render (including a direct URL/refresh), a
 * protected view can never be reached by typing its key.
 */
export function ModuleRoute({
  module,
  allModules,
  anyModules,
  element,
}: ModuleRouteProps): ReactElement {
  const allowed = useCanAccessFeature({
    requiredModule: module,
    requiredAllModules: allModules,
    requiredAnyModules: anyModules,
  });
  if (!allowed) return <ModuleUnavailablePage module={module} />;
  return element;
}

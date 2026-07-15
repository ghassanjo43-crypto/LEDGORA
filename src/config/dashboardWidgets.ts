/**
 * Dashboard widget entitlement registry.
 *
 * Each dashboard widget declares the module it needs. Widgets whose module is
 * not owned are never rendered (no empty "unavailable" placeholders). The
 * existing widgets are all core-accounting widgets; project/construction
 * widgets are added by their respective phases and gated here.
 */
import type { DashboardWidgetId } from '@/types/dashboard';
import type { LedgoraModule } from '@/types/entitlements';
import type { ModuleRequirement } from '@/lib/entitlementResolution';
import { canAccessFeature } from '@/lib/entitlementResolution';

/** Requirement per widget. Widgets absent from this map are always shown. */
export const DASHBOARD_WIDGET_MODULES: Partial<
  Record<DashboardWidgetId, ModuleRequirement>
> = {
  'financial-summary': { requiredModule: 'core_accounting' },
  'operational-status': { requiredModule: 'core_accounting' },
  'cash-flow': { requiredModule: 'core_accounting' },
  'income-expense': { requiredModule: 'core_accounting' },
  receivables: { requiredModule: 'sales' },
  payables: { requiredModule: 'purchases' },
  'top-expenses': { requiredModule: 'core_accounting' },
  'bank-accounts': { requiredModule: 'core_accounting' },
  'attention-required': { requiredModule: 'core_accounting' },
  'recent-activity': { requiredModule: 'core_accounting' },
  'business-overview': { requiredModule: 'core_accounting' },
};

/** Whether a widget may be shown for the given owned modules. */
export function canShowDashboardWidget(
  moduleIds: readonly LedgoraModule[],
  id: DashboardWidgetId,
): boolean {
  return canAccessFeature(moduleIds, DASHBOARD_WIDGET_MODULES[id]);
}

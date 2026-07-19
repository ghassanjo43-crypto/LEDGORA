import { FlaskConical } from 'lucide-react';
import type { LedgoraEdition } from '@/types/entitlements';
import { useEntitlementStore } from '@/store/entitlementStore';
import { ALL_EDITIONS } from '@/config/editions';
import { EDITION_INFO } from '@/config/editionCommercialInfo';
import { cn } from '@/lib/utils';

/**
 * Whether development-only tooling should be shown. Delegates to the single
 * platform-wide switch so the edition/role switchers can never appear on the
 * public welcome, registration or sign-in screens, during package selection, or
 * in a production build.
 */
import { platformAdminToolsAllowed } from '@/lib/platformAccess';

export { platformAdminToolsAllowed as devToolsEnabled };

/**
 * Development-only edition switcher. Switching edition updates the entitlement
 * store, which immediately re-filters navigation, routes, dashboard and forms —
 * no reload and no white screen (selectors return the stored module array or a
 * primitive). Hidden in production unless explicitly authorized.
 */
export function DevelopmentEditionSwitcher({ compact = false }: { compact?: boolean }) {
  // Selector returns a primitive string — stable across renders.
  const edition = useEntitlementStore((s) => s.subscription.edition);
  const setEdition = useEntitlementStore((s) => s.setEdition);

  if (!platformAdminToolsAllowed()) return null;

  return (
    <div
      className={cn(
        'flex items-center gap-1 rounded-lg border border-dashed border-amber-300 bg-amber-50/60 p-1 dark:border-amber-500/40 dark:bg-amber-500/5',
        compact ? 'text-[11px]' : 'text-xs',
      )}
      title="Development-only: switch the active Ledgora edition"
    >
      <span className="flex items-center gap-1 px-1.5 font-medium text-amber-700 dark:text-amber-300">
        <FlaskConical className="h-3.5 w-3.5" />
        {!compact && <span>Edition</span>}
      </span>
      {ALL_EDITIONS.map((e: LedgoraEdition) => (
        <button
          key={e}
          type="button"
          onClick={() => setEdition(e)}
          className={cn(
            'focus-ring rounded-md px-2 py-1 font-medium capitalize transition-colors',
            edition === e
              ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-slate-100'
              : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200',
          )}
        >
          {EDITION_INFO[e]?.name.replace('Ledgora ', '') ?? e}
        </button>
      ))}
    </div>
  );
}

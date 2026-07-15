import { Lock, ArrowRight } from 'lucide-react';
import type { LedgoraModule } from '@/types/entitlements';
import { useStore } from '@/store/useStore';
import { useCurrentEdition } from '@/store/entitlementHooks';
import { MODULE_BY_ID } from '@/config/modules';
import { EDITION_INFO } from '@/config/editionCommercialInfo';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

/**
 * Shown when a protected view is reached without the required entitlement —
 * whether via navigation or by typing/refreshing a protected URL. It never
 * renders the protected content and never crashes.
 */
export function ModuleUnavailablePage({ module }: { module?: LedgoraModule }) {
  const setActiveView = useStore((s) => s.setActiveView);
  const edition = useCurrentEdition();
  const moduleName = module ? MODULE_BY_ID[module]?.name ?? module : undefined;
  const editionName = EDITION_INFO[edition]?.name ?? 'Ledgora';

  return (
    <div className="mx-auto max-w-lg py-10">
      <Card>
        <CardBody className="flex flex-col items-center gap-4 py-10 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
            <Lock className="h-6 w-6" />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {moduleName ? `${moduleName} is not available` : 'Feature not available'}
            </h2>
            <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
              This feature is not included in your current {editionName} edition.
              Contact your administrator to enable it.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button variant="primary" size="sm" onClick={() => setActiveView('dashboard')}>
              Back to dashboard
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setActiveView('settings')}>
              Manage subscription <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

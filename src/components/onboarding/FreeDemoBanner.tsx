/**
 * Persistent Free Demo banner shown inside the accounting application.
 *
 * "Choose a package" opens package selection *inside* the application, so the
 * current demo workspace is untouched until the visitor actually leaves or
 * upgrades. "Exit demo" discards it after an explicit confirmation.
 */
import { useState } from 'react';
import { Info, Package } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { FREE_DEMO_COPY } from '@/config/freeDemo';
import { useStore } from '@/store/useStore';
import { useIsFreeDemo } from '@/hooks/useSession';
import { endFreeDemoWorkspace } from '@/lib/freeDemoSession';
import { useRouterStore } from '@/store/routerStore';
import { ROUTES } from '@/lib/accessControl';

export function FreeDemoBanner() {
  const isDemo = useIsFreeDemo();
  const setActiveView = useStore((s) => s.setActiveView);
  const navigate = useRouterStore((s) => s.navigate);
  const [confirmExit, setConfirmExit] = useState(false);

  if (!isDemo) return null;

  return (
    <>
      <div
        role="status"
        className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
      >
        <Info className="h-4 w-4 shrink-0" aria-hidden />
        <p className="min-w-0 flex-1">{FREE_DEMO_COPY.banner}</p>
        <Button size="sm" onClick={() => setActiveView('subscription')}>
          <Package className="h-3.5 w-3.5" aria-hidden />
          Choose a package
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirmExit(true)}>
          Exit demo
        </Button>
      </div>

      <ConfirmDialog
        open={confirmExit}
        title="Leave the Free Demo?"
        message="Everything entered during this demonstration session will be discarded. Choose a package first if you want to keep working with permanent records."
        confirmLabel="Leave and discard"
        cancelLabel="Stay in the demo"
        destructive
        onCancel={() => setConfirmExit(false)}
        onConfirm={() => {
          setConfirmExit(false);
          endFreeDemoWorkspace();
          navigate(ROUTES.welcome, { replace: true });
        }}
      />
    </>
  );
}

/**
 * Platform administration surface.
 *
 * Deliberately OUTSIDE the tenant application shell. A Ledgora operator is not
 * a subscriber: they have no organization, no package and no subscription, so
 * nothing here may depend on the customer state that `/app` requires. Rendering
 * the console inside `/app` was the production defect — that surface is gated on
 * an active subscription an operator will never have.
 *
 * The chrome is intentionally distinct from a subscriber workspace so it is
 * obvious at a glance that this is cross-tenant platform tooling.
 */
import { useState } from 'react';
import { ShieldCheck, LogOut } from 'lucide-react';
import { SuperAdminConsolePage } from '@/pages/SuperAdminConsolePage';
import { usePlatformAccess } from '@/hooks/usePlatformRole';
import { useRouterStore } from '@/store/routerStore';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { authService } from '@/services';
import { ROUTES } from '@/lib/accessControl';

export function PlatformConsolePage() {
  const { role, verifiedByBackend, resolving } = usePlatformAccess();
  const navigate = useRouterStore((s) => s.navigate);
  const [signingOut, setSigningOut] = useState(false);

  // Never paint platform tooling before the server has confirmed the role.
  if (resolving) return null;

  const signOut = async (): Promise<void> => {
    setSigningOut(true);
    await authService.signOut();
    navigate(ROUTES.welcome, { replace: true });
  };

  return (
    <div className="min-h-full bg-slate-100 dark:bg-slate-950">
      <header className="border-b border-slate-300 bg-slate-900 text-slate-100 dark:border-slate-800">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="h-5 w-5 text-emerald-400" aria-hidden />
            <div>
              <p className="text-sm font-semibold leading-tight">Ledgora platform administration</p>
              <p className="text-[11px] leading-tight text-slate-400">
                Cross-tenant operator console — not a subscriber workspace
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Badge tone={verifiedByBackend ? 'green' : 'amber'}>
              {verifiedByBackend ? `Verified ${role}` : `Simulated ${role} (local)`}
            </Badge>
            <Button variant="secondary" size="sm" onClick={() => void signOut()} disabled={signingOut}>
              <LogOut className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {signingOut ? 'Signing out…' : 'Sign out'}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <SuperAdminConsolePage />
      </main>
    </div>
  );
}

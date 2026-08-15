/**
 * Account security — the self-service surface every signed-in person can reach.
 *
 * ── Why a standalone route exists at all ─────────────────────────────────────
 * The same panel is embedded in in-app Settings and in the platform console, and
 * for most people that is where they will find it. But both of those live behind
 * something: Settings is inside `/app`, which requires an active subscription,
 * and the console requires a platform capability. A person whose subscription
 * has lapsed, or who is mid-onboarding, still owns their account and must still
 * be able to change their password without writing to support.
 *
 * So this route sits on the `account` surface, which `lib/accessControl` grants
 * to ANY authenticated user — no organization, no subscription, no module
 * entitlement and no bookkeeping permission is consulted.
 *
 * "Back" returns wherever the person actually belongs (`resolvePostLoginRoute`),
 * which is the platform console for an operator and the application for a
 * subscriber — never the other way round.
 */
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { AccountSecurityPanel } from '@/components/account/AccountSecurityPanel';
import { Button } from '@/components/ui/Button';
import { useRouterStore } from '@/store/routerStore';
import { resolvePostLoginRoute } from '@/lib/accessControl';
import { readAccessContext } from '@/lib/accessContext';
import { useBackendSessionStore } from '@/store/backendSessionStore';

export function AccountSecurityPage() {
  const navigate = useRouterStore((s) => s.navigate);
  const user = useBackendSessionStore((s) => s.user);

  const goBack = (): void => navigate(resolvePostLoginRoute(readAccessContext()), { replace: true });

  return (
    <div className="min-h-full bg-slate-50 dark:bg-slate-950">
      <div className="mx-auto max-w-3xl space-y-5 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-900 dark:text-slate-50">
              <ShieldCheck className="h-5 w-5 text-slate-400" aria-hidden />
              Account security
            </h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {user
                ? `Signed in as ${user.fullName} (${user.email}).`
                : 'Manage the security of your own account.'}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={goBack}>
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Back
          </Button>
        </div>

        <AccountSecurityPanel />
      </div>
    </div>
  );
}

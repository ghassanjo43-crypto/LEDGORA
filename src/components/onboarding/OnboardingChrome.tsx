/**
 * Shared chrome for the public site and onboarding funnel: brand mark, a public
 * marketing shell (header/footer), a centered card layout for auth/onboarding
 * screens, and a step indicator.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/store/authStore';
import { useRouterStore } from '@/store/routerStore';
import { ROUTES } from '@/lib/accessControl';

export function Brand({ className }: { className?: string }) {
  const navigate = useRouterStore((s) => s.navigate);
  return (
    <button
      type="button"
      onClick={() => navigate(ROUTES.pricing)}
      aria-label="Ledgora home"
      className={cn('flex items-center gap-2', className)}
    >
      <span
        role="img"
        aria-label="Ledgora"
        className="h-8 w-32 rounded bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/ledgora-logo.png')", backgroundSize: 'contain' }}
      />
    </button>
  );
}

/** Public marketing shell used by pricing / login / register. */
export function PublicShell({ children }: { children: ReactNode }) {
  const navigate = useRouterStore((s) => s.navigate);
  const currentUserId = useAuthStore((s) => s.currentUserId);

  return (
    <div className="flex min-h-full flex-col bg-slate-50 dark:bg-slate-950">
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <Brand />
          <nav className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => navigate(ROUTES.pricing)}>
              Pricing
            </Button>
            {currentUserId ? (
              <Button size="sm" onClick={() => navigate(ROUTES.appDashboard)}>
                Go to app
              </Button>
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={() => navigate(ROUTES.login)}>
                  Sign in
                </Button>
                <Button size="sm" onClick={() => navigate(ROUTES.register)}>
                  Get started
                </Button>
              </>
            )}
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-slate-200 py-6 text-center text-xs text-slate-400 dark:border-slate-800">
        Ledgora — IFRS Accounting Suite. One application, one accounting engine.
      </footer>
    </div>
  );
}

/** Centered single-card layout for auth + onboarding steps. */
export function CenteredCard({
  title,
  subtitle,
  children,
  width = 'md',
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  width?: 'md' | 'lg' | 'xl';
  footer?: ReactNode;
}) {
  const maxW = width === 'xl' ? 'max-w-3xl' : width === 'lg' ? 'max-w-xl' : 'max-w-md';
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-slate-50 px-4 py-10 dark:bg-slate-950">
      <div className="mb-6">
        <Brand />
      </div>
      <div className={cn('w-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-8', maxW)}>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
      {footer && <div className="mt-4 text-sm text-slate-500 dark:text-slate-400">{footer}</div>}
    </div>
  );
}

const ONBOARDING_STEPS = ['Account', 'Verify', 'Organization', 'Subscription', 'Payment'] as const;

export function Stepper({ current }: { current: (typeof ONBOARDING_STEPS)[number] }) {
  const activeIndex = ONBOARDING_STEPS.indexOf(current);
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {ONBOARDING_STEPS.map((step, i) => {
        const state = i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'todo';
        return (
          <li key={step} className="flex items-center gap-2">
            <span
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold',
                state === 'done' && 'bg-emerald-500 text-white',
                state === 'active' && 'bg-brand-600 text-white',
                state === 'todo' && 'bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400',
              )}
            >
              {state === 'done' ? '✓' : i + 1}
            </span>
            <span
              className={cn(
                state === 'active' ? 'font-medium text-slate-900 dark:text-slate-100' : 'text-slate-400 dark:text-slate-500',
              )}
            >
              {step}
            </span>
            {i < ONBOARDING_STEPS.length - 1 && <span className="text-slate-300 dark:text-slate-600">→</span>}
          </li>
        );
      })}
    </ol>
  );
}

export function money(amount: number, currency = 'USD'): string {
  return `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: amount % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

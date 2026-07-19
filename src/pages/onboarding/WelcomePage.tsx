/**
 * Public welcome page — the only surface an unauthenticated visitor sees.
 * The accounting application is never rendered from here; the gate in
 * `AppShell` decides that, so the screen cannot be bypassed by changing a view
 * key, a stored value or the URL.
 */
import { useState } from 'react';
import { ArrowRight, BookOpenCheck, LineChart, ShieldCheck, Sparkles } from 'lucide-react';
import { useRouterStore } from '@/store/routerStore';
import { ROUTES } from '@/lib/accessControl';
import { Button } from '@/components/ui/Button';
import { Brand } from '@/components/onboarding/OnboardingChrome';
import { FreeDemoConfirmDialog } from '@/components/onboarding/FreeDemoConfirmDialog';
import { FREE_DEMO_COPY } from '@/config/freeDemo';

const HIGHLIGHTS = [
  {
    icon: BookOpenCheck,
    title: 'IFRS-aligned books',
    body: 'Chart of accounts, journals, ledgers and a trial balance that always reconciles.',
  },
  {
    icon: LineChart,
    title: 'Statements & reporting',
    body: 'Income statement, balance sheet and cash flow generated straight from the ledger.',
  },
  {
    icon: ShieldCheck,
    title: 'Controlled access',
    body: 'Subscription entitlements decide which modules each organization can open.',
  },
];

export function WelcomePage() {
  const navigate = useRouterStore((s) => s.navigate);
  const [demoOpen, setDemoOpen] = useState(false);

  return (
    <div className="flex min-h-full flex-col bg-slate-50 dark:bg-slate-950">
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Brand />
          <nav className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => navigate(ROUTES.pricing)}>
              Pricing
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate(ROUTES.login)}>
              Sign in
            </Button>
          </nav>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-4 py-12 sm:px-6">
        <div className="max-w-2xl">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            LEDGORA — IFRS Accounting Suite
          </span>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-900 dark:text-slate-50 sm:text-4xl">
            Run your books, invoices and reports in one accounting platform
          </h1>
          <p className="mt-3 text-base text-slate-600 dark:text-slate-300">
            LEDGORA is a complete double-entry accounting platform: a chart of accounts, general journal
            and ledgers, customer and supplier documents, tax, inventory and IFRS financial statements —
            all driven by one accounting engine.
          </p>

          <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button size="md" onClick={() => navigate(ROUTES.register)} className="sm:w-auto">
              Create account
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
            <Button variant="outline" size="md" onClick={() => navigate(ROUTES.login)}>
              Sign in
            </Button>
            <Button variant="ghost" size="md" onClick={() => setDemoOpen(true)}>
              Explore free demo
            </Button>
          </div>
          <p className="mt-3 max-w-xl text-xs text-slate-500 dark:text-slate-400">
            The free demo runs in a temporary workspace. Anything you enter is kept for this session only
            and is not saved for a future session.
          </p>
        </div>

        <ul className="mt-12 grid gap-4 sm:grid-cols-3">
          {HIGHLIGHTS.map(({ icon: Icon, title, body }) => (
            <li
              key={title}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
            >
              <Icon className="h-5 w-5 text-brand-600 dark:text-brand-400" aria-hidden />
              <h2 className="mt-2 text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{body}</p>
            </li>
          ))}
        </ul>
      </main>

      <footer className="border-t border-slate-200 py-6 text-center text-xs text-slate-400 dark:border-slate-800">
        LEDGORA — one application, one accounting engine.
      </footer>

      <FreeDemoConfirmDialog
        open={demoOpen}
        onCancel={() => setDemoOpen(false)}
        onChoosePackage={() => {
          setDemoOpen(false);
          navigate(ROUTES.register);
        }}
        choosePackageLabel={FREE_DEMO_COPY.confirmChoosePackage}
      />
    </div>
  );
}

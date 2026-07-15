import { Sparkles, ArrowRight } from 'lucide-react';
import type { ViewKey } from '@/types';
import { VIEW_META } from '@/config/navigation';
import { useStore } from '@/store/useStore';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';

/** What each future module will deliver — shown on its placeholder page. */
const ROADMAP: Partial<Record<ViewKey, string[]>> = {
  'general-ledger': [
    'Account-level posting history from the General Journal',
    'Running balances and drill-down to source entries',
    'Period and date-range filtering',
  ],
  'trial-balance': [
    'Debit / credit totals per account',
    'Automatic balance verification',
    'Export to CSV, Excel and PDF',
  ],
  'financial-statements': [
    'Statement of Financial Position',
    'Profit or Loss and Other Comprehensive Income',
    'Statement of Cash Flows (IAS 7)',
  ],
  invoices: ['Sales invoice creation from customers', 'Automatic journal posting', 'Aging & receivables tracking'],
  receipts: ['Record customer receipts', 'Allocate against open invoices', 'Bank reconciliation ready'],
  bills: ['Capture supplier bills', 'Approval workflow', 'Payables aging'],
  payments: ['Record supplier payments', 'Batch payment runs', 'Remittance advice'],
  'tax-codes': ['Configurable VAT / sales-tax codes', 'Input & output tax accounts', 'Tax return summaries'],
  currencies: ['Multi-currency support', 'Exchange-rate management', 'Revaluation entries'],
  'cost-centers': ['Departmental cost centers', 'Dimensional reporting', 'Budget vs actual'],
  projects: ['Project & job cost tracking', 'Profitability by project', 'Time & materials'],
};

export function ComingSoon({ viewKey }: { viewKey: ViewKey }) {
  const meta = VIEW_META[viewKey];
  const Icon = meta.icon;
  const setActiveView = useStore((s) => s.setActiveView);
  const roadmap = ROADMAP[viewKey] ?? [];

  return (
    <Card className="overflow-hidden">
      <div className="relative border-b border-slate-200/70 bg-gradient-to-br from-brand-50 via-white to-slate-50 px-8 py-12 dark:border-slate-800 dark:from-brand-500/5 dark:via-slate-900 dark:to-slate-900">
        <div className="mx-auto flex max-w-2xl flex-col items-center text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-elevated">
            <Icon className="h-8 w-8" strokeWidth={2} />
          </span>
          <div className="mt-4 flex items-center gap-2">
            <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
              {meta.title}
            </h2>
            <Badge tone="violet" className="gap-1">
              <Sparkles className="h-3 w-3" /> Coming soon
            </Badge>
          </div>
          <p className="mt-2 max-w-lg text-sm text-slate-500 dark:text-slate-400">
            {meta.subtitle}. This module is on the roadmap and will plug directly into your existing
            chart of accounts and journal data — no re-entry required.
          </p>
        </div>
      </div>

      <div className="px-8 py-8">
        {roadmap.length > 0 && (
          <>
            <p className="mb-4 text-xs font-semibold uppercase tracking-wide text-slate-400">
              What to expect
            </p>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {roadmap.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-2.5 rounded-lg border border-slate-200/70 bg-slate-50/50 p-3 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-800/30 dark:text-slate-300"
                >
                  <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
                  {item}
                </li>
              ))}
            </ul>
          </>
        )}
        <div className={roadmap.length > 0 ? 'mt-8 flex flex-wrap items-center gap-2' : 'flex flex-wrap items-center gap-2'}>
          <Button onClick={() => setActiveView('journal')}>Go to General Journal</Button>
          <Button variant="outline" onClick={() => setActiveView('dashboard')}>
            Back to Dashboard
          </Button>
        </div>
      </div>
    </Card>
  );
}

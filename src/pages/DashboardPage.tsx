import { useMemo, useState, type ReactNode } from 'react';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useJournalStore } from '@/store/journalStore';
import { useDashboardPreferences } from '@/store/dashboardPreferencesStore';
import { useEffectiveModules } from '@/store/entitlementHooks';
import { canShowDashboardWidget } from '@/config/dashboardWidgets';
import type { DashboardWidgetId } from '@/types/dashboard';
import { computeJournalStats } from '@/lib/journalSelectors';
import { validateChart } from '@/lib/validation';
import {
  resolvePeriod,
  postedEntries,
  calculateReceivablesBalance,
  calculatePayablesBalance,
  calculateCashAndBankBalance,
  calculateNetIncome,
  calculateTopExpenses,
  calculateCashMovements,
  calculateIncomeExpenseSeries,
  getRecentAccountingActivity,
  getDashboardAttentionItems,
} from '@/lib/dashboardCalculations';
import { PageActions } from '@/components/ui/PageActions';
import { DashboardHeaderActions, CustomizePanel } from '@/components/dashboard/DashboardControls';
import {
  FinancialSummary,
  OperationalStatus,
  CashFlow,
  IncomeExpense,
  Receivables,
  Payables,
  TopExpenses,
  BankAccounts,
  AttentionRequired,
  RecentActivity,
  BusinessOverview,
} from '@/components/dashboard/DashboardWidgets';
import { cn } from '@/lib/utils';

/** Literal col-span classes so Tailwind's JIT keeps them. */
const COL_SPAN: Record<DashboardWidgetId, string> = {
  'financial-summary': 'lg:col-span-6',
  'operational-status': 'lg:col-span-6',
  'cash-flow': 'lg:col-span-4',
  'receivables': 'lg:col-span-2',
  'income-expense': 'lg:col-span-4',
  'top-expenses': 'lg:col-span-2',
  'payables': 'lg:col-span-2',
  'bank-accounts': 'lg:col-span-3',
  'attention-required': 'lg:col-span-3',
  'recent-activity': 'lg:col-span-4',
  'business-overview': 'lg:col-span-2',
};

export function DashboardPage() {
  const accounts = useStore((s) => s.accounts);
  const settings = useStore((s) => s.settings);
  const setActiveView = useStore((s) => s.setActiveView);
  const entities = useEntityStore((s) => s.entities);
  const entries = useJournalStore((s) => s.entries);

  const periodId = useDashboardPreferences((s) => s.periodId);
  const customFrom = useDashboardPreferences((s) => s.customFrom);
  const customTo = useDashboardPreferences((s) => s.customTo);
  const density = useDashboardPreferences((s) => s.density);
  const widgets = useDashboardPreferences((s) => s.widgets);
  const moduleIds = useEffectiveModules();

  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(() => Date.now());

  const base = settings.baseCurrency;
  const period = useMemo(
    () => resolvePeriod(periodId, new Date(), { from: customFrom, to: customTo }),
    [periodId, customFrom, customTo],
  );

  // Point-in-time balances (NOT period-filtered).
  const receivables = useMemo(() => calculateReceivablesBalance(entries, accounts, entities, base), [entries, accounts, entities, base]);
  const payables = useMemo(() => calculatePayablesBalance(entries, accounts, entities, base), [entries, accounts, entities, base]);
  const cash = useMemo(() => calculateCashAndBankBalance(entries, accounts, base), [entries, accounts, base]);

  // Period-sensitive results.
  const netIncome = useMemo(() => calculateNetIncome(entries, accounts, period, base), [entries, accounts, period, base]);
  const topExpenses = useMemo(() => calculateTopExpenses(entries, accounts, period, base), [entries, accounts, period, base]);
  const cashMoves = useMemo(() => calculateCashMovements(entries, accounts, period, base), [entries, accounts, period, base]);
  const incExp = useMemo(() => calculateIncomeExpenseSeries(entries, accounts, period, base), [entries, accounts, period, base]);

  const activity = useMemo(() => getRecentAccountingActivity(entries, entities, accounts), [entries, entities, accounts]);
  const attention = useMemo(() => getDashboardAttentionItems(entries, accounts, entities), [entries, accounts, entities]);

  const jStats = useMemo(() => computeJournalStats(entries), [entries]);
  const warningCount = useMemo(
    () => validateChart(accounts).filter((i) => i.severity === 'warning').length,
    [accounts],
  );
  const postedThisPeriod = useMemo(
    () => postedEntries(entries).filter((e) => e.entryDate >= period.from && e.entryDate <= period.to).length,
    [entries, period],
  );
  const customers = entities.filter((e) => e.entityType === 'customer' || e.entityType === 'both').length;
  const suppliers = entities.filter((e) => e.entityType === 'supplier' || e.entityType === 'both').length;
  const activeAccounts = accounts.filter((a) => a.isActive).length;
  const lastPostedDate = useMemo(
    () => postedEntries(entries).reduce((max, e) => (e.entryDate > max ? e.entryDate : max), ''),
    [entries],
  );

  const go = setActiveView;

  const widgetNodes: Record<DashboardWidgetId, ReactNode> = {
    'financial-summary': <FinancialSummary receivables={receivables} payables={payables} cash={cash} netIncome={netIncome} currency={base} go={go} />,
    'operational-status': <OperationalStatus drafts={jStats.draftEntries} unbalanced={jStats.unbalancedDrafts} postedThisPeriod={postedThisPeriod} warnings={warningCount} customers={customers} suppliers={suppliers} go={go} />,
    'cash-flow': <CashFlow series={cashMoves} currency={base} />,
    'income-expense': <IncomeExpense series={incExp} net={netIncome} currency={base} />,
    'receivables': <Receivables data={receivables} currency={base} go={go} />,
    'payables': <Payables data={payables} currency={base} go={go} />,
    'top-expenses': <TopExpenses items={topExpenses} currency={base} go={go} />,
    'bank-accounts': <BankAccounts cash={cash} currency={base} go={go} />,
    'attention-required': <AttentionRequired items={attention} go={go} />,
    'recent-activity': <RecentActivity items={activity} go={go} />,
    'business-overview': <BusinessOverview settings={settings} activeAccounts={activeAccounts} customers={customers} suppliers={suppliers} lastPostedDate={lastPostedDate} />,
  };

  const visible = [...widgets]
    .filter((w) => w.visible && canShowDashboardWidget(moduleIds, w.id))
    .sort((a, b) => a.order - b.order);

  return (
    <>
      <PageActions>
        <DashboardHeaderActions
          lastRefreshed={lastRefreshed}
          onRefresh={() => setLastRefreshed(Date.now())}
          onCustomize={() => setCustomizeOpen(true)}
          go={go}
        />
      </PageActions>

      <div className={cn('grid grid-cols-1 lg:grid-cols-6', density === 'compact' ? 'gap-3' : 'gap-4')}>
        {visible.map((w) => (
          <div key={w.id} className={COL_SPAN[w.id]}>
            {widgetNodes[w.id]}
          </div>
        ))}
      </div>

      <CustomizePanel open={customizeOpen} onClose={() => setCustomizeOpen(false)} />
    </>
  );
}

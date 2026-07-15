import { useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowRight,
  ArrowDownLeft,
  ArrowUpRight,
  Wallet,
  Landmark,
  Users,
  Truck,
  TrendingUp,
  TrendingDown,
  FileEdit,
  Scale,
  CheckCircle2,
  AlertTriangle,
  BadgeInfo,
  BookOpenText,
  Coins,
  Receipt,
  ShieldCheck,
  CircleDot,
  BarChart3,
  ListChecks,
} from 'lucide-react';
import type { ViewKey } from '@/types';
import type { CompanySettings } from '@/types';
import type {
  ActivityItem,
  AttentionItem,
  CashAndBankSummary,
  CashMovementSeries,
  IncomeExpensePoint,
  NetIncomeSummary,
  PayablesSummary,
  ReceivablesSummary,
  TopExpenseItem,
} from '@/types/dashboard';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { formatCurrency, formatCurrencyCompact, formatPercent } from '@/lib/money';
import { timeAgo, formatDate, cn } from '@/lib/utils';

type Go = (view: ViewKey) => void;

/* ─────────────────────────── Principal summary cards ─────────────────────── */

function SummaryCard({
  icon: Icon,
  tone,
  label,
  amount,
  currency,
  rows,
  footer,
}: {
  icon: LucideIcon;
  tone: string;
  label: string;
  amount: number;
  currency: string;
  rows: { label: string; value: string; tone?: string }[];
  footer: ReactNode;
}) {
  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-center justify-between">
        <span className={cn('flex h-9 w-9 items-center justify-center rounded-lg', tone)}>
          <Icon className="h-5 w-5" />
        </span>
      </div>
      <p className="mt-3 text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-0.5 truncate text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50" title={formatCurrency(amount, currency)}>
        {formatCurrencyCompact(amount, currency)}
      </p>
      <dl className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-xs dark:border-slate-800">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-2">
            <dt className="text-slate-400">{r.label}</dt>
            <dd className={cn('font-medium tabular-nums text-slate-700 dark:text-slate-200', r.tone)}>{r.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3">{footer}</div>
    </Card>
  );
}

export function FinancialSummary({
  receivables,
  payables,
  cash,
  netIncome,
  currency,
  go,
}: {
  receivables: ReceivablesSummary;
  payables: PayablesSummary;
  cash: CashAndBankSummary;
  netIncome: NetIncomeSummary;
  currency: string;
  go: Go;
}) {
  const netTone = netIncome.net >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
  const trendUp = netIncome.previousNet !== null && netIncome.net >= netIncome.previousNet;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <SummaryCard
        icon={ArrowDownLeft}
        tone="bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300"
        label="Total receivables"
        amount={receivables.total}
        currency={currency}
        rows={[
          { label: 'Current', value: formatCurrency(receivables.current, currency) },
          { label: 'Overdue', value: receivables.agingAvailable ? formatCurrency(receivables.overdue, currency) : '—' },
          { label: 'Customers with balances', value: String(receivables.customerCount) },
        ]}
        footer={<LinkAction label="View receivables" onClick={() => go('customers')} />}
      />
      <SummaryCard
        icon={ArrowUpRight}
        tone="bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300"
        label="Total payables"
        amount={payables.total}
        currency={currency}
        rows={[
          { label: 'Current', value: formatCurrency(payables.current, currency) },
          { label: 'Overdue', value: payables.agingAvailable ? formatCurrency(payables.overdue, currency) : '—' },
          { label: 'Suppliers with balances', value: String(payables.supplierCount) },
        ]}
        footer={<LinkAction label="View payables" onClick={() => go('suppliers')} />}
      />
      <SummaryCard
        icon={Wallet}
        tone="bg-cyan-50 text-cyan-600 dark:bg-cyan-500/10 dark:text-cyan-300"
        label="Cash & bank"
        amount={cash.total}
        currency={currency}
        rows={[
          { label: 'Bank', value: formatCurrency(cash.bank, currency) },
          { label: 'Cash on hand', value: formatCurrency(cash.cashOnHand, currency) },
          { label: 'Active accounts', value: String(cash.accountCount) },
        ]}
        footer={<LinkAction label="View accounts" onClick={() => go('tree')} />}
      />
      <SummaryCard
        icon={netIncome.net >= 0 ? TrendingUp : TrendingDown}
        tone={netIncome.net >= 0 ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300'}
        label="Net income (period)"
        amount={netIncome.net}
        currency={currency}
        rows={[
          { label: 'Income', value: formatCurrency(netIncome.income, currency) },
          { label: 'Expenses', value: formatCurrency(netIncome.expenses, currency) },
          { label: 'Margin', value: netIncome.income > 0 ? formatPercent(netIncome.marginPct) : '—', tone: netTone },
        ]}
        footer={
          netIncome.previousNet !== null ? (
            <span className={cn('inline-flex items-center gap-1 text-xs font-medium', trendUp ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
              {trendUp ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
              vs prev {formatCurrency(netIncome.previousNet, currency)}
            </span>
          ) : (
            <span className="text-xs text-slate-400">No prior period to compare</span>
          )
        }
      />
    </div>
  );
}

function LinkAction({ label, onClick, disabled }: { label: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'focus-ring inline-flex items-center gap-1 rounded text-xs font-medium transition-colors',
        disabled ? 'cursor-not-allowed text-slate-300 dark:text-slate-600' : 'text-brand-600 hover:text-brand-700 dark:text-brand-300',
      )}
    >
      {label} {!disabled && <ArrowRight className="h-3.5 w-3.5" />}
      {disabled && <span className="rounded bg-slate-100 px-1 text-[9px] font-semibold uppercase text-slate-400 dark:bg-slate-800">Soon</span>}
    </button>
  );
}

/* ─────────────────────────── Operational status strip ────────────────────── */

export function OperationalStatus({
  drafts,
  unbalanced,
  postedThisPeriod,
  warnings,
  customers,
  suppliers,
  go,
}: {
  drafts: number;
  unbalanced: number;
  postedThisPeriod: number;
  warnings: number;
  customers: number;
  suppliers: number;
  go: Go;
}) {
  const items: { icon: LucideIcon; label: string; value: number; tone: string; onClick?: () => void }[] = [
    { icon: FileEdit, label: 'Draft entries', value: drafts, tone: 'text-amber-500', onClick: () => go('journal') },
    { icon: Scale, label: 'Unbalanced drafts', value: unbalanced, tone: unbalanced > 0 ? 'text-red-500' : 'text-emerald-500', onClick: () => go('journal') },
    { icon: CheckCircle2, label: 'Posted (period)', value: postedThisPeriod, tone: 'text-emerald-500', onClick: () => go('journal') },
    { icon: AlertTriangle, label: 'Validation warnings', value: warnings, tone: warnings > 0 ? 'text-amber-500' : 'text-emerald-500', onClick: () => go('mapping') },
    { icon: Users, label: 'Customers', value: customers, tone: 'text-brand-500', onClick: () => go('customers') },
    { icon: Truck, label: 'Suppliers', value: suppliers, tone: 'text-brand-500', onClick: () => go('suppliers') },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 rounded-xl border border-slate-200/80 bg-white p-2 shadow-card dark:border-slate-800 dark:bg-slate-900 sm:grid-cols-3 lg:grid-cols-6">
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          onClick={it.onClick}
          className="focus-ring flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60"
        >
          <it.icon className={cn('h-4 w-4 shrink-0', it.tone)} />
          <span className="min-w-0">
            <span className="block text-lg font-semibold leading-none text-slate-800 dark:text-slate-100">{it.value}</span>
            <span className="block truncate text-[11px] text-slate-400">{it.label}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/* ─────────────────────────────── Bar chart ──────────────────────────────── */

function GroupedBars({
  data,
  currency,
  labelA,
  labelB,
}: {
  data: { label: string; a: number; b: number }[];
  currency: string;
  labelA: string;
  labelB: string;
}) {
  const max = Math.max(1, ...data.map((d) => Math.max(d.a, d.b)));
  if (data.every((d) => d.a === 0 && d.b === 0)) {
    return <p className="py-8 text-center text-sm text-slate-400">No transactions in the selected period.</p>;
  }
  return (
    <div>
      <div className="flex items-end gap-3 overflow-x-auto pb-1" style={{ height: '9rem' }} role="img" aria-label={`${labelA} vs ${labelB} by month`}>
        {data.map((d) => (
          <div key={d.label} className="flex min-w-[2.5rem] flex-1 flex-col items-center justify-end gap-1">
            <div className="flex h-full w-full items-end justify-center gap-1">
              <div
                className="w-2.5 rounded-t bg-emerald-400 dark:bg-emerald-500/80"
                style={{ height: `${(d.a / max) * 100}%` }}
                title={`${d.label} · ${labelA}: ${formatCurrency(d.a, currency)}`}
              />
              <div
                className="w-2.5 rounded-t bg-red-400 dark:bg-red-500/80"
                style={{ height: `${(d.b / max) * 100}%` }}
                title={`${d.label} · ${labelB}: ${formatCurrency(d.b, currency)}`}
              />
            </div>
            <span className="text-[10px] text-slate-400">{d.label}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-4 text-[11px] text-slate-500">
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-400" /> {labelA}</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-red-400" /> {labelB}</span>
      </div>
    </div>
  );
}

/* ──────────────────────────────── Cash flow ─────────────────────────────── */

export function CashFlow({ series, currency }: { series: CashMovementSeries; currency: string }) {
  return (
    <Card>
      <CardHeader title="Cash flow" description="Cash and bank account movements (provisional until an IAS 7 engine exists)." />
      <CardBody className="space-y-4">
        <GroupedBars
          data={series.points.map((p) => ({ label: p.label, a: p.inflow, b: p.outflow }))}
          currency={currency}
          labelA="Cash in"
          labelB="Cash out"
        />
        <div className="grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 text-sm dark:border-slate-800 sm:grid-cols-4">
          <Stat label="Opening" value={formatCurrency(series.openingBalance, currency)} />
          <Stat label="Inflows" value={formatCurrency(series.totalInflow, currency)} tone="text-emerald-600 dark:text-emerald-400" />
          <Stat label="Outflows" value={formatCurrency(series.totalOutflow, currency)} tone="text-red-600 dark:text-red-400" />
          <Stat label="Closing" value={formatCurrency(series.closingBalance, currency)} strong />
        </div>
      </CardBody>
    </Card>
  );
}

function Stat({ label, value, tone, strong }: { label: string; value: string; tone?: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={cn('font-mono tabular-nums', strong ? 'font-semibold text-slate-900 dark:text-slate-50' : 'text-slate-700 dark:text-slate-200', tone)}>{value}</p>
    </div>
  );
}

/* ──────────────────────────── Income & expenses ─────────────────────────── */

export function IncomeExpense({
  series,
  net,
  currency,
}: {
  series: IncomeExpensePoint[];
  net: NetIncomeSummary;
  currency: string;
}) {
  const [tab, setTab] = useState<'chart' | 'summary'>('chart');
  return (
    <Card>
      <CardHeader
        title="Income and expenses"
        actions={
          <div className="flex rounded-lg border border-slate-200 p-0.5 text-xs dark:border-slate-700">
            {(['chart', 'summary'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn('flex items-center gap-1 rounded-md px-2.5 py-1 font-medium capitalize transition-colors', tab === t ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-200')}
              >
                {t === 'chart' ? <BarChart3 className="h-3.5 w-3.5" /> : <ListChecks className="h-3.5 w-3.5" />}
                {t}
              </button>
            ))}
          </div>
        }
      />
      <CardBody>
        {tab === 'chart' ? (
          <GroupedBars
            data={series.map((p) => ({ label: p.label, a: p.income, b: p.expenses }))}
            currency={currency}
            labelA="Income"
            labelB="Expenses"
          />
        ) : (
          <dl className="grid grid-cols-2 gap-4">
            <Stat label="Total income" value={formatCurrency(net.income, currency)} tone="text-emerald-600 dark:text-emerald-400" />
            <Stat label="Total expenses" value={formatCurrency(net.expenses, currency)} tone="text-red-600 dark:text-red-400" />
            <Stat label="Net income" value={formatCurrency(net.net, currency)} strong />
            <Stat label="Net margin" value={net.income > 0 ? formatPercent(net.marginPct) : '—'} />
          </dl>
        )}
      </CardBody>
    </Card>
  );
}

/* ────────────────────────── Receivables / payables ──────────────────────── */

function ArApPanel({
  title,
  total,
  current,
  count,
  countLabel,
  top,
  agingLabel,
  currency,
  onView,
}: {
  title: string;
  total: number;
  current: number;
  count: number;
  countLabel: string;
  top: { entityId: string; name: string; amount: number }[];
  agingLabel: string;
  currency: string;
  onView: () => void;
}) {
  return (
    <Card>
      <CardHeader title={title} actions={<Button variant="ghost" size="sm" onClick={onView}>View <ArrowRight className="h-4 w-4" /></Button>} />
      <CardBody className="space-y-4">
        <div>
          <p className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">{formatCurrency(total, currency)}</p>
          <p className="text-xs text-slate-400">{current === total ? 'All current' : `${formatCurrency(current, currency)} current`} · {count} {countLabel}</p>
        </div>
        {/* Aging placeholder */}
        <div>
          <div className="flex h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div className="h-full bg-brand-400" style={{ width: '100%' }} />
          </div>
          <p className="mt-1 text-[11px] text-slate-400">{agingLabel}</p>
        </div>
        {top.length > 0 ? (
          <ul className="space-y-1.5">
            {top.map((t) => (
              <li key={t.entityId} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate text-slate-700 dark:text-slate-200">{t.name}</span>
                <span className="font-mono tabular-nums text-slate-800 dark:text-slate-100">{formatCurrency(t.amount, currency)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-400">No outstanding balances.</p>
        )}
      </CardBody>
    </Card>
  );
}

export function Receivables({ data, currency, go }: { data: ReceivablesSummary; currency: string; go: Go }) {
  return (
    <ArApPanel
      title="Receivables"
      total={data.total}
      current={data.current}
      count={data.customerCount}
      countLabel="customers"
      top={data.topBalances}
      agingLabel="Aging available after invoicing is enabled"
      currency={currency}
      onView={() => go('customers')}
    />
  );
}

export function Payables({ data, currency, go }: { data: PayablesSummary; currency: string; go: Go }) {
  return (
    <ArApPanel
      title="Payables"
      total={data.total}
      current={data.current}
      count={data.supplierCount}
      countLabel="suppliers"
      top={data.topBalances}
      agingLabel="Aging available after bills are enabled"
      currency={currency}
      onView={() => go('suppliers')}
    />
  );
}

/* ─────────────────────────────── Top expenses ───────────────────────────── */

export function TopExpenses({ items, currency, go }: { items: TopExpenseItem[]; currency: string; go: Go }) {
  return (
    <Card>
      <CardHeader title="Top expenses" description="Largest expense categories for the period." />
      <CardBody>
        {items.length === 0 ? (
          <EmptyState icon={Receipt} compact title="No expenses in this period." description="Posted expense entries will appear here." />
        ) : (
          <ul className="space-y-3">
            {items.map((it) => (
              <li key={it.accountId}>
                <button
                  type="button"
                  onClick={() => go('journal')}
                  className="focus-ring block w-full text-left"
                >
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate font-medium text-slate-700 dark:text-slate-200">
                      {it.code && <span className="mr-1.5 font-mono text-xs text-slate-400">{it.code}</span>}
                      {it.name}
                    </span>
                    <span className="font-mono tabular-nums text-slate-800 dark:text-slate-100">{formatCurrency(it.amount, currency)}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                      <div className={cn('h-full rounded-full', it.isOther ? 'bg-slate-300 dark:bg-slate-600' : 'bg-gradient-to-r from-brand-400 to-brand-600')} style={{ width: `${it.pctOfTotal}%` }} />
                    </div>
                    <span className="w-10 text-right text-[11px] tabular-nums text-slate-400">{it.pctOfTotal.toFixed(0)}%</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/* ────────────────────────── Bank & cash accounts ────────────────────────── */

export function BankAccounts({ cash, currency, go }: { cash: CashAndBankSummary; currency: string; go: Go }) {
  return (
    <Card>
      <CardHeader title="Bank and cash accounts" description="Active cash & cash-equivalent accounts." />
      <CardBody className="p-0">
        {cash.accounts.length === 0 ? (
          <div className="p-5"><EmptyState icon={Landmark} compact title="No cash accounts." description="Add cash/bank accounts in the Chart of Accounts." /></div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {cash.accounts.map((a) => (
              <li key={a.accountId} className="flex items-center gap-3 px-5 py-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cyan-50 text-cyan-500 dark:bg-cyan-500/10 dark:text-cyan-300">
                  <Coins className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                    <span className="mr-1.5 font-mono text-xs text-slate-400">{a.code}</span>{a.name}
                  </p>
                  <p className="text-xs text-slate-400">
                    {a.lastActivity ? `Last activity ${formatDate(a.lastActivity)}` : 'No activity yet'} · Reconciliation —
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-mono text-sm font-semibold tabular-nums text-slate-800 dark:text-slate-100">{formatCurrency(a.balance, currency)}</p>
                  <div className="mt-0.5 flex items-center justify-end gap-2">
                    <button type="button" onClick={() => go('journal')} className="focus-ring rounded text-[11px] font-medium text-brand-600 hover:underline dark:text-brand-300">Transactions</button>
                    <span className="rounded bg-slate-100 px-1 text-[9px] font-semibold uppercase text-slate-400 dark:bg-slate-800">Reconcile soon</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/* ────────────────────────────── Attention ───────────────────────────────── */

const SEV_META = {
  error: { icon: AlertTriangle, tone: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300', badge: 'red' as const },
  warning: { icon: AlertTriangle, tone: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300', badge: 'amber' as const },
  info: { icon: BadgeInfo, tone: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300', badge: 'slate' as const },
};

export function AttentionRequired({ items, go }: { items: AttentionItem[]; go: Go }) {
  return (
    <Card>
      <CardHeader title="Attention required" description="Actionable items across your books." />
      <CardBody className={items.length === 0 ? '' : 'p-0'}>
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-50 text-emerald-500 dark:bg-emerald-500/10 dark:text-emerald-300">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Everything looks in order.</p>
            <p className="text-xs text-slate-400">No unbalanced drafts, stale entries or validation issues.</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.slice(0, 8).map((it) => {
              const meta = SEV_META[it.severity];
              return (
                <li key={it.id} className="flex items-start gap-3 px-5 py-3">
                  <span className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full', meta.tone)}>
                    <meta.icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-slate-700 dark:text-slate-200">{it.message}</p>
                    <p className="text-[11px] text-slate-400">{it.record}</p>
                  </div>
                  {it.action && (
                    <button type="button" onClick={() => go(it.action as ViewKey)} className="focus-ring shrink-0 rounded text-xs font-medium text-brand-600 hover:underline dark:text-brand-300">
                      Review
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/* ─────────────────────────────── Recent activity ────────────────────────── */

const ACTIVITY_ICON: Record<ActivityItem['kind'], LucideIcon> = {
  created: BookOpenText,
  edited: FileEdit,
  posted: CheckCircle2,
  voided: AlertTriangle,
  customer: Users,
  supplier: Truck,
  account: CircleDot,
};

export function RecentActivity({ items, go }: { items: ActivityItem[]; go: Go }) {
  return (
    <Card>
      <CardHeader title="Recent activity" actions={<Button variant="ghost" size="sm" onClick={() => go('journal')}>Open journal <ArrowRight className="h-4 w-4" /></Button>} />
      <CardBody className="p-0">
        {items.length === 0 ? (
          <div className="p-5"><EmptyState icon={BookOpenText} compact title="No recent activity." /></div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((it) => {
              const Icon = ACTIVITY_ICON[it.kind];
              return (
                <li key={it.id}>
                  <button
                    type="button"
                    onClick={() => it.entryId && go('journal')}
                    disabled={!it.entryId}
                    className={cn('flex w-full items-center gap-3 px-5 py-2.5 text-left', it.entryId && 'transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50')}
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-slate-800 dark:text-slate-100">{it.title}<span className="text-slate-400"> · {it.detail}</span></span>
                      <span className="block text-[11px] text-slate-400">{timeAgo(it.at)} · {it.actor}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/* ────────────────────────────── Business overview ───────────────────────── */

export function BusinessOverview({
  settings,
  activeAccounts,
  customers,
  suppliers,
  lastPostedDate,
}: {
  settings: CompanySettings;
  activeAccounts: number;
  customers: number;
  suppliers: number;
  lastPostedDate: string;
}) {
  const frameworkLabel: Record<string, string> = { IFRS: 'IFRS', IFRS_FOR_SMES: 'IFRS for SMEs', US_GAAP: 'US GAAP', OTHER: 'Local GAAP' };
  const rows: { label: string; value: string }[] = [
    { label: 'Company', value: settings.tradingName || settings.companyName },
    { label: 'Base currency', value: settings.baseCurrency },
    { label: 'Framework', value: frameworkLabel[settings.reportingFramework] ?? settings.reportingFramework },
    { label: 'Basis', value: settings.accountingBasis === 'cash' ? 'Cash' : 'Accrual' },
    { label: 'Tax registered', value: settings.taxRegistered ? settings.taxRegistrationNumber || 'Yes' : 'No' },
    { label: 'Active accounts', value: String(activeAccounts) },
    { label: 'Customers', value: String(customers) },
    { label: 'Suppliers', value: String(suppliers) },
    { label: 'Last posted entry', value: lastPostedDate ? formatDate(lastPostedDate) : '—' },
  ];
  return (
    <Card>
      <CardHeader title="Business overview" />
      <CardBody className="space-y-2 text-sm">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-3 border-b border-slate-100 pb-2 last:border-0 dark:border-slate-800">
            <span className="text-slate-500 dark:text-slate-400">{r.label}</span>
            <span className="truncate text-right font-medium text-slate-800 dark:text-slate-100">{r.value}</span>
          </div>
        ))}
      </CardBody>
    </Card>
  );
}

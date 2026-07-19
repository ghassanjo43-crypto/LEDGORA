import { useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck,
  AlertTriangle,
  Users,
  Building2,
  CalendarClock,
  LayoutDashboard,
  Package,
  FileText,
  Ban,
  RefreshCw,
  Gauge,
} from 'lucide-react';
import type { SubscriptionStatus } from '@/types/subscription';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useStore } from '@/store/useStore';
import { useBillingStore } from '@/store/billingStore';
import {
  useActivePlan,
  useInvoices,
  useIsAdmin,
  useOpenInvoice,
  useRenewalReminder,
} from '@/store/billingHooks';
import { statusIsActive } from '@/lib/entitlementResolution';
import { EDITION_INFO } from '@/config/editionCommercialInfo';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { EditionBadge } from '@/components/entitlements/EditionBadge';
import { PlanCatalog } from '@/components/billing/PlanCatalog';
import { SubscriptionInvoicePanel } from '@/components/billing/SubscriptionInvoicePanel';
import { InvoiceHistoryList } from '@/components/billing/InvoiceHistoryList';
import { UsageDashboard } from '@/components/metering/UsageDashboard';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import { useIsFreeDemo } from '@/hooks/useSession';

const STATUS_META: Record<SubscriptionStatus, { label: string; tone: 'green' | 'amber' | 'red' | 'slate' }> = {
  trial: { label: 'Trial', tone: 'amber' },
  active: { label: 'Active', tone: 'green' },
  'past-due': { label: 'Past due', tone: 'amber' },
  suspended: { label: 'Suspended', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: 'red' },
  expired: { label: 'Expired', tone: 'red' },
};

type BillingTabId = 'overview' | 'packages' | 'usage' | 'invoices';

export interface SubscriptionSettingsPageProps {
  /** Open a specific tab first (onboarding opens the package catalogue). */
  initialTab?: BillingTabId;
  /**
   * Onboarding presentation: hide administration entry points, usage metering
   * and development controls, and keep only public package selection plus the
   * invoice/payment steps that follow it.
   */
  onboardingMode?: boolean;
}

/** Tabbed subscription & package-management centre (subscriber-facing). */
export function SubscriptionSettingsPage({
  initialTab = 'overview',
  onboardingMode = false,
}: SubscriptionSettingsPageProps = {}) {
  const [tab, setTab] = useState<BillingTabId>(initialTab);
  const [flowInvoiceId, setFlowInvoiceId] = useState<string | null>(null);
  const isDemo = useIsFreeDemo();
  // Platform-administration entry points are never shown during onboarding, in
  // a Free Demo, or to an ordinary customer.
  const isAdmin = useIsAdmin() && !onboardingMode && !isDemo;
  const openInvoice = useOpenInvoice();
  const invoices = useInvoices();

  // Seed packages / settings and apply expiry+grace transitions on first view.
  useEffect(() => {
    useBillingStore.getState().ensureSeeded();
  }, []);

  const flowInvoice = useMemo(() => {
    if (flowInvoiceId) return invoices.find((i) => i.id === flowInvoiceId) ?? null;
    return openInvoice;
  }, [flowInvoiceId, invoices, openInvoice]);

  const tabs: TabItem<BillingTabId>[] = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'packages', label: 'Packages', icon: Package },
    // Usage metering is infrastructure detail — not part of package selection.
    ...(onboardingMode || isDemo ? [] : [{ id: 'usage' as const, label: 'Usage', icon: Gauge }]),
    { id: 'invoices', label: 'Invoices', icon: FileText },
  ];

  return (
    <div className="space-y-4">
      {isDemo && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          You are in the Free Demo. Choosing a package starts a real subscription request; the demo
          workspace is temporary and is not carried over.
        </div>
      )}
      {isAdmin && (
        <div className="flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50/60 px-3 py-2 text-xs text-indigo-800 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-200">
          <ShieldCheck className="h-3.5 w-3.5" />
          Platform administration — payment verification, packages, metering and entitlements — is in the
          <button className="font-semibold underline hover:no-underline" onClick={() => useStore.getState().setActiveView('super-admin')}>Super Admin console</button>.
        </div>
      )}
      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'overview' && (
        <SubscriptionOverview
          onChangePackage={() => setTab('packages')}
          onOpenInvoice={() => setTab('invoices')}
        />
      )}

      {tab === 'packages' && (
        <PlanCatalog
          onInvoiceIssued={(id) => {
            setFlowInvoiceId(id);
            setTab('invoices');
          }}
        />
      )}

      {tab === 'usage' && !onboardingMode && !isDemo && <UsageDashboard />}

      {tab === 'invoices' && (
        <div className="space-y-4">
          {flowInvoice ? (
            <SubscriptionInvoicePanel invoice={flowInvoice} />
          ) : (
            <Card>
              <CardBody className="flex flex-col items-center gap-2 py-8 text-center">
                <FileText className="h-6 w-6 text-slate-400" />
                <p className="text-sm font-medium text-slate-700 dark:text-slate-200">No open subscription invoice</p>
                <p className="text-xs text-slate-400">Choose a package to start a subscription request.</p>
                <Button variant="primary" size="sm" onClick={() => setTab('packages')}>Browse packages</Button>
              </CardBody>
            </Card>
          )}
          <InvoiceHistoryList />
        </div>
      )}

    </div>
  );
}

/* ── Overview ─────────────────────────────────────────────────────────────── */

function SubscriptionOverview({
  onChangePackage,
  onOpenInvoice,
}: {
  onChangePackage: () => void;
  onOpenInvoice: () => void;
}) {
  const subscription = useEntitlementStore((s) => s.subscription);
  const activePlan = useActivePlan();
  const reminder = useRenewalReminder();
  const cancelSubscription = useBillingStore((s) => s.cancelSubscription);
  const statusMeta = STATUS_META[subscription.status];
  const active = statusIsActive(subscription.status);
  const info = EDITION_INFO[subscription.edition];

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <EditionBadge />
                <Badge tone={statusMeta.tone}>
                  {active ? <ShieldCheck className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                  {statusMeta.label}
                </Badge>
              </div>
              <p className="mt-1.5 max-w-xl text-sm text-slate-500 dark:text-slate-400">{info?.description}</p>
              {activePlan && (
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                  Current package: <span className="font-medium">{activePlan.name}</span> ·{' '}
                  {formatCurrency(activePlan.priceMonthly, activePlan.currency)}/month
                </p>
              )}
            </div>
            <div className="flex flex-col items-end gap-2">
              <Button variant="primary" size="sm" onClick={onChangePackage}><Package className="h-4 w-4" /> Change package</Button>
              {subscription.status !== 'cancelled' && (
                <Button variant="ghost" size="sm" onClick={() => cancelSubscription('Requested by administrator')}>
                  <Ban className="h-4 w-4" /> Cancel subscription
                </Button>
              )}
            </div>
          </div>

          {reminder && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              <RefreshCw className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="flex-1">
                <p className="font-medium">{reminder.title}</p>
                <p className="opacity-90">{reminder.message}</p>
              </div>
              <Button variant="outline" size="sm" onClick={onChangePackage}>Renew</Button>
            </div>
          )}

          <dl className="grid grid-cols-2 gap-3 border-t border-slate-100 pt-4 dark:border-slate-800 sm:grid-cols-4">
            <Stat icon={CalendarClock} label="Started" value={subscription.startsAt ? formatDate(subscription.startsAt) : '—'} />
            <Stat icon={CalendarClock} label="Expires" value={subscription.expiresAt ? formatDate(subscription.expiresAt) : 'No expiry'} />
            <Stat icon={Users} label="User limit" value={String(subscription.userLimit)} />
            <Stat icon={Building2} label="Entity limit" value={String(subscription.entityLimit)} />
          </dl>

          {subscription.bankRemittanceReference && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Last bank-remittance reference: <span className="font-mono">{subscription.bankRemittanceReference}</span>
            </p>
          )}
        </CardBody>
      </Card>

      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={onOpenInvoice}><FileText className="h-4 w-4" /> View invoices</Button>
      </div>
    </div>
  );
}


function Stat({ icon: Icon, label, value }: { icon: typeof Users; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
      <div>
        <dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt>
        <dd className="text-sm font-medium text-slate-800 dark:text-slate-100">{value}</dd>
      </div>
    </div>
  );
}

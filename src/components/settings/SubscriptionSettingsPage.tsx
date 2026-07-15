import { useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck,
  AlertTriangle,
  Users,
  Building2,
  CalendarClock,
  History,
  LayoutDashboard,
  Package,
  FileText,
  ClipboardCheck,
  Settings2,
  Ban,
  RefreshCw,
  FlaskConical,
  Gauge,
  Server,
} from 'lucide-react';
import type { SubscriptionStatus } from '@/types/subscription';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useEffectiveModules } from '@/store/entitlementHooks';
import { useBillingStore } from '@/store/billingStore';
import {
  useActivePlan,
  useInvoices,
  useIsAdmin,
  useOpenInvoice,
  usePendingVerificationCount,
  useRenewalReminder,
} from '@/store/billingHooks';
import { useSessionStore } from '@/store/sessionStore';
import { statusIsActive } from '@/lib/entitlementResolution';
import { EDITION_INFO } from '@/config/editionCommercialInfo';
import { MODULE_BY_ID } from '@/config/modules';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { EditionBadge } from '@/components/entitlements/EditionBadge';
import { DevelopmentEditionSwitcher, devToolsEnabled } from '@/components/entitlements/DevelopmentEditionSwitcher';
import { EditionSelector } from './EditionSelector';
import { ModuleEntitlementTable } from './ModuleEntitlementTable';
import { BankRemittanceActivationPanel } from './BankRemittanceActivationPanel';
import { PlanCatalog } from '@/components/billing/PlanCatalog';
import { SubscriptionInvoicePanel } from '@/components/billing/SubscriptionInvoicePanel';
import { PaymentVerificationPanel } from '@/components/billing/PaymentVerificationPanel';
import { PlanAdminEditor } from '@/components/billing/PlanAdminEditor';
import { BillingSettingsEditor } from '@/components/billing/BillingSettingsEditor';
import { InvoiceHistoryList } from '@/components/billing/InvoiceHistoryList';
import { UsageDashboard } from '@/components/metering/UsageDashboard';
import { InfrastructureCostDashboard } from '@/components/metering/InfrastructureCostDashboard';
import { MeteringConfigEditor } from '@/components/metering/MeteringConfigEditor';
import { UsageLedgerPanel } from '@/components/metering/UsageLedgerPanel';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';

const STATUS_META: Record<SubscriptionStatus, { label: string; tone: 'green' | 'amber' | 'red' | 'slate' }> = {
  trial: { label: 'Trial', tone: 'amber' },
  active: { label: 'Active', tone: 'green' },
  'past-due': { label: 'Past due', tone: 'amber' },
  suspended: { label: 'Suspended', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: 'red' },
  expired: { label: 'Expired', tone: 'red' },
};

const STATUS_OPTIONS = (Object.keys(STATUS_META) as SubscriptionStatus[]).map((s) => ({
  value: s,
  label: STATUS_META[s].label,
}));

type BillingTabId = 'overview' | 'packages' | 'usage' | 'invoices' | 'verify' | 'admin';

/** Tabbed subscription & package-management centre. */
export function SubscriptionSettingsPage() {
  const [tab, setTab] = useState<BillingTabId>('overview');
  const [flowInvoiceId, setFlowInvoiceId] = useState<string | null>(null);
  const isAdmin = useIsAdmin();
  const pending = usePendingVerificationCount();
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
    { id: 'usage', label: 'Usage', icon: Gauge },
    { id: 'invoices', label: 'Invoices', icon: FileText },
    ...(isAdmin ? [{ id: 'verify' as const, label: 'Verify', icon: ClipboardCheck, count: pending }] : []),
    ...(isAdmin ? [{ id: 'admin' as const, label: 'Administration', icon: Settings2 }] : []),
  ];

  return (
    <div className="space-y-4">
      <RoleSwitcher />
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

      {tab === 'usage' && <UsageDashboard />}

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

      {tab === 'verify' && isAdmin && <PaymentVerificationPanel />}

      {tab === 'admin' && isAdmin && (
        <div className="space-y-6">
          <AdminSection icon={Package} title="Packages & payments">
            <PlanAdminEditor />
            <BillingSettingsEditor />
          </AdminSection>
          <AdminSection icon={Server} title="Infrastructure cost recovery">
            <InfrastructureCostDashboard />
          </AdminSection>
          <AdminSection icon={Gauge} title="Usage ledger">
            <UsageLedgerPanel />
          </AdminSection>
          <AdminSection icon={Settings2} title="Metering configuration (super administrator)">
            <MeteringConfigEditor />
          </AdminSection>
          <AdminSection icon={ShieldCheck} title="Entitlements & lifecycle">
            <EntitlementAdminPanel />
          </AdminSection>
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

/* ── Admin section wrapper ────────────────────────────────────────────────── */

function AdminSection({ icon: Icon, title, children }: { icon: typeof Server; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
        <Icon className="h-4 w-4 text-slate-400" /> {title}
      </h2>
      {children}
    </section>
  );
}

/* ── Development role switcher (testing permission checks) ─────────────────── */

function RoleSwitcher() {
  const role = useSessionStore((s) => s.role);
  const setRole = useSessionStore((s) => s.setRole);
  if (!devToolsEnabled()) return null;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-amber-300 bg-amber-50/60 px-2 py-1 text-xs dark:border-amber-500/40 dark:bg-amber-500/5">
      <span className="flex items-center gap-1 font-medium text-amber-700 dark:text-amber-300">
        <FlaskConical className="h-3.5 w-3.5" /> Role
      </span>
      {(['admin', 'member'] as const).map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => setRole(r)}
          className={
            role === r
              ? 'rounded-md bg-white px-2 py-1 font-medium capitalize text-slate-900 shadow-sm dark:bg-slate-800 dark:text-slate-100'
              : 'rounded-md px-2 py-1 capitalize text-slate-500 hover:text-slate-700 dark:text-slate-400'
          }
        >
          {r}
        </button>
      ))}
    </div>
  );
}

/* ── Entitlement & lifecycle administration (existing panel) ──────────────── */

function EntitlementAdminPanel() {
  const subscription = useEntitlementStore((s) => s.subscription);
  const auditTrail = useEntitlementStore((s) => s.auditTrail);
  const owned = useEffectiveModules();
  const setEdition = useEntitlementStore((s) => s.setEdition);
  const setStatus = useEntitlementStore((s) => s.setSubscriptionStatus);
  const suspend = useEntitlementStore((s) => s.suspendSubscription);
  const renew = useEntitlementStore((s) => s.renewSubscription);
  const updateLimits = useEntitlementStore((s) => s.updateLimits);

  const statusMeta = STATUS_META[subscription.status];
  const active = statusIsActive(subscription.status);
  const info = EDITION_INFO[subscription.edition];

  const addOns = useMemo(
    () => subscription.enabledModules.map((m) => MODULE_BY_ID[m]?.name ?? m),
    [subscription.enabledModules],
  );
  const disabled = useMemo(
    () => subscription.disabledModules.map((m) => MODULE_BY_ID[m]?.name ?? m),
    [subscription.disabledModules],
  );
  const recentAudit = useMemo(() => [...auditTrail].reverse().slice(0, 12), [auditTrail]);

  return (
    <div className="space-y-4">
      {/* Overview */}
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
              <p className="mt-1.5 max-w-xl text-sm text-slate-500 dark:text-slate-400">
                {info?.description}
              </p>
            </div>
            <DevelopmentEditionSwitcher />
          </div>

          <dl className="grid grid-cols-2 gap-3 border-t border-slate-100 pt-4 dark:border-slate-800 sm:grid-cols-4">
            <Stat icon={CalendarClock} label="Started" value={subscription.startsAt ? formatDate(subscription.startsAt) : '—'} />
            <Stat icon={CalendarClock} label="Expires" value={subscription.expiresAt ? formatDate(subscription.expiresAt) : 'No expiry'} />
            <Stat icon={Users} label="User limit" value={String(subscription.userLimit)} />
            <Stat icon={Building2} label="Entity limit" value={String(subscription.entityLimit)} />
          </dl>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Enabled add-ons</p>
              {addOns.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {addOns.map((n) => <Badge key={n} tone="teal">{n}</Badge>)}
                </div>
              ) : (
                <p className="mt-1 text-sm text-slate-400">None</p>
              )}
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Disabled modules</p>
              {disabled.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {disabled.map((n) => <Badge key={n} tone="amber">{n}</Badge>)}
                </div>
              ) : (
                <p className="mt-1 text-sm text-slate-400">None</p>
              )}
            </div>
          </div>

          {(subscription.bankRemittanceReference || subscription.adminNotes) && (
            <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
              {subscription.bankRemittanceReference && (
                <p>Bank-remittance reference: <span className="font-mono">{subscription.bankRemittanceReference}</span></p>
              )}
              {subscription.adminNotes && <p>Notes: {subscription.adminNotes}</p>}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Choose edition */}
      <Card>
        <CardHeader title="Edition" description="Which Ledgora edition fits your business? Changing edition re-filters navigation, reports and forms immediately." />
        <CardBody>
          <EditionSelector value={subscription.edition} onSelect={setEdition} />
        </CardBody>
      </Card>

      {/* Modules */}
      <Card>
        <CardHeader title="Modules & add-ons" description="Enable a module as an add-on or disable one. Disabling hides the module and blocks new activity — historical records are always preserved." />
        <CardBody>
          <ModuleEntitlementTable />
        </CardBody>
      </Card>

      {/* Lifecycle / admin */}
      <Card>
        <CardHeader title="Subscription status & activation" description="Development/admin actions. These may move to a backend admin service later." />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">Status</label>
              <Select
                value={subscription.status}
                options={STATUS_OPTIONS}
                onChange={(e) => setStatus(e.target.value as SubscriptionStatus)}
                className="w-44"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => renew()}>Renew</Button>
            <Button variant="outline" size="sm" onClick={() => suspend('Manual admin suspension')}>Suspend</Button>
          </div>

          <div className="flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
            <LimitField
              label="User limit"
              value={subscription.userLimit}
              onCommit={(v) => updateLimits({ userLimit: v })}
            />
            <LimitField
              label="Entity limit"
              value={subscription.entityLimit}
              onCommit={(v) => updateLimits({ entityLimit: v })}
            />
          </div>

          <div className="border-t border-slate-100 pt-4 dark:border-slate-800">
            <BankRemittanceActivationPanel />
          </div>
        </CardBody>
      </Card>

      {/* Audit trail */}
      <Card>
        <CardHeader title="Subscription audit trail" description="Every edition, module and status change is recorded." />
        <CardBody className="p-0">
          {recentAudit.length === 0 ? (
            <div className="flex items-center gap-2 px-5 py-6 text-sm text-slate-400">
              <History className="h-4 w-4" /> No subscription events yet.
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {recentAudit.map((e) => (
                <li key={e.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                  <Badge tone="slate">{e.event}</Badge>
                  <span className="min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300">{e.detail}</span>
                  <span className="shrink-0 text-[11px] text-slate-400">{formatDate(e.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      <p className="px-1 text-[11px] text-slate-400">
        {owned.length} module{owned.length === 1 ? '' : 's'} currently owned by this organization.
      </p>
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

function LimitField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-500">{label}</label>
      <input
        type="number"
        min={1}
        defaultValue={value}
        key={value}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v) && v >= 1 && v !== value) onCommit(Math.floor(v));
        }}
        className="focus-ring h-9 w-32 rounded-lg border border-slate-300 bg-white px-2.5 text-sm dark:border-slate-700 dark:bg-slate-900"
      />
    </div>
  );
}

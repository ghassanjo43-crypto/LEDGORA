/**
 * Platform Super-Administrator console.
 *
 * A single, clearly-separated place for Ledgora platform staff (NOT tenant
 * subscribers) to see subscribers, verify payments, edit packages/pricing, and
 * manage metering + infrastructure cost. Access is gated to the platform
 * super-administrator role (`sessionStore.role === 'admin'`); regular
 * subscribers never see this view or its sidebar entry.
 */
import { useMemo, useState } from 'react';
import { useSessionStore } from '@/store/sessionStore';
import { useIsPlatformAdmin, usePlatformAccess } from '@/hooks/usePlatformRole';
import { usePendingVerificationCount } from '@/store/billingHooks';
import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { SubscribersPanel } from '@/components/admin/SubscribersPanel';
import { PaymentVerificationPanel } from '@/components/billing/PaymentVerificationPanel';
import { PlanAdminEditor } from '@/components/billing/PlanAdminEditor';
import { BillingSettingsEditor } from '@/components/billing/BillingSettingsEditor';
import { InfrastructureCostDashboard } from '@/components/metering/InfrastructureCostDashboard';
import { MeteringConfigEditor } from '@/components/metering/MeteringConfigEditor';
import { UsageLedgerPanel } from '@/components/metering/UsageLedgerPanel';
import { EntitlementAdminPanel } from '@/components/admin/EntitlementAdminPanel';
import { Building2, ClipboardCheck, Package, Server, ShieldAlert, ShieldCheck } from 'lucide-react';

type ConsoleTab = 'subscribers' | 'payments' | 'packages' | 'metering' | 'entitlements';

export function SuperAdminConsolePage() {
  // Effective capability. In a production build this is always false, so the
  // console refuses to render regardless of what the browser has stored.
  // The console renders only when a role actually applies: confirmed by the
  // backend session in production, or simulated on a local dev server.
  const { verifiedByBackend, resolving } = usePlatformAccess();
  const isAdmin = useIsPlatformAdmin();
  const setRole = useSessionStore((s) => s.setPlatformRole);
  const pending = usePendingVerificationCount();
  const [tab, setTab] = useState<ConsoleTab>('subscribers');

  const tabs: TabItem<ConsoleTab>[] = useMemo(() => [
    { id: 'subscribers', label: 'Subscribers', icon: Building2 },
    { id: 'payments', label: 'Payments', icon: ClipboardCheck, count: pending },
    { id: 'packages', label: 'Packages & pricing', icon: Package },
    { id: 'metering', label: 'Metering & infra cost', icon: Server },
    { id: 'entitlements', label: 'Entitlements', icon: ShieldCheck },
  ], [pending]);

  // Never paint the console while the server check is still in flight.
  if (resolving) return null;

  if (!isAdmin) {
    return (
      <Alert variant="error" title="Platform super-administrator only">
        This console is for Ledgora platform staff. Your subscriber account cannot access it.
      </Alert>
    );
  }

  return (
    <div className="space-y-5">
      {/* Be explicit about WHERE this authority came from. A simulated role is
          a local development convenience and grants nothing on a real server. */}
      {!verifiedByBackend && (
        <Alert variant="warning" title="Simulated administrator role (local development)">
          This role is not verified by the LEDGORA account service. Actions here affect only this browser —
          they are not real platform administration.
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-indigo-200 bg-indigo-50/60 px-4 py-2.5 dark:border-indigo-500/30 dark:bg-indigo-500/10">
        <span className="flex items-center gap-2 text-sm font-medium text-indigo-800 dark:text-indigo-200">
          <ShieldAlert className="h-4 w-4" /> You are acting as the Ledgora platform super-administrator.
        </span>
        <button className="text-xs font-medium text-indigo-700 underline hover:no-underline dark:text-indigo-300" onClick={() => setRole('none')}>
          Exit to subscriber view
        </button>
      </div>

      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'subscribers' && <SubscribersPanel />}

      {tab === 'payments' && <PaymentVerificationPanel />}

      {tab === 'packages' && (
        <div className="space-y-6">
          <Section title="Subscription packages & bank remittance">
            <PlanAdminEditor />
            <BillingSettingsEditor />
          </Section>
        </div>
      )}

      {tab === 'metering' && (
        <div className="space-y-6">
          <Section title="Infrastructure cost recovery"><InfrastructureCostDashboard /></Section>
          <Section title="Usage ledger"><UsageLedgerPanel /></Section>
          <Section title="Metering configuration"><MeteringConfigEditor /></Section>
        </div>
      )}

      {tab === 'entitlements' && (
        <Section title="Entitlements & subscription lifecycle"><EntitlementAdminPanel /></Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2"><Badge tone="indigo">Super admin</Badge><h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</h3></div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

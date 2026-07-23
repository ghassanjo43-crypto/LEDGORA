import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from '@/store/useStore';
import { useCompanyStore } from '@/store/companyStore';
import { VIEW_META } from '@/config/navigation';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { GlobalSearch } from './GlobalSearch';
import { SubscriptionStatusBanner } from '@/components/entitlements/SubscriptionStatusBanner';
import { RenewalReminderBanner } from '@/components/billing/RenewalReminderBanner';
import { UsageWarningBanner } from '@/components/metering/UsageWarningBanner';
import { useBillingStore } from '@/store/billingStore';
import { useMeteringConfigStore } from '@/store/meteringConfigStore';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useInventoryStore } from '@/store/inventoryStore';
import { useManufacturingStore } from '@/store/manufacturingStore';
import { useFixedAssetStore } from '@/store/fixedAssetStore';
import { PageHeader } from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/Badge';

export function AppLayout({ children }: { children: ReactNode }) {
  const activeView = useStore((s) => s.activeView);
  const setActiveView = useStore((s) => s.setActiveView);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const meta = VIEW_META[activeView] ?? VIEW_META.dashboard;

  // Register the current books as the first company on first run, and seed the
  // billing packages / apply any expiry+grace transitions.
  useEffect(() => {
    useCompanyStore.getState().ensureInitialized();
    useBillingStore.getState().ensureSeeded();
    useMeteringConfigStore.getState().ensureSeeded();
    // Seed inventory master data only for organizations entitled to it.
    // Deliberately the REAL owned modules (not the operator full-access
    // override): viewing a subscriber must never seed module data they
    // don't pay for into their workspace.
    const modules = useEntitlementStore.getState().effectiveModuleIds;
    if (modules.includes('inventory_basic')) {
      useInventoryStore.getState().ensureSeeded();
    }
    // Seed manufacturing only for Manufacturing organizations.
    if (modules.includes('manufacturing_core')) {
      useManufacturingStore.getState().ensureSeeded();
    }
    // Seed fixed-asset categories only for entitled organizations.
    if (modules.includes('fixed_assets')) {
      useFixedAssetStore.getState().ensureSeeded();
    }
  }, []);

  // Global command-palette shortcut (Ctrl/Cmd + K).
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="flex h-full bg-slate-50 dark:bg-slate-950">
      {/* Desktop sidebar */}
      <div className="hidden lg:block print:hidden">
        <Sidebar />
      </div>

      {/* Mobile sidebar */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm animate-fade-in" onClick={() => setMobileOpen(false)} />
          <div className="absolute left-0 top-0 h-full animate-slide-up">
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="print:hidden">
          <Topbar onOpenSearch={() => setSearchOpen(true)} onOpenMobileNav={() => setMobileOpen(true)} />
          <SubscriptionStatusBanner />
          <RenewalReminderBanner />
          <UsageWarningBanner />
        </div>

        <main className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8 print:overflow-visible print:p-0">
          <div className="mx-auto max-w-app">
            <div className="print:hidden">
              <PageHeader
                title={meta.title}
                subtitle={meta.subtitle}
                icon={meta.icon}
                breadcrumb={[
                  { label: 'Home', onClick: () => setActiveView('dashboard') },
                  { label: meta.group },
                  { label: meta.title },
                ]}
                badge={
                  meta.comingSoon ? (
                    <Badge tone="violet">Coming soon</Badge>
                  ) : undefined
                }
              />
            </div>
            <div key={activeView} className="animate-fade-in">
              {children}
            </div>
          </div>
        </main>
      </div>

      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

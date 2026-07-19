import { lazy, Suspense } from 'react';
import { useStore } from '@/store/useStore';
import { AppLayout } from '@/components/layout/AppLayout';
import { ToastProvider } from '@/components/ui/Toast';
import { PageSkeleton } from '@/components/ui/Skeleton';
import { VIEW_META, VIEW_MODULE_REQUIREMENTS } from '@/config/navigation';
import { ModuleRoute } from '@/components/entitlements/ModuleRoute';
import { ModuleUnavailablePage } from '@/components/entitlements/ModuleUnavailablePage';
import { AccessGate } from '@/components/access/AccessGate';
import { FreeDemoBanner } from '@/components/onboarding/FreeDemoBanner';
import { FreeDemoNotices } from '@/components/onboarding/FreeDemoNotices';

/**
 * Route-level code splitting: each page ships in its own chunk that is only
 * fetched when the view is first opened. Pages use named exports, so we adapt
 * them to the default export that React.lazy expects.
 */
const DashboardPage = lazy(() =>
  import('@/pages/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
const TreePage = lazy(() => import('@/pages/TreePage').then((m) => ({ default: m.TreePage })));
const MappingPage = lazy(() =>
  import('@/pages/MappingPage').then((m) => ({ default: m.MappingPage })),
);
const EntitiesPage = lazy(() =>
  import('@/pages/EntitiesPage').then((m) => ({ default: m.EntitiesPage })),
);
const CustomersPage = lazy(() =>
  import('@/pages/CustomersPage').then((m) => ({ default: m.CustomersPage })),
);
const SuppliersPage = lazy(() =>
  import('@/pages/SuppliersPage').then((m) => ({ default: m.SuppliersPage })),
);
const JournalPage = lazy(() =>
  import('@/pages/JournalPage').then((m) => ({ default: m.JournalPage })),
);
const GeneralLedgerPage = lazy(() =>
  import('@/pages/GeneralLedgerPage').then((m) => ({ default: m.GeneralLedgerPage })),
);
const TrialBalancePage = lazy(() =>
  import('@/pages/TrialBalancePage').then((m) => ({ default: m.TrialBalancePage })),
);
const IncomeStatementPage = lazy(() =>
  import('@/pages/IncomeStatementPage').then((m) => ({ default: m.IncomeStatementPage })),
);
const BalanceSheetPage = lazy(() =>
  import('@/pages/BalanceSheetPage').then((m) => ({ default: m.BalanceSheetPage })),
);
const CashFlowStatementPage = lazy(() =>
  import('@/pages/CashFlowStatementPage').then((m) => ({ default: m.CashFlowStatementPage })),
);
const InvoicesPage = lazy(() => import('@/pages/InvoicesPage').then((m) => ({ default: m.InvoicesPage })));
const CreditNotesPage = lazy(() => import('@/pages/CreditNotesPage').then((m) => ({ default: m.CreditNotesPage })));
const ReceiptsPage = lazy(() => import('@/pages/ReceiptsPage').then((m) => ({ default: m.ReceiptsPage })));
const StatementsPage = lazy(() => import('@/pages/StatementsPage').then((m) => ({ default: m.StatementsPage })));
const BillsPage = lazy(() => import('@/pages/BillsPage').then((m) => ({ default: m.BillsPage })));
const PaymentsPage = lazy(() => import('@/pages/PaymentsPage').then((m) => ({ default: m.PaymentsPage })));
const TaxCodesPage = lazy(() => import('@/pages/TaxCodesPage').then((m) => ({ default: m.TaxCodesPage })));
const TaxGroupsPage = lazy(() => import('@/pages/TaxGroupsPage').then((m) => ({ default: m.TaxGroupsPage })));
const TaxJurisdictionsPage = lazy(() => import('@/pages/TaxJurisdictionsPage').then((m) => ({ default: m.TaxJurisdictionsPage })));
const TaxPeriodsPage = lazy(() => import('@/pages/TaxPeriodsPage').then((m) => ({ default: m.TaxPeriodsPage })));
const TaxSummaryPage = lazy(() => import('@/pages/TaxSummaryPage').then((m) => ({ default: m.TaxSummaryPage })));
const TaxDetailPage = lazy(() => import('@/pages/TaxDetailPage').then((m) => ({ default: m.TaxDetailPage })));
const TaxReconciliationPage = lazy(() => import('@/pages/TaxReconciliationPage').then((m) => ({ default: m.TaxReconciliationPage })));
const CurrenciesPage = lazy(() => import('@/pages/CurrenciesPage').then((m) => ({ default: m.CurrenciesPage })));
const ExchangeRatesPage = lazy(() => import('@/pages/ExchangeRatesPage').then((m) => ({ default: m.ExchangeRatesPage })));
const CurrencyRevaluationPage = lazy(() => import('@/pages/CurrencyRevaluationPage').then((m) => ({ default: m.CurrencyRevaluationPage })));
const FxGainLossPage = lazy(() => import('@/pages/FxGainLossPage').then((m) => ({ default: m.FxGainLossPage })));
const CostCentersPage = lazy(() => import('@/pages/CostCentersPage').then((m) => ({ default: m.CostCentersPage })));
const CostCenterBudgetsPage = lazy(() => import('@/pages/CostCenterBudgetsPage').then((m) => ({ default: m.CostCenterBudgetsPage })));
const CostCenterAllocationsPage = lazy(() => import('@/pages/CostCenterAllocationsPage').then((m) => ({ default: m.CostCenterAllocationsPage })));
const CostCenterReportsPage = lazy(() => import('@/pages/CostCenterReportsPage').then((m) => ({ default: m.CostCenterReportsPage })));
const ProjectsPage = lazy(() => import('@/pages/ProjectsPage').then((m) => ({ default: m.ProjectsPage })));
const ProjectReportsPage = lazy(() => import('@/pages/ProjectReportsPage').then((m) => ({ default: m.ProjectReportsPage })));
const ProjectDeliveryPage = lazy(() => import('@/pages/ProjectDeliveryPage').then((m) => ({ default: m.ProjectDeliveryPage })));
const InvoiceTemplatesPage = lazy(() =>
  import('@/pages/InvoiceTemplatesPage').then((m) => ({ default: m.InvoiceTemplatesPage })),
);
const ImportExportPage = lazy(() =>
  import('@/pages/ImportExportPage').then((m) => ({ default: m.ImportExportPage })),
);
const SettingsPage = lazy(() =>
  import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const SubscriptionPage = lazy(() =>
  import('@/pages/SubscriptionPage').then((m) => ({ default: m.SubscriptionPage })),
);
const MembersPage = lazy(() => import('@/pages/MembersPage').then((m) => ({ default: m.MembersPage })));
const SuperAdminConsolePage = lazy(() => import('@/pages/SuperAdminConsolePage').then((m) => ({ default: m.SuperAdminConsolePage })));
const InventoryDashboardPage = lazy(() => import('@/pages/inventory/InventoryDashboardPage').then((m) => ({ default: m.InventoryDashboardPage })));
const ItemsPage = lazy(() => import('@/pages/inventory/ItemsPage').then((m) => ({ default: m.ItemsPage })));
const ItemCategoriesPage = lazy(() => import('@/pages/inventory/ItemCategoriesPage').then((m) => ({ default: m.ItemCategoriesPage })));
const UnitsOfMeasurePage = lazy(() => import('@/pages/inventory/UnitsOfMeasurePage').then((m) => ({ default: m.UnitsOfMeasurePage })));
const WarehousesPage = lazy(() => import('@/pages/inventory/WarehousesPage').then((m) => ({ default: m.WarehousesPage })));
const StockMovementsPage = lazy(() => import('@/pages/inventory/StockMovementsPage').then((m) => ({ default: m.StockMovementsPage })));
const GoodsReceiptsPage = lazy(() => import('@/pages/inventory/MovementDocumentPage').then((m) => ({ default: m.GoodsReceiptsPage })));
const GoodsIssuesPage = lazy(() => import('@/pages/inventory/MovementDocumentPage').then((m) => ({ default: m.GoodsIssuesPage })));
const AdjustmentsPage = lazy(() => import('@/pages/inventory/MovementDocumentPage').then((m) => ({ default: m.AdjustmentsPage })));
const TransfersPage = lazy(() => import('@/pages/inventory/TransfersPage').then((m) => ({ default: m.TransfersPage })));
const StockCountsPage = lazy(() => import('@/pages/inventory/StockCountsPage').then((m) => ({ default: m.StockCountsPage })));
const InventoryReportsPage = lazy(() => import('@/pages/inventory/InventoryReportsPage').then((m) => ({ default: m.InventoryReportsPage })));
const ManufacturingDashboardPage = lazy(() => import('@/pages/manufacturing/ManufacturingDashboardPage').then((m) => ({ default: m.ManufacturingDashboardPage })));
const WorkOrdersPage = lazy(() => import('@/pages/manufacturing/WorkOrdersPage').then((m) => ({ default: m.WorkOrdersPage })));
const PlantsPage = lazy(() => import('@/pages/manufacturing/MasterPages').then((m) => ({ default: m.PlantsPage })));
const ProductionLinesPage = lazy(() => import('@/pages/manufacturing/MasterPages').then((m) => ({ default: m.ProductionLinesPage })));
const WorkCentersPage = lazy(() => import('@/pages/manufacturing/MasterPages').then((m) => ({ default: m.WorkCentersPage })));
const BillsOfMaterialsPage = lazy(() => import('@/pages/manufacturing/MasterPages').then((m) => ({ default: m.BillsOfMaterialsPage })));
const RoutingsPage = lazy(() => import('@/pages/manufacturing/MasterPages').then((m) => ({ default: m.RoutingsPage })));
const MaterialIssuesPage = lazy(() => import('@/pages/manufacturing/RegisterPages').then((m) => ({ default: m.MaterialIssuesPage })));
const MaterialReturnsPage = lazy(() => import('@/pages/manufacturing/RegisterPages').then((m) => ({ default: m.MaterialReturnsPage })));
const ProductionReceiptsPage = lazy(() => import('@/pages/manufacturing/RegisterPages').then((m) => ({ default: m.ProductionReceiptsPage })));
const ManufacturingScrapPage = lazy(() => import('@/pages/manufacturing/RegisterPages').then((m) => ({ default: m.ManufacturingScrapPage })));
const ProductCostingPage = lazy(() => import('@/pages/manufacturing/ProductCostingPage').then((m) => ({ default: m.ProductCostingPage })));
const ManufacturingReportsPage = lazy(() => import('@/pages/manufacturing/ManufacturingReportsPage').then((m) => ({ default: m.ManufacturingReportsPage })));
const ComingSoon = lazy(() =>
  import('@/pages/ComingSoon').then((m) => ({ default: m.ComingSoon })),
);

export default function App() {
  const activeView = useStore((s) => s.activeView);

  const renderView = (): JSX.Element => {
    switch (activeView) {
      case 'dashboard':
        return <DashboardPage />;
      case 'tree':
        return <TreePage />;
      case 'mapping':
        return <MappingPage />;
      case 'entities':
        return <EntitiesPage />;
      case 'customers':
        return <CustomersPage />;
      case 'suppliers':
        return <SuppliersPage />;
      case 'journal':
        return <JournalPage />;
      case 'general-ledger':
        return <GeneralLedgerPage />;
      case 'trial-balance':
        return <TrialBalancePage />;
      case 'income-statement':
        return <IncomeStatementPage />;
      case 'balance-sheet':
        return <BalanceSheetPage />;
      case 'cash-flow':
        return <CashFlowStatementPage />;
      case 'invoices':
        return <InvoicesPage />;
      case 'credit-notes':
        return <CreditNotesPage />;
      case 'receipts':
        return <ReceiptsPage />;
      case 'statements':
        return <StatementsPage />;
      case 'bills':
        return <BillsPage />;
      case 'payments':
        return <PaymentsPage />;
      case 'tax-codes':
        return <TaxCodesPage />;
      case 'tax-groups':
        return <TaxGroupsPage />;
      case 'tax-jurisdictions':
        return <TaxJurisdictionsPage />;
      case 'tax-periods':
        return <TaxPeriodsPage />;
      case 'tax-summary':
        return <TaxSummaryPage />;
      case 'tax-detail':
        return <TaxDetailPage />;
      case 'tax-reconciliation':
        return <TaxReconciliationPage />;
      case 'currencies':
        return <CurrenciesPage />;
      case 'exchange-rates':
        return <ExchangeRatesPage />;
      case 'currency-revaluation':
        return <CurrencyRevaluationPage />;
      case 'fx-gain-loss':
        return <FxGainLossPage />;
      case 'cost-centers':
        return <CostCentersPage />;
      case 'cost-center-budgets':
        return <CostCenterBudgetsPage />;
      case 'cost-center-allocations':
        return <CostCenterAllocationsPage />;
      case 'cost-center-reports':
        return <CostCenterReportsPage />;
      case 'projects':
        return <ProjectsPage />;
      case 'project-reports':
        return <ProjectReportsPage />;
      case 'project-delivery':
        return <ProjectDeliveryPage />;
      case 'invoice-templates':
        return <InvoiceTemplatesPage />;
      case 'import-export':
        return <ImportExportPage />;
      case 'settings':
        return <SettingsPage />;
      case 'subscription':
        return <SubscriptionPage />;
      case 'members':
        return <MembersPage />;
      case 'super-admin':
        return <SuperAdminConsolePage />;
      case 'inventory-dashboard':
        return <InventoryDashboardPage />;
      case 'inventory-items':
        return <ItemsPage />;
      case 'inventory-categories':
        return <ItemCategoriesPage />;
      case 'inventory-units':
        return <UnitsOfMeasurePage />;
      case 'inventory-warehouses':
        return <WarehousesPage />;
      case 'inventory-movements':
        return <StockMovementsPage />;
      case 'inventory-receipts':
        return <GoodsReceiptsPage />;
      case 'inventory-issues':
        return <GoodsIssuesPage />;
      case 'inventory-transfers':
        return <TransfersPage />;
      case 'inventory-adjustments':
        return <AdjustmentsPage />;
      case 'inventory-counts':
        return <StockCountsPage />;
      case 'inventory-reports':
        return <InventoryReportsPage />;
      case 'manufacturing-dashboard':
        return <ManufacturingDashboardPage />;
      case 'manufacturing-plants':
        return <PlantsPage />;
      case 'manufacturing-lines':
        return <ProductionLinesPage />;
      case 'manufacturing-work-centers':
        return <WorkCentersPage />;
      case 'manufacturing-bom':
        return <BillsOfMaterialsPage />;
      case 'manufacturing-routings':
        return <RoutingsPage />;
      case 'manufacturing-work-orders':
        return <WorkOrdersPage />;
      case 'manufacturing-material-issues':
        return <MaterialIssuesPage />;
      case 'manufacturing-material-returns':
        return <MaterialReturnsPage />;
      case 'manufacturing-production-receipts':
        return <ProductionReceiptsPage />;
      case 'manufacturing-scrap':
        return <ManufacturingScrapPage />;
      case 'manufacturing-costing':
        return <ProductCostingPage />;
      case 'manufacturing-reports':
        return <ManufacturingReportsPage />;
      case 'module-unavailable':
        return <ModuleUnavailablePage />;
      default:
        // Future modules flagged in the navigation config render a placeholder.
        return VIEW_META[activeView]?.comingSoon ? (
          <ComingSoon viewKey={activeView} />
        ) : (
          <DashboardPage />
        );
    }
  };

  // Route-level entitlement guard: a protected view is never rendered without
  // the required module, even when reached by typing/refreshing its key.
  const requirement = VIEW_MODULE_REQUIREMENTS[activeView];
  const view = renderView();
  const guarded = requirement ? (
    <ModuleRoute
      module={requirement.requiredModule}
      allModules={requirement.requiredAllModules}
      anyModules={requirement.requiredAnyModules}
      element={view}
    />
  ) : (
    view
  );

  return (
    <ToastProvider>
      <FreeDemoNotices />
      <FreeDemoBanner />
      <AppLayout>
        {/*
          Onboarding access gate. A view is only rendered when the account
          status permits the application at all, and — in a Free Demo — only
          when the view is on the demo allow-list.
        */}
        <AccessGate view={activeView} fallback={<ModuleUnavailablePage />}>
          <Suspense fallback={<PageSkeleton />}>{guarded}</Suspense>
        </AccessGate>
      </AppLayout>
    </ToastProvider>
  );
}

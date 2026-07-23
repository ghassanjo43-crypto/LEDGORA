import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  ListTree,
  BookOpenText,
  Library,
  Scale,
  TrendingUp,
  Landmark,
  Waves,
  LayoutTemplate,
  FileBarChart2,
  Layers,
  Users,
  FileText,
  ReceiptText,
  ScrollText,
  Truck,
  ReceiptEuro,
  Banknote,
  Building2,
  Percent,
  Coins,
  Target,
  FolderKanban,
  ArrowLeftRight,
  Settings2,
  Landmark as JurisdictionIcon,
  CalendarClock,
  BarChart3,
  ListChecks,
  Scale as ReconcileIcon,
  Boxes,
  RefreshCw,
  CreditCard,
  Factory,
  Warehouse,
  Package,
  PackageCheck,
  PackageSearch,
  Gauge,
  Ruler,
  Recycle,
  Cog,
  ClipboardList,
  Blocks,
  Component,
  Container,
  Cpu,
  Workflow,
  FileSignature,
} from 'lucide-react';
import type { ViewKey } from '@/types';
import type { LedgoraModule } from '@/types/entitlements';
import { canAccessFeature } from '@/lib/entitlementResolution';

export interface NavItem {
  key: ViewKey;
  label: string;
  icon: LucideIcon;
  /** Short description shown in tooltips / command palette. */
  description: string;
  /** Placeholder module not yet implemented. */
  comingSoon?: boolean;
  /** Entitlement requirement — item is hidden unless the module(s) are owned. */
  requiredModule?: LedgoraModule;
  requiredAnyModules?: LedgoraModule[];
  requiredAllModules?: LedgoraModule[];
  /** Platform super-administrator only — hidden from regular subscribers. */
  platformAdminOnly?: boolean;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
  /** Optional group-level requirement (in addition to per-item requirements). */
  requiredAnyModules?: LedgoraModule[];
}

/**
 * Single source of truth for the sidebar, breadcrumbs and page metadata.
 * Live modules point at existing views; future modules are flagged
 * `comingSoon` and routed to a placeholder page.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'accounting',
    label: 'Accounting',
    items: [
      { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, description: 'Overview & KPIs' },
      { key: 'tree', label: 'Chart of Accounts', icon: ListTree, description: 'Account hierarchy & editing', requiredModule: 'core_accounting' },
      { key: 'journal', label: 'General Journal', icon: BookOpenText, description: 'Double-entry transactions', requiredModule: 'core_accounting' },
      { key: 'journal-vouchers', label: 'Journal Vouchers', icon: FileSignature, description: 'Universal voucher workflow — drafts, approval, posting, templates', requiredModule: 'core_accounting' },
      { key: 'journal-voucher-reports', label: 'Voucher Reports', icon: FileBarChart2, description: 'Voucher registers, analysis & GL reconciliation', requiredModule: 'core_accounting' },
      { key: 'general-ledger', label: 'General Ledger', icon: Library, description: 'Account-level postings', requiredModule: 'core_accounting' },
      { key: 'trial-balance', label: 'Trial Balance', icon: Scale, description: 'Debits vs credits by account', requiredModule: 'core_accounting' },
      { key: 'income-statement', label: 'Income Statement', icon: TrendingUp, description: 'Statement of profit or loss', requiredModule: 'core_accounting' },
      { key: 'balance-sheet', label: 'Balance Sheet', icon: Landmark, description: 'Statement of financial position', requiredModule: 'core_accounting' },
      { key: 'cash-flow', label: 'Cash Flow Statement', icon: Waves, description: 'Statement of cash flows (indirect)', requiredModule: 'core_accounting' },
      { key: 'financial-statements', label: 'Financial Statements', icon: FileBarChart2, description: 'Changes in equity & notes', comingSoon: true, requiredModule: 'core_accounting' },
      { key: 'mapping', label: 'IFRS Mapping', icon: Layers, description: 'Accounts by financial statement', requiredModule: 'core_accounting' },
    ],
  },
  {
    id: 'sales',
    label: 'Sales',
    items: [
      { key: 'customers', label: 'Customers', icon: Users, description: 'Entities we invoice', requiredModule: 'sales' },
      { key: 'invoices', label: 'Invoices', icon: FileText, description: 'Sales invoices', requiredModule: 'sales' },
      { key: 'invoice-templates', label: 'Invoice Templates', icon: LayoutTemplate, description: 'Invoice formats & versions', requiredModule: 'sales' },
      { key: 'credit-notes', label: 'Credit Notes', icon: ReceiptText, description: 'Customer credit notes', requiredModule: 'sales' },
      { key: 'receipts', label: 'Receipts', icon: Banknote, description: 'Customer receipts', requiredModule: 'sales' },
      { key: 'statements', label: 'Statements of Account', icon: ScrollText, description: 'Customer statements of account', requiredModule: 'customer_statements' },
    ],
  },
  {
    id: 'purchasing',
    label: 'Purchasing',
    items: [
      { key: 'suppliers', label: 'Suppliers', icon: Truck, description: 'Entities who invoice us', requiredModule: 'purchases' },
      { key: 'bills', label: 'Bills', icon: ReceiptEuro, description: 'Supplier bills', requiredModule: 'purchases' },
      { key: 'payments', label: 'Payments Made', icon: Banknote, description: 'Supplier & other payments', comingSoon: false, requiredModule: 'purchases' },
    ],
  },
  {
    id: 'master-data',
    label: 'Master Data',
    items: [
      { key: 'entities', label: 'Business Entities', icon: Building2, description: 'Shared customer & supplier directory', requiredAnyModules: ['sales', 'purchases'] },
    ],
  },
  {
    id: 'projects',
    label: 'Projects',
    items: [
      { key: 'projects', label: 'Projects', icon: FolderKanban, description: 'Projects, jobs & contracts', requiredModule: 'projects' },
      { key: 'project-delivery', label: 'Project Delivery', icon: ListChecks, description: 'Time, expenses, commitments, milestones & billing', requiredModule: 'project_time_expenses' },
      { key: 'project-reports', label: 'Project Reports', icon: BarChart3, description: 'Profitability, cash flow & revenue recognition', requiredModule: 'project_profitability' },
    ],
  },
  {
    id: 'cost-centers',
    label: 'Cost Centers',
    items: [
      { key: 'cost-centers', label: 'Cost Centers', icon: Target, description: 'Cost-center hierarchy & master data', requiredModule: 'cost_centers' },
      { key: 'cost-center-budgets', label: 'Budgets', icon: FileBarChart2, description: 'Cost-center budgets & vs-actual', requiredModule: 'cost_center_budgets' },
      { key: 'cost-center-allocations', label: 'Cost Allocations', icon: RefreshCw, description: 'Shared-cost allocation rules & runs', requiredModule: 'cost_allocations' },
      { key: 'cost-center-reports', label: 'Cost Center Reports', icon: BarChart3, description: 'Income statement, trial balance & ledger by cost center', requiredModule: 'cost_centers' },
    ],
  },
  {
    id: 'fixed-assets',
    label: 'Fixed Assets',
    requiredAnyModules: ['fixed_assets'],
    items: [
      { key: 'fixed-assets', label: 'Asset Register', icon: Landmark, description: 'Fixed asset register & transactions', requiredModule: 'fixed_assets' },
      { key: 'fixed-asset-categories', label: 'Asset Categories', icon: Layers, description: 'Categories & accounting mappings', requiredModule: 'fixed_assets' },
      { key: 'fixed-assets-depreciation', label: 'Depreciation Runs', icon: CalendarClock, description: 'Preview, approve, post & reverse depreciation', requiredModule: 'fixed_assets' },
      { key: 'fixed-assets-reports', label: 'Asset Reports', icon: BarChart3, description: 'Register, schedules, movements & GL reconciliation', requiredModule: 'fixed_assets' },
    ],
  },
  {
    id: 'inventory',
    label: 'Inventory',
    requiredAnyModules: ['inventory_basic'],
    items: [
      { key: 'inventory-dashboard', label: 'Dashboard', icon: Boxes, description: 'Inventory value, low & out-of-stock', requiredModule: 'inventory_basic' },
      { key: 'inventory-items', label: 'Items', icon: Package, description: 'Stock items & valuation', requiredModule: 'inventory_basic' },
      { key: 'inventory-categories', label: 'Item Categories', icon: Layers, description: 'Hierarchical item categories', requiredModule: 'inventory_basic' },
      { key: 'inventory-units', label: 'Units of Measure', icon: Ruler, description: 'Units of measure', requiredModule: 'inventory_basic' },
      { key: 'inventory-warehouses', label: 'Warehouses', icon: Warehouse, description: 'Warehouses & stock locations', requiredModule: 'inventory_basic' },
      { key: 'inventory-movements', label: 'Stock Movements', icon: ArrowLeftRight, description: 'Immutable stock-movement ledger', requiredModule: 'inventory_basic' },
      { key: 'inventory-receipts', label: 'Goods Receipts', icon: PackageCheck, description: 'Receive stock into a warehouse', requiredModule: 'inventory_basic' },
      { key: 'inventory-issues', label: 'Goods Issues', icon: PackageSearch, description: 'Issue stock to cost / project', requiredModule: 'inventory_basic' },
      { key: 'inventory-transfers', label: 'Transfers', icon: Container, description: 'Inter-warehouse transfers', requiredModule: 'inventory_basic' },
      { key: 'inventory-adjustments', label: 'Adjustments', icon: RefreshCw, description: 'Increase / decrease adjustments', requiredModule: 'inventory_basic' },
      { key: 'inventory-counts', label: 'Stock Counts', icon: ClipboardList, description: 'Count & post variances', requiredModule: 'inventory_basic' },
      { key: 'inventory-reports', label: 'Reports', icon: BarChart3, description: 'Valuation, registers & GL reconciliation', requiredModule: 'inventory_basic' },
    ],
  },
  {
    id: 'manufacturing',
    label: 'Manufacturing',
    requiredAnyModules: ['manufacturing_core'],
    items: [
      { key: 'manufacturing-dashboard', label: 'Dashboard', icon: Gauge, description: 'Production, cost & WIP KPIs', requiredModule: 'manufacturing_core' },
      { key: 'manufacturing-plants', label: 'Plants', icon: Factory, description: 'Plants & their warehouses', requiredModule: 'manufacturing_core' },
      { key: 'manufacturing-lines', label: 'Production Lines', icon: Workflow, description: 'Production lines', requiredModule: 'manufacturing_core' },
      { key: 'manufacturing-work-centers', label: 'Work Centers', icon: Cpu, description: 'Machines, lines & labor groups with rates', requiredModule: 'manufacturing_work_centers' },
      { key: 'manufacturing-bom', label: 'Bills of Materials', icon: Component, description: 'Versioned, approved BOMs', requiredModule: 'manufacturing_bom' },
      { key: 'manufacturing-routings', label: 'Routings', icon: Ruler, description: 'Operations & standard times', requiredModule: 'manufacturing_routings' },
      { key: 'manufacturing-work-orders', label: 'Work Orders', icon: ClipboardList, description: 'Plan-to-complete production orders', requiredModule: 'manufacturing_work_orders' },
      { key: 'manufacturing-material-issues', label: 'Material Issues', icon: PackageCheck, description: 'Issue material to WIP', requiredModule: 'manufacturing_material_issues' },
      { key: 'manufacturing-material-returns', label: 'Material Returns', icon: PackageSearch, description: 'Return unused material from WIP', requiredModule: 'manufacturing_material_issues' },
      { key: 'manufacturing-production-receipts', label: 'Production Receipts', icon: Blocks, description: 'Receive finished goods from WIP', requiredModule: 'manufacturing_production_receipts' },
      { key: 'manufacturing-scrap', label: 'Scrap', icon: Recycle, description: 'Normal & abnormal scrap', requiredModule: 'manufacturing_scrap' },
      { key: 'manufacturing-costing', label: 'Product Costing', icon: Cog, description: 'Standard & actual product cost', requiredAnyModules: ['manufacturing_standard_costing', 'manufacturing_actual_costing'] },
      { key: 'manufacturing-reports', label: 'Manufacturing Reports', icon: BarChart3, description: 'WIP, variance & GL reconciliation', requiredModule: 'manufacturing_reports' },
    ],
  },
  {
    id: 'currency',
    label: 'Financial Settings',
    items: [
      { key: 'currencies', label: 'Currencies', icon: Coins, description: 'Currency Master — standard & custom currencies, precision, base currency', requiredModule: 'currency_basic' },
      { key: 'exchange-rates', label: 'Exchange Rates', icon: ArrowLeftRight, description: 'Effective-dated rates & converter', requiredModule: 'currency_basic' },
      { key: 'currency-revaluation', label: 'Currency Revaluation', icon: RefreshCw, description: 'Period-end FX revaluation', requiredModule: 'currency_advanced' },
      { key: 'fx-gain-loss', label: 'FX Gain / Loss', icon: TrendingUp, description: 'Realized & unrealized FX, exposure', requiredModule: 'currency_advanced' },
    ],
  },
  {
    id: 'tax',
    label: 'Tax',
    items: [
      { key: 'tax-codes', label: 'Tax Codes', icon: Percent, description: 'VAT & sales-tax codes, rate versions', requiredModule: 'tax_basic' },
      { key: 'tax-summary', label: 'Tax Summary', icon: BarChart3, description: 'Tax by code, direction and box', requiredModule: 'tax_basic' },
      { key: 'tax-detail', label: 'Tax Detail', icon: ListChecks, description: 'Transaction-level tax detail', requiredModule: 'tax_basic' },
      { key: 'tax-groups', label: 'Tax Groups', icon: Boxes, description: 'Compound & parallel tax groups', requiredModule: 'tax_advanced' },
      { key: 'tax-jurisdictions', label: 'Tax Jurisdictions', icon: JurisdictionIcon, description: 'Jurisdictions & reporting boxes', requiredModule: 'tax_advanced' },
      { key: 'tax-periods', label: 'Tax Periods', icon: CalendarClock, description: 'Tax periods & locking', requiredModule: 'tax_advanced' },
      { key: 'tax-reconciliation', label: 'Tax Reconciliation', icon: ReconcileIcon, description: 'Report totals vs GL tax accounts', requiredModule: 'tax_advanced' },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      { key: 'import-export', label: 'Import / Export', icon: ArrowLeftRight, description: 'Accounts CSV & JSON', requiredModule: 'core_accounting' },
      { key: 'members', label: 'Members', icon: Users, description: 'Organization users, roles & invitations' },
      { key: 'subscription', label: 'Subscription', icon: CreditCard, description: 'Edition, modules & subscription status' },
      { key: 'settings', label: 'Settings', icon: Settings2, description: 'Company & presentation' },
    ],
  },
];

/**
 * Return only the navigation groups/items the given owned modules unlock.
 * Hides unavailable items, drops groups left empty, and preserves order. Items
 * with no requirement (Dashboard, Settings, Subscription) are always shown.
 */
export function filterNavigationByEntitlements(
  moduleIds: readonly LedgoraModule[],
  groups: NavGroup[] = NAV_GROUPS,
): NavGroup[] {
  const out: NavGroup[] = [];
  for (const group of groups) {
    // A group-level requirement is an OR across the listed modules.
    if (
      group.requiredAnyModules &&
      group.requiredAnyModules.length > 0 &&
      !canAccessFeature(moduleIds, { requiredAnyModules: group.requiredAnyModules })
    ) {
      continue;
    }
    const items = group.items.filter((item) =>
      canAccessFeature(moduleIds, {
        requiredModule: item.requiredModule,
        requiredAnyModules: item.requiredAnyModules,
        requiredAllModules: item.requiredAllModules,
      }),
    );
    if (items.length > 0) out.push({ ...group, items });
  }
  return out;
}

export interface ViewMeta {
  key: ViewKey;
  title: string;
  subtitle: string;
  icon: LucideIcon;
  group: string;
  comingSoon: boolean;
}

/** Page-header title/subtitle per view. Falls back to the nav label. */
const SUBTITLES: Partial<Record<ViewKey, string>> = {
  dashboard: 'Financial health and business performance at a glance',
  tree: 'Build, organise and edit your IFRS-aligned account hierarchy',
  journal: 'Record and post balanced double-entry transactions',
  'general-ledger': 'Account-level postings derived from posted journal entries',
  'trial-balance': 'Review account balances and confirm that total debits equal total credits',
  'income-statement': 'Review revenue, expenses, and profitability for the selected reporting period',
  'balance-sheet': 'Assets, equity and liabilities as at the selected reporting date',
  'cash-flow': 'Operating, investing and financing cash flows — indirect method',
  invoices: 'Create, issue and track customer invoices',
  'credit-notes': 'Issue, apply and refund customer credit notes linked to invoices',
  receipts: 'Record money received, allocate to invoices and post the cash journal',
  statements: 'Customer statement of account — activity, running balance, aging and reconciliation',
  'invoice-templates': 'Design invoice formats, versions and customer assignments',
  mapping: 'See how each account maps to the IFRS financial statements',
  customers: 'Entities you invoice — a CRM-style directory',
  suppliers: 'Entities who invoice you',
  bills: 'Record supplier bills, post to Trade Payables, then pay or credit them',
  payments: 'Record money paid out — allocate to bills, post one balanced bank journal and generate a payment voucher',
  entities: 'One shared record per party — customer, supplier, or both',
  'tax-codes': 'Centralized tax codes — rates, effective-dated versions, account mappings and reporting boxes',
  'tax-groups': 'Combine multiple tax codes on one line — parallel or sequential (compound)',
  'tax-jurisdictions': 'Tax jurisdictions, registrations and return reporting boxes',
  'tax-periods': 'Tax periods with prepare, file, lock and reopen controls',
  'tax-summary': 'Tax by code and direction — taxable base, output, input and net payable',
  'tax-detail': 'Transaction-level tax detail with drill-down to source and journal',
  'tax-reconciliation': 'Reconcile tax report totals against the General Ledger tax control accounts',
  currencies: 'Currency master data, decimal precision and per-entity base & enabled currencies',
  'exchange-rates': 'Effective-dated exchange rates, manual overrides and a conversion preview',
  'currency-revaluation': 'Revalue foreign monetary balances at a closing rate and post the unrealized FX',
  'fx-gain-loss': 'Realized and unrealized FX results and currency exposure',
  'cost-centers': 'Organizational cost-center hierarchy, posting rules and requirement policy',
  'cost-center-budgets': 'Monthly cost-center budgets and budget-versus-actual analysis',
  'cost-center-allocations': 'Shared-cost allocation rules and balanced allocation runs',
  'cost-center-reports': 'Income statement, trial balance and general ledger by cost center',
  projects: 'Temporary initiatives, contracts and jobs — revenue, cost and margin by project',
  'project-reports': 'Profitability, cash flow, budget-vs-actual and revenue recognition by project',
  'project-delivery': 'Capture time and expenses, track commitments and milestones, and bill projects',
  'journal-vouchers': 'One flexible voucher for every balanced non-document transaction — posted through the General Journal',
  'journal-voucher-reports': 'Voucher registers by type, account, user and dimension, plus reconciliation to the General Ledger',
  'fixed-assets': 'Asset register — every posted asset transaction creates a linked General Journal Voucher',
  'fixed-asset-categories': 'Asset categories mapped to your chart of accounts — cost, depreciation, impairment and disposal accounts',
  'fixed-assets-depreciation': 'Depreciation runs — preview, validate, approve, post and reverse with a full audit history',
  'fixed-assets-reports': 'Registers, schedules, movement analysis and reconciliation of the asset register to the General Ledger',
  'import-export': 'Move your chart of accounts in and out as CSV or JSON',
  subscription: 'Your Ledgora edition, enabled modules, limits and subscription status',
  members: 'Invite teammates, assign roles and manage seats within your plan limit',
  settings: 'Company profile, accounting and presentation preferences',
};

export const VIEW_META: Record<ViewKey, ViewMeta> = Object.fromEntries(
  NAV_GROUPS.flatMap((group) =>
    group.items.map((item) => [
      item.key,
      {
        key: item.key,
        title: item.label,
        subtitle: SUBTITLES[item.key] ?? item.description,
        icon: item.icon,
        group: group.label,
        comingSoon: !!item.comingSoon,
      } satisfies ViewMeta,
    ]),
  ),
) as Record<ViewKey, ViewMeta>;

/** Flat list of every nav item (used by search & routing). */
export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

export interface ViewModuleRequirement {
  requiredModule?: LedgoraModule;
  requiredAnyModules?: LedgoraModule[];
  requiredAllModules?: LedgoraModule[];
}

/**
 * Per-view entitlement requirement, derived from the nav registry. Used by the
 * route guard (App) and global search so a protected view cannot be reached by
 * typing its key or from the command palette.
 */
export const VIEW_MODULE_REQUIREMENTS: Partial<Record<ViewKey, ViewModuleRequirement>> =
  Object.fromEntries(
    ALL_NAV_ITEMS.filter(
      (i) => i.requiredModule || i.requiredAnyModules || i.requiredAllModules,
    ).map((i) => [
      i.key,
      {
        requiredModule: i.requiredModule,
        requiredAnyModules: i.requiredAnyModules,
        requiredAllModules: i.requiredAllModules,
      },
    ]),
  ) as Partial<Record<ViewKey, ViewModuleRequirement>>;

/** Whether a set of owned modules can access a given view. */
export function canAccessView(
  moduleIds: readonly LedgoraModule[],
  view: ViewKey,
): boolean {
  return canAccessFeature(moduleIds, VIEW_MODULE_REQUIREMENTS[view]);
}

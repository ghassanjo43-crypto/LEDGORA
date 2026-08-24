import {
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Building2,
  ChevronDown,
  BookOpenText,
  Users,
  Truck,
  FileText,
  ReceiptText,
  Banknote,
  Eye,
  EyeOff,
  ArrowUp,
  ArrowDown,
  RotateCcw,
} from 'lucide-react';
import type { ViewKey } from '@/types';
import type { ReportingPeriodId } from '@/types/dashboard';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Drawer } from '@/components/ui/Drawer';
import { Toggle } from '@/components/ui/Toggle';
import { Dropdown, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Dropdown';
import { useDashboardPreferences, WIDGET_META } from '@/store/dashboardPreferencesStore';
import { useToast } from '@/components/ui/Toast';
import { useHasModule } from '@/store/entitlementHooks';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useBillStore } from '@/store/billStore';
import { usePaymentStore } from '@/store/paymentStore';
import { useInvoiceEditor } from '@/store/invoiceEditorStore';
import { useBillEditor } from '@/store/billEditorStore';
import { usePaymentEditor } from '@/store/paymentEditorStore';
import { getCurrentUser } from '@/store/authStore';
import { isPlatformAdminFullAccess } from '@/store/platformFullAccess';
import { roleCanCreateDocument } from '@/lib/transactionDocumentPermissions';
import type { OrganizationRole } from '@/types/roles';
import { timeAgo, cn } from '@/lib/utils';

const PERIOD_OPTIONS: { value: ReportingPeriodId; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'this-week', label: 'This week' },
  { value: 'this-month', label: 'This month' },
  { value: 'this-quarter', label: 'This quarter' },
  { value: 'this-year', label: 'This year' },
  { value: 'prev-month', label: 'Previous month' },
  { value: 'prev-quarter', label: 'Previous quarter' },
  { value: 'prev-year', label: 'Previous year' },
  { value: 'custom', label: 'Custom range' },
];

/**
 * Quick-create: start a document here, finish it in its own module.
 *
 * ══ What this is, and firmly is not ══════════════════════════════════════════
 *
 * An ENTRY POINT. Each action calls the module's own `createDraft` and then asks
 * that module to open the draft it just made. Numbering, defaults, the company's
 * functional currency, persistence policy, validation and permissions all stay
 * where they already live — nothing about how a document is created is decided
 * here, and adding a rule to this file would mean the Dashboard and the module's
 * own New button could disagree.
 *
 * ══ Why these were "Soon" ════════════════════════════════════════════════════
 *
 * The menu was written before Invoices, Bills and Payments existed and was never
 * revisited. The label was false: all three modules are complete, and the
 * dropdown was advertising their absence.
 *
 * ══ How the destination opens the draft ══════════════════════════════════════
 *
 * Through each module's existing cross-view editor-request store — the same
 * mechanism the Invoices page already uses to open a credit note or a receipt
 * it has just created. Bills and Payments had one; Invoices did not, so
 * `invoiceEditorStore` was added in the identical shape rather than inventing a
 * different mechanism for one of the three.
 */
function useQuickCreate(go: (view: ViewKey) => void) {
  const { notify } = useToast();
  const createInvoice = useInvoiceStore((s) => s.createDraft);
  const createBill = useBillStore((s) => s.createDraft);
  const createPayment = usePaymentStore((s) => s.createDraft);
  const requestOpenInvoice = useInvoiceEditor((s) => s.requestOpen);
  const requestOpenBill = useBillEditor((s) => s.requestOpen);
  const requestOpenPayment = usePaymentEditor((s) => s.requestOpen);

  /*
   * Entitlement, from the resolver the sidebar already uses. An unentitled
   * module is HIDDEN — the established Ledgora behaviour for something the
   * organization's package does not include — never relabelled "Soon", which
   * would claim the feature does not exist.
   */
  const hasSales = useHasModule('sales');
  const hasPurchases = useHasModule('purchases');

  /*
   * Permission, from the same resolver the stores enforce on the write. This
   * decides what to DRAW; the store decides what happens, so hiding the item is
   * an affordance rather than the gate.
   */
  const role: OrganizationRole = isPlatformAdminFullAccess()
    ? 'admin'
    : getCurrentUser()?.role ?? 'owner';

  /**
   * Create, then navigate, then open — and only in that order.
   *
   * A failed `createDraft` returns here without navigating, so the user is never
   * dropped into an empty editor for a record that was refused. The refusal is
   * reported through the application's ordinary toast.
   */
  /*
   * `create` may be synchronous or asynchronous: an invoice posts over the
   * network for a server-backed company, a bill and a payment never do.
   * Awaiting a plain value is a no-op, so one wrapper covers all three.
   */
  const start = (
    create: () =>
      | { ok: boolean; error?: string; id?: string }
      | Promise<{ ok: boolean; error?: string; id?: string }>,
    requestOpen: (id: string) => void,
    view: ViewKey,
    failure: string,
  ) => (): void => {
    void (async () => {
      const result = await create();
      if (!result.ok || !result.id) {
        notify(result.error ?? failure, 'error');
        return;
      }
      requestOpen(result.id);
      go(view);
    })();
  };

  return {
    canInvoice: hasSales && roleCanCreateDocument(role, 'invoice'),
    canBill: hasPurchases && roleCanCreateDocument(role, 'bill'),
    // A payment is a purchases-side document, and this one is deliberately
    // standalone: no supplier and no bill allocation, because the user asked
    // for a payment rather than for a specific bill to be paid.
    canPayment: hasPurchases && roleCanCreateDocument(role, 'payment'),
    newInvoice: start(() => createInvoice({}), requestOpenInvoice, 'invoices', 'Could not create the invoice.'),
    newBill: start(() => createBill(), requestOpenBill, 'bills', 'Could not create the bill.'),
    recordPayment: start(() => createPayment(), requestOpenPayment, 'payments', 'Could not create the payment.'),
  };
}

export function DashboardHeaderActions({
  lastRefreshed,
  onRefresh,
  onCustomize,
  go,
}: {
  lastRefreshed: number;
  onRefresh: () => void;
  onCustomize: () => void;
  go: (view: ViewKey) => void;
}) {
  const quick = useQuickCreate(go);
  const periodId = useDashboardPreferences((s) => s.periodId);
  const customFrom = useDashboardPreferences((s) => s.customFrom);
  const customTo = useDashboardPreferences((s) => s.customTo);
  const setPeriod = useDashboardPreferences((s) => s.setPeriod);
  const setCustomRange = useDashboardPreferences((s) => s.setCustomRange);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        className="h-9 w-auto"
        options={PERIOD_OPTIONS}
        value={periodId}
        onChange={(e) => setPeriod(e.target.value as ReportingPeriodId)}
        aria-label="Reporting period"
      />
      {periodId === 'custom' && (
        <div className="flex items-center gap-1">
          <input
            type="date"
            value={customFrom}
            onChange={(e) => setCustomRange(e.target.value, customTo)}
            className="focus-ring h-9 rounded-lg border border-slate-300 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-900"
            aria-label="Custom from date"
          />
          <span className="text-slate-400">–</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => setCustomRange(customFrom, e.target.value)}
            className="focus-ring h-9 rounded-lg border border-slate-300 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-900"
            aria-label="Custom to date"
          />
        </div>
      )}

      {/* Branch placeholder */}
      <span
        className="hidden items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-400 dark:border-slate-700 lg:inline-flex"
        title="Multi-branch support is coming soon"
      >
        <Building2 className="h-4 w-4" /> Head Office <ChevronDown className="h-3.5 w-3.5" />
      </span>

      <button
        type="button"
        onClick={onRefresh}
        title="Refresh figures"
        className="focus-ring flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        <RefreshCw className="h-4 w-4" />
        <span className="hidden sm:inline">Updated {timeAgo(new Date(lastRefreshed).toISOString())}</span>
      </button>

      <Button variant="outline" size="sm" onClick={onCustomize}>
        <SlidersHorizontal className="h-4 w-4" /> Customize
      </Button>

      <Dropdown
        label="Quick create"
        trigger={(o) => (
          <span className={cn('inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-700', o && 'bg-brand-700')}>
            <Plus className="h-4 w-4" /> New <ChevronDown className="h-3.5 w-3.5" />
          </span>
        )}
      >
        <MenuLabel>Create</MenuLabel>
        <MenuItem icon={BookOpenText} onClick={() => go('journal')}>New journal entry</MenuItem>
        <MenuItem icon={Users} onClick={() => go('customers')}>New customer</MenuItem>
        <MenuItem icon={Truck} onClick={() => go('suppliers')}>New supplier</MenuItem>
        {(quick.canInvoice || quick.canBill || quick.canPayment) && <MenuSeparator />}
        {quick.canInvoice && (
          <MenuItem icon={FileText} onClick={quick.newInvoice}>New invoice</MenuItem>
        )}
        {quick.canBill && (
          <MenuItem icon={ReceiptText} onClick={quick.newBill}>New bill</MenuItem>
        )}
        {quick.canPayment && (
          <MenuItem icon={Banknote} onClick={quick.recordPayment}>Record payment</MenuItem>
        )}
      </Dropdown>
    </div>
  );
}

export function CustomizePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const widgets = useDashboardPreferences((s) => s.widgets);
  const density = useDashboardPreferences((s) => s.density);
  const toggleWidget = useDashboardPreferences((s) => s.toggleWidget);
  const moveWidget = useDashboardPreferences((s) => s.moveWidget);
  const setDensity = useDashboardPreferences((s) => s.setDensity);
  const resetLayout = useDashboardPreferences((s) => s.resetLayout);

  const ordered = [...widgets].sort((a, b) => a.order - b.order);
  const labelFor = (id: string): string => WIDGET_META.find((w) => w.id === id)?.label ?? id;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      widthClassName="max-w-md"
      title="Customize dashboard"
      description="Show, hide and reorder widgets. Preferences are saved to this browser."
      footer={
        <div className="flex w-full items-center justify-between">
          <Button variant="ghost" size="sm" onClick={resetLayout}>
            <RotateCcw className="h-4 w-4" /> Reset to default
          </Button>
          <Button onClick={onClose}>Done</Button>
        </div>
      }
    >
      <div className="space-y-5">
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Density</h3>
          <div className="flex rounded-lg border border-slate-200 p-1 dark:border-slate-700">
            {(['comfortable', 'compact'] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDensity(d)}
                className={cn('flex-1 rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors', density === d ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-200')}
              >
                {d}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Widgets</h3>
          <ul className="space-y-1.5">
            {ordered.map((w, i) => (
              <li key={w.id} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
                <span className="flex flex-col">
                  <button type="button" disabled={i === 0} onClick={() => moveWidget(w.id, 'up')} className="focus-ring rounded text-slate-400 disabled:opacity-30 hover:text-slate-600" aria-label="Move up">
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" disabled={i === ordered.length - 1} onClick={() => moveWidget(w.id, 'down')} className="focus-ring rounded text-slate-400 disabled:opacity-30 hover:text-slate-600" aria-label="Move down">
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                </span>
                <span className={cn('flex-1 text-sm', w.visible ? 'text-slate-700 dark:text-slate-200' : 'text-slate-400 line-through')}>
                  {labelFor(w.id)}
                </span>
                <span className="flex items-center gap-2">
                  {w.visible ? <Eye className="h-4 w-4 text-slate-400" /> : <EyeOff className="h-4 w-4 text-slate-300" />}
                  <Toggle checked={w.visible} onChange={() => toggleWidget(w.id)} label={`Toggle ${labelFor(w.id)}`} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Drawer>
  );
}

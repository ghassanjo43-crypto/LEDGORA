// @vitest-environment happy-dom
/**
 * The other half of quick-create: the destination page opens the draft.
 *
 * ══ Why this is separate from the menu test ══════════════════════════════════
 *
 * `dashboardQuickCreate.test.tsx` proves the Dashboard creates one draft and
 * REQUESTS its editor. That request is only worth anything if the page it
 * navigates to honours it — and for Invoices nothing did, because invoices were
 * the one document module with no cross-view editor store at all.
 *
 * So these render the real destination pages with a request already pending and
 * assert that the editor drawer for THAT draft is on screen. Between the two
 * files the whole path is covered: click → draft → navigation → open editor.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { InvoicesPage } from './InvoicesPage';
import { BillsPage } from './BillsPage';
import { PaymentsPage } from './PaymentsPage';
import { ToastProvider } from '@/components/ui/Toast';
import { useStore } from '@/store/useStore';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useBillStore } from '@/store/billStore';
import { usePaymentStore } from '@/store/paymentStore';
import { useInvoiceEditor } from '@/store/invoiceEditorStore';
import { useBillEditor } from '@/store/billEditorStore';
import { usePaymentEditor } from '@/store/paymentEditorStore';

const page = (node: React.ReactElement) => render(<ToastProvider>{node}</ToastProvider>);

/** The drawer is open when its dialog is on screen. */
const openDrawer = (): HTMLElement | null => document.querySelector('[role="dialog"]');

beforeEach(async () => {
  useInvoiceStore.setState({ invoices: [] });
  useBillStore.setState({ bills: [] });
  usePaymentStore.setState({ payments: [] });
  useInvoiceEditor.setState({ requestedEditorId: null });
  useBillEditor.setState({ requestedEditorId: null });
  usePaymentEditor.setState({ requestedEditorId: null });
  useStore.setState((s) => ({ settings: { ...s.settings, baseCurrency: 'JOD' } }));
});
afterEach(cleanup);

describe('a pending editor request opens the draft on arrival', () => {
  it('Invoices opens the requested invoice', async () => {
    const created = await useInvoiceStore.getState().createDraft({});
    expect(created.ok).toBe(true);
    useInvoiceEditor.getState().requestOpen(created.id!);

    page(<InvoicesPage />);

    // The drawer is open, and the request has been consumed so it cannot fire
    // again the next time the user visits Invoices.
    expect(openDrawer()).not.toBeNull();
    expect(useInvoiceEditor.getState().requestedEditorId).toBeNull();
    // It is the invoice that was created, identified by its own number.
    const invoice = useInvoiceStore.getState().getInvoice(created.id!)!;
    expect(openDrawer()!.textContent).toContain(invoice.invoiceNumber);
  });

  it('Bills opens the requested bill', async () => {
    const created = useBillStore.getState().createDraft();
    expect(created.ok).toBe(true);
    useBillEditor.getState().requestOpen(created.id!);

    page(<BillsPage />);

    expect(openDrawer()).not.toBeNull();
    expect(useBillEditor.getState().requestedEditorId).toBeNull();
    expect(openDrawer()!.textContent).toContain(useBillStore.getState().getBill(created.id!)!.billNumber);
  });

  it('Payments opens the requested payment', async () => {
    const created = usePaymentStore.getState().createDraft();
    expect(created.ok).toBe(true);
    usePaymentEditor.getState().requestOpen(created.id!);

    page(<PaymentsPage />);

    expect(openDrawer()).not.toBeNull();
    expect(usePaymentEditor.getState().requestedEditorId).toBeNull();
  });
});

describe('without a request', () => {
  it('each page opens no drawer at all', async () => {
    // Arriving at the module normally must not pop an editor — the request is
    // what distinguishes "the user asked to create one" from "the user browsed
    // to the list".
    for (const node of [<InvoicesPage key="i" />, <BillsPage key="b" />, <PaymentsPage key="p" />]) {
      cleanup();
      page(node);
      expect(openDrawer()).toBeNull();
    }
  });
});

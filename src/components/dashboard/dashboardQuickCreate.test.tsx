// @vitest-environment happy-dom
/**
 * Dashboard quick-create — the "New" menu.
 *
 * ══ The defect these keep dead ═══════════════════════════════════════════════
 *
 * The menu offered "New invoice · Soon", "New bill · Soon" and "Record payment
 * · Soon", all disabled. Every one of those three modules had been complete for
 * some time; the menu was written before they existed and was never revisited.
 * The label was not merely stale, it was false — it told the user a finished
 * feature did not exist.
 *
 * ══ Why these are interaction tests ══════════════════════════════════════════
 *
 * A test that only asserted the strings were gone would pass against a menu
 * whose items did nothing at all. What matters is the whole action: one click
 * creates exactly one draft through the module's own store, navigates once, and
 * arrives with that draft's editor already open. So these click the real menu,
 * against the real stores, and then check the stores and the navigation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { DashboardHeaderActions } from './DashboardControls';
import { ToastProvider } from '@/components/ui/Toast';
import { useStore } from '@/store/useStore';
import { useAuthStore } from '@/store/authStore';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useBillStore } from '@/store/billStore';
import { usePaymentStore } from '@/store/paymentStore';
import { useInvoiceEditor } from '@/store/invoiceEditorStore';
import { useBillEditor } from '@/store/billEditorStore';
import { usePaymentEditor } from '@/store/paymentEditorStore';
import type { OrganizationRole } from '@/types/roles';
import type { ViewKey } from '@/types';

/* ─────────────────────────────── Harness ────────────────────────────────── */

let navigated: ViewKey[] = [];

/** Sign a user in with `role`, the way `getCurrentUser` actually reads it. */
function signInAs(role: OrganizationRole): void {
  useAuthStore.setState({
    users: [{
      id: 'u1', fullName: 'Tester', email: 't@t.test', mobile: '', country: 'JO',
      passwordHash: 'x', emailVerified: true, role,
    } as never],
    currentUserId: 'u1',
  } as never);
}

function menu(role: OrganizationRole = 'owner') {
  signInAs(role);
  const view = render(
    <ToastProvider>
      <DashboardHeaderActions
        lastRefreshed={Date.now()}
        onRefresh={() => {}}
        onCustomize={() => {}}
        go={(v) => navigated.push(v)}
      />
    </ToastProvider>,
  );
  // Open the "New" dropdown.
  fireEvent.click(screen.getByLabelText('Quick create'));
  return view;
}

/**
 * Click a menu item and let the action it starts finish.
 *
 * Creating an invoice posts over the network for a server-backed company, so
 * the handler is async even when the browser path resolves immediately. A bare
 * `fireEvent.click` returns before the store has been written, and the
 * assertion that follows would be reading the state from before the click.
 */
const clickItem = async (label: string | RegExp): Promise<void> => {
  await act(async () => { fireEvent.click(item(label)!); });
};

const item = (label: string | RegExp): HTMLElement | null =>
  screen.queryAllByRole('menuitem').find((el) => {
    const text = (el.textContent ?? '').trim();
    return typeof label === 'string' ? text === label : label.test(text);
  }) ?? null;

const counts = () => ({
  invoices: useInvoiceStore.getState().invoices.length,
  bills: useBillStore.getState().bills.length,
  payments: usePaymentStore.getState().payments.length,
});

/** Grant every module the quick-create actions need. */
function entitleAll(): void {
  useEntitlementStore.getState().enableModule('sales');
  useEntitlementStore.getState().enableModule('purchases');
}

beforeEach(async () => {
  navigated = [];
  useInvoiceStore.setState({ invoices: [] });
  useBillStore.setState({ bills: [] });
  usePaymentStore.setState({ payments: [] });
  useInvoiceEditor.setState({ requestedEditorId: null });
  useBillEditor.setState({ requestedEditorId: null });
  usePaymentEditor.setState({ requestedEditorId: null });
  useStore.setState((s) => ({ settings: { ...s.settings, baseCurrency: 'JOD' } }));
  entitleAll();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ══ The stale placeholders ════════════════════════════════════════════════ */

describe('the obsolete "Soon" placeholders', () => {
  it('are gone for invoice, bill and payment', async () => {
    menu();
    expect(screen.queryByText(/New invoice · Soon/i)).toBeNull();
    expect(screen.queryByText(/New bill · Soon/i)).toBeNull();
    expect(screen.queryByText(/Record payment · Soon/i)).toBeNull();
    // Nothing in the menu claims a finished feature is still to come.
    expect(document.querySelector('[role="menu"]')?.textContent).not.toMatch(/soon/i);
  });

  it('leaves the three actions present and enabled', async () => {
    menu();
    for (const label of ['New invoice', 'New bill', 'Record payment']) {
      const el = item(label);
      expect(el, label).not.toBeNull();
      expect((el as HTMLButtonElement).disabled, label).toBe(false);
    }
  });

  it('lists the whole Create menu in the specified order', async () => {
    menu();
    expect(screen.getAllByRole('menuitem').map((el) => (el.textContent ?? '').trim())).toEqual([
      'New journal entry',
      'New customer',
      'New supplier',
      'New invoice',
      'New bill',
      'Record payment',
    ]);
  });
});

/* ══ The three actions ═════════════════════════════════════════════════════ */

describe('New invoice', () => {
  it('creates exactly one draft, navigates to Invoices and asks for its editor', async () => {
    menu();
    const before = counts().invoices;
    await clickItem('New invoice');

    expect(counts().invoices).toBe(before + 1);
    expect(navigated).toEqual(['invoices']);

    // The request names the draft that was just created — not merely "open the
    // invoices list", which is what the task explicitly rules out.
    const created = useInvoiceStore.getState().invoices.at(-1)!;
    expect(useInvoiceEditor.getState().requestedEditorId).toBe(created.id);
  });

  it('creates the draft in the company’s functional currency', async () => {
    menu();
    await clickItem('New invoice');
    const created = useInvoiceStore.getState().invoices.at(-1)!;
    // Derived by the store, never passed from the Dashboard.
    expect(created.currency).toBe('JOD');
    expect(created.exchangeRate).toBe(1);
  });
});

describe('New bill', () => {
  it('creates exactly one draft, navigates to Bills and asks for its editor', async () => {
    menu();
    const before = counts().bills;
    await clickItem('New bill');

    expect(counts().bills).toBe(before + 1);
    expect(navigated).toEqual(['bills']);
    expect(useBillEditor.getState().requestedEditorId)
      .toBe(useBillStore.getState().bills.at(-1)!.id);
  });

  it('creates the draft in the company’s functional currency', async () => {
    menu();
    await clickItem('New bill');
    expect(useBillStore.getState().bills.at(-1)!.currency).toBe('JOD');
  });
});

describe('Record payment', () => {
  it('creates exactly one draft, navigates to Payments and asks for its editor', async () => {
    menu();
    const before = counts().payments;
    await clickItem('Record payment');

    expect(counts().payments).toBe(before + 1);
    expect(navigated).toEqual(['payments']);
    expect(usePaymentEditor.getState().requestedEditorId)
      .toBe(usePaymentStore.getState().payments.at(-1)!.id);
  });

  it('creates a STANDALONE payment, not one allocated to a bill', async () => {
    // The user asked to record a payment, not to pay a particular bill.
    menu();
    await clickItem('Record payment');
    const payment = usePaymentStore.getState().payments.at(-1)!;
    expect(payment.supplierId ?? '').toBe('');
    expect(payment.allocations ?? []).toHaveLength(0);
    expect(payment.currency).toBe('JOD');
  });
});

/* ══ One click, one draft ══════════════════════════════════════════════════ */

describe('a single click creates a single draft', () => {
  it('does not double-create for any of the three actions', async () => {
    for (const [label, read] of [
      ['New invoice', () => counts().invoices],
      ['New bill', () => counts().bills],
      ['Record payment', () => counts().payments],
    ] as const) {
      cleanup();
      navigated = [];
      useInvoiceStore.setState({ invoices: [] });
      useBillStore.setState({ bills: [] });
      usePaymentStore.setState({ payments: [] });
      menu();
      await clickItem(label);
      expect(read(), label).toBe(1);
      expect(navigated, label).toHaveLength(1);
    }
  });

  it('consumes the editor request exactly once, so a remount does not reopen it', async () => {
    /*
     * The destination page reads the request in an effect, and React StrictMode
     * runs effects twice. `consume` clears as it reads, so the second call sees
     * nothing — which is why arriving at the page again later does not reopen a
     * drawer the user has closed.
     */
    menu();
    await clickItem('New invoice');
    const first = useInvoiceEditor.getState().consume();
    const second = useInvoiceEditor.getState().consume();
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});

/* ══ Failure ═══════════════════════════════════════════════════════════════ */

describe('when creation fails', () => {
  it('does not navigate, and does not open an editor for a record that was refused', async () => {
    // The store refuses — a subscription restriction, a validation failure, a
    // missing company context. Whatever the reason, the Dashboard must not walk
    // the user into an empty drawer.
    // The action is async now, so the refusal has to be a resolved promise --
    // a bare object would make the caller's `await` yield the object's `then`.
    vi.spyOn(useInvoiceStore.getState(), 'createDraft').mockResolvedValue({
      ok: false,
      error: 'Persistence is not allowed on this subscription.',
    });
    menu();
    await clickItem('New invoice');

    expect(navigated).toEqual([]);
    expect(useInvoiceEditor.getState().requestedEditorId).toBeNull();
    expect(counts().invoices).toBe(0);
    // …and the refusal is reported rather than swallowed.
    expect(document.body.textContent).toMatch(/Persistence is not allowed/i);
  });
});

/* ══ Entitlement and permission ════════════════════════════════════════════ */

describe('entitlement and permission', () => {
  it('hides an unentitled module rather than calling it "Soon"', async () => {
    /*
     * The established Ledgora behaviour for something the organization's package
     * does not include is to HIDE it — the sidebar does exactly this. "Soon"
     * would say the feature does not exist, which is a different and untrue
     * statement.
     */
    useEntitlementStore.getState().disableModule('sales');
    menu();

    expect(item('New invoice')).toBeNull();
    expect(document.querySelector('[role="menu"]')?.textContent).not.toMatch(/soon/i);
    // The rest of the menu is unaffected.
    expect(item('New journal entry')).not.toBeNull();
    expect(item('New bill')).not.toBeNull();
  });

  it('hides quick-create from a role that may not create documents', async () => {
    menu('viewer');
    expect(item('New invoice')).toBeNull();
    expect(item('New bill')).toBeNull();
    expect(item('Record payment')).toBeNull();
    // A viewer still reaches the actions that are theirs.
    expect(item('New journal entry')).not.toBeNull();
  });

  it('refuses at the STORE, so a restricted user cannot bypass the hidden menu', async () => {
    /*
     * The menu is an affordance, not the gate. Calling the store directly — as
     * devtools or any other code path would — must be refused on its own.
     */
    signInAs('viewer');

    const invoice = await useInvoiceStore.getState().createDraft({});
    const bill = useBillStore.getState().createDraft();
    const payment = usePaymentStore.getState().createDraft();

    for (const [label, result] of [['invoice', invoice], ['bill', bill], ['payment', payment]] as const) {
      expect(result.ok, label).toBe(false);
      expect(result.error, label).toMatch(/does not include/i);
    }
    expect(counts()).toEqual({ invoices: 0, bills: 0, payments: 0 });
  });

  it('lets an accountant quick-create all three', async () => {
    menu('accountant');
    expect(item('New invoice')).not.toBeNull();
    expect(item('New bill')).not.toBeNull();
    expect(item('Record payment')).not.toBeNull();
  });
});

/* ══ The existing actions ══════════════════════════════════════════════════ */

describe('the actions that already worked', () => {
  it('still navigate, and create nothing', async () => {
    for (const [label, view] of [
      ['New journal entry', 'journal'],
      ['New customer', 'customers'],
      ['New supplier', 'suppliers'],
    ] as const) {
      cleanup();
      navigated = [];
      menu();
      await clickItem(label);
      expect(navigated, label).toEqual([view]);
    }
    // These three are navigation only — none of them mints a document.
    expect(counts()).toEqual({ invoices: 0, bills: 0, payments: 0 });
  });
});

/* ══ The active company ════════════════════════════════════════════════════ */

describe('the active organization', () => {
  it('creates under whichever company is active at the time of the click', async () => {
    // Switching company changes the functional currency the store derives, so
    // the created document follows the company rather than a captured value.
    menu();
    await clickItem('New invoice');
    expect(useInvoiceStore.getState().invoices.at(-1)!.currency).toBe('JOD');

    cleanup();
    useStore.setState((s) => ({ settings: { ...s.settings, baseCurrency: 'EUR' } }));
    menu();
    await clickItem('New invoice');
    expect(useInvoiceStore.getState().invoices.at(-1)!.currency).toBe('EUR');
  });
});

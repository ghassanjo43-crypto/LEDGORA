// @vitest-environment happy-dom
/**
 * The Purchasing screens a durable subscriber actually uses, driven end to end.
 *
 * ══ Why these go through `fetch` ═════════════════════════════════════════════
 *
 * P2–P4 shipped a tested gateway that no visible screen called. A gateway test
 * proves the adapter; it does not prove a durable subscriber can record a bill.
 * So these render the REAL pages, click the REAL menus and fill in the REAL
 * drawers, and everything below them — the page handler, the actions layer, the
 * gateway, the API client, the URL, the method, the body and the error mapping
 * — runs unmocked against an in-memory server standing at the `fetch` boundary.
 *
 * That fake server enforces the same rules the PostgreSQL one does, and for the
 * same reasons: a posted payment is fully allocated, an outstanding balance is
 * derived from active allocations, and a bill a live payment settles cannot be
 * reversed. Its refusals are the server's own sentences, so a screen that
 * garbled one would fail here.
 *
 * ══ What is deliberately mocked ══════════════════════════════════════════════
 *
 * The supplier directory and the tax-code catalogue, because they are P1 and
 * P3 and have their own cutover tests. Nothing in the bill or payment write
 * path is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react';

const engine = vi.hoisted(() => ({ current: 'server' as 'server' | 'demo' }));
vi.mock('@/services/books/booksEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/books/booksEngine')>()),
  booksEngine: () => engine.current,
}));

const SUPPLIER = { id: 'sup-1', legalName: 'Acme Supplies Ltd' };

vi.mock('@/services/api/suppliersApi', () => ({
  suppliersApi: {
    list: vi.fn(async () => ({ parties: [], nextCursor: null })),
    count: vi.fn(async () => 0),
  },
}));
vi.mock('@/services/api/customersApi', () => ({
  customersApi: { list: vi.fn(async () => ({ parties: [], nextCursor: null })) },
}));
vi.mock('@/services/api/invoicesApi', () => ({ invoicesApi: { list: vi.fn(async () => []) } }));
vi.mock('@/services/api/accountingApi', () => ({
  accountingApi: { list: vi.fn(async () => []), create: vi.fn() },
}));
vi.mock('@/services/api/taxCodesApi', () => ({
  taxCodesApi: {
    list: vi.fn(async () => ([{
      id: 'tax-1', code: 'VATIN16', name: 'Standard-rated purchases', description: '',
      category: 'standard', calculationMethod: 'exclusive', direction: 'purchase',
      status: 'active', outputTaxAccountId: null, inputTaxAccountId: 'acct-input',
      effectiveFrom: '2020-01-01', effectiveTo: null, version: 1,
      rateVersions: [{
        id: 'rv-1', taxCodeId: 'tax-1', rate: '16.000000',
        effectiveFrom: '2020-01-01', effectiveTo: null,
        outputTaxAccountId: null, inputTaxAccountId: 'acct-input', createdAt: null,
      }],
    }])),
  },
}));

/* The supplier DIRECTORY the pickers read. P1's own cutover covers it. */
vi.mock('@/services/parties/useSuppliers', () => ({
  useSuppliers: () => ({
    suppliers: [{
      id: SUPPLIER.id, legalName: SUPPLIER.legalName, entityType: 'supplier',
      entityCode: 'ACME', isActive: true,
    }],
    serverBacked: true, loading: false, error: null, stranded: 0,
  }),
}));

import { BillsPage } from './BillsPage';
import { PaymentsPage } from './PaymentsPage';
import { ToastProvider } from '@/components/ui/Toast';
import { useStore } from '@/store/useStore';
import { useAuthStore } from '@/store/authStore';
import { useBillStore } from '@/store/billStore';
import { usePaymentStore } from '@/store/paymentStore';
import { clearBillCache, loadBills } from '@/services/bills/billBackend';
import { clearPaymentCache, loadPayments } from '@/services/payments/paymentBackend';
import { server, resetServer } from './__fixtures__/purchasingFakeServer';

/* ══ Harness ═══════════════════════════════════════════════════════════════ */

const account = (id: string, code: string, name: string, type: string) => ({
  id, code, name, type, parentId: null, level: 1,
  normalBalance: type === 'ASSET' || type === 'OPERATING_EXPENSE' ? 'DEBIT' : 'CREDIT',
  ifrsStatement: 'SFP', ifrsCategory: name, ifrsSubcategory: name,
  cashFlowCategory: 'OPERATING', isPostingAccount: true, isActive: true,
} as never);

function signIn(): void {
  useAuthStore.setState({
    users: [{
      id: 'u1', fullName: 'Tester', email: 't@t.test', mobile: '', country: 'JO',
      passwordHash: 'x', emailVerified: true, role: 'owner',
    } as never],
    currentUserId: 'u1',
  } as never);
}

/*
 * `PageActions` portals a page's primary button into the application header's
 * own slot, so the harness must provide that slot — otherwise "New bill" is
 * simply not in the document and the test would be asserting about a layout
 * detail rather than the page.
 */
function headerSlot(): HTMLElement {
  let slot = document.getElementById('page-header-actions');
  if (!slot) {
    slot = document.createElement('div');
    slot.id = 'page-header-actions';
    document.body.appendChild(slot);
  }
  return slot;
}

const bills = () => render(<ToastProvider><BillsPage /></ToastProvider>);
const payments = () => render(<ToastProvider><PaymentsPage /></ToastProvider>);

/** Open the Actions menu on the row whose text contains `label`. */
function rowActions(label: string): HTMLElement {
  const cell = screen.getByText(label);
  const row = cell.closest('tr');
  if (!row) throw new Error(`No row for ${label}`);
  fireEvent.click(within(row as HTMLElement).getByText('Actions'));
  return row as HTMLElement;
}

const click = (name: string | RegExp): void => {
  fireEvent.click(screen.getByText(name));
};

const type = (label: string | RegExp, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

/*
 * The supplier and account pickers are the application's own searchable
 * comboboxes — a button plus a portalled listbox — so the tests drive them the
 * way a user does rather than reaching past them. A `<select>` here would test
 * a widget the product does not ship.
 */
function comboboxShowing(text: RegExp): HTMLElement {
  const trigger = Array.from(document.querySelectorAll<HTMLElement>('[role="combobox"]'))
    .find((element) => text.test((element.textContent ?? '').trim()));
  if (!trigger) throw new Error(`No combobox showing ${text}`);
  return trigger;
}

function chooseFrom(trigger: HTMLElement, option: RegExp): void {
  fireEvent.click(trigger);
  const choice = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
    .find((element) => option.test((element.textContent ?? '').trim()));
  if (!choice) throw new Error(`No option matching ${option}`);
  fireEvent.click(choice);
}

const pickSupplier = (): void =>
  chooseFrom(comboboxShowing(/Select supplier|Acme Supplies/), /Acme Supplies/);

const pickPurchaseAccount = (): void =>
  chooseFrom(comboboxShowing(/Select account|Professional fees|^5100/), /Professional fees/);

/** Let every pending gateway round-trip and its re-read settle. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
  await waitFor(() => expect(server.pending).toBe(0));
  await act(async () => { await Promise.resolve(); });
}

beforeEach(async () => {
  engine.current = 'server';
  /* The suite is hermetic by default (`VITE_API_URL: ''`), which makes the
   * client refuse before it reaches `fetch`. These tests are about the request
   * actually travelling, so they configure a base the fake server answers. */
  vi.stubEnv('VITE_API_URL', 'http://localhost:3000');
  resetServer();
  localStorage.clear();
  vi.stubGlobal('fetch', server.fetch);
  headerSlot();
  signIn();
  useStore.setState({
    accounts: [
      account('acct-expense', '5100', 'Professional fees', 'OPERATING_EXPENSE'),
      account('acct-bank', '1100', 'Bank current cash', 'ASSET'),
    ],
    settings: { ...useStore.getState().settings, baseCurrency: 'JOD' },
  } as never);
  useBillStore.setState({ bills: [] });
  usePaymentStore.setState({ payments: [] });
  clearBillCache();
  clearPaymentCache();
  await act(async () => { await loadBills(); await loadPayments(); });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

/* ══ Recording a bill ══════════════════════════════════════════════════════ */

/** Fill and save a new bill through the rendered drawer. Returns its number. */
async function recordBill(reference: string, unitPrice: string, options: {
  taxCodeId?: string; dueDate?: string; post?: boolean;
} = {}): Promise<void> {
  click('New bill');
  await settle();

  pickSupplier();
  type('Supplier invoice number', reference);
  type('Bill date', '2026-03-01');
  type('Due date', options.dueDate ?? '2026-03-31');
  pickPurchaseAccount();
  type('Line 1 description', 'Consulting');
  type('Line 1 quantity', '1');
  type('Line 1 unit price', unitPrice);
  if (options.taxCodeId) {
    fireEvent.change(screen.getByLabelText('Line 1 tax code'), { target: { value: options.taxCodeId } });
  }

  click(options.post ? 'Post bill' : 'Save draft');
  await settle();
}

describe('a durable subscriber records a bill through the screen', () => {
  it('creates it on the SERVER, with a server-allocated number', async () => {
    bills();
    await recordBill('SUP-001', '1000');

    /* The record exists on the server, not in the browser store. */
    expect(server.bills).toHaveLength(1);
    expect(server.bills[0]!.billNumber).toBe('BILL-2026-0001');
    expect(server.bills[0]!.status).toBe('draft');
    expect(useBillStore.getState().bills).toHaveLength(0);

    /* And the screen is showing the server's record. */
    await waitFor(() => expect(screen.getByText('BILL-2026-0001')).toBeTruthy());
  });

  it('edits it, carrying the version the server last returned', async () => {
    bills();
    await recordBill('SUP-001', '1000');

    rowActions('BILL-2026-0001');
    click('Edit');
    await settle();

    type('Line 1 unit price', '1500');
    click('Save draft');
    await settle();

    expect(server.bills[0]!.total).toBe('1500.000');
    /* The PATCH carried the version the create returned, never one typed into
     * a form. */
    expect(server.lastPatchVersion).toBe(1);
  });

  it('posts it and shows the ledger’s own figures, tax included', async () => {
    bills();
    await recordBill('SUP-001', '1000', { taxCodeId: 'tax-1', post: true });

    expect(server.bills[0]!.status).toBe('posted');
    expect(server.bills[0]!.journalEntryId).toBeTruthy();
    /* 1,000 net plus 16% input tax, resolved by the SERVER. Nothing in the
     * browser computed this. */
    expect(server.bills[0]!.taxTotal).toBe('160.000');
    expect(server.bills[0]!.total).toBe('1160.000');

    await waitFor(() => expect(screen.getByText('BILL-2026-0001')).toBeTruthy());
    const row = screen.getByText('BILL-2026-0001').closest('tr')!;
    /* The row reports the server's total and its derived balance — both 1,160
     * because nothing has settled it. */
    expect(within(row).getAllByText(/1,160\.000/).length).toBeGreaterThanOrEqual(2);
  });

  it('offers the duplicate-reference override only when the SERVER refuses', async () => {
    bills();
    await recordBill('SUP-001', '1000', { post: true });
    /* The same supplier reference again, posted straight from the drawer. */
    await recordBill('SUP-001', '500', { post: true });

    /* The server's refusal, on screen, with the deliberate second action. */
    /* On screen twice, deliberately: the banner keeps it while the toast
     * announces it. */
    expect(screen.getAllByText(/already recorded on/i).length).toBeGreaterThan(0);
    const override = screen.getByText(/Post anyway/i);

    fireEvent.click(override);
    await settle();

    expect(server.bills[1]!.status).toBe('posted');
    /* The override travelled ONLY on the second attempt at this bill: it is a
     * deliberate act, never a default. */
    expect(server.postAttempts).toEqual([false, false, true]);
  });
});

describe('the refusals a durable subscriber can actually meet', () => {
  it('shows the STALE-VERSION refusal in the server’s own words', async () => {
    bills();
    await recordBill('SUP-001', '1000');

    rowActions('BILL-2026-0001');
    click('Edit');
    await settle();

    /* Somebody else saves while this drawer is open. The next save from here
     * carries the version the cache holds, which the server no longer accepts. */
    server.bumpVersionOutsideThisSession('BILL-2026-0001');

    type('Line 1 unit price', '1500');
    click('Save draft');
    await settle();

    expect(screen.getAllByText(/changed by another user/i).length).toBeGreaterThan(0);
    /* A refusal, not a merge: the other edit still stands. */
    expect(server.bills[0]!.total).toBe('1000.000');
  });

  it('shows a MISSING-ACCOUNT refusal rather than posting anyway', async () => {
    server.breakPayableAccount();
    bills();
    await recordBill('SUP-001', '1000', { post: true });

    expect(screen.getAllByText(/no accounts payable account set/i).length).toBeGreaterThan(0);
    expect(server.bills[0]!.status).toBe('draft');
  });
});

/* ══ Paying it ═════════════════════════════════════════════════════════════ */

/** Fill and post a payment through the rendered drawer. */
async function payBills(amount: string, allocations: Record<string, string>): Promise<void> {
  click('New payment');
  await settle();

  pickSupplier();
  type('Payment date', '2026-04-01');
  type('Payment amount', amount);
  fireEvent.change(screen.getByLabelText('Paying account'), { target: { value: 'acct-bank' } });
  await settle();

  for (const [billNumber, value] of Object.entries(allocations)) {
    type(`Allocate to ${billNumber}`, value);
  }

  click('Post payment');
  await settle();
}

describe('a durable subscriber pays through the screen', () => {
  beforeEach(async () => {
    /* Two posted bills to settle: 1,000 and 400. */
    bills();
    await recordBill('SUP-001', '1000', { post: true });
    await recordBill('SUP-002', '400', { post: true, dueDate: '2026-02-01' });
    cleanup();
  });

  it('creates a fully allocated payment and posts it', async () => {
    payments();
    await payBills('1000', { 'BILL-2026-0001': '1000' });

    expect(server.payments).toHaveLength(1);
    expect(server.payments[0]!.status).toBe('posted');
    expect(server.payments[0]!.journalEntryId).toBeTruthy();
    expect(server.allocations.filter((a) => a.status === 'active')).toHaveLength(1);
    /* Nothing was written to the browser store. */
    expect(usePaymentStore.getState().payments).toHaveLength(0);
  });

  it('refuses to post while anything is unallocated, and says why', async () => {
    payments();
    click('New payment');
    await settle();

    pickSupplier();
    type('Payment date', '2026-04-01');
    type('Payment amount', '1000');
    fireEvent.change(screen.getByLabelText('Paying account'), { target: { value: 'acct-bank' } });
    await settle();

    type('Allocate to BILL-2026-0001', '600');

    /* The button is disabled, and the reason is on screen the whole time. */
    const post = screen.getByText('Post payment').closest('button')!;
    expect(post.disabled).toBe(true);
    expect(screen.getByTestId('durable-payment-remaining').textContent).toMatch(/400/);
    expect(screen.getByText(/is not yet allocated/i)).toBeTruthy();
    expect(screen.getByText(/unapplied cash|allocated in full/i)).toBeTruthy();
    /* And nothing was posted. */
    expect(server.payments.filter((p) => p.status === 'posted')).toHaveLength(0);
  });

  it('PARTLY pays a bill while the payment itself is fully allocated', async () => {
    payments();
    await payBills('600', { 'BILL-2026-0001': '600' });

    expect(server.payments[0]!.status).toBe('posted');
    /* The PAYMENT is whole; the BILL is not. Those are different questions,
     * and only the first has a rule. */
    expect(server.outstandingFor('BILL-2026-0001')).toBe('400.000');
    expect(server.outstandingFor('BILL-2026-0002')).toBe('400.000');
  });

  it('spreads ONE payment across several bills', async () => {
    payments();
    await payBills('1400', { 'BILL-2026-0001': '1000', 'BILL-2026-0002': '400' });

    expect(server.allocations.filter((a) => a.status === 'active')).toHaveLength(2);
    expect(server.outstandingFor('BILL-2026-0001')).toBe('0.000');
    expect(server.outstandingFor('BILL-2026-0002')).toBe('0.000');
  });

  it('shows the updated outstanding balances after posting', async () => {
    payments();
    await payBills('600', { 'BILL-2026-0001': '600' });

    click('What is owed');
    await settle();

    const schedule = screen.getByTestId('outstanding-schedule');
    expect(within(schedule).getByTestId('outstanding-BILL-2026-0001').textContent).toMatch(/400\.000/);
    expect(within(schedule).getByTestId('outstanding-BILL-2026-0002').textContent).toMatch(/400\.000/);
  });

  it('refuses an over-allocation with the SERVER’s own words', async () => {
    payments();
    click('New payment');
    await settle();

    pickSupplier();
    type('Payment date', '2026-04-01');
    type('Payment amount', '2000');
    fireEvent.change(screen.getByLabelText('Paying account'), { target: { value: 'acct-bank' } });
    await settle();

    /* Balanced against the payment, but more than the bill owes. Only the
     * server can know that, and only the server may say so. */
    type('Allocate to BILL-2026-0001', '1600');
    type('Allocate to BILL-2026-0002', '400');

    click('Post payment');
    await settle();

    await waitFor(() => expect(screen.getAllByText(/more than bill .* still owes/i).length).toBeGreaterThan(0));
    expect(server.payments.filter((p) => p.status === 'posted')).toHaveLength(0);
  });
});

/* ══ Correcting and reversing ══════════════════════════════════════════════ */

describe('correcting a durable payment through the screen', () => {
  beforeEach(async () => {
    bills();
    await recordBill('SUP-001', '1000', { post: true });
    await recordBill('SUP-002', '1000', { post: true });
    cleanup();
    payments();
    await payBills('1000', { 'BILL-2026-0001': '1000' });
  });

  it('reallocates the WHOLE payment onto another bill', async () => {
    rowActions('PAY-2026-0001');
    click('Reallocate');
    await settle();

    type('Reallocate to BILL-2026-0001', '0');
    type('Reallocate to BILL-2026-0002', '1000');
    click('Replace allocations');
    await settle();

    expect(server.outstandingFor('BILL-2026-0001')).toBe('1000.000');
    expect(server.outstandingFor('BILL-2026-0002')).toBe('0.000');
    /* The old row is KEPT, marked superseded. Nothing was deleted. */
    expect(server.allocations).toHaveLength(2);
    expect(server.allocations.filter((a) => a.status === 'superseded')).toHaveLength(1);
  });

  it('will not submit a partial reallocation at all', async () => {
    rowActions('PAY-2026-0001');
    click('Reallocate');
    await settle();

    type('Reallocate to BILL-2026-0001', '600');

    const replace = screen.getByText('Replace allocations').closest('button')!;
    expect(replace.disabled).toBe(true);
    expect(screen.getByTestId('reallocate-remaining').textContent).toMatch(/still needs a bill/i);
    /* And the dialog says what the two complete corrections are. */
    expect(screen.getByText(/reallocate the full amount|reverse the payment/i)).toBeTruthy();
  });

  it('reverses the payment and the bill balance reopens', async () => {
    rowActions('PAY-2026-0001');
    click('Reverse');
    await settle();

    fireEvent.change(screen.getByPlaceholderText(/Reason for reversal/i), {
      target: { value: 'Bank returned it' },
    });
    click('Reverse payment');
    await settle();

    expect(server.payments[0]!.status).toBe('reversed');
    expect(server.allocations.every((a) => a.status === 'reversed')).toBe(true);
    expect(server.outstandingFor('BILL-2026-0001')).toBe('1000.000');
  });
});

describe('reversing a bill through the screen', () => {
  beforeEach(async () => {
    bills();
    await recordBill('SUP-001', '1000', { post: true });
    await recordBill('SUP-002', '500', { post: true });
    cleanup();
  });

  const reverseBillRow = async (billNumber: string, reason: string): Promise<void> => {
    rowActions(billNumber);
    click('Reverse');
    await settle();
    fireEvent.change(screen.getByPlaceholderText(/Reason for reversal/i), { target: { value: reason } });
    click('Reverse bill');
    await settle();
  };

  it('reverses an UNALLOCATED bill', async () => {
    bills();
    await reverseBillRow('BILL-2026-0002', 'Duplicate entry');

    expect(server.bills[1]!.status).toBe('reversed');
    expect(server.bills[1]!.reversalJournalEntryId).toBeTruthy();
  });

  it('shows the BLOCKING-PAYMENT message when the bill is settled', async () => {
    payments();
    await payBills('1000', { 'BILL-2026-0001': '1000' });
    cleanup();

    bills();
    await reverseBillRow('BILL-2026-0001', 'Wrong supplier');

    /* The server's refusal reaches the user intact: the payment number, the
     * amount, and the two routes that are actually complete. */
    const message = await screen.findByText(/cannot be reversed while/i);
    expect(message.textContent).toMatch(/PAY-2026-0001/);
    expect(message.textContent).toMatch(/1000\.000/);
    expect(message.textContent).toMatch(/reverse that payment first/i);
    expect(message.textContent).toMatch(/reallocate its full amount/i);
    expect(message.textContent).not.toMatch(/unallocate the payment first/i);

    expect(server.bills[0]!.status).toBe('posted');
  });

  it('permits the reversal once the payment has been reversed', async () => {
    payments();
    await payBills('1000', { 'BILL-2026-0001': '1000' });

    rowActions('PAY-2026-0001');
    click('Reverse');
    await settle();
    fireEvent.change(screen.getByPlaceholderText(/Reason for reversal/i), { target: { value: 'Returned' } });
    click('Reverse payment');
    await settle();
    cleanup();

    bills();
    await reverseBillRow('BILL-2026-0001', 'Wrong supplier');
    expect(server.bills[0]!.status).toBe('reversed');
  });
});

/* ══ The payables reports ══════════════════════════════════════════════════ */

describe('what is owed, on screen', () => {
  beforeEach(async () => {
    bills();
    await recordBill('SUP-001', '1000', { post: true, dueDate: '2026-03-01' });
    await recordBill('SUP-002', '400', { post: true, dueDate: '2026-07-01' });
    cleanup();
    payments();
    await payBills('600', { 'BILL-2026-0001': '600' });
  });

  it('ages the REMAINING balance, in the server’s own buckets', async () => {
    click('What is owed');
    await settle();

    const ageing = screen.getByTestId('ap-ageing');
    /* 400 left on the paid-down bill and 400 on the other. Both are the
     * server's figures, in the server's own buckets — the browser bucketed
     * nothing and summed nothing. */
    expect(within(ageing).getByTestId('ageing-total').textContent).toMatch(/800\.000/);
    /* Exactly one bucket carries the whole 800: the browser neither bucketed
     * nor summed anything, so this is a statement about the server's answer. */
    const amounts = ['current', '1-30', '31-60', '61-90', '91-120', '120-plus'].map((id) => {
      const text = within(ageing).getByTestId(`ageing-${id}`).textContent ?? '';
      return Number(text.replace(/[^0-9.]/g, '')) || 0;
    });
    expect(amounts.filter((value) => value > 0)).toEqual([800]);
  });

  it('shows a supplier statement that reconciles', async () => {
    click('What is owed');
    await settle();

    fireEvent.change(screen.getByLabelText('Statement supplier'), { target: { value: SUPPLIER.id } });
    await settle();

    const statement = await screen.findByTestId('supplier-statement');
    expect(within(statement).getByTestId('statement-closing').textContent).toMatch(/800\.000/);
    /* The server compared its running balance against the bill subledger by two
     * different routes and reported that they agree. */
    expect(within(statement).getByTestId('statement-reconciled').textContent).toMatch(/Reconciled/i);
    /* Every movement, including the payment. */
    expect(within(statement).getAllByTestId('statement-line').length).toBeGreaterThanOrEqual(4);
  });
});

/* ══ Durability ════════════════════════════════════════════════════════════ */

describe('clearing browser storage', () => {
  it('loses nothing: the books are on the server', async () => {
    bills();
    await recordBill('SUP-001', '1000', { post: true });
    cleanup();
    payments();
    await payBills('400', { 'BILL-2026-0001': '400' });
    cleanup();

    /* The reload a user performs after clearing site data. */
    localStorage.clear();
    clearBillCache();
    clearPaymentCache();
    await act(async () => { await loadBills(); await loadPayments(); });

    bills();
    await waitFor(() => expect(screen.getByText('BILL-2026-0001')).toBeTruthy());
    const row = screen.getByText('BILL-2026-0001').closest('tr')!;
    /* Total AND the settled portion survived, because neither was ever here. */
    expect(within(row).getByText(/1,000\.000/)).toBeTruthy();
    expect(within(row).getByText(/600\.000/)).toBeTruthy();
    cleanup();

    payments();
    await waitFor(() => expect(screen.getByText('PAY-2026-0001')).toBeTruthy());
  });
});

/* ══ Free Demo ═════════════════════════════════════════════════════════════ */

describe('Free Demo keeps its own disposable behaviour', () => {
  beforeEach(async () => {
    engine.current = 'demo';
    clearBillCache();
    clearPaymentCache();
    /* The durable setup above spoke to the server; from here nothing may. */
    resetServer();
  });

  it('creates a bill in the BROWSER, and asks the server for nothing', async () => {
    bills();
    click('New bill');
    await settle();

    expect(useBillStore.getState().bills).toHaveLength(1);
    expect(server.bills).toHaveLength(0);
    /* Not one request left the browser. */
    expect(server.requests).toHaveLength(0);
  });

  it('creates a payment in the BROWSER, with the demo drawer', async () => {
    payments();
    click('New payment');
    await settle();

    expect(usePaymentStore.getState().payments).toHaveLength(1);
    expect(server.payments).toHaveLength(0);
    expect(server.requests).toHaveLength(0);
  });

  it('offers no payables report, which is a server thing', async () => {
    payments();
    expect(screen.queryByText('What is owed')).toBeNull();
    expect(screen.queryByTestId('payables-panel')).toBeNull();
  });
});

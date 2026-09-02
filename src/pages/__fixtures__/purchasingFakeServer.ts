/**
 * An in-memory Purchasing server, standing where `fetch` does.
 *
 * ══ Why a fake at the network boundary rather than a mocked module ═══════════
 *
 * The point of the Purchasing cutover tests is that a durable subscriber's
 * clicks reach the server. Mocking `billsApi` would leave the URL, the method,
 * the body shape and the error mapping untested — exactly the layer that was
 * missing before this slice. So the real client runs, and this answers it.
 *
 * ══ It enforces the real rules, in the real words ════════════════════════════
 *
 * A posted payment must be fully allocated; an allocation may not exceed what a
 * bill still owes; a bill a live payment settles cannot be reversed, and the
 * refusal names the payments. The sentences are the server's own, so a screen
 * that garbled or replaced one fails the test that reads it.
 *
 * The arithmetic is deliberately ordinary: `server/tests/supplierPayments.test.ts`
 * proves the exact-decimal BigInt maths against PostgreSQL. What is proved here
 * is the wiring, so three decimal places and plain numbers are enough — and the
 * fixtures use amounts that are exact in binary anyway.
 */

type Json = Record<string, unknown>;

interface FakeBill {
  id: string;
  billNumber: string;
  supplierInvoiceNumber: string;
  status: 'draft' | 'posted' | 'reversed';
  issuingEntityId: string;
  supplierId: string;
  billDate: string;
  postingDate: string;
  dueDate: string;
  currency: string;
  memo: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  payableAccountId: string | null;
  inputTaxAccountId: string | null;
  journalEntryId: string | null;
  reversalJournalEntryId: string | null;
  reversalReason: string | null;
  postedAt: string | null;
  reversedAt: string | null;
  version: number;
  lines: Json[];
}

interface FakePayment {
  id: string;
  paymentNumber: string;
  status: 'draft' | 'posted' | 'reversed';
  issuingEntityId: string;
  supplierId: string;
  paymentDate: string;
  currency: string;
  amount: string;
  method: string;
  reference: string;
  memo: string;
  cashAccountId: string | null;
  payableAccountId: string | null;
  journalEntryId: string | null;
  reversalJournalEntryId: string | null;
  reversalReason: string | null;
  postedAt: string | null;
  reversedAt: string | null;
  version: number;
}

interface FakeAllocation {
  id: string;
  paymentId: string;
  billId: string;
  amount: number;
  status: 'active' | 'superseded' | 'reversed';
}

/** JOD, three decimals — the currency the fixtures use. */
const D3 = (value: number): string => value.toFixed(3);
const num = (value: unknown): number => Number(value ?? 0);

/** The one purchase tax code the catalogue mock offers. */
const TAX_RATE: Record<string, number> = { 'tax-1': 0.16 };

interface State {
  bills: FakeBill[];
  payments: FakePayment[];
  allocations: FakeAllocation[];
  billSeq: number;
  paySeq: number;
  journalSeq: number;
  requests: Array<{ method: string; path: string }>;
  postAttempts: boolean[];
  lastPatchVersion: number | null;
  pending: number;
  /** Set when a test wants the supplier's payable account to be missing. */
  payableConfigured: boolean;
}

const state: State = {
  bills: [], payments: [], allocations: [],
  billSeq: 0, paySeq: 0, journalSeq: 0,
  requests: [], postAttempts: [], lastPatchVersion: null, pending: 0,
  payableConfigured: true,
};

export function resetServer(): void {
  state.bills = []; state.payments = []; state.allocations = [];
  state.billSeq = 0; state.paySeq = 0; state.journalSeq = 0;
  state.requests = []; state.postAttempts = []; state.lastPatchVersion = null;
  state.pending = 0;
  state.payableConfigured = true;
}

/* ══ Derived, exactly as the real server derives it ════════════════════════ */

function activeFor(billId: string): number {
  return state.allocations
    .filter((a) => a.billId === billId && a.status === 'active')
    .reduce((sum, a) => sum + a.amount, 0);
}

function outstanding(bill: FakeBill): number {
  return num(bill.total) - activeFor(bill.id);
}

function livePaymentsFor(billId: string): Array<{ number: string; amount: number }> {
  return state.allocations
    .filter((a) => a.billId === billId && a.status === 'active')
    .map((a) => ({
      number: state.payments.find((p) => p.id === a.paymentId)?.paymentNumber ?? '?',
      amount: a.amount,
    }))
    .sort((a, b) => a.number.localeCompare(b.number));
}

/* ══ Errors, in the server's own words ═════════════════════════════════════ */

class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const UNAPPLIED =
  'A supplier payment must be allocated in full to posted bills. Unapplied cash, supplier advances '
  + 'and overpayments are not supported: the advances account is defined only by a browser account '
  + 'code with no controlled mapping on the server, and supplier refunds have no workflow at all, '
  + 'so an unapplied balance would be money with nowhere defined to sit. Allocate the whole amount, '
  + 'or record a smaller payment. Nothing has been saved.';

/* ══ Bills ═════════════════════════════════════════════════════════════════ */

function computeTotals(lines: Json[]): {
  subtotal: number; discountTotal: number; taxTotal: number; total: number; priced: Json[];
} {
  let subtotal = 0; let discountTotal = 0; let taxTotal = 0;
  const priced = lines.map((line, index) => {
    const gross = num(line.quantity) * num(line.unitPrice);
    const discount = line.discountType === 'percentage'
      ? gross * (num(line.discountValue) / 100)
      : 0;
    const net = gross - discount;
    const rate = line.taxCodeId ? (TAX_RATE[String(line.taxCodeId)] ?? 0) : 0;
    const tax = net * rate;
    subtotal += gross; discountTotal += discount; taxTotal += tax;
    return {
      id: `line-${index + 1}`, lineNumber: index + 1,
      description: String(line.description ?? ''), accountId: String(line.accountId ?? ''),
      quantity: D3(num(line.quantity)), unit: String(line.unit ?? ''),
      unitPrice: D3(num(line.unitPrice)),
      discountType: line.discountType ?? null, discountValue: line.discountValue ?? null,
      discountAmount: D3(discount),
      lineSubtotal: D3(gross), lineNet: D3(net),
      taxableAmount: D3(net), taxAmount: D3(tax), grossAmount: D3(net + tax),
      taxCodeId: line.taxCodeId ?? null,
      /* Frozen at posting on the real server; the shape is what matters here. */
      taxSnapshot: line.taxCodeId ? { rate: D3(rate * 100) } : null,
    } as Json;
  });
  return { subtotal, discountTotal, taxTotal, total: subtotal - discountTotal + taxTotal, priced };
}

function billBody(body: Json, bill: FakeBill): void {
  const { subtotal, discountTotal, taxTotal, total, priced } =
    computeTotals((body.lines as Json[]) ?? []);
  bill.supplierInvoiceNumber = String(body.supplierInvoiceNumber ?? '');
  bill.billDate = String(body.billDate ?? bill.billDate);
  bill.postingDate = String(body.postingDate ?? body.billDate ?? bill.postingDate);
  bill.dueDate = String(body.dueDate ?? bill.dueDate);
  bill.memo = String(body.memo ?? '');
  if (body.supplierId) bill.supplierId = String(body.supplierId);
  bill.subtotal = D3(subtotal);
  bill.discountTotal = D3(discountTotal);
  bill.taxTotal = D3(taxTotal);
  bill.total = D3(total);
  bill.inputTaxAccountId = taxTotal > 0 ? 'acct-input' : null;
  bill.lines = priced;
}

function createBill(body: Json): FakeBill {
  state.billSeq += 1;
  const bill: FakeBill = {
    id: `bill-${state.billSeq}`,
    billNumber: `BILL-2026-${String(state.billSeq).padStart(4, '0')}`,
    supplierInvoiceNumber: '', status: 'draft',
    issuingEntityId: String(body.issuingEntityId ?? 'primary'),
    supplierId: String(body.supplierId ?? ''),
    billDate: '', postingDate: '', dueDate: '', currency: 'JOD', memo: '',
    subtotal: '0.000', discountTotal: '0.000', taxTotal: '0.000', total: '0.000',
    payableAccountId: 'acct-payable', inputTaxAccountId: null,
    journalEntryId: null, reversalJournalEntryId: null, reversalReason: null,
    postedAt: null, reversedAt: null, version: 1, lines: [],
  };
  billBody(body, bill);
  state.bills.push(bill);
  return bill;
}

function postBill(bill: FakeBill, body: Json): FakeBill {
  const override = body.overrideDuplicate === true;
  state.postAttempts.push(override);

  if (bill.status !== 'draft') {
    throw new Refusal(409, 'conflict', `A ${bill.status} bill cannot be posted.`);
  }
  if (!state.payableConfigured) {
    throw new Refusal(
      422, 'validation_error',
      'Acme Supplies Ltd has no accounts payable account set, so there is nothing for this bill to '
      + 'credit. What the business owes a supplier is a liability; set the payable account on the '
      + 'supplier record and post again. Nothing has been saved.',
    );
  }
  const clash = state.bills.find((other) => (
    other.id !== bill.id
    && other.status === 'posted'
    && other.supplierId === bill.supplierId
    && other.supplierInvoiceNumber
    && other.supplierInvoiceNumber === bill.supplierInvoiceNumber
  ));
  if (clash && !override) {
    throw new Refusal(
      422, 'validation_error',
      `${bill.supplierInvoiceNumber} is already recorded on posted bill ${clash.billNumber} for this `
      + 'supplier. Paying the same supplier document twice is what this check exists for. Post it '
      + 'again with an explicit override if it really is a different document.',
    );
  }

  state.journalSeq += 1;
  bill.status = 'posted';
  bill.journalEntryId = `je-${state.journalSeq}`;
  bill.postedAt = '2026-03-01T00:00:00.000Z';
  bill.version += 1;
  return bill;
}

function reverseBill(bill: FakeBill, body: Json): FakeBill {
  if (!String(body.reason ?? '').trim()) {
    throw new Refusal(422, 'validation_error', 'A reversal reason is required.');
  }
  if (bill.status === 'reversed') throw new Refusal(409, 'conflict', 'This bill is already reversed.');
  if (bill.status !== 'posted') throw new Refusal(409, 'conflict', 'Only a posted bill can be reversed.');

  const live = livePaymentsFor(bill.id);
  if (live.length > 0) {
    const named = live.map((l) => `${l.number} (${D3(l.amount)})`).join(', ');
    throw new Refusal(
      409, 'conflict',
      `Bill ${bill.billNumber} cannot be reversed while ${live.length === 1 ? 'a payment settles' : 'payments settle'} `
      + `it: ${named}. Reversing it now would debit accounts payable a second time against a single `
      + 'credit, understating what is owed and leaving the payment pointing at a document reversed out '
      + `of the books. Either reverse ${live.length === 1 ? 'that payment' : 'those payments'} first, or `
      + `reallocate ${live.length === 1 ? 'its' : 'their'} full amount to other posted bills for the same `
      + 'supplier. A payment cannot simply be detached, because unapplied cash is not supported.',
    );
  }

  state.journalSeq += 1;
  bill.status = 'reversed';
  bill.reversalJournalEntryId = `je-${state.journalSeq}`;
  bill.reversalReason = String(body.reason);
  bill.reversedAt = '2026-03-02T00:00:00.000Z';
  bill.version += 1;
  return bill;
}

/* ══ Payments ══════════════════════════════════════════════════════════════ */

function createPayment(body: Json): FakePayment {
  state.paySeq += 1;
  const payment: FakePayment = {
    id: `pay-${state.paySeq}`,
    paymentNumber: `PAY-2026-${String(state.paySeq).padStart(4, '0')}`,
    status: 'draft',
    issuingEntityId: String(body.issuingEntityId ?? 'primary'),
    supplierId: String(body.supplierId ?? ''),
    paymentDate: String(body.paymentDate ?? ''),
    currency: 'JOD',
    amount: D3(num(body.amount)),
    method: String(body.method ?? 'bank-transfer'),
    reference: String(body.reference ?? ''),
    memo: String(body.memo ?? ''),
    cashAccountId: (body.cashAccountId as string) ?? null,
    payableAccountId: null,
    journalEntryId: null, reversalJournalEntryId: null, reversalReason: null,
    postedAt: null, reversedAt: null, version: 1,
  };
  state.payments.push(payment);
  return payment;
}

/**
 * The allocation rules, in one place — because posting and reallocating apply
 * exactly the same ones, which is the property the real service has too.
 */
function validateAllocations(
  payment: FakePayment,
  incoming: Json[],
  ignorePaymentId?: string,
): Array<{ billId: string; amount: number }> {
  if (incoming.length === 0) throw new Refusal(422, 'validation_error', UNAPPLIED);

  const resolved: Array<{ billId: string; amount: number }> = [];
  const seen = new Set<string>();

  for (const line of incoming) {
    const billId = String(line.billId);
    if (seen.has(billId)) {
      throw new Refusal(422, 'validation_error', 'The same bill appears twice in the allocations.');
    }
    seen.add(billId);

    const amount = num(line.amount);
    const bill = state.bills.find((b) => b.id === billId);
    if (!bill) throw new Refusal(404, 'not_found', 'Bill not found.');
    if (bill.status !== 'posted') {
      throw new Refusal(
        422, 'validation_error',
        `Bill ${bill.billNumber} is ${bill.status} and cannot be paid. Only a posted bill records a liability to settle.`,
      );
    }
    if (bill.supplierId !== payment.supplierId) {
      throw new Refusal(
        422, 'validation_error',
        `Bill ${bill.billNumber} belongs to a different supplier.`,
      );
    }

    const heldByThis = ignorePaymentId
      ? state.allocations
          .filter((a) => a.billId === billId && a.paymentId === ignorePaymentId && a.status === 'active')
          .reduce((sum, a) => sum + a.amount, 0)
      : 0;
    const available = num(bill.total) - activeFor(billId) + heldByThis;

    if (amount > available + 1e-9) {
      throw new Refusal(
        422, 'validation_error',
        `Allocation of ${D3(amount)} is more than bill ${bill.billNumber} still owes `
        + `(${D3(available)}). Over-allocating would create a negative balance, which is an `
        + 'overpayment by another name. Nothing has been saved.',
      );
    }
    resolved.push({ billId, amount });
  }

  const total = resolved.reduce((sum, r) => sum + r.amount, 0);
  if (Math.abs(total - num(payment.amount)) > 1e-9) {
    throw new Refusal(
      422, 'validation_error',
      total > num(payment.amount)
        ? `Allocations total ${D3(total)}, which is more than the payment of ${payment.amount}. Nothing has been saved.`
        : UNAPPLIED,
    );
  }
  return resolved;
}

function postPayment(payment: FakePayment, body: Json): FakePayment {
  if (payment.status !== 'draft') {
    throw new Refusal(409, 'conflict', `A ${payment.status} payment cannot be posted.`);
  }
  const resolved = validateAllocations(payment, (body.allocations as Json[]) ?? []);

  state.journalSeq += 1;
  for (const line of resolved) {
    state.allocations.push({
      id: `alloc-${state.allocations.length + 1}`,
      paymentId: payment.id, billId: line.billId, amount: line.amount, status: 'active',
    });
  }
  payment.status = 'posted';
  payment.journalEntryId = `je-${state.journalSeq}`;
  payment.payableAccountId = 'acct-payable';
  payment.postedAt = '2026-04-01T00:00:00.000Z';
  payment.version += 1;
  return payment;
}

function reallocatePayment(payment: FakePayment, body: Json): FakePayment {
  if (payment.status !== 'posted') {
    throw new Refusal(409, 'conflict', `Only a posted payment can be reallocated. This one is ${payment.status}.`);
  }
  /* Validated against the balances that will be true once the old rows are
   * superseded — the same order the real service uses. */
  const resolved = validateAllocations(payment, (body.allocations as Json[]) ?? [], payment.id);

  for (const allocation of state.allocations) {
    if (allocation.paymentId === payment.id && allocation.status === 'active') {
      allocation.status = 'superseded';
    }
  }
  for (const line of resolved) {
    state.allocations.push({
      id: `alloc-${state.allocations.length + 1}`,
      paymentId: payment.id, billId: line.billId, amount: line.amount, status: 'active',
    });
  }
  payment.version += 1;
  return payment;
}

function reversePayment(payment: FakePayment, body: Json): FakePayment {
  if (!String(body.reason ?? '').trim()) {
    throw new Refusal(422, 'validation_error', 'A reversal reason is required.');
  }
  if (payment.status === 'reversed') throw new Refusal(409, 'conflict', 'This payment is already reversed.');
  if (payment.status !== 'posted') throw new Refusal(409, 'conflict', 'Only a posted payment can be reversed.');

  for (const allocation of state.allocations) {
    if (allocation.paymentId === payment.id && allocation.status === 'active') {
      allocation.status = 'reversed';
    }
  }
  state.journalSeq += 1;
  payment.status = 'reversed';
  payment.reversalJournalEntryId = `je-${state.journalSeq}`;
  payment.reversalReason = String(body.reason);
  payment.reversedAt = '2026-04-02T00:00:00.000Z';
  payment.version += 1;
  return payment;
}

/* ══ Reads ═════════════════════════════════════════════════════════════════ */

function paymentView(payment: FakePayment): Json {
  return {
    ...payment,
    allocations: state.allocations
      .filter((a) => a.paymentId === payment.id && a.status === 'active')
      .map((a) => ({
        id: a.id, billId: a.billId,
        billNumber: state.bills.find((b) => b.id === a.billId)?.billNumber ?? '',
        amount: D3(a.amount), status: a.status, createdAt: '2026-04-01T00:00:00.000Z',
      })),
  };
}

const BUCKETS = [
  { id: 'current', label: 'Current' },
  { id: '1-30', label: '1–30 days' },
  { id: '31-60', label: '31–60 days' },
  { id: '61-90', label: '61–90 days' },
  { id: '91-120', label: '91–120 days' },
  { id: '120-plus', label: 'Over 120 days' },
] as const;

const daysOverdue = (dueDate: string, asOf: string): number => Math.max(
  0, Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000),
);

const bucketFor = (days: number): string => {
  if (days <= 0) return 'current';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  if (days <= 120) return '91-120';
  return '120-plus';
};

function outstandingRows(asOf: string, supplierId?: string): Json[] {
  return state.bills
    .filter((bill) => bill.status === 'posted' && (!supplierId || bill.supplierId === supplierId))
    .map((bill) => {
      const owed = outstanding(bill);
      const days = daysOverdue(bill.dueDate, asOf);
      return {
        billId: bill.id, billNumber: bill.billNumber, supplierId: bill.supplierId,
        supplierName: 'Acme Supplies Ltd', supplierInvoiceNumber: bill.supplierInvoiceNumber,
        billDate: bill.billDate, dueDate: bill.dueDate, currency: bill.currency,
        total: bill.total, paid: D3(activeFor(bill.id)), outstanding: D3(owed),
        daysOverdue: days, agingBucket: bucketFor(days),
        _owed: owed,
      } as Json;
    })
    .filter((row) => (row._owed as number) > 1e-9)
    .map(({ _owed, ...row }) => row as Json);
}

function ageing(asOf: string, supplierId?: string): Json {
  const rows = outstandingRows(asOf, supplierId);
  const totals = new Map<string, number>(BUCKETS.map((b) => [b.id, 0]));
  const ids = new Map<string, string[]>(BUCKETS.map((b) => [b.id, []]));
  for (const row of rows) {
    const bucket = String(row.agingBucket);
    totals.set(bucket, (totals.get(bucket) ?? 0) + num(row.outstanding));
    ids.get(bucket)!.push(String(row.billId));
  }
  return {
    asOfDate: asOf, currency: 'JOD',
    buckets: BUCKETS.map((b) => ({
      id: b.id, label: b.label, amount: D3(totals.get(b.id) ?? 0), billIds: ids.get(b.id) ?? [],
    })),
    total: D3([...totals.values()].reduce((sum, value) => sum + value, 0)),
    suppliers: [],
  };
}

function statement(supplierId: string, start: string, end: string): Json {
  interface Movement { id: string; type: string; date: string; doc: string; debit: number; credit: number; description: string }
  const movements: Movement[] = [];

  for (const bill of state.bills) {
    if (bill.supplierId !== supplierId) continue;
    if (bill.status === 'draft') continue;
    movements.push({
      id: `bill:${bill.id}`, type: 'bill', date: bill.billDate, doc: bill.billNumber,
      debit: 0, credit: num(bill.total), description: `Bill ${bill.billNumber}`,
    });
    if (bill.status === 'reversed') {
      movements.push({
        id: `bill-reversal:${bill.id}`, type: 'bill-reversal', date: bill.billDate,
        doc: bill.billNumber, debit: num(bill.total), credit: 0,
        description: `Bill ${bill.billNumber} reversed`,
      });
    }
  }
  for (const payment of state.payments) {
    if (payment.supplierId !== supplierId || payment.status === 'draft') continue;
    movements.push({
      id: `payment:${payment.id}`, type: 'payment', date: payment.paymentDate,
      doc: payment.paymentNumber, debit: num(payment.amount), credit: 0,
      description: `Payment ${payment.paymentNumber}`,
    });
    if (payment.status === 'reversed') {
      movements.push({
        id: `payment-reversal:${payment.id}`, type: 'payment-reversal', date: payment.paymentDate,
        doc: payment.paymentNumber, debit: 0, credit: num(payment.amount),
        description: `Payment ${payment.paymentNumber} reversed`,
      });
    }
  }
  movements.sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)));

  let running = 0;
  let charges = 0;
  let paid = 0;
  const lines: Json[] = [{
    id: 'opening-balance', type: 'opening-balance', date: start, documentNumber: '',
    reference: '', description: 'Opening balance',
    debit: '0.000', credit: '0.000', runningBalance: '0.000', journalEntryId: null,
  }];
  for (const movement of movements) {
    running += movement.credit - movement.debit;
    charges += movement.credit;
    paid += movement.debit;
    lines.push({
      id: movement.id, type: movement.type, date: movement.date,
      documentNumber: movement.doc, reference: '', description: movement.description,
      debit: D3(movement.debit), credit: D3(movement.credit),
      runningBalance: D3(running), journalEntryId: null,
    });
  }

  const rows = outstandingRows(end, supplierId);
  const subledger = rows.reduce((sum, row) => sum + num(row.outstanding), 0);

  return {
    supplierId, supplierName: 'Acme Supplies Ltd',
    periodStart: start, periodEnd: end, currency: 'JOD',
    openingBalance: '0.000', periodCharges: D3(charges), periodPayments: D3(paid),
    closingBalance: D3(running), lines,
    aging: ageing(end, supplierId), outstandingBills: rows,
    subledgerBalance: D3(subledger),
    reconciliationDifference: D3(running - subledger),
    isReconciled: Math.abs(running - subledger) < 1e-9,
  };
}

/* ══ The router ════════════════════════════════════════════════════════════ */

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const refuse = (error: Refusal): Response =>
  new Response(
    JSON.stringify({ error: { code: error.code, message: error.message } }),
    { status: error.status, headers: { 'content-type': 'application/json' } },
  );

function route(method: string, path: string, query: URLSearchParams, body: Json): Response {
  const billMatch = /^\/api\/bills\/([^/]+)(\/(post|reverse))?$/.exec(path);
  const payMatch = /^\/api\/payments\/([^/]+)(\/(post|reallocate|reverse))?$/.exec(path);

  if (path === '/api/bills' && method === 'GET') {
    return ok({ bills: [...state.bills].reverse() });
  }
  if (path === '/api/bills' && method === 'POST') {
    return ok({ bill: createBill(body) }, 201);
  }
  if (billMatch) {
    const bill = state.bills.find((b) => b.id === billMatch[1]);
    if (!bill) throw new Refusal(404, 'not_found', 'Bill not found.');
    const action = billMatch[3];
    if (method === 'PATCH' && !action) {
      if (num(body.expectedVersion) !== bill.version) {
        throw new Refusal(409, 'conflict',
          'This bill was changed by another user while you were editing it. Reload to see their change before saving yours.');
      }
      state.lastPatchVersion = num(body.expectedVersion);
      billBody(body, bill);
      bill.version += 1;
      return ok({ bill });
    }
    if (method === 'DELETE' && !action) {
      if (bill.status !== 'draft') throw new Refusal(409, 'conflict', 'A posted bill cannot be deleted.');
      state.bills = state.bills.filter((b) => b.id !== bill.id);
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && action === 'post') return ok({ bill: postBill(bill, body) });
    if (method === 'POST' && action === 'reverse') return ok({ bill: reverseBill(bill, body) });
  }

  if (path === '/api/payments' && method === 'GET') {
    return ok({ payments: [...state.payments].reverse().map(paymentView) });
  }
  if (path === '/api/payments' && method === 'POST') {
    return ok({ payment: paymentView(createPayment(body)) }, 201);
  }
  if (path === '/api/payments/payables' && method === 'GET') {
    const asOf = query.get('asOfDate') ?? '2026-12-31';
    return ok({ outstanding: outstandingRows(asOf), aging: ageing(asOf) });
  }
  if (path === '/api/payments/statement' && method === 'GET') {
    const supplierId = query.get('supplierId');
    if (!supplierId) throw new Refusal(422, 'validation_error', 'supplierId is required.');
    return ok({
      statement: statement(
        supplierId,
        query.get('periodStart') ?? '2026-01-01',
        query.get('periodEnd') ?? '2026-12-31',
      ),
    });
  }
  if (payMatch) {
    const payment = state.payments.find((p) => p.id === payMatch[1]);
    if (!payment) throw new Refusal(404, 'not_found', 'Payment not found.');
    const action = payMatch[3];
    if (method === 'PATCH' && !action) {
      if (num(body.expectedVersion) !== payment.version) {
        throw new Refusal(409, 'conflict',
          'This payment was changed by another user while you were editing it. Reload to see their change before saving yours.');
      }
      payment.paymentDate = String(body.paymentDate ?? payment.paymentDate);
      payment.amount = D3(num(body.amount));
      payment.method = String(body.method ?? payment.method);
      payment.reference = String(body.reference ?? '');
      payment.memo = String(body.memo ?? '');
      if (body.cashAccountId) payment.cashAccountId = String(body.cashAccountId);
      if (body.supplierId) payment.supplierId = String(body.supplierId);
      payment.version += 1;
      return ok({ payment: paymentView(payment) });
    }
    if (method === 'DELETE' && !action) {
      if (payment.status !== 'draft') throw new Refusal(409, 'conflict', 'A posted payment cannot be deleted.');
      state.payments = state.payments.filter((p) => p.id !== payment.id);
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && action === 'post') return ok({ payment: paymentView(postPayment(payment, body)) });
    if (method === 'POST' && action === 'reallocate') return ok({ payment: paymentView(reallocatePayment(payment, body)) });
    if (method === 'POST' && action === 'reverse') return ok({ payment: paymentView(reversePayment(payment, body)) });
  }

  throw new Refusal(404, 'not_found', `No route for ${method} ${path}`);
}

export const server = {
  get bills(): FakeBill[] { return state.bills; },
  get payments(): FakePayment[] { return state.payments; },
  get allocations(): FakeAllocation[] { return state.allocations; },
  get requests(): Array<{ method: string; path: string }> { return state.requests; },
  get postAttempts(): boolean[] { return state.postAttempts; },
  get lastPatchVersion(): number | null { return state.lastPatchVersion; },
  /** In-flight requests, so a test can wait for the screen to settle. */
  get pending(): number { return state.pending; },

  /** Another session saves first, so the open form's version goes stale. */
  bumpVersionOutsideThisSession(billNumber: string): void {
    const bill = state.bills.find((b) => b.billNumber === billNumber);
    if (bill) bill.version += 1;
  },

  /** Take away the supplier's payable account, as a misconfigured tenant has. */
  breakPayableAccount(): void { state.payableConfigured = false; },

  outstandingFor(billNumber: string): string {
    const bill = state.bills.find((b) => b.billNumber === billNumber);
    return bill ? D3(outstanding(bill)) : 'no such bill';
  },

  fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    state.requests.push({ method, path: url.pathname });
    state.pending += 1;
    try {
      const body = init?.body ? (JSON.parse(String(init.body)) as Json) : {};
      /* A microtask, so a test can observe the in-flight state the screen
       * shows while a write is travelling. */
      await Promise.resolve();
      return route(method, url.pathname, url.searchParams, body);
    } catch (error) {
      if (error instanceof Refusal) return refuse(error);
      throw error;
    } finally {
      state.pending -= 1;
    }
  },
};

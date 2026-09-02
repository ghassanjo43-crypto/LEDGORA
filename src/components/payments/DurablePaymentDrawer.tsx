/**
 * The payment editor a durable subscriber actually uses.
 *
 * ══ Why this is a separate component ═════════════════════════════════════════
 *
 * `PaymentEditorDrawer` offers bank fees, withholding, settlement discounts,
 * realised exchange differences, loans, leases, payroll and tax payments. Every
 * one of those is refused by the server, and a field on the screen that
 * produces a refusal when saved is worse than a field that is not there. So the
 * durable editor shows what the server can hold, and Free Demo keeps its own
 * drawer unchanged.
 *
 * ══ The allocations are part of posting ══════════════════════════════════════
 *
 * A posted payment is fully allocated, so the allocation table is in this
 * drawer rather than behind a later "apply" step: the two are one decision. The
 * Post button stays disabled until the allocations total the payment exactly,
 * and the reason is on screen the whole time — an unapplied balance has no
 * account to sit in, so it is not a state the product can save.
 *
 * ══ Nothing here computes accounting ═════════════════════════════════════════
 *
 * The eligible bills and their outstanding amounts come from the server's own
 * derived schedule. The remaining-to-allocate figure is arithmetic on what the
 * user has typed, not a balance: every allocation is revalidated against a
 * locked bill row when the payment posts, and this list can be stale the moment
 * it renders.
 */
import { useMemo, useState } from 'react';
import { Send, Save, Loader2, Wand2, Info } from 'lucide-react';
import type { BusinessEntity } from '@/types';
import { useStore } from '@/store/useStore';
import { useSuppliers } from '@/services/parties/useSuppliers';
import { usePayments } from '@/services/payments/usePayments';
import {
  useServerPayments, eligibleBillsFor, UNAPPLIED_UNSUPPORTED,
} from '@/services/payments/paymentBackend';
import {
  paymentActions, type PaymentDraftValues, type AllocationDraft,
} from '@/services/payments/paymentActions';
import { eligiblePostingAccounts } from '@/lib/accountEligibility';
import { formatCurrency } from '@/lib/money';
import { describeCurrency, useTransactionCurrency } from '@/lib/transactionCurrency';
import { PAYMENT_METHOD_LABELS } from '@/lib/paymentLabels';
import type { PaymentMethod } from '@/types/payment';
import { cn as cx } from '@/lib/utils';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ReadOnlyValue } from '@/components/ui/ReadOnlyValue';
import { useToast } from '@/components/ui/Toast';
import { EntityPicker } from '@/components/shared/EntityPicker';
import { useMonetaryStep } from '@/lib/useMonetaryPrecision';
import { roundToCompanyPrecision } from '@/lib/monetaryPrecision';

interface Props {
  open: boolean;
  /** `null` means a new payment that does not exist on the server yet. */
  paymentId: string | null;
  /** Pre-selects the supplier when a bill sent the user here to pay it. */
  seedSupplierId?: string | null;
  onClose: () => void;
  onSaved?: (id: string) => void;
}

const METHOD_OPTIONS = (Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[])
  .map((key) => ({ value: key, label: PAYMENT_METHOD_LABELS[key] }));

const today = (): string => new Date().toISOString().slice(0, 10);

export function DurablePaymentDrawer({ open, paymentId, seedSupplierId, onClose, onSaved }: Props) {
  const moneyStep = useMonetaryStep();
  const accounts = useStore((s) => s.accounts);
  const { notify } = useToast();
  const companyCurrency = useTransactionCurrency();

  const { payments } = usePayments();
  const payment = paymentId ? payments.find((p) => p.id === paymentId) : undefined;
  const outstanding = useServerPayments((s) => s.outstanding);

  /* The P1 supplier directory, and the chart's own cash and bank accounts. A
   * payment may only leave an account the chart says holds money. */
  const { suppliers } = useSuppliers();
  const cashAccounts = useMemo(
    () => eligiblePostingAccounts({ accounts, purpose: 'bank-cash' }),
    [accounts],
  );

  const [supplierId, setSupplierId] = useState('');
  const [paymentDate, setPaymentDate] = useState(today());
  const [amount, setAmount] = useState(0);
  const [method, setMethod] = useState<PaymentMethod>('bank-transfer');
  const [cashAccountId, setCashAccountId] = useState('');
  const [reference, setReference] = useState('');
  const [memo, setMemo] = useState('');
  const [allocation, setAllocation] = useState<Record<string, number>>({});

  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  /*
   * Two triggers, for the same reason as the bill drawer.
   *
   * The DOCUMENT changing resets the fields and clears any message. The STATUS
   * changing — a draft becoming posted — refreshes the values only, so a
   * refusal that arrives with a save is still on screen to be read.
   */
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [loadedStatus, setLoadedStatus] = useState<string | null>(null);
  const identity = paymentId ?? 'new';

  const applyRecord = (): void => {
    if (payment) {
      setSupplierId(payment.supplierId ?? '');
      setPaymentDate(payment.paymentDate);
      setAmount(payment.grossAmount);
      setMethod(payment.method);
      setCashAccountId(payment.bankAccountId ?? '');
      setReference(payment.transactionReference ?? '');
      setMemo(payment.narration ?? '');
      setAllocation(Object.fromEntries(
        payment.allocations.map((a) => [a.billId ?? '', a.amount]),
      ));
    } else {
      setSupplierId(seedSupplierId ?? ''); setPaymentDate(today()); setAmount(0);
      setMethod('bank-transfer'); setCashAccountId('');
      setReference(''); setMemo(''); setAllocation({});
    }
  };

  if (open && loadedId !== identity) {
    setLoadedId(identity);
    setLoadedStatus(payment?.status ?? null);
    /* A blank editor that has just adopted the id of the record it created
     * keeps what is on screen, allocations included. */
    if (loadedId !== 'new' || !payment) {
      applyRecord();
      setFormError(null);
    }
  } else if (open && payment && loadedStatus !== payment.status) {
    setLoadedStatus(payment.status);
    applyRecord();
  }

  const currency = payment?.currency || companyCurrency.code;
  const money = (n: number): string => formatCurrency(n, currency);
  const readOnly = Boolean(payment && payment.status !== 'draft');

  /* The server's own outstanding schedule, filtered to this supplier and
   * currency. A suggestion for the screen; the server revalidates every line
   * against a locked bill row regardless of what was offered here. */
  const eligible = useMemo(
    () => (supplierId ? eligibleBillsFor(supplierId, currency) : []),
    [supplierId, currency, outstanding],
  );

  const allocated = roundToCompanyPrecision(
    Object.values(allocation).reduce((sum, value) => sum + (Number(value) || 0), 0),
  );
  const remaining = roundToCompanyPrecision(amount - allocated);
  const fullyAllocated = Math.abs(remaining) < 0.0000005 && amount > 0;

  /** Fill oldest-due first, up to the payment. A helper, never a rule. */
  const autoAllocate = (): void => {
    let left = amount;
    const next: Record<string, number> = {};
    for (const bill of [...eligible].sort((a, b) => a.dueDate.localeCompare(b.dueDate))) {
      if (left <= 0) break;
      const take = Math.min(left, Number(bill.outstanding));
      if (take > 0) { next[bill.billId] = roundToCompanyPrecision(take); left = roundToCompanyPrecision(left - take); }
    }
    setAllocation(next);
  };

  const collect = (): PaymentDraftValues => ({
    supplierId, paymentDate, amount, method,
    reference: reference || undefined, memo: memo || undefined,
    cashAccountId: cashAccountId || undefined,
  });

  const allocationDrafts = (): AllocationDraft[] =>
    Object.entries(allocation)
      .filter(([, value]) => Number(value) > 0)
      .map(([billId, value]) => ({ billId, amount: Number(value) }));

  const actions = paymentActions();

  const missing = (): string | null => {
    if (!supplierId) return 'Choose the supplier being paid.';
    if (!paymentDate) return 'Enter the payment date.';
    if (!(amount > 0)) return 'Enter an amount greater than zero.';
    if (!cashAccountId) return 'Choose the bank or cash account the money leaves.';
    return null;
  };

  const save = async (): Promise<string | null> => {
    const problem = missing();
    if (problem) { setFormError(problem); notify(problem, 'error'); return null; }

    setBusy(true);
    try {
      const result = payment
        ? await actions.update(payment.id, collect())
        : await actions.create(collect());
      if (!result.ok || !result.id) {
        /* The SERVER's words, verbatim. */
        const message = result.error ?? 'Could not save the payment.';
        setFormError(message);
        notify(message, 'error');
        return null;
      }
      setFormError(null);
      onSaved?.(result.id);
      return result.id;
    } finally {
      setBusy(false);
    }
  };

  const onSave = async (): Promise<void> => {
    const id = await save();
    if (id) { notify('Payment draft saved.', 'success'); onClose(); }
  };

  const onPost = async (): Promise<void> => {
    if (!fullyAllocated) {
      setFormError(UNAPPLIED_UNSUPPORTED);
      notify(UNAPPLIED_UNSUPPORTED, 'error');
      return;
    }
    const id = await save();
    if (!id) return;

    setBusy(true);
    try {
      const result = await actions.post(id, allocationDrafts());
      if (result.ok) {
        notify('Payment posted. The bank entry and the allocations are in the books.', 'success');
        onClose();
        return;
      }
      const message = result.error ?? 'Could not post the payment.';
      setFormError(message);
      notify(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  if (paymentId && !payment) return null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      widthClassName="max-w-4xl"
      title={payment ? `Payment ${payment.paymentNumber}` : 'New supplier payment'}
      description={
        readOnly
          ? `${payment!.status} — read only. Correct it by reallocating in full, or reverse it.`
          : 'Recorded on the server. Posting debits the supplier’s payable and credits the bank.'
      }
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <div className="flex gap-4 text-sm">
            <span>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Payment</span>
              <span className="ml-2 font-mono text-base font-bold" data-testid="durable-payment-amount">{money(amount)}</span>
            </span>
            <span>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Unallocated</span>
              <span
                data-testid="durable-payment-remaining"
                className={cx('ml-2 font-mono text-base font-bold', !fullyAllocated && 'text-red-600 dark:text-red-400')}
              >
                {money(remaining)}
              </span>
            </span>
          </div>
          {formError && (
            <p role="alert" className="w-full text-xs text-red-600 dark:text-red-400">{formError}</p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Close</Button>
            {!readOnly && (
              <Button variant="secondary" onClick={() => void onSave()} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save draft
              </Button>
            )}
            {!readOnly && (
              <Button onClick={() => void onPost()} disabled={busy || !fullyAllocated}>
                <Send className="h-4 w-4" /> Post payment
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-6">
        <section aria-labelledby="durable-payment-details" className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-5">
          <h3 id="durable-payment-details" className="mb-4 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Who is paid, and from where
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Supplier" required>
              <EntityPicker
                value={supplierId}
                entities={suppliers}
                onChange={(e: BusinessEntity | null) => { setSupplierId(e?.id ?? ''); setAllocation({}); }}
                placeholder="Select supplier"
                disabled={readOnly}
              />
            </Field>
            <Field label="Payment date" required>
              <Input aria-label="Payment date" type="date" value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)} disabled={readOnly} />
            </Field>
            <Field label="Amount" required>
              <Input aria-label="Payment amount" type="number" step={moneyStep} data-money="true"
                value={amount} onChange={(e) => setAmount(Number(e.target.value))}
                disabled={readOnly} className="text-right" />
            </Field>
            <Field label="Paid from" required>
              <Select
                aria-label="Paying account"
                options={[
                  { value: '', label: 'Select a bank or cash account' },
                  ...cashAccounts.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` })),
                ]}
                value={cashAccountId}
                onChange={(e) => setCashAccountId(e.target.value)}
                disabled={readOnly}
              />
            </Field>
            <Field label="Method">
              <Select aria-label="Payment method" options={METHOD_OPTIONS} value={method}
                onChange={(e) => setMethod(e.target.value as PaymentMethod)} disabled={readOnly} />
            </Field>
            {/* Functional currency only: the server cannot justify a converted
                amount while rates and realised differences live in the browser. */}
            <Field label="Currency">
              <ReadOnlyValue data-testid="durable-payment-currency">
                {describeCurrency(currency).label}
              </ReadOnlyValue>
            </Field>
            <Field label="Reference">
              <Input aria-label="Payment reference" value={reference}
                onChange={(e) => setReference(e.target.value)} disabled={readOnly}
                placeholder="Transfer or cheque reference" />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Memo">
                <Input aria-label="Payment memo" value={memo} onChange={(e) => setMemo(e.target.value)}
                  disabled={readOnly} placeholder="Optional note kept with the payment" />
              </Field>
            </div>
          </div>
        </section>

        <section aria-labelledby="durable-payment-allocations" className="space-y-3" data-testid="durable-allocation-table">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 id="durable-payment-allocations" className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Bills this payment settles
              </h3>
              <p className="mt-1 text-xs text-slate-500">
                Every fils must name a bill. There is no unapplied balance to leave over.
              </p>
            </div>
            {!readOnly && eligible.length > 0 && (
              <Button type="button" variant="outline" size="sm" onClick={autoAllocate}>
                <Wand2 className="h-4 w-4" /> Fill oldest first
              </Button>
            )}
          </div>

          {!supplierId ? (
            <p className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-500 dark:border-slate-800">
              Choose a supplier to see the bills this payment can settle.
            </p>
          ) : eligible.length === 0 ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              This supplier has no posted bills with anything left to pay. A payment can only settle
              a posted bill.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400 dark:bg-slate-800/40">
                  <tr>
                    <th className="px-2 py-2 text-left">Bill</th>
                    <th className="px-2 py-2 text-left">Due</th>
                    <th className="px-2 py-2 text-right">Outstanding</th>
                    <th className="px-2 py-2 text-right">Allocate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {eligible.map((bill) => {
                    const value = allocation[bill.billId] ?? 0;
                    const over = Number(value) > Number(bill.outstanding) + 0.0000005;
                    return (
                      <tr key={bill.billId} data-testid="durable-allocation-row">
                        <td className="px-2 py-1.5 font-mono">{bill.billNumber}</td>
                        <td className="px-2 py-1.5 text-slate-500">{bill.dueDate}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{money(Number(bill.outstanding))}</td>
                        <td className="w-32 px-2 py-1.5">
                          <Input
                            aria-label={`Allocate to ${bill.billNumber}`}
                            type="number" step={moneyStep} data-money="true"
                            value={value}
                            onChange={(e) => setAllocation((prev) => ({
                              ...prev, [bill.billId]: Number(e.target.value),
                            }))}
                            disabled={readOnly}
                            className={cx('h-8 text-right', over && 'border-red-400 text-red-600')}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {!readOnly && !fullyAllocated && amount > 0 && (
            <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              {remaining > 0
                ? `${money(remaining)} is not yet allocated. ${UNAPPLIED_UNSUPPORTED}`
                : `Allocations exceed the payment by ${money(-remaining)}. Reduce them, or raise the payment.`}
            </p>
          )}
        </section>

        {payment && payment.status !== 'draft' && (
          <section
            className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs dark:border-slate-800 dark:bg-slate-800/40"
            data-testid="durable-payment-posted"
          >
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
              As the ledger records it
            </h3>
            <ul className="space-y-1">
              {payment.allocations.map((a: (typeof payment.allocations)[number]) => (
                <li key={a.id} className="flex items-center justify-between gap-2">
                  <span className="font-mono">{a.billNumber}</span>
                  <span className="font-mono">{money(a.amount)}</span>
                </li>
              ))}
              {payment.allocations.length === 0 && (
                <li className="text-slate-500">No live allocations — this payment has been reversed.</li>
              )}
            </ul>
          </section>
        )}

        {!readOnly && (
          <p className="flex items-start gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800/40">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" />
            Posting writes one balanced entry (Dr the supplier’s payable, Cr the bank) and records
            what each bill was settled by. Bank fees, settlement discounts and withholding are not
            recorded here — each needs its own controlled account.
          </p>
        )}
      </div>
    </Drawer>
  );
}

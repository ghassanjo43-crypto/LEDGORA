/**
 * The bill editor a durable subscriber actually uses.
 *
 * ══ Why this is a separate component ═════════════════════════════════════════
 *
 * `BillEditorDrawer` offers withholding, additional charges, projects, cost
 * centres, inventory receipts and attachments. Every one of those is refused by
 * the server, and a field on the screen that produces a refusal when saved is
 * worse than a field that is not there: the user has already decided, typed and
 * been told no. So the durable editor shows what the server can actually hold,
 * and Free Demo keeps its own drawer unchanged — its records are the originals
 * and none of that is refused there.
 *
 * ══ Nothing here computes accounting ═════════════════════════════════════════
 *
 * The line totals beside each row are a DRAFT arithmetic aid, and they say so.
 * The authoritative subtotal, discount, input tax and total come back from the
 * server on every save and are displayed from the saved record — the browser
 * never resolves a tax rate, and a posted bill's figures come from its frozen
 * snapshot. `Balance due` is the server's derived outstanding amount, never a
 * local netting of payments.
 *
 * ══ The version is never in the form ═════════════════════════════════════════
 *
 * `billActions.update` reads it from the cached server row at the moment of the
 * write. A form that carried the version it was opened with would happily send
 * it back after somebody else had saved, which is the merge the server exists
 * to refuse.
 */
import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Send, Save, X, Info, AlertTriangle, Loader2 } from 'lucide-react';
import type { BusinessEntity } from '@/types';
import type { BillLine } from '@/types/bill';
import { useStore } from '@/store/useStore';
import { useSuppliers } from '@/services/parties/useSuppliers';
import { useServerTaxCodeStore, rateOn } from '@/store/serverTaxCodeStore';
import { useBills } from '@/services/bills/useBills';
import {
  billActions, emptyDurableLine, type BillDraftValues,
} from '@/services/bills/billActions';
import { formatCurrency } from '@/lib/money';
import { describeCurrency, useTransactionCurrency } from '@/lib/transactionCurrency';
import { cn as cx } from '@/lib/utils';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { ReadOnlyValue } from '@/components/ui/ReadOnlyValue';
import { useToast } from '@/components/ui/Toast';
import { EntityPicker } from '@/components/shared/EntityPicker';
import { AccountSelect } from '@/components/journal/AccountSelect';
import { useMonetaryStep } from '@/lib/useMonetaryPrecision';
import { BILL_STATUS_TONE } from '@/lib/billLabels';

interface Props {
  open: boolean;
  /** `null` means a new bill that does not exist on the server yet. */
  billId: string | null;
  onClose: () => void;
  /** Called with the saved id, so the page can keep the drawer on the record. */
  onSaved?: (id: string) => void;
}

const today = (): string => new Date().toISOString().slice(0, 10);

export function DurableBillDrawer({ open, billId, onClose, onSaved }: Props) {
  const moneyStep = useMonetaryStep();
  const accounts = useStore((s) => s.accounts);
  const { notify } = useToast();
  const companyCurrency = useTransactionCurrency();

  /* The server ledger. Reading `useBillStore` here would show a durable
   * workspace a bill the books do not have. */
  const { bills } = useBills();
  const bill = billId ? bills.find((b) => b.id === billId) : undefined;

  /*
   * The P1 supplier DIRECTORY, not the local entity store: a durable bill may
   * only name a supplier these books hold, and offering another would produce a
   * refusal for a name on the screen.
   */
  const { suppliers } = useSuppliers();

  /* Purchase-applicable, effective-on-the-date codes only. */
  const serverTaxCodes = useServerTaxCodeStore((s) => s.taxCodes);
  const serverTaxError = useServerTaxCodeStore((s) => s.loadError);
  const serverTaxLoaded = useServerTaxCodeStore((s) => s.loaded);
  const loadServerTaxCodes = useServerTaxCodeStore((s) => s.load);
  const selectableOn = useServerTaxCodeStore((s) => s.selectableOn);

  useEffect(() => {
    if (open && !serverTaxLoaded) void loadServerTaxCodes();
  }, [open, serverTaxLoaded, loadServerTaxCodes]);

  const [supplierId, setSupplierId] = useState('');
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState('');
  const [billDate, setBillDate] = useState(today());
  const [dueDate, setDueDate] = useState(today());
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<BillLine[]>([emptyDurableLine(1)]);

  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /* Set only when the SERVER refuses a post for a duplicate supplier reference.
   * The override is then a deliberate second action, never a default. */
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);

  /*
   * Load the record into the form.
   *
   * Two separate triggers, because they mean different things.
   *
   * The DOCUMENT changing — a different bill, or a blank one — resets the
   * fields and clears any message, since a refusal about the last document has
   * nothing to say about this one.
   *
   * The VERSION changing refreshes the values only. The server may normalise an
   * amount, and a form that kept what was typed would disagree with the books
   * it just wrote. It must NOT clear the messages: a save that succeeds and a
   * post that is then refused arrive as one version bump followed by an error,
   * and clearing here would wipe the refusal the user needs to read.
   */
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const identity = billId ?? 'new';

  const applyRecord = (): void => {
    if (bill) {
      setSupplierId(bill.supplierId);
      setSupplierInvoiceNumber(bill.supplierInvoiceNumber);
      setBillDate(bill.billDate);
      setDueDate(bill.dueDate);
      setNotes(bill.notes ?? '');
      setLines(bill.lines.length ? bill.lines : [emptyDurableLine(1)]);
    } else {
      setSupplierId(''); setSupplierInvoiceNumber('');
      setBillDate(today()); setDueDate(today());
      setNotes(''); setLines([emptyDurableLine(1)]);
    }
  };

  if (open && loadedId !== identity) {
    setLoadedId(identity);
    setLoadedVersion(bill ? (bill.revision ?? null) : null);
    /* A blank editor that has just adopted the id of the record it created
     * keeps what is on screen: nothing about the document changed. */
    if (loadedId !== 'new' || !bill) {
      applyRecord();
      setFormError(null);
      setDuplicateWarning(null);
    }
  } else if (open && bill && loadedVersion !== (bill.revision ?? null)) {
    setLoadedVersion(bill.revision ?? null);
    applyRecord();
  }

  const purchaseCodes = useMemo(
    () => selectableOn(billDate, 'purchase'),
    [selectableOn, billDate, serverTaxCodes],
  );

  const currency = bill?.currency || companyCurrency.code;
  const money = (n: number): string => formatCurrency(n, currency);
  const readOnly = Boolean(bill && bill.status !== 'draft');

  const setLine = (id: string, patch: Partial<BillLine>): void =>
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const addLine = (): void => setLines((prev) => [...prev, emptyDurableLine(prev.length + 1)]);
  const removeLine = (id: string): void =>
    setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.id !== id) : prev));

  /*
   * A DRAFT aid only, and labelled as one on screen.
   *
   * Quantity times price less the percentage discount. It carries no tax,
   * because the rate belongs to a code the server resolves against the bill's
   * date — computing it here would give a second answer that disagrees the
   * moment a rate version changes.
   */
  const draftNet = (line: BillLine): number => {
    const gross = (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0);
    const discount = gross * ((Number(line.discountValue) || 0) / 100);
    return gross - discount;
  };
  const draftTotal = lines.reduce((sum, line) => sum + draftNet(line), 0);

  const collect = (): BillDraftValues => ({
    supplierId, supplierInvoiceNumber, billDate, dueDate, notes, lines,
  });

  const actions = billActions();

  const missing = (): string | null => {
    if (!supplierId) return 'Choose the supplier this bill is from.';
    if (!supplierInvoiceNumber.trim()) return "Enter the supplier's own invoice number.";
    if (!billDate) return 'Enter the bill date.';
    if (!dueDate) return 'Enter the due date.';
    if (lines.some((line) => !line.accountId)) return 'Every line needs a purchase account.';
    return null;
  };

  const save = async (): Promise<string | null> => {
    const problem = missing();
    if (problem) { setFormError(problem); notify(problem, 'error'); return null; }

    setBusy(true);
    try {
      const result = bill
        ? await actions.update(bill.id, collect())
        : await actions.create(collect());
      if (!result.ok || !result.id) {
        /* The SERVER's words, verbatim: a locked period, a missing payable
         * account and a stale version each say something different. */
        const message = result.error ?? 'Could not save the bill.';
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
    if (id) { notify('Bill draft saved.', 'success'); onClose(); }
  };

  const onPost = async (overrideDuplicate = false): Promise<void> => {
    const id = await save();
    if (!id) return;

    setBusy(true);
    try {
      const result = await actions.post(id, overrideDuplicate ? { overrideDuplicate: true } : {});
      if (result.ok) {
        setDuplicateWarning(null);
        notify('Bill posted. The expense and the payable are in the ledger.', 'success');
        onClose();
        return;
      }
      const message = result.error ?? 'Could not post the bill.';
      if (result.duplicateReference) {
        /* Offered, never taken automatically: paying the same supplier document
         * twice is the mistake this check exists for. */
        setDuplicateWarning(message);
      } else {
        setFormError(message);
      }
      notify(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  if (billId && !bill) return null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      widthClassName="max-w-4xl"
      title={bill ? `Bill ${bill.billNumber}` : 'New bill'}
      description={
        readOnly
          ? `${bill!.status} — read only. Posted figures come from the ledger.`
          : 'Recorded on the server. Posting debits the expense and credits the supplier’s payable.'
      }
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              {bill && bill.status !== 'draft' ? 'Bill total' : 'Draft net (before tax)'}
            </span>
            <span className="ml-2 font-mono text-base font-bold" data-testid="durable-bill-total">
              {money(bill && bill.status !== 'draft' ? bill.grandTotal : draftTotal)}
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
              <Button onClick={() => void onPost()} disabled={busy}>
                <Send className="h-4 w-4" /> Post bill
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-6">
        {duplicateWarning && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-600/50 dark:bg-amber-500/10 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-2">
              <p>{duplicateWarning}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="danger" onClick={() => void onPost(true)} disabled={busy}>
                  Post anyway — this is a different document
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDuplicateWarning(null)}>
                  <X className="h-3.5 w-3.5" /> Keep checking
                </Button>
              </div>
            </div>
          </div>
        )}

        <section aria-labelledby="durable-bill-details" className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-5">
          <h3 id="durable-bill-details" className="mb-4 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Supplier and bill details
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Supplier" required>
              <EntityPicker
                value={supplierId}
                entities={suppliers}
                onChange={(e: BusinessEntity | null) => setSupplierId(e?.id ?? '')}
                placeholder="Select supplier"
                disabled={readOnly}
              />
            </Field>
            <Field label="Supplier invoice no." required>
              <Input
                aria-label="Supplier invoice number"
                value={supplierInvoiceNumber}
                onChange={(e) => setSupplierInvoiceNumber(e.target.value)}
                disabled={readOnly}
                placeholder="SUP-INV-8842"
              />
            </Field>
            <Field label="Bill date" required>
              <Input aria-label="Bill date" type="date" value={billDate}
                onChange={(e) => setBillDate(e.target.value)} disabled={readOnly} />
            </Field>
            <Field label="Due date" required>
              <Input aria-label="Due date" type="date" value={dueDate}
                onChange={(e) => setDueDate(e.target.value)} disabled={readOnly} />
            </Field>
            {/* The company's own currency, shown and not chosen: the server
                holds functional-currency bills only. */}
            <Field label="Currency">
              <ReadOnlyValue data-testid="durable-bill-currency">
                {describeCurrency(currency).label}
              </ReadOnlyValue>
            </Field>
            {bill && (
              <Field label="Status">
                <ReadOnlyValue>
                  <Badge tone={BILL_STATUS_TONE[bill.status]}>{bill.status}</Badge>
                </ReadOnlyValue>
              </Field>
            )}
          </div>
        </section>

        <section aria-labelledby="durable-bill-lines" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 id="durable-bill-lines" className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Bill lines
              </h3>
              <p className="mt-1 text-xs text-slate-500">
                The tax comes from the code you choose, resolved by the server against the bill date.
              </p>
            </div>
            {!readOnly && (
              <Button type="button" variant="outline" size="sm" onClick={addLine}>
                <Plus className="h-4 w-4" /> Add line
              </Button>
            )}
          </div>

          <div className="space-y-4" data-testid="durable-bill-lines">
            {lines.map((line, index) => (
              <article
                key={line.id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-5"
                data-testid="durable-bill-line"
              >
                <div className="mb-4 flex items-center justify-between gap-3">
                  <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Line {index + 1}</h4>
                  {!readOnly && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => removeLine(line.id)}
                      aria-label={`Remove line ${index + 1}`} disabled={lines.length <= 1}>
                      <Trash2 className="h-4 w-4" /> Remove
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Field label="Purchase account" required>
                    <AccountSelect
                      value={line.accountId}
                      accounts={accounts}
                      onChange={(a) => setLine(line.id, { accountId: a.id })}
                      disabled={readOnly}
                    />
                  </Field>
                  <Field label="Description">
                    <Input
                      aria-label={`Line ${index + 1} description`}
                      value={line.description}
                      onChange={(e) => setLine(line.id, { description: e.target.value })}
                      disabled={readOnly}
                      placeholder="What was purchased?"
                    />
                  </Field>
                </div>
                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="Quantity">
                    <Input aria-label={`Line ${index + 1} quantity`} type="number" step="0.01"
                      value={line.quantity}
                      onChange={(e) => setLine(line.id, { quantity: Number(e.target.value) })}
                      disabled={readOnly} className="text-right" />
                  </Field>
                  <Field label="Unit price">
                    <Input aria-label={`Line ${index + 1} unit price`} type="number" step={moneyStep}
                      data-money="true" value={line.unitPrice}
                      onChange={(e) => setLine(line.id, { unitPrice: Number(e.target.value) })}
                      disabled={readOnly} className="text-right" />
                  </Field>
                  <Field label="Discount %">
                    <Input aria-label={`Line ${index + 1} discount`} type="number" step="0.01"
                      value={line.discountValue ?? 0}
                      onChange={(e) => setLine(line.id, {
                        discountType: 'percentage', discountValue: Number(e.target.value),
                      })}
                      disabled={readOnly} className="text-right" />
                  </Field>
                  <Field label="Tax code">
                    <select
                      aria-label={`Line ${index + 1} tax code`}
                      value={line.taxCodeId ?? ''}
                      onChange={(e) => setLine(line.id, { taxCodeId: e.target.value || undefined })}
                      disabled={readOnly}
                      className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                    >
                      {/* "No tax code" is NOT zero-rated. A purchase with no
                          code is untaxed; a zero-rated one is taxed at 0% and
                          reported. */}
                      <option value="">No tax code</option>
                      {purchaseCodes.map((code) => {
                        const rate = rateOn(code, billDate);
                        return (
                          <option key={code.id} value={code.id}>
                            {code.code} — {code.name}
                            {rate === null ? ' (no rate on this date)' : ` (${rate.replace(/0+$/, '').replace(/\.$/, '')}%)`}
                          </option>
                        );
                      })}
                    </select>
                    {serverTaxError ? (
                      <p className="mt-1 text-xs text-red-600 dark:text-red-400">{serverTaxError}</p>
                    ) : purchaseCodes.length === 0 ? (
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        No purchase tax codes apply on this date. Add one under Tax, marked for
                        purchases, to reclaim input tax.
                      </p>
                    ) : null}
                  </Field>
                </div>
                <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/50">
                  <p className="text-xs font-medium text-slate-500">
                    {readOnly ? 'Line total (from the ledger)' : 'Draft line net — tax is added by the server'}
                  </p>
                  <output
                    aria-label={`Line ${index + 1} total`}
                    className="mt-1 block text-right font-mono text-base font-semibold text-slate-900 dark:text-slate-100"
                  >
                    {money(readOnly ? line.lineTotal : draftNet(line))}
                  </output>
                </div>
              </article>
            ))}
          </div>
        </section>

        {bill && bill.status !== 'draft' && (
          <section
            aria-labelledby="durable-bill-totals"
            className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-800/40"
            data-testid="durable-bill-posted-totals"
          >
            <h3 id="durable-bill-totals" className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
              As the ledger records it
            </h3>
            <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3 lg:grid-cols-5">
              <Stat label="Subtotal" value={money(bill.subtotal)} />
              <Stat label="Discount" value={money(bill.discountTotal)} />
              <Stat label="Input tax" value={money(bill.taxTotal)} testId="durable-bill-tax" />
              <Stat label="Bill total" value={money(bill.grandTotal)} strong />
              {/* The SERVER's derived outstanding amount. Never a local netting
                  of payments — that would be a second answer to a question the
                  server has already answered. */}
              <Stat label="Balance due" value={money(bill.balanceDue)} strong testId="durable-bill-balance" />
            </div>
            {bill.journalEntryId && (
              <p className="mt-3 text-xs text-slate-500">
                Journal entry recorded. Reversing posts an opposite entry and keeps both visible.
              </p>
            )}
          </section>
        )}

        <section aria-labelledby="durable-bill-notes" className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <h3 id="durable-bill-notes" className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Memo</h3>
          <Field label="Memo">
            <Input aria-label="Memo" value={notes} onChange={(e) => setNotes(e.target.value)}
              disabled={readOnly} placeholder="Optional note kept with the bill" />
          </Field>
        </section>

        {!readOnly && (
          <p className="flex items-start gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800/40">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" />
            Posting creates one balanced entry (Dr expense or asset, Dr recoverable input tax, Cr the
            supplier’s payable). No cash moves until a payment is posted, and a payment settles the
            whole of what it names.
          </p>
        )}
      </div>
    </Drawer>
  );
}

function Stat({ label, value, strong, testId }: {
  label: string; value: string; strong?: boolean; testId?: string;
}) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p data-testid={testId} className={cx('font-mono', strong ? 'text-sm font-semibold text-slate-900 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300')}>
        {value}
      </p>
    </div>
  );
}

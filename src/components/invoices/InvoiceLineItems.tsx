/**
 * Invoice line items, as a stack of cards rather than a wide table.
 *
 * ── Why this stopped being a table ───────────────────────────────────────────
 * Eight editable columns plus a remove button do not fit the drawer at any
 * useful width. The table survived by making every field narrow, which is
 * fine for a quantity and hostile for the two fields people read most: the
 * description and the revenue account. An account named "4120 · Professional
 * services — consulting" was showing as about nine characters.
 *
 * Each line is now a card of two rows. Row one is what the line IS — the item
 * and its description, given the full width. Row two is what it COSTS, plus the
 * account it credits. Nothing is narrower than its content needs.
 *
 * ── Why the labels are repeated on every card ────────────────────────────────
 * A table header labels its columns once. A stack of cards has no such row, so
 * each field carries its own label; without them the second row is six
 * unexplained numbers. They are `<label htmlFor>`-associated rather than
 * decorative text, so a screen reader announces the field, and clicking the
 * label focuses the input — which the old `<th>` never did either.
 *
 * ── Totals are displayed, never edited ───────────────────────────────────────
 * The line total is computed by `calculateInvoiceLine` on every render. It is
 * deliberately not an input: an invoice whose stated total disagrees with its
 * own quantity times price is the kind of document that gets an accountant
 * asked difficult questions.
 */
import { Trash2 } from 'lucide-react';
import type { InvoiceLine } from '@/types/invoice';
import type { Account } from '@/types';
import type { Project } from '@/types/project';
import { calculateInvoiceLine } from '@/lib/invoiceCalculations';
import { Input } from '@/components/ui/Input';
import { AccountSelect } from '@/components/journal/AccountSelect';
import { ItemSelector } from '@/components/items/ItemSelector';
import { CostCenterLineControl } from '@/components/cost-centers/CostCenterLineControl';
import { ProjectPicker } from '@/components/projects/ProjectPicker';
import { InventoryLineControl } from '@/components/inventory/InventoryLineControl';
import { rateOn } from '@/store/serverTaxCodeStore';
import type { ServerTaxCode } from '@/services/api/taxCodesApi';
import { cn } from '@/lib/utils';

/** "16.000000" reads badly in a picker; "16" is the same number. */
function trimRate(rate: string): string {
  return rate.includes('.') ? rate.replace(/0+$/, '').replace(/\.$/, '') : rate;
}

/** One labelled field inside a card. */
function LineField({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('min-w-0 space-y-1', className)}>
      <label
        htmlFor={htmlFor}
        className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

export interface InvoiceLineItemsProps {
  lines: InvoiceLine[];
  accounts: Account[];
  projects: Project[];
  currency: string;
  issueDate: string;
  moneyStep: string | number;
  money: (value: number) => string;
  readOnly: boolean;
  showCostCenter: boolean;
  showProject: boolean;
  showInventory: boolean;
  onChange: (id: string, patch: Partial<InvoiceLine>) => void;
  onSelectItem: (lineId: string, itemId?: string) => void;
  onRemove: (id: string) => void;
  /**
   * On SERVER books the tax is a code, not a number.
   *
   * The rate, the category and the method are decided by the server from the
   * code and the invoice date, so typing a percentage here would be typing a
   * figure the server refuses. When these are absent the workspace is a demo
   * one, whose invoices are browser records, and the free rate input stays.
   */
  serverTaxCodes?: ServerTaxCode[];
  serverTaxError?: string;
}

export function InvoiceLineItems({
  lines,
  accounts,
  projects,
  currency,
  issueDate,
  moneyStep,
  money,
  readOnly,
  showCostCenter,
  showProject,
  showInventory,
  onChange,
  onSelectItem,
  onRemove,
  serverTaxCodes,
  serverTaxError,
}: InvoiceLineItemsProps) {
  const serverTax = serverTaxCodes !== undefined;
  const showDimensions = showCostCenter || showProject || showInventory;
  /*
   * The last line is not removable. `removeLine` already refuses it, but a
   * button that silently does nothing is worse than one that is not offered.
   */
  const canRemove = !readOnly && lines.length > 1;

  return (
    <div className="space-y-2">
      {lines.map((line, index) => {
        const computed = calculateInvoiceLine(line);
        const id = (field: string): string => `line-${line.id}-${field}`;

        return (
          <div
            key={line.id}
            className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900"
          >
            {/* ── Row 1: what the line is ─────────────────────────────── */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
              <LineField label="Item" htmlFor={id('item')} className="sm:col-span-4">
                <ItemSelector
                  id={id('item')}
                  mode="sales"
                  value={line.itemId}
                  disabled={readOnly}
                  onChange={(itemId) => onSelectItem(line.id, itemId)}
                />
              </LineField>

              {/* The field people actually read. It gets the remaining width. */}
              <LineField label="Description" htmlFor={id('description')} className="sm:col-span-8">
                <Input
                  id={id('description')}
                  value={line.description}
                  onChange={(e) => onChange(line.id, { description: e.target.value })}
                  disabled={readOnly}
                  className="h-9"
                  placeholder="What is being billed"
                />
              </LineField>
            </div>

            {/* ── Row 2: what it costs ────────────────────────────────── */}
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-12">
              <LineField label="Qty" htmlFor={id('qty')} className="lg:col-span-1">
                <Input
                  id={id('qty')}
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  value={line.quantity}
                  onChange={(e) => onChange(line.id, { quantity: Number(e.target.value) })}
                  disabled={readOnly}
                  className="h-9 text-right"
                />
              </LineField>

              <LineField label="Unit price" htmlFor={id('price')} className="lg:col-span-2">
                <Input
                  id={id('price')}
                  type="number"
                  step={moneyStep}
                  data-money="true"
                  inputMode="decimal"
                  value={line.unitPrice}
                  onChange={(e) => onChange(line.id, { unitPrice: Number(e.target.value) })}
                  disabled={readOnly}
                  className="h-9 text-right"
                />
              </LineField>

              <LineField label="Disc %" htmlFor={id('disc')} className="lg:col-span-1">
                <Input
                  id={id('disc')}
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  value={line.discountValue ?? 0}
                  onChange={(e) =>
                    onChange(line.id, { discountType: 'percentage', discountValue: Number(e.target.value) })
                  }
                  disabled={readOnly}
                  className="h-9 text-right"
                />
              </LineField>

              {serverTax ? (
                <LineField label="Tax code" htmlFor={id('tax')} className="col-span-2 lg:col-span-2">
                  <select
                    id={id('tax')}
                    value={line.taxCodeId ?? ''}
                    onChange={(e) => onChange(line.id, { taxCodeId: e.target.value || undefined })}
                    disabled={readOnly}
                    className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                  >
                    {/* "No tax" is NOT zero-rated. A supply with no code is
                        untaxed; a zero-rated one is taxed at 0% and reported. */}
                    <option value="">No tax code</option>
                    {(serverTaxCodes ?? []).map((code) => {
                      const rate = rateOn(code, issueDate);
                      return (
                        <option key={code.id} value={code.id}>
                          {code.code} — {code.name}
                          {rate === null ? ' (no rate on this date)' : ` (${trimRate(rate)}%)`}
                        </option>
                      );
                    })}
                  </select>
                  {serverTaxError ? (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-400">{serverTaxError}</p>
                  ) : (serverTaxCodes ?? []).length === 0 ? (
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      No tax codes are set up for these books yet. Add one under Tax to charge tax.
                    </p>
                  ) : null}
                </LineField>
              ) : (
                <LineField label="Tax %" htmlFor={id('tax')} className="lg:col-span-1">
                  <Input
                    id={id('tax')}
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    value={line.taxRate}
                    onChange={(e) => onChange(line.id, { taxRate: Number(e.target.value) })}
                    disabled={readOnly}
                    className="h-9 text-right"
                  />
                </LineField>
              )}

              {/* Wide enough to show a full account name, which was the point. */}
              <LineField label="Revenue account" htmlFor={id('account')} className="col-span-2 sm:col-span-4 lg:col-span-4">
                <AccountSelect
                  id={id('account')}
                  value={line.accountId}
                  accounts={accounts}
                  onChange={(account) => onChange(line.id, { accountId: account.id })}
                  disabled={readOnly}
                />
              </LineField>

              <div className="col-span-2 flex items-end justify-between gap-2 sm:col-span-4 lg:col-span-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    Line total
                  </span>
                  {/*
                    * Derived, so it is text rather than a disabled input — a
                    * greyed-out box invites someone to try to type in it.
                    */}
                  <output
                    htmlFor={`${id('qty')} ${id('price')} ${id('disc')} ${id('tax')}`}
                    className="block h-9 truncate rounded-lg bg-slate-50 px-3 py-2 text-right font-mono text-sm font-semibold text-slate-900 dark:bg-slate-800/60 dark:text-slate-100"
                  >
                    {money(computed.lineTotal)}
                  </output>
                </div>

                {canRemove && (
                  <button
                    type="button"
                    onClick={() => onRemove(line.id)}
                    className="mb-0.5 shrink-0 rounded-lg p-2 text-slate-400 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"
                    aria-label={`Remove line ${index + 1}${line.description ? `: ${line.description}` : ''}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>

            {/* ── Cost centre / project / inventory, when entitled ────── */}
            {showDimensions && (
              <div className="mt-3 flex flex-wrap items-start gap-x-6 gap-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                {showCostCenter && (
                  <CostCenterLineControl
                    amount={computed.taxableAmount}
                    costCenterId={line.costCenterId}
                    assignments={line.costCenterAssignments}
                    postingDate={issueDate}
                    currency={currency}
                    disabled={readOnly}
                    onChange={(patch) => onChange(line.id, patch)}
                  />
                )}
                {showProject && (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Project</span>
                    <div className="w-52">
                      <ProjectPicker
                        value={line.projectId ?? ''}
                        projects={projects}
                        postingDate={issueDate}
                        disabled={readOnly}
                        onChange={(projectId) => onChange(line.id, { projectId: projectId || undefined })}
                      />
                    </div>
                  </div>
                )}
                {showInventory && (
                  <InventoryLineControl
                    mode="issue"
                    itemId={line.inventoryItemId}
                    warehouseId={line.warehouseId}
                    enabled={line.inventoryFulfillmentMode === 'issue-on-invoice'}
                    disabled={readOnly}
                    onChange={(p) =>
                      onChange(line.id, {
                        inventoryItemId: p.itemId,
                        warehouseId: p.warehouseId,
                        inventoryFulfillmentMode: p.enabled ? 'issue-on-invoice' : 'none',
                      })
                    }
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The running totals beneath the stack. */
export function InvoiceLineTotals({
  subtotal,
  taxTotal,
  grandTotal,
  money,
}: {
  subtotal: number;
  taxTotal: number;
  grandTotal: number;
  money: (value: number) => string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-800/40">
      <dl className="ml-auto w-full max-w-xs space-y-1 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500 dark:text-slate-400">Subtotal</dt>
          <dd className="font-mono text-slate-700 dark:text-slate-200">{money(subtotal)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500 dark:text-slate-400">Tax</dt>
          <dd className="font-mono text-slate-700 dark:text-slate-200">{money(taxTotal)}</dd>
        </div>
        <div className="flex justify-between gap-4 border-t border-slate-200 pt-1 dark:border-slate-700">
          <dt className="font-semibold text-slate-700 dark:text-slate-200">Total</dt>
          <dd className="font-mono font-semibold text-slate-900 dark:text-slate-50">{money(grandTotal)}</dd>
        </div>
      </dl>
    </div>
  );
}

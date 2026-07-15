import { useMemo, useState } from 'react';
import { Printer, Eye, X, Download, FileSpreadsheet, AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { BusinessEntity } from '@/types';
import type { StatementCurrencyMode, StatementLine, StatementType } from '@/types/statementOfAccount';
import { useStore } from '@/store/useStore';
import { useEntityStore } from '@/store/useEntityStore';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useCreditNoteStore } from '@/store/creditNoteStore';
import { useReceiptStore } from '@/store/receiptStore';
import { useJournalStore } from '@/store/journalStore';
import { useInvoiceTemplateStore, INVOICE_ENTITY_ID } from '@/store/invoiceTemplateStore';
import { useCreditNoteEditor } from '@/store/creditNoteEditorStore';
import { useReceiptEditor } from '@/store/receiptEditorStore';
import { useStatementStore } from '@/store/statementStore';
import { buildStatementOfAccount } from '@/lib/statementOfAccount';
import { createStatementTemplateSnapshot } from '@/lib/statementTemplate';
import { exportStatementCsv, exportStatementExcel, statementExportFilename } from '@/lib/statementExport';
import { STATEMENT_TYPE_LABELS } from '@/lib/statementLabels';
import { formatCurrency } from '@/lib/money';
import { cn, downloadFile } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Field } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageActions } from '@/components/ui/PageActions';
import { EntityPicker } from '@/components/shared/EntityPicker';
import { PrintDocument } from '@/components/ui/PrintDocument';
import { StatementRenderer } from '@/components/statements/StatementRenderer';

export function StatementsPage() {
  const settings = useStore((s) => s.settings);
  const accounts = useStore((s) => s.accounts);
  const setActiveView = useStore((s) => s.setActiveView);
  const entities = useEntityStore((s) => s.entities);
  const invoices = useInvoiceStore((s) => s.invoices);
  const creditNotes = useCreditNoteStore((s) => s.creditNotes);
  const receipts = useReceiptStore((s) => s.receipts);
  const journalEntries = useJournalStore((s) => s.entries);
  const templates = useInvoiceTemplateStore();

  const selectedCustomerId = useStatementStore((s) => s.selectedCustomerId);
  const selectCustomer = useStatementStore((s) => s.selectCustomer);
  const options = useStatementStore((s) => s.options);
  const setOptions = useStatementStore((s) => s.setOptions);

  const [showPreview, setShowPreview] = useState(false);

  const customers = useMemo(() => entities.filter((e) => e.entityType === 'customer' || e.entityType === 'both'), [entities]);

  const statement = useMemo(() => {
    if (!selectedCustomerId) return null;
    return buildStatementOfAccount({
      entityId: INVOICE_ENTITY_ID,
      customerId: selectedCustomerId,
      options,
      invoices, creditNotes, receipts, journalEntries,
      customers: entities, accounts,
      baseCurrency: settings.baseCurrency,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomerId, options, invoices, creditNotes, receipts, journalEntries, entities, accounts, settings.baseCurrency]);

  const snapshot = useMemo(() => {
    if (!statement) return null;
    const resolved = templates.resolve({ entityId: INVOICE_ENTITY_ID });
    const template = templates.getTemplate(resolved.templateId);
    const version = templates.getVersion(resolved.templateVersionId);
    if (!template || !version) return null;
    const address = [settings.addressLine1, settings.addressLine2, settings.city, settings.stateProvince, settings.postalCode, settings.country].filter(Boolean).join(', ');
    return createStatementTemplateSnapshot(
      template, version,
      { legalName: settings.companyName, tradingName: settings.tradingName || undefined, address: address || undefined, taxNumber: settings.taxRegistrationNumber || undefined, phone: settings.phone || undefined, email: settings.email || undefined, website: settings.website || undefined, logoUrl: settings.logoUrl || undefined },
      { name: statement.customerName, billingAddress: statement.billingAddress, taxNumber: statement.taxNumber },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statement, templates.templates, templates.versions, settings]);

  const money = (n: number): string => formatCurrency(n, statement?.currency ?? settings.baseCurrency);

  const drill = (l: StatementLine): void => {
    if (l.invoiceId && l.type === 'invoice') setActiveView('invoices');
    else if (l.creditNoteId) { useCreditNoteEditor.getState().requestOpen(l.creditNoteId); setActiveView('credit-notes'); }
    else if (l.receiptId) { useReceiptEditor.getState().requestOpen(l.receiptId); setActiveView('receipts'); }
    else if (l.journalEntryId) setActiveView('journal');
  };

  const onCsv = (): void => { if (statement) downloadFile(statementExportFilename(statement, 'csv'), exportStatementCsv(statement), 'text/csv'); };
  const onExcel = (): void => { if (statement) downloadFile(statementExportFilename(statement, 'xls'), exportStatementExcel(statement), 'application/vnd.ms-excel'); };

  const typeOptions = (Object.keys(STATEMENT_TYPE_LABELS) as StatementType[]).map((t) => ({ value: t, label: STATEMENT_TYPE_LABELS[t] }));

  return (
    <>
      <PageActions>
        <div className="min-w-[240px]"><EntityPicker value={selectedCustomerId} entities={customers} onChange={(e: BusinessEntity | null) => selectCustomer(e?.id ?? '')} placeholder="Select a customer…" /></div>
        {statement && <Button variant="outline" size="sm" onClick={() => setShowPreview(true)}><Eye className="h-4 w-4" /> Preview / print</Button>}
        {statement && <Button variant="outline" size="sm" onClick={onCsv}><Download className="h-4 w-4" /> CSV</Button>}
        {statement && <Button variant="outline" size="sm" onClick={onExcel}><FileSpreadsheet className="h-4 w-4" /> Excel</Button>}
      </PageActions>

      {/* Filters */}
      <Card className="mb-4"><CardBody>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Field label="Statement type"><Select options={typeOptions} value={options.statementType} onChange={(e) => setOptions({ statementType: e.target.value as StatementType })} /></Field>
          <Field label="Date basis"><Select options={[{ value: 'document', label: 'Document date' }, { value: 'posting', label: 'Posting date' }]} value={options.statementBasis} onChange={(e) => setOptions({ statementBasis: e.target.value as 'document' | 'posting' })} /></Field>
          <Field label="Start date"><Input type="date" value={options.periodStart} onChange={(e) => setOptions({ periodStart: e.target.value })} /></Field>
          <Field label="End date"><Input type="date" value={options.periodEnd} onChange={(e) => setOptions({ periodEnd: e.target.value, asOfDate: e.target.value })} /></Field>
          <Field label="Currency mode"><Select options={[{ value: 'single-currency', label: 'Single currency' }, { value: 'base-currency', label: 'Base currency' }, { value: 'multi-currency', label: 'Multi-currency' }]} value={options.currencyMode} onChange={(e) => setOptions({ currencyMode: e.target.value as StatementCurrencyMode })} /></Field>
          <Field label="Currency"><Input value={options.currency} onChange={(e) => setOptions({ currency: e.target.value.toUpperCase() })} disabled={options.currencyMode !== 'single-currency'} /></Field>
        </div>
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-600 dark:text-slate-300">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={options.includeSettledInvoices} onChange={(e) => setOptions({ includeSettledInvoices: e.target.checked })} /> Include settled invoices</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={options.includeAging} onChange={(e) => setOptions({ includeAging: e.target.checked })} /> Aging</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={options.includeOutstandingSchedule} onChange={(e) => setOptions({ includeOutstandingSchedule: e.target.checked })} /> Outstanding schedule</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={options.includeUnappliedReceipts} onChange={(e) => setOptions({ includeUnappliedReceipts: e.target.checked })} /> Unapplied receipts</label>
        </div>
      </CardBody></Card>

      {!statement ? (
        <Card><CardBody><EmptyState icon={Eye} title="Select a customer" description="Choose a customer to generate their statement of account — opening balance, activity, running balance, aging and reconciliation." /></CardBody></Card>
      ) : (
        <div className="space-y-4">
          {/* Warnings */}
          {statement.warnings.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
              {statement.warnings.map((w, i) => <p key={i} className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}</p>)}
            </div>
          )}

          {/* Summary */}
          <Card><CardBody>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold">{statement.customerName}{statement.customerCode ? ` · ${statement.customerCode}` : ''}</p>
                <p className="text-xs text-slate-500">{statement.periodStart} → {statement.periodEnd} · {statement.currency} · {STATEMENT_TYPE_LABELS[statement.statementType]}</p>
              </div>
              <Badge tone={statement.isReconciled ? 'green' : 'red'}>{statement.isReconciled ? <><CheckCircle2 className="mr-1 h-3 w-3" /> Reconciled</> : `Difference ${money(statement.reconciliationDifference)}`}</Badge>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Opening balance" value={money(statement.openingBalance)} />
              <Stat label="Invoices" value={money(statement.periodDebits)} />
              <Stat label="Credits & receipts" value={`(${money(statement.periodCredits)})`} />
              <Stat label="Closing balance" value={money(statement.closingBalance)} strong />
              <Stat label="Overdue" value={money(statement.overdueAmount)} />
              <Stat label="Customer credit" value={money(statement.availableCredit)} />
            </div>
          </CardBody></Card>

          {/* Transactions */}
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/80 dark:text-slate-400">
                  <tr>
                    {['Date', 'Document', 'Description', 'Due', 'Debit', 'Credit', 'Balance'].map((h) => (
                      <th key={h} className={cn('px-3 py-2 font-semibold', ['Debit', 'Credit', 'Balance'].includes(h) ? 'text-right' : 'text-left')}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {statement.lines.map((l) => (
                    <tr key={l.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/20">
                      <td className="px-3 py-2 text-xs text-slate-500">{l.date}</td>
                      <td className="px-3 py-2">
                        {l.documentNumber && l.type !== 'opening-balance' ? (
                          <button type="button" onClick={() => drill(l)} className="font-mono text-xs font-semibold text-brand-600 hover:underline dark:text-brand-300">{l.documentNumber}</button>
                        ) : <span className="text-xs text-slate-400">{l.documentNumber ?? '—'}</span>}
                      </td>
                      <td className="px-3 py-2 text-xs">{l.description}</td>
                      <td className={cn('px-3 py-2 text-xs', l.isOverdue ? 'font-semibold text-red-600' : 'text-slate-500')}>{l.dueDate ?? ''}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{l.debit ? money(l.debit) : ''}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{l.credit ? money(l.credit) : ''}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs font-semibold">{money(l.runningBalance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Aging + Outstanding */}
          <div className="grid gap-4 lg:grid-cols-2">
            {options.includeAging && statement.aging.total > 0 && (
              <Card><CardBody>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Aging (as of {statement.aging.asOfDate})</h3>
                <div className="grid grid-cols-3 gap-2 text-xs sm:grid-cols-4">
                  {statement.aging.buckets.map((b) => <Stat key={b.id} label={b.label} value={money(b.amount)} />)}
                  <Stat label="Total" value={money(statement.aging.total)} strong />
                </div>
              </CardBody></Card>
            )}
            {options.includeOutstandingSchedule && statement.outstandingInvoices.length > 0 && (
              <Card className="overflow-hidden"><div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400 dark:bg-slate-800/40"><tr>
                    <th className="px-2 py-1.5 text-left">Invoice</th><th className="px-2 py-1.5 text-left">Due</th><th className="px-2 py-1.5 text-right">Original</th><th className="px-2 py-1.5 text-right">Outstanding</th><th className="px-2 py-1.5 text-right">Days</th>
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {statement.outstandingInvoices.map((o) => (
                      <tr key={o.invoiceId}>
                        <td className="px-2 py-1.5 font-mono">{o.invoiceNumber}</td>
                        <td className="px-2 py-1.5 text-slate-500">{o.dueDate}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-slate-500">{money(o.originalTotal)}</td>
                        <td className="px-2 py-1.5 text-right font-mono font-semibold">{money(o.outstandingBalance)}</td>
                        <td className={cn('px-2 py-1.5 text-right', o.daysOverdue > 0 && 'font-semibold text-red-600')}>{o.daysOverdue > 0 ? o.daysOverdue : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div></Card>
            )}
          </div>
        </div>
      )}

      {/* Preview / print modal */}
      {showPreview && statement && snapshot && (
        <>
          <div className="fixed inset-0 z-50 flex flex-col bg-slate-900/50 backdrop-blur-sm">
            <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900">
              <div className="text-sm font-medium">Statement · {statement.customerName}</div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print / PDF</Button>
                <button onClick={() => setShowPreview(false)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close"><X className="h-5 w-5" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-6"><div className="mx-auto shadow-xl"><StatementRenderer statement={statement} snapshot={snapshot} /></div></div>
          </div>
          <PrintDocument><StatementRenderer statement={statement} snapshot={snapshot} /></PrintDocument>
        </>
      )}
    </>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={cn('font-mono', strong ? 'text-sm font-semibold text-slate-900 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300')}>{value}</p>
    </div>
  );
}

import type { Invoice, InvoiceColumnConfig, InvoiceTemplateSnapshot } from '@/types/invoice';
import type { InvoiceSettlementSummary } from '@/lib/invoiceSettlement';
import { calculateInvoiceLine } from '@/lib/invoiceCalculations';
import { resolveInvoiceLogo } from '@/lib/invoiceLogo';
import { formatCurrency } from '@/lib/money';
import { LogoImage } from './LogoImage';

interface Props {
  invoice: Invoice;
  snapshot: InvoiceTemplateSnapshot;
  /**
   * When present the renderer appends an "Updated account position" panel — used
   * for a CURRENT COPY. The original issued document (no settlement) is left
   * untouched, so the historical snapshot is never rewritten.
   */
  settlement?: InvoiceSettlementSummary | null;
  /** As-of date shown on the current-copy panel (defaults to today). */
  settlementAsOf?: string;
  /** Per-credit-note deduction lines (e.g. "Less: CN-2026-0004 (3,000.00)"). */
  settlementCreditNotes?: { number: string; applied: number }[];
}

/** "12 July 2026" style long date; accepts ISO date or datetime; falls back to the raw string. */
function longDate(iso: string | undefined): string {
  if (!iso) return new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function visibleColumns(cols: InvoiceColumnConfig[]): InvoiceColumnConfig[] {
  return cols.filter((c) => c.visible).sort((a, b) => a.order - b.order);
}

/**
 * Renders an invoice from a frozen template snapshot (used for preview, print
 * and PDF). Honours RTL, custom labels, column visibility/order, brand colours
 * and section toggles. Historical invoices always render from their own
 * snapshot, so later template edits never change them.
 */
export function InvoiceRenderer({ invoice, snapshot, settlement, settlementAsOf, settlementCreditNotes }: Props) {
  const { styleConfig: style, contentConfig: content, layoutConfig: layout, companySnapshot: co, customerSnapshot: cust } = snapshot;
  const rtl = content.direction === 'rtl';
  const label = (key: string, fallback: string): string => content.customLabels[key] || fallback;
  const money = (n: number): string => formatCurrency(n, invoice.currency);
  const cols = visibleColumns(layout.lineItemColumns);
  const sectionVisible = (kind: string): boolean => layout.sections.find((s) => s.kind === kind)?.visible ?? true;

  const align = rtl ? 'right' : 'left';
  const opp = rtl ? 'left' : 'right';

  return (
    <div
      dir={content.direction}
      lang={content.language}
      className="invoice-page relative mx-auto bg-white text-slate-900"
      style={{
        width: layout.pageSize === 'Letter' ? '8.5in' : '210mm',
        minHeight: layout.pageSize === 'Letter' ? '11in' : '297mm',
        padding: `${layout.margins.top}px ${layout.margins.right}px ${layout.margins.bottom}px ${layout.margins.left}px`,
        fontFamily: style.fontFamily,
        fontSize: style.baseFontSize,
        color: style.textColor,
        backgroundColor: style.backgroundColor,
      }}
    >
      {invoice.status === 'void' && (
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rotate-[-24deg] select-none text-[120px] font-black uppercase tracking-widest text-red-500/10">Void</span>
        </div>
      )}
      {invoice.status !== 'void' && style.watermark && (
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rotate-[-24deg] select-none text-[110px] font-black uppercase tracking-widest" style={{ color: `${style.primaryColor}12` }}>{style.watermark}</span>
        </div>
      )}

      {/* Header: company + title */}
      <header className="flex items-start justify-between gap-6" style={{ flexDirection: layout.headerLayout === 'logo-right' ? 'row-reverse' : 'row' }}>
        <div>
          {(() => {
            // Single shared resolver — same result for preview, print, PDF and issued views.
            const logo = resolveInvoiceLogo(snapshot);
            if (!logo.visible || !logo.url) return null; // hidden or no logo → nothing (no broken icon)
            const posAlign = logo.position === 'right' ? 'flex-end' : logo.position === 'center' ? 'center' : 'flex-start';
            return (
              <div className="mb-2 flex" style={{ justifyContent: posAlign }}>
                <LogoImage
                  url={logo.url}
                  alt={`${co.legalName} logo`}
                  style={{ maxWidth: logo.width, maxHeight: logo.maxHeight, width: 'auto', height: 'auto', objectFit: logo.fit }}
                />
              </div>
            );
          })()}
          <p className="text-base font-bold" style={{ color: style.primaryColor }}>{co.legalName}</p>
          {co.tradingName && <p className="text-xs" style={{ color: style.secondaryColor }}>{co.tradingName}</p>}
          {content.showCompanyAddress && co.address && <p className="mt-1 max-w-[280px] text-xs" style={{ color: style.secondaryColor }}>{co.address}</p>}
          <p className="mt-1 text-xs" style={{ color: style.secondaryColor }}>
            {[co.phone, co.email, co.website].filter(Boolean).join(' · ')}
          </p>
          {content.showTaxDetails && (
            <p className="text-xs" style={{ color: style.secondaryColor }}>
              {[co.taxNumber && `${label('taxNumber', 'Tax No.')}: ${co.taxNumber}`, co.registrationNumber && `${label('regNumber', 'Reg. No.')}: ${co.registrationNumber}`].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
        <div style={{ textAlign: opp }}>
          <h1 className="text-2xl font-black uppercase tracking-wide" style={{ color: style.primaryColor }}>{content.title}</h1>
          <table className="mt-2 text-xs" style={{ marginInlineStart: rtl ? 0 : 'auto' }}>
            <tbody>
              <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>{label('invoiceNumber', 'Invoice No.')}</td><td className="font-mono font-semibold">{invoice.invoiceNumber}</td></tr>
              <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>{label('issueDate', 'Issue date')}</td><td>{invoice.issueDate}</td></tr>
              <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>{label('dueDate', 'Due date')}</td><td>{invoice.dueDate}</td></tr>
              {invoice.purchaseOrderReference && <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>{label('po', 'PO')}</td><td>{invoice.purchaseOrderReference}</td></tr>}
              <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>{label('currency', 'Currency')}</td><td>{invoice.currency}</td></tr>
            </tbody>
          </table>
        </div>
      </header>

      {/* Bill to */}
      {content.showCustomerAddress && sectionVisible('customer') && (
        <section className="mt-6">
          <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: style.secondaryColor }}>{label('billTo', 'Bill to')}</p>
          <p className="text-sm font-semibold">{cust.name}</p>
          {cust.billingAddress && <p className="text-xs" style={{ color: style.secondaryColor }}>{cust.billingAddress}</p>}
          <p className="text-xs" style={{ color: style.secondaryColor }}>{[cust.phone, cust.email, cust.taxNumber && `${label('taxNumber', 'Tax No.')}: ${cust.taxNumber}`].filter(Boolean).join(' · ')}</p>
        </section>
      )}

      {/* Line items */}
      <section className="mt-6">
        <table className="w-full border-collapse text-xs" style={{ direction: content.direction }}>
          <thead>
            <tr style={{ backgroundColor: style.primaryColor, color: '#fff' }}>
              {cols.map((c) => (
                <th key={c.field} className="px-2 py-2 font-semibold" style={{ textAlign: c.align ?? (c.field === 'description' || c.field === 'item' ? align : 'right') }}>
                  {label(c.field, c.label)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((line, i) => {
              const c = calculateInvoiceLine(line);
              return (
                <tr key={line.id} style={{ backgroundColor: style.tableStyle === 'striped' && i % 2 ? '#f8fafc' : undefined, borderBottom: style.showTableGrid || style.tableStyle === 'bordered' ? `1px solid ${style.borderColor}` : `1px solid ${style.borderColor}55` }}>
                  {cols.map((col) => (
                    <td key={col.field} className="px-2 py-1.5" style={{ textAlign: col.align ?? (col.field === 'description' || col.field === 'item' ? align : 'right') }}>
                      {renderCell(col.field, line, c, money)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* Totals */}
      {sectionVisible('totals') && (
        <section className="mt-4 flex" style={{ justifyContent: rtl ? 'flex-start' : 'flex-end' }}>
          <table className="text-sm" style={{ minWidth: 260 }}>
            <tbody>
              <TotalRow label={label('subtotal', 'Subtotal')} value={money(invoice.subtotal)} muted color={style.secondaryColor} />
              {invoice.discountTotal > 0 && <TotalRow label={label('discount', 'Discount')} value={`- ${money(invoice.discountTotal)}`} muted color={style.secondaryColor} />}
              {invoice.taxTotal > 0 && <TotalRow label={label('tax', 'Tax')} value={money(invoice.taxTotal)} muted color={style.secondaryColor} />}
              {invoice.additionalChargesTotal > 0 && <TotalRow label={label('charges', 'Charges')} value={money(invoice.additionalChargesTotal)} muted color={style.secondaryColor} />}
              <tr style={{ borderTop: `2px solid ${style.primaryColor}` }}>
                <td className="py-1.5 pr-6 font-bold" style={{ color: style.primaryColor }}>{label('total', 'Total')}</td>
                <td className="py-1.5 text-right font-mono font-bold" style={{ color: style.primaryColor }}>{money(invoice.grandTotal)}</td>
              </tr>
              {(invoice.creditsApplied ?? 0) > 0 && <TotalRow label={label('creditNotesApplied', 'Less: credit notes')} value={`- ${money(invoice.creditsApplied)}`} muted color={style.secondaryColor} />}
              {invoice.amountPaid > 0 && <TotalRow label={label('amountPaid', 'Amount paid')} value={`- ${money(invoice.amountPaid)}`} muted color={style.secondaryColor} />}
              <tr><td className="py-1 pr-6 font-semibold">{label('balanceDue', 'Balance due')}</td><td className="py-1 text-right font-mono font-semibold">{money(invoice.balanceDue)}</td></tr>
            </tbody>
          </table>
        </section>
      )}

      {/* Updated account position (current copy only — never on the original issued document).
          Gated on an explicit null check: a zero payment is a valid amount and must not hide it. */}
      {settlement != null && (
        <section className="mt-5 flex" style={{ justifyContent: rtl ? 'flex-start' : 'flex-end' }}>
          <div className="rounded-md px-3 py-2" style={{ border: `1px solid ${style.primaryColor}`, minWidth: 320 }}>
            <p className="mb-1 text-[11px] font-bold uppercase tracking-wide" style={{ color: style.primaryColor }}>
              {label('accountPosition', 'Updated account position')} {label('asOf', 'as of')} {longDate(settlementAsOf)}
            </p>
            <table className="w-full text-xs">
              <tbody>
                <tr><td className="py-1 pr-6" style={{ color: style.secondaryColor }}>{label('origTotal', 'Original invoice total')}</td><td className="py-1 text-right font-mono">{money(settlement.originalTotal)}</td></tr>
                {settlementCreditNotes && settlementCreditNotes.length > 0 ? (
                  settlementCreditNotes.map((c) => (
                    <tr key={c.number}><td className="py-1 pr-6" style={{ color: style.secondaryColor }}>{label('lessCredit', 'Less')}: {c.number}</td><td className="py-1 text-right font-mono">({money(c.applied)})</td></tr>
                  ))
                ) : (
                  <tr><td className="py-1 pr-6" style={{ color: style.secondaryColor }}>{label('lessCredits', 'Less: credit notes')}</td><td className="py-1 text-right font-mono">{settlement.creditNotesApplied > 0 ? `(${money(settlement.creditNotesApplied)})` : money(0)}</td></tr>
                )}
                <tr><td className="py-1 pr-6" style={{ color: style.secondaryColor }}>{label('lessPayments', 'Less: payments received')}</td><td className="py-1 text-right font-mono">{settlement.paymentsApplied > 0 ? `(${money(settlement.paymentsApplied)})` : money(0)}</td></tr>
                <tr style={{ borderTop: `2px solid ${style.primaryColor}` }}>
                  <td className="py-1.5 pr-6 font-bold" style={{ color: style.primaryColor }}>{label('currentBalance', 'Current balance due')}</td>
                  <td className="py-1.5 text-right font-mono font-bold" style={{ color: style.primaryColor }}>{money(settlement.balanceDue)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Payment / notes / terms */}
      <section className="mt-6 grid grid-cols-2 gap-6 text-xs" style={{ color: style.secondaryColor }}>
        <div className="space-y-3">
          {content.showPaymentTerms && invoice.paymentTerms && <div><p className="font-semibold text-slate-700">{label('paymentTerms', 'Payment terms')}</p><p>{invoice.paymentTerms}</p></div>}
          {content.showBankDetails && co.bankDetails && <div><p className="font-semibold text-slate-700">{label('bank', 'Bank details')}</p><p className="whitespace-pre-line">{co.bankDetails}</p></div>}
          {content.paymentInstructions && <p>{content.paymentInstructions}</p>}
        </div>
        <div className="space-y-3">
          {content.showNotes && invoice.notes && <div><p className="font-semibold text-slate-700">{label('notes', 'Notes')}</p><p>{invoice.notes}</p></div>}
          {content.showTerms && (invoice.terms || content.termsText) && <div><p className="font-semibold text-slate-700">{label('terms', 'Terms & conditions')}</p><p>{invoice.terms || content.termsText}</p></div>}
        </div>
      </section>

      {content.showSignature && sectionVisible('signature') && (
        <section className="mt-10 flex" style={{ justifyContent: opp === 'right' ? 'flex-end' : 'flex-start' }}>
          <div className="text-center text-xs" style={{ color: style.secondaryColor }}>
            <div className="mb-1 h-10 w-48 border-b" style={{ borderColor: style.borderColor }} />
            {label('signature', 'Authorized signature')}
          </div>
        </section>
      )}

      {content.footerText && <footer className="mt-8 border-t pt-3 text-center text-[11px]" style={{ borderColor: style.borderColor, color: style.secondaryColor }}>{content.footerText}</footer>}
    </div>
  );
}

function renderCell(field: InvoiceColumnConfig['field'], line: Invoice['lines'][number], c: ReturnType<typeof calculateInvoiceLine>, money: (n: number) => string): string {
  switch (field) {
    case 'item': return line.itemId || line.description.split(' ').slice(0, 3).join(' ');
    case 'description': return line.description;
    case 'quantity': return String(line.quantity);
    case 'unit': return line.unit ?? '';
    case 'unitPrice': return money(line.unitPrice);
    case 'discount': return c.discountAmount ? money(c.discountAmount) : '—';
    case 'taxRate': return `${line.taxRate}%`;
    case 'taxAmount': return money(c.taxAmount);
    case 'lineTotal': return money(c.lineTotal);
    default: return '';
  }
}

function TotalRow({ label, value, muted, color }: { label: string; value: string; muted?: boolean; color?: string }) {
  return (
    <tr>
      <td className="py-1 pr-6" style={{ color: muted ? color : undefined }}>{label}</td>
      <td className="py-1 text-right font-mono" style={{ color: muted ? color : undefined }}>{value}</td>
    </tr>
  );
}

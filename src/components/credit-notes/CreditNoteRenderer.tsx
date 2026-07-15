import type { CreditNote, CreditNoteInvoiceReferenceSnapshot, CreditNoteTemplateSnapshot } from '@/types/creditNote';
import { calculateCreditNoteLine } from '@/lib/creditNoteCalculations';
import { resolveInvoiceLogo } from '@/lib/invoiceLogo';
import { formatCurrency } from '@/lib/money';
import { CREDIT_NOTE_REASON_LABELS } from '@/lib/creditNoteLabels';
import { LogoImage } from '@/components/invoices/LogoImage';

interface Props {
  creditNote: CreditNote;
  snapshot: CreditNoteTemplateSnapshot;
  /** Original-invoice financial context (frozen if issued, live if draft). */
  reference?: CreditNoteInvoiceReferenceSnapshot | null;
}

/** "12 July 2026" style long date; falls back to the raw string. */
function longDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Renders a credit note from a frozen template snapshot (preview, print, PDF).
 * Prominently shows the ORIGINAL INVOICE REFERENCE and a CREDIT RECONCILIATION
 * that ties the original invoice total → previous credits → payments → this
 * credit → revised balance. All original values come from the frozen reference
 * snapshot, so a posted credit note never changes if the invoice is later paid,
 * further credited, or its customer data edited.
 */
export function CreditNoteRenderer({ creditNote: cn, snapshot, reference }: Props) {
  const { styleConfig: style, contentConfig: content, layoutConfig: layout, companySnapshot: co, customerSnapshot: cust } = snapshot;
  const rtl = content.direction === 'rtl';
  const label = (key: string, fallback: string): string => content.customLabels[key] || fallback;
  const money = (n: number): string => formatCurrency(n, cn.currency);
  const neg = (n: number): string => `(${money(n)})`;
  const align = rtl ? 'right' : 'left';
  const opp = rtl ? 'left' : 'right';
  const reason = cn.reasonDescription?.trim() || CREDIT_NOTE_REASON_LABELS[cn.reasonCode];
  const invNumber = reference?.invoiceNumber ?? cn.originalInvoiceNumber;
  const invDate = reference?.invoiceDate ?? cn.originalInvoiceDate;
  // When a linked credit note is fully consumed by its invoice, the reconciliation
  // panel already tells the story — so the "Amount applied / Remaining credit"
  // rows are redundant and are hidden. They still show for unapplied, partially
  // applied or refunded credits, where the remaining balance matters.
  const fullyAppliedToInvoice = !!cn.originalInvoiceId && cn.amountApplied > 0.005 && cn.amountRefunded <= 0.005 && cn.remainingCredit <= 0.005;

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
      {cn.status === 'void' && (
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rotate-[-24deg] select-none text-[120px] font-black uppercase tracking-widest text-red-500/10">Void</span>
        </div>
      )}

      {/* Header: company + title */}
      <header className="flex items-start justify-between gap-6" style={{ flexDirection: layout.headerLayout === 'logo-right' ? 'row-reverse' : 'row' }}>
        <div>
          {(() => {
            const logo = resolveInvoiceLogo(snapshot);
            if (!logo.visible || !logo.url) return null;
            const posAlign = logo.position === 'right' ? 'flex-end' : logo.position === 'center' ? 'center' : 'flex-start';
            return (
              <div className="mb-2 flex" style={{ justifyContent: posAlign }}>
                <LogoImage url={logo.url} alt={`${co.legalName} logo`} style={{ maxWidth: logo.width, maxHeight: logo.maxHeight, width: 'auto', height: 'auto', objectFit: logo.fit }} />
              </div>
            );
          })()}
          <p className="text-base font-bold" style={{ color: style.primaryColor }}>{co.legalName}</p>
          {co.tradingName && <p className="text-xs" style={{ color: style.secondaryColor }}>{co.tradingName}</p>}
          {content.showCompanyAddress && co.address && <p className="mt-1 max-w-[280px] text-xs" style={{ color: style.secondaryColor }}>{co.address}</p>}
          <p className="mt-1 text-xs" style={{ color: style.secondaryColor }}>{[co.phone, co.email, co.website].filter(Boolean).join(' · ')}</p>
          {content.showTaxDetails && co.taxNumber && <p className="text-xs" style={{ color: style.secondaryColor }}>{label('taxNumber', 'Tax No.')}: {co.taxNumber}</p>}
        </div>
        <div style={{ textAlign: opp }}>
          <h1 className="text-2xl font-black uppercase tracking-wide" style={{ color: style.primaryColor }}>{content.title || 'Credit Note'}</h1>
          <table className="mt-2 text-xs" style={{ marginInlineStart: rtl ? 0 : 'auto' }}>
            <tbody>
              <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>{label('creditNoteNumber', 'Credit note No.')}</td><td className="font-mono font-semibold">{cn.creditNoteNumber}</td></tr>
              <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>{label('issueDate', 'Issue date')}</td><td>{cn.issueDate}</td></tr>
              <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>{label('currency', 'Currency')}</td><td>{cn.currency}</td></tr>
            </tbody>
          </table>
        </div>
      </header>

      {/* Prominent credit-against line */}
      {invNumber && (
        <p className="mt-4 text-sm font-semibold" style={{ color: style.primaryColor }}>
          {label('creditAgainst', 'Credit against Invoice')} {invNumber}{invDate ? ` ${label('dated', 'dated')} ${longDate(invDate)}` : ''}
        </p>
      )}

      {/* Bill to + original invoice reference panel */}
      <section className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {content.showCustomerAddress && (
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: style.secondaryColor }}>{label('creditTo', 'Credit to')}</p>
            <p className="text-sm font-semibold">{cust.name}</p>
            {cust.billingAddress && <p className="text-xs" style={{ color: style.secondaryColor }}>{cust.billingAddress}</p>}
            <p className="text-xs" style={{ color: style.secondaryColor }}>{[cust.phone, cust.email, cust.taxNumber && `${label('taxNumber', 'Tax No.')}: ${cust.taxNumber}`].filter(Boolean).join(' · ')}</p>
          </div>
        )}
        {invNumber && (
          <div className="rounded-md px-3 py-2 text-xs" style={{ border: `1px solid ${style.borderColor}` }}>
            <p className="mb-1 text-[11px] font-bold uppercase tracking-wide" style={{ color: style.primaryColor }}>{label('originalInvoiceReference', 'Original invoice reference')}</p>
            <RefRow label={label('invoiceNumber', 'Invoice number')} value={invNumber} color={style.secondaryColor} mono />
            {invDate && <RefRow label={label('invoiceDate', 'Invoice date')} value={longDate(invDate)} color={style.secondaryColor} />}
            {reference && <RefRow label={label('originalTotal', 'Original invoice total')} value={money(reference.originalInvoiceTotal)} color={style.secondaryColor} mono />}
            {reference?.purchaseOrderReference && <RefRow label={label('po', 'PO reference')} value={reference.purchaseOrderReference} color={style.secondaryColor} />}
            {reference?.customerReference && <RefRow label={label('customerRef', 'Customer reference')} value={reference.customerReference} color={style.secondaryColor} />}
          </div>
        )}
      </section>

      {/* Reason */}
      <section className="mt-4">
        <div className="rounded-md px-3 py-2 text-xs" style={{ border: `1px solid ${style.borderColor}`, color: style.secondaryColor }}>
          <span className="font-semibold" style={{ color: style.primaryColor }}>{label('reason', 'Reason for credit')}: </span>{reason}
        </div>
      </section>

      {/* Credited lines */}
      <section className="mt-5">
        {reference && reference.lines.length ? (
          <table className="w-full border-collapse text-[11px]" style={{ direction: content.direction }}>
            <thead>
              <tr style={{ backgroundColor: style.primaryColor, color: '#fff' }}>
                <th className="px-1.5 py-2 font-semibold" style={{ textAlign: align }}>{label('item', 'Item')}</th>
                <th className="px-1.5 py-2 font-semibold" style={{ textAlign: align }}>{label('description', 'Description')}</th>
                <th className="px-1.5 py-2 font-semibold" style={{ textAlign: 'right' }}>{label('origQty', 'Orig qty')}</th>
                <th className="px-1.5 py-2 font-semibold" style={{ textAlign: 'right' }}>{label('prevCredited', 'Prev. credited')}</th>
                <th className="px-1.5 py-2 font-semibold" style={{ textAlign: 'right' }}>{label('creditedNow', 'Credited')}</th>
                <th className="px-1.5 py-2 font-semibold" style={{ textAlign: 'right' }}>{label('remainingQty', 'Remaining')}</th>
                <th className="px-1.5 py-2 font-semibold" style={{ textAlign: 'right' }}>{label('origUnitPrice', 'Orig unit price')}</th>
                <th className="px-1.5 py-2 font-semibold" style={{ textAlign: 'right' }}>{label('origLineTotal', 'Orig line total')}</th>
                <th className="px-1.5 py-2 font-semibold" style={{ textAlign: 'right' }}>{label('creditTotal', 'Credit total')}</th>
              </tr>
            </thead>
            <tbody>
              {reference.lines.map((rl, i) => (
                <tr key={rl.creditNoteLineId} style={{ backgroundColor: style.tableStyle === 'striped' && i % 2 ? '#f8fafc' : undefined, borderBottom: `1px solid ${style.borderColor}${style.showTableGrid || style.tableStyle === 'bordered' ? '' : '55'}` }}>
                  <td className="px-1.5 py-1.5" style={{ textAlign: align }}>{rl.itemLabel}</td>
                  <td className="px-1.5 py-1.5" style={{ textAlign: align }}>
                    {rl.description}
                    {rl.creditBasis === 'amount' && (
                      <span className="ml-1 rounded px-1 py-0.5 text-[9px] font-semibold uppercase" style={{ border: `1px solid ${style.borderColor}`, color: style.secondaryColor }}>{label('amountAdjustment', 'Credit basis: Amount adjustment')}</span>
                    )}
                  </td>
                  <td className="px-1.5 py-1.5" style={{ textAlign: 'right' }}>{rl.originalInvoiceLineId ? rl.originalQuantity : '—'}</td>
                  <td className="px-1.5 py-1.5" style={{ textAlign: 'right' }}>{rl.originalInvoiceLineId ? rl.previouslyCreditedQuantity : '—'}</td>
                  <td className="px-1.5 py-1.5" style={{ textAlign: 'right' }}>{rl.creditBasis === 'amount' ? '—' : rl.quantityCreditedByThisNote}</td>
                  <td className="px-1.5 py-1.5" style={{ textAlign: 'right' }}>{rl.originalInvoiceLineId ? rl.remainingQuantity : '—'}</td>
                  <td className="px-1.5 py-1.5 font-mono" style={{ textAlign: 'right' }}>{rl.originalInvoiceLineId ? money(rl.originalUnitPrice) : '—'}</td>
                  <td className="px-1.5 py-1.5 font-mono" style={{ textAlign: 'right' }}>{rl.originalInvoiceLineId ? money(rl.originalLineTotal) : '—'}</td>
                  <td className="px-1.5 py-1.5 font-mono" style={{ textAlign: 'right' }}>{money(rl.creditNoteLineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full border-collapse text-xs" style={{ direction: content.direction }}>
            <thead>
              <tr style={{ backgroundColor: style.primaryColor, color: '#fff' }}>
                <th className="px-2 py-2 font-semibold" style={{ textAlign: align }}>{label('description', 'Description')}</th>
                <th className="px-2 py-2 font-semibold" style={{ textAlign: 'right' }}>{label('creditedQty', 'Credited qty')}</th>
                <th className="px-2 py-2 font-semibold" style={{ textAlign: 'right' }}>{label('unitPrice', 'Unit price')}</th>
                <th className="px-2 py-2 font-semibold" style={{ textAlign: 'right' }}>{label('creditTotal', 'Credit total')}</th>
              </tr>
            </thead>
            <tbody>
              {cn.lines.map((line, i) => (
                <tr key={line.id} style={{ backgroundColor: style.tableStyle === 'striped' && i % 2 ? '#f8fafc' : undefined, borderBottom: `1px solid ${style.borderColor}55` }}>
                  <td className="px-2 py-1.5" style={{ textAlign: align }}>{line.description}</td>
                  <td className="px-2 py-1.5" style={{ textAlign: 'right' }}>{line.quantity}</td>
                  <td className="px-2 py-1.5 font-mono" style={{ textAlign: 'right' }}>{money(line.unitPrice)}</td>
                  <td className="px-2 py-1.5 font-mono" style={{ textAlign: 'right' }}>{money(calculateCreditNoteLine(line).lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Credit totals */}
      <section className="mt-4 flex" style={{ justifyContent: rtl ? 'flex-start' : 'flex-end' }}>
        <table className="text-sm" style={{ minWidth: 280 }}>
          <tbody>
            <TotalRow label={label('subtotal', 'Subtotal')} value={money(cn.subtotal)} color={style.secondaryColor} />
            {cn.discountTotal > 0 && <TotalRow label={label('discount', 'Discount')} value={neg(cn.discountTotal)} color={style.secondaryColor} />}
            {cn.taxTotal > 0 && <TotalRow label={label('taxReversal', 'Tax reversal')} value={money(cn.taxTotal)} color={style.secondaryColor} />}
            <tr style={{ borderTop: `2px solid ${style.primaryColor}` }}>
              <td className="py-1.5 pr-6 font-bold" style={{ color: style.primaryColor }}>{label('totalCredit', 'Total credit')}</td>
              <td className="py-1.5 text-right font-mono font-bold" style={{ color: style.primaryColor }}>{money(cn.grandTotal)}</td>
            </tr>
            {cn.amountApplied > 0 && !fullyAppliedToInvoice && <TotalRow label={label('amountApplied', 'Amount applied')} value={neg(cn.amountApplied)} color={style.secondaryColor} />}
            {cn.amountRefunded > 0 && <TotalRow label={label('amountRefunded', 'Amount refunded')} value={neg(cn.amountRefunded)} color={style.secondaryColor} />}
            {!fullyAppliedToInvoice && <tr><td className="py-1 pr-6 font-semibold">{label('remainingCredit', 'Remaining credit')}</td><td className="py-1 text-right font-mono font-semibold">{money(cn.remainingCredit)}</td></tr>}
          </tbody>
        </table>
      </section>

      {/* Credit reconciliation panel */}
      {reference && (
        <section className="mt-5 flex" style={{ justifyContent: rtl ? 'flex-start' : 'flex-end' }}>
          <div className="rounded-md px-3 py-2" style={{ border: `1px solid ${style.borderColor}`, minWidth: 320 }}>
            <p className="mb-1 text-[11px] font-bold uppercase tracking-wide" style={{ color: style.primaryColor }}>{label('reconciliation', 'Credit reconciliation')}</p>
            <table className="w-full text-xs">
              <tbody>
                <ReconRow label={label('originalTotal', 'Original invoice total')} value={money(reference.originalInvoiceTotal)} color={style.secondaryColor} />
                <ReconRow label={label('lessPrevCredits', 'Less: previous credit notes')} value={neg(reference.previousCreditsTotal)} color={style.secondaryColor} />
                <ReconRow label={label('lessPayments', 'Less: payments received')} value={neg(reference.paymentsAppliedBeforeCredit)} color={style.secondaryColor} />
                <ReconRow label={label('balanceBefore', 'Balance before this credit')} value={money(reference.invoiceBalanceBeforeCredit)} color={style.secondaryColor} strong border={style.borderColor} />
                <ReconRow label={label('lessThisCredit', 'Less: this credit note')} value={neg(reference.currentCreditAmount)} color={style.secondaryColor} />
                <tr style={{ borderTop: `2px solid ${style.primaryColor}` }}>
                  <td className="py-1.5 pr-6 font-bold" style={{ color: style.primaryColor }}>{label('revisedBalance', 'Revised invoice balance')}</td>
                  <td className="py-1.5 text-right font-mono font-bold" style={{ color: style.primaryColor }}>{money(reference.invoiceBalanceAfterCredit)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Notes / terms / signature / footer */}
      <section className="mt-6 grid grid-cols-2 gap-6 text-xs" style={{ color: style.secondaryColor }}>
        <div className="space-y-3">
          {content.showBankDetails && co.bankDetails && <div><p className="font-semibold text-slate-700">{label('bank', 'Bank details')}</p><p className="whitespace-pre-line">{co.bankDetails}</p></div>}
        </div>
        <div className="space-y-3">
          {content.showNotes && cn.notes && <div><p className="font-semibold text-slate-700">{label('notes', 'Notes')}</p><p>{cn.notes}</p></div>}
          {content.showTerms && (cn.terms || content.termsText) && <div><p className="font-semibold text-slate-700">{label('terms', 'Terms & conditions')}</p><p>{cn.terms || content.termsText}</p></div>}
        </div>
      </section>

      {content.showSignature && (
        <section className="mt-8 flex" style={{ justifyContent: opp === 'right' ? 'flex-end' : 'flex-start' }}>
          <div className="text-center text-xs" style={{ color: style.secondaryColor }}>
            <div className="mb-1 h-10 w-48 border-b" style={{ borderColor: style.borderColor }} />
            {label('signature', 'Authorized signature')}
          </div>
        </section>
      )}

      {content.footerText && <footer className="mt-6 border-t pt-3 text-center text-[11px]" style={{ borderColor: style.borderColor, color: style.secondaryColor }}>{content.footerText}</footer>}
    </div>
  );
}

function RefRow({ label, value, color, mono }: { label: string; value: string; color?: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span style={{ color }}>{label}</span>
      <span className={mono ? 'font-mono font-semibold' : 'font-semibold'}>{value}</span>
    </div>
  );
}

function ReconRow({ label, value, color, strong, border }: { label: string; value: string; color?: string; strong?: boolean; border?: string }) {
  return (
    <tr style={border ? { borderTop: `1px solid ${border}` } : undefined}>
      <td className={`py-1 pr-6 ${strong ? 'font-semibold' : ''}`} style={{ color: strong ? undefined : color }}>{label}</td>
      <td className={`py-1 text-right font-mono ${strong ? 'font-semibold' : ''}`} style={{ color: strong ? undefined : color }}>{value}</td>
    </tr>
  );
}

function TotalRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <tr>
      <td className="py-1 pr-6" style={{ color }}>{label}</td>
      <td className="py-1 text-right font-mono" style={{ color }}>{value}</td>
    </tr>
  );
}

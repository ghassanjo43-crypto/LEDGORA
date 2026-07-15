import type { InvoiceTemplateSnapshot } from '@/types/invoice';
import type { StatementOfAccount } from '@/types/statementOfAccount';
import { resolveInvoiceLogo } from '@/lib/invoiceLogo';
import { formatCurrency } from '@/lib/money';
import { STATEMENT_LINE_TYPE_LABELS } from '@/lib/statementLabels';
import { LogoImage } from '@/components/invoices/LogoImage';

interface Props {
  statement: StatementOfAccount;
  snapshot: InvoiceTemplateSnapshot;
}

/**
 * Customer-facing Statement of Account document (preview / print / PDF). Reuses
 * the invoice template's branding (logo, colours, fonts, company identity) and
 * presents the derived statement: opening balance, a chronological transaction
 * table with running balance, closing balance, aging and outstanding invoices.
 * The `<thead>` elements repeat automatically across printed pages.
 */
export function StatementRenderer({ statement: st, snapshot }: Props) {
  const { styleConfig: style, contentConfig: content, layoutConfig: layout, companySnapshot: co } = snapshot;
  const rtl = content.direction === 'rtl';
  const money = (n: number): string => formatCurrency(n, st.currency);
  const opp = rtl ? 'left' : 'right';
  const isCredit = st.closingBalance < -0.005;

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
      {/* Header */}
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
          {content.showCompanyAddress && co.address && <p className="mt-1 max-w-[280px] text-xs" style={{ color: style.secondaryColor }}>{co.address}</p>}
          <p className="mt-1 text-xs" style={{ color: style.secondaryColor }}>{[co.phone, co.email, co.website].filter(Boolean).join(' · ')}</p>
          {co.taxNumber && <p className="text-xs" style={{ color: style.secondaryColor }}>Tax No.: {co.taxNumber}</p>}
        </div>
        <div style={{ textAlign: opp }}>
          <h1 className="text-2xl font-black uppercase tracking-wide" style={{ color: style.primaryColor }}>{content.title || 'Statement of Account'}</h1>
          <table className="mt-2 text-xs" style={{ marginInlineStart: rtl ? 0 : 'auto' }}>
            <tbody>
              <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>Statement date</td><td>{st.asOfDate}</td></tr>
              <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>Period</td><td>{st.periodStart} → {st.periodEnd}</td></tr>
              <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>Currency</td><td>{st.currency}</td></tr>
            </tbody>
          </table>
        </div>
      </header>

      {/* Customer + summary */}
      <section className="mt-6 flex flex-wrap items-start justify-between gap-6">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: style.secondaryColor }}>Statement for</p>
          <p className="text-sm font-semibold">{st.customerName}{st.customerCode ? ` (${st.customerCode})` : ''}</p>
          {st.billingAddress && <p className="text-xs" style={{ color: style.secondaryColor }}>{st.billingAddress}</p>}
          {st.taxNumber && <p className="text-xs" style={{ color: style.secondaryColor }}>Tax No.: {st.taxNumber}</p>}
        </div>
        <div className="rounded-md px-3 py-2 text-xs" style={{ border: `1px solid ${style.borderColor}`, minWidth: 240 }}>
          <SumRow label="Opening balance" value={money(st.openingBalance)} color={style.secondaryColor} />
          <SumRow label="Invoices" value={money(st.periodDebits)} color={style.secondaryColor} />
          <SumRow label="Credits & receipts" value={`(${money(st.periodCredits)})`} color={style.secondaryColor} />
          <div className="mt-1 border-t pt-1" style={{ borderColor: style.borderColor }}>
            <SumRow label={isCredit ? 'Closing balance (credit)' : 'Closing balance'} value={money(st.closingBalance)} strong color={style.primaryColor} />
          </div>
        </div>
      </section>

      {/* Transaction table */}
      <section className="mt-6">
        <table className="w-full border-collapse text-[11px]" style={{ direction: content.direction }}>
          <thead>
            <tr style={{ backgroundColor: style.primaryColor, color: '#fff' }}>
              <th className="px-1.5 py-2 text-left font-semibold">Date</th>
              <th className="px-1.5 py-2 text-left font-semibold">Document</th>
              <th className="px-1.5 py-2 text-left font-semibold">Description</th>
              <th className="px-1.5 py-2 text-left font-semibold">Due</th>
              <th className="px-1.5 py-2 text-right font-semibold">Debit</th>
              <th className="px-1.5 py-2 text-right font-semibold">Credit</th>
              <th className="px-1.5 py-2 text-right font-semibold">Balance</th>
            </tr>
          </thead>
          <tbody>
            {st.lines.map((l) => (
              <tr key={l.id} style={{ borderBottom: `1px solid ${style.borderColor}55` }}>
                <td className="px-1.5 py-1.5">{l.date}</td>
                <td className="px-1.5 py-1.5 font-mono">{l.documentNumber ?? STATEMENT_LINE_TYPE_LABELS[l.type]}</td>
                <td className="px-1.5 py-1.5">{l.description}</td>
                <td className="px-1.5 py-1.5">{l.dueDate ?? ''}</td>
                <td className="px-1.5 py-1.5 text-right font-mono">{l.debit ? money(l.debit) : ''}</td>
                <td className="px-1.5 py-1.5 text-right font-mono">{l.credit ? money(l.credit) : ''}</td>
                <td className="px-1.5 py-1.5 text-right font-mono font-semibold">{money(l.runningBalance)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: `2px solid ${style.primaryColor}` }}>
              <td colSpan={6} className="px-1.5 py-2 text-right font-bold" style={{ color: style.primaryColor }}>Closing balance</td>
              <td className="px-1.5 py-2 text-right font-mono font-bold" style={{ color: style.primaryColor }}>{money(st.closingBalance)}</td>
            </tr>
          </tfoot>
        </table>
      </section>

      {/* Aging */}
      {st.aging.total > 0 && (
        <section className="mt-6">
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wide" style={{ color: style.secondaryColor }}>Aging (as of {st.aging.asOfDate})</p>
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr style={{ backgroundColor: `${style.primaryColor}12` }}>
                {st.aging.buckets.map((b) => <th key={b.id} className="px-1.5 py-1.5 text-right font-semibold">{b.label}</th>)}
                <th className="px-1.5 py-1.5 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                {st.aging.buckets.map((b) => <td key={b.id} className="px-1.5 py-1.5 text-right font-mono">{money(b.amount)}</td>)}
                <td className="px-1.5 py-1.5 text-right font-mono font-semibold">{money(st.aging.total)}</td>
              </tr>
            </tbody>
          </table>
        </section>
      )}

      {/* Outstanding invoices */}
      {st.outstandingInvoices.length > 0 && (
        <section className="mt-6">
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wide" style={{ color: style.secondaryColor }}>Outstanding invoices</p>
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr style={{ backgroundColor: `${style.primaryColor}12` }}>
                <th className="px-1.5 py-1.5 text-left font-semibold">Invoice</th>
                <th className="px-1.5 py-1.5 text-left font-semibold">Due</th>
                <th className="px-1.5 py-1.5 text-right font-semibold">Original</th>
                <th className="px-1.5 py-1.5 text-right font-semibold">Outstanding</th>
                <th className="px-1.5 py-1.5 text-right font-semibold">Days</th>
              </tr>
            </thead>
            <tbody>
              {st.outstandingInvoices.map((o) => (
                <tr key={o.invoiceId} style={{ borderBottom: `1px solid ${style.borderColor}55` }}>
                  <td className="px-1.5 py-1.5 font-mono">{o.invoiceNumber}</td>
                  <td className="px-1.5 py-1.5">{o.dueDate}</td>
                  <td className="px-1.5 py-1.5 text-right font-mono">{money(o.originalTotal)}</td>
                  <td className="px-1.5 py-1.5 text-right font-mono font-semibold">{money(o.outstandingBalance)}</td>
                  <td className="px-1.5 py-1.5 text-right">{o.daysOverdue > 0 ? o.daysOverdue : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {(st.unappliedReceipts > 0 || st.customerAdvances > 0) && (
        <p className="mt-4 text-xs" style={{ color: style.secondaryColor }}>
          Available customer credit: {money(st.availableCredit)} (unapplied receipts {money(st.unappliedReceipts)}, advances {money(st.customerAdvances)}).
        </p>
      )}

      {content.showBankDetails && co.bankDetails && (
        <section className="mt-6 text-xs" style={{ color: style.secondaryColor }}>
          <p className="font-semibold text-slate-700">Payment instructions</p>
          <p className="whitespace-pre-line">{co.bankDetails}</p>
        </section>
      )}

      {content.footerText && <footer className="mt-8 border-t pt-3 text-center text-[11px]" style={{ borderColor: style.borderColor, color: style.secondaryColor }}>{content.footerText}</footer>}
    </div>
  );
}

function SumRow({ label, value, color, strong }: { label: string; value: string; color?: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <span style={{ color: strong ? undefined : color }} className={strong ? 'font-semibold' : ''}>{label}</span>
      <span className={`font-mono ${strong ? 'font-bold' : ''}`} style={{ color: strong ? color : undefined }}>{value}</span>
    </div>
  );
}

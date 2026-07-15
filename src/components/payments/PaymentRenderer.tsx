import type { Payment, PaymentTemplateSnapshot } from '@/types/payment';
import { resolveInvoiceLogo } from '@/lib/invoiceLogo';
import { formatCurrency } from '@/lib/money';
import { amountToWords } from '@/lib/amountToWords';
import { PAYMENT_METHOD_LABELS } from '@/lib/paymentLabels';
import { LogoImage } from '@/components/invoices/LogoImage';

interface Props {
  payment: Payment;
  snapshot: PaymentTemplateSnapshot;
  /** Directory account-name resolver, supplied by the caller. */
  accountName?: (id: string | undefined) => string;
}

/**
 * Renders a Payment Voucher from a frozen template snapshot (preview, print,
 * PDF). Reuses the invoice template's branding — logo, colours, fonts, company
 * identity — and presents the payment-specific content: payee, amount, amount in
 * words, method, cash/bank account, cheque details, bill allocations, bank fee,
 * withholding, discount and signatures. Posted payments render from their own
 * snapshot so later edits never change them.
 */
export function PaymentRenderer({ payment, snapshot, accountName }: Props) {
  const { styleConfig: style, contentConfig: content, layoutConfig: layout, companySnapshot: co, customerSnapshot: payee } = snapshot;
  const rtl = content.direction === 'rtl';
  const label = (key: string, fallback: string): string => content.customLabels[key] || fallback;
  const money = (n: number): string => formatCurrency(n, payment.currency);
  const opp = rtl ? 'left' : 'right';
  const payeeName = payment.payeeName || payee.name;
  const bankLine = accountName?.(payment.bankAccountId || payment.cashAccountId);
  const liveAllocations = payment.allocations.filter((a) => !a.reversed);

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
      {(payment.status === 'reversed' || payment.status === 'void') && (
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rotate-[-24deg] select-none text-[110px] font-black uppercase tracking-widest text-red-500/10">{payment.status}</span>
        </div>
      )}

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
          {co.tradingName && <p className="text-xs" style={{ color: style.secondaryColor }}>{co.tradingName}</p>}
          {content.showCompanyAddress && co.address && <p className="mt-1 max-w-[280px] text-xs" style={{ color: style.secondaryColor }}>{co.address}</p>}
          <p className="mt-1 text-xs" style={{ color: style.secondaryColor }}>{[co.phone, co.email, co.website].filter(Boolean).join(' · ')}</p>
          {content.showTaxDetails && co.taxNumber && <p className="text-xs" style={{ color: style.secondaryColor }}>{label('taxNumber', 'Tax No.')}: {co.taxNumber}</p>}
        </div>
        <div style={{ textAlign: opp }}>
          <h1 className="text-2xl font-black uppercase tracking-wide" style={{ color: style.primaryColor }}>{content.title || 'Payment Voucher'}</h1>
          <table className="mt-2 text-xs" style={{ marginInlineStart: rtl ? 0 : 'auto' }}>
            <tbody>
              <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>{label('paymentNumber', 'Voucher No.')}</td><td className="font-mono font-semibold">{payment.paymentNumber}</td></tr>
              <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>{label('paymentDate', 'Date')}</td><td>{payment.paymentDate}</td></tr>
              <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>{label('method', 'Method')}</td><td>{PAYMENT_METHOD_LABELS[payment.method]}</td></tr>
              <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>{label('currency', 'Currency')}</td><td>{payment.currency}</td></tr>
            </tbody>
          </table>
        </div>
      </header>

      {/* Paid to + amount */}
      <section className="mt-6 flex flex-wrap items-start justify-between gap-6">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: style.secondaryColor }}>{label('paidTo', 'Paid to')}</p>
          <p className="text-sm font-semibold">{payeeName}</p>
          {payee.billingAddress && <p className="text-xs" style={{ color: style.secondaryColor }}>{payee.billingAddress}</p>}
          {bankLine && <p className="mt-1 text-xs" style={{ color: style.secondaryColor }}>{label('paidFrom', 'Paid from')}: {bankLine}</p>}
          {payment.method === 'cheque' && payment.chequeNumber && <p className="text-xs" style={{ color: style.secondaryColor }}>{label('cheque', 'Cheque')}: {payment.chequeNumber}{payment.chequeBankName ? ` · ${payment.chequeBankName}` : ''}</p>}
          {(payment.transactionReference || payment.transferReference) && <p className="text-xs" style={{ color: style.secondaryColor }}>{label('reference', 'Reference')}: {payment.transactionReference || payment.transferReference}</p>}
        </div>
        <div className="rounded-lg px-4 py-3 text-right" style={{ backgroundColor: `${style.primaryColor}0f`, minWidth: 200 }}>
          <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: style.secondaryColor }}>{label('amountPaid', 'Amount paid')}</p>
          <p className="font-mono text-xl font-black" style={{ color: style.primaryColor }}>{money(payment.netCashAmount)}</p>
        </div>
      </section>

      {/* Amount in words */}
      <section className="mt-4 rounded-md px-3 py-2 text-sm" style={{ border: `1px solid ${style.borderColor}` }}>
        <span className="text-xs font-semibold" style={{ color: style.secondaryColor }}>{label('amountInWords', 'Amount in words')}: </span>
        <span className="italic">{amountToWords(payment.netCashAmount, payment.currency)}</span>
      </section>

      {/* Allocations */}
      {liveAllocations.length > 0 && (
        <section className="mt-6">
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wide" style={{ color: style.secondaryColor }}>{label('allocations', 'Applied to bills')}</p>
          <table className="w-full border-collapse text-xs" style={{ direction: content.direction }}>
            <thead>
              <tr style={{ backgroundColor: style.primaryColor, color: '#fff' }}>
                <th className="px-2 py-2 text-left font-semibold">{label('bill', 'Bill')}</th>
                <th className="px-2 py-2 text-left font-semibold">{label('date', 'Date')}</th>
                <th className="px-2 py-2 text-right font-semibold">{label('allocated', 'Allocated')}</th>
              </tr>
            </thead>
            <tbody>
              {liveAllocations.map((a) => (
                <tr key={a.id} style={{ borderBottom: `1px solid ${style.borderColor}55` }}>
                  <td className="px-2 py-1.5 font-mono">{a.billNumber ?? a.allocationType}</td>
                  <td className="px-2 py-1.5">{a.allocationDate}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{money(a.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Totals */}
      <section className="mt-4 flex" style={{ justifyContent: rtl ? 'flex-start' : 'flex-end' }}>
        <table className="text-sm" style={{ minWidth: 260 }}>
          <tbody>
            <tr><td className="py-1 pr-6" style={{ color: style.secondaryColor }}>{label('grossAmount', 'Gross amount')}</td><td className="py-1 text-right font-mono">{money(payment.grossAmount)}</td></tr>
            {payment.bankFeeAmount > 0 && <tr><td className="py-1 pr-6" style={{ color: style.secondaryColor }}>{label('bankFee', 'Bank fee')}</td><td className="py-1 text-right font-mono">{money(payment.bankFeeAmount)}</td></tr>}
            {payment.withholdingTaxAmount > 0 && <tr><td className="py-1 pr-6" style={{ color: style.secondaryColor }}>{label('withholding', 'Withholding tax')}</td><td className="py-1 text-right font-mono">({money(payment.withholdingTaxAmount)})</td></tr>}
            {payment.discountTakenAmount > 0 && <tr><td className="py-1 pr-6" style={{ color: style.secondaryColor }}>{label('discount', 'Discount taken')}</td><td className="py-1 text-right font-mono">({money(payment.discountTakenAmount)})</td></tr>}
            <tr><td className="py-1 pr-6 font-semibold">{label('netCash', 'Net cash paid')}</td><td className="py-1 text-right font-mono font-semibold">{money(payment.netCashAmount)}</td></tr>
            {payment.unappliedAmount > 0.005 && <tr><td className="py-1 pr-6" style={{ color: style.secondaryColor }}>{label('unapplied', 'Unapplied (advance)')}</td><td className="py-1 text-right font-mono">{money(payment.unappliedAmount)}</td></tr>}
          </tbody>
        </table>
      </section>

      {payment.narration && (
        <section className="mt-6 text-xs" style={{ color: style.secondaryColor }}>
          <p><span className="font-semibold text-slate-700">{label('narration', 'Narration')}: </span>{payment.narration}</p>
        </section>
      )}

      {content.showSignature && (
        <section className="mt-10 flex justify-between gap-8 text-center text-xs" style={{ color: style.secondaryColor }}>
          <div><div className="mb-1 h-10 w-40 border-b" style={{ borderColor: style.borderColor }} />{label('preparedBy', 'Prepared by')}</div>
          <div><div className="mb-1 h-10 w-40 border-b" style={{ borderColor: style.borderColor }} />{label('approvedBy', 'Approved by')}{payment.approvedBy ? ` · ${payment.approvedBy}` : ''}</div>
          <div><div className="mb-1 h-10 w-40 border-b" style={{ borderColor: style.borderColor }} />{label('signature', 'Authorized signature')}</div>
        </section>
      )}

      {content.footerText && <footer className="mt-8 border-t pt-3 text-center text-[11px]" style={{ borderColor: style.borderColor, color: style.secondaryColor }}>{content.footerText} · {label('page', 'Page')} 1</footer>}
    </div>
  );
}

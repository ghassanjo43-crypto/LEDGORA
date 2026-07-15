import type { Receipt, ReceiptTemplateSnapshot } from '@/types/receipt';
import { resolveInvoiceLogo } from '@/lib/invoiceLogo';
import { formatCurrency } from '@/lib/money';
import { amountToWords } from '@/lib/amountToWords';
import { RECEIPT_METHOD_LABELS } from '@/lib/receiptLabels';
import { LogoImage } from '@/components/invoices/LogoImage';

interface Props {
  receipt: Receipt;
  snapshot: ReceiptTemplateSnapshot;
  /** Company/customer directory account names, resolved by the caller. */
  accountName?: (id: string | undefined) => string;
}

/**
 * Renders an official receipt from a frozen template snapshot (preview, print,
 * PDF). Reuses the invoice template's branding — logo, colours, fonts, company &
 * customer identity — and presents the receipt-specific content: amount received,
 * amount in words, method, cash/bank account, invoice allocations and unapplied
 * amount. Posted receipts always render from their own snapshot.
 */
export function ReceiptRenderer({ receipt, snapshot, accountName }: Props) {
  const { styleConfig: style, contentConfig: content, layoutConfig: layout, companySnapshot: co, customerSnapshot: cust } = snapshot;
  const rtl = content.direction === 'rtl';
  const label = (key: string, fallback: string): string => content.customLabels[key] || fallback;
  const money = (n: number): string => formatCurrency(n, receipt.currency);
  const opp = rtl ? 'left' : 'right';
  const payer = receipt.customerId ? cust.name : receipt.payerName || cust.name;
  const bankLine = accountName?.(receipt.bankAccountId || receipt.cashAccountId || receipt.depositAccountId);

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
      {(receipt.status === 'reversed' || receipt.status === 'void') && (
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rotate-[-24deg] select-none text-[110px] font-black uppercase tracking-widest text-red-500/10">{receipt.status}</span>
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
          <h1 className="text-2xl font-black uppercase tracking-wide" style={{ color: style.primaryColor }}>{content.title || 'Official Receipt'}</h1>
          <table className="mt-2 text-xs" style={{ marginInlineStart: rtl ? 0 : 'auto' }}>
            <tbody>
              <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>{label('receiptNumber', 'Receipt No.')}</td><td className="font-mono font-semibold">{receipt.receiptNumber}</td></tr>
              <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>{label('receiptDate', 'Date')}</td><td>{receipt.receiptDate}</td></tr>
              <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>{label('method', 'Method')}</td><td>{RECEIPT_METHOD_LABELS[receipt.method]}</td></tr>
              <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>{label('currency', 'Currency')}</td><td>{receipt.currency}</td></tr>
            </tbody>
          </table>
        </div>
      </header>

      {/* Received from + amount */}
      <section className="mt-6 flex flex-wrap items-start justify-between gap-6">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: style.secondaryColor }}>{label('receivedFrom', 'Received from')}</p>
          <p className="text-sm font-semibold">{payer}</p>
          {cust.billingAddress && receipt.customerId && <p className="text-xs" style={{ color: style.secondaryColor }}>{cust.billingAddress}</p>}
          {bankLine && <p className="mt-1 text-xs" style={{ color: style.secondaryColor }}>{label('depositedTo', 'Deposited to')}: {bankLine}</p>}
          {receipt.method === 'cheque' && receipt.chequeNumber && <p className="text-xs" style={{ color: style.secondaryColor }}>{label('cheque', 'Cheque')}: {receipt.chequeNumber}{receipt.chequeBankName ? ` · ${receipt.chequeBankName}` : ''}</p>}
          {receipt.transactionReference && <p className="text-xs" style={{ color: style.secondaryColor }}>{label('reference', 'Reference')}: {receipt.transactionReference}</p>}
        </div>
        <div className="rounded-lg px-4 py-3 text-right" style={{ backgroundColor: `${style.primaryColor}0f`, minWidth: 200 }}>
          <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: style.secondaryColor }}>{label('amountReceived', 'Amount received')}</p>
          <p className="font-mono text-xl font-black" style={{ color: style.primaryColor }}>{money(receipt.amount)}</p>
        </div>
      </section>

      {/* Amount in words */}
      <section className="mt-4 rounded-md px-3 py-2 text-sm" style={{ border: `1px solid ${style.borderColor}` }}>
        <span className="text-xs font-semibold" style={{ color: style.secondaryColor }}>{label('amountInWords', 'Amount in words')}: </span>
        <span className="italic">{amountToWords(receipt.amount, receipt.currency)}</span>
      </section>

      {/* Allocations */}
      {receipt.allocations.filter((a) => !a.reversed).length > 0 && (
        <section className="mt-6">
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wide" style={{ color: style.secondaryColor }}>{label('allocations', 'Applied to invoices')}</p>
          <table className="w-full border-collapse text-xs" style={{ direction: content.direction }}>
            <thead>
              <tr style={{ backgroundColor: style.primaryColor, color: '#fff' }}>
                <th className="px-2 py-2 text-left font-semibold">{label('invoice', 'Invoice')}</th>
                <th className="px-2 py-2 text-left font-semibold">{label('date', 'Date')}</th>
                <th className="px-2 py-2 text-right font-semibold">{label('allocated', 'Allocated')}</th>
              </tr>
            </thead>
            <tbody>
              {receipt.allocations.filter((a) => !a.reversed).map((a) => (
                <tr key={a.id} style={{ borderBottom: `1px solid ${style.borderColor}55` }}>
                  <td className="px-2 py-1.5 font-mono">{a.invoiceNumber ?? a.allocationType}</td>
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
        <table className="text-sm" style={{ minWidth: 240 }}>
          <tbody>
            <tr><td className="py-1 pr-6" style={{ color: style.secondaryColor }}>{label('allocated', 'Allocated')}</td><td className="py-1 text-right font-mono">{money(receipt.allocationTotal)}</td></tr>
            <tr><td className="py-1 pr-6 font-semibold">{label('unapplied', 'Unapplied')}</td><td className="py-1 text-right font-mono font-semibold">{money(receipt.unappliedAmount)}</td></tr>
          </tbody>
        </table>
      </section>

      {(receipt.narration || receipt.notes) && (
        <section className="mt-6 text-xs" style={{ color: style.secondaryColor }}>
          {receipt.narration && <p><span className="font-semibold text-slate-700">{label('narration', 'Narration')}: </span>{receipt.narration}</p>}
          {receipt.notes && <p className="mt-1">{receipt.notes}</p>}
        </section>
      )}

      {content.showSignature && (
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

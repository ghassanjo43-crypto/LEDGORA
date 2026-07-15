import type { InvoiceTemplateSnapshot } from '@/types/invoice';
import type { Bill } from '@/types/bill';
import { calculateBillLine } from '@/lib/billCalculations';
import { resolveInvoiceLogo } from '@/lib/invoiceLogo';
import { formatCurrency } from '@/lib/money';
import { BILL_TYPE_LABELS, BILL_PAYMENT_METHOD_LABELS } from '@/lib/billLabels';
import { LogoImage } from '@/components/invoices/LogoImage';

interface Props {
  bill: Bill;
  snapshot: InvoiceTemplateSnapshot;
  supplierName: string;
  supplierAddress?: string;
  supplierTaxNumber?: string;
}

/**
 * Internal supplier-bill document (preview / print). Reuses the invoice
 * template's branding. This is an INTERNAL record of what we owe — it does not
 * recreate the supplier's original invoice (that is stored as an attachment).
 */
export function BillRenderer({ bill, snapshot, supplierName, supplierAddress, supplierTaxNumber }: Props) {
  const { styleConfig: style, contentConfig: content, layoutConfig: layout, companySnapshot: co } = snapshot;
  const rtl = content.direction === 'rtl';
  const money = (n: number): string => formatCurrency(n, bill.currency);
  const opp = rtl ? 'left' : 'right';
  const align = rtl ? 'right' : 'left';
  const netPayable = Math.round((bill.grandTotal - bill.withholdingTaxTotal) * 100) / 100;

  return (
    <div dir={content.direction} lang={content.language} className="invoice-page relative mx-auto bg-white text-slate-900"
      style={{ width: layout.pageSize === 'Letter' ? '8.5in' : '210mm', minHeight: layout.pageSize === 'Letter' ? '11in' : '297mm', padding: `${layout.margins.top}px ${layout.margins.right}px ${layout.margins.bottom}px ${layout.margins.left}px`, fontFamily: style.fontFamily, fontSize: style.baseFontSize, color: style.textColor, backgroundColor: style.backgroundColor }}>
      {(bill.status === 'reversed' || bill.status === 'void') && (
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center"><span className="rotate-[-24deg] select-none text-[110px] font-black uppercase tracking-widest text-red-500/10">{bill.status}</span></div>
      )}
      <header className="flex items-start justify-between gap-6" style={{ flexDirection: layout.headerLayout === 'logo-right' ? 'row-reverse' : 'row' }}>
        <div>
          {(() => { const logo = resolveInvoiceLogo(snapshot); if (!logo.visible || !logo.url) return null; const posAlign = logo.position === 'right' ? 'flex-end' : logo.position === 'center' ? 'center' : 'flex-start'; return (<div className="mb-2 flex" style={{ justifyContent: posAlign }}><LogoImage url={logo.url} alt={`${co.legalName} logo`} style={{ maxWidth: logo.width, maxHeight: logo.maxHeight, width: 'auto', height: 'auto', objectFit: logo.fit }} /></div>); })()}
          <p className="text-base font-bold" style={{ color: style.primaryColor }}>{co.legalName}</p>
          {content.showCompanyAddress && co.address && <p className="mt-1 max-w-[280px] text-xs" style={{ color: style.secondaryColor }}>{co.address}</p>}
          {co.taxNumber && <p className="text-xs" style={{ color: style.secondaryColor }}>Tax No.: {co.taxNumber}</p>}
        </div>
        <div style={{ textAlign: opp }}>
          <h1 className="text-2xl font-black uppercase tracking-wide" style={{ color: style.primaryColor }}>{content.title || 'Supplier Bill'}</h1>
          <table className="mt-2 text-xs" style={{ marginInlineStart: rtl ? 0 : 'auto' }}><tbody>
            <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>Bill No.</td><td className="font-mono font-semibold">{bill.billNumber}</td></tr>
            <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>Supplier inv.</td><td className="font-mono">{bill.supplierInvoiceNumber || '—'}</td></tr>
            <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>Bill date</td><td>{bill.billDate}</td></tr>
            <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>Due date</td><td>{bill.dueDate}</td></tr>
            <tr><td className="pr-3 font-medium" style={{ color: style.secondaryColor }}>Currency</td><td>{bill.currency}</td></tr>
          </tbody></table>
        </div>
      </header>

      <section className="mt-6 flex flex-wrap items-start justify-between gap-6">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: style.secondaryColor }}>Bill from</p>
          <p className="text-sm font-semibold">{supplierName}</p>
          {supplierAddress && <p className="text-xs" style={{ color: style.secondaryColor }}>{supplierAddress}</p>}
          {supplierTaxNumber && <p className="text-xs" style={{ color: style.secondaryColor }}>Tax No.: {supplierTaxNumber}</p>}
        </div>
        <div className="text-xs" style={{ color: style.secondaryColor }}>
          <p>Type: {BILL_TYPE_LABELS[bill.billType]}</p>
          {bill.purchaseOrderId && <p>PO: {bill.purchaseOrderId}</p>}
          <p>Status: {bill.status}{bill.journalEntryId ? ' · posted' : ''}</p>
        </div>
      </section>

      <section className="mt-6">
        <table className="w-full border-collapse text-xs" style={{ direction: content.direction }}>
          <thead><tr style={{ backgroundColor: style.primaryColor, color: '#fff' }}>
            <th className="px-2 py-2 font-semibold" style={{ textAlign: align }}>Description</th>
            <th className="px-2 py-2 font-semibold" style={{ textAlign: 'right' }}>Qty</th>
            <th className="px-2 py-2 font-semibold" style={{ textAlign: 'right' }}>Unit price</th>
            <th className="px-2 py-2 font-semibold" style={{ textAlign: 'right' }}>Tax</th>
            <th className="px-2 py-2 font-semibold" style={{ textAlign: 'right' }}>Line total</th>
          </tr></thead>
          <tbody>
            {bill.lines.map((line) => { const c = calculateBillLine(line); return (
              <tr key={line.id} style={{ borderBottom: `1px solid ${style.borderColor}55` }}>
                <td className="px-2 py-1.5" style={{ textAlign: align }}>{line.description}</td>
                <td className="px-2 py-1.5" style={{ textAlign: 'right' }}>{line.quantity}</td>
                <td className="px-2 py-1.5 font-mono" style={{ textAlign: 'right' }}>{money(line.unitPrice)}</td>
                <td className="px-2 py-1.5" style={{ textAlign: 'right' }}>{line.taxRate}%</td>
                <td className="px-2 py-1.5 font-mono" style={{ textAlign: 'right' }}>{money(c.lineTotal)}</td>
              </tr>
            ); })}
          </tbody>
        </table>
      </section>

      <section className="mt-4 flex" style={{ justifyContent: rtl ? 'flex-start' : 'flex-end' }}>
        <table className="text-sm" style={{ minWidth: 280 }}><tbody>
          <TotalRow label="Subtotal" value={money(bill.subtotal)} color={style.secondaryColor} />
          {bill.discountTotal > 0 && <TotalRow label="Discount" value={`- ${money(bill.discountTotal)}`} color={style.secondaryColor} />}
          {bill.taxTotal > 0 && <TotalRow label="Input tax" value={money(bill.taxTotal)} color={style.secondaryColor} />}
          <tr style={{ borderTop: `2px solid ${style.primaryColor}` }}><td className="py-1.5 pr-6 font-bold" style={{ color: style.primaryColor }}>Bill total</td><td className="py-1.5 text-right font-mono font-bold" style={{ color: style.primaryColor }}>{money(bill.grandTotal)}</td></tr>
          {bill.withholdingTaxTotal > 0 && <TotalRow label="Withholding tax" value={`- ${money(bill.withholdingTaxTotal)}`} color={style.secondaryColor} />}
          {bill.supplierCreditsApplied > 0 && <TotalRow label="Supplier credits" value={`- ${money(bill.supplierCreditsApplied)}`} color={style.secondaryColor} />}
          {bill.amountPaid > 0 && <TotalRow label="Amount paid" value={`- ${money(bill.amountPaid)}`} color={style.secondaryColor} />}
          <tr><td className="py-1 pr-6 font-semibold">Balance due</td><td className="py-1 text-right font-mono font-semibold">{money(bill.balanceDue)}</td></tr>
          {bill.withholdingTaxTotal > 0 && <tr><td className="py-1 pr-6 text-[10px]" style={{ color: style.secondaryColor }}>Net payable</td><td className="py-1 text-right font-mono text-[10px]" style={{ color: style.secondaryColor }}>{money(netPayable)}</td></tr>}
        </tbody></table>
      </section>

      {bill.payments.length > 0 && (
        <section className="mt-6">
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wide" style={{ color: style.secondaryColor }}>Payments</p>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr style={{ backgroundColor: `${style.primaryColor}0f` }}>
                <th className="px-2 py-1.5 text-left font-semibold">Date</th>
                <th className="px-2 py-1.5 text-left font-semibold">Method</th>
                <th className="px-2 py-1.5 text-left font-semibold">Reference</th>
                <th className="px-2 py-1.5 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {bill.payments.map((p) => (
                <tr key={p.id} style={{ borderBottom: `1px solid ${style.borderColor}55` }}>
                  <td className="px-2 py-1.5">{p.date}</td>
                  <td className="px-2 py-1.5">{BILL_PAYMENT_METHOD_LABELS[p.method]}</td>
                  <td className="px-2 py-1.5 font-mono">{p.reference || '—'}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{money(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {content.footerText && <footer className="mt-8 border-t pt-3 text-center text-[11px]" style={{ borderColor: style.borderColor, color: style.secondaryColor }}>{content.footerText}</footer>}
    </div>
  );
}

function TotalRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (<tr><td className="py-1 pr-6" style={{ color }}>{label}</td><td className="py-1 text-right font-mono" style={{ color }}>{value}</td></tr>);
}

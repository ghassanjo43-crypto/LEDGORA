import { useMemo, useState } from 'react';
import { Printer, X } from 'lucide-react';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useCreditNoteStore } from '@/store/creditNoteStore';
import { useReceiptStore } from '@/store/receiptStore';
import { buildInvoiceSettlementSummary, creditNotesForInvoice, creditNoteAppliedToInvoice } from '@/lib/invoiceSettlement';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { PrintDocument } from '@/components/ui/PrintDocument';
import { InvoiceRenderer } from './InvoiceRenderer';

type CopyMode = 'original' | 'current';

/**
 * The single invoice preview/print surface, used by both the Invoices list and
 * the invoice details drawer so settlement is never computed in one component
 * tree while the preview renders in another.
 *
 * - The document BODY always uses the invoice's own (issued) snapshot.
 * - The "Current copy" toggle derives the settlement panel from LIVE store data
 *   (credit-note applications + receipt allocations), never a stale snapshot.
 */
export function InvoicePreviewModal({ invoiceId, onClose, zClass = 'z-50' }: { invoiceId: string; onClose: () => void; zClass?: string }) {
  const invoice = useInvoiceStore((s) => s.invoices.find((i) => i.id === invoiceId));
  const previewSnapshot = useInvoiceStore((s) => s.previewSnapshot);
  const creditNotes = useCreditNoteStore((s) => s.creditNotes); // live subscription
  const receipts = useReceiptStore((s) => s.receipts); // live subscription

  const [copyMode, setCopyMode] = useState<CopyMode>('original');

  const settlement = useMemo(
    () => (invoice ? buildInvoiceSettlementSummary(invoice, creditNotes, receipts) : null),
    [invoice, creditNotes, receipts],
  );
  const settlementCreditNotes = useMemo(
    () => (invoice ? creditNotesForInvoice(invoice.id, creditNotes).map((c) => ({ number: c.creditNoteNumber, applied: creditNoteAppliedToInvoice(c, invoice.id) })) : []),
    [invoice, creditNotes],
  );

  const snapshot = invoice ? previewSnapshot(invoiceId) : null;
  if (!invoice || !snapshot) return null;

  const isCurrent = copyMode === 'current';
  const renderProps = {
    invoice,
    snapshot,
    settlement: isCurrent ? settlement : undefined,
    settlementAsOf: isCurrent ? new Date().toISOString() : undefined,
    settlementCreditNotes: isCurrent ? settlementCreditNotes : undefined,
  };

  return (
    <>
      <div className={cn('fixed inset-0 flex flex-col bg-slate-900/50 backdrop-blur-sm', zClass)}>
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-3 text-sm font-medium">
            <span>{snapshot.templateName} — v{snapshot.versionNumber} · <span className="text-slate-500">{invoice.status}</span></span>
          </div>
          <div className="flex items-center gap-2">
            {/* Copy-mode toggle. The original issued document is never rewritten. */}
            <div className="inline-flex overflow-hidden rounded-lg border border-slate-200 text-xs dark:border-slate-700" role="group" aria-label="Copy mode">
              <button
                type="button"
                aria-pressed={!isCurrent}
                onClick={() => setCopyMode('original')}
                className={cn('px-2.5 py-1', !isCurrent ? 'bg-brand-50 font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-200' : 'text-slate-500')}
              >
                Original copy
              </button>
              <button
                type="button"
                aria-pressed={isCurrent}
                onClick={() => setCopyMode('current')}
                className={cn('px-2.5 py-1', isCurrent ? 'bg-brand-50 font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-200' : 'text-slate-500')}
              >
                Current copy
              </button>
            </div>
            <Button size="sm" variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print / PDF</Button>
            <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close"><X className="h-5 w-5" /></button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-6">
          <div className="mx-auto shadow-xl"><InvoiceRenderer {...renderProps} /></div>
        </div>
      </div>
      {/* Print-only copy at <body> level receives the SAME copy mode + settlement. */}
      <PrintDocument><InvoiceRenderer {...renderProps} /></PrintDocument>
    </>
  );
}

/**
 * The "this will not be saved" notice for Free Preview.
 *
 * Same approach as `FreeDemoNotices`: rather than coupling forty accounting
 * stores to the UI, this watches the COUNT of business records and reacts when
 * one appears. Nothing is ever blocked — a preview customer completes real
 * workflows end to end; they are simply told, once per save, that the record
 * lives only for this session.
 */
import { useEffect, useRef } from 'react';
import { useToast } from '@/components/ui/Toast';
import { FREE_PREVIEW_COPY } from '@/lib/freePreview';
import { useIsFreePreview } from '@/store/freePreviewAccess';
import { useJournalStore } from '@/store/journalStore';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useBillStore } from '@/store/billStore';
import { useReceiptStore } from '@/store/receiptStore';
import { usePaymentStore } from '@/store/paymentStore';

function usePreviewRecordCount(): number {
  const journals = useJournalStore((s) => s.entries.length);
  const invoices = useInvoiceStore((s) => s.invoices.length);
  const bills = useBillStore((s) => s.bills.length);
  const receipts = useReceiptStore((s) => s.receipts.length);
  const payments = usePaymentStore((s) => s.payments.length);
  return journals + invoices + bills + receipts + payments;
}

export function FreePreviewNotices() {
  const isPreview = useIsFreePreview();
  const { notify } = useToast();
  const count = usePreviewRecordCount();
  const previous = useRef<number | null>(null);

  useEffect(() => {
    if (!isPreview) {
      previous.current = null;
      return;
    }
    // First observation establishes the baseline — no toast on mount.
    if (previous.current === null) {
      previous.current = count;
      return;
    }
    if (count <= previous.current) {
      previous.current = count;
      return;
    }
    previous.current = count;
    notify(FREE_PREVIEW_COPY.saveNotice, 'info');
  }, [count, isPreview, notify]);

  return null;
}

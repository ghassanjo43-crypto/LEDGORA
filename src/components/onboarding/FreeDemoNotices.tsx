/**
 * Restrained upgrade prompts for the Free Demo.
 *
 * Rather than coupling every accounting store to the UI, this component watches
 * the *count* of business records in the demo workspace and reacts:
 *   · every save  → "Saved temporarily for this demo session…" (toast)
 *   · milestones  → one upgrade prompt, then silence until the next milestone
 *
 * Nothing here blocks a save: a demo visitor completes realistic workflows and
 * the records live in the in-memory workspace for the session.
 */
import { useEffect, useRef } from 'react';
import { useToast, useOptionalToast } from '@/components/ui/Toast';
import { FREE_DEMO_COPY } from '@/config/freeDemo';
import { useIsFreeDemo } from '@/hooks/useSession';
import { useAccountSessionStore } from '@/store/accountSessionStore';
import { useJournalStore } from '@/store/journalStore';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useBillStore } from '@/store/billStore';
import { useReceiptStore } from '@/store/receiptStore';
import { usePaymentStore } from '@/store/paymentStore';

/** Record counts after which a single upgrade prompt is shown. */
const UPGRADE_MILESTONES = [3, 10, 25];

function useDemoRecordCount(): number {
  const journals = useJournalStore((s) => s.entries.length);
  const invoices = useInvoiceStore((s) => s.invoices.length);
  const bills = useBillStore((s) => s.bills.length);
  const receipts = useReceiptStore((s) => s.receipts.length);
  const payments = usePaymentStore((s) => s.payments.length);
  return journals + invoices + bills + receipts + payments;
}

export function FreeDemoNotices() {
  const isDemo = useIsFreeDemo();
  const { notify } = useToast();
  const count = useDemoRecordCount();
  const noteDemoRecords = useAccountSessionStore((s) => s.noteDemoRecords);
  const previous = useRef<number | null>(null);
  const prompted = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (!isDemo) {
      previous.current = null;
      prompted.current.clear();
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
    noteDemoRecords(count);
    notify(FREE_DEMO_COPY.saveNotice, 'info');

    const milestone = UPGRADE_MILESTONES.filter((m) => count >= m).pop();
    if (milestone && !prompted.current.has(milestone)) {
      prompted.current.add(milestone);
      notify(
        `You have created ${count} records in this temporary workspace. Choose a package to keep them.`,
        'warning',
      );
    }
  }, [count, isDemo, notify, noteDemoRecords]);

  return null;
}

/**
 * Guard for actions a demo workspace genuinely cannot perform (permanent
 * document upload, inviting a user, import/export that needs durable storage).
 * Returns `true` when the action was blocked and a prompt was shown.
 */
export function useDemoActionGuard(): (action: 'upload' | 'invite' | 'import-export') => boolean {
  const isDemo = useIsFreeDemo();
  const { notify } = useOptionalToast();

  const MESSAGES: Record<'upload' | 'invite' | 'import-export', string> = {
    upload: 'Permanent document uploads need a package. Files are not stored in the free demo.',
    invite: 'Inviting teammates needs a package — the free demo is a single-user session.',
    'import-export': 'Import and export need permanent storage. Choose a package to enable them.',
  };

  return (action) => {
    if (!isDemo) return false;
    notify(MESSAGES[action], 'warning');
    return true;
  };
}

/**
 * All-or-nothing across browser-resident stores.
 *
 * ══ The problem ══════════════════════════════════════════════════════════════
 *
 * An amendment touches five or six stores: the journal, the document, the
 * inventory subledger, the receipt or payment that settled it, and the audit
 * trail. Each store's `set` is atomic on its own; the SEQUENCE is not. A
 * failure halfway through would leave a posted reversal with no replacement —
 * exactly the "partial amendment must not remain" the rule forbids.
 *
 * There is no database here to open a transaction on. Ledgora's books live in
 * the browser (`lib/workspaceStorage`), so the strongest thing available is:
 *
 *   1. capture every affected store's state BEFORE anything is written;
 *   2. run the sequence, checking every step;
 *   3. on any failure, write the captured state back — to every store, in one
 *      pass — and report the failure.
 *
 * The captured state is a structural copy, not a reference, so a store mutating
 * its own array afterwards cannot corrupt the rollback copy.
 *
 * ══ The limits, stated plainly ═══════════════════════════════════════════════
 *
 *  · This is a ROLLBACK, not an atomic commit. If the tab is closed or the
 *    machine loses power between two `set` calls, the persisted state can be
 *    left mid-sequence and nothing runs the rollback on the next load. A real
 *    transaction requires the records to be server-side; until they are, the
 *    amendment audit event's `outcome` field is the thing that says whether an
 *    amendment actually completed.
 *  · Zustand's persist middleware writes asynchronously per store. The rollback
 *    restores every store's in-memory state synchronously and the writes follow,
 *    so a crash DURING the rollback has the same exposure as a crash during the
 *    amendment.
 *  · Nothing here defends against another tab writing the same workspace
 *    concurrently. The optimistic version check on the document is what
 *    catches that, and it is checked again immediately before the commit.
 */
import { useJournalStore } from '@/store/journalStore';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useBillStore } from '@/store/billStore';
import { useCreditNoteStore } from '@/store/creditNoteStore';
import { useReceiptStore } from '@/store/receiptStore';
import { usePaymentStore } from '@/store/paymentStore';
import { useInventoryStore } from '@/store/inventoryStore';
import { useInvoiceTemplateStore } from '@/store/invoiceTemplateStore';

function copy<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* Fall through: a value holding a function or a DOM node is not ours. */
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * A restorable picture of everything an amendment can touch.
 *
 * Numbering is captured alongside the documents deliberately: `takeInvoiceNumber`
 * advances a stored sequence as a side effect, so a rolled-back amendment that
 * did not restore it would silently burn a document number and leave a gap in a
 * sequence an auditor expects to be unbroken.
 */
export interface AmendmentSnapshot {
  restore: () => void;
}

export function captureSnapshot(): AmendmentSnapshot {
  const journal = copy(useJournalStore.getState().entries);
  const invoices = copy(useInvoiceStore.getState().invoices);
  const bills = copy(useBillStore.getState().bills);
  const billNumbering = copy(useBillStore.getState().numbering);
  const creditNotes = copy(useCreditNoteStore.getState().creditNotes);
  const creditNoteNumbering = copy(useCreditNoteStore.getState().numbering);
  const receipts = copy(useReceiptStore.getState().receipts);
  const payments = copy(usePaymentStore.getState().payments);
  const inventory = useInventoryStore.getState();
  const movements = copy(inventory.movements);
  const inventoryDocuments = copy(inventory.documents);
  const inventoryAudit = copy(inventory.auditTrail);
  const invoiceNumbering = copy(useInvoiceTemplateStore.getState().numbering);

  return {
    restore: () => {
      /*
       * `setState` rather than each store's `replaceAll`: several of those
       * normalise or re-derive on the way in (`journalStore.replaceAll` runs
       * `normalizeEntry`, `billStore.replaceAll` re-stamps revisions), and a
       * rollback must put back exactly what was there, not a re-derived
       * approximation of it.
       */
      useJournalStore.setState({ entries: journal });
      useInvoiceStore.setState({ invoices });
      useBillStore.setState({ bills, numbering: billNumbering });
      useCreditNoteStore.setState({ creditNotes, numbering: creditNoteNumbering });
      useReceiptStore.setState({ receipts });
      usePaymentStore.setState({ payments });
      useInventoryStore.setState({
        movements,
        documents: inventoryDocuments,
        auditTrail: inventoryAudit,
      });
      useInvoiceTemplateStore.setState({ numbering: invoiceNumbering });
    },
  };
}

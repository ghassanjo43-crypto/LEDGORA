/**
 * What the "Amend posted document" menu item should look like, and why.
 *
 * ── Why a hook and not a check inside each page ──────────────────────────────
 * Four screens offer this action. Written out four times, the menus would drift
 * from each other and — worse — from the service, which is where the decision
 * actually gets made. This hook reads the SAME assessment the service re-runs
 * before it writes anything, so the reason the menu shows for a disabled action
 * is the reason the service would give.
 *
 * The menu is an affordance, never the gate. A user who reaches
 * `amendPostedDocument` another way is refused there, and `documentAmendment.test`
 * proves it.
 *
 * ── Every store the assessment reads is a dependency ─────────────────────────
 * `assessAmendment` consults the documents, the JOURNAL (is the posting there
 * and posted?), TAX PERIODS (filed or locked?), INVENTORY (can the stock be
 * reversed?), the ENTITLEMENTS (does the subscription permit posting?), the
 * amendment POLICY and the acting user. Subscribing to only some of those meant
 * a verdict computed against half-hydrated state could never be recomputed when
 * the rest arrived — the menu would keep showing a refusal that had stopped
 * being true. Selecting each one is what makes the memo honest; a `getState()`
 * read inside `useMemo` is invisible to React and goes stale silently.
 */
import { useMemo } from 'react';
import type { AmendableDocumentType, AmendmentAssessment } from '@/types/documentAmendment';
import { assessAmendment } from '@/services/documentAmendmentService';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useBillStore } from '@/store/billStore';
import { useCreditNoteStore } from '@/store/creditNoteStore';
import { useJournalStore } from '@/store/journalStore';
import { useTaxPeriodStore } from '@/store/taxPeriodStore';
import { useInventoryStore } from '@/store/inventoryStore';
import { useEntitlementStore } from '@/store/entitlementStore';
import { useReceiptStore } from '@/store/receiptStore';
import { usePaymentStore } from '@/store/paymentStore';
import { useAmendmentPolicyStore } from '@/store/amendmentPolicyStore';
import { useAuthStore } from '@/store/authStore';

export interface AmendmentAction {
  /** Show the action at all. False for a draft, where ordinary editing applies. */
  visible: boolean;
  /** Drawn but not clickable, with `reason` explaining what stands in the way. */
  disabled: boolean;
  reason: string;
  assessment: AmendmentAssessment | null;
}

const UNAVAILABLE: AmendmentAction = {
  visible: false,
  disabled: true,
  reason: '',
  assessment: null,
};

/**
 * The sentence shown when an action is refused but the assessment somehow
 * produced nothing to say. `assessDocumentAmendment` already guarantees a
 * non-empty reason; this is the second belt, because a blank refusal reads as a
 * broken control and is the exact defect this hook was reported for.
 */
const UNSTATED_REFUSAL =
  'This document cannot be amended right now, and Ledgora could not determine why. '
  + 'Nothing has been changed. Please report this so the cause can be found.';

export function useAmendmentAction(
  documentType: AmendableDocumentType,
  documentId: string | undefined,
): AmendmentAction {
  const invoices = useInvoiceStore((s) => s.invoices);
  const invoiceBackend = useInvoiceStore((s) => s.backend);
  const bills = useBillStore((s) => s.bills);
  const creditNotes = useCreditNoteStore((s) => s.creditNotes);
  const entries = useJournalStore((s) => s.entries);
  const taxPeriods = useTaxPeriodStore((s) => s.periods);
  const movements = useInventoryStore((s) => s.movements);
  const inventoryDocuments = useInventoryStore((s) => s.documents);
  const subscription = useEntitlementStore((s) => s.subscription);
  const receipts = useReceiptStore((s) => s.receipts);
  const payments = usePaymentStore((s) => s.payments);
  const roleGrants = useAmendmentPolicyStore((s) => s.roleGrants);
  const userOverrides = useAmendmentPolicyStore((s) => s.userOverrides);
  const currentUserId = useAuthStore((s) => s.currentUserId);
  const users = useAuthStore((s) => s.users);

  return useMemo(() => {
    if (!documentId) return UNAVAILABLE;
    const assessment = assessAmendment(documentType, documentId);
    if (!assessment) return UNAVAILABLE;

    /*
     * A draft is not "an amendment you are not allowed to make" — it is a
     * document the ordinary editor handles. Offering a disabled amendment
     * action beside a live Edit action would suggest the two compete.
     */
    const isDraft = assessment.blockers.some((b) => b.kind === 'not_posted');
    if (isDraft) return UNAVAILABLE;

    const disabled = !assessment.eligible;
    return {
      visible: true,
      disabled,
      reason: disabled ? (assessment.reason.trim() || UNSTATED_REFUSAL) : '',
      assessment,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    documentType, documentId,
    invoices, invoiceBackend, bills, creditNotes,
    entries, taxPeriods, movements, inventoryDocuments,
    subscription, receipts, payments,
    roleGrants, userOverrides, currentUserId, users,
  ]);
}

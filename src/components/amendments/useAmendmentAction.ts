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
 */
import { useMemo } from 'react';
import type { AmendableDocumentType, AmendmentAssessment } from '@/types/documentAmendment';
import { assessAmendment } from '@/services/documentAmendmentService';
import { useInvoiceStore } from '@/store/invoiceStore';
import { useBillStore } from '@/store/billStore';
import { useCreditNoteStore } from '@/store/creditNoteStore';
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
 * Subscribe to the stores the assessment reads, so the menu re-evaluates when
 * the document is settled, superseded or the policy changes. Selecting the
 * arrays rather than calling `getState()` is what makes this reactive at all —
 * a `getState()` read inside `useMemo` would go stale the moment anything moved.
 */
export function useAmendmentAction(
  documentType: AmendableDocumentType,
  documentId: string | undefined,
): AmendmentAction {
  const invoices = useInvoiceStore((s) => s.invoices);
  const bills = useBillStore((s) => s.bills);
  const creditNotes = useCreditNoteStore((s) => s.creditNotes);
  const roleGrants = useAmendmentPolicyStore((s) => s.roleGrants);
  const userOverrides = useAmendmentPolicyStore((s) => s.userOverrides);
  const currentUserId = useAuthStore((s) => s.currentUserId);

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

    return {
      visible: true,
      disabled: !assessment.eligible,
      reason: assessment.eligible ? '' : assessment.reason,
      assessment,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentType, documentId, invoices, bills, creditNotes, roleGrants, userOverrides, currentUserId]);
}
